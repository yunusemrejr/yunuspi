/**
 * Shared reminders-state contract — single owner of the
 * ~/.pi/reminders/state-<sid>.json schema and filename.
 *
 * WHY: checkpoints.ts used to hand-parse this file with a duplicated,
 * untyped shape and silently swallow parse failures (schema drift would
 * degrade post-compaction restore invisibly). The schema now lives here;
 * reminders.ts writes it, checkpoints.ts reads its restore slice through
 * readRemindersRestore(). Harness contract fix 2026-09-01.
 *
 * 2026-09-02: the governor broker was removed — reminders are injected
 * directly, so the old `custom`/`customBlocked`/`lastShownCtx`/`shown`
 * context-growth fields are gone. Manual reminders are now scheduled on an
 * exact, independent per-reminder cadence: after the command's immediate
 * delivery, `nextFireAt = createdAt + 5min`, then `previous nextFireAt + 5min`
 * thereafter (grid anchored at createdAt, never `now + 5min`).
 *
 * 2026-09-14: cadence widened 2min -> 5min (user feedback: the 2-minute grid
 * repeated too often). The immediate first delivery is unchanged and is still
 * structurally deduped: nextFireAt is anchored at createdAt + 5min, so the
 * first repeat cannot fire until that grid point.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const REMINDERS_STATE_DIR = path.join(os.homedir(), ".pi", "reminders");

/** Fixed manual-reminder cadence. First fire at createdAt + this, then every
 * this on the same anchored grid (whole-interval advancement only). */
export const MANUAL_INTERVAL_MS = 5 * 60_000;

/** A /reminder-registered line with an exact independent schedule. */
export interface ManualReminder {
	id: string; // stable unique id (random UUID)
	text: string;
	createdAt: number; // wall-clock ms the reminder was registered
	nextFireAt: number; // wall-clock ms of the NEXT scheduled occurrence
	active: boolean; // false = completed/cleared (retained, never fires)
	delivered: number; // delivery count (0 = full text next, >0 = digest refresher)
}

export interface ReminderState {
	startedAt: number;
	promptCount: number;
	lastTodoActionAt: number;
	hasPending: boolean;
	pendingCount: number;
	inProgressCount: number;
	todoReminders: number;
	lastTodoRemindAt: number;
	driftReminders: number;
	lastRemindAt: number;
	overthinkReminders: number;
	lastOverthinkAt: number; // independent of manual/todo/drift delivery clocks
	cautionReminders: number; // mutating-action caution reminder: per-session count
	lastCautionAt: number; // last caution fire (its own independent gap clock)
	mutPending: boolean; // armed by a completed mutating action, cleared on fire
	lastMutAt: number; // wall-clock ms of the most recent mutating action
	runMutCount: number; // mutating tool calls in the current/most-recent run
	manual: ManualReminder[];
	shownCtx: string[]; // contextual rule tags already injected (once per session each)
}

export function remindersStateFile(sid: string): string {
	return path.join(
		REMINDERS_STATE_DIR,
		`state-${sid.replace(/[^A-Za-z0-9_-]/g, "-")}.json`,
	);
}

export function defaultRemindersState(): ReminderState {
	return {
		startedAt: Date.now(),
		promptCount: 0,
		lastTodoActionAt: 0,
		hasPending: false,
		pendingCount: 0,
		inProgressCount: 0,
		todoReminders: 0,
		lastTodoRemindAt: 0,
		driftReminders: 0,
		lastRemindAt: 0,
		overthinkReminders: 0,
		lastOverthinkAt: 0,
		cautionReminders: 0,
		lastCautionAt: 0,
		mutPending: false,
		lastMutAt: 0,
		runMutCount: 0,
		manual: [],
		shownCtx: [],
	};
}

function readValidatedRemindersState(sidOrEmpty: string): ReminderState {
	const raw: unknown = JSON.parse(
		fs.readFileSync(remindersStateFile(sidOrEmpty), "utf8"),
	);
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid reminder state record");
	// Rebuild strictly over the declared schema: unknown/legacy fields (e.g.
	// the retired prompt-offload `briefing`) are dropped, so state files
	// converge to the schema this lib owns instead of accumulating drift.
	const st = defaultRemindersState();
	// SAFETY: ReminderState is a flat JSON-safe record; the dynamic copy only
	// pulls keys that exist in the schema's own defaults, and array/record
	// fields are re-validated below — TypeScript cannot express the
	// key-by-key copy without this widening.
	const rec = st as unknown as Record<string, unknown>;
	const src = raw as Record<string, unknown> | null;
	if (src) {
		for (const key of Object.keys(st)) {
			const value = src[key];
			if (typeof value !== typeof rec[key]) continue;
			if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) continue;
			rec[key] = value;
		}
	}
	// Defensive: a hand-edited or legacy-corrupted state file must not break
	// the next check-in. Atomic tmp+rename already prevents partial writes.
	if (!Array.isArray(st.manual)) st.manual = [];
	if (!Array.isArray(st.shownCtx)) st.shownCtx = [];
	// Drop any record the scheduler cannot trust: a non-finite nextFireAt
	// would compare false against every `now` and the reminder would
	// silently never fire; a non-number createdAt/nextFireAt would corrupt
	// grid arithmetic.
	st.manual = st.manual.filter(
		(r) =>
			r &&
			typeof r.id === "string" &&
			typeof r.text === "string" &&
			Number.isFinite(r.createdAt) &&
			Number.isFinite(r.nextFireAt),
	);
	// Coerce the fields the scheduler mutates: a missing/non-number
	// `delivered` would NaN on advance, a non-boolean `active` would fire
	// from truthy garbage.
	for (const r of st.manual) {
		r.active = r.active === true;
		r.delivered =
			typeof r.delivered === "number" && Number.isFinite(r.delivered)
				? r.delivered
				: 0;
	}
	return st;
}

export function readRemindersState(sidOrEmpty: string): ReminderState {
	try {
		return readValidatedRemindersState(sidOrEmpty);
	} catch {
		return defaultRemindersState();
	}
}

export function writeRemindersState(
	sidOrEmpty: string,
	st: ReminderState,
): boolean {
	let tmp: string | undefined;
	try {
		fs.mkdirSync(REMINDERS_STATE_DIR, { recursive: true, mode: 0o700 });
		tmp = `${remindersStateFile(sidOrEmpty)}.${process.pid}.${randomUUID()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(st), { flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, remindersStateFile(sidOrEmpty));
		tmp = undefined;
		return true;
	} catch (error) {
		// Ambient hooks must never break a session, but persistence loss must be
		// observable. Interactive callers also inspect false and roll back.
		console.error(
			"[reminders] state write failed:",
			error instanceof Error ? error.message : String(error),
		);
		return false;
	} finally {
		if (tmp) {
			try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
		}
	}
}

/** The slice checkpoints.ts needs for its canonical post-compaction restore.
 * `ok` distinguishes "no/empty state" from "file unreadable" so the caller
 * can surface degradation instead of failing silently. Returns only ACTIVE
 * manual reminder texts (completed/cleared reminders are excluded). */
export function readRemindersRestore(sid: string): {
	custom: string[];
	pending: number;
	inProgress: number;
	ok: boolean;
} {
	try {
		const raw = readValidatedRemindersState(sid);
		return {
			custom: raw.manual
				.filter((r) => r.active)
				.map((r) => r.text)
				.filter(Boolean),
			pending: raw.pendingCount,
			inProgress: raw.inProgressCount,
			ok: true,
		};
	} catch {
		return { custom: [], pending: 0, inProgress: 0, ok: false };
	}
}
