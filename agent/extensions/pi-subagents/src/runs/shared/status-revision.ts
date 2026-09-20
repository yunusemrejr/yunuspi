/**
 * Monotonic status guard.
 *
 * Three independent writers touch a run's `status.json`: the runner (full
 * replace, coalesced), the stale-run reconciler (repair after the runner died)
 * and the process-terminal overlay (read-modify-write when the proof sidecar
 * lands). `writeAtomicJson` makes each write crash-safe, but nothing ordered
 * them: a slow writer could land after a newer one and regress the run — a
 * repaired terminal status back to `running`, or a final state back to
 * `processTerminal: pending`.
 *
 * This module gives status.json a revision and refuses stale writes:
 *   - a non-terminal payload never overwrites a terminal one;
 *   - between two terminal payloads the newer `lastUpdate`/`endedAt` wins;
 *   - every accepted write bumps `revision` so readers and later writers can
 *     detect that they lost a race instead of silently clobbering it.
 *
 * Guarded writers are not required to win: `skip` is a legitimate outcome and
 * the caller keeps its own authoritative copy (result file, proof sidecar).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { waitForFileSystemRetry } from "../../shared/file-system-retry.ts";

const STATUS_LOCK_STALE_MS = 30_000;
const STATUS_LOCK_WAIT_MS = 10_000;
const STATUS_LOCK_POLL_MS = 10;

function reclaimStaleStatusLock(lockDir: string): boolean {
	const entries = fs.readdirSync(lockDir);
	if (entries.length === 0) {
		try {
			fs.rmdirSync(lockDir);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return true;
			if (code === "ENOTEMPTY" || code === "EEXIST") return false;
			throw error;
		}
	}
	if (entries.length !== 1 || !entries[0]!.startsWith("owner-")) return false;
	const ownerPath = path.join(lockDir, entries[0]!);
	const claimPath = `${lockDir}.reclaim-${process.pid}-${randomUUID()}`;
	try {
		fs.renameSync(ownerPath, claimPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	let removed = false;
	try {
		fs.rmdirSync(lockDir);
		removed = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true;
	}
	if (removed) {
		try { fs.unlinkSync(claimPath); } catch { /* best-effort tombstone cleanup */ }
		return true;
	}
	try { fs.renameSync(claimPath, ownerPath); } catch { /* leave uncertain ownership for timeout */ }
	return false;
}

/** Status fields the guard reasons about. Deliberately structural, not typed. */
export interface RevisionedStatus {
	state?: string;
	revision?: number;
	lastUpdate?: number;
	endedAt?: number;
	[key: string]: unknown;
}

/** States that mean the run has ended. Mirrors the fork's terminal vocabulary. */
const TERMINAL_STATES = new Set(["complete", "completed", "failed", "partial", "paused", "stopped", "rejected"]);

export function isTerminalStatusState(state: unknown): boolean {
	return typeof state === "string" && TERMINAL_STATES.has(state);
}

function recency(status: RevisionedStatus | undefined): number {
	if (!status) return 0;
	const endedAt = typeof status.endedAt === "number" && Number.isFinite(status.endedAt) ? status.endedAt : 0;
	const lastUpdate = typeof status.lastUpdate === "number" && Number.isFinite(status.lastUpdate) ? status.lastUpdate : 0;
	return Math.max(endedAt, lastUpdate);
}

export type StatusWriteDecision =
	| { action: "write"; revision: number }
	| { action: "skip"; revision: number; reason: "stale-terminal" | "stale-revision" };

/**
 * Decide whether `next` may replace `current`. Returns the revision to write.
 * Pure: callers can unit-test every race without touching a filesystem.
 */
export function decideStatusWrite(current: RevisionedStatus | undefined, next: RevisionedStatus): StatusWriteDecision {
	const currentRevision = typeof current?.revision === "number" && Number.isFinite(current.revision) ? current.revision : 0;
	const nextRevision = typeof next.revision === "number" && Number.isFinite(next.revision) ? next.revision : 0;
	const currentTerminal = current ? isTerminalStatusState(current.state) : false;
	const nextTerminal = isTerminalStatusState(next.state);

	// A run that already ended must not be dragged back to running by a late
	// writer (coalesced flush, overlay, or a parent's initial status write).
	if (currentTerminal && !nextTerminal) {
		return { action: "skip", revision: currentRevision, reason: "stale-terminal" };
	}
	// Between two terminal payloads the newer observation wins — this is what
	// lets the reconciler's repair survive the runner's final write when the
	// repair carries later evidence, and vice versa.
	if (currentTerminal && nextTerminal && recency(next) < recency(current)) {
		return { action: "skip", revision: currentRevision, reason: "stale-terminal" };
	}
	if (currentTerminal && nextTerminal && recency(next) === recency(current) && currentRevision > nextRevision) {
		return { action: "skip", revision: currentRevision, reason: "stale-revision" };
	}
	// Same-epoch ordering: an explicitly older revision loses even when both
	// payloads are non-terminal (interleaved coalesced flushes).
	if (!currentTerminal && !nextTerminal && currentRevision > nextRevision) {
		return { action: "skip", revision: currentRevision, reason: "stale-revision" };
	}
	return { action: "write", revision: Math.max(currentRevision, nextRevision) + 1 };
}

