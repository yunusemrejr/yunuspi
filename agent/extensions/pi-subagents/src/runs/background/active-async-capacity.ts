import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { readProcessStartIdentity } from "../../shared/process-start-identity.ts";
import { TEMP_ROOT_DIR, type ActiveAsyncCapacitySnapshot, type AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { checkPidLiveness, type PidLiveness } from "./stale-run-reconciler.ts";
import { readProcessTerminal } from "./process-terminal.ts";

export const ACTIVE_ASYNC_CAPACITY_DIR = path.join(TEMP_ROOT_DIR, "session-active-async-capacity");
export const DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS = 20 * 60 * 1000;
export const MIN_ABANDONED_SLOT_RELEASE_AFTER_MS = 5 * 60 * 1000;
export const MAX_ABANDONED_SLOT_RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;

interface ReservationCreator {
	pid: number;
	bootId: string;
	pidNamespace: string;
	startIdentity: string;
}

function localReservationCreator(): ReservationCreator | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		if (fs.readlinkSync("/proc/self") !== String(process.pid)) return undefined;
		const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
		const pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
		const startIdentity = readProcessStartIdentity(process.pid);
		if (bootId && pidNamespace && startIdentity) return { pid: process.pid, bootId, pidNamespace, startIdentity };
	} catch { /* A reservation without qualified process evidence is retained. */ }
}

const localCreator = localReservationCreator();
const writeCapacityOwner = createAtomicJsonWriter({ mode: 0o600, ignoreCleanupErrorAfterSuccess: true });

export interface ActiveAsyncCapacityOwnerV1 {
	version: 1;
	reservationToken: string;
	ownerSessionId: string;
	ownerSessionKey: string;
	slot: number;
	runId: string;
	sourceRunId?: string;
	generation: number;
	kind: "runner" | "workflow";
	asyncDir: string;
	reservedAt: number;
	creator?: ReservationCreator;
	transferPredecessor?: ActiveAsyncCapacityOwnerV1;
	runnerProcessInstanceId?: string;
	runnerStartedAt?: number;
	workflowDispatchPending?: true;
}

export interface ActiveAsyncCapacityHandle {
	readonly owner: ActiveAsyncCapacityOwnerV1;
	markStarted(runnerProcessInstanceId: string): void;
	markWorkflowPrepared(): void;
	markWorkflowStarted(): void;
	rollback(): boolean;
	rollbackBeforeRunnerProceed(runnerProcessInstanceId: string): boolean;
	reconcile(liveWorkflowRunIds?: ReadonlySet<string>): ActiveAsyncCapacitySnapshot;
}

interface CapacityOptions {
	rootDir?: string;
	now?: () => number;
	token?: () => string;
	abandonedSlotReleaseAfterMs?: number | false;
	pidLiveness?: (pid: number) => PidLiveness;
	afterSlotRename?: (releasedDir: string) => void;
	writeOwner?: (filePath: string, owner: ActiveAsyncCapacityOwnerV1) => void;
}

export interface ActiveAsyncCapacityReleaseEvidence {
	releasedBy: "abandoned-timeout";
	processProof: "unknown";
	runnerPid: "gone";
	lastActivityAgeMs: number;
	abandonedSlotReleaseAfterMs: number;
}

export type ActiveAsyncCapacityReleaseVerdict =
	| { state: "releasable"; reason: string; evidence?: ActiveAsyncCapacityReleaseEvidence; unstartedReservation?: true }
	| { state: "retained"; reason: string }
	| { state: "not-owned"; reason: string };

export interface ActiveAsyncCapacityInspection {
	owner?: ActiveAsyncCapacityOwnerV1;
	relation: "current" | "source" | "none";
	slotDir?: string;
	release: ActiveAsyncCapacityReleaseVerdict;
}

export class ActiveAsyncCapacityError extends Error {
	readonly snapshot: ActiveAsyncCapacitySnapshot;

	constructor(snapshot: ActiveAsyncCapacitySnapshot) {
		super(`Active async run capacity exhausted: ${snapshot.used}/${snapshot.limit} used.`);
		this.name = "ActiveAsyncCapacityError";
		this.snapshot = snapshot;
	}
}

export function resolveMaxActiveAsyncRunsPerSession(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
	return value === 0 ? undefined : value;
}

export function resolveAbandonedSlotReleaseAfterMs(value: unknown): number | false {
	if (value === false) return false;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS;
	return value;
}

