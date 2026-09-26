/**
 * Task State Graph — deterministic reducer.
 *
 * Pure module: append-only events in, materialized graph out. No I/O, no
 * inference, no clock reads (callers stamp `ts`). Replaying the same event
 * list always yields the same graph, and replaying an event twice is a no-op.
 */
import type {
	EntityStatusEvent,
	TaskEntity,
	TaskEntityStatus,
	TaskEvent,
	TaskGraph,
	TaskLink,
} from "./types.ts";

/** Bounds keep one session's graph small and projections cheap. */
export const TASK_GRAPH_MAX_ENTITIES = 2000;
export const TASK_GRAPH_MAX_LINKS = 5000;
export const TASK_GRAPH_MAX_EVENT_IDS = 20000;
export const TASK_GRAPH_MAX_ERRORS = 32;

const TERMINAL: Record<TaskEntityStatus, boolean> = {
	superseded: true,
	invalidated: true,
	proposed: false,
	active: false,
	implemented: false,
	"partially-verified": false,
	verified: false,
	failed: false,
	blocked: false,
	unknown: false,
};

/**
 * Allowed status transitions. Anything else is recorded as an impossible
 * transition and ignored: the graph never silently produces false authority
 * from a bad writer. Terminal states only reopen via explicit supersession
 * (a new entity), never by mutating the old one.
 */
const ALLOWED: Record<TaskEntityStatus, readonly TaskEntityStatus[]> = {
	proposed: ["active", "blocked", "superseded", "invalidated", "unknown"],
	active: ["implemented", "failed", "blocked", "superseded", "invalidated", "unknown", "proposed"],
	implemented: ["partially-verified", "verified", "failed", "blocked", "superseded", "invalidated", "active"],
	"partially-verified": ["verified", "implemented", "failed", "blocked", "superseded", "invalidated", "active"],
	verified: ["partially-verified", "implemented", "superseded", "invalidated"],
	failed: ["active", "blocked", "superseded", "invalidated", "implemented"],
	blocked: ["active", "proposed", "superseded", "invalidated", "failed"],
	superseded: [],
	invalidated: ["active", "proposed"],
	unknown: ["proposed", "active", "implemented", "failed", "blocked", "superseded", "invalidated", "verified", "partially-verified"],
};

export function isStatusTransitionAllowed(from: TaskEntityStatus, to: TaskEntityStatus): boolean {
	if (from === to) return true;
	return ALLOWED[from]?.includes(to) === true;
}

export function emptyGraph(taskId: string, sessionId: string, now = 0): TaskGraph {
	return {
		taskId,
		sessionId,
		label: "",
		objective: "",
		createdAt: now,
		updatedAt: now,
		seq: 0,
		entities: {},
		links: [],
		files: {},
		eventIds: [],
		health: {
			degraded: false,
			quarantined: false,
			eventCount: 0,
			appliedCount: 0,
			duplicateEvents: 0,
			errors: [],
			warnings: [],
			impossibleTransitions: [],
		},
		rotations: [],
	};
}

const noteError = (graph: TaskGraph, message: string): void => {
	const text = String(message ?? "unknown reducer error").slice(0, 280);
	graph.health.lastError = text;
	if (graph.health.errors.length < TASK_GRAPH_MAX_ERRORS) graph.health.errors.push(text);
};

const noteWarning = (graph: TaskGraph, message: string): void => {
	const text = String(message ?? "unknown reducer warning").slice(0, 280);
	if (graph.health.warnings.length < TASK_GRAPH_MAX_ERRORS && !graph.health.warnings.includes(text)) {
		graph.health.warnings.push(text);
	}
};

const linkKey = (link: Pick<TaskLink, "from" | "to" | "kind">): string => `${link.from}\0${link.kind}\0${link.to}`;

function addLink(graph: TaskGraph, link: TaskLink): boolean {
	if (graph.links.length >= TASK_GRAPH_MAX_LINKS) {
		noteWarning(graph, `link cap reached (${TASK_GRAPH_MAX_LINKS}); further links dropped`);
		return false;
	}
	const key = linkKey(link);
	for (const existing of graph.links) {
		if (linkKey(existing) === key) return false;
	}
	graph.links.push(link);
	return true;
}

function applyStatus(graph: TaskGraph, event: EntityStatusEvent): void {
	const entity = graph.entities[event.entityId];
	if (!entity) {
		noteWarning(graph, `status event for unknown entity ${event.entityId.slice(0, 64)}`);
		return;
	}
	if (!isStatusTransitionAllowed(entity.status, event.status)) {
		graph.health.impossibleTransitions.push({
			entityId: event.entityId,
			from: entity.status,
			to: event.status,
			ts: event.ts,
		});
		if (graph.health.impossibleTransitions.length > TASK_GRAPH_MAX_ERRORS) {
			graph.health.impossibleTransitions.splice(0, graph.health.impossibleTransitions.length - TASK_GRAPH_MAX_ERRORS);
		}
		return;
	}
	entity.status = event.status;
	if (event.status === "invalidated" && entity.kind === "evidence") entity.stale = true;
	entity.updatedAt = event.ts;
	entity.version += 1;
}

