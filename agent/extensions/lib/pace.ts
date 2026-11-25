/**
 * The pace note: what a session spent waiting on subagents, once that waiting
 * is both long and large enough to be worth a different plan.
 *
 * Session facts sees the events needed to measure it: a person's prompt opens
 * a window (the `input` event), the end of a run starts the clock (`agent_end`),
 * and the next run the person did not type (a subagent result waking the
 * agent) counts the wait. Waiting the person did themselves is not counted:
 * their prompt clears the stop mark, and a prompt with no subagent out
 * restarts the window. A main-model tool call or turn end is work, so it
 * clears the mark without counting either.
 *
 * The note is due only when all of these hold for the current window: it is at
 * least 40 minutes long, at least 40% of it was spent waiting, at least two of
 * the subagents were launched inside it, fewer than three ran at a time on
 * average, and no note was given in the last 30 minutes. `PI_PACE=0` turns it
 * off.
 */

/** True unless the person switched the note off. */
export const paceOn = (): boolean => process.env.PI_PACE !== "0";

/** A subagent's measured span: `end` is absent while it still runs. */
export interface PaceSubagent {
	start: number;
	end?: number;
}

interface Window {
	start: number;
	waitedMs: number;
	/** when the main model's run ended and the session has been waiting since */
	stopAt?: number;
	/** when this note was last given */
	saidAt?: number;
}

const MIN_WALL_MS = 40 * 60_000;
const MIN_SHARE = 0.4;
const MIN_SUBAGENTS = 2;
const MAX_AVERAGE = 3;
const QUIET_MS = 30 * 60_000;
const MAX_SESSIONS = 256;

/** Minutes and hours as people read them: `50m`, `1h20m`. */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** How many subagents ran at a time over [start, now], on average: each span's overlap with the window, summed, over its length. */
export function averageOut(subagents: readonly PaceSubagent[], start: number, now: number): number {
	const wall = now - start;
	if (!(wall > 0)) return 0;
	let out = 0;
	for (const span of subagents) {
		const from = Math.max(span.start, start);
		const to = Math.min(span.end ?? now, now);
		if (to > from) out += to - from;
	}
	return out / wall;
}

/** The note, with D the window's length, P its waiting share in whole percent and A the average subagents out. */
export function paceNote(wallMs: number, percent: number, average: number): string {
	return `Pace: ${formatDuration(wallMs)} on this demand, ${percent}% of it spent waiting on subagents with ${average.toFixed(1)} out at a time. Before you wait again: launch every open piece that does not need a running subagent's result, in one call (a tasks list runs them side by side); a piece queued behind a file is built in a new file of its own and joined later; commit what is verified. Then tell the user in one line what is left and how long it will take. If nothing is queued, carry on.`;
}

export class Pace {
	private readonly sessions = new Map<string, Window>();
	private readonly now: () => number;

	constructor(opts: { now?: () => number } = {}) {
		this.now = opts.now ?? Date.now;
	}

	/** A prompt the person typed. With no subagent out it opens a fresh window; with one out the window goes on. */
	human(session: string, subagentsOut: boolean): void {
		if (!paceOn() || !session) return;
		const now = this.now();
		const window = this.window(session, now);
		if (!subagentsOut) {
			window.start = now;
			window.waitedMs = 0;
			window.saidAt = undefined;
		}
		window.stopAt = undefined;
	}

	/** The main model's run ended: waiting starts here. */
	stopped(session: string): void {
		if (!paceOn() || !session) return;
		this.window(session, this.now()).stopAt = this.now();
	}

	/** The main model is working again (a tool call, a turn end): the wait ends without counting. */
	working(session: string): void {
		if (!paceOn() || !session) return;
		const window = this.sessions.get(session);
		if (window) window.stopAt = undefined;
	}

	/** A run that is not the person's (a subagent result waking the agent): count the wait, then return the note if one is due. */
	machine(session: string, subagents: readonly PaceSubagent[]): string {
		if (!paceOn() || !session) return "";
		const now = this.now();
		const window = this.window(session, now);
		if (window.stopAt !== undefined) {
			window.waitedMs += Math.max(0, now - window.stopAt);
			window.stopAt = undefined;
		}
		const wall = now - window.start;
		if (wall < MIN_WALL_MS) return "";
		if (window.waitedMs / wall < MIN_SHARE) return "";
		if (subagents.filter((span) => span.start >= window.start).length < MIN_SUBAGENTS) return "";
		const average = averageOut(subagents, window.start, now);
		if (average >= MAX_AVERAGE) return "";
		if (window.saidAt !== undefined && now - window.saidAt < QUIET_MS) return "";
		window.saidAt = now;
		return paceNote(wall, Math.round((window.waitedMs / wall) * 100), average);
	}

	/** Forget a session. */
	end(session: string): void {
		this.sessions.delete(session);
	}

	private window(session: string, now: number): Window {
		let window = this.sessions.get(session);
		if (!window) {
			window = { start: now, waitedMs: 0 };
			this.sessions.set(session, window);
			while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
		}
		return window;
	}
}
