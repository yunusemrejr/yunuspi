/**
 * Review/council coordination policy — distinct purposes, trivial-work
 * suppression and stuck-signal gating for multi-agent workflows.
 *
 * This module is pure policy: it owns no launcher, model selection or
 * persistence. Every kind below reuses an existing mechanism:
 *
 *   quality  implementation quality and regressions -> the quality-review
 *            lifecycle (lib/quality-review.ts) with its native runner.
 *   project  architecture, goals, consistency, debt and direction -> a
 *            bounded advisory helper through the native subagent executor.
 *   error    likely faults, root causes, failed assumptions, debugging
 *            leads -> a bounded advisory helper, suggested on stuck signals.
 *   council  structured multi-perspective reasoning -> the automatic
 *            scope-council runner, or the supervisor-mediated council prompt
 *            (`prompt-workflow` council) for deliberate use.
 *   swarm    separable parallel investigations -> assistance-plan swarm mode
 *            with the native executor and swarm-recovery respawns.
 *   fusion   competing approaches -> fusion-mode workers merged by the
 *            deterministic fusion planner.
 *
 * The main agent always remains the coordinator: it can invoke any of these
 * deliberately, and automatic intervention is reserved for strong signals
 * with cooldowns, caps and trivial-work suppression. No new review engine,
 * launcher or model fan-out lives here.
 */

export type ReviewKind = "quality" | "project" | "error" | "council" | "swarm" | "fusion";

export interface ReviewKindSpec {
	kind: ReviewKind;
	purpose: string;
	owner: string;
	workflow: string;
	invoke: string;
}

export const REVIEW_KINDS: Record<ReviewKind, ReviewKindSpec> = {
	quality: {
		kind: "quality",
		purpose: "Evaluate implementation quality and regressions in observed changes.",
		owner: "quality-review lifecycle (lib/quality-review.ts) with the native review runner.",
		workflow: "Bounded aspect reviews (correctness, security, interface, content, runtime, delivery) with strict evidence parsing; two rounds; parent assesses.",
		invoke: "quality_review({action:\"review\"}), then quality_review({action:\"assess\",disposition,reason}). Automatic at completion checkpoints. Do not also run prompt-workflow parallel-review/review-loop on the same revision: those are the deliberate deep-review alternative (P0/P1/P2 + Merge verdict), not a second approval.",
	},
	project: {
		kind: "project",
		purpose: "Assess architecture, goals, consistency, debt and project direction.",
		owner: "One bounded advisory helper via the native subagent executor; no dedicated launcher.",
		invoke: "Deliberate only: subagent worker with a project-review brief (scope, decisions, debt, direction). No automatic suggestion path exists; the stuck-signal suggester proposes error reviews, never project reviews.",
		workflow: "Single read-only investigation with a concise findings report; parent owns decisions.",
	},
	error: {
		kind: "error",
		purpose: "Aggressively identify likely faults, root causes, failed assumptions and concrete debugging leads.",
		owner: "One bounded advisory helper via the native subagent executor; no dedicated launcher.",
		invoke: "Deliberate: subagent worker with an error-review brief (failures, hypotheses, discriminating checks). Suggested on strong stuck patterns.",
		workflow: "Single read-only diagnosis with concrete leads; parent verifies and fixes.",
	},
	council: {
		kind: "council",
		purpose: "Structured multi-perspective reasoning when a problem genuinely benefits from several perspectives.",
		owner: "Automatic scope council (scope-council-runner) for change-scope questions; supervisor-mediated council prompt for deliberate use.",
		invoke: "Deliberate: `prompt-workflow` council with a question, or subagent supervisors per prompts/council.md. Automatic only for qualifying change-scope requests.",
		workflow: "Two independent perspectives plus a critique under a shared deadline and budget; advisory brief, never authorization.",
	},
	swarm: {
		kind: "swarm",
		purpose: "Separable parallel investigations within one broad task.",
		owner: "Assistance-plan swarm mode with the native executor; bounded respawns via swarm-recovery.",
		invoke: "Deliberate: subagent({tasks:[...],async:true}) with a common brief. Automatic only for broad tasks with separable work.",
		workflow: "At most three model identities; bounded attributed outputs; parent resolves disagreements.",
	},
	fusion: {
		kind: "fusion",
		purpose: "Compare competing approaches or alternatives, then synthesize with provenance.",
		owner: "Fusion-mode workers merged by the deterministic fusion planner (runs/shared/fusion.ts).",
		invoke: "Deliberate: fusion workers plus runs.fuse. Automatic only when alternatives are explicitly in play.",
		workflow: "Duplicate/complementary/conflict fragments; conflicts stay visible for parent review.",
	},
};

export function describeReviewKind(kind: string): string {
	const spec = (REVIEW_KINDS as Record<string, ReviewKindSpec>)[kind];
	return spec ? `${kind}: ${spec.purpose} Owner: ${spec.owner}` : `${kind}: unknown review kind.`;
}

