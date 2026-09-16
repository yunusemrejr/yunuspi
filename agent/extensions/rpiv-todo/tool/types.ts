import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction =
	| "create"
	| "update"
	| "list"
	| "get"
	| "delete"
	| "clear"
	| "batch";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	parentId?: number | null;
	execution?: "self" | "subagent" | "swarm" | "fusion";
	files?: string[];
	acceptance?: string;
	evidence?: string;
	refs?: string[];
	runId?: string;

}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	parentId?: number | null;
	execution?: "self" | "subagent" | "swarm" | "fusion";
	files?: string[];
	acceptance?: string;
	evidence?: string;
	refs?: string[];
	runId?: string;

	id?: number;
	includeDeleted?: boolean;
	view?: "tree" | "frontier";
	operations?: Array<TaskMutationParams & {action: "create" | "update" | "delete"}>;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests and the
// pre-refactor schema at `packages/rpiv-todo/todo.ts:512-573`.
// ---------------------------------------------------------------------------

const MutationSchema = Type.Object({
	action: StringEnum([
		"create",
		"update",
		"list",
		"get",
		"delete",
		"clear",
	] as const),
	parentId: Type.Optional(Type.Union([Type.Integer(), Type.Null()], {description: "Parent outcome id; null detaches. Negative ids must be declared as \"id\" on an earlier create in the same batch."})),
	execution: Type.Optional(StringEnum(["self", "subagent", "swarm", "fusion"] as const)),
	files: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:512}), {maxItems:32})),
	acceptance: Type.Optional(Type.String({maxLength:2000,description:"Concrete completion check"})),
	evidence: Type.Optional(Type.String({maxLength:2000,description:"Observed verification and limitations; required to complete a task with acceptance"})),
	refs: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:512}), {maxItems:32,description:"Project fact ids, observation ids or source references; no copied project map"})),
	runId: Type.Optional(Type.String({maxLength:2000,description:"Native subagent/swarm/fusion run id; results still require review"})),
	subject: Type.Optional(
		Type.String({ description: "Task subject line (required for create)" }),
	),
	description: Type.Optional(
		Type.String({ description: "Long-form task description" }),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Set this task's status: one of pending, in_progress, completed, deleted. Create honors it as the initial status; update transitions it. When action is list, filters returned tasks by this status.",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(
		Type.String({ description: "Agent/owner assigned to this task" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

export const TodoParamsSchema = Type.Object({
 ...MutationSchema.properties,
 action: StringEnum(["create", "update", "list", "get", "delete", "clear", "batch"] as const),
 view: Type.Optional(StringEnum(["tree", "frontier"] as const, {description:"list projection; omitted means tree"})),
 operations: Type.Optional(Type.Array(Type.Object({...MutationSchema.properties, action:StringEnum(["create", "update", "delete"] as const)}), {maxItems:32,minItems:1,description:"Atomic mutations. Create may supply a unique negative id as a local alias; later operations reference it. Errors roll back the entire batch."})),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
