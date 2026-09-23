/**
 * Canonical child lifecycle ledger.
 *
 * ONE normalized reducer for child state, keyed by stable task identity and
 * attempt identity. Launch, lifecycle, progress, completion, accounting,
 * recovery, resume, stop, and failure evidence all merge here. `/used`
 * (session-signals) and session export read from this ledger — they never
 * independently reconstruct child rows from launch receipts. `/metrics`
 * (session-metrics) still keeps its own transcript reducer for agent/workflow
 * counters; the cross-surface invariant is liveness agreement (a live child is
 * never terminal/queued in either surface), not identical state labels.
 *
 * Precedence (explicit terminal states win; secondary flags never overwrite):
 *   intentional stop    -> stopped
 *   interrupted/recoverable -> paused
 *   completed acceptance    -> completed
 *   execution failed        -> failed
 *   still running           -> running (detached folds here: live elsewhere)
 *   launch accepted, idle   -> queued
 * Exit codes and generic error markers are secondary flags, kept separately.
 *
 * Execution outcome and acceptance outcome are independent: a child can
 * execute successfully but fail acceptance, or fail execution and never reach
 * acceptance. Transport failures, truncation, schema failures, and budget
 * exhaustion are execution causes — never rewritten as "verification".
 *
 * Retries form attempt trees: one logical child/task with expandable attempt
 * history. Top-level status reflects the logical task; route-level failures
 * stay visible beneath it.
 *
 * Dependency-free and pure (node:crypto only, via failure-cause).
 */
import { hasRecordedTokenUsage } from "../../../../lib/cost-evidence.ts";
import { classifyFailure, readFailureCause, type FailureCause, type StructuredFailureEvidence } from "./failure-cause.ts";
import { buildChildTaskIdentity } from "./child-identity.ts";
import { buildExecutionEvidence, type ExecutionEvidence } from "../../../../lib/execution-evidence.ts";

export type ChildLifecycleState = "queued" | "running" | "paused" | "stopped" | "completed" | "failed";

export type ExecutionStatus = "none" | "running" | "succeeded" | "failed";
export type AcceptanceStatus = "none" | "pending" | "passed" | "failed";

export interface ExecutionOutcome {
	status: ExecutionStatus;
	cause?: FailureCause;
}

export interface AcceptanceOutcome {
	status: AcceptanceStatus;
	reason?: string;
}

export interface AttemptUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	turns?: number;
}

export interface AttemptRecord {
	attempt: number;
	runId?: string;
	route?: string;
	backend?: string;
	agent?: string;
	state: ChildLifecycleState;
	execution: ExecutionOutcome;
	acceptance: AcceptanceOutcome;
	usage?: AttemptUsage;
	artifacts?: string[];
	sessionFile?: string;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number;
	diagnosticRef?: string;
}

export interface LogicalChildTask {
	/** Stable task identity: retries/resumes/recovery stay bound to it. */
	taskId: string;
	/** Human-readable label, generated from the child-specific task. */
	label: string;
	todoId?: string;
	scopeId?: string;
	parentGoal?: string;
	description?: string;
	agent?: string;
	attempts: AttemptRecord[];
	/** Logical-task status derived from the attempt tree. */
	state: ChildLifecycleState;
	execution: ExecutionOutcome;
	acceptance: AcceptanceOutcome;
	/** True when identity linkage is incomplete (never silently "omitted"). */
	unresolvedLinkage?: boolean;
}

export interface UnresolvedEvidence {
	kind: "missing-task-id" | "missing-attempt" | "orphan-accounting" | "conflict";
	detail: string;
	ref?: string;
}

export interface ChildLedger {
	version: 1;
	tasks: LogicalChildTask[];
	unresolved: UnresolvedEvidence[];
}

export type ChildLedgerEvent =
	| { type: "launch"; taskId?: string; attempt?: number; runId?: string; label?: string; todoId?: string; scopeId?: string; parentGoal?: string; description?: string; agent?: string; route?: string; backend?: string; at?: number; ref?: string }
	| { type: "lifecycle"; taskId?: string; runId?: string; attempt?: number; state?: string; at?: number; ref?: string }
	| { type: "progress"; taskId?: string; runId?: string; attempt?: number; at?: number; ref?: string }
	| { type: "completion"; taskId?: string; runId?: string; attempt?: number; row?: Record<string, unknown>; at?: number; ref?: string }
	| { type: "accounting"; taskId?: string; runId?: string; attempt?: number; usage?: AttemptUsage; route?: string; agent?: string; at?: number; ref?: string }
	| { type: "recovery"; taskId?: string; runId?: string; attempt?: number; reason?: string; replacementAttempt?: number; at?: number; ref?: string }
	| { type: "resume"; taskId?: string; runId?: string; attempt?: number; at?: number; ref?: string }
	| { type: "stop"; taskId?: string; runId?: string; attempt?: number; at?: number; ref?: string }
	| { type: "failure"; taskId?: string; runId?: string; attempt?: number; evidence?: StructuredFailureEvidence; at?: number; ref?: string };

const MAX_TASKS = 512;
const MAX_ATTEMPTS = 32;

