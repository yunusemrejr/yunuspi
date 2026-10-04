/**
 * Double mode — portable core.
 *
 * Two independent inference streams behave as two cooperating instances of one
 * agent inside one session, reconciled into one decision stream. The streams
 * run the same model twice, or two different models the user chose (a pair):
 *
 *   Independent A ∥ Independent B → Compare → Challenge → Reconcile → Commit
 *
 * This module is deliberately free of harness imports. It depends only on
 * generic concepts — session, model, provider, context, inference stream,
 * tool proposal, reconciliation, execution — so the same mechanism ports to
 * any agent harness. Host wiring (launching streams, session events, cost
 * accounting, UI) lives in the harness adapter, not here.
 *
 * Independence rule: a stream's first pass must never see the other stream's
 * reasoning. Peer awareness ("another instance works on the same task") is
 * supplied; peer content is not. Content meets only at reconciliation.
 */

/** One of the two cooperating inference streams. */
export type DoubleStreamId = "A" | "B";

/** Identity of the model a stream must run on. Never substituted. */
export interface DoubleModelRef {
	provider: string;
	id: string;
	thinking?: string;
}

/** Which route runs the reconciliation pass of a two-model pair. "session" is
 * the model that will act on the directive. */
export type DoubleReconciler = "a" | "b" | "session";

/** Two chosen routes for the two streams. The twin mode (one model, twice) has no pair. */
export interface DoublePair {
	a: DoubleModelRef;
	b: DoubleModelRef;
	reconcile: DoubleReconciler;
}

/** Shared immutable context, prepared once and supplied to both streams. */
export interface DoubleSharedContext {
	cwd?: string;
	toolNames?: string[];
	skillNames?: string[];
	memoryNote?: string;
	extra?: string;
}

export interface DoubleStreamBrief {
	stream: DoubleStreamId;
	/** The user's request, verbatim where possible. */
	task: string;
	/** Requirements extracted from the request by the host, as verbatim excerpts. */
	requirements?: readonly string[];
	context?: DoubleSharedContext;
	/** Present when the two streams run on different routes. */
	pair?: DoublePair;
	maxTaskChars?: number;
	maxContextChars?: number;
}

export type DoubleStreamStatus = "complete" | "partial" | "failed" | "cancelled";

export interface DoubleStreamOutcome {
	stream: DoubleStreamId;
	status: DoubleStreamStatus;
	/** Bounded usable output; empty when the stream produced nothing usable. */
	text: string;
	gap?: string;
	elapsedMs?: number;
	attempts?: number;
}

export interface DoublePackagedStreams {
	usable: DoubleStreamId[];
	bothUsable: boolean;
	timingNote: string;
	/** Mechanical comparison of the files each stream names; empty when neither names any. */
	overlapNote: string;
	gaps: string[];
}

/** Portable ceiling recommendations; the host adapter owns hard enforcement. */
export const DOUBLE_RECOMMENDED_LIMITS = Object.freeze({
	maxTaskChars: 16_000,
	maxContextChars: 4_000,
	maxStreamTextChars: 8_000,
	maxReconcileChars: 6_000,
	maxDirectiveChars: 10_000,
	maxRequirementChars: 1_600,
});

export function doubleRouteLabel(ref: DoubleModelRef): string {
	if (!ref || typeof ref.provider !== "string" || !ref.provider.trim()
		|| typeof ref.id !== "string" || !ref.id.trim()) {
		throw new TypeError("doubleRouteLabel: ref must carry a non-empty provider and id");
	}
	return `${ref.provider.trim()}/${ref.id.trim()}`;
}

/** Route plus the pinned thinking level, for prose that names a stream's model. */
export function doubleRefLabel(ref: DoubleModelRef): string {
	const route = doubleRouteLabel(ref);
	const thinking = typeof ref.thinking === "string" ? ref.thinking.trim() : "";
	return thinking ? `${route} (thinking ${thinking})` : route;
}

export function doublePairLabel(pair: DoublePair): string {
	return `A ${doubleRouteLabel(pair.a)} ∥ B ${doubleRouteLabel(pair.b)}`;
}

/** True when both streams would run on one provider/model (thinking aside). */
export function doublePairSameRoute(pair: DoublePair): boolean {
	return doubleRouteLabel(pair.a) === doubleRouteLabel(pair.b);
}

