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
import { writeAtomicJson } from "../../shared/atomic-json.ts";

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
	// Same-epoch ordering: an explicitly older revision loses even when both
	// payloads are non-terminal (interleaved coalesced flushes).
	if (!currentTerminal && !nextTerminal && nextRevision > 0 && currentRevision > nextRevision) {
		return { action: "skip", revision: currentRevision, reason: "stale-revision" };
	}
	return { action: "write", revision: Math.max(currentRevision, nextRevision) + 1 };
}

export interface GuardedStatusWriteResult {
	written: boolean;
	revision: number;
	reason?: "stale-terminal" | "stale-revision" | "unreadable-current";
}

/**
 * Read-modify-decide-write for status.json. Unknown/absent current state is not
 * a reason to refuse: the guard only protects against a *known newer* state.
 */
export function writeGuardedStatus(statusPath: string, next: RevisionedStatus): GuardedStatusWriteResult {
	let current: RevisionedStatus | undefined;
	let unreadable = false;
	try {
		const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as RevisionedStatus;
		else unreadable = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
	}
	const decision = decideStatusWrite(current, next);
	if (decision.action === "skip") return { written: false, revision: decision.revision, reason: decision.reason };
	writeAtomicJson(statusPath, { ...next, revision: decision.revision });
	return { written: true, revision: decision.revision, ...(unreadable ? { reason: "unreadable-current" } : {}) };
}

/** Bump a payload's revision for the next guarded write (caller keeps ordering). */
export function withStatusRevision<T extends RevisionedStatus>(status: T, revision: number): T {
	return { ...status, revision };
}
