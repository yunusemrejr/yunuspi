/**
 * Group reliability accounting: what "finished" means for a fan-out.
 *
 * Historical bug class this module exists to end: a parallel group was treated
 * as "still waiting" until every child *succeeded*, so children that had
 * already ended badly (failed, cancelled, timed out) kept the group in a
 * running state and the counters could not say why. Here, completion is
 * defined by TERMINAL children, not successful ones:
 *
 *   requested  = running + terminal
 *   terminal   = succeeded + failed + cancelled + timed_out
 *
 * A terminal child is never "still waiting"; it stays in the counters so the
 * failure remains diagnostically visible. Degradation is explicit:
 * RUNNING_DEGRADED while some children have already ended badly and others are
 * still running, FINISHED_DEGRADED when everything is terminal but not
 * everything succeeded.
 *
 * Pure module: no I/O, no clock, no imports. Safe to use from the runner, the
 * wait paths, the TUI and offline benches.
 */

/** Ended states. Every value here is terminal; every non-value is not. */
export type ChildTerminalState = "succeeded" | "failed" | "cancelled" | "timed_out";

/** Lifecycle view: requested (not yet dispatched) or running (dispatched, not ended). */
export type ChildLifecycleState = "requested" | "running" | ChildTerminalState;

export const CHILD_TERMINAL_STATES: readonly ChildTerminalState[] = ["succeeded", "failed", "cancelled", "timed_out"];

export type ChildTerminalCause =
	| "completed"
	| "provider_failure"
	| "tool_failure"
	| "startup_failure"
	| "timeout"
	| "cancelled"
	| "budget_exhausted"
	| "context_overflow"
	| "protocol_error"
	| "process_signal"
	| "empty_output"
	| "unknown";

/**
 * Loose evidence about one child. Every field is optional because the same
 * classifier runs over persisted status steps, workflow child results and
 * wait-completion projections, which carry different subsets.
 */
export interface ChildTerminalFacts {
	ok?: boolean;
	success?: boolean;
	/** Persisted step/run status vocabulary (completed, failed, stopped, ...). */
	status?: string;
	state?: string;
	stopped?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	timedOut?: boolean;
	cancelled?: boolean;
	rejected?: boolean;
	exitCode?: number | null;
	error?: string;
	turnBudgetExceeded?: boolean;
	toolBudgetBlocked?: boolean;
	usageBudgetExceeded?: boolean;
	contextOverflow?: boolean;
	/** Circuit-breaker trip reason, when a breaker ended the child. */
	breakerReason?: string;
	terminalOutcome?: { state?: string; reason?: string };
	terminalCause?: string;
	terminalState?: string;
}

function truthy(value: unknown): boolean {
	return value === true;
}

