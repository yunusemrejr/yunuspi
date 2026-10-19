/**
 * Cache sentinel — name the cause of every prompt-cache miss.
 *
 * A provider prefix cache only hits when a request starts with the bytes of the
 * previous one. The harness owns most of what sits at the front (tool schemas,
 * the system prompt, earlier messages), so a miss that follows a harness change
 * is a harness cost, while a miss after an unchanged request belongs to the
 * route (idle gap, eviction, a different upstream provider).
 *
 * Observation only: fingerprints are hashes, nothing is stored but one digest
 * list for the previous request, and no payload is ever modified. Each miss is
 * attributed once, with the tokens it re-billed and their price over the cache
 * rate, so `/budget` can state "3 misses, 410k tokens re-billed: tools 2,
 * history 1" instead of just a hit percentage.
 */
import { createHash } from "node:crypto";

export type CacheMissCause = "tools" | "system" | "history" | "route" | "idle" | "provider";

export interface CacheMiss {
	cause: CacheMissCause;
	/** Prompt tokens that were billed fresh although the previous request had carried them. */
	rebilledTokens: number;
	/** Message index where the request diverged from the previous one (history/system only). */
	atMessage?: number;
	/** Tool names that appeared or disappeared (tools only). */
	toolsChanged?: string[];
	usd: number;
}

export interface CacheSentinelSummary {
	requests: number;
	misses: number;
	rebilledTokens: number;
	usd: number;
	byCause: Partial<Record<CacheMissCause, { count: number; tokens: number; usd: number }>>;
}

interface Fingerprint {
	tools: string;
	system: string;
	toolNames: string[];
	messages: string[];
	roles: string[];
}

const MESSAGE_KEYS = ["messages", "input", "contents"] as const;
const TOOL_KEYS = ["tools", "tool_config", "toolConfig"] as const;
const SYSTEM_KEYS = ["system", "instructions", "systemInstruction", "system_instruction"] as const;
/** A previous prompt below this size is not worth attributing; a re-bill of it costs fractions of a cent. */
const MIN_PREVIOUS_TOKENS = 4_000;
/** Fraction of the previous prompt that must be served from cache for the request to count as a hit. */
const HIT_FRACTION = 0.6;

const sha = (text: string): string => createHash("sha1").update(text).digest("base64url").slice(0, 16);

// Per-object digest memo: several provider paths hand the same message/tool
// objects to before_provider_request on every request, and re-stringifying +
// re-hashing the whole history per request grows linearly with session size
// (~18ms at 800 messages). Identity-keyed, so a replaced object re-hashes; a
// mutated-in-place object would keep its old digest (payloads are built, not
// mutated, after this hook).
const digestMemo = new WeakMap<object, string>();
function digestOf(value: unknown): string {
	if (!value || typeof value !== "object") return sha(JSON.stringify(value) ?? "");
	const hit = digestMemo.get(value);
	if (hit !== undefined) return hit;
	const digest = sha(JSON.stringify(value) ?? "");
	digestMemo.set(value, digest);
	return digest;
}

export function fingerprintPayload(payload: any): Fingerprint | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const key = MESSAGE_KEYS.find((candidate) => Array.isArray(payload[candidate]));
	if (!key) return undefined;
	const tools: Record<string, unknown> = {}, system: Record<string, unknown> = {};
	for (const name of TOOL_KEYS) if (payload[name] !== undefined) tools[name] = payload[name];
	for (const name of SYSTEM_KEYS) if (payload[name] !== undefined) system[name] = payload[name];
	const declared: any[] = Array.isArray(payload.tools) ? payload.tools : [];
	// Gemini groups many declarations under one tool entry; every other API lists one function per entry.
	const toolNames = declared
		.flatMap((tool) => (Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : [tool]))
		.map((tool) => String(tool?.function?.name ?? tool?.name ?? ""))
		.filter(Boolean);
	const list: any[] = payload[key];
	return {
		tools: sha(JSON.stringify(tools)),
		system: sha(JSON.stringify(system)),
		toolNames,
		messages: list.map((message) => digestOf(message)),
		roles: list.map((message) => String(message?.role ?? message?.type ?? "")),
	};
}

