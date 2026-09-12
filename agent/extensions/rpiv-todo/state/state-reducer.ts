import type {
	Task,
	TaskAction,
	TaskMutationParams,
	TaskStatus,
} from "../tool/types.js";
import { PLAN_FIELDS, planFieldError, planGraphError, blockers } from "./plan.ts";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "batch"; ids: Record<string, number>; count: number }
	| {
			kind: "update";
			id: number;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			changed: boolean;
	  }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean; view?: "tree" | "frontier" }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameNumberList(
	a: number[] | undefined,
	b: number[] | undefined,
): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined,
): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		PLAN_FIELDS.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])) ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors the
 * `applyTaskMutation` of pre-refactor `todo.ts` minus content/details
 * formatting; the response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer — see Plan §Decisions §Decision 2.
 */
function reduceTaskMutation(
	state: TaskState,
	action: TaskAction,
	params: TaskMutationParams,
): ApplyResult {
	switch (action) {
		case "batch": return errorResult(state, "Nested batches are not supported");
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted")
						return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			for (const key of PLAN_FIELDS) if (params[key] !== undefined) Object.assign(newTask, {[key]: structuredClone(params[key])});

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined)
				return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				PLAN_FIELDS.some(key => params[key] !== undefined) ||
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(
						state,
						`illegal transition ${current.status} → ${params.status}`,
					);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id)
						return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted")
						return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(
						state,
						"addBlockedBy would create a cycle in the blockedBy graph",
					);
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (current.status === "completed" && newStatus !== "completed" || params.acceptance !== undefined && params.acceptance !== current.acceptance) delete updated.evidence;
			for (const key of PLAN_FIELDS) if (params[key] !== undefined) Object.assign(updated, {[key]: structuredClone(params[key])});
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined)
				updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					view: params.view,
					...(params.status === undefined ? {} : { statusFilter: params.status }),
				},
			};
		}

		case "get": {
			if (params.id === undefined)
				return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined)
				return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted")
				return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}

/** Atomic plan edits use the existing reducer and persisted snapshot. */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
 if (action === "batch") {
  if (!Array.isArray(params.operations) || !params.operations.length || params.operations.length > 32) return errorResult(state, "batch requires 1..32 operations");
  let next = state; const ids: Record<string, number> = {};
  const resolve = (id: number) => id < 0 ? ids[String(id)] ?? id : id;
  for (const [index, input] of params.operations.entries()) {
   if (!input || !["create", "update", "delete"].includes(input.action)) return errorResult(state, `batch operation ${index+1}: unsupported action`);
   const item = {...input};
   if (item.action === "create" && item.id !== undefined) {
    if (!Number.isSafeInteger(item.id) || item.id >= 0 || ids[String(item.id)] !== undefined) return errorResult(state, "Batch create aliases must be unique negative integers");
    ids[String(item.id)] = next.nextId; delete item.id;
   } else if (item.id !== undefined) item.id = resolve(item.id);
   if (item.parentId != null) item.parentId = resolve(item.parentId);
   for (const key of ["blockedBy", "addBlockedBy", "removeBlockedBy"] as const) if (item[key]) item[key] = item[key]!.map(resolve);
   const result = applyTaskMutation(next, item.action, item);
   if (result.op.kind === "error") return errorResult(state, `batch operation ${index+1}: ${result.op.message}`);
   next = result.state;
  }
  return {state:next, op:{kind:"batch", ids, count:params.operations.length}};
 }
 const invalid = planFieldError(params); if (invalid) return errorResult(state, invalid);
 const result = reduceTaskMutation(state, action, params);
 if (result.op.kind === "error" || result.state === state) return result;
 const graphError = planGraphError(result.state.tasks); if (graphError) return errorResult(state, graphError);
 const task = result.state.tasks.find(t => t.id === params.id);
 if (action === "update" && task && ["in_progress", "completed"].includes(task.status)) {
  if (blockers(task, result.state.tasks).length) return errorResult(state, "Complete dependencies before starting or completing this task");
  if (task.status === "completed") {
   if (result.state.tasks.some(t => t.parentId === task.id && !["completed", "deleted"].includes(t.status))) return errorResult(state, "Complete or explicitly remove unfinished children first");
   if (task.acceptance?.trim() && !task.evidence?.trim()) return errorResult(state, "Record verification evidence before completing this task");
  }
 }
 return result;
}