function lower(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function reasonOf(facts: ChildTerminalFacts): string {
	return lower(facts.terminalOutcome?.reason);
}

function isTerminalStateValue(value: unknown): value is ChildTerminalState {
	return value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed_out";
}

/**
 * Classify one child. Returns undefined when the child has not ended yet —
 * callers must then treat it as still running (still waiting).
 *
 * Order matters: an explicit timed_out/cancelled marker wins over the coarse
 * persisted status, because the runner historically folded both into
 * "failed"/"stopped" and callers lost the cause.
 */
export function classifyChildTerminal(facts: ChildTerminalFacts | undefined): ChildTerminalState | undefined {
	if (!facts || typeof facts !== "object") return undefined;
	if (isTerminalStateValue(facts.terminalState)) return facts.terminalState;
	const status = lower(facts.status) || lower(facts.state);
	if (status === "timed_out" || status === "timedout") return "timed_out";
	if (truthy(facts.timedOut)) return "timed_out";
	if (status === "cancelled" || status === "canceled" || truthy(facts.cancelled)) return "cancelled";
	if (status === "rejected" || truthy(facts.rejected)) return "failed";
	const outcomeState = lower(facts.terminalOutcome?.state);
	// Stopped and interrupted (paused) children are terminal for completion
	// accounting: they no longer advance this group. An explicit resume re-opens
	// the child as a new epoch instead of silently reviving a counted one.
	if (truthy(facts.stopped) || status === "stopped") return "cancelled";
	if (truthy(facts.interrupted)) return "cancelled";
	// A detached child left this group's supervision: terminal here, recorded as
	// cancelled unless it already carries an explicit success (checked below).
	if ((truthy(facts.detached) || status === "detached") && facts.ok !== true && facts.success !== true) return "cancelled";
	if (isTerminalStateValue(status)) return status;
	let ended = status === "completed" || status === "complete" || status === "failed" || status === "partial" || status === "paused" || status === "detached" || truthy(facts.detached) || outcomeState === "partial" || outcomeState === "failed" || outcomeState === "complete";
	if (typeof facts.exitCode === "number" && facts.exitCode !== null) ended = true;
	if (!ended && facts.exitCode === undefined && facts.ok === undefined && facts.success === undefined) return undefined;
	const succeeded = facts.ok === true || facts.success === true || status === "completed" || status === "complete" || outcomeState === "complete";
	if (succeeded && !truthy(facts.timedOut) && !truthy(facts.stopped)) return "succeeded";
	if (truthy(facts.detached) || status === "detached") return "cancelled";
	if (ended) return "failed";
	if (typeof facts.exitCode === "number" && facts.exitCode !== null) return facts.exitCode === 0 ? "succeeded" : "failed";
	if (facts.ok === false || facts.success === false) return "failed";
	return undefined;
}

const PROVIDER_FAILURE_PATTERN = /\b(provider|upstream|5\d\d|rate[_ ]limit|429|overloaded|unavailable|timeout waiting for provider|connection (?:reset|refused)|econnreset|socket hang up|bad gateway|service unavailable|internal server error)\b/i;
const TOOL_FAILURE_PATTERN = /\b(tool .*(?:failed|error)|failed to (?:call|execute) tool|tool execution failed|invalid tool (?:arguments|input)|no such tool|tool not found|toolbudget|tool budget)\b/i;
const STARTUP_FAILURE_PATTERN = /\b(failed to start|startup race|exited before model or tool activity|failed to load extension|spawn (?:failed|enoent)|enoent)\b/i;
const CONTEXT_OVERFLOW_PATTERN = /\b(context (?:length|overflow|window)|prompt is too long|maximum context|input exceeds)\b/i;
const BUDGET_PATTERN = /\b(budget|usage limit|cost limit|spend limit|token limit)\b/i;
const PROTOCOL_PATTERN = /\b(protocol error|malformed json|invalid json|unexpected (?:message|event)|stream error|transport error|aborted? (?:mid|during) (?:stream|response))\b/i;
const SIGNAL_PATTERN = /\b(terminated by signal|sigkill|sigterm|sigsegv|sigabrt)\b/i;
const EMPTY_OUTPUT_PATTERN = /\b(empty (?:final )?(?:assistant )?(?:response|output)|no (?:final )?output|produced no output)\b/i;

/**
 * Best-effort terminal cause for one child, used for telemetry and for the
 * "why did this end" line the parent sees. Never throws; unknown is honest.
 */
export function childTerminalCause(facts: ChildTerminalFacts | undefined): ChildTerminalCause {
	if (!facts || typeof facts !== "object") return "unknown";
	const declared = lower(facts.terminalCause);
	if (declared === "completed" || declared === "provider_failure" || declared === "tool_failure" || declared === "startup_failure"
		|| declared === "timeout" || declared === "cancelled" || declared === "budget_exhausted" || declared === "context_overflow"
		|| declared === "protocol_error" || declared === "process_signal" || declared === "empty_output") return declared;
	const terminal = classifyChildTerminal(facts);
	if (terminal === undefined) return "unknown";
	if (terminal === "succeeded") return "completed";
	if (terminal === "timed_out") return "timeout";
	if (terminal === "cancelled") return "cancelled";
	if (truthy(facts.breakerReason)) {
		const breaker = lower(facts.breakerReason);
		if (breaker.includes("provider")) return "provider_failure";
		if (breaker.includes("tool")) return "tool_failure";
		if (breaker.includes("progress")) return "tool_failure";
		if (breaker.includes("turn")) return "budget_exhausted";
		if (breaker.includes("stale")) return "timeout";
		if (breaker.includes("cost")) return "budget_exhausted";
	}
	if (truthy(facts.contextOverflow)) return "context_overflow";
	if (truthy(facts.turnBudgetExceeded) || truthy(facts.toolBudgetBlocked) || truthy(facts.usageBudgetExceeded)) return "budget_exhausted";
	if (reasonOf(facts) === "budget_exhausted" || reasonOf(facts) === "timeout") return reasonOf(facts) === "timeout" ? "timeout" : "budget_exhausted";
	const error = typeof facts.error === "string" ? facts.error : "";
	if (error) {
		if (STARTUP_FAILURE_PATTERN.test(error)) return "startup_failure";
		if (CONTEXT_OVERFLOW_PATTERN.test(error)) return "context_overflow";
		if (BUDGET_PATTERN.test(error)) return "budget_exhausted";
		if (PROTOCOL_PATTERN.test(error)) return "protocol_error";
		if (SIGNAL_PATTERN.test(error)) return "process_signal";
		if (PROVIDER_FAILURE_PATTERN.test(error)) return "provider_failure";
		if (TOOL_FAILURE_PATTERN.test(error)) return "tool_failure";
		if (EMPTY_OUTPUT_PATTERN.test(error)) return "empty_output";
	}
	return "unknown";
}

export interface GroupCounters {
	/** Children the group was asked to run. */
	requested: number;
	/** Dispatched or queued children that have not ended (still waiting). */
	running: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	timed_out: number;
	/** succeeded + failed + cancelled + timed_out. */
	terminal: number;
	/** True when any child ended badly. */
	degraded: boolean;
}

export interface GroupCompletionOptions {
	/** Planned group size when it exceeds the observed children (queued fan-out). */
	requested?: number;
}

/**
 * Count a group by TERMINAL children. Children that ended badly are terminal:
 * they are counted here and never counted as running.
 */
export function groupCounters(children: readonly (ChildTerminalFacts | undefined)[], options: GroupCompletionOptions = {}): GroupCounters {
	const rows = Array.isArray(children) ? children : [];
	let succeeded = 0;
	let failed = 0;
	let cancelled = 0;
	let timed_out = 0;
	for (const child of rows) {
		switch (classifyChildTerminal(child)) {
			case "succeeded": succeeded += 1; break;
			case "failed": failed += 1; break;
			case "cancelled": cancelled += 1; break;
			case "timed_out": timed_out += 1; break;
			default: break;
		}
	}
	const observed = rows.length;
	const terminal = succeeded + failed + cancelled + timed_out;
	const requested = Math.max(observed, Math.floor(options.requested ?? observed));
	const running = Math.max(0, requested - terminal);
	return {
		requested,
		running,
		succeeded,
		failed,
		cancelled,
		timed_out,
		terminal,
		degraded: failed + cancelled + timed_out > 0,
	};
}

/** A group is complete when every requested child is terminal. */
export function groupComplete(counters: GroupCounters): boolean {
	return counters.requested > 0 && counters.terminal >= counters.requested;
}

export type GroupLifecycleState =
	/** Nothing dispatched or observed yet. */
	| "PENDING"
	/** Children running, none ended badly yet. */
	| "RUNNING"
	/** Children running while at least one has already ended badly. */
	| "RUNNING_DEGRADED"
	/** Every child terminal and every child succeeded. */
	| "FINISHED"
	/** Every child terminal, at least one did not succeed. */
	| "FINISHED_DEGRADED";

export function groupLifecycleState(counters: GroupCounters): GroupLifecycleState {
	if (counters.requested <= 0) return "PENDING";
	if (!groupComplete(counters)) return counters.degraded ? "RUNNING_DEGRADED" : "RUNNING";
	return counters.succeeded === counters.requested ? "FINISHED" : "FINISHED_DEGRADED";
}

/**
 * Children the group is still waiting for: only non-terminal ones. Failed,
 * cancelled and timed-out children are excluded by construction — they remain
 * visible in the counters but never hold the group open.
 */
export function groupStillWaiting(children: readonly (ChildTerminalFacts | undefined)[]): number[] {
	const waiting: number[] = [];
	(Array.isArray(children) ? children : []).forEach((child, index) => {
		if (classifyChildTerminal(child) === undefined) waiting.push(index);
	});
	return waiting;
}

/** True when no child of the group is still running/queued. */
export function groupSettled(children: readonly (ChildTerminalFacts | undefined)[], options: GroupCompletionOptions = {}): boolean {
	const counters = groupCounters(children, options);
	return counters.requested > 0 && groupComplete(counters);
}

/**
 * Unified telemetry for one child. The fork accumulated the same facts under
 * different names per surface (status steps, result rows, wait completions,
 * cost ledger); this is the single row shape they all project into so a group
 * can be summed without losing the cache or route split.
 */
export interface ChildTelemetry {
	key?: string;
	runId?: string;
	agent?: string;
	/** Provider/model actually attempted (as-run), not the requested route. */
	provider?: string;
	model?: string;
	requestedModel?: string;
	terminalState?: ChildTerminalState;
	terminalCause?: ChildTerminalCause;
	/** Prompt tokens not served from cache. */
	inputTokens: number;
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** input + cacheRead + cacheWrite: the billed prompt side. */
	billableInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	costUsd: number;
	turns: number;
	toolCalls: number;
	runtimeMs: number;
}

export interface ChildTelemetrySource extends ChildTerminalFacts {
	key?: string;
	runId?: string;
	agent?: string;
	model?: string;
	requestedModel?: string;
	provider?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
		turns?: number;
		reasoning?: number;
		reasoningTokens?: number;
		toolCalls?: number;
	};
	toolCount?: number;
	durationMs?: number;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	now?: number;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Project one child's telemetry. Missing fields are zero, never undefined. */
export function childTelemetryFrom(source: ChildTelemetrySource | undefined): ChildTelemetry {
	const usage = source?.usage ?? {};
	const inputTokens = count(usage.input);
	const cacheReadTokens = count(usage.cacheRead);
	const cacheWriteTokens = count(usage.cacheWrite);
	const terminalState = classifyChildTerminal(source);
	const startedAt = typeof source?.startedAt === "number" ? source.startedAt : undefined;
	const endedAt = typeof source?.endedAt === "number" ? source.endedAt : typeof source?.lastUpdate === "number" ? source.lastUpdate : undefined;
	const runtimeMs = count(source?.durationMs) || (startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : 0);
	return {
		...(source?.key ? { key: source.key } : {}),
		...(source?.runId ? { runId: source.runId } : {}),
		...(source?.agent ? { agent: source.agent } : {}),
		...(source?.provider ? { provider: source.provider } : {}),
		...(source?.model ? { model: source.model } : {}),
		...(source?.requestedModel ? { requestedModel: source.requestedModel } : {}),
		...(terminalState ? { terminalState } : {}),
		...(terminalState ? { terminalCause: childTerminalCause(source) } : {}),
		inputTokens,
		uncachedInputTokens: inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		billableInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
		outputTokens: count(usage.output),
		reasoningTokens: count(usage.reasoning ?? usage.reasoningTokens),
		costUsd: count(usage.cost),
		turns: count(usage.turns),
		toolCalls: count(usage.toolCalls ?? source?.toolCount),
		runtimeMs,
	};
}

export interface GroupTelemetry {
	counters: GroupCounters;
	state: GroupLifecycleState;
	/** Summed across children. */
	total: ChildTelemetry;
	/** Per-child rows, input order. */
	rows: ChildTelemetry[];
	/** Terminal causes present in the group, most frequent first. */
	causes: Array<{ cause: ChildTerminalCause; count: number }>;
}

function sumRow(total: ChildTelemetry, row: ChildTelemetry): void {
	total.inputTokens += row.inputTokens;
	total.uncachedInputTokens += row.uncachedInputTokens;
	total.cacheReadTokens += row.cacheReadTokens;
	total.cacheWriteTokens += row.cacheWriteTokens;
	total.billableInputTokens += row.billableInputTokens;
	total.outputTokens += row.outputTokens;
	total.reasoningTokens += row.reasoningTokens;
	total.costUsd += row.costUsd;
	total.turns += row.turns;
	total.toolCalls += row.toolCalls;
	total.runtimeMs += row.runtimeMs;
}

/** Counters, degraded state and summed telemetry for a whole group. */
export function groupTelemetry(sources: readonly ChildTelemetrySource[], options: GroupCompletionOptions = {}): GroupTelemetry {
	const rows = (Array.isArray(sources) ? sources : []).map((source) => childTelemetryFrom(source));
	const total: ChildTelemetry = {
		inputTokens: 0,
		uncachedInputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		billableInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		turns: 0,
		toolCalls: 0,
		runtimeMs: 0,
	};
	const causeCounts = new Map<ChildTerminalCause, number>();
	for (const row of rows) {
		sumRow(total, row);
		if (row.terminalCause) causeCounts.set(row.terminalCause, (causeCounts.get(row.terminalCause) ?? 0) + 1);
	}
	const counters = groupCounters(sources, options);
	return {
		counters,
		state: groupLifecycleState(counters),
		total,
		rows,
		causes: [...causeCounts.entries()]
			.map(([cause, count]) => ({ cause, count }))
			.sort((left, right) => right.count - left.count || left.cause.localeCompare(right.cause)),
	};
}

/** True when text reads as a provider/transport failure (not a tool result error). */
export function isProviderFailureText(text: string | undefined): boolean {
	if (!text || typeof text !== "string") return false;
	return PROVIDER_FAILURE_PATTERN.test(text) && !TOOL_FAILURE_PATTERN.test(text);
}

/** True when text reads as a tool-call failure. */
export function isToolFailureText(text: string | undefined): boolean {
	if (!text || typeof text !== "string") return false;
	return TOOL_FAILURE_PATTERN.test(text) || /^\s*(error|failed|exception|toolerror)\b/i.test(text);
}

/** Compact one-line UI summary: "3/5 terminal · 2 failed · 1 running". */
export function formatGroupCounters(counters: GroupCounters): string {
	const parts = [`${counters.terminal}/${counters.requested} terminal`];
	if (counters.failed > 0) parts.push(`${counters.failed} failed`);
	if (counters.timed_out > 0) parts.push(`${counters.timed_out} timed out`);
	if (counters.cancelled > 0) parts.push(`${counters.cancelled} cancelled`);
	if (counters.running > 0) parts.push(`${counters.running} running`);
	return parts.join(" · ");
}