export interface GuardedStatusWriteResult {
	written: boolean;
	revision: number;
	reason?: "stale-terminal" | "stale-revision" | "unreadable-current";
}

function withStatusWriteLock<T>(statusPath: string, operation: () => T): T {
	const lockDir = `${statusPath}.write-lock`;
	fs.mkdirSync(path.dirname(statusPath), { recursive: true });
	const deadline = Date.now() + STATUS_LOCK_WAIT_MS;
	let ownerTokenPath: string | undefined;
	for (;;) {
		try {
			fs.mkdirSync(lockDir, { mode: 0o700 });
			const candidateTokenPath = path.join(lockDir, `owner-${process.pid}-${randomUUID()}`);
			try {
				fs.writeFileSync(candidateTokenPath, "", { flag: "wx", mode: 0o600 });
			} catch (error) {
				// Non-recursive cleanup cannot erase a replacement lock if stale
				// takeover raced token creation.
				try {
					fs.rmdirSync(lockDir);
				} catch {
					/* Leave uncertain ownership for stale recovery. */
				}
				throw error;
			}
			ownerTokenPath = candidateTokenPath;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - fs.statSync(lockDir).mtimeMs > STATUS_LOCK_STALE_MS) {
					if (reclaimStaleStatusLock(lockDir)) continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				if (Date.now() >= deadline) throw new Error(`status write lock timeout: ${lockDir}`, { cause: statError });
				waitForFileSystemRetry(STATUS_LOCK_POLL_MS);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`status write lock timeout: ${lockDir}`);
			waitForFileSystemRetry(STATUS_LOCK_POLL_MS);
		}
	}
	try {
		return operation();
	} finally {
		let removedOwnToken = false;
		try {
			if (ownerTokenPath) fs.unlinkSync(ownerTokenPath);
			removedOwnToken = ownerTokenPath !== undefined;
		} catch {
			// Stale takeover removed our token; never touch the replacement.
		}
		if (removedOwnToken) {
			try {
				fs.rmdirSync(lockDir);
			} catch {
				/* Non-empty or replaced: stale recovery owns cleanup. */
			}
		}
	}
}

function readCurrentStatus(statusPath: string): { current?: RevisionedStatus; unreadable: boolean } {
	try {
		const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { current: parsed as RevisionedStatus, unreadable: false };
		return { unreadable: true };
	} catch (error) {
		return { unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" };
	}
}

function writeGuardedStatusLocked(
	statusPath: string,
	next: RevisionedStatus,
	current: RevisionedStatus | undefined,
	unreadable: boolean,
	write: (filePath: string, payload: object) => void = writeAtomicJson,
): GuardedStatusWriteResult {
	const decision = decideStatusWrite(current, next);
	if (decision.action === "skip") return { written: false, revision: decision.revision, reason: decision.reason };
	write(statusPath, { ...next, revision: decision.revision });
	return { written: true, revision: decision.revision, ...(unreadable ? { reason: "unreadable-current" as const } : {}) };
}

/**
 * Read-modify-decide-write for status.json. Unknown/absent current state is not
 * a reason to refuse: the guard only protects against a *known newer* state.
 */
export function writeGuardedStatus(statusPath: string, next: RevisionedStatus): GuardedStatusWriteResult {
	return withStatusWriteLock(statusPath, () => {
		const { current, unreadable } = readCurrentStatus(statusPath);
		return writeGuardedStatusLocked(statusPath, next, current, unreadable);
	});
}

/** Guarded status replacement whose staged file is owner-only (0600). */
export function writePrivateGuardedStatus(statusPath: string, next: RevisionedStatus): GuardedStatusWriteResult {
	return withStatusWriteLock(statusPath, () => {
		const { current, unreadable } = readCurrentStatus(statusPath);
		return writeGuardedStatusLocked(statusPath, next, current, unreadable, writePrivateAtomicJson);
	});
}

/**
 * Locked read-transform-write for overlays that must preserve fields from the
 * latest status. Returning undefined leaves the file untouched.
 */
export function updateGuardedStatus(
	statusPath: string,
	update: (current: RevisionedStatus) => RevisionedStatus | undefined,
): GuardedStatusWriteResult {
	return withStatusWriteLock(statusPath, () => {
		const { current, unreadable } = readCurrentStatus(statusPath);
		if (!current) return { written: false, revision: 0, ...(unreadable ? { reason: "unreadable-current" as const } : {}) };
		const next = update(current);
		if (!next) return { written: false, revision: current.revision ?? 0 };
		return writeGuardedStatusLocked(statusPath, next, current, unreadable);
	});
}

/** Bump a payload's revision for the next guarded write (caller keeps ordering). */
export function withStatusRevision<T extends RevisionedStatus>(status: T, revision: number): T {
	return { ...status, revision };
}
