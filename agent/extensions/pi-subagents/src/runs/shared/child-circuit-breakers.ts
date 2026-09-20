/**
 * Per-child circuit breakers.
 *
 * A child that is alive but useless is the most expensive failure mode in a
 * fan-out: it holds a slot, keeps the group "running", and burns budget until
 * the run-wide deadline finally kills it. Until now the only bound was that
 * deadline plus launch-time budgets; nothing ended a child that was looping,
 * hammering a dead provider, or silently idle.
 *
 * These breakers are evaluated from observations the runner already collects.
 * Each one trips independently and reports a reason; the runner decides how to
 * stop the child (per-child stop) and records the reason as the terminal cause.
 *
 * Pure module: no I/O, no clock. `now` is always supplied by the caller.
 */

export type ChildBreakerReason =
	| "provider_failure_streak"
	| "tool_failure_streak"
	| "no_useful_progress"
	| "excessive_tool_calls"
	| "excessive_turns"
	| "stale_activity"
	| "runaway_cost";

/** How often a running group evaluates its children's breakers. */
export const CHILD_BREAKER_EVAL_INTERVAL_MS = 15_000;

export const CHILD_BREAKER_REASONS: readonly ChildBreakerReason[] = [
	"provider_failure_streak",
	"tool_failure_streak",
	"no_useful_progress",
	"excessive_tool_calls",
	"excessive_turns",
	"stale_activity",
	"runaway_cost",
];

export interface ChildBreakerPolicy {
	/** Consecutive provider/transport failures before tripping. */
	maxConsecutiveProviderFailures: number;
	/** Consecutive tool failures before tripping. */
	maxConsecutiveToolFailures: number;
	/** No new tokens, tool calls, output or turns within this window. */
	noProgressMs: number;
	/** Hard cap on model turns for one child. */
	maxTurns: number;
	/** Hard cap on tool calls for one child, independent of model turns. */
	maxToolCalls: number;
	/** No activity at all (no event, no output) within this window. */
	staleActivityMs: number;
	/** Per-child spend ceiling. */
	maxCostUsd: number;
}

/**
 * Deliberately generous defaults: these end children that are provably stuck,
 * not children that are merely slow. The run-wide deadline remains the outer
 * bound; breakers fire well before it when a child stops making progress.
 */
export const DEFAULT_CHILD_BREAKER_POLICY: ChildBreakerPolicy = {
	maxConsecutiveProviderFailures: 4,
	maxConsecutiveToolFailures: 8,
	noProgressMs: 15 * 60_000,
	maxToolCalls: 48,
	maxTurns: 400,
	staleActivityMs: 20 * 60_000,
	maxCostUsd: 25,
};

export interface ChildBreakerObservation {
	now: number;
	startedAt?: number;
	/** Last event of any kind from the child (tool start/end, message, usage). */
	lastActivityAt?: number;
	/** Last event that advanced the work: new tokens, a completed tool call, new output, or a new turn. */
	lastProgressAt?: number;
	consecutiveProviderFailures?: number;
	consecutiveToolFailures?: number;
	turns?: number;
	toolCalls?: number;
	outputChars?: number;
	tokens?: number;
	costUsd?: number;
	/** True once the child ended; breakers never apply to a terminal child. */
	terminal?: boolean;
	/** A stop/timeout already requested — a second opinion is noise. */
	stopRequested?: boolean;
}