/**
 * A newer file version stales bound evidence and cascades: requirements that
 * were verified only through now-stale evidence drop back to
 * partially-verified (verified claims must be re-earned, never inherited).
 */
function cascadeFileVersion(graph: TaskGraph, file: string, version: number, ts: number): void {
	const staleEvidence = new Set<string>();
	for (const entity of Object.values(graph.entities)) {
		if (entity.kind !== "evidence" || entity.stale) continue;
		if (entity.refs?.file !== file) continue;
		const bound = entity.refs?.fileVersion;
		if (typeof bound === "number" && bound < version) {
			entity.stale = true;
			entity.status = "invalidated";
			entity.updatedAt = ts;
			entity.version += 1;
			staleEvidence.add(entity.id);
		}
	}
	if (!staleEvidence.size) return;
	const verifiedBy = (id: string): string[] => graph.links
		.filter((link) => link.to === id && link.kind === "verified-by")
		.map((link) => link.from);
	for (const entity of Object.values(graph.entities)) {
		if (entity.kind !== "requirement" && entity.kind !== "subtask") continue;
		if (entity.status !== "verified") continue;
		const evidence = verifiedBy(entity.id);
		if (!evidence.length) continue;
		const current = evidence.filter((id) => {
			const ev = graph.entities[id];
			return ev && ev.status !== "invalidated" && !ev.stale;
		});
		if (current.length < evidence.length && !current.length) {
			entity.status = "partially-verified";
			entity.updatedAt = ts;
			entity.version += 1;
		}
	}
}

function applyUpsert(graph: TaskGraph, event: Extract<TaskEvent, { kind: "entity-upsert" }>): void {
	const input = event.entity;
	if (!input || typeof input.id !== "string" || !input.id) {
		noteError(graph, "entity-upsert without a stable id");
		return;
	}
	const id = input.id.slice(0, 160);
	const existing = graph.entities[id];
	if (existing && TERMINAL[existing.status] && input.status !== existing.status) {
		// Terminal entities are history; writers must supersede, not rewrite.
		noteWarning(graph, `upsert ignored for terminal entity ${id} (${existing.status})`);
		return;
	}
	if (!existing && Object.keys(graph.entities).length >= TASK_GRAPH_MAX_ENTITIES) {
		noteWarning(graph, `entity cap reached (${TASK_GRAPH_MAX_ENTITIES}); further entities dropped`);
		return;
	}
	const now = event.ts;
	if (existing) {
		const next: TaskEntity = {
			...existing,
			...input,
			id,
			createdAt: existing.createdAt,
			updatedAt: now,
			eventId: event.eventId,
			version: existing.version + 1,
		};
		if (input.status !== undefined && input.status !== existing.status && !isStatusTransitionAllowed(existing.status, input.status)) {
			graph.health.impossibleTransitions.push({ entityId: id, from: existing.status, to: input.status, ts: now });
			next.status = existing.status;
		}
		graph.entities[id] = next;
		return;
	}
	graph.entities[id] = {
		kind: input.kind,
		status: input.status,
		title: String(input.title ?? "").slice(0, 500),
		detail: typeof input.detail === "string" ? input.detail.slice(0, 2000) : undefined,
		provenance: input.provenance,
		refs: input.refs,
		stale: input.stale,
		family: typeof input.family === "string" ? input.family.slice(0, 64) : undefined,
		id,
		createdAt: now,
		updatedAt: now,
		eventId: event.eventId,
		version: 1,
	};
}