const TERMINAL: ReadonlySet<ChildLifecycleState> = new Set(["stopped", "completed", "failed"]);

/** Precedence rank: higher wins when merging states for one attempt. */
function stateRank(state: ChildLifecycleState): number {
	switch (state) {
		case "stopped": return 60;
		case "failed": return 50;
		case "completed": return 40;
		case "paused": return 30;
		case "running": return 20;
		case "queued": return 10;
	}
}

function normalizeState(value: unknown): ChildLifecycleState | undefined {
	if (value === "complete") return "completed";
	if (value === "rejected") return "failed";
	// A detached child is live elsewhere — never queued, never terminal.
	// /metrics keeps "detached" as its own display label; the ledger folds it
	// to running so both surfaces agree the child is outstanding.
	if (value === "detached") return "running";
	if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "paused") {
		return value;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asString(value: unknown, max = 256): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value.slice(0, max) : undefined;
}

/**
 * Derive attempt state from a completion/accounting row under strict
 * precedence. Explicit lifecycle markers win; exit codes and error flags are
 * secondary evidence only.
 */
export function deriveAttemptOutcome(row: Record<string, unknown>): {
	state: ChildLifecycleState;
	execution: ExecutionOutcome;
	acceptance: AcceptanceOutcome;
	exitCode?: number;
} {
	const stopped = row.stopped === true || row.status === "stopped" || row.state === "stopped";
	const paused = row.interrupted === true || row.status === "paused" || row.state === "paused";
	const detached = row.detached === true || row.status === "detached" || row.state === "detached";
	const acceptanceRow = asRecord(row.acceptance);
	const acceptanceStatus = acceptanceRow.status ?? row.acceptanceStatus;
	const acceptance: AcceptanceOutcome =
		acceptanceStatus === "passed" || acceptanceStatus === "accepted"
			? { status: "passed", ...(asString(acceptanceRow.reason ?? row.acceptanceReason, 160) ? { reason: asString(acceptanceRow.reason ?? row.acceptanceReason, 160) } : {}) }
			: acceptanceStatus === "failed" || acceptanceStatus === "rejected"
				? { status: "failed", ...(asString(acceptanceRow.reason ?? row.acceptanceReason, 160) ? { reason: asString(acceptanceRow.reason ?? row.acceptanceReason, 160) } : {}) }
				: acceptanceStatus === "pending"
					? { status: "pending" }
					: { status: "none" };

	const evidence: StructuredFailureEvidence = {
		...(typeof row.stage === "string" ? { stage: row.stage as StructuredFailureEvidence["stage"] } : {}),
		...(typeof row.runtimeError === "string" ? { runtimeError: row.runtimeError } : {}),
		...(typeof row.processCode === "string" ? { processCode: row.processCode } : {}),
		...(typeof row.validatorCode === "string" ? { validatorCode: row.validatorCode } : {}),
		...(typeof row.toolName === "string" ? { toolName: row.toolName } : {}),
		...(typeof row.schemaField === "string" ? { schemaField: row.schemaField } : {}),
		...(typeof row.exitCode === "number" ? { exitCode: row.exitCode } : {}),
		...(typeof row.signal === "string" ? { signal: row.signal } : {}),
		...(row.providerCode !== undefined ? { providerCode: row.providerCode as string | number } : {}),
		...(typeof row.backend === "string" ? { backend: row.backend } : {}),
		...(typeof row.parserError === "string" ? { parserError: row.parserError } : {}),
		...(row.toolBudgetBlocked === true || row.turnBudgetExceeded === true || row.budgetExhausted === true ? { budgetExhausted: true } : {}),
		...(row.timedOut === true ? { timedOut: true } : {}),
		...(row.contextOverflow === true ? { contextOverflow: true } : {}),
		...(typeof row.stopReason === "string" ? { stopReason: row.stopReason } : typeof row.finishReason === "string" ? { stopReason: row.finishReason } : {}),
		...(row.structuredOutputFailed === true ? { structuredOutputFailed: true } : {}),
		// Acceptance is assessed independently below; it must not leak into
		// the EXECUTION cause. A child that ran cleanly but failed acceptance
		// reports execution succeeded + acceptance failed — never a rewritten
		// transport/truncation cause, and never execution failed "because".
		...(stopped ? { stopped: true } : {}),
		...(paused ? { interrupted: true } : {}),
		...(typeof row.status === "string" ? { status: row.status } : typeof row.state === "string" ? { status: row.state } : {}),
		...(row.error !== undefined && row.error !== false && row.error !== null ? { error: true } : {}),
		...(Number.isSafeInteger(row.attempt) ? { attempt: row.attempt as number } : {}),
		...(row.outputState === "present" || row.output === "present" ? { outputPresent: true } : {}),
		...(typeof row.diagnosticRef === "string" ? { diagnosticRef: row.diagnosticRef } : {}),
		...(typeof row.error === "string" ? { message: row.error } : {}),
	};
	const classified = classifyFailure(evidence);
	const retained = readFailureCause(row.cause ?? asRecord(row.evidence).cause);
	// Cost rows deliberately redact raw errors to "child-error". The already
	// classified cause must survive that projection instead of becoming unknown.
	const cause = classified.category === "unknown" && retained ? retained : classified;

	let execution: ExecutionOutcome;
	if (stopped || paused) {
		execution = { status: "failed", cause };
	} else if (cause.category === "none") {
		const running = detached || row.status === "running" || row.state === "running";
		execution = { status: running ? "running" : "succeeded" };
	} else {
		execution = { status: "failed", cause };
	}

	// Strict precedence: intentional stop > interruption > execution failure >
	// acceptance failure > explicit completion > running > queued.
	let state: ChildLifecycleState;
	if (stopped) state = "stopped";
	else if (paused) state = "paused";
	else if (execution.status === "failed") state = "failed";
	else if (acceptance.status === "failed") state = "failed";
	else if (row.status === "completed" || row.state === "completed" || row.state === "complete" || row.status === "complete" || row.success === true || row.exitCode === 0) state = "completed";
	else if (detached || row.status === "running" || row.state === "running") state = "running";
	else state = normalizeState(row.status ?? row.state) ?? "queued";

	const exitCode = typeof row.exitCode === "number" && Number.isSafeInteger(row.exitCode) ? row.exitCode : undefined;
	return { state, execution, acceptance, ...(exitCode === undefined ? {} : { exitCode }) };
}