export function doubleReconcilerLabel(pair: DoublePair): string {
	return pair.reconcile === "a" ? `A (${doubleRouteLabel(pair.a)})`
		: pair.reconcile === "b" ? `B (${doubleRouteLabel(pair.b)})`
			: "the session model";
}

export function formatDoubleStatus(enabled: boolean, ref?: DoubleModelRef | null, pair?: DoublePair | null): string {
	if (!enabled) return "Double mode: OFF";
	if (pair) {
		try {
			return `Double mode: ON (custom pair)\n${doublePairLabel(pair)} + reconcile on ${doubleReconcilerLabel(pair)}`;
		} catch {
			/* fall through to the single-route state */
		}
	}
	if (ref) {
		try {
			return `Double mode: ON\nTwin first-pass (A ∥ B) + reconcile · ${doubleRouteLabel(ref)}`;
		} catch {
			/* fall through to the unlabelled ON state */
		}
	}
	return "Double mode: ON";
}

export type DoubleCommandIntent = "toggle" | "on" | "off" | "status";

export function parseDoubleCommandArgs(args: unknown): DoubleCommandIntent {
	const text = typeof args === "string" ? args.trim().toLowerCase() : "";
	if (!text) return "toggle";
	if (text === "on" || text === "enable") return "on";
	if (text === "off" || text === "disable") return "off";
	if (text === "status" || text === "state") return "status";
	throw new TypeError(`parseDoubleCommandArgs: expected "", "on", "off" or "status", got ${JSON.stringify(text)}`);
}

export type CustomDoubleIntent =
	| { kind: "picker" }
	| { kind: "resume" }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "pair"; a: string; b: string; reconcile?: DoubleReconciler };

const CUSTOM_DOUBLE_USAGE = "Usage: /custom-double [provider/model[:thinking] provider/model[:thinking]] [reconcile=a|b|session] | on | off | status";

/**
 * `/custom-double` with no arguments opens the picker; two model tokens set the
 * pair without it (headless sessions, scripts). Model tokens stay raw strings:
 * resolving them against the live registry is the host adapter's job.
 */
export function parseCustomDoubleArgs(args: unknown): CustomDoubleIntent {
	const text = typeof args === "string" ? args.trim() : "";
	const lower = text.toLowerCase();
	if (!text || lower === "pick" || lower === "choose" || lower === "edit") return { kind: "picker" };
	if (lower === "on" || lower === "enable" || lower === "resume") return { kind: "resume" };
	if (lower === "off" || lower === "disable") return { kind: "off" };
	if (lower === "status" || lower === "state") return { kind: "status" };
	let reconcile: DoubleReconciler | undefined;
	const tokens: string[] = [];
	for (const token of text.split(/\s+/)) {
		const match = /^reconcile[=:](a|b|session)$/i.exec(token);
		if (match) { reconcile = match[1]!.toLowerCase() as DoubleReconciler; continue; }
		tokens.push(token);
	}
	if (tokens.length !== 2) throw new TypeError(`parseCustomDoubleArgs: expected two models. ${CUSTOM_DOUBLE_USAGE}`);
	return { kind: "pair", a: tokens[0]!, b: tokens[1]!, ...(reconcile ? { reconcile } : {}) };
}

/**
 * A forked stream carries the whole session transcript, so it fits a model only
 * when the model's window holds that transcript, the stream prompt and the
 * read-only tool results the stream reads. Unknown sizes count as fitting: the
 * check exists to skip a launch that is certain to overflow, not to guess.
 */
export function doubleContextFits(contextWindow: unknown, transcriptTokens: unknown, reserveTokens = 24_000): boolean {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return true;
	if (typeof transcriptTokens !== "number" || !Number.isFinite(transcriptTokens) || transcriptTokens < 0) return true;
	return Math.ceil(transcriptTokens * 1.1) + reserveTokens <= contextWindow;
}

/**
 * Bounds literal content without inventing replacements. Oversized text keeps
 * its head and tail around an explicit omission marker; the omitted middle
 * is unknown, never summarized.
 */
