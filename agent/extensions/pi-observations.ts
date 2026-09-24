import { sessionObservability } from './lib/session-observability.ts';
/**
 * Exact deduplication, bounded output distillation and visible-baseline deltas.
 * The session transcript owns original evidence;
 * this extension keeps only a bounded index, never a second content store.
 * Every call still executes. Changed bytes, errors and attachments stay visible.
 * Numeric references survive compaction/reload/fork and are branch-scoped.
 */
import { createHash } from "node:crypto";
import {
	taskTerms,
	structuralFingerprint,
	fingerprintSimilarity,
	failureSimilarity,
} from "./lib/local-intelligence.mjs";
import {
	createMiniPreprocessor,
	miniSource,
	miniProjection,
} from "./lib/mini-preprocessor.ts";
import {
	createSmolPreprocessor,
	safeSmolOutput,
} from "./lib/smol-preprocessor.ts";
import { routeEvidence } from "./lib/micro-intelligence/evidence.ts";
import { microMetrics } from "./lib/micro-intelligence/metrics.ts";
import { retrieveObservation } from "./lib/observation-retrieval.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@yunuspi/coding-agent";
import { Type } from "typebox";
import {
	distillOutput,
	outputDelta,
	outputLineDelta,
	MAX_OUTPUT_CHARS,
	isSearchCommand,
} from "./lib/output-distiller.ts";
import { askJev, selectDistillChunks, jevEnabled } from "./lib/jev-client.ts";
import {
	compactProviderPayload,
	providerImageCountLimit,
	GATE_THRESHOLD_BYTES,
} from "./lib/image-compaction.ts";

/** Providers whose encoded request body has a hard size cap (independent of the
 *  token window). Inlined from the retired request-body-gate transform — owned
 *  source no longer depends on any transform catalogue. */
const BODY_LIMIT_PROVIDERS = new Set(["openrouter", "runinfra", "friendli"]);
function hasRequestBodyLimit(provider: string | undefined): boolean {
	return !provider || BODY_LIMIT_PROVIDERS.has(provider);
}

const MIN_DEDUP_CHARS = 400;
// Small tool results are already cheap and exact. Preserve them byte-for-byte
// in the model context so an extractive observation cannot silently replace a
// useful `ls`, diff, status or short log with an unverified paraphrase.
export const RAW_PASSTHROUGH_CHARS = 1024;
const MAX_ENTRIES = 64;
// Sealed renderings hold only a receipt or a reference to one, never a copy of
// the raw output, so the bound can be far larger than the observation index.
const MAX_SEALED = 2048;
/** Bounded context-time wait for an in-flight Jev distillation (typically ~0.6s). */
const JEV_DISTILL_WAIT_MS = 1500;
const PAGE_CHARS = 20000;
const TOOLS = new Set(["bash", "read", "grep", "ls", "find"]);
// Needle error-family labels for tool-result triage. A similarity cue only:
// the deterministic failureCategory verdict and the raw text stay authoritative.
// Labels mirror failureCategory's taxonomy so cues compose with verdicts.
// Best-effort capability telemetry: selection rendered into model context is
// the honest usefulness signal (stronger than inference accepted, weaker than
// proven downstream use, which no observer can see).
const noteHealth = (kind: string, data: Record<string, unknown>): void => {
	try {
		sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data);
	} catch {
		/* telemetry is optional */
	}
};
// Whole-paragraph prose from local documentation also benefits from Kompress.
// Structured code, status, errors and source qualifications remain protected.
const isSkillRead = (tool: string, input: any) =>
	tool === "read" &&
	typeof input?.path === "string" &&
	/(?:^|[\\/])SKILL\.md$/i.test(input.path);
// Repeated identical failures dedup like successes, but the receipt must keep
// failure visibility: the raw transcript keeps the original and this cue names
// the first failure-looking line, bounded, without inventing a resolution.
const failureCue = (text: string): string => {
	const line = text
		.split("\n")
		.find((entry) => /(?:FAIL|Error|error:|failed)/.test(entry));
	return line ? ` First failure line: ${line.trim().slice(0, 160)}` : "";
};
const miniEligibleTool = (tool: string, input: any) =>
	tool === "bash" ||
	(tool === "read" &&
		typeof input?.path === "string" &&
		/\.(?:txt|md|rst)$/i.test(input.path));
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