/** Logical-task status from the attempt tree: latest terminal attempt wins; running beats queued. */
export function deriveLogicalState(attempts: AttemptRecord[]): {
	state: ChildLifecycleState;
	execution: ExecutionOutcome;
	acceptance: AcceptanceOutcome;
} {
	if (!attempts.length) {
		return { state: "queued", execution: { status: "none" }, acceptance: { status: "none" } };
	}
	const ordered = [...attempts].sort((a, b) => a.attempt - b.attempt);
	const latest = ordered[ordered.length - 1]!;
	if (TERMINAL.has(latest.state)) {
		return { state: latest.state, execution: latest.execution, acceptance: latest.acceptance };
	}
	// A non-terminal latest attempt with a terminal sibling (parallel fan-out)
	// still reports the live state; history stays under attempts.
	if (ordered.some((attempt) => attempt.state === "running")) {
		const running = ordered.filter((attempt) => attempt.state === "running").sort((a, b) => b.attempt - a.attempt)[0]!;
		return { state: "running", execution: running.execution, acceptance: running.acceptance };
	}
	if (ordered.some((attempt) => attempt.state === "paused")) {
		return { state: "paused", execution: latest.execution, acceptance: latest.acceptance };
	}
	return { state: latest.state, execution: latest.execution, acceptance: latest.acceptance };
}

interface TaskDraft {
	task: LogicalChildTask;
	byRunId: Map<string, AttemptRecord>;
}

function taskKey(event: ChildLedgerEvent): string | undefined {
	if (event.taskId && typeof event.taskId === "string") return event.taskId.slice(0, 160);
	return undefined;
}

