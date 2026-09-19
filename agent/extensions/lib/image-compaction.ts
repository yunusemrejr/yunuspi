/**
 * Pure image-eviction logic for provider request-body compaction.
 *
 * The request-body-gate patch (scripts/compatibility/legacy-transforms/request-body-gate.mjs) hard-blocks
 * any provider send whose ENCODED body exceeds ~3.5 MB, and providers in this
 * harness also cap the COUNT of images per prompt (observed: friendli's
 * OpenAI-completions endpoint 400s with "At most 8 image(s) may be provided in
 * one prompt" — a count limit, independent of body size). Blocking is still
 * correct for a single image that is itself too large, but for the common
 * "too many accumulated screenshots" cases the right move is to drop the
 * OLDEST-CONSUMED image parts (replaced inline with a short note) so the turn
 * continues with the freshest images intact.
 *
 * Dependency-free (node builtins only) so both the pi-observations extension and
 * the standalone bench test can import it under `node --experimental-strip-types`
 * without the harness loader.
 *
 * Image shapes detected (the three the gate's walk also scans):
 *   - OpenAI    : { type:"image_url", image_url:{ url:"data:..." } }
 *   - Anthropic : { type:"image", source:{ type:"base64", media_type, data } }
 *   - read tool : { type:"image", data, mimeType }
 * plus a bare { url:"data:..." } part as a generic fallback.
 */

export const PROVIDER_REQUEST_BODY_CAP = 3.5 * 1024 * 1024; // 3,670,016 — mirrors the patch
export const GATE_THRESHOLD_BYTES = PROVIDER_REQUEST_BODY_CAP - 128 * 1024; // 3,538,944
const COMPACT_MARGIN_BYTES = 128 * 1024; // evict to `threshold` minus this

/** Strictest per-prompt image COUNT limit among this harness's providers
 *  (friendli's OpenAI-compatible endpoint: 400 "At most 8 image(s) may be
 *  provided in one prompt"). Providers with higher limits are unaffected:
 *  eviction only fires above the cap, and oldest-first. */
export const PROVIDER_IMAGE_COUNT_CAP = 8;
/** Observed endpoint limits, not a universal multimodal model restriction. */
export function providerImageCountLimit(provider?: string, modelId?: string): number {
	return provider === 'friendli' || (provider === 'runinfra' && /glm[-_.]?5[-_.]?3[-_.]?flash/i.test(modelId ?? '')) ? PROVIDER_IMAGE_COUNT_CAP : Infinity;
}

/** Byte size of an image content part, or 0 if the part is not an image. */
export function imagePartBytes(part: unknown): number {
	if (!part || typeof part !== "object") return 0;
	const p = part as Record<string, any>;
	if (typeof p.image_url === 'string') return Math.max(1, p.image_url.length);
	if (typeof p.image_url?.url === "string") {
		return p.image_url.url.length;
	}
	if (p.type === 'image' && typeof p.source?.url === 'string') return Math.max(1, p.source.url.length);
	if (typeof p.source?.data === "string") return Math.max(1, p.source.data.length);
	if (p.type === "image" && typeof p.data === "string") return p.data.length;
	if (typeof p.url === "string" && p.url.startsWith("data:")) return p.url.length;
	return 0;
}

export interface CompactResult {
	payload: unknown;
	removed: number;
	removedBytes: number;
}

function measure(payload: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(payload), "utf8");
	} catch {
		return -1;
	}
}

function clonePayload(payload: unknown): unknown {
	try {
		return structuredClone(payload);
	} catch {
		return JSON.parse(JSON.stringify(payload));
	}
}

const BYTE_EVICT_NOTE = (size: number) =>
	`[image removed to stay under the provider's ~3.5 MB request cap (~${(size / 1048576).toFixed(2)} MB) — re-read the source file if you need it again]`;
const COUNT_EVICT_NOTE = (limit: number) =>
	`[image removed to stay under the provider's ${limit}-images-per-prompt limit (oldest images are dropped first) — re-read the source file if you need it again]`;