export function boundDoubleText(value: unknown, max: number): { text: string; truncated: boolean } {
	if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
		throw new TypeError("boundDoubleText: max must be a positive integer");
	}
	if (typeof value !== "string") return { text: "", truncated: value !== undefined };
	const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
	if (text.length <= max) return { text, truncated: false };
	const omitted = "[Double omitted the middle of an oversized text; the omitted part is unknown.]";
	if (max <= omitted.length + 2) return { text: text.slice(0, Math.max(0, max)), truncated: true };
	const remaining = max - omitted.length - 2;
	const left = Math.ceil(remaining / 2);
	const right = Math.max(0, remaining - left);
	return {
		text: `${text.slice(0, left)}\n${omitted}\n${right ? text.slice(-right) : ""}`,
		truncated: true,
	};
}

export function mergeDoubleGaps(gaps: unknown): string {
	if (!Array.isArray(gaps)) return "";
	return [...new Set(gaps.map((gap) => typeof gap === "string" ? gap.trim() : "").filter(Boolean))].join(" ");
}

const DOUBLE_TRANSIENT_MARKERS = /\b(timeout|timed?\s?out|deadline\s?exceeded|429|502|503|504|econnreset|etimedout|eai_again|socket\s?hang\s?up|overloaded|over\s?capacity|capacity|rate[\s-]?limit|temporar\w+|transient|try\s?again|service\s?unavailable|server\s?error|internal\s?error|connection\s?(reset|refused|aborted)|network\s?(error|failure)|fetch\s?failed)\b/i;
const DOUBLE_DETERMINISTIC_MARKERS = /\b(budget|blocked|denied|deny|permission|forbidden|unauthorized|unauthenticated|invalid|not\s?found|no\s?such|unknown\s?model|capability|ceiling|excluded|excludes|validation|schema|auth|api\s?key|quota\s?exceeded|insufficient|provider[\s-]?gate\s?deferral|cooldown[\s-]active)\b/i;

/**
 * Heuristic retry gate: true only when a failure reason reads as plausibly
 * transient (overload, rate limit, timeout, network blip) rather than
 * deterministic (budget, permissions, validation, unknown model, or a route the
 * provider gate already holds in cooldown, which a relaunch would hit again). Pure
 * string judgment — the host adapter still owns deadline and row-flag checks.
 */
export function isDoubleTransientFailure(reason: unknown): boolean {
	if (typeof reason !== "string" || !reason.trim()) return false;
	return DOUBLE_TRANSIENT_MARKERS.test(reason) && !DOUBLE_DETERMINISTIC_MARKERS.test(reason);
}

/**
 * A bare acknowledgement ("ok", "thanks") brings no request to analyze twice:
 * both streams would only re-read the transcript. Approvals and directives
 * ("do it", "continue", "go ahead") authorize work and are still doubled.
 */
export function isDoubleAcknowledgement(prompt: unknown): boolean {
	if (typeof prompt !== "string") return false;
	const text = prompt.trim().toLowerCase().replace(/[.!\s]+$/g, "");
	if (!text || text.length > 40) return false;
	return /^(?:ok(?:ay)?|k|yes|yep|yeah|yup|sure|y|thanks?|thank you|thx|ty|great|perfect|nice|good|cool|got it|sounds good|lgtm|looks good|👍)$/.test(text);
}

function requirementBlock(requirements: readonly string[] | undefined, maxChars: number): string {
	if (!Array.isArray(requirements)) return "";
	const rows: string[] = [];
	let used = 0;
	for (const raw of requirements) {
		if (typeof raw !== "string") continue;
		const row = `- ${raw.replace(/\s+/g, " ").trim()}`;
		if (row.length < 4 || used + row.length + 1 > maxChars) continue;
		rows.push(row);
		used += row.length + 1;
	}
	return rows.length
		? `Requirements extracted from the user's words (verbatim excerpts; the user's own words outrank this list):\n${rows.join("\n")}`
		: "";
}

const FILE_REFERENCE = /(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|php|rb|cc?|cpp|hpp?|cs|sh|json|ya?ml|toml|md|html?|css|scss|sql|vue|svelte|kt|swift)\b/gi;

