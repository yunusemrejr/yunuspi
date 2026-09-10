/**
 * Exact deduplication, bounded output distillation and visible-baseline deltas.
 * The session transcript owns original evidence;
 * this extension keeps only a bounded index, never a second content store.
 * Every call still executes. Changed bytes, errors and attachments stay visible.
 * Numeric references survive compaction/reload/fork and are branch-scoped.
 */
import { createHash } from "node:crypto";
import {createMiniPreprocessor, miniSource, miniProjection} from "./lib/mini-preprocessor.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { distillOutput, outputDelta, MAX_OUTPUT_CHARS, isSearchCommand } from "./lib/output-distiller.ts";
import {
	compactProviderPayload,
	providerImageCountLimit,
	GATE_THRESHOLD_BYTES,
} from "./lib/image-compaction.ts";
import { hasRequestBodyLimit } from "../scripts/patches/request-body-gate.mjs";

const MIN_DEDUP_CHARS = 400;
const MAX_ENTRIES = 64;
const PAGE_CHARS = 20000;
const TOOLS = new Set(["bash", "read", "grep", "ls", "find"]);
interface Reference {
	version: 1;
	id: number;
	signature: string;
	operation?: string;
	resultHash?: string;
	searchOutput?: boolean;
}

function reference(entry: SessionEntry): Reference | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return;
	const value = entry.message.details?.piObservation;
	if (
		value?.version === 1 &&
		Number.isSafeInteger(value.id) &&
		value.id > 0 &&
		typeof value.signature === "string"
	)
		return value;
}

function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
		.join("\n");
}

function signature(tool: string, input: unknown, content: unknown): string {
	// Key order is not meaning. No output normalization: timings, PIDs, paths,
	// whitespace and progress can all be the evidence the user asked to measure.
	const encoded = JSON.stringify([tool, input, content], (_key, value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, value[key]]),
		);
	});
	return createHash("sha256").update(encoded).digest("hex");
}

