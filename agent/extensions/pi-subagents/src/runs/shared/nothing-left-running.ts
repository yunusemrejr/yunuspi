/**
 * Nothing left running: the child processes a session starts are recorded, and
 * ended when the session ends or when a later session finds their owner gone.
 *
 * A record names the child by pid and kernel start time (field 22 of
 * /proc/<pid>/stat) and its owner the same way; a signal is sent only when the
 * live process still has the recorded start time, so a recycled pid is never
 * touched. Nothing is ended by name, and never this process. `PI_REAP=0` ends
 * no process; records are still cleaned.
 *
 * Moment 1 (the run ends with workers out) is the note built by
 * `stillRunningNote`; moment 2 is `endOwnChildren`; moment 3 is `endOrphans`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { readProcessState } from "../../shared/process-start-identity.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

export const REAP_RECORDS_DIR = path.join(TEMP_ROOT_DIR, "reap-records");

const TERM_GRACE_MS = 3_000;
const KILL_WAIT_MS = 500;
const POLL_MS = 25;
const MAX_LOG_BYTES = 128 * 1024;

/** True unless the person switched the ending of processes off. */
export const reapOn = (): boolean => process.env.PI_REAP !== "0";

export type ChildKind = "foreground" | "runner";
export type EndReason = "session-end" | "owner-gone";

export interface ChildRecord {
	version: 1;
	kind: ChildKind;
	pid: number;
	startIdentity: string;
	/** True when the child leads a process group of its own, so the whole group is signalled. */
	group: boolean;
	ownerPid: number;
	ownerStartIdentity: string;
	startedAtMs: number;
}

export interface ReapOptions {
	dir?: string;
	/** The session process; defaults to this one. */
	owner?: { pid: number; startIdentity: string };
	now?: () => number;
	termGraceMs?: number;
}

const writeRecord = createAtomicJsonWriter({ mode: 0o600, ignoreCleanupErrorAfterSuccess: true });

function self(options: ReapOptions): { pid: number; startIdentity: string } | undefined {
	if (options.owner) return options.owner;
	const startIdentity = readProcessState(process.pid)?.startIdentity;
	return startIdentity ? { pid: process.pid, startIdentity } : undefined;
}

const recordPath = (dir: string, owner: number, pid: number): string => path.join(dir, `${owner}-${pid}.json`);

/**
 * Record a child this process just started. Returns a function that removes the
 * record when the child has exited. Without a readable start time (not Linux)
 * nothing is recorded: such a child could never be matched safely.
 */
export function recordChild(child: { kind: ChildKind; pid: number; group: boolean }, options: ReapOptions = {}): () => void {
	const none = () => {};
	try {
		const owner = self(options);
		const startIdentity = readProcessState(child.pid)?.startIdentity;
		if (!owner || !startIdentity) return none;
		const dir = options.dir ?? REAP_RECORDS_DIR;
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const record: ChildRecord = {
			version: 1,
			kind: child.kind,
			pid: child.pid,
			startIdentity,
			group: child.group,
			ownerPid: owner.pid,
			ownerStartIdentity: owner.startIdentity,
			startedAtMs: (options.now ?? Date.now)(),
		};
		const file = recordPath(dir, owner.pid, child.pid);
		writeRecord(file, record);
		return () => removeFile(file);
	} catch {
		return none;
	}
}

function removeFile(file: string): void {
	try { fs.rmSync(file, { force: true }); } catch { /* a record that cannot be removed is found stale next time */ }
}

function readRecords(dir: string): Array<{ file: string; record: ChildRecord }> {
	let names: string[];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const found: Array<{ file: string; record: ChildRecord }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf-8")) as ChildRecord;
			const valid = record?.version === 1 && (record.kind === "foreground" || record.kind === "runner")
				&& Number.isSafeInteger(record.pid) && record.pid > 0 && Number.isSafeInteger(record.ownerPid) && record.ownerPid > 0
				&& typeof record.startIdentity === "string" && typeof record.ownerStartIdentity === "string"
				&& typeof record.group === "boolean" && Number.isFinite(record.startedAtMs);
			if (valid) found.push({ file, record });
			else removeFile(file);
		} catch {
			removeFile(file);
		}
	}
	return found;
}

/** True while the recorded process is still the one that was started and has not exited. */
function stillThere(pid: number, startIdentity: string): boolean {
	const state = readProcessState(pid);
	return state !== undefined && state.startIdentity === startIdentity && state.state !== "Z" && state.state !== "X";
}

function signal(record: ChildRecord, name: NodeJS.Signals): void {
	try {
		process.kill(record.group ? -record.pid : record.pid, name);
	} catch { /* already gone, or not ours to signal */ }
}

/** After the first signal the group counts as running while any member is left: its id cannot be reused while it is in use. */
function groupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The process group of this process (field 5 of /proc/self/stat); undefined when unreadable. */
function ownGroupId(): number | undefined {
	try {
		const stat = fs.readFileSync("/proc/self/stat", "utf-8");
		const group = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[2]);
		return Number.isSafeInteger(group) ? group : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A recorded child that leads a group of its own still counts while any member
 * of that group runs, even after the leader exited: a group id cannot be handed
 * out again while a member holds it, so the group is the one the harness made.
 * Not when the leader's pid now belongs to another process (different start
 * time), and never this process's own group.
 */
function groupOutlivesLeader(record: ChildRecord): boolean {
	if (!record.group || record.pid === process.pid || record.pid === ownGroupId()) return false;
	const leader = readProcessState(record.pid);
	if (leader && leader.startIdentity !== record.startIdentity) return false;
	return groupExists(record.pid);
}