/** Apply one event. Returns false when the event was a duplicate no-op. */
export function applyEvent(graph: TaskGraph, event: TaskEvent): boolean {
	if (!event || typeof event.eventId !== "string" || !event.eventId) {
		noteError(graph, "event without eventId rejected");
		return false;
	}
	if (graph.eventIds.includes(event.eventId)) {
		graph.health.duplicateEvents += 1;
		return false;
	}
	graph.health.eventCount += 1;
	graph.seq += 1;
	graph.updatedAt = Math.max(graph.updatedAt, event.ts);
	if (graph.eventIds.length < TASK_GRAPH_MAX_EVENT_IDS) graph.eventIds.push(event.eventId);
	graph.health.appliedCount += 1;
	try {
		switch (event.kind) {
			case "task-opened": {
				graph.label = event.label.slice(0, 200);
				graph.objective = event.objective.slice(0, 2000);
				if (event.ts && !graph.createdAt) graph.createdAt = event.ts;
				graph.entities[event.taskId] = {
					id: event.taskId,
					kind: "task",
					status: "active",
					title: event.label.slice(0, 200),
					detail: event.objective.slice(0, 2000),
					provenance: event.provenance,
					createdAt: event.ts,
					updatedAt: event.ts,
					eventId: event.eventId,
					version: 1,
				};
				break;
			}
			case "task-followup": {
				// Follow-ups are continuity markers; the entities they add arrive
				// as their own upsert events. Nothing else to materialize.
				break;
			}
			case "entity-upsert":
				applyUpsert(graph, event);
				break;
			case "entity-status":
				applyStatus(graph, event);
				break;
			case "link": {
				if (!graph.entities[event.from] || !graph.entities[event.to]) {
					noteWarning(graph, `link ${event.link} references unknown entity`);
					break;
				}
				addLink(graph, { from: event.from, to: event.to, kind: event.link, eventId: event.eventId, ts: event.ts });
				if (event.link === "supersedes") {
					const prior = graph.entities[event.to];
					if (prior && !TERMINAL[prior.status]) {
						prior.status = "superseded";
						prior.updatedAt = event.ts;
						prior.version += 1;
					}
				}
				if (event.link === "invalidates") {
					const target = graph.entities[event.to];
					if (target && target.status !== "superseded") {
						target.status = "invalidated";
						if (target.kind === "evidence") target.stale = true;
						target.updatedAt = event.ts;
						target.version += 1;
					}
				}
				break;
			}
			case "file-version": {
				const file = event.file.slice(0, 512);
				const prior = graph.files[file];
				if (!prior || event.version > prior.version) {
					graph.files[file] = {
						version: event.version,
						hash: event.hash,
						ts: event.ts,
						toolCallId: event.toolCallId,
					};
					cascadeFileVersion(graph, file, event.version, event.ts);
				}
				break;
			}
			case "evidence-stale": {
				const entity = graph.entities[event.entityId];
				if (entity) {
					entity.stale = true;
					entity.status = "invalidated";
					entity.updatedAt = event.ts;
					entity.version += 1;
				}
				break;
			}
			case "task-rotated": {
				graph.rotations.push({
					priorTaskId: event.priorTaskId,
					priorLabel: event.priorLabel.slice(0, 200),
					reason: event.reason.slice(0, 280),
					ts: event.ts,
				});
				break;
			}
			default:
				noteWarning(graph, `unknown event kind ${(event as TaskEvent).kind}`);
				break;
		}
	} catch (error) {
		noteError(graph, `reducer failed on ${(event as TaskEvent).kind}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return true;
}

/**
 * Deterministic fold: stable order by ts, preserving log order within equal
 * timestamps. Producers must emit entity upserts before links that reference
 * them (all ingest mappers do); a link whose endpoint is still unknown is
 * dropped with a warning rather than inventing state.
 */
export function reduce(events: readonly TaskEvent[], seed?: TaskGraph): TaskGraph {
	const graph = seed ?? emptyGraph("", "");
	const ordered = [...events].sort((a, b) => a.ts - b.ts);
	for (const event of ordered) {
		if (!graph.taskId && event.taskId) {
			graph.taskId = event.taskId;
			graph.sessionId = event.sessionId;
		}
		applyEvent(graph, event);
	}
	return graph;
}

/** Requirement implementation/verification roll-up from graph relations. */
export function requirementState(graph: TaskGraph, requirementId: string): {
	found: boolean;
	implemented: boolean;
	verified: boolean;
	status: TaskEntityStatus | "missing";
	evidence: Array<{ id: string; status: TaskEntityStatus; stale: boolean; title: string }>;
} {
	const entity = graph.entities[requirementId];
	if (!entity) return { found: false, implemented: false, verified: false, status: "missing", evidence: [] };
	const evidenceIds = graph.links
		.filter((link) => link.to === requirementId && link.kind === "verified-by")
		.map((link) => link.from);
	const evidence = evidenceIds
		.map((id) => graph.entities[id])
		.filter((entry): entry is TaskEntity => !!entry)
		.map((entry) => ({ id: entry.id, status: entry.status, stale: entry.stale === true, title: entry.title }));
	const current = evidence.filter((entry) => entry.status !== "invalidated" && !entry.stale);
	const implementedBy = graph.links.some((link) => link.to === requirementId && (link.kind === "implemented-by" || link.kind === "satisfies"));
	return {
		found: true,
		implemented: implementedBy || ["implemented", "partially-verified", "verified"].includes(entity.status),
		verified: entity.status === "verified" && current.length > 0,
		status: entity.status,
		evidence,
	};
}