export function activeAsyncCapacitySessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

function sessionDir(sessionId: string, rootDir: string): string {
	return path.join(rootDir, activeAsyncCapacitySessionKey(sessionId));
}

function slotDir(poolDir: string, slot: number): string {
	return path.join(poolDir, `slot-${slot}`);
}

function parseOwner(value: unknown): ActiveAsyncCapacityOwnerV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Partial<ActiveAsyncCapacityOwnerV1>;
	if (owner.version !== 1
		|| typeof owner.reservationToken !== "string" || !owner.reservationToken
		|| typeof owner.ownerSessionId !== "string" || !owner.ownerSessionId
		|| typeof owner.ownerSessionKey !== "string" || !owner.ownerSessionKey
		|| typeof owner.slot !== "number" || !Number.isInteger(owner.slot) || owner.slot < 0
		|| typeof owner.runId !== "string" || !owner.runId
		|| typeof owner.generation !== "number" || !Number.isSafeInteger(owner.generation) || owner.generation < 0
		|| (owner.kind !== "runner" && owner.kind !== "workflow")
		|| typeof owner.asyncDir !== "string" || !owner.asyncDir
		|| typeof owner.reservedAt !== "number" || !Number.isFinite(owner.reservedAt)) return undefined;
	if (owner.sourceRunId !== undefined && typeof owner.sourceRunId !== "string") return undefined;
	if (owner.runnerProcessInstanceId !== undefined && (typeof owner.runnerProcessInstanceId !== "string" || !owner.runnerProcessInstanceId)) return undefined;
	if (owner.runnerStartedAt !== undefined && (typeof owner.runnerStartedAt !== "number" || !Number.isFinite(owner.runnerStartedAt))) return undefined;
	return owner as ActiveAsyncCapacityOwnerV1;
}

