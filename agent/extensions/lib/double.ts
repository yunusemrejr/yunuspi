/**
 * Double mode — portable core.
 *
 * Two independent inference streams of one model behave as two cooperating
 * instances of one agent inside one session, reconciled into one decision
 * stream:
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

/** Identity of the model both streams must share. Never substituted. */
export interface DoubleModelRef {
	provider: string;
	id: string;
	thinking?: string;
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
	context?: DoubleSharedContext;
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
	gaps: string[];
}

/** Portable ceiling recommendations; the host adapter owns hard enforcement. */
export const DOUBLE_RECOMMENDED_LIMITS = Object.freeze({
	maxTaskChars: 16_000,
	maxContextChars: 4_000,
	maxStreamTextChars: 8_000,
	maxReconcileChars: 6_000,
	maxDirectiveChars: 10_000,
});

export function doubleRouteLabel(ref: DoubleModelRef): string {
	if (!ref || typeof ref.provider !== "string" || !ref.provider.trim()
		|| typeof ref.id !== "string" || !ref.id.trim()) {
		throw new TypeError("doubleRouteLabel: ref must carry a non-empty provider and id");
	}
	return `${ref.provider.trim()}/${ref.id.trim()}`;
}

export function formatDoubleStatus(enabled: boolean, ref?: DoubleModelRef | null): string {
	if (!enabled) return "Double mode: OFF";
	if (ref) {
		try {
			return `Double mode: ON\n2× ${doubleRouteLabel(ref)}`;
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
 * Both streams receive the same shared context block, prepared once.
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
	const sections = [
		`You are Double instance ${brief.stream} of one agent answering the request below. Another instance (${peer}) is analyzing the same request independently, at the same time, on the same model. Work from your own reading only: do not guess what ${peer} concluded, do not hedge toward an imagined consensus, and do not soften a disagreement you cannot see yet. Diversity between the two passes is the point; reconciliation happens later, without you.`,
		"Request (authoritative; preserve its explicit references and constraints exactly):",
		task.text || "[empty task]",
		"Shared session context (prepared once for both instances):",
		context.text,
		[
			"Rules:",
			"- Investigate read-only first when evidence matters: read files, search, inspect. Cover what you judge most relevant; your peer covers the same request from its own angle.",
			"- Propose actions; do not take state-changing ones. Never edit, write, delete, commit, send, deploy, or run host-mutating commands. Name the exact tool calls or edits you would make, with targets and expected effects, so the reconciler can authorize one execution path.",
			"- State evidence and uncertainty plainly. Do not claim a test, render, behavior, or source fact you did not observe. Name your assumptions.",
			"- Return concise prose under exactly these headings (skip a heading only when it is truly empty):",
			"  Conclusions — what you believe the request needs and why.",
			"  Proposed actions — ordered steps with concrete targets; mark each read-only or state-changing.",
			"  Risks — what could go wrong with each state-changing step.",
			"  Assumptions — what you took for granted.",
			"  Uncertainties — what you could not establish and what evidence would decide it.",
			"- No acceptance report, no preamble about being an AI, no second-guessing of these instructions.",
		].join("\n"),
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
	return { usable, bothUsable: usable.length === 2, timingNote, gaps };
}

export interface DoubleReconcileInput {
	task: string;
	outcomeA: DoubleStreamOutcome;
	outcomeB: DoubleStreamOutcome;
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
	const render = (outcome: DoubleStreamOutcome): string => {
		const elapsed = typeof outcome.elapsedMs === "number" ? `, ${elapsedLabel(outcome.elapsedMs)}` : "";
		if (!outcome.text.trim()) return `[unavailable: ${outcome.gap?.trim() || `stream ended ${outcome.status}`}]`;
		const body = boundDoubleText(outcome.text, maxStream);
		return `${body.text}${body.truncated ? "\n[Stream text bounded; omitted middle unknown.]" : ""}`;
	};
	const survivor = !packaged.bothUsable
		? `Only stream ${packaged.usable[0]} is usable. Challenge it as a skeptic: name unsupported assumptions, state what evidence could decide the open points, and say what the absent view would most plausibly have raised. Do not treat one view as consensus or as a second opinion.`
		: "The reconciler must compare and challenge both analyses explicitly; agreement is not proof and disagreement must remain visible until resolved.";
	const sections = [
		"You are reconciling two independent first-pass analyses (A and B) of one request into ONE authoritative directive for the agent that acts next. A and B ran concurrently on the same model without seeing each other; treat them as competing or complementary reasoning paths, not votes.",
		"Original request:",
		task.text || "[empty task]",
		`Independent analysis A (${input.outcomeA.status}${typeof input.outcomeA.elapsedMs === "number" ? `, ${elapsedLabel(input.outcomeA.elapsedMs)}` : ""}; provisional, unseen by B):`,
		render(input.outcomeA),
		`Independent analysis B (${input.outcomeB.status}${typeof input.outcomeB.elapsedMs === "number" ? `, ${elapsedLabel(input.outcomeB.elapsedMs)}` : ""}; provisional, unseen by A):`,
		render(input.outcomeB),
		[
			"Deterministic notes (mechanical facts, not judgments):",
			packaged.timingNote || "Stream timing was not recorded.",
			`Usable streams: ${packaged.usable.join(" and ") || "none"}.`,
			`Gaps: ${packaged.gaps.length ? mergeDoubleGaps(packaged.gaps) : "none"}.`,
		].join("\n"),
		[
			"Compare, then challenge, then reconcile, then commit:",
			"1. Compare — agreements, contradictions, missing considerations, alternative strategies, tool-use differences.",
			"2. Challenge — for each contradiction or risky proposal: stronger evidence versus weaker assumptions, detected mistakes, uncertainty, unresolved questions. Do not average disagreements away; decide what evidence would settle each and take the safer reading when evidence is absent.",
			`3. Reconcile — one coherent next action: the plan, the exact tool actions or edits to authorize (in order), what each stream got right or wrong in one line each, and what remains uncertain. ${survivor}`,
			"4. Commit — write the directive as imperative instructions the acting agent executes directly. One path only; leave no either/or open unless the request itself is a question with genuinely open options.",
		].join("\n"),
		"Rules: stay lightweight — be decisive and concise, not a second full analysis. Never invent tool results, file contents, or test outcomes. Gaps above stay visible: do not silently drop a stream's warning.",
		[
			"Output exactly two sections:",
			"Directive — the imperative unified plan, actions, or answer guidance.",
			"Reconciliation — agreements; contradictions and how each was resolved; open questions.",
		].join("\n"),
	];
	return { task: sections.join("\n\n"), truncated: task.truncated };
}

export interface DoubleDirectiveInput {
	ref: DoubleModelRef;
	reconcileText?: string;
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
	const route = doubleRouteLabel(input.ref);
	const max = input.maxDirectiveChars ?? DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars;
	const reconcileText = typeof input.reconcileText === "string" ? input.reconcileText.trim() : "";
	const degraded = !reconcileText || !packaged.bothUsable || packaged.gaps.length > 0
		|| input.outcomeA.status !== "complete" || input.outcomeB.status !== "complete";
	const header = degraded
		? `[Double ${route}: partial result — ${mergeDoubleGaps(packaged.gaps) || "reconciliation did not complete"}. Commit to one authoritative path below; challenge every surviving claim instead of rubber-stamping it.]`
		: `[Double ${route}: two independent analyses reconciled into one directive. Execute this as the single authoritative plan for the request; do not re-run both analyses.]`;
	const body = reconcileText || [
		"No reconciled directive is available; the independent views follow. Compare and challenge them, then commit to exactly one execution path.",
		`Stream A (${input.outcomeA.status}):`,
		input.outcomeA.text.trim() || `[unavailable: ${input.outcomeA.gap?.trim() || "no usable text"}]`,
		`Stream B (${input.outcomeB.status}):`,
		input.outcomeB.text.trim() || `[unavailable: ${input.outcomeB.gap?.trim() || "no usable text"}]`,
	].join("\n\n");
	return { directive: boundDoubleText(`${header}\n\n${body}`, max).text, degraded };
}