/** Reduce a redacted event sequence into the canonical child ledger. Deterministic: same events, same ledger. */
export function reduceChildEvents(events: readonly ChildLedgerEvent[]): ChildLedger {
	const tasks = new Map<string, TaskDraft>();
	const unresolved: UnresolvedEvidence[] = [];
	const runToTask = new Map<string, string>();
	let anonymous = 0;

	const ensureTask = (event: ChildLedgerEvent, fallbackLabel: string): TaskDraft | undefined => {
		let key = taskKey(event);
		if (!key && event.runId && runToTask.has(event.runId)) key = runToTask.get(event.runId);
		if (!key) {
			if (event.type === "launch") {
				anonymous += 1;
				key = `anonymous-${anonymous}`;
				unresolved.push({ kind: "missing-task-id", detail: "launch without a stable task id; recovery cannot bind retries", ...(event.ref ? { ref: event.ref } : {}) });
			} else {
				unresolved.push({
					kind: event.type === "accounting" ? "orphan-accounting" : "missing-task-id",
					detail: `${event.type} references no known task`,
					...(event.ref ? { ref: event.ref } : {}),
				});
				return undefined;
			}
		}
		let draft = tasks.get(key);
		if (!draft) {
			if (tasks.size >= MAX_TASKS) {
				unresolved.push({ kind: "conflict", detail: `task overflow; ledger capped at ${MAX_TASKS}` });
				return undefined;
			}
			draft = {
				task: {
					taskId: key,
					label: fallbackLabel,
					attempts: [],
					state: "queued",
					execution: { status: "none" },
					acceptance: { status: "none" },
				},
				byRunId: new Map(),
			};
			tasks.set(key, draft);
		}
		if (event.runId && !runToTask.has(event.runId)) runToTask.set(event.runId, key);
		return draft;
	};

	const ensureAttempt = (draft: TaskDraft, event: ChildLedgerEvent): AttemptRecord | undefined => {
		const declared = Number.isSafeInteger(event.attempt) && (event.attempt as number) > 0 ? (event.attempt as number) : undefined;
		if (event.runId && draft.byRunId.has(event.runId)) {
			const attempt = draft.byRunId.get(event.runId)!;
			if (declared !== undefined && declared !== attempt.attempt) {
				unresolved.push({ kind: "conflict", detail: `run ${event.runId} re-declared as attempt ${declared} (was ${attempt.attempt})` });
			}
			return attempt;
		}
		// A recovery can pre-declare the replacement attempt before its launch
		// arrives; the later launch binds to it instead of forking a twin.
		if (declared !== undefined) {
			const existing = draft.task.attempts.find((attempt) => attempt.attempt === declared);
			if (existing) {
				if (event.runId && !existing.runId) {
					existing.runId = event.runId.slice(0, 160);
					draft.byRunId.set(event.runId, existing);
				}
				return existing;
			}
		}
		const next = declared ?? (draft.task.attempts.length ? Math.max(...draft.task.attempts.map((attempt) => attempt.attempt)) + 1 : 1);
		if (draft.task.attempts.length >= MAX_ATTEMPTS) {
			unresolved.push({ kind: "conflict", detail: `task ${draft.task.taskId} exceeded ${MAX_ATTEMPTS} attempts` });
			return undefined;
		}
		const attempt: AttemptRecord = {
			attempt: next,
			state: "queued",
			execution: { status: "none" },
			acceptance: { status: "none" },
		};
		if (event.runId) {
			attempt.runId = event.runId.slice(0, 160);
			draft.byRunId.set(event.runId, attempt);
		}
		draft.task.attempts.push(attempt);
		draft.task.attempts.sort((a, b) => a.attempt - b.attempt);
		return attempt;
	};

	for (const event of events) {
		switch (event.type) {
			case "launch": {
				const draft = ensureTask(event, event.label ?? event.description?.slice(0, 80) ?? "child task");
				if (!draft) break;
				if (event.label) draft.task.label = event.label.slice(0, 160);
				if (event.todoId) draft.task.todoId = event.todoId.slice(0, 160);
				if (event.scopeId) draft.task.scopeId = event.scopeId.slice(0, 160);
				if (event.parentGoal) draft.task.parentGoal = event.parentGoal.slice(0, 280);
				if (event.description) draft.task.description = event.description.slice(0, 280);
				if (event.agent) draft.task.agent = event.agent.slice(0, 80);
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				if (event.route) attempt.route = event.route.slice(0, 200);
				if (event.backend) attempt.backend = event.backend.slice(0, 128);
				if (event.agent) attempt.agent = event.agent.slice(0, 80);
				if (event.at !== undefined && attempt.startedAt === undefined) attempt.startedAt = event.at;
				if (event.ref) attempt.diagnosticRef = event.ref.slice(0, 256);
				break;
			}
			case "lifecycle": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				const state = normalizeState(event.state);
				if (state && stateRank(state) >= stateRank(attempt.state)) {
					// Terminal states never move backwards; explicit stop wins.
					if (!TERMINAL.has(attempt.state) || state === "stopped") attempt.state = state;
				}
				if (event.at !== undefined) {
					if (state === "running" && attempt.startedAt === undefined) attempt.startedAt = event.at;
					if (state && TERMINAL.has(state)) attempt.endedAt = event.at;
				}
				break;
			}
			case "progress": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				if (!TERMINAL.has(attempt.state)) attempt.state = "running";
				break;
			}
			case "completion":
			case "failure": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				if (event.type === "completion") {
					const outcome = deriveAttemptOutcome(asRecord(event.row));
					// Completion evidence outranks earlier lifecycle guesses, but
					// an explicit stop already recorded stays stopped.
					if (attempt.state === "stopped" && outcome.state !== "stopped") {
						attempt.execution = outcome.execution;
						attempt.acceptance = outcome.acceptance;
						if (outcome.exitCode !== undefined) attempt.exitCode = outcome.exitCode;
					} else {
						attempt.state = outcome.state;
						attempt.execution = outcome.execution;
						attempt.acceptance = outcome.acceptance;
						if (outcome.exitCode !== undefined) attempt.exitCode = outcome.exitCode;
					}
					const row = asRecord(event.row);
					const usageRow = hasRecordedTokenUsage(row.usage, row.childProcessStarted === false && row.stage === "launch") ? asRecord(row.usage) : {};
					const mergedUsage = {...attempt.usage};
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "turns"] as const) {
						const value = asNumber(usageRow[key]);
						if (value !== undefined) mergedUsage[key] = Math.max(mergedUsage[key] ?? 0, value);
					}
					if (Object.keys(mergedUsage).length) attempt.usage = mergedUsage;
					if (typeof row.sessionFile === "string") attempt.sessionFile = row.sessionFile.slice(0, 512);
					if (Array.isArray(row.artifacts)) {
						attempt.artifacts = row.artifacts.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 512)).slice(0, 32);
					}
					if (typeof row.model === "string" && !attempt.route) attempt.route = row.model.slice(0, 200);
				} else {
					const cause = classifyFailure(event.evidence ?? {});
					if (cause.category !== "none") {
						attempt.execution = { status: "failed", cause };
						if (!TERMINAL.has(attempt.state) || attempt.state === "completed") attempt.state = "failed";
					}
				}
				if (event.at !== undefined && TERMINAL.has(attempt.state)) attempt.endedAt = event.at;
				if (event.ref) attempt.diagnosticRef = event.ref.slice(0, 256);
				break;
			}
			case "accounting": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				// Accounting never moves lifecycle state by itself; it only
				// enriches usage. Late receipts cannot resurrect terminals.
				if (event.usage) {
					const merged = { ...(attempt.usage ?? {}) };
					for (const [key, value] of Object.entries(event.usage)) {
						if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
							(merged as Record<string, number>)[key] = Math.max((merged as Record<string, number>)[key] ?? 0, value);
						}
					}
					if (Object.keys(merged).length) attempt.usage = merged;
				}
				if (event.route && !attempt.route) attempt.route = event.route.slice(0, 200);
				if (event.agent && !attempt.agent) attempt.agent = event.agent.slice(0, 80);
				if (event.agent && !draft.task.agent) draft.task.agent = event.agent.slice(0, 80);
				break;
			}
			case "recovery":
			case "resume": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				if (event.type === "recovery" && event.reason && event.replacementAttempt !== undefined) {
					const attempt = ensureAttempt(draft, { ...event, attempt: event.replacementAttempt });
					if (attempt && attempt.attempt === event.replacementAttempt) {
						if (event.runId) {
							attempt.runId = event.runId.slice(0, 160);
							draft.byRunId.set(event.runId, attempt);
						}
					}
				} else {
					const attempt = ensureAttempt(draft, event);
					if (attempt && !TERMINAL.has(attempt.state)) attempt.state = "running";
				}
				if (event.ref) draft.task.attempts[draft.task.attempts.length - 1]!.diagnosticRef = event.ref.slice(0, 256);
				break;
			}
			case "stop": {
				const draft = ensureTask(event, "child task");
				if (!draft) break;
				const attempt = ensureAttempt(draft, event);
				if (!attempt) break;
				attempt.state = "stopped";
				attempt.execution = { status: "failed", cause: classifyFailure({ stopped: true }) };
				if (event.at !== undefined) attempt.endedAt = event.at;
				break;
			}
		}
	}

	for (const draft of tasks.values()) {
		const derived = deriveLogicalState(draft.task.attempts);
		draft.task.state = derived.state;
		draft.task.execution = derived.execution;
		draft.task.acceptance = derived.acceptance;
		if (draft.task.taskId.startsWith("anonymous-")) draft.task.unresolvedLinkage = true;
	}

	return {
		version: 1,
		tasks: [...tasks.values()].map((draft) => draft.task),
		unresolved: unresolved.slice(0, 64),
	};
}