export default function piObservationsExtension(
	pi: ExtensionAPI,
	mini = createMiniPreprocessor(),
	smol = createSmolPreprocessor(),
) {
	// Publish bounded inspectors for the read-only micro_status tool.
	// Inspection never runs inference; failures degrade to unknown.
	try {
		const key = Symbol.for("yunus-pi.micro.inspect.v1");
		const registry = (((globalThis as Record<symbol, unknown>)[key] ?? {}) as Record<string, unknown>);
		registry.smol = () => {
			try {
				return (smol as { inspect?: () => unknown }).inspect?.() ?? { status: "unknown" };
			} catch {
				return { status: "unavailable" };
			}
		};
		registry.mini = () => {
			try {
				return (mini as { inspect?: () => unknown }).inspect?.() ?? { status: "unknown" };
			} catch {
				return { status: "unavailable" };
			}
		};
		(globalThis as Record<symbol, unknown>)[key] = registry;
	} catch {
		/* Inspection is optional. */
	}
	let observations = new Map<string, number>();
	let counter = 0;
	let visionHintSent = false;
	let taskSignal = "";
	// Background Jev selections are offered at tool_result time. The next
	// provider request usually follows within milliseconds, before a ~0.6s Jev
	// answer, and the first render is sealed for the branch lifetime; without a
	// wait, paid selections never reached context. The context pass therefore
	// waits a bounded JEV_DISTILL_WAIT_MS, only for not-yet-sealed results.
	const jevDistillPending = new Map<string, {value?:string; settled?:Promise<void>}>();
	const offerJevDistill = (key: string, tool: string, text: string): void => {
		if (jevDistillPending.has(key)) return;
		if (jevDistillPending.size >= 200) jevDistillPending.delete(jevDistillPending.keys().next().value!);
		const slot: {value?:string; settled?:Promise<void>} = {};
		jevDistillPending.set(key,slot);
		slot.settled = selectDistillChunks(tool,text,(site,state,questions)=>askJev(site,state,questions,{pi}),undefined,taskSignal)
			.then(value=>{if(jevDistillPending.get(key)===slot)slot.value=value;})
			.catch(()=>{});
	};
	// Provider-visible history is append-only: the first rendering chosen for a
	// message is sealed and reused verbatim on later requests. A rewritten
	// earlier message invalidates the provider cache prefix and re-bills the
	// whole conversation, so later state must never re-render it — not a
	// distillation cache that filled after the fact, not a bounded baseline map
	// that evicted an entry, not a shifted failure window. `content: null` means
	// "leave the original in place"; that is a decision, not an absence.
	let sealedRenders = new Map<
		number,
		{ resultHash: string | undefined; content: any[] | null; requires: number[] }
	>();
	const sealRender = (
		id: number,
		resultHash: string | undefined,
		content: any[] | null,
		requires: number[],
	): void => {
		if (sealedRenders.size >= MAX_SEALED)
			sealedRenders.delete(sealedRenders.keys().next().value!);
		sealedRenders.set(id, { resultHash, content, requires });
	};
	// The first rendering of a given message content is authoritative. Re-rendering
	// is allowed when a dependency is temporarily invisible (a baseline that is not
	// in this request, e.g. a reduced or compacted view), but that transient view
	// must not replace the established seal — the full history would then be
	// re-rendered on the next request and re-bill the whole prefix.
	const sealFirstRender = (
		id: number,
		resultHash: string | undefined,
		content: any[] | null,
		requires: number[],
	): void => {
		const prior = sealedRenders.get(id);
		if (prior && prior.resultHash === resultHash) return;
		sealRender(id, resultHash, content, requires);
	};

	function remember(key: string, id: number): void {
		observations.delete(key);
		observations.set(key, id);
		if (observations.size > MAX_ENTRIES)
			observations.delete(observations.keys().next().value!);
	}

	function restore(ctx: ExtensionContext): void {
		mini.reset();
		smol.reset();
		jevDistillPending.clear();
		taskSignal = "";
		observations = new Map();
		// A replaced branch (new/forks/compaction) re-renders from scratch.
		sealedRenders = new Map();
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

	pi.on("session_shutdown", () => {
		mini.reset();
		smol.reset();
		jevDistillPending.clear();
	});
	pi.on("agent_end", () => {
		// Turn boundary keeps validated caches and live inference: an observation
		// offered late in this turn is usually first rendered next turn. Full
		// reset stays on session/branch/compaction boundaries via restore().
		mini.endTurn();
		smol.endTurn();
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("message_end", (event) => {
		if (event.message.role !== "toolResult") return;
		const ref = event.message.details?.piObservation as Reference | undefined;
		if (ref?.version === 1) remember(ref.signature, ref.id);
	});
	pi.on("before_agent_start", (event) => {
		visionHintSent = false;
		taskSignal = taskTerms(event?.prompt).join(" ");
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
			!ctx.model.input?.includes("image") &&
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
							"[visual capability] Your current model cannot see this image. Reading source or capturing another screenshot does not provide visual evidence. If your question is only about printed text in the image, use image_ocr on the local path instead (fast, no delegation). " +
							(canDelegate
								? 'For layout, color, composition or meaning, use subagent({action:"list",capabilities:true}) to resolve an existing reviewer profile, then subagent({action:"models",model:"input:image"}). Choose a permitted image route (check economy labels), then launch a fresh read-only reviewer with that exact model, the absolute image paths, and your visual question. The child must read the images; do not inherit this text-only model. Respect user limits on delegation. If no route is permitted, report the limitation.'
								: "No subagent tool is active here. Report the visual limitation; do not claim to have inspected the pixels."),
					},
				],
			};
		}
		// Workflow instructions must actually reach the model after compaction;
		// a pointer to an old observation is not a fresh skill read.
		if (isSkillRead(event.toolName, event.input)) return;
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
		const key = signature(event.toolName, event.input, {
			content: event.content,
			isError: event.isError === true,
			details: event.details ?? null,
		});
		const id = observations.get(key);
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
						text: event.isError
							? `[observation #${id} — identical failing output already seen; the call executed again and failed identically.${failureCue(text)} Raw original: obs_read({id:${id}}).]`
							: `[observation #${id} — exact output already seen; the call executed again. Retrieve the original with obs_read({id:${id}}).]`,
					},
				],
				details: {
					...event.details,
					observationId: id,
					deduplicated: true,
					observationResultHash: signature("result", null, {
						content: event.content,
						isError: event.isError === true,
						details: event.details ?? null,
					}),
				},
			};
		}
		const ref: Reference = {
			version: 1,
			id: ++counter,
			signature: key,
			operation: signature(event.toolName, event.input, null),
			resultHash: signature("result", null, {
				content: event.content,
				isError: event.isError === true,
				details: event.details ?? null,
			}),
			...(event.toolName === "bash" && isSearchCommand(event.input?.command)
				? { searchOutput: true }
				: {}),
		};
		// Do not index until message_end: parallel siblings finish out of order
		// but persist in source order. A forward pointer could lose its original
		// when the user forks at that result. Same-batch originals stay intact.
		// Original content stays in its normal toolResult entry, with a small id.
		const finish = (selection?: unknown) => ({
			details: {
				...event.details,
				piObservation: ref,
				...(selection ? { piMiniSelection: selection } : {}),
			},
		});
		// The deterministic distiller runs first and its win ends ML routing.
		// Computed once and shared by every gate below (pure function).
		const distilled = distillOutput(event.toolName, text, ref.searchOutput);
		// Keep short successful output byte-for-byte. Error receipts still pass
		// through the bounded failure-family matcher so a small repeated error can
		// retain its related-failure cue.
		const preserveRaw = !event.isError && text.length < RAW_PASSTHROUGH_CHARS;
		// Evidence routing: deterministic content-shape classification decides
		// which ML stages deserve an opportunity. Routing is observability;
		// each gate below still enforces its own eligibility.
		const route = routeEvidence({
			tool: event.toolName,
			text,
			isError: event.isError === true,
			details: event.details,
			distilled: !!distilled,
			evidenceId: key,
		});
		noteHealth("ml.evidence.route", {
			shape: route.shape,
			smol: route.smol,
			kompress: route.kompress,
			needle: route.needle,
			jev: route.jev,
			count: 1,
		});
		// Existing deterministic compression wins. Only bounded successful prose
		// can spend local inference; the original tool body stays in the transcript.
		if (
			miniEligibleTool(event.toolName, event.input) &&
			!event.isError &&
			!event.details?.truncation &&
			!event.details?.truncated &&
			!event.details?.cancelled &&
			!event.details?.aborted &&
			(event.details?.exitCode === undefined || event.details.exitCode === 0) &&
			process.env.PI_OUTPUT_DISTILLER !== "off" &&
			pi.getActiveTools().includes("obs_read") &&
			miniSource(text) &&
			!preserveRaw &&
			!distilled
		) {
			let statusSize = Infinity;
			try {
				statusSize = JSON.stringify({
					isError: false,
					details: event.details ?? {},
				}).length;
			} catch {}
			if (statusSize <= 80)
				return mini
					.select(text, ctx?.model?.cost?.input, taskSignal)
					.then(finish, () => finish());
		}
		// Structured successful line output complements Kompress prose selection.
		// Speculate without delaying this result; a pending first exposure stays
		// raw while a validated source/task cache can serve later observations.
		if (
			process.env.PI_OUTPUT_DISTILLER !== "off" &&
			pi.getActiveTools().includes("obs_read") &&
			!miniSource(text) &&
			safeSmolOutput(
				event.toolName,
				text,
				event.isError === true,
				event.details,
			) &&
			!preserveRaw &&
			!distilled
		) {
			smol.offer(
				`${ref.id}:${ref.signature}`,
				text,
				ctx?.model?.cost?.input,
				taskSignal,
				event.toolName,
			);
		}
		// Oversized line output (4KB..32KB): window to head + diagnostics +
		// tail and select within the window. Rendered with original line
		// numbers; the full original stays behind obs_read.
		if (
			route.smol &&
			!event.isError &&
			typeof (smol as { offerWindowed?: unknown }).offerWindowed === "function" &&
			process.env.PI_OUTPUT_DISTILLER !== "off" &&
			pi.getActiveTools().includes("obs_read") &&
			!miniSource(text) &&
			!safeSmolOutput(event.toolName, text, false, event.details) &&
			!preserveRaw &&
			!distilled
		) {
			(smol as { offerWindowed: (...args: [string, string, unknown, string, string, unknown]) => void }).offerWindowed(
				`${ref.id}:${ref.signature}`,
				text,
				ctx?.model?.cost?.input,
				taskSignal,
				event.toolName,
				event.details,
			);
		}
		// Jev scores chunks only when every deterministic and local path
		// misses: large, successful, undistilled prose with no mini or smol
		// coverage. Offered in the background like smol; the context render
		// below consumes whatever is ready without waiting on slow calls.
		if (
			process.env.PI_OUTPUT_DISTILLER !== "off" &&
			jevEnabled() &&
			pi.getActiveTools().includes("obs_read") &&
			!event.isError &&
			text.length >= 6000 &&
			text.length <= MAX_OUTPUT_CHARS &&
			!miniSource(text) &&
			!safeSmolOutput(event.toolName, text, false, event.details) &&
			!preserveRaw &&
			!distilled
		) {
			offerJevDistill(`${ref.id}:${ref.signature}`, event.toolName, text);
		}
		return finish();
	});

	// Project only tool-result bodies at the context boundary. The transcript is
	// unchanged and obs_read can recover every character, including old branches'
	// active ancestry. Recomputing in source order keeps an append-only prefix
	// stable: later calls cannot alter how an earlier result was represented.
	pi.on("context", async (event) => {
		if (
			process.env.PI_OUTPUT_DISTILLER === "off" ||
			!pi.getActiveTools().includes("obs_read")
		)
			return;
		const skillCalls = new Set(
			event.messages.flatMap((message) =>
				message.role === "assistant" && Array.isArray(message.content)
					? message.content.flatMap((part) =>
							part.type === "toolCall" && isSkillRead(part.name, part.arguments)
								? [part.id]
								: [],
						)
					: [],
			),
		);
		const baselines = new Map<
			string,
			{
				id: number;
				text: string;
				tool: string;
				fingerprint: Set<string> | undefined;
			}
		>();
		const failures: Array<{ id: number; text: string; tool: string }> = [];
		const searchCalls = new Set(
			event.messages.flatMap((message) =>
				message.role === "assistant" && Array.isArray(message.content)
					? message.content.flatMap((part) =>
							part.type === "toolCall" &&
							part.name === "bash" &&
							isSearchCommand(part.arguments?.command)
								? [part.id]
								: [],
						)
					: [],
			),
		);
		let changed = false;
		// A seal is valid only while the history it was rendered against is still
		// visible: a delta receipt whose baseline observation is gone (compaction,
		// branch move) must not be replayed as if it were. The cache is already
		// broken in that case, so re-rendering there costs nothing extra.
		const presentIds = new Set<number>();
		for (const entry of event.messages) {
			const visible = entry?.details?.piObservation?.id;
			if (Number.isSafeInteger(visible)) presentIds.add(visible);
		}
		// Resolve local line selections up front, in parallel under one bounded
		// budget: inference offered at tool_result time usually finished during
		// the agent's reasoning gap, and a nearly-done request is worth a short
		// wait. The sequential map below keeps source-order seals untouched.
		// Take coverage is a superset of rendered messages (late status checks
		// still apply in the map); ml.evidence.delivered, not take transitions, is the
		// rendered-usefulness signal, and frozen selections stay re-readable.
		const smolReady = new Map<number, string | undefined>();
		if (process.env.PI_SMOL_PREPROCESSOR !== "off") {
			const pending: Array<Promise<void>> = [];
			event.messages.forEach((message, index) => {
				const ref = message.details?.piObservation as Reference | undefined;
				if (
					message.role !== "toolResult" ||
					!message.content.every((part) => part.type === "text") ||
					skillCalls.has(message.toolCallId) ||
					ref?.version !== 1 ||
					!ref.operation ||
					!TOOLS.has(message.toolName)
				)
					return;
				const raw = textOf(message.content);
				if (raw.length > MAX_OUTPUT_CHARS || raw.includes("\0")) return;
				if (raw.length < RAW_PASSTHROUGH_CHARS) return;
				pending.push(
					smol
						.takeAsync(`${ref.id}:${ref.signature}`, raw)
						.then(async (value) => {
							const takeWindowed = (smol as { takeWindowed?: (key: string, waitMs?: number, raw?: string) => Promise<string | undefined> }).takeWindowed;
							smolReady.set(
								index,
								value ?? (typeof takeWindowed === "function"
										? await takeWindowed.call(smol, `${ref.id}:${ref.signature}`, 150, raw)
									: undefined),
							);
						}),
				);
			});
			if (pending.length) await Promise.all(pending);
		}
		const jevReady = new Map<number, string | undefined>();
		if (jevEnabled()) {
			const eligible = (message: any) => {
				const ref=message.details?.piObservation as Reference|undefined;
				return message.role==='toolResult'&&ref?.version===1&&ref.operation&&TOOLS.has(message.toolName) ? ref : undefined;
			};
			const waits: Array<Promise<void>> = [];
			for (const message of event.messages) {
				const ref = eligible(message), slot = ref && jevDistillPending.get(`${ref.id}:${ref.signature}`);
				const sealed = ref && sealedRenders.get(ref.id);
				if (slot?.settled && slot.value === undefined && !(sealed && sealed.resultHash === ref.resultHash)) waits.push(slot.settled);
			}
			if (waits.length) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([Promise.all(waits), new Promise<void>(resolve => { timer = setTimeout(resolve, JEV_DISTILL_WAIT_MS); })]);
				clearTimeout(timer);
			}
			event.messages.forEach((message,index)=>{
				const ref=eligible(message);
				if(ref) jevReady.set(index,jevDistillPending.get(`${ref.id}:${ref.signature}`)?.value);
			});
		}
		const messages = event.messages.map((message, index) => {
			if (
				message.role !== "toolResult" ||
				message.content.some((part) => part.type !== "text")
			)
				return message;
			if (skillCalls.has(message.toolCallId)) return message;
			const ref = message.details?.piObservation as Reference | undefined;
			if (ref?.version !== 1 || !ref.operation || !TOOLS.has(message.toolName))
				return message;
			const raw = textOf(message.content);
			if (raw.length > MAX_OUTPUT_CHARS || raw.includes("\0")) return message;
			// The transcript itself is authoritative for small results. Keep the
			// original message and seal a null projection so later context passes
			// cannot introduce a summary after a cache becomes ready.
			if (raw.length < RAW_PASSTHROUGH_CHARS && !message.isError) {
				sealFirstRender(ref.id, ref.resultHash, null, []);
				return message;
			}
			// Carry all foreign status/provenance details verbatim into the visible
			// receipt as well as retaining them on the original toolResult object.
			const {
				piObservation: _ref,
				piMiniSelection: selection,
				...details
			} = message.details ?? {};
			let status: string;
			try {
				status = JSON.stringify({ isError: message.isError === true, details });
			} catch {
				return message;
			}
			if (status.length > 2000) return message;
			const sealed = sealedRenders.get(ref.id);
			if (sealed && sealed.resultHash === ref.resultHash) {
				// The first rendering is authoritative for the branch lifetime.
				// Never re-render here: mini/smol state and baseline availability
				// vary per request, so a re-render flips provider-visible bytes
				// and re-bills the whole prefix. A delta whose baseline is no
				// longer visible degrades to the original in place - one
				// deterministic change, stable afterwards - instead of a
				// per-request projection.
				if (
					sealed.content === null ||
					!sealed.requires.every((required) => presentIds.has(required))
				)
					return message;
				changed = true;
				return { ...message, content: sealed.content };
			}
			// Failure matching only adds a retrieval cue. Existing deterministic
			// distillation still applies and originals remain recoverable.
			let failureHint: string | undefined;
			if (message.isError) {
				const related =
					process.env.PI_LOCAL_INTELLIGENCE === "off"
						? undefined
						: failures
								.slice(-16)
								.filter((item) => item.tool === message.toolName)
								.map((item) => ({
									...item,
									similarity: failureSimilarity(raw, item.text),
								}))
								.filter((item) => item.similarity >= 0.85)
								.sort((a, b) => b.similarity - a.similarity)[0];
				failures.push({ id: ref.id, text: raw, tool: message.toolName });
				if (failures.length > 16) failures.shift();
				if (related)
					failureHint = `[Related historical failure: obs_read({id:${related.id}}); structural similarity ${related.similarity.toFixed(2)}, not a probability or verified resolution. The match does not establish current cause or resolution.]`;
			}
			let baseline = baselines.get(ref.operation);
			const exactChange = (previous: string) =>
				outputDelta(previous, raw) ??
				(process.env.PI_LOCAL_INTELLIGENCE === "off"
					? undefined
					: outputLineDelta(previous, raw));
			let delta =
				!message.isError && !details.truncation && !details.truncated && baseline
					? exactChange(baseline.text)
					: undefined;
			if (
				!message.isError &&
				!delta &&
				!details.truncation &&
				!details.truncated &&
				process.env.PI_LOCAL_INTELLIGENCE !== "off"
			) {
				const fingerprint = structuralFingerprint(raw);
				const candidates = [...baselines.values()]
					.filter((item) => item.tool === message.toolName)
					.map((item) => ({
						item,
						score: fingerprintSimilarity(fingerprint, item.fingerprint),
					}))
					.filter((item) => item.score >= 0.8)
					.sort((a, b) => b.score - a.score)
					.slice(0, 8);
				for (const { item } of candidates) {
					const proposed = exactChange(item.text);
					if (proposed) {
						baseline = item;
						delta = proposed;
						break;
					}
				}
			}
			const summary = delta
				? undefined
				: distillOutput(
						message.toolName,
						raw,
						ref.searchOutput || searchCalls.has(message.toolCallId),
					);
			const localLines = smolReady.get(index);
			const miniRendered =
				!delta && !summary && !message.isError && process.env.PI_MINI_PREPROCESSOR !== "off"
					? miniProjection(raw, selection)
					: undefined;
			const jevLines = jevReady.get(index);
			const selected =
				!delta && !summary && !message.isError
					? (miniRendered ?? localLines ?? jevLines)
					: undefined;
			if (!delta && !summary && !selected) {
				if (
					!message.isError &&
					!details.truncation &&
					!details.truncated &&
					raw.length >= 3000
				) {
					baselines.set(ref.operation, {
						id: ref.id,
						text: raw,
						tool: message.toolName,
						fingerprint: structuralFingerprint(raw),
					});
					if (baselines.size > MAX_ENTRIES)
						baselines.delete(baselines.keys().next().value!);
				}
				if (failureHint) {
					changed = true;
					const content = [
						...message.content,
						{ type: "text" as const, text: failureHint },
					];
					sealFirstRender(ref.id, ref.resultHash, content, []);
					return { ...message, content };
				}
				sealFirstRender(ref.id, ref.resultHash, null, []);
				return message;
			}
			changed = true;
			const projection = delta
				? JSON.stringify({
						kind: "exact-delta",
						baselineObservation: baseline!.id,
						offsetUnit: "UTF-16 code units",
						...delta,
						currentChars: raw.length,
					})
				: (selected ?? summary!.text);
			const projected = [
				{
					type: "text" as const,
					text: `[observation #${ref.id}; ${delta ? "exact change against the full baseline above" : "extractive summary; omitted content is not verified"}; raw: obs_read({id:${ref.id}})]\n${status}\n${projection}${failureHint ? `\n${failureHint}` : ""}`,
				},
			];
			if (!sealed) {
				const helper = selected ? miniRendered ? "kompress" : localLines ? "smol" : "jev" : "deterministic";
				const savedChars = Math.max(0, raw.length - textOf(projected).length);
				microMetrics().rendered(helper, savedChars);
				noteHealth("ml.evidence.delivered", { helper, savedChars, count: 1 });
			}
			sealFirstRender(
				ref.id,
				ref.resultHash,
				projected,
				delta && baseline ? [baseline.id] : [],
			);
			return { ...message, content: projected };
		});
		return changed ? { messages } : undefined;
	});

	pi.registerTool({
		name: "obs_read",
		label: "Read Observation",
		description:
			"Retrieve original tool output by observation id from this session branch. Use query for bounded, locally ranked exact excerpts before rereading a large result. Excerpts omit context and do not prove absence. Omit query for exact original pagination with offset/limit (characters).",
		parameters: Type.Object({
			id: Type.Integer({ minimum: 1 }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, description: "Character offset (default 0)" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE_CHARS })),
			query: Type.Optional(Type.String({ minLength: 3, maxLength: 512, description: "Find relevant exact excerpts; cannot combine with offset" })),
			maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Query excerpt count (default 3)" })),
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
			if (params.query !== undefined) {
				if (params.offset !== undefined) throw new Error("query and offset cannot be combined; omit query for original pagination");
				const result = await retrieveObservation(text, params.query, { limit: params.limit, maxMatches: params.maxMatches, signal });
				signal?.throwIfAborted();
				// A branch switch while local inference ran cannot return stale evidence.
				if (!ctx.sessionManager.getBranch().some(item => item === entry ||
					(item.id === entry.id && reference(item)?.id === params.id && item.type === "message" && item.message.role === "toolResult" && textOf(item.message.content) === text)))
					throw new Error("Observation branch changed during retrieval; retry in the current branch");
				const originalIsError = entry.message.isError === true;
				const content = `[observation #${params.id}; query excerpts; omitted context is not verified; originalIsError=${originalIsError}; scanned ${result.scannedChars}/${text.length} characters; offsets are UTF-16 code units]\n` +
					(result.spans.length ? result.spans.map(span => `[${span.start},${span.end})\n${text.slice(span.start, span.end)}`).join("\n\n") : "No lexical candidates in the scanned prefix. This does not establish absence.") +
					`\n[Full original: obs_read({id:${params.id},offset:0}); ranking=${result.ranking}]`;
				// Completion is returned as evidence, distinct from a ranker merely running.
				if (result.spans.length) noteHealth("ml.evidence.returned", { helper: result.ranking === "needle" || result.ranking === "fused" ? "needle" : "deterministic", savedChars: Math.max(0, text.length - content.length), count: 1 });
				return { content: [{ type: "text" as const, text: content }], details: {
					observationId: params.id, sourceHash: createHash("sha256").update(text).digest("hex"),
					originalIsError, originalExitCode: entry.message.details?.exitCode,
					incomplete: true, ...result,
				} };
			}
			if (params.maxMatches !== undefined) throw new Error("maxMatches requires query");
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