/** True while the recorded child, or the group it led, can still be ended. */
function endable(record: ChildRecord): boolean {
	return stillThere(record.pid, record.startIdentity) || groupOutlivesLeader(record);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilGone(records: readonly ChildRecord[], ms: number): Promise<ChildRecord[]> {
	const deadline = Date.now() + ms;
	let alive = records.filter(endable);
	while (alive.length > 0 && Date.now() < deadline) {
		await pause(POLL_MS);
		alive = alive.filter(endable);
	}
	return alive;
}

function logEnding(record: ChildRecord, reason: EndReason, outcome: "term" | "kill", now: number, dir: string): void {
	// Kind, pid, age and reason only: no command text, no brief text.
	try {
		const file = path.join(dir, "ended.log");
		if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0);
		fs.appendFileSync(file, `${new Date(now).toISOString()} ${record.kind} pid=${record.pid} age=${Math.max(0, Math.round((now - record.startedAtMs) / 1000))}s why=${reason} result=${outcome}\n`, { mode: 0o600 });
	} catch { /* a log that cannot be written changes nothing about the ending */ }
}

/**
 * End the given records: TERM (to the group where the child leads one), wait up
 * to 3 seconds for all of them together, then KILL what is left. Records are
 * removed at the end whatever happened; with PI_REAP=0 no signal is sent.
 */
async function endRecords(entries: Array<{ file: string; record: ChildRecord }>, reason: EndReason, options: ReapOptions): Promise<number> {
	const dir = options.dir ?? REAP_RECORDS_DIR;
	const now = options.now ?? Date.now;
	const targets = entries.filter(({ record }) => reapOn() && record.pid !== process.pid && endable(record));
	for (const { record } of targets) signal(record, "SIGTERM");
	const survivors = await waitUntilGone(targets.map(({ record }) => record), options.termGraceMs ?? TERM_GRACE_MS);
	for (const record of survivors) signal(record, "SIGKILL");
	const unkilled = await waitUntilGone(survivors, KILL_WAIT_MS);
	for (const { record } of targets) logEnding(record, reason, survivors.includes(record) ? "kill" : "term", now(), dir);
	// A child that would not die keeps its record so a later sweep tries again.
	const keep = new Set(unkilled);
	for (const { file, record } of entries) if (!keep.has(record)) removeFile(file);
	return targets.length;
}

/** Moment 2: end every child this process recorded. At most about 4 seconds; never throws. */
export async function endOwnChildren(reason: EndReason = "session-end", options: ReapOptions = {}): Promise<number> {
	try {
		const owner = self(options);
		if (!owner) return 0;
		const mine = readRecords(options.dir ?? REAP_RECORDS_DIR).filter(({ record }) => record.ownerPid === owner.pid && record.ownerStartIdentity === owner.startIdentity);
		return await endRecords(mine, reason, options);
	} catch {
		return 0;
	}
}

/** Moment 3: end the children of sessions that are gone and drop records of processes that no longer exist. Never throws. */
export async function endOrphans(options: ReapOptions = {}): Promise<number> {
	try {
		const owner = self(options);
		const orphans = readRecords(options.dir ?? REAP_RECORDS_DIR).filter(({ record }) => {
			if (owner && record.ownerPid === owner.pid && record.ownerStartIdentity === owner.startIdentity) return false;
			if (!stillThere(record.pid, record.startIdentity)) return true;
			return !stillThere(record.ownerPid, record.ownerStartIdentity);
		});
		return await endRecords(orphans, "owner-gone", options);
	} catch {
		return 0;
	}
}

/** Moment 2 when the process is already leaving and cannot wait: TERM only, records stay for the next sweep. */
export function signalOwnChildrenAtExit(options: ReapOptions = {}): void {
	try {
		const owner = self(options);
		if (!owner || !reapOn()) return;
		for (const { record } of readRecords(options.dir ?? REAP_RECORDS_DIR)) {
			if (record.ownerPid === owner.pid && record.ownerStartIdentity === owner.startIdentity && record.pid !== process.pid && endable(record)) signal(record, "SIGTERM");
		}
	} catch { /* leaving must never hang or throw */ }
}

export interface RunningJob {
	name: string;
	startedAt: number;
}

/** Moment 1: the one note for a stop with workers still out, in the harness-wide wording. */
export function stillRunningNote(jobs: readonly RunningJob[], now: number): string {
	const list = jobs.map((job) => `${job.name} (${Math.max(0, Math.round((now - job.startedAt) / 60_000))} min)`).join("; ");
	return `Still running: ${list}. The work is not done while a worker is out: read its report when it lands, or stop it now if its result is no longer needed.`;
}

export const STILL_RUNNING_TYPE = "subagents-still-running";

export interface NotedJob extends RunningJob {
	asyncId: string;
}

/**
 * The still-running note is read in a later turn, when the worker it names may
 * have finished. Applied to each message of a request: other messages pass
 * unchanged; the note is cut down to the workers still out (named in its
 * `details.jobs`), and is dropped (undefined) when none is.
 */
export function keepStillRunningNote<T extends object>(message: T, isOut: (asyncId: string) => boolean): T | undefined {
	const note = message as { role?: string; customType?: string; timestamp?: number; details?: { jobs?: NotedJob[] } };
	if (note.role !== "custom" || note.customType !== STILL_RUNNING_TYPE) return message;
	const named = note.details?.jobs ?? [];
	const running = named.filter((job) => isOut(job.asyncId));
	if (running.length === named.length && named.length > 0) return message;
	if (running.length === 0) return undefined;
	return { ...message, content: stillRunningNote(running, note.timestamp ?? Date.now()), details: { jobs: running } };
}
