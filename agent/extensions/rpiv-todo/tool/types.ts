import { StringEnum } from "@yunuspi/ai";
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
	execution?: "self" | "subagent" | "fanout";
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
	execution?: "self" | "subagent" | "fanout";
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
	parentId: Type.Optional(Type.Union([Type.Integer(), Type.Null()], {description: "Parent task id; null detaches."})),
	execution: Type.Optional(StringEnum(["self", "subagent", "fanout"] as const, {description: "How the task runs: self, subagent or fanout. Records intent for native orchestration."})),
	files: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:512}), {maxItems:32})),
	acceptance: Type.Optional(Type.String({maxLength:2000,description:"How to check the task is done."})),
	evidence: Type.Optional(Type.String({maxLength:2000,description:"What you checked and its limits. Required to complete a task that has acceptance."})),
	refs: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:512}), {maxItems:32,description:"Fact ids, observation ids or source references. Do not paste a project map."})),
	runId: Type.Optional(Type.String({maxLength:2000,description:"Run id of a subagent or fanout. Its results still need review."})),
	subject: Type.Optional(
		Type.String({ description: "Short title. Required for create." }),
	),
	description: Type.Optional(
		Type.String({ description: "Longer task details." }),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Spinner label shown while in progress, in -ing form (e.g. 'writing tests').",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description:
				"Create sets the starting status, update changes it, list filters by it.",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids that block this one. Create only.",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy. Update only.",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description:
				"Task ids to remove from blockedBy. Update only.",
		}),
	),
	owner: Type.Optional(
		Type.String({ description: "Agent or person who owns the task." }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Free-form data. On update, a null value deletes that key.",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id. Required for update, get and delete.",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"With list, also return deleted tasks. Default false.",
		}),
	),
});

// Batch items repeat the top-level fields, whose descriptions already ship in
// the same schema; the copy drops them to keep every request smaller.
function undescribed(schema: any): any {
	if (Array.isArray(schema)) return schema.map(undescribed);
	if (!schema || typeof schema !== "object") return schema;
	const copy: any = {};
	for (const key of Reflect.ownKeys(schema)) if (key !== "description") copy[key] = undescribed(schema[key]);
	return copy;
}

export const TodoParamsSchema = Type.Object({
 ...MutationSchema.properties,
 action: StringEnum(["create", "update", "list", "get", "delete", "clear", "batch"] as const, {description: "The operation. batch applies the operations list atomically."}),
 view: Type.Optional(StringEnum(["tree", "frontier"] as const, {description:"For list: frontier (ready and active work) or tree (full hierarchy). Default tree."})),
 operations: Type.Optional(Type.Array(Type.Object({...undescribed(MutationSchema.properties), action:StringEnum(["create", "update", "delete"] as const)}), {maxItems:32,minItems:1,description:"1 to 32 create, update or delete items using the fields above. A create may set a unique negative id as a local alias that later items use. Any error rolls back the whole batch."})),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
