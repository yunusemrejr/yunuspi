import * as fs from "node:fs";
import * as path from "node:path";
import { updateGuardedStatus } from "../shared/status-revision.ts";
import { resultFilePath, resultPayloadPathForSessionRun, writeAsyncResultFileIfAbsent } from "./result-files.ts";
import { readCompletionReplay } from "./completion-replay.ts";
import { updateActiveRunIndex } from "./active-run-index.ts";
import { readStatus } from "../../shared/utils.ts";
import { readProcessStartIdentity } from "../../shared/process-start-identity.ts";
import { DIRS, type AsyncParallelGroupStatus, type AsyncStatus, type NestedRunSummary, type SubagentRunMode } from "../../shared/types.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, type NestedRoute } from "../shared/nested-events.ts";
import { assertWorkflowGraphHostSteps } from "../shared/host-step-status.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	completionOwnerId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
	sessionName?: string;
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
	readStartIdentity?: (pid: number) => string | undefined;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
	const stderrPath = path.join(asyncDir, "runner.stderr.log");
	const maxBytes = 64 * 1024;
	let content: string;
	try {
		const stat = fs.statSync(stderrPath);
		if (stat.size <= 0) return undefined;
		const fd = fs.openSync(stderrPath, "r");
		try {
			const bytesToRead = Math.min(stat.size, maxBytes);
			const start = Math.max(0, stat.size - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			fs.readSync(fd, buffer, 0, bytesToRead, start);
			content = buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(-30).join("\n");
	return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function appendJsonlBestEffort(filePath: string, payload: object): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Repair status/result writes are the important path. A broken or full
		// diagnostic event log must not make stale-run reconciliation fail.
	}
}

interface ResultChildOutcome {
	agent?: string;
	sessionName?: string;
	success?: boolean;
	error?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
	contextOverflow?: boolean;
}

interface ResultRepairData {
	state: "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
	results?: ResultChildOutcome[];
}

function regularFileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

function parseResultRepairData(data: { success?: boolean; state?: string; exitCode?: number; results?: unknown }, source: string): ResultRepairData {
	const state = data.success || (data.success === undefined && data.state === "complete") ? "complete"
		: data.state === "stopped" || data.state === "rejected" || data.state === "partial" ? data.state
		: data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
	const results = Array.isArray(data.results)
		? data.results.map((entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
			const child = entry as ResultChildOutcome;
			if (child.model !== undefined && typeof child.model !== "string") throw new Error(`Invalid async result file '${source}': results[${index}].model must be a string.`);
			if (child.thinking !== undefined && typeof child.thinking !== "string") throw new Error(`Invalid async result file '${source}': results[${index}].thinking must be a string.`);
			return child;
		})
		: undefined;
	return { state, ...(results ? { results } : {}) };
}

function readResultRepairData(resultPath: string): ResultRepairData | undefined {
	try {
		return parseResultRepairData(JSON.parse(fs.readFileSync(resultPath, "utf-8")), resultPath);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): ResultRepairData["state"] {
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

function terminalStatusFromResult(status: AsyncStatus, repair: ResultRepairData, now: number): AsyncStatus {
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		const model = child?.model ?? step.model;
		const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
		return {
			...step,
			status: state === "complete" ? "complete" as const : state,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: state === "failed" || state === "partial" || state === "stopped" ? step.error ?? child?.error : step.error,
			stopped: state === "stopped" ? true : step.stopped,
			sessionName: step.sessionName ?? child?.sessionName,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model,
			thinking,
			attemptedModels: child?.attemptedModels ?? step.attemptedModels,
			modelAttempts: child?.modelAttempts ?? step.modelAttempts,
			contextOverflow: child?.contextOverflow ?? step.contextOverflow,
		};
	});
	const terminalStatus: AsyncStatus = {
		...status,
		state: repair.state,
		...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
			processTerminal: { version: 1 as const, state: "unknown" as const, runId: status.runId, runnerProcessInstanceId: "observer-unavailable", reason: "observer-unavailable" as const },
		} : {}),
		...(repair.state === "stopped" ? { stopped: true } : {}),
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
	};
	delete terminalStatus.displayDismissedAt;
	return terminalStatus;
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return {
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		...(startedRun.completionOwnerId ? { completionOwnerId: startedRun.completionOwnerId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	};
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number): { status: AsyncStatus; result: Record<string, unknown>; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const baseMessage = `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const diagnostics = readRunnerStartupDiagnostics(asyncDir);
	const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
		? {
			...step,
			status: "failed" as const,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? 1,
			error: step.error ?? message,
		}
		: step);
	const repairedStatus: AsyncStatus = {
		...status,
		state: "failed",
		...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
			processTerminal: { version: 1 as const, state: "unknown" as const, runId, runnerProcessInstanceId: "observer-unavailable", reason: "stale-repair" as const },
		} : {}),
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			...(status.completionOwnerId ? { completionOwnerId: status.completionOwnerId } : {}),
			success: false,
			state: "failed",
			summary: message,
			results: repairedSteps.map((step) => ({
				agent: step.agent,
				...(step.sessionName ? { sessionName: step.sessionName } : {}),
				output: step.status === "complete" || step.status === "completed" ? "" : message,
				error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
				success: step.status === "complete" || step.status === "completed",
				model: step.model,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				contextOverflow: step.contextOverflow,
				sessionFile: step.sessionFile,
			})),
			exitCode: 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

function findResultPath(status: AsyncStatus, resultsDir: string, resultPath: string): string | undefined {
	const indexed = status.sessionId
		? resultPayloadPathForSessionRun(resultsDir, status.sessionId, status.runId || path.basename(resultPath, ".json"))
		: undefined;
	return indexed ?? (regularFileExists(resultPath) ? resultPath : undefined);
}

function repairFromObservedOutcome(input: {
	asyncDir: string;
	observed: AsyncStatus;
	initial?: AsyncStatus;
	verifiedDead: boolean;
	resultsDir: string;
	resultPath: string;
	now: number;
}): ReconcileAsyncRunResult {
	const { asyncDir, observed, initial, verifiedDead, resultsDir, resultPath, now } = input;
	let outcome: ReconcileAsyncRunResult = { status: null, repaired: false, resultPath };
	let synthetic = false;
	const statusPath = path.join(asyncDir, "status.json");
	const guarded = updateGuardedStatus(statusPath, (value) => {
		const current = value as unknown as AsyncStatus;
		outcome.status = current.displayDismissedAt === undefined ? current : null;
		if (current.runId !== observed.runId || current.sessionId !== observed.sessionId || !outcome.status) return undefined;

		const recoverExisting = () => {
			const existing = findResultPath(current, resultsDir, resultPath);
			if (existing) outcome.resultPath = existing;
			if (current.state !== "running" && current.state !== "queued") return undefined;
			const receipt = existing ? readResultRepairData(existing) : undefined;
			const replay = !receipt && current.sessionId
				? readCompletionReplay(resultsDir, current.runId, { sessionId: current.sessionId, now })
				: undefined;
			if (!receipt && !replay) return undefined;
			outcome.message = receipt ? "Existing async result file was used to repair stale running status."
				: "Delivered async completion replay was used to repair stale running status.";
			return terminalStatusFromResult(current, receipt ?? parseResultRepairData(replay!.completion, replay!.archivePath), now);
		};

		const existing = recoverExisting();
		if (existing) return outcome.status = existing;
		const sameWriter = current.pid === observed.pid && current.runnerProcessStartIdentity === observed.runnerProcessStartIdentity;
		if (!verifiedDead || current.state !== "running" || !sameWriter) return undefined;

		const repair = buildFailedRepair(current, asyncDir, now);
		// The pending/public receipt and replay were re-observed after death and
		// under the status lock. Publish only as a fallback. If publication wins
		// but the status write is interrupted, the next pass recovers from it.
		if (current.sessionId && !writeAsyncResultFileIfAbsent(resultPath, repair.result)) {
			const winner = recoverExisting();
			if (winner) return outcome.status = winner;
			return undefined;
		}
		synthetic = true;
		outcome = { status: repair.status, repaired: false, ...(current.sessionId ? { resultPath } : {}), message: repair.message };
		return repair.status;
	}, { initial });
	if (!guarded.written || !outcome.status) return outcome;
	outcome.status = { ...outcome.status, revision: guarded.revision };
	outcome.repaired = true;
	updateActiveRunIndex(asyncDir, outcome.status.state, outcome.status.toolCallId);
	if (synthetic) appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: outcome.status.runId,
		pid: observed.pid,
		...(outcome.resultPath ? { resultPath: outcome.resultPath } : {}),
		message: outcome.message,
	});
	return outcome;
}

function terminal(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? DIRS.results, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state)) continue;
		const ts = options.now?.() ?? Date.now();
		writeNestedEvent(route, {
			type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			parentStepIndex: run.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(status, asyncDir, {
				id: run.id,
				parentRunId: run.parentRunId,
				parentStepIndex: run.parentStepIndex,
				depth: run.depth,
				path: run.path,
				mode: run.mode,
				ts,
			}),
		});
	}
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill, options: { expectedStartIdentity?: string; readStartIdentity?: (pid: number) => string | undefined } = {}): PidLiveness {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	try {
		if (!kill(pid, 0)) return "unknown";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
	// The PID exists, but it may have been recycled since the runner recorded it.
	// When the runner persisted its kernel start time, verify the live process is
	// still that same instance. A readable-but-different identity proves the PID
	// now belongs to an unrelated process, so the run is as good as dead. An
	// unreadable identity (non-Linux, permission, transient /proc race) falls back
	// to "alive" so we never mark a possibly-live runner failed on that alone.
	const expected = options.expectedStartIdentity;
	if (expected) {
		const reader = options.readStartIdentity ?? readProcessStartIdentity;
		const current = reader(pid);
		if (current !== undefined && current !== expected) return "dead";
	}
	return "alive";
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatus(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };
	assertWorkflowGraphHostSteps(effectiveStatus.workflowGraph, path.join(asyncDir, "status.json"), effectiveStatus.runId);
	const statusPath = path.join(asyncDir, "status.json");
	for (const [index, step] of (effectiveStatus.steps ?? []).entries()) {
		const stepRecord = step as Record<string, unknown>;
		if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
		if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
	}
	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultsDir = options.resultsDir ?? DIRS.results;
	const resultPath = resultFilePath(resultsDir, runId);
	if (effectiveStatus.displayDismissedAt !== undefined) {
		return { status: null, repaired: false, resultPath };
	}
	const existingResultPath = findResultPath(effectiveStatus, resultsDir, resultPath);
	const recovery = { asyncDir, observed: effectiveStatus, initial: startedStatus, resultsDir, resultPath, now };
	if (existingResultPath) {
		if (effectiveStatus.state === "running" || effectiveStatus.state === "queued") {
			return repairFromObservedOutcome({ ...recovery, verifiedDead: false });
		}
		return { status: effectiveStatus, repaired: false, resultPath: existingResultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	const liveness = checkPidLiveness(effectiveStatus.pid, options.kill, { expectedStartIdentity: effectiveStatus.runnerProcessStartIdentity, readStartIdentity: options.readStartIdentity });
	if (liveness !== "dead") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} has no confirmed exit and its status has not updated for ${now - lastUpdate}ms.`;
		return { status: status ?? null, repaired: false, resultPath, message };
	}

	return repairFromObservedOutcome({ ...recovery, verifiedDead: true });
}
