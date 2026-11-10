import { StringEnum } from "@yunuspi/ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

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
// copy.
// ---------------------------------------------------------------------------

// Every field the tool accepts.
const MutationSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	id: Type.Optional(Type.Number({ description: "Task id, for update, get and delete." })),
	subject: Type.Optional(Type.String({ description: "Short title, for create." })),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String({ description: "Label shown while in progress, in -ing form." })),
	status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const, { description: "Create sets it, update changes it, list filters by it." })),
	acceptance: Type.Optional(Type.String({ maxLength: 2000, description: "How to check the task is done." })),
	evidence: Type.Optional(Type.String({ maxLength: 2000, description: "What you checked and its limits; needed to complete a task that has acceptance." })),
	parentId: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "Parent task id; null detaches." })),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Ids that block this task (create). On update use addBlockedBy or removeBlockedBy." })),
	addBlockedBy: Type.Optional(Type.Array(Type.Number())),
	removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
	execution: Type.Optional(StringEnum(["self", "subagent", "fanout"] as const, { description: "A note of how the task is meant to run; it starts nothing." })),
	files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 })),
	refs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32, description: "Fact ids, observation ids or source references. Do not paste a project map." })),
	runId: Type.Optional(Type.String({ maxLength: 2000, description: "Run id of a subagent or fanout. Its results still need review." })),
	owner: Type.Optional(Type.String({ description: "Agent or person who owns the task." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Free-form data. On update, a null value deletes that key." })),
	includeDeleted: Type.Optional(Type.Boolean({ description: "With list, also return deleted tasks. Default false." })),
});

// The model sees a smaller schema than the tool accepts. 45 days of sessions
// used refs, runId, owner, metadata and includeDeleted in 4 of 296 calls, so
// they stay accepted but unlisted (and are checked by unlistedFieldError, since
// the wire schema no longer does). Batch items repeat the top-level fields
// without their descriptions, which already ship once in the same schema.
const UNLISTED = new Set(["refs", "runId", "owner", "metadata", "includeDeleted"]);
const UNLISTED_IN_BATCH = new Set([...UNLISTED, "addBlockedBy", "removeBlockedBy"]);

function undescribed(schema: any): any {
	if (Array.isArray(schema)) return schema.map(undescribed);
	if (!schema || typeof schema !== "object") return schema;
	// The schema library keeps its own markers as hidden properties; a plain
	// assignment would make them visible and send them to the model.
	const copy: any = {};
	for (const key of Reflect.ownKeys(schema)) {
		if (key === "description") continue;
		const own = Object.getOwnPropertyDescriptor(schema, key)!;
		Object.defineProperty(copy, key, "value" in own ? { ...own, value: undescribed(own.value) } : own);
	}
	return copy;
}

// The expected shape of each field in UNLISTED_IN_BATCH, mirroring its MutationSchema entry.
const UNLISTED_SHAPE_HINTS: Record<string, string> = {
	refs: 'todo: "refs" must be an array of up to 32 text ids, like ["fact-1"].',
	runId: 'todo: "runId" must be a string, like "run-1".',
	owner: 'todo: "owner" must be a string, like "reviewer".',
	metadata: 'todo: "metadata" must be an object of key-value pairs, like {"source": "docs"}.',
	includeDeleted: 'todo: "includeDeleted" must be true or false.',
	addBlockedBy: 'todo: "addBlockedBy" must be an array of task ids, like [1, 2].',
	removeBlockedBy: 'todo: "removeBlockedBy" must be an array of task ids, like [1, 2].',
};

/** Names the first unlisted field whose value has the wrong shape, in a call or in one of its batch items. */
export function unlistedFieldError(params: unknown): string | undefined {
	const entries = [params, ...(Array.isArray((params as any)?.operations) ? (params as any).operations : [])];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		for (const name of UNLISTED_IN_BATCH) {
			const value = (entry as any)[name];
			if (value !== undefined && !Value.Check((MutationSchema.properties as any)[name], value)) return UNLISTED_SHAPE_HINTS[name];
		}
	}
	return undefined;
}

function listed(skip: Set<string>, shape: (schema: any) => any = (schema) => schema): any {
	const fields: any = {};
	for (const [name, schema] of Object.entries(MutationSchema.properties)) if (!skip.has(name)) fields[name] = shape(schema);
	return fields;
}

export const TodoParamsSchema = Type.Object({
	...listed(UNLISTED),
	action: StringEnum(["create", "update", "list", "get", "delete", "clear", "batch"] as const, { description: "batch applies the operations list atomically." }),
	view: Type.Optional(StringEnum(["tree", "frontier"] as const, { description: "For list: frontier (ready and active work) or tree (default)." })),
	operations: Type.Optional(Type.Array(Type.Object({ ...listed(UNLISTED_IN_BATCH, undescribed), action: StringEnum(["create", "update", "delete"] as const) }), { maxItems: 32, minItems: 1, description: "Create, update or delete items with the fields above. A create may take a unique negative id as an alias that later items use. Any error rolls back the whole batch." })),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