/**
 * Evict the oldest-consumed image parts from a provider request payload until
 * BOTH the byte bound (JSON-encoded size <= threshold - margin) and the image
 * count bound (<= maxImages) hold, or no evictable image remains. Pure with
 * respect to the input: the input payload is never mutated; a new payload is
 * returned only when something was actually removed. Oldest message first,
 * oldest part within a message first, stopping as soon as both bounds are met
 * so the freshest (pending-turn) images always survive.
 *
 * The LAST message is never touched for BYTE eviction: its image (if any) is
 * the freshest read the pending turn just made, and dropping a single fresh
 * image is exactly the case the gate should BLOCK on instead. Count eviction
 * may trim the last message ONLY when that message alone exceeds maxImages
 * (e.g. a 12-frame video extraction, or 9 user-pasted images): no other
 * message can bring the count down, the request would be a guaranteed 400,
 * and keeping the freshest images of the batch still preserves the turn.
 */
export function compactProviderPayload(
	payload: unknown,
	threshold: number,
	maxImages: number = PROVIDER_IMAGE_COUNT_CAP,
): CompactResult {
	const root = payload as { messages?: unknown } | null;
	if (!root || !Array.isArray(root.messages)) {
		return { payload, removed: 0, removedBytes: 0 };
	}

	// Count once, without serializing image-free requests.
	let imageCount = 0;
	for (const msg of root.messages as any[]) {
		if (!msg || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (imagePartBytes(part) > 0) imageCount++;
		}
	}
	if (!imageCount) return { payload, removed: 0, removedBytes: 0 };
	const initialBytes = measure(payload);
	if (initialBytes < 0 || !Number.isFinite(threshold) || threshold <= 0 ||
		!(maxImages === Infinity || Number.isSafeInteger(maxImages) && maxImages >= 0))
		return { payload, removed: 0, removedBytes: 0 };
	if (initialBytes <= threshold && imageCount <= maxImages) {
		return { payload, removed: 0, removedBytes: 0 };
	}

	const clone = clonePayload(payload) as { messages: any[] };
	if (!Array.isArray(clone.messages)) return { payload, removed: 0, removedBytes: 0 };
	// structuredClone preserves shared references. Isolate replacement slots so
	// an old message sharing content with the newest cannot evict the newest too.
	clone.messages = clone.messages.map(msg => msg && Array.isArray(msg.content)
		? { ...msg, content: [...msg.content] } : msg);
	const target = threshold - COMPACT_MARGIN_BYTES;
	let removed = 0;
	let removedBytes = 0;
	let bytes = measure(clone);
	let count = imageCount;

	// Oldest message first, oldest part within a message first, stopping as soon
	// as both bounds are met so the freshest images always survive. The LAST
	// message is never touched here: byte eviction defers its lone fresh image
	// to the gate (see doc), and count overflow confined to it is handled below.
	for (let mi = 0; mi < clone.messages.length - 1 && (bytes > target || count > maxImages); mi++) {
		const msg = clone.messages[mi];
		if (!msg || !Array.isArray(msg.content)) continue;
		for (let ci = 0; ci < msg.content.length && (bytes > target || count > maxImages); ci++) {
			const size = imagePartBytes(msg.content[ci]);
			if (size <= 0) continue;
			const previousBytes = measure(msg.content[ci]);
			msg.content[ci] = {
				type: "text",
				text: count > maxImages ? COUNT_EVICT_NOTE(maxImages) : BYTE_EVICT_NOTE(size),
			};
			removed++;
			removedBytes += size;
			count--;
			// JSON array delimiters stay fixed: only this element's encoded bytes change.
			// Avoid repeatedly serializing the whole multi-megabyte request.
			bytes += measure(msg.content[ci]) - previousBytes;
		}
	}

	// Count overflow confined to the last message (multi-image tool result or
	// user attachment batch): trim its OLDEST images down to the cap. Freshest
	// images of the batch survive; byte eviction never reaches this message.
	const last = clone.messages[clone.messages.length - 1];
	if (count > maxImages && last && Array.isArray(last.content)) {
		for (let ci = 0; ci < last.content.length && count > maxImages; ci++) {
			const size = imagePartBytes(last.content[ci]);
			if (size <= 0) continue;
			last.content[ci] = { type: "text", text: COUNT_EVICT_NOTE(maxImages) };
			removed++;
			removedBytes += size;
			count--;
		}
	}

	return removed > 0
		? { payload: clone, removed, removedBytes }
		: { payload, removed: 0, removedBytes: 0 };
}