/**
 * Project session transcript entries into canonical ledger events. Consumes
 * the same evidence every surface already persists (toolResult subagent rows,
 * subagent-cost-v1, subagent-lifecycle-v1, recovery/compaction-resume
 * notices) and normalizes them into ONE event stream for reduceChildEvents.
 * Bounded and pure; unknown shapes are skipped, never inferred.
 */
export function normalizeHelperChildEntries(entries: readonly unknown[]): readonly unknown[] {
	// Native lifecycle and helper accounting describe the same attempted child.
	// Link only explicit single-child run IDs; conflicts remain separate.
	const helperLinks = new Map<string, {parent: string; row: Record<string, unknown>} | null>();
	for (const value of entries) {
		const entry = asRecord(value), data = asRecord(entry.data);
		if (entry.type !== "custom" || entry.customType !== "subagent-cost-v1" || typeof data.runId !== "string" || !/^(?:auto-assist|quality-review|skill-discovery|scope-council)-/.test(data.runId) || !Array.isArray(data.results) || data.results.length !== 1) continue;
		const row = asRecord(data.results[0]);
		if (typeof row.runId !== "string" || row.runId === data.runId || (row.index ?? 0) !== 0) continue;
		const prior = helperLinks.get(row.runId);
		if (prior === null || prior && (prior.parent !== data.runId || (prior.row.attempt ?? 1) !== (row.attempt ?? 1))) helperLinks.set(row.runId, null);
		else helperLinks.set(row.runId, {parent:data.runId, row});
	}
	return entries.map(value => {
		const entry = asRecord(value), message = asRecord(entry.message);
		const custom = entry.type === "custom" && ["subagent-cost-v1", "subagent-lifecycle-v1"].includes(String(entry.customType));
		const tool = entry.type === "message" && message.role === "toolResult" && message.toolName === "subagent";
		if (!custom && !tool) return value;
		const data = asRecord(custom ? entry.data : message.details);
		const native = asString(data.runId ?? data.asyncId, 160), link = native ? helperLinks.get(native) : undefined;
		if (!link || !Array.isArray(data.results) || data.results.length !== 1) return value;
		const row = asRecord(data.results[0]);
		if ((row.index ?? 0) !== 0) return value;
		const normalized = {...data, runId:link.parent, results:[{...row, runId:native, index:0, attempt:link.row.attempt ?? 1,
			...(link.row.label ? {label:link.row.label} : {}), ...(link.row.scopeId ? {scopeId:link.row.scopeId} : {})}]};
		return custom ? {...entry,data:normalized} : {...entry,message:{...message,details:normalized}};
	});
}