export default function piObservationsExtension(pi: ExtensionAPI, mini = createMiniPreprocessor()) {
	let observations = new Map<string, number>();
	let counter = 0;
	let visionHintSent = false;

	function remember(key: string, id: number): void {
		observations.delete(key);
		observations.set(key, id);
		if (observations.size > MAX_ENTRIES)
			observations.delete(observations.keys().next().value!);
	}

	function restore(ctx: ExtensionContext): void {
		mini.reset();
		observations = new Map();
		counter = 0;
		// Include inactive branches when reserving ids, but NEVER when retrieving
		// evidence. Also reserve legacy ids so they cannot alias new observations.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult")
				continue;
			const id = reference(entry)?.id ?? entry.message.details?.observationId;
			if (Number.isSafeInteger(id) && id > counter) counter = id;
		}
		for (const entry of ctx.sessionManager.getBranch()) {
			const ref = reference(entry);
			if (ref) remember(ref.signature, ref.id);
		}
		visionHintSent = false;
	}

	pi.on("session_shutdown", () => mini.reset());
	pi.on("agent_end", () => mini.reset());
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("message_end", (event) => {
		if (event.message.role !== "toolResult") return;
		const ref = event.message.details?.piObservation as Reference | undefined;
		if (ref?.version === 1) remember(ref.signature, ref.id);
	});
	pi.on("before_agent_start", () => {
		visionHintSent = false;
	});

	// Existing image policy stays route-owned and is resolved on every request.
	pi.on("before_provider_request", (event, ctx) => {
		if (!hasRequestBodyLimit(ctx.model?.provider)) return;
		const maxImages = providerImageCountLimit(ctx.model?.provider, ctx.model?.id);
		const result = compactProviderPayload(
			event.payload,
			GATE_THRESHOLD_BYTES,
			maxImages,
		);
		return result.removed > 0 ? result.payload : undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (
			!event.isError &&
			event.toolName === "read" &&
			!visionHintSent &&
			ctx?.model &&
			!ctx.model.input.includes("image") &&
			event.content.some((part) => part.type === "image")
		) {
			visionHintSent = true;
			const canDelegate = pi.getActiveTools().includes("subagent");
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text:
							"[visual capability] Your current model cannot see this image. Reading source or capturing another screenshot does not provide visual evidence. " +
							(canDelegate
								? 'For a visual task, read the pi-subagents skill, then use subagent({action:"models",model:"input:image"}). Choose a permitted image route (check economy labels), then launch a fresh read-only reviewer with that exact model, the absolute image paths, and your visual question. The child must read the images; do not inherit this text-only model. Respect user limits on delegation. If no route is permitted, report the limitation.'
								: "No subagent tool is active here. Report the visual limitation; do not claim to have inspected the pixels."),
					},
				],
			};
		}
		if (!TOOLS.has(event.toolName)) return;
		if (event.content.some((part) => part.type !== "text")) return;
		const text = textOf(event.content);
		if (text.length < MIN_DEDUP_CHARS) return;
		// Preserve foreign details formats rather than coercing them to objects.
		if (
			event.details != null &&
			(typeof event.details !== "object" || Array.isArray(event.details))
		)
			return;
		const key = signature(event.toolName, event.input, {content: event.content, isError: event.isError === true, details: event.details ?? null});
		const id = event.isError ? undefined : observations.get(key);
		if (id !== undefined) {
			remember(key, id);
			// Restricted tool profiles can disable retrieval mid-session. Preserve
			// the actual evidence until its reference is usable again.
			if (!pi.getActiveTools().includes("obs_read")) return;
			// reminders.ts consumes this exact-repeat receipt at a continuing
			// turn boundary. Dedup must not run a second steering loop here.
			return {
				content: [
					{
						type: "text" as const,
						text: `[observation #${id} — exact output already seen; the call executed again. Retrieve the original with obs_read({id:${id}}).]`,
					},
				],
				details: { ...event.details, observationId: id, deduplicated: true, observationResultHash: signature("result", null, {content: event.content, isError: event.isError === true, details: event.details ?? null}) },
			};
		}
		const ref: Reference = { version: 1, id: ++counter, signature: key, operation: signature(event.toolName, event.input, null), resultHash: signature("result", null, {content: event.content, isError: event.isError === true, details: event.details ?? null}), ...(event.toolName === 'bash' && isSearchCommand(event.input?.command) ? {searchOutput:true} : {}) };
		// Do not index until message_end: parallel siblings finish out of order
		// but persist in source order. A forward pointer could lose its original
		// when the user forks at that result. Same-batch originals stay intact.
		// Original content stays in its normal toolResult entry, with a small id.
		const finish = (selection?: unknown) => ({details: {...event.details, piObservation: ref, ...(selection ? {piMiniSelection: selection} : {})}});
		// Existing deterministic compression wins. Only bounded successful prose
		// can spend local inference; the original tool body stays in the transcript.
		if (event.toolName === "bash" && !event.isError && !event.details?.truncation && !event.details?.truncated
			&& !event.details?.cancelled && !event.details?.aborted && (event.details?.exitCode === undefined || event.details.exitCode === 0)
			&& ctx?.model?.cost?.input > 0 && process.env.PI_OUTPUT_DISTILLER !== "off"
			&& pi.getActiveTools().includes("obs_read") && miniSource(text) && !distillOutput(event.toolName, text, ref.searchOutput)) {
			let statusSize = Infinity;
			try {statusSize = JSON.stringify({isError:false,details:event.details ?? {}}).length;} catch {}
			if (statusSize <= 80) return mini.select(text, ctx.model.cost.input).then(finish, () => finish());
		}
		return finish();
	});

	// Project only tool-result bodies at the context boundary. The transcript is
	// unchanged and obs_read can recover every character, including old branches'
	// active ancestry. Recomputing in source order keeps an append-only prefix
	// stable: later calls cannot alter how an earlier result was represented.
	pi.on("context", (event) => {
		if (process.env.PI_OUTPUT_DISTILLER === "off" || !pi.getActiveTools().includes("obs_read")) return;
		const baselines = new Map<string, { id: number; text: string }>();
		const searchCalls = new Set(event.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content) ? message.content.flatMap(part => part.type === 'toolCall' && part.name === 'bash' && isSearchCommand(part.arguments?.command) ? [part.id] : []) : []));
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "toolResult" || message.content.some(part => part.type !== "text")) return message;
			const ref = message.details?.piObservation as Reference | undefined;
			if (ref?.version !== 1 || !ref.operation || !TOOLS.has(message.toolName)) return message;
			const raw = textOf(message.content);
			if (raw.length > MAX_OUTPUT_CHARS || raw.includes("\0")) return message;
			// Carry all foreign status/provenance details verbatim into the visible
			// receipt as well as retaining them on the original toolResult object.
			const { piObservation: _ref, piMiniSelection: selection, ...details } = message.details ?? {};
			let status: string;
			try { status = JSON.stringify({isError: message.isError === true, details}); } catch { return message; }
			if (status.length > 2000) return message;
			const baseline = baselines.get(ref.operation);
			const delta = !message.isError && !details.truncation && !details.truncated && baseline
				? outputDelta(baseline.text, raw) : undefined;
			const summary = delta ? undefined : distillOutput(message.toolName, raw, ref.searchOutput || searchCalls.has(message.toolCallId));
			const selected = !delta && !summary && !message.isError && process.env.PI_MINI_PREPROCESSOR !== "off" ? miniProjection(raw, selection) : undefined;
			if (!delta && !summary && !selected) {
				if (!message.isError && !details.truncation && !details.truncated && raw.length >= 3000) {
					baselines.set(ref.operation, {id: ref.id, text: raw});
					if (baselines.size > MAX_ENTRIES) baselines.delete(baselines.keys().next().value!);
				}
				return message;
			}
			changed = true;
			const projection = delta
				? JSON.stringify({kind: "exact-delta", baselineObservation: baseline!.id, offsetUnit: "UTF-16 code units", ...delta, currentChars: raw.length})
				: selected ?? summary!.text;
			return {...message, content: [{type: "text" as const, text:
				`[observation #${ref.id}; ${delta ? "exact change against the full baseline above" : "extractive summary; omitted content is not verified"}; raw: obs_read({id:${ref.id}})]\n${status}\n${projection}`}]};
		});
		return changed ? {messages} : undefined;
	});

	pi.registerTool({
		name: "obs_read",
		label: "Read Observation",
		description:
			"Retrieve exact original tool output by observation id from the current session branch, including before compaction/reload. Long output is paginated with offset/limit (characters).",
		parameters: Type.Object({
			id: Type.Integer({ minimum: 1 }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset (default 0)" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE_CHARS })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const entry = ctx.sessionManager
				.getBranch()
				.find((entry) => reference(entry)?.id === params.id);
			if (
				!entry ||
				entry.type !== "message" ||
				entry.message.role !== "toolResult"
			) {
				throw new Error(
					`Observation #${params.id} is unavailable on this branch (legacy cache-only references cannot be recovered). Re-run the original tool if needed.`,
				);
			}
			const text = textOf(entry.message.content);
			const offset = params.offset ?? 0;
			if (offset > text.length)
				throw new Error(`offset exceeds observation length ${text.length}`);
			const end = Math.min(text.length, offset + (params.limit ?? PAGE_CHARS));
			const nextOffset = end < text.length ? end : undefined;
			return {
				content: [
					{
						type: "text" as const,
						text:
							text.slice(offset, end) +
							(nextOffset === undefined
								? ""
								: `\n[More: obs_read({id:${params.id},offset:${nextOffset}}); ${text.length} characters total]`),
					},
				],
				details: {
					observationId: params.id,
					offset,
					nextOffset,
					totalChars: text.length,
				},
			};
		},
	});

	pi.registerCommand("obs", {
		description:
			"List recent indexed observations (older references remain retrievable)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI)
				ctx.ui.notify(
					`Recent observations: ${[...observations.values()].map((id) => `#${id}`).join(", ") || "none"}. Originals live in this session's branch history.`,
					"info",
				);
		},
	});
}