/** Mechanical comparison of the files two analyses name: facts for the reconciler, not a judgment. */
export function doubleOverlapNote(a: string, b: string): string {
	const files = (text: string) => new Set((String(text ?? "").match(FILE_REFERENCE) ?? []).map((file) => file.toLowerCase()).filter((file) => file.length <= 120));
	const fa = files(a);
	const fb = files(b);
	if (fa.size + fb.size === 0) return "";
	const shared = [...fa].filter((file) => fb.has(file));
	const onlyA = [...fa].filter((file) => !fb.has(file));
	const onlyB = [...fb].filter((file) => !fa.has(file));
	const list = (items: string[]) => items.length ? ` (${items.slice(0, 4).join(", ")}${items.length > 4 ? ", …" : ""})` : "";
	return `Named files: ${shared.length} in both${list(shared)}, ${onlyA.length} only in A${list(onlyA)}, ${onlyB.length} only in B${list(onlyB)}; overlap ${Math.round((100 * shared.length) / (fa.size + onlyB.length))}%.`;
}

function contextBlock(context: DoubleSharedContext | undefined, maxChars: number): { text: string; truncated: boolean } {
	if (!context || typeof context !== "object") return { text: "[none supplied]", truncated: false };
	const lines: string[] = [];
	if (typeof context.cwd === "string" && context.cwd.trim()) lines.push(`Working directory: ${context.cwd.trim()}`);
	if (Array.isArray(context.toolNames) && context.toolNames.length) {
		lines.push(`Available tools: ${context.toolNames.filter((name) => typeof name === "string" && name.trim()).join(", ")}`);
	}
	if (Array.isArray(context.skillNames) && context.skillNames.length) {
		lines.push(`Available skills: ${context.skillNames.filter((name) => typeof name === "string" && name.trim()).join(", ")}`);
	}
	if (typeof context.memoryNote === "string" && context.memoryNote.trim()) lines.push(`Session memory: ${context.memoryNote.trim()}`);
	if (typeof context.extra === "string" && context.extra.trim()) lines.push(context.extra.trim());
	if (!lines.length) return { text: "[none supplied]", truncated: false };
	return boundDoubleText(lines.join("\n"), maxChars);
}

/**
 * Builds the independent first-pass task for one stream. The brief names the
 * peer (awareness) but carries none of the peer's content (independence).
 *
 * Cache order: everything the two instances share (framing, request,
 * requirements, context, rules) comes first and is byte-identical for A and
 * B, so the second instance's prompt prefix is already cached by the time it
 * starts. Only the closing identity and angle differ, and being last they
 * are also the freshest instruction when the instance begins.
 */