// ── Trivial-work suppression ────────────────────────────────────────────
// Formatting, linting, trivial cleanup and similarly mechanical edits must
// not trigger project reviews, quality reviews, councils or other expensive
// mechanisms *automatically*. Deliberate invocation always stays available.

const TRIVIAL_CUE = /\b(format(?:ting|ter)?|prettier|lint(?:ing|er)?|eslint|ruff|clippy|gofmt|rustfmt|tidy|whitespace|indent(?:ation|ing)?|trivial(?:ly)?(?: clean-?up)?|mechanical edits?|comment (?:typo|fix(?:es)?)|spell(?:ing|check))\b/i;
const NONTRIVIAL_OVERRIDE = /\b(refactor|redesign|rearchitect|architect(?:ure)?|security|auth(?:entication|orization)?|migration|feature|implement|behavior|behaviour|logic|contract|api change|breaking|performance|regression|race|deadlock|production|billing|payment)\b/i;

/** True when the request reads as formatting/lint/trivial-cleanup work with
 * no behavioral signal. Conservative: any override term disables it. */
export function isTrivialChangeRequest(task = "", files: readonly string[] = []): boolean {
	const text = String(task ?? "").slice(0, 32768).replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ");
	if (!text.trim() && !files.length) return false;
	if (NONTRIVIAL_OVERRIDE.test(text)) return false;
	if (TRIVIAL_CUE.test(text)) return true;
	return false;
}

// ── Stuck-signal evaluation ─────────────────────────────────────────────
// Strong signals only: repeated failing commands, several same-fix attempts,
// debugging loops, accumulated unresolved errors. Transient/expected
// failures, successful repeats and harmless iteration must not qualify.

export interface StuckSignalInput {
	/** Consecutive tool errors without an intervening success. */
	consecutiveErrors: number;
	/** Repeats of essentially the same failing operation/fix. */
	sameFixRepeats: number;
	/** Distinct error categories recently observed (failureCategory values). */
	errorKinds?: readonly string[];
	/** True when every recent error is an expected transient (rate limit, quota, budget). */
	transientOnly?: boolean;
	/** Loop-tracker or strategy-guard evidence of a debugging loop. */
	debuggingLoop?: boolean;
	/** The session is doing meaningful (non-trivial) work. */
	meaningfulWork?: boolean;
}

export interface StuckSignalVerdict {
	kind: "error" | "none";
	reason: string;
}

const TRANSIENT_KINDS = new Set(["capacity", "budget"]);

export function evaluateStuckSignal(input: StuckSignalInput): StuckSignalVerdict {
	const none = (reason: string): StuckSignalVerdict => ({ kind: "none", reason });
	if (!input || typeof input !== "object") return none("no stuck-signal evidence");
	const consecutive = Math.max(0, Math.floor(input.consecutiveErrors ?? 0));
	const sameFix = Math.max(0, Math.floor(input.sameFixRepeats ?? 0));
	if (input.transientOnly) return none("recent errors are expected transients");
	const kinds = Array.isArray(input.errorKinds) ? input.errorKinds.filter(k => typeof k === "string") : [];
	if (kinds.length > 0 && kinds.every(k => TRANSIENT_KINDS.has(k))) return none("recent errors are capacity/budget transients");
	if (input.meaningfulWork === false) return none("no meaningful work in progress");
	if (sameFix >= 4) return { kind: "error", reason: `same fix attempted ${sameFix} times without success; error review can trace the root cause` };
	if (consecutive >= 4 && (input.debuggingLoop || kinds.length >= 2 || sameFix >= 2))
		return { kind: "error", reason: `${consecutive} consecutive errors with ${input.debuggingLoop ? "debugging-loop" : "multi-cause"} evidence; error review can supply leads` };
	return none("no strong stuck pattern");
}

// ── Suggestion gating (cooldowns, caps, history) ────────────────────────
// Automatic suggestions complement deliberate invocation; they never replace
// it and never launch work by themselves.

export const REVIEW_SUGGESTION_COOLDOWN_MS = 30 * 60_000;
export const REVIEW_SUGGESTION_SESSION_CAP = 2;
export const REVIEW_RECENT_RUN_SUPPRESS_MS = 10 * 60_000;

export interface ReviewSuggestionState {
	lastSuggestedAt?: number;
	suggestionsThisSession?: number;
	/** When the main agent last ran (or was told about) this kind of review. */
	lastReviewAt?: number;
}

export function shouldSuggestReview(kind: string, state: ReviewSuggestionState | undefined, now = Date.now()): boolean {
	if (!(REVIEW_KINDS as Record<string, unknown>)[kind]) return false;
	const s = state ?? {};
	if ((s.suggestionsThisSession ?? 0) >= REVIEW_SUGGESTION_SESSION_CAP) return false;
	if (typeof s.lastSuggestedAt === "number" && now - s.lastSuggestedAt < REVIEW_SUGGESTION_COOLDOWN_MS) return false;
	if (typeof s.lastReviewAt === "number" && now - s.lastReviewAt < REVIEW_RECENT_RUN_SUPPRESS_MS) return false;
	return true;
}
