import type { TaskDetails } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.ts";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is Pick<TaskDetails, "tasks" | "nextId"> {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.tasks) || !Number.isSafeInteger(v.nextId) || (v.nextId as number) < 1) return false;
	const ids = new Set<number>();
	for (const item of v.tasks) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const t = item as Record<string, unknown>;
		if (!Number.isSafeInteger(t.id) || (t.id as number) < 1 || (t.id as number) >= (v.nextId as number) || ids.has(t.id as number)
			|| typeof t.subject !== "string" || !["pending", "in_progress", "completed", "deleted"].includes(t.status as string)) return false;
		if (["description", "activeForm", "owner"].some(key => t[key] !== undefined && typeof t[key] !== "string")) return false;
		if (t.blockedBy !== undefined && (!Array.isArray(t.blockedBy) || !t.blockedBy.every(id => Number.isSafeInteger(id) && id > 0))) return false;
		if (t.metadata !== undefined && (!t.metadata || typeof t.metadata !== "object" || Array.isArray(t.metadata))) return false;
		ids.add(t.id as number);
	}
	return true;
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). When no matching entry exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: {
	sessionManager: { getBranch(): Iterable<unknown> };
}): TaskState {
	const empty: TaskState = {
		tasks: [...EMPTY_STATE.tasks],
		nextId: EMPTY_STATE.nextId,
	};
	const branch = ctx.sessionManager.getBranch();
	const entries = Array.isArray(branch) ? branch : [...branch];
	// Latest valid snapshot wins. Do not validate/clone every obsolete snapshot
	// in a long session, and never partially resurrect a malformed task list.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const e = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		try {
			return { tasks: structuredClone(msg.details.tasks), nextId: msg.details.nextId };
		} catch { /* Non-persistable legacy metadata: retain the previous valid snapshot. */ }
	}
	return empty;
}