export function projectTranscriptChildren(entries: readonly unknown[]): ChildLedgerEvent[] {
	entries = normalizeHelperChildEntries(entries);
	const events: ChildLedgerEvent[] = [];
	const push = (event: ChildLedgerEvent) => {
		if (events.length < 4096) events.push(event);
	};
	// Result rows and cost ledgers rarely name the agent; the launch toolCall
	// args do (agent for single launches, tasks[i].agent positionally for
	// parallel launches). Index them by toolCallId (receipt linkage) and by
	// run/async id (cost-ledger linkage). Management actions
	// (status/stop/...) are not launches; chain steps and nested groups have
	// no stable positional mapping and stay unattributed.
	type LaunchArgs = { agent?: string; model?: string; agents?: (string | undefined)[]; models?: (string | undefined)[] };
	const launchByCall = new Map<string, LaunchArgs>();
	for (const entry of entries) {
		const message = asRecord(asRecord(entry).message);
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content.slice(0, 256)) {
			const call = asRecord(part);
			if (call.type !== "toolCall" || call.name !== "subagent" || typeof call.id !== "string" || launchByCall.has(call.id)) continue;
			const args = asRecord(call.arguments);
			if (args.action !== undefined) continue;
			// Positional arrays keep holes (no filter): tasks[i] maps to row
			// index i even when earlier siblings omit the field.
			const positional = (pick: (step: Record<string, unknown>) => string | undefined): (string | undefined)[] | undefined => {
				if (!Array.isArray(args.tasks)) return undefined;
				const names = (args.tasks as unknown[]).slice(0, 64).map((step) => pick(asRecord(step)));
				return names.some((name) => !!name) ? names : undefined;
			};
			launchByCall.set(call.id, {
				...(typeof args.agent === "string" && args.agent ? { agent: args.agent.slice(0, 80) } : {}),
				...(typeof args.model === "string" && args.model ? { model: args.model.slice(0, 200) } : {}),
				...(positional((step) => asString(step.agent, 80)) ? { agents: positional((step) => asString(step.agent, 80)) } : {}),
				...(positional((step) => asString(step.model, 200)) ? { models: positional((step) => asString(step.model, 200)) } : {}),
			});
		}
	}
	const launchByRun = new Map<string, LaunchArgs>();
	for (const entry of entries) {
		const message = asRecord(asRecord(entry).message);
		if (message.role !== "toolResult" || message.toolName !== "subagent" || typeof message.toolCallId !== "string") continue;
		const launch = launchByCall.get(message.toolCallId);
		if (!launch) continue;
		const details = asRecord(message.details);
		for (const key of [details.asyncId, details.runId]) {
			if (typeof key === "string" && key && !launchByRun.has(key)) launchByRun.set(key, launch);
		}
	}
	// Positional agent/model for one result row: tasks[i] wins for parallel
	// launches, else the single-launch agent/model. The top-level model is a
	// documented child override so it stays a fallback; the top-level agent
	// names one-child execution only and never backfills parallel rows.
	const launchFor = (callId: unknown, runId: string | undefined, index: number): LaunchArgs | undefined => {
		const launch = (typeof callId === "string" ? launchByCall.get(callId) : undefined) ?? (runId ? launchByRun.get(runId) : undefined);
		if (!launch) return undefined;
		const agent = launch.agents?.[index] ?? (launch.agents ? undefined : launch.agent);
		const model = launch.models?.[index] ?? launch.model;
		if (!agent && !model) return undefined;
		return { ...(agent ? { agent } : {}), ...(model ? { model } : {}) };
	};
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "message") {
			const message = asRecord(record.message);
			if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
			const details = asRecord(message.details);
			const runId = asString(details.runId ?? details.asyncId ?? details.id, 160);
			const rows = Array.isArray(details.results) ? details.results : [];
			// Legacy parity (session-metrics record()): a detached single launch
			// has no completed results yet. Count its accepted child
			// immediately as queued (or its stated lifecycle state) instead
			// of dropping the receipt. Other receipt shapes stay uninferred.
			if (!rows.length && runId && details.mode === "single" && details.asyncId) {
				const identity = buildChildTaskIdentity({ runId, index: 0, attempt: 1 });
				const solo = launchFor(message.toolCallId, runId, 0);
				push({ type: "launch", taskId: identity.taskId, attempt: 1, runId, label: identity.label, ...(solo?.agent ? { agent: solo.agent } : {}), ...(solo?.model ? { route: solo.model } : {}) });
				const state = asString(details.state ?? details.status, 32);
				push({ type: "lifecycle", taskId: identity.taskId, attempt: 1, runId, state: state ?? "queued" });
			}
			rows.slice(0, 128).forEach((rowValue, position) => {
				const row = asRecord(rowValue);
				const index = Number.isSafeInteger(row.index) ? (row.index as number) : position;
				const identity = buildChildTaskIdentity({
					runId,
					index,
					childTask: asString(row.task ?? row.label ?? row.description, 1024),
					label: asString(row.label, 160),
					todoId: asString(row.todoId, 160),
					scopeId: asString(row.scopeId, 160),
					description: asString(row.description ?? row.task, 280),
					attempt: Number.isSafeInteger(row.attempt) ? (row.attempt as number) : 1,
					workflowKey: asString(row.workflowKey, 160),
					childId: asString(row.childId, 160),
				});
				// Row-named agent/route wins; launch args fill rows that omit them.
				const launch = launchFor(message.toolCallId, runId, index);
				push({
					type: "launch",
					taskId: identity.taskId,
					attempt: identity.attempt,
					...(typeof row.runId === "string" ? { runId: row.runId.slice(0, 160) } : runId ? { runId } : {}),
					label: identity.label,
					...(identity.todoId ? { todoId: identity.todoId } : {}),
					...(identity.scopeId ? { scopeId: identity.scopeId } : {}),
					...(identity.description ? { description: identity.description } : {}),
					...(typeof row.agent === "string" ? { agent: row.agent.slice(0, 80) } : launch?.agent ? { agent: launch.agent } : {}),
					...(typeof row.model === "string" ? { route: row.model.slice(0, 200) } : launch?.model ? { route: launch.model } : {}),
				});
				push({ type: "completion", taskId: identity.taskId, attempt: identity.attempt, ...(typeof row.runId === "string" ? { runId: row.runId.slice(0, 160) } : {}), row: row as Record<string, unknown> });
			});
			continue;
		}
		if (record.type !== "custom" || typeof record.customType !== "string") continue;
		const data = asRecord(record.data);
		if (record.customType === "subagent-cost-v1") {
			const runId = asString(data.runId, 160);
			const rows = Array.isArray(data.results) ? data.results : [];
			rows.slice(0, 128).forEach((rowValue, position) => {
				const row = asRecord(rowValue);
				const index = Number.isSafeInteger(row.index) ? (row.index as number) : position;
				const identity = buildChildTaskIdentity({
					runId,
					index,
					childTask: asString(row.task ?? row.label ?? row.description, 1024),
					label: asString(row.label, 160),
					todoId: asString(row.todoId, 160),
					scopeId: asString(row.scopeId, 160),
					description: asString(row.description ?? row.task, 280),
					attempt: Number.isSafeInteger(row.attempt) ? (row.attempt as number) : 1,
					workflowKey: asString(row.workflowKey, 160),
					childId: asString(row.childId, 160),
				});
				push({ type: "launch", taskId: identity.taskId, attempt: identity.attempt, label: identity.label, ...(identity.scopeId ? { scopeId: identity.scopeId } : {}) });
				const usage = hasRecordedTokenUsage(row.usage, row.childProcessStarted === false && row.stage === "launch") ? asRecord(row.usage) : {};
				const costLaunch = launchFor(undefined, runId, index);
				push({
					type: "accounting",
					taskId: identity.taskId,
					attempt: identity.attempt,
					...(typeof row.runId === "string" ? { runId: row.runId.slice(0, 160) } : {}),
					...(Object.keys(usage).length ? {
						usage: {
							...(asNumber(usage.input) === undefined ? {} : { input: asNumber(usage.input) }),
							...(asNumber(usage.output) === undefined ? {} : { output: asNumber(usage.output) }),
							...(asNumber(usage.cacheRead) === undefined ? {} : { cacheRead: asNumber(usage.cacheRead) }),
							...(asNumber(usage.cacheWrite) === undefined ? {} : { cacheWrite: asNumber(usage.cacheWrite) }),
							...(asNumber(usage.reasoning) === undefined ? {} : { reasoning: asNumber(usage.reasoning) }),
							...(asNumber(usage.turns) === undefined ? {} : { turns: asNumber(usage.turns) }),
						},
					} : {}),
					...(typeof row.model === "string" ? { route: row.model.slice(0, 200) } : costLaunch?.model ? { route: costLaunch.model } : {}),
					...(typeof row.agent === "string" ? { agent: row.agent.slice(0, 80) } : costLaunch?.agent ? { agent: costLaunch.agent } : {}),
				});
				push({ type: "completion", taskId: identity.taskId, attempt: identity.attempt, ...(typeof row.runId === "string" ? { runId: row.runId.slice(0, 160) } : {}), row });
			});
			continue;
		}
		if (record.customType === "subagent-lifecycle-v1") {
			const runId = asString(data.runId, 160);
			const rows = Array.isArray(data.results) ? data.results : [];
			if (!rows.length && (data.mode === "single" || typeof data.state === "string")) {
				const identity = buildChildTaskIdentity({ runId, index: 0, attempt: 1 });
				const soloLaunch = launchFor(undefined, runId, 0);
				push({ type: "launch", taskId: identity.taskId, attempt: 1, ...(runId ? { runId } : {}), label: identity.label, ...(soloLaunch?.agent ? { agent: soloLaunch.agent } : {}), ...(soloLaunch?.model ? { route: soloLaunch.model } : {}) });
				if (typeof data.state === "string") {
					push({ type: "lifecycle", taskId: identity.taskId, attempt: 1, ...(runId ? { runId } : {}), state: data.state });
				}
				continue;
			}
			rows.slice(0, 128).forEach((rowValue, position) => {
				const row = asRecord(rowValue);
				const index = Number.isSafeInteger(row.index) ? (row.index as number) : position;
				const identity = buildChildTaskIdentity({
					runId,
					index,
					childTask: asString(row.task ?? row.label ?? row.description, 1024),
					label: asString(row.label, 160),
					todoId: asString(row.todoId, 160),
					scopeId: asString(row.scopeId, 160),
					attempt: Number.isSafeInteger(row.attempt) ? (row.attempt as number) : 1,
					workflowKey: asString(row.workflowKey, 160),
					childId: asString(row.childId, 160),
				});
				const lifeLaunch = launchFor(undefined, runId, index);
				push({ type: "launch", taskId: identity.taskId, attempt: identity.attempt, ...(typeof row.runId === "string" ? { runId: row.runId.slice(0, 160) } : {}), label: identity.label, ...(identity.scopeId ? { scopeId: identity.scopeId } : {}), ...(typeof row.agent === "string" && row.agent ? { agent: row.agent.slice(0, 80) } : lifeLaunch?.agent ? { agent: lifeLaunch.agent } : {}), ...(typeof row.model === "string" && row.model ? { route: row.model.slice(0, 200) } : lifeLaunch?.model ? { route: lifeLaunch.model } : {}) });
				const state = asString(row.status ?? row.state, 32);
				if (state) push({ type: "lifecycle", taskId: identity.taskId, attempt: identity.attempt, state });
			});
			continue;
		}
		if (record.customType === "subagent-recover-evidence") {
			const taskId = asString(data.taskId ?? data.childId ?? data.workflowKey, 160);
			const attempt = Number.isSafeInteger(data.replacementAttempt) ? (data.replacementAttempt as number)
				: Number.isSafeInteger(data.attempt) ? (data.attempt as number) + 1 : undefined;
			push({
				type: "recovery",
				...(taskId ? { taskId } : {}),
				...(typeof data.runId === "string" ? { runId: data.runId.slice(0, 160) } : {}),
				...(Number.isSafeInteger(data.attempt) ? { attempt: data.attempt as number } : {}),
				...(asString(data.reason, 280) ? { reason: asString(data.reason, 280) } : {}),
				...(attempt !== undefined ? { replacementAttempt: attempt } : {}),
			});
			continue;
		}
		if (record.customType === "subagent-compaction-resume") {
			const taskId = asString(data.taskId ?? data.childId, 160);
			push({
				type: "resume",
				...(taskId ? { taskId } : {}),
				...(typeof data.runId === "string" ? { runId: data.runId.slice(0, 160) } : {}),
				...(Number.isSafeInteger(data.attempt) ? { attempt: data.attempt as number } : {}),
			});
			continue;
		}
	}
	return events;
}