export function buildDoubleStreamTask(brief: DoubleStreamBrief): { task: string; truncated: boolean } {
	if (!brief || typeof brief !== "object") throw new TypeError("buildDoubleStreamTask: brief must be an object");
	if (brief.stream !== "A" && brief.stream !== "B") throw new TypeError("buildDoubleStreamTask: brief.stream must be \"A\" or \"B\"");
	if (typeof brief.task !== "string" || !brief.task.trim()) {
		throw new TypeError("buildDoubleStreamTask: brief.task must be a non-empty string");
	}
	const peer = brief.stream === "A" ? "B" : "A";
	const task = boundDoubleText(brief.task, brief.maxTaskChars ?? DOUBLE_RECOMMENDED_LIMITS.maxTaskChars);
	const context = contextBlock(brief.context, brief.maxContextChars ?? DOUBLE_RECOMMENDED_LIMITS.maxContextChars);
	const requirements = requirementBlock(brief.requirements, DOUBLE_RECOMMENDED_LIMITS.maxRequirementChars);
	// Complementary lenses on the SAME task, evidence, model and context.
	// A constructs the strongest affirmative case; B independently attacks
	// the problem for what a conventional pass overlooks. Same headings,
	// same rules, same read-only ceiling — only the reasoning angle differs.
	const lens = brief.stream === "A"
		? "Your angle: construct the strongest solution or interpretation. Build the best-supported reading of the request, the most coherent plan that follows from it, and the concrete actions it implies. Ground every claim in evidence you actually observed; where the request is ambiguous, commit to the most defensible reading and say why. Your peer (B) independently stress-tests the same request from its own angle; you never see its output."
		: "Your angle: independently stress-test the request. Hunt for what a conventional first pass would overlook: hidden assumptions, failure modes, contradictory evidence, simpler alternatives, architectural weaknesses, edge cases, and reasons the obvious reading might be wrong. You answer the same request from the same evidence and context — you just attack it from the skeptical side. Your peer (A) independently constructs the strongest affirmative case; you never see its output.";
	// Two different models share evidence and context but not a prompt cache, and
	// their difference is part of the point; the intro says so and names both.
	const intro = brief.pair
		? `You are one of two Double instances (A and B) of one agent answering the request below. The other instance is analyzing the same request independently, at the same time, on the same evidence and context, but on a different model (A runs ${doubleRefLabel(brief.pair.a)}; B runs ${doubleRefLabel(brief.pair.b)}). Work from your own reading only: do not guess what your peer concluded, do not hedge toward an imagined consensus, and do not soften a disagreement you cannot see yet. Different models make different mistakes, and that diversity is the point; reconciliation happens later, without you.`
		: "You are one of two Double instances (A and B) of one agent answering the request below. The other instance is analyzing the same request independently, at the same time, on the same model, thinking level and evidence. Work from your own reading only: do not guess what your peer concluded, do not hedge toward an imagined consensus, and do not soften a disagreement you cannot see yet. Diversity between the two passes is the point; reconciliation happens later, without you.";
	const sections = [
		intro,
		"Request (authoritative; preserve its explicit references and constraints exactly):",
		task.text || "[empty task]",
		...(requirements ? [requirements] : []),
		"Shared session context (prepared once for both instances):",
		context.text,
		[
			"Rules:",
			"- Investigate read-only first when evidence matters: read files, search, inspect. Cover what you judge most relevant; your peer covers the same request from its own angle.",
			"- Propose actions; do not take state-changing ones. Never edit, write, delete, commit, send, deploy, or run host-mutating commands. Name the exact tool calls or edits you would make, with targets and expected effects, so the reconciler can authorize one execution path.",
			"- State evidence and uncertainty plainly. Do not claim a test, render, behavior, or source fact you did not observe. Name your assumptions.",
			"- Every proposed action must satisfy the request's explicit constraints and the requirements listed above; say so when a tempting action would violate one.",
			"- Return concise prose under exactly these headings (skip a heading only when it is truly empty):",
			"  Conclusions — what you believe the request needs and why.",
			"  Proposed actions — ordered steps with concrete targets; mark each read-only or state-changing.",
			"  Risks — what could go wrong with each state-changing step.",
			"  Assumptions — what you took for granted.",
			"  Uncertainties — what you could not establish and what evidence would decide it.",
			"- No acceptance report, no preamble about being an AI, no second-guessing of these instructions.",
		].join("\n"),
		`You are Double instance ${brief.stream}; the other instance is ${peer}. ${lens}`,
	];
	return { task: sections.join("\n\n"), truncated: task.truncated || context.truncated };
}