export function createCacheSentinel(options: { ttlMs?: number } = {}) {
	let previous: { fp: Fingerprint; total: number; at: number; route: string } | undefined;
	let current: { fp: Fingerprint; route: string; at: number; ttlMs: number } | undefined;
	const summary: CacheSentinelSummary = { requests: 0, misses: 0, rebilledTokens: 0, usd: 0, byCause: {} };
	const ttlMs = options.ttlMs ?? 3_600_000;

	/** Record the request about to be sent; `ttlMs` is the route's cache lifetime. */
	function request(payload: any, route: string, now = Date.now(), requestTtlMs = ttlMs): void {
		const fp = fingerprintPayload(payload);
		current = fp ? { fp, route, at: now, ttlMs: requestTtlMs } : undefined;
	}

	/**
	 * Settle the response for the last recorded request; returns the miss it represents, if any.
	 * `cacheReported` is false when the provider omits cache fields: every read then looks like a miss, so none is named.
	 */
	function response(usage: { input?: number; cacheRead?: number; cacheWrite?: number }, premiumPerMillion = 0, now = Date.now(), cacheReported = true): CacheMiss | undefined {
		const sent = current;
		current = undefined;
		if (!sent) return undefined;
		const total = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
		// An errored or aborted request billed nothing and says nothing about the cache: keep the earlier baseline.
		if (!(total > 0)) return undefined;
		summary.requests += 1;
		const before = previous;
		previous = { fp: sent.fp, total, at: now, route: sent.route };
		if (!before || before.total < MIN_PREVIOUS_TOKENS || !cacheReported) return undefined;
		const cached = Number(usage.cacheRead ?? 0);
		if (cached >= before.total * HIT_FRACTION) return undefined;
		const rebilledTokens = Math.max(0, before.total - cached);
		const usd = (rebilledTokens * Math.max(0, premiumPerMillion)) / 1e6;
		const miss: CacheMiss = { cause: "provider", rebilledTokens, usd };
		if (before.route !== sent.route) miss.cause = "route";
		else if (sent.at - before.at > sent.ttlMs) miss.cause = "idle";
		else if (before.fp.tools !== sent.fp.tools) {
			miss.cause = "tools";
			const removedOrAdded = [...new Set([...before.fp.toolNames, ...sent.fp.toolNames])].filter(
				(name) => before.fp.toolNames.includes(name) !== sent.fp.toolNames.includes(name),
			);
			if (removedOrAdded.length) miss.toolsChanged = removedOrAdded.slice(0, 8);
		} else if (before.fp.system !== sent.fp.system) {
			miss.cause = "system";
		} else {
			let index = 0;
			const shared = Math.min(before.fp.messages.length, sent.fp.messages.length);
			while (index < shared && before.fp.messages[index] === sent.fp.messages[index]) index++;
			if (index < before.fp.messages.length) {
				miss.cause = /^(?:system|developer)$/.test(sent.fp.roles[index] ?? "") ? "system" : "history";
				miss.atMessage = index;
			}
		}
		summary.misses += 1;
		summary.rebilledTokens += rebilledTokens;
		summary.usd += usd;
		const row = (summary.byCause[miss.cause] ??= { count: 0, tokens: 0, usd: 0 });
		row.count += 1;
		row.tokens += rebilledTokens;
		row.usd += usd;
		return miss;
	}

	return {
		request,
		response,
		summary: (): CacheSentinelSummary => ({ ...summary, byCause: { ...summary.byCause } }),
		reset(): void {
			previous = undefined;
			current = undefined;
			summary.requests = summary.misses = summary.rebilledTokens = summary.usd = 0;
			summary.byCause = {};
		},
	};
}

export function describeCacheMisses(summary: CacheSentinelSummary, fmtTokens: (n: number) => string, fmtUsd: (n: number) => string): string {
	if (!summary.misses) return `Cache misses: none in ${summary.requests} request(s)`;
	const parts = Object.entries(summary.byCause)
		.sort((a, b) => b[1].tokens - a[1].tokens)
		.map(([cause, row]) => `${cause} ${row.count}`);
	return `Cache misses: ${summary.misses} of ${summary.requests} request(s) re-billed ${fmtTokens(summary.rebilledTokens)} tokens (~${fmtUsd(summary.usd)} over the cache rate): ${parts.join(", ")}`;
}