/**
 * Project a logical task into the unified ExecutionEvidence envelope. This is
 * a pure projection of canonical ledger state — not a second source — so
 * cross-module merging (cost, reviews, diagnostics) never re-infers it.
 */
export function childTaskToEvidence(task: LogicalChildTask): ExecutionEvidence {
	const latest = [...task.attempts].sort((a, b) => b.attempt - a.attempt)[0];
	const usage = latest?.usage;
	return buildExecutionEvidence({
		identity: {
			id: task.taskId,
			...(latest ? { attempt: latest.attempt } : {}),
			...(task.todoId ? { todoId: task.todoId } : {}),
			...(task.label ? { label: task.label } : {}),
		},
		owner: "subagent",
		...(latest?.startedAt === undefined ? {} : { startedAt: latest.startedAt }),
		...(latest?.endedAt === undefined ? {} : { endedAt: latest.endedAt }),
		state: task.state,
		...(task.execution.cause ? { cause: `child/${task.execution.cause.category}` } : task.state === "completed" ? { cause: "child/ok" } : {}),
		artifacts: task.attempts.flatMap((attempt) => attempt.artifacts ?? []).slice(0, 32),
		...(usage ? {
			usage: {
				...(usage.input === undefined ? {} : { input: usage.input }),
				...(usage.output === undefined ? {} : { output: usage.output }),
				...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
				...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
				...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
				...(usage.turns === undefined ? {} : { turns: usage.turns }),
			},
		} : {}),
		...(task.acceptance.status === "none" ? {} : {
			verification: {
				method: "acceptance",
				passed: task.acceptance.status === "passed" ? true : task.acceptance.status === "failed" ? false : undefined,
			},
		}),
		producer: "child-ledger",
		detail: {
			attempts: task.attempts.length,
			route: latest?.route,
			execution: task.execution.status,
			acceptance: task.acceptance.status,
		},
	});
}

/** Count logical tasks by state (aggregate first; attempts stay expandable). */
export function summarizeLedger(ledger: ChildLedger): Record<ChildLifecycleState, number> & { tasks: number; attempts: number } {
	const summary: Record<ChildLifecycleState, number> & { tasks: number; attempts: number } = {
		queued: 0,
		running: 0,
		paused: 0,
		stopped: 0,
		completed: 0,
		failed: 0,
		tasks: ledger.tasks.length,
		attempts: 0,
	};
	for (const task of ledger.tasks) {
		summary[task.state] += 1;
		summary.attempts += task.attempts.length;
	}
	return summary;
}
