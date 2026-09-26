/**
 * Task State Graph — shared type vocabulary.
 *
 * Pure types only: no I/O, no inference. The graph records and exposes task
 * state, provenance, relationships and evidence; it never decides, permits or
 * orchestrates. Existing subsystems keep their own decisions.
 */

/** Entity families the graph can represent. */
export type TaskEntityKind =
	| "task"
	| "requirement"
	| "constraint"
	| "inferred-constraint"
	| "subtask"
	| "decision"
	| "assumption"
	| "question"
	| "work"
	| "attempt"
	| "failure"
	| "artifact"
	| "tool-exec"
	| "child"
	| "peer"
	| "review"
	| "finding"
	| "verification"
	| "evidence"
	| "completion-claim"
	| "gap";

/** Where a fact came from. Never collapsed into equivalent truth. */
export type TaskProvenance =
	| "literal-user"
	| "prompt-analysis"
	| "main-agent"
	| "tool-output"
	| "source-inspection"
	| "test-result"
	| "render-inspection"
	| "subagent"
	| "observer"
	| "watchmaker"
	| "expert-director"
	| "guardian"
	| "review-council"
	| "project-memory"
	| "project-intelligence"
	| "sibling-session"
	| "session-history";

/** Explicit status vocabulary. No fake probabilistic precision. */
export type TaskEntityStatus =
	| "proposed"
	| "active"
	| "implemented"
	| "partially-verified"
	| "verified"
	| "failed"
	| "blocked"
	| "superseded"
	| "invalidated"
	| "unknown";

export type TaskLinkKind =
	| "implemented-by"
	| "affects"
	| "verified-by"
	| "caused-retry-of"
	| "based-on"
	| "satisfies"
	| "challenges"
	| "supersedes"
	| "caused-by"
	| "child-of"
	| "evidences"
	| "blocks"
	| "invalidates"
	| "relates-to";

/** Source identity/version bindings carried by evidence and versioned facts. */
export interface TaskRefs {
	file?: string;
	fileHash?: string;
	fileVersion?: number;
	gitCommit?: string;
	toolCallId?: string;
	testCommand?: string;
	testCommandHash?: string;
	observationId?: string;
	renderArtifactHash?: string;
	childRunId?: string;
	reviewId?: string;
	todoId?: number;
	requirementId?: string;
	url?: string;
	detail?: string;
}

export interface TaskEntity {
	id: string;
	kind: TaskEntityKind;
	status: TaskEntityStatus;
	title: string;
	detail?: string;
	provenance: TaskProvenance;
	refs?: TaskRefs;
	/** True when a newer file version invalidated the bound evidence. */
	stale?: boolean;
	family?: string;
	createdAt: number;
	updatedAt: number;
	eventId: string;
	version: number;
}

export interface TaskLink {
	from: string;
	to: string;
	kind: TaskLinkKind;
	eventId: string;
	ts: number;
}

export interface TaskFileVersion {
	version: number;
	hash?: string;
	ts: number;
	toolCallId?: string;
}

/** Append-only event envelope. The materialized graph derives from these. */
export type TaskEventKind =
	| "task-opened"
	| "task-followup"
	| "entity-upsert"
	| "entity-status"
	| "link"
	| "file-version"
	| "evidence-stale"
	| "task-rotated";

export interface TaskEventBase {
	/** Stable idempotent identity; replays with the same id are no-ops. */
	eventId: string;
	ts: number;
	sessionId: string;
	taskId: string;
	kind: TaskEventKind;
}

export interface TaskOpenedEvent extends TaskEventBase {
	kind: "task-opened";
	label: string;
	objective: string;
	provenance: TaskProvenance;
	continuedFrom?: string;
}

export interface TaskFollowupEvent extends TaskEventBase {
	kind: "task-followup";
	mode: "followup" | "correction";
	summary: string;
	promptHash: string;
}

export interface EntityUpsertEvent extends TaskEventBase {
	kind: "entity-upsert";
	entity: Omit<TaskEntity, "createdAt" | "updatedAt" | "eventId" | "version"> & {
		version?: number;
	};
}

export interface EntityStatusEvent extends TaskEventBase {
	kind: "entity-status";
	entityId: string;
	status: TaskEntityStatus;
	why?: string;
}

export interface LinkEvent extends TaskEventBase {
	kind: "link";
	from: string;
	to: string;
	link: TaskLinkKind;
}

export interface FileVersionEvent extends TaskEventBase {
	kind: "file-version";
	file: string;
	version: number;
	hash?: string;
	toolCallId?: string;
}

export interface EvidenceStaleEvent extends TaskEventBase {
	kind: "evidence-stale";
	entityId: string;
	why: string;
}

export interface TaskRotatedEvent extends TaskEventBase {
	kind: "task-rotated";
	priorTaskId: string;
	priorLabel: string;
	reason: string;
}

export type TaskEvent =
	| TaskOpenedEvent
	| TaskFollowupEvent
	| EntityUpsertEvent
	| EntityStatusEvent
	| LinkEvent
	| FileVersionEvent
	| EvidenceStaleEvent
	| TaskRotatedEvent;

export interface TaskGraphHealth {
	degraded: boolean;
	quarantined: boolean;
	eventCount: number;
	appliedCount: number;
	duplicateEvents: number;
	errors: string[];
	warnings: string[];
	impossibleTransitions: Array<{ entityId: string; from: TaskEntityStatus; to: TaskEntityStatus; ts: number }>;
	lastError?: string;
}

/** Materialized current-state view. Derived deterministically from events. */
export interface TaskGraph {
	taskId: string;
	sessionId: string;
	label: string;
	objective: string;
	createdAt: number;
	updatedAt: number;
	seq: number;
	entities: Record<string, TaskEntity>;
	links: TaskLink[];
	files: Record<string, TaskFileVersion>;
	/** Bounded set of applied event ids (idempotency + replay safety). */
	eventIds: string[];
	health: TaskGraphHealth;
	rotations: Array<{ priorTaskId: string; priorLabel: string; reason: string; ts: number }>;
}

export const TASK_ENTITY_KINDS: readonly TaskEntityKind[] = [
	"task", "requirement", "constraint", "inferred-constraint", "subtask",
	"decision", "assumption", "question", "work", "attempt", "failure",
	"artifact", "tool-exec", "child", "peer", "review", "finding",
	"verification", "evidence", "completion-claim", "gap",
];

export const TASK_PROVENANCE: readonly TaskProvenance[] = [
	"literal-user", "prompt-analysis", "main-agent", "tool-output",
	"source-inspection", "test-result", "render-inspection", "subagent",
	"observer", "watchmaker", "expert-director", "guardian", "review-council",
	"project-memory", "project-intelligence", "sibling-session", "session-history",
];

export const TASK_STATUSES: readonly TaskEntityStatus[] = [
	"proposed", "active", "implemented", "partially-verified", "verified",
	"failed", "blocked", "superseded", "invalidated", "unknown",
];