function validateOutcome(outcome: unknown, label: string): asserts outcome is DoubleStreamOutcome {
	const value = outcome as Record<string, unknown>;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label}: must be an object`);
	}
	if (value.stream !== "A" && value.stream !== "B") throw new TypeError(`${label}.stream: must be "A" or "B"`);
	if (value.status !== "complete" && value.status !== "partial" && value.status !== "failed" && value.status !== "cancelled") {
		throw new TypeError(`${label}.status: must be complete|partial|failed|cancelled`);
	}
	if (typeof value.text !== "string") throw new TypeError(`${label}.text: must be a string`);
	if (value.gap !== undefined && typeof value.gap !== "string") throw new TypeError(`${label}.gap: must be a string`);
	if (value.elapsedMs !== undefined && (typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)) {
		throw new TypeError(`${label}.elapsedMs: must be a non-negative finite number`);
	}
}

function elapsedLabel(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	return `${Math.round(ms / 6000) / 10}m`;
}

/**
 * Deterministic packaging of the two finished streams: usability, timing
 * facts and gaps. No semantic judgment — the reconciler judges.
 */
export function packageDoubleStreams(a: DoubleStreamOutcome, b: DoubleStreamOutcome): DoublePackagedStreams {
	validateOutcome(a, "outcomeA");
	validateOutcome(b, "outcomeB");
	if (a.stream !== "A" || b.stream !== "B") {
		throw new TypeError("packageDoubleStreams: outcomes must be stream A then stream B");
	}
	const usable = ([a, b] as DoubleStreamOutcome[])
		.filter((outcome) => outcome.text.trim().length > 0)
		.map((outcome) => outcome.stream);
	let timingNote = "";
	if (typeof a.elapsedMs === "number" && typeof b.elapsedMs === "number") {
		const delta = Math.abs(a.elapsedMs - b.elapsedMs);
		if (delta >= 5000) {
			const first = a.elapsedMs <= b.elapsedMs ? "A" : "B";
			timingNote = `Stream ${first} finished ${elapsedLabel(delta)} before its peer; the slower stream still ran to its own conclusion.`;
		} else {
			timingNote = `Both streams finished within ${elapsedLabel(delta)} of each other.`;
		}
	}
	const gaps: string[] = [];
	for (const outcome of [a, b]) {
		if (outcome.gap?.trim()) gaps.push(outcome.gap.trim());
		else if (outcome.status !== "complete" || !outcome.text.trim()) {
			gaps.push(`Stream ${outcome.stream} ended ${outcome.status} with no usable text.`);
		}
	}
	const overlapNote = usable.length === 2 ? doubleOverlapNote(a.text, b.text) : "";
	return { usable, bothUsable: usable.length === 2, timingNote, overlapNote, gaps };
}

export interface DoubleReconcileInput {
	task: string;
	/** Requirements extracted from the request by the host, as verbatim excerpts. */
	requirements?: readonly string[];
	outcomeA: DoubleStreamOutcome;
	outcomeB: DoubleStreamOutcome;
	/** Present when the two streams ran on different routes. */
	pair?: DoublePair;
	maxTaskChars?: number;
	maxStreamTextChars?: number;
}

/**
 * Builds the lightweight reconciliation task: compare, challenge, reconcile,
 * commit. Handles the degraded single-survivor case explicitly instead of
 * treating one view as consensus.
 */
export function buildDoubleReconcileTask(input: DoubleReconcileInput): { task: string; truncated: boolean } {
	if (!input || typeof input !== "object") throw new TypeError("buildDoubleReconcileTask: input must be an object");
	if (typeof input.task !== "string" || !input.task.trim()) {
		throw new TypeError("buildDoubleReconcileTask: input.task must be a non-empty string");
	}
	validateOutcome(input.outcomeA, "outcomeA");
	validateOutcome(input.outcomeB, "outcomeB");
	const packaged = packageDoubleStreams(input.outcomeA, input.outcomeB);
	if (!packaged.bothUsable && packaged.usable.length === 0) {
		throw new TypeError("buildDoubleReconcileTask: at least one stream must carry usable text");
	}
	const maxTask = input.maxTaskChars ?? DOUBLE_RECOMMENDED_LIMITS.maxTaskChars;
	const maxStream = input.maxStreamTextChars ?? DOUBLE_RECOMMENDED_LIMITS.maxStreamTextChars;
	const task = boundDoubleText(input.task, maxTask);
	const requirements = requirementBlock(input.requirements, DOUBLE_RECOMMENDED_LIMITS.maxRequirementChars);
	const render = (outcome: DoubleStreamOutcome): string => {
		const elapsed = typeof outcome.elapsedMs === "number" ? `, ${elapsedLabel(outcome.elapsedMs)}` : "";
		if (!outcome.text.trim()) return `[unavailable: ${outcome.gap?.trim() || `stream ended ${outcome.status}`}]`;
		const body = boundDoubleText(outcome.text, maxStream);
		return `${body.text}${body.truncated ? "\n[Stream text bounded; omitted middle unknown.]" : ""}`;
	};
	const survivor = !packaged.bothUsable
		? `Only stream ${packaged.usable[0]} is usable — this is one view, never consensus. Adversarially review it: actively try to refute its key claims, name unsupported assumptions, state what evidence could decide the open points, and say what the absent view would most plausibly have raised against it. Carry every surviving warning into the directive.`
		: "Compare and challenge both analyses explicitly; agreement is not proof and disagreement must remain visible until resolved. Preserve useful minority findings even when the majority path wins: name which minority points survive into the directive and why.";
	const sections = [
		input.pair
			? `You are reconciling two independent first-pass analyses (A and B) of one request into ONE authoritative directive for the agent that acts next. A and B ran concurrently on two different models (A: ${doubleRefLabel(input.pair.a)}; B: ${doubleRefLabel(input.pair.b)}) without seeing each other; treat them as competing or complementary reasoning paths, not votes. Different models fail differently, so a claim both reach independently carries more weight than one model agreeing with itself, but it is still not proof: look for the blind spot they share. Never defer to a model's reputation; weigh each claim by the evidence behind it, and say which stream raised each minority point you keep.`
			: "You are reconciling two independent first-pass analyses (A and B) of one request into ONE authoritative directive for the agent that acts next. A and B ran concurrently on the same model without seeing each other; treat them as competing or complementary reasoning paths, not votes.",
		"Original request:",
		task.text || "[empty task]",
		...(requirements ? [requirements] : []),
		`Independent analysis A (${input.outcomeA.status}${typeof input.outcomeA.elapsedMs === "number" ? `, ${elapsedLabel(input.outcomeA.elapsedMs)}` : ""}; provisional, unseen by B):`,
		render(input.outcomeA),
		`Independent analysis B (${input.outcomeB.status}${typeof input.outcomeB.elapsedMs === "number" ? `, ${elapsedLabel(input.outcomeB.elapsedMs)}` : ""}; provisional, unseen by A):`,
		render(input.outcomeB),
		[
			"Deterministic notes (mechanical facts, not judgments):",
			packaged.timingNote || "Stream timing was not recorded.",
			...(packaged.overlapNote ? [packaged.overlapNote] : []),
			`Usable streams: ${packaged.usable.join(" and ") || "none"}.`,
			`Gaps: ${packaged.gaps.length ? mergeDoubleGaps(packaged.gaps) : "none"}.`,
		].join("\n"),
		[
			"Compare, then challenge, then reconcile, then commit:",
			"1. Compare — agreements, contradictions, evidence strength behind each claim (observed versus assumed), assumptions, risks, unresolved questions, and proposed tool actions side by side. Note missing considerations and alternative strategies either stream overlooked.",
			"2. Challenge — reject any proposed action that conflicts with the request's explicit constraints or the requirements above. For each contradiction or risky proposal: weigh stronger evidence against weaker assumptions, name detected mistakes, and either choose the better-supported side or define exactly what evidence would decide it. Agreement is not proof: re-check each agreement for shared blind spots and independent evidence. Do not average disagreements away; take the safer reading when evidence is absent. Preserve useful minority findings instead of silently dropping them.",
			`3. Reconcile — one coherent next action: the plan, the exact tool actions or edits to authorize (in order), what each stream got right or wrong in one line each, and what remains uncertain. ${survivor}`,
			"4. Commit — write the directive as imperative instructions the acting agent executes directly. One path only; leave no either/or open unless the request itself is a question with genuinely open options.",
		].join("\n"),
		"Rules: stay lightweight — be decisive and concise, not a second full analysis. Never invent tool results, file contents, or test outcomes. Gaps above stay visible: do not silently drop a stream's warning.",
		[
			"Output exactly two sections:",
			"Directive — the imperative unified plan, actions, or answer guidance.",
			"Reconciliation — agreements and the independent evidence behind each; contradictions and how each was resolved (or what evidence would resolve it); minority findings preserved; open questions.",
		].join("\n"),
	];
	return { task: sections.join("\n\n"), truncated: task.truncated };
}