function readOwner(dir: string): ActiveAsyncCapacityOwnerV1 | undefined {
	try {
		return parseOwner(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf-8")));
	} catch {
		return undefined;
	}
}

function occupiedSlots(poolDir: string): string[] {
	try {
		return fs.readdirSync(poolDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^slot-\d+$/.test(entry.name))
			.map((entry) => path.join(poolDir, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function snapshotFor(sessionId: string, limit: number | undefined, rootDir: string): ActiveAsyncCapacitySnapshot {
	return { used: occupiedSlots(sessionDir(sessionId, rootDir)).length, limit: limit ?? 0 };
}

function matchingOwner(dir: string, expected: ActiveAsyncCapacityOwnerV1): ActiveAsyncCapacityOwnerV1 | undefined {
	const owner = readOwner(dir);
	return owner?.reservationToken === expected.reservationToken
		&& owner.runId === expected.runId
		&& owner.generation === expected.generation
		? owner
		: undefined;
}

interface SlotClaim { token: string; creator?: ReservationCreator }

function readSlotClaim(claimPath: string): SlotClaim | undefined {
	try {
		const claim = JSON.parse(fs.readFileSync(path.join(claimPath, "owner.json"), "utf-8")) as SlotClaim;
		if (typeof claim?.token === "string" && /^[0-9a-f-]{36}$/.test(claim.token)) return claim;
	} catch { /* Legacy and unreadable claims do not prove ownership ended. */ }
}

function claimUnavailable(error: unknown): boolean {
	return ["ENOENT", "EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function withPathClaim<T>(claimPath: string, recoveryDir: string, operation: () => T): { acquired: true; value: T } | { acquired: false } {
	const dir = path.dirname(claimPath);
	const previous = readSlotClaim(claimPath);
	if (previous) {
		if (!creatorIsGone(previous.creator)) return { acquired: false };
		// Two reapers of the same token cannot move a later claim over this tombstone.
		const retired = path.join(recoveryDir, `.recovered-claim-${previous.token}`);
		try { fs.renameSync(claimPath, retired); }
		catch (error) { if (claimUnavailable(error)) return { acquired: false }; throw error; }
	} else if (fs.lstatSync(claimPath, { throwIfNoEntry: false })) return { acquired: false };
	const claim = { token: randomUUID(), creator: localCreator };
	const candidate = path.join(dir, `.claim-candidate-${claim.token}`);
	try {
		fs.mkdirSync(candidate, { mode: 0o700 });
		fs.writeFileSync(path.join(candidate, "owner.json"), JSON.stringify(claim), { mode: 0o600, flag: "wx" });
		fs.renameSync(candidate, claimPath);
	} catch (error) {
		if (claimUnavailable(error)) return { acquired: false };
		throw error;
	} finally {
		fs.rmSync(candidate, { force: true, recursive: true });
	}
	try {
		return { acquired: true, value: operation() };
	} finally {
		if (readSlotClaim(claimPath)?.token === claim.token) {
			const retired = path.join(dir, `.released-claim-${claim.token}`);
			try {
				fs.renameSync(claimPath, retired);
				fs.rmSync(retired, { force: true, recursive: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

function withSlotClaim<T>(dir: string, operation: () => T) {
	return withPathClaim(path.join(dir, "capacity.claim"), path.dirname(dir), operation);
}

function removeOwnedSlot(dir: string, expected: ActiveAsyncCapacityOwnerV1, options: CapacityOptions, requireBeforeDispatch = false, release?: ActiveAsyncCapacityReleaseVerdict): boolean {
	if (requireBeforeDispatch && !isBeforeDispatch(expected)) return false;
	const claimed = withSlotClaim(dir, () => {
		const current = matchingOwner(dir, expected);
		if (!current || (requireBeforeDispatch && !isBeforeDispatch(current))) return false;
		if (release?.state === "releasable" && release.unstartedReservation) {
			if (!abandonedFreshReservation(current, options)) return false;
			// Keep the retired generation's directory nonempty. If two reapers
			// recovered the same stale claim, neither can rename a replacement over it.
			const key = createHash("sha256").update(JSON.stringify([current.reservationToken, current.runId, current.generation])).digest("hex");
			const retired = path.join(path.dirname(dir), `.recovered-reservation-${key}`);
			try { fs.renameSync(dir, retired); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT" || fs.existsSync(retired)) return false;
				throw error;
			}
			return true;
		}
		const releasedDir = path.join(path.dirname(dir), `.${path.basename(dir)}.released-${randomUUID()}`);
		fs.renameSync(dir, releasedDir);
		options.afterSlotRename?.(releasedDir);
		if (release?.state === "releasable" && release.evidence) {
			appendAbandonedReleaseEvent(expected.asyncDir, expected, release.evidence, options.now?.() ?? Date.now());
		}
		fs.rmSync(releasedDir, { recursive: true, force: true });
		return true;
	});
	return claimed.acquired && claimed.value;
}

function appendAbandonedReleaseEvent(asyncDir: string, owner: ActiveAsyncCapacityOwnerV1, evidence: ActiveAsyncCapacityReleaseEvidence, now: number): void {
	try {
		const eventsPath = path.join(asyncDir, "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.appendFileSync(eventsPath, `${JSON.stringify({
			type: "subagent.capacity.released",
			ts: now,
			runId: owner.runId,
			sessionId: owner.ownerSessionId,
			...evidence,
		})}\n`, "utf-8");
	} catch {
		// Capacity release must not fail because its diagnostic event cannot be written.
	}
}

function terminalState(state: AsyncStatus["state"]): boolean {
	return state !== "queued" && state !== "running" && state !== "paused";
}

function creatorIsGone(creator: ReservationCreator | undefined, liveness = checkPidLiveness): boolean {
	if (!creator || !localCreator ||
		creator.bootId !== localCreator.bootId || creator.pidNamespace !== localCreator.pidNamespace ||
		!Number.isSafeInteger(creator.pid) || creator.pid <= 0 || typeof creator.startIdentity !== "string" ||
		!/^linux:\d+$/.test(creator.startIdentity)) return false;
	if (creator.pid === localCreator.pid) return creator.startIdentity !== localCreator.startIdentity;
	if (liveness(creator.pid) === "dead") return true;
	const currentIdentity = readProcessStartIdentity(creator.pid);
	return Boolean(currentIdentity && /^linux:\d+$/.test(currentIdentity) && currentIdentity !== creator.startIdentity);
}

function isUnstarted(owner: ActiveAsyncCapacityOwnerV1): boolean {
	return owner.runnerProcessInstanceId === undefined && owner.runnerStartedAt === undefined;
}

function isBeforeDispatch(owner: ActiveAsyncCapacityOwnerV1): boolean {
	return isUnstarted(owner) || (owner.kind === "workflow" && owner.workflowDispatchPending === true && owner.runnerProcessInstanceId === undefined);
}

function abandonedFreshReservation(owner: ActiveAsyncCapacityOwnerV1, options: CapacityOptions): boolean {
	return owner.generation === 0 && owner.sourceRunId === undefined && isBeforeDispatch(owner) && creatorIsGone(owner.creator, options.pidLiveness);
}

function transferPredecessor(owner: ActiveAsyncCapacityOwnerV1): ActiveAsyncCapacityOwnerV1 | undefined {
	const predecessor = parseOwner(owner.transferPredecessor);
	if (predecessor && !predecessor.transferPredecessor && predecessor.runId === owner.sourceRunId &&
		predecessor.ownerSessionId === owner.ownerSessionId && predecessor.ownerSessionKey === owner.ownerSessionKey &&
		predecessor.slot === owner.slot && predecessor.reservationToken === owner.reservationToken &&
		predecessor.generation + 1 === owner.generation) return predecessor;
}

function restorePredecessor(dir: string, owner: ActiveAsyncCapacityOwnerV1, predecessor: ActiveAsyncCapacityOwnerV1): void {
	writeCapacityOwner(path.join(dir, "owner.json"), { ...predecessor, generation: owner.generation + 1 });
}

function recoverAbandonedTransfer(dir: string, expected: ActiveAsyncCapacityOwnerV1, options: CapacityOptions): boolean {
	if (!transferPredecessor(expected) || !isUnstarted(expected) || !creatorIsGone(expected.creator, options.pidLiveness)) return false;
	const claim = withSlotClaim(dir, () => {
		const current = matchingOwner(dir, expected);
		const predecessor = current && transferPredecessor(current);
		if (!current || !predecessor || !isUnstarted(current) || !creatorIsGone(current.creator, options.pidLiveness)) return false;
		restorePredecessor(dir, current, predecessor);
		return true;
	});
	return claim.acquired && claim.value;
}

function runnerReleaseVerdict(owner: ActiveAsyncCapacityOwnerV1, status: AsyncStatus | null, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	if (!status) return { state: "retained", reason: "status file is missing or unreadable" };
	if (!owner.runnerProcessInstanceId) return { state: "retained", reason: "runner process identity has not been recorded" };
	if (status.sessionId !== owner.ownerSessionId) return { state: "retained", reason: `status session ${status.sessionId ?? "unknown"} does not match owner session ${owner.ownerSessionId}` };
	if (status.runId !== owner.runId) return { state: "retained", reason: `status run ${status.runId} does not match owner run ${owner.runId}` };
	if (!terminalState(status.state)) return { state: "retained", reason: `run is still ${status.state}` };
	if (status.processTerminal?.state === "not-started"
		&& status.processTerminal.runId === owner.runId
		&& status.processTerminal.runnerProcessInstanceId === owner.runnerProcessInstanceId
		&& typeof status.error === "string"
		&& status.error) return { state: "releasable", reason: "run failed before child startup completed" };
	const proof = readProcessTerminal(owner.asyncDir, {
		runId: owner.runId,
		runnerProcessInstanceId: owner.runnerProcessInstanceId,
	});
	return proof?.state === "observed"
		&& proof.runId === owner.runId
		&& proof.runnerProcessInstanceId === owner.runnerProcessInstanceId
		? { state: "releasable", reason: "matching observed process-terminal proof is present" }
		: abandonedRunnerReleaseVerdict(status, proof?.state ?? "missing", options);
}

function abandonedRunnerReleaseVerdict(status: AsyncStatus, proofState: string, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	const proofReason = `process-terminal proof is ${proofState}`;
	const thresholdMs = resolveAbandonedSlotReleaseAfterMs(options.abandonedSlotReleaseAfterMs);
	if (thresholdMs === false) return { state: "retained", reason: `${proofReason}; abandoned-timeout policy is disabled` };
	if (status.state !== "failed") return { state: "retained", reason: `${proofReason}; abandoned-timeout policy requires a failed run, not ${status.state}` };
	if (typeof status.pid !== "number" || !Number.isInteger(status.pid) || status.pid < 1) return { state: "retained", reason: `${proofReason}; runner PID is missing or invalid` };
	const liveness = (options.pidLiveness ?? checkPidLiveness)(status.pid);
	if (liveness !== "dead") return { state: "retained", reason: `${proofReason}; runner PID liveness is ${liveness}` };
	const lastActivityAt = status.lastActivityAt ?? status.lastUpdate ?? status.endedAt;
	if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) return { state: "retained", reason: `${proofReason}; last activity timestamp is missing or invalid` };
	const now = options.now?.() ?? Date.now();
	const lastActivityAgeMs = Math.max(0, now - lastActivityAt);
	if (lastActivityAgeMs <= thresholdMs) return { state: "retained", reason: `${proofReason}; last activity age ${lastActivityAgeMs}ms has not exceeded abandoned-timeout ${thresholdMs}ms` };
	const evidence: ActiveAsyncCapacityReleaseEvidence = {
		releasedBy: "abandoned-timeout",
		processProof: "unknown",
		runnerPid: "gone",
		lastActivityAgeMs,
		abandonedSlotReleaseAfterMs: thresholdMs,
	};
	return {
		state: "releasable",
		reason: `${evidence.releasedBy}: ${proofReason}; runner PID is gone; process proof unknown; last activity age ${lastActivityAgeMs}ms exceeds ${thresholdMs}ms`,
		evidence,
	};
}

function workflowReleaseVerdict(owner: ActiveAsyncCapacityOwnerV1, status: AsyncStatus | null, liveWorkflowRunIds: ReadonlySet<string>): ActiveAsyncCapacityReleaseVerdict {
	if (!status) return { state: "retained", reason: "status file is missing or unreadable" };
	if (status.sessionId !== owner.ownerSessionId) return { state: "retained", reason: `status session ${status.sessionId ?? "unknown"} does not match owner session ${owner.ownerSessionId}` };
	if (status.runId !== owner.runId) return { state: "retained", reason: `status run ${status.runId} does not match owner run ${owner.runId}` };
	if (status.mode !== "workflow") return { state: "retained", reason: `status mode is ${status.mode}, not workflow` };
	if (!terminalState(status.state)) return { state: "retained", reason: `workflow is still ${status.state}` };
	if (liveWorkflowRunIds.has(owner.runId)) return { state: "retained", reason: "workflow controller is still live" };
	for (const step of status.steps ?? []) {
		const label = step.workflowKey ?? step.agent;
		if (step.status === "pending" || step.status === "running" || step.status === "paused") return { state: "retained", reason: `workflow child ${label} is still ${step.status}` };
		if (typeof step.async !== "boolean") return { state: "retained", reason: `workflow child ${label} is missing async classification` };
		if (!step.async) continue;
		if (!step.runId) return { state: "retained", reason: `async workflow child ${label} is missing run id` };
		const childDir = path.join(path.dirname(owner.asyncDir), step.runId);
		if (!fs.existsSync(childDir)) return { state: "retained", reason: `async workflow child ${label} directory is missing` };
		const childStatus = readStatus(childDir);
		if (!childStatus) return { state: "retained", reason: `async workflow child ${label} status is missing or unreadable` };
		if (!terminalState(childStatus.state)) return { state: "retained", reason: `async workflow child ${label} is still ${childStatus.state}` };
		if (!childStatus.processTerminal?.runnerProcessInstanceId) return { state: "retained", reason: `async workflow child ${label} has no runner process identity` };
		const proof = readProcessTerminal(childDir, {
			runId: step.runId,
			runnerProcessInstanceId: childStatus.processTerminal.runnerProcessInstanceId,
		});
		if (proof?.state !== "observed" || proof.runId !== step.runId) return { state: "retained", reason: `async workflow child ${label} process-terminal proof is ${proof?.state ?? "missing"}` };
	}
	return { state: "releasable", reason: "workflow is terminal, controller is gone, and async children have observed proof" };
}

function ownerReleaseVerdict(owner: ActiveAsyncCapacityOwnerV1, liveWorkflowRunIds: ReadonlySet<string>, options: CapacityOptions): ActiveAsyncCapacityReleaseVerdict {
	// A runner needs its binding before proceed. A workflow needs its durable
	// startup marker before scheduling. Neither can dispatch while still unstarted.
	if (abandonedFreshReservation(owner, options)) {
		return { state: "releasable", reason: "reservation creator exited before startup was authorized", unstartedReservation: true };
	}
	const status = readStatus(owner.asyncDir);
	return owner.kind === "runner"
		? runnerReleaseVerdict(owner, status, options)
		: workflowReleaseVerdict(owner, status, liveWorkflowRunIds);
}

function capacitySessionDirs(rootDir: string, sessionId?: string): string[] {
	if (sessionId) return [sessionDir(sessionId, rootDir)];
	try {
		return fs.readdirSync(rootDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(rootDir, entry.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function inspectActiveAsyncCapacityOwner(
	input: { runId: string; sessionId?: string; asyncDir?: string },
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacityInspection {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const liveWorkflowRunIds = options.liveWorkflowRunIds ?? new Set<string>();
	for (const poolDir of capacitySessionDirs(rootDir, input.sessionId)) {
		for (const dir of occupiedSlots(poolDir)) {
			const owner = readOwner(dir);
			if (!owner) continue;
			const sameRun = owner.runId === input.runId || (input.asyncDir !== undefined && path.resolve(owner.asyncDir) === path.resolve(input.asyncDir));
			const sourceRun = owner.sourceRunId === input.runId;
			if (!sameRun && !sourceRun) continue;
			if (sourceRun && !sameRun) {
				return {
					owner,
					relation: "source",
					slotDir: dir,
					release: { state: "not-owned", reason: `slot was transferred to ${owner.runId}` },
				};
			}
			return { owner, relation: "current", slotDir: dir, release: ownerReleaseVerdict(owner, liveWorkflowRunIds, options) };
		}
	}
	return { relation: "none", release: { state: "not-owned", reason: "no active-capacity slot records this run" } };
}

export function reconcileActiveAsyncCapacity(
	sessionId: string,
	limit: number | undefined,
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacitySnapshot {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const poolDir = sessionDir(sessionId, rootDir);
	const liveWorkflowRunIds = options.liveWorkflowRunIds ?? new Set<string>();
	for (const dir of occupiedSlots(poolDir)) {
		let owner = readOwner(dir);
		if (!owner) {
			if (incompletePublication(dir) && creatorIsGone(readPublisher(dir))) {
				withPublicationClaim(dir, () => recoverIncompletePublication(dir));
			}
			continue;
		}
		if (owner.ownerSessionId !== sessionId
			|| owner.ownerSessionKey !== activeAsyncCapacitySessionKey(sessionId)
			|| path.basename(dir) !== `slot-${owner.slot}`) continue;
		if (recoverAbandonedTransfer(dir, owner, options)) {
			owner = readOwner(dir);
			if (!owner) continue;
		}
		const release = ownerReleaseVerdict(owner, liveWorkflowRunIds, options);
		if (release.state !== "releasable") continue;
		removeOwnedSlot(dir, owner, options, false, release);
	}
	return snapshotFor(sessionId, limit, rootDir);
}

export function getActiveAsyncCapacitySnapshot(
	sessionId: string,
	limit: number | undefined,
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacitySnapshot {
	return reconcileActiveAsyncCapacity(sessionId, limit, options);
}

const publicationMode = 0o1700;

function publicationPath(dir: string, suffix: string): string {
	return path.join(path.dirname(dir), `.${path.basename(dir)}.publisher${suffix}`);
}

function withPublicationClaim<T>(dir: string, operation: () => T) {
	return withPathClaim(publicationPath(dir, ".claim"), path.dirname(dir), operation);
}

function incompletePublication(dir: string): boolean {
	const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
	return Boolean(stat?.isDirectory() && (stat.mode & 0o1000) && stat.uid === process.getuid?.() &&
		!fs.lstatSync(path.join(dir, "owner.json"), { throwIfNoEntry: false }));
}

function readPublisher(dir: string): ReservationCreator | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(publicationPath(dir, ".json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(fd);
		if (stat.isFile() && stat.uid === process.getuid?.() && stat.size <= 1024) return JSON.parse(fs.readFileSync(fd, "utf-8"));
	} catch { /* Unreadable publisher identity cannot establish a dead owner. */ }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}

function retireIncompleteSlot(dir: string): void {
	const retired = path.join(path.dirname(dir), `.incomplete-slot-${randomUUID()}`);
	fs.renameSync(dir, retired);
	fs.rmSync(retired, { recursive: true, force: true });
}

function recoverIncompletePublication(dir: string): boolean {
	if (!incompletePublication(dir) || !creatorIsGone(readPublisher(dir))) return false;
	retireIncompleteSlot(dir);
	return true;
}

function publishSlot(destination: string, owner: ActiveAsyncCapacityOwnerV1, mode: number): boolean {
	try {
		fs.mkdirSync(destination, { mode });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try { writeCapacityOwner(path.join(destination, "owner.json"), owner); }
	catch (error) {
		if (mode === publicationMode) {
			try { if (incompletePublication(destination)) retireIncompleteSlot(destination); }
			catch { /* Preserve the original write error and its recovery evidence. */ }
		}
		throw error;
	}
	return true;
}

function createSlot(poolDir: string, owner: ActiveAsyncCapacityOwnerV1): boolean {
	const destination = slotDir(poolDir, owner.slot);
	fs.mkdirSync(poolDir, { recursive: true, mode: 0o700 });
	if (!localCreator) return publishSlot(destination, owner, 0o700);
	const publisher = withPublicationClaim(destination, () => {
		if (fs.lstatSync(destination, { throwIfNoEntry: false }) && !recoverIncompletePublication(destination)) return false;
		// Legacy writers use mkdir(0700). Its EEXIST exclusion still applies to
		// both versions, and the sticky bit identifies a new incomplete slot.
		writeCapacityOwner(publicationPath(destination, ".json"), localCreator);
		return publishSlot(destination, owner, publicationMode);
	});
	return publisher.acquired && publisher.value;
}

function handleFor(owner: ActiveAsyncCapacityOwnerV1, limit: number, options: CapacityOptions, rollbackOwner?: ActiveAsyncCapacityOwnerV1): ActiveAsyncCapacityHandle {
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const writeOwner = options.writeOwner ?? writeCapacityOwner;
	const dir = slotDir(sessionDir(owner.ownerSessionId, rootDir), owner.slot);
	const markWorkflow = (dispatchPending: boolean): void => {
		const claimed = withSlotClaim(dir, () => {
			const current = matchingOwner(dir, owner);
			if (!current || current.kind !== "workflow") return false;
			if (current.runnerStartedAt !== undefined) {
				if (dispatchPending && !current.workflowDispatchPending) return false;
				if (dispatchPending === Boolean(current.workflowDispatchPending)) return true;
			}
			const next = { ...current, runnerStartedAt: current.runnerStartedAt ?? options.now?.() ?? Date.now() };
			if (dispatchPending) next.workflowDispatchPending = true;
			else delete next.workflowDispatchPending;
			writeOwner(path.join(dir, "owner.json"), next);
			Object.assign(owner, next);
			if (!dispatchPending) delete owner.workflowDispatchPending;
			return true;
		});
		if (!claimed.acquired || !claimed.value) throw new Error(`Active async capacity ownership changed for workflow '${owner.runId}'.`);
	};
	return {
		owner,
		markStarted(runnerProcessInstanceId) {
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current) return false;
				const next = { ...current, runnerProcessInstanceId, runnerStartedAt: options.now?.() ?? Date.now() };
				delete next.transferPredecessor;
				// Mark memory first so pre-proceed cleanup can distinguish a failed durable
				// bind from an unrelated unstarted reservation.
				Object.assign(owner, next);
				writeOwner(path.join(dir, "owner.json"), next);
				delete owner.transferPredecessor;
				return true;
			});
			if (!claimed.acquired || !claimed.value) throw new Error(`Active async capacity ownership changed for run '${owner.runId}'.`);
		},
		markWorkflowPrepared: () => markWorkflow(true),
		markWorkflowStarted: () => markWorkflow(false),
		rollback() {
			if (!rollbackOwner) return removeOwnedSlot(dir, owner, options, true);
			if (owner.runnerProcessInstanceId || owner.runnerStartedAt) return false;
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current || current.runnerProcessInstanceId || current.runnerStartedAt) return false;
				restorePredecessor(dir, current, rollbackOwner);
				return true;
			});
			return claimed.acquired && claimed.value;
		},
		rollbackBeforeRunnerProceed(runnerProcessInstanceId) {
			const claimed = withSlotClaim(dir, () => {
				const current = matchingOwner(dir, owner);
				if (!current) return false;
				const boundToRunner = current.runnerProcessInstanceId === runnerProcessInstanceId;
				const bindingFailedBeforeProceed = current.runnerProcessInstanceId === undefined && current.runnerStartedAt === undefined && owner.runnerProcessInstanceId === runnerProcessInstanceId;
				if (!boundToRunner && !bindingFailedBeforeProceed) return false;
				if (rollbackOwner) {
					restorePredecessor(dir, current, rollbackOwner);
					return true;
				}
				const releasedDir = path.join(path.dirname(dir), `.${path.basename(dir)}.released-${randomUUID()}`);
				fs.renameSync(dir, releasedDir);
				options.afterSlotRename?.(releasedDir);
				fs.rmSync(releasedDir, { recursive: true, force: true });
				return true;
			});
			return claimed.acquired && claimed.value;
		},
		reconcile(liveWorkflowRunIds) {
			return reconcileActiveAsyncCapacity(owner.ownerSessionId, limit, { ...options, rootDir, liveWorkflowRunIds });
		},
	};
}

export function acquireActiveAsyncCapacity(
	input: { sessionId: string; limit: number | undefined; runId: string; kind: "runner" | "workflow"; asyncDir: string },
	options: CapacityOptions & { liveWorkflowRunIds?: ReadonlySet<string> } = {},
): ActiveAsyncCapacityHandle | undefined {
	if (input.limit === undefined) return undefined;
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const reconciled = reconcileActiveAsyncCapacity(input.sessionId, input.limit, options);
	if (reconciled.used >= input.limit) throw new ActiveAsyncCapacityError(reconciled);
	const poolDir = sessionDir(input.sessionId, rootDir);
	const token = options.token?.() ?? randomUUID();
	for (let slot = 0; slot < input.limit; slot++) {
		const owner: ActiveAsyncCapacityOwnerV1 = {
			version: 1,
			reservationToken: token,
			ownerSessionId: input.sessionId,
			ownerSessionKey: activeAsyncCapacitySessionKey(input.sessionId),
			slot,
			runId: input.runId,
			generation: 0,
			kind: input.kind,
			asyncDir: input.asyncDir,
			reservedAt: options.now?.() ?? Date.now(),
			...(localCreator ? { creator: localCreator } : {}),
		};
		if (createSlot(poolDir, owner)) return handleFor(owner, input.limit, { ...options, rootDir });
	}
	throw new ActiveAsyncCapacityError(snapshotFor(input.sessionId, input.limit, rootDir));
}

export function transferActiveAsyncCapacity(
	input: { sessionId: string; limit: number | undefined; sourceRunId: string; runId: string; asyncDir: string },
	options: CapacityOptions = {},
): ActiveAsyncCapacityHandle | undefined {
	const limit = input.limit ?? 0;
	const rootDir = options.rootDir ?? ACTIVE_ASYNC_CAPACITY_DIR;
	const poolDir = sessionDir(input.sessionId, rootDir);
	for (const dir of occupiedSlots(poolDir)) {
		let source = readOwner(dir);
		if (source?.ownerSessionId === input.sessionId && source.sourceRunId === input.sourceRunId) {
			if (recoverAbandonedTransfer(dir, source, options)) source = readOwner(dir);
		}
		if (!source || source.ownerSessionId !== input.sessionId || source.runId !== input.sourceRunId) continue;
		const expected = source;
		const claimed = withSlotClaim(dir, () => {
			const current = matchingOwner(dir, expected);
			const status = readStatus(expected.asyncDir);
			if (!current || current.transferPredecessor || !status || status.runId !== input.sourceRunId ||
				(status.sessionId !== undefined && status.sessionId !== input.sessionId) || status.state === "queued" || status.state === "running") {
				throw new Error(`Active async capacity source '${input.sourceRunId}' is not transferable.`);
			}
			const next: ActiveAsyncCapacityOwnerV1 = {
				...current,
				runId: input.runId,
				sourceRunId: input.sourceRunId,
				generation: current.generation + 1,
				kind: "runner",
				asyncDir: input.asyncDir,
				reservedAt: options.now?.() ?? Date.now(),
				transferPredecessor: current,
			};
			delete next.creator;
			if (localCreator) next.creator = localCreator;
			delete next.runnerProcessInstanceId;
			delete next.runnerStartedAt;
			writeCapacityOwner(path.join(dir, "owner.json"), next);
			return handleFor(next, limit, { ...options, rootDir }, current);
		});
		if (!claimed.acquired) throw new Error(`Active async capacity transfer is already in progress for run '${input.sourceRunId}'.`);
		return claimed.value;
	}
	return acquireActiveAsyncCapacity({ sessionId: input.sessionId, limit: input.limit, runId: input.runId, kind: "runner", asyncDir: input.asyncDir }, options);
}