export type ChildBreakerVerdict =
	| { tripped: false }
	| { tripped: true; reason: ChildBreakerReason; detail: string; evidence: Record<string, number | string> };

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveIntEnv(value: unknown, fallback: number): number {
	const parsed = typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Policy overrides from the environment (thresholds only; never disables a breaker class silently). */
export function resolveChildBreakerPolicy(env: NodeJS.ProcessEnv = process.env, base: ChildBreakerPolicy = DEFAULT_CHILD_BREAKER_POLICY): ChildBreakerPolicy {
	return {
		maxConsecutiveProviderFailures: positiveIntEnv(env.PI_SUBAGENT_MAX_PROVIDER_FAILURES, base.maxConsecutiveProviderFailures),
		maxConsecutiveToolFailures: positiveIntEnv(env.PI_SUBAGENT_MAX_TOOL_FAILURES, base.maxConsecutiveToolFailures),
		noProgressMs: positiveIntEnv(env.PI_SUBAGENT_NO_PROGRESS_MS, base.noProgressMs),
		maxToolCalls: positiveIntEnv(env.PI_SUBAGENT_MAX_CHILD_TOOLS, base.maxToolCalls),
		maxTurns: positiveIntEnv(env.PI_SUBAGENT_MAX_TURNS, base.maxTurns),
		staleActivityMs: positiveIntEnv(env.PI_SUBAGENT_STALE_ACTIVITY_MS, base.staleActivityMs),
		maxCostUsd: Number.isFinite(Number(env.PI_SUBAGENT_MAX_CHILD_COST_USD)) && Number(env.PI_SUBAGENT_MAX_CHILD_COST_USD) > 0
			? Number(env.PI_SUBAGENT_MAX_CHILD_COST_USD)
			: base.maxCostUsd,
	};
}

/**
 * Evaluate every breaker. First trip wins; the runner stops the child once.
 * A child that already ended or is already being stopped is never tripped.
 */
export function evaluateChildBreakers(
	observation: ChildBreakerObservation,
	policy: ChildBreakerPolicy = DEFAULT_CHILD_BREAKER_POLICY,
): ChildBreakerVerdict {
	if (observation.terminal || observation.stopRequested) return { tripped: false };
	const now = num(observation.now) || Date.now();

	if (num(observation.consecutiveProviderFailures) >= Math.max(1, policy.maxConsecutiveProviderFailures)) {
		return {
			tripped: true,
			reason: "provider_failure_streak",
			detail: `Provider/transport failed ${num(observation.consecutiveProviderFailures)} times in a row; the route is not recovering on its own.`,
			evidence: { consecutiveProviderFailures: num(observation.consecutiveProviderFailures), limit: policy.maxConsecutiveProviderFailures },
		};
	}
	if (num(observation.consecutiveToolFailures) >= Math.max(1, policy.maxConsecutiveToolFailures)) {
		return {
			tripped: true,
			reason: "tool_failure_streak",
			detail: `${num(observation.consecutiveToolFailures)} consecutive tool-call failures; the child is looping on a broken tool.`,
			evidence: { consecutiveToolFailures: num(observation.consecutiveToolFailures), limit: policy.maxConsecutiveToolFailures },
		};
	}
	if (policy.maxTurns > 0 && num(observation.turns) >= policy.maxTurns) {
		return {
			tripped: true,
			reason: "excessive_turns",
			detail: `Child reached ${num(observation.turns)} turns (limit ${policy.maxTurns}).`,
			evidence: { turns: num(observation.turns), limit: policy.maxTurns },
		};
	}
	if (policy.maxToolCalls > 0 && num(observation.toolCalls) >= policy.maxToolCalls) {
		return {
			tripped: true,
			reason: "excessive_tool_calls",
			detail: `Child reached ${num(observation.toolCalls)} tool calls (limit ${policy.maxToolCalls}).`,
			evidence: { toolCalls: num(observation.toolCalls), limit: policy.maxToolCalls },
		};
	}
	if (policy.maxCostUsd > 0 && num(observation.costUsd) >= policy.maxCostUsd) {
		return {
			tripped: true,
			reason: "runaway_cost",
			detail: `Child spent $${num(observation.costUsd).toFixed(2)} (limit $${policy.maxCostUsd.toFixed(2)}).`,
			evidence: { costUsd: num(observation.costUsd), limit: policy.maxCostUsd },
		};
	}
	const lastProgressAt = num(observation.lastProgressAt) || num(observation.lastActivityAt) || num(observation.startedAt);
	if (policy.noProgressMs > 0 && lastProgressAt > 0 && now - lastProgressAt >= policy.noProgressMs) {
		return {
			tripped: true,
			reason: "no_useful_progress",
			detail: `No new tokens, tool results, output or turns for ${Math.round((now - lastProgressAt) / 1000)}s.`,
			evidence: { idleMs: now - lastProgressAt, limitMs: policy.noProgressMs },
		};
	}
	const lastActivityAt = num(observation.lastActivityAt) || num(observation.lastProgressAt) || num(observation.startedAt);
	if (policy.staleActivityMs > 0 && lastActivityAt > 0 && now - lastActivityAt >= policy.staleActivityMs) {
		return {
			tripped: true,
			reason: "stale_activity",
			detail: `No activity from the child for ${Math.round((now - lastActivityAt) / 1000)}s; the slot is effectively dead.`,
			evidence: { idleMs: now - lastActivityAt, limitMs: policy.staleActivityMs },
		};
	}
	return { tripped: false };
}

/**
 * Retry ownership. A dead slot gets exactly one cheap retry (same route, short
 * delay) or one fallback route; after that the failure is the parent's to see.
 * Nothing here waits indefinitely: every retry is bounded by the caller's
 * deadline and by this schedule.
 */
// Child startup has one same-route retry. Fallback selection is a separate
// decision, so do not advertise an unused second delay.
export const CHILD_RETRY_SCHEDULE_MS = [1_000] as const;

export type ChildRetryDecision =
	| { action: "attempt"; attempt: number; delayMs: number }
	| { action: "fallback"; attempt: number; detail: string }
	| { action: "surface"; attempt: number; detail: string };

export interface ChildRetryState {
	/** Attempts already made on the current route (0 = first try pending). */
	attempts: number;
	/** True when the route itself is the problem (auth, quota, outage, no route). */
	routeFaulty: boolean;
	/** True when a cheaper/alternative route exists to try. */
	fallbackAvailable: boolean;
	/** True when the failure happened before any useful work (cheap to retry). */
	cheapFailure: boolean;
}

export function planChildRetry(state: ChildRetryState): ChildRetryDecision {
	const attempts = Math.max(0, Math.floor(state.attempts));
	if (attempts === 0) return { action: "attempt", attempt: 1, delayMs: 0 };
	// The first failure gets one cheap retry on the same route only when the
	// route is healthy and the failure produced no work worth protecting.
	if (attempts === 1 && !state.routeFaulty && state.cheapFailure) {
		return { action: "attempt", attempt: 2, delayMs: CHILD_RETRY_SCHEDULE_MS[0] };
	}
	// Otherwise move straight to a fallback route if one exists, and never
	// retry more than once per route.
	if (state.fallbackAvailable && !state.routeFaulty) {
		return { action: "fallback", attempt: attempts + 1, detail: "Route failed after one retry; switching to a fallback route." };
	}
	return {
		action: "surface",
		attempt: attempts + 1,
		detail: state.routeFaulty
			? "Route is faulty (auth/quota/outage); surfacing the failure instead of retrying."
			: "Retry budget exhausted; surfacing the failure to the parent instead of waiting on a dead slot.",
	};
}