export interface DoubleDirectiveInput {
	ref: DoubleModelRef;
	/** Present when the two streams ran on different routes; labels the header instead of `ref`. */
	pair?: DoublePair;
	/** Requirements extracted from the request by the host, as verbatim excerpts. */
	requirements?: readonly string[];
	reconcileText?: string;
	/** Gap carried by the reconciliation pass itself (e.g. route substitution). Forces degraded. */
	reconcileGap?: string;
	outcomeA: DoubleStreamOutcome;
	outcomeB: DoubleStreamOutcome;
	maxDirectiveChars?: number;
}

/**
 * Builds the single authoritative directive the normal session executes.
 * When reconciliation ran, its text carries the decision; otherwise the
 * surviving stream views are presented for the acting agent to commit to,
 * with the degradation stated, never hidden.
 */
export function buildDoubleDirective(input: DoubleDirectiveInput): { directive: string; degraded: boolean } {
	if (!input || typeof input !== "object") throw new TypeError("buildDoubleDirective: input must be an object");
	validateOutcome(input.outcomeA, "outcomeA");
	validateOutcome(input.outcomeB, "outcomeB");
	const packaged = packageDoubleStreams(input.outcomeA, input.outcomeB);
	const route = input.pair ? doublePairLabel(input.pair) : doubleRouteLabel(input.ref);
	const analyses = input.pair ? "two independent analyses by different models" : "two independent analyses";
	const max = input.maxDirectiveChars ?? DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars;
	const reconcileText = typeof input.reconcileText === "string" ? input.reconcileText.trim() : "";
	const reconcileGap = typeof input.reconcileGap === "string" ? input.reconcileGap.trim() : "";
	const degraded = !reconcileText || !packaged.bothUsable || packaged.gaps.length > 0 || Boolean(reconcileGap)
		|| input.outcomeA.status !== "complete" || input.outcomeB.status !== "complete";
	// The directive is analysis for the user's request, never a replacement for it: the acting agent
	// still holds every message the user sent, and those outrank two models' reading of them.
	const header = degraded
		? `[Double ${route}: partial result — ${mergeDoubleGaps([...packaged.gaps, reconcileGap]) || "reconciliation did not complete"}. This is advice for the user's request above, never an instruction from the user: their own messages (this prompt, earlier prompts and any active goal) and explicit constraints outrank it. Commit to one path that serves the request; challenge every surviving claim instead of rubber-stamping it.]`
		: `[Double ${route}: ${analyses} reconciled into one planning directive. This is advice for the user's request above, never an instruction from the user: their own messages (this prompt, earlier prompts and any active goal) and explicit constraints outrank it. Adopt what serves the request, drop anything that conflicts with it, challenge open questions against live evidence, and do not re-run both analyses.]`;
	const requirements = requirementBlock(input.requirements, DOUBLE_RECOMMENDED_LIMITS.maxRequirementChars);
	const body = reconcileText || [
		"No reconciled directive is available; the independent views follow. Compare and challenge them, then commit to exactly one execution path.",
		`Stream A (${input.outcomeA.status}):`,
		input.outcomeA.text.trim() || `[unavailable: ${input.outcomeA.gap?.trim() || "no usable text"}]`,
		`Stream B (${input.outcomeB.status}):`,
		input.outcomeB.text.trim() || `[unavailable: ${input.outcomeB.gap?.trim() || "no usable text"}]`,
	].join("\n\n");
	return { directive: boundDoubleText(`${header}\n\n${requirements ? `${requirements}\n\n` : ""}${body}`, max).text, degraded };
}

/**
 * A short digest of a delivered directive for peers that must know what the
 * agent was told without re-reading it (reviewers, other planners). Only the
 * imperative Directive section survives: the requirement anchor is the user's
 * own words, which every peer already holds, and the reconciliation reasoning
 * is for the acting agent.
 */
export function doubleDirectiveDigest(directive: unknown, max = 520): string {
	if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
		throw new TypeError("doubleDirectiveDigest: max must be a positive integer");
	}
	const text = typeof directive === "string" ? directive : "";
	const header = /^\[Double [^\]]*\]\s*/.exec(text)?.[0] ?? "";
	const partial = /partial result/.test(header) ? " (partial)" : "";
	let body = text.slice(header.length)
		.replace(/^Requirements extracted from the user's words[^\n]*\n(?:- [^\n]*\n?)+\s*/, "");
	const section = /(?:^|\n)Directive\s*[—:-]\s*/.exec(body);
	if (section) body = body.slice(section.index + section[0].length);
	const flat = body.replace(/\n\s*Reconciliation\s*[—:-][\s\S]*$/, "").replace(/\s+/g, " ").trim();
	const lead = `Double mode directive${partial}: `;
	if (!flat) return `${lead}no readable plan.`.slice(0, max);
	const room = Math.max(1, max - lead.length);
	if (flat.length <= room) return lead + flat;
	const cut = flat.slice(0, room - 1);
	const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
	return `${lead}${sentence > room * 0.5 ? cut.slice(0, sentence + 1) : cut.trimEnd()}…`;
}
