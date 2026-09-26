/**
 * Task State Graph — session-scoped service and typed mutation API.
 *
 * One service per root session; concurrent sessions keep separate graphs.
 * Every public method is fail-open: a graph problem records health status and
 * returns a safe default instead of breaking the session.
 */
import { createHash } from "node:crypto";
import { sessionObservability } from "../session-observability.ts";
import {
	appendTaskEvents,
	defaultTaskStateDir,
	listSessionTasks,
	loadTaskState,
	taskStatePaths,
	writeTaskSnapshot,
	TASK_STATE_SNAPSHOT_EVERY,
	type TaskStatePaths,
} from "./store.ts";
import { applyEvent, emptyGraph } from "./reducer.ts";
import {
	classifyUserInput,
	linkEvent,
	requirementEvents,
	statusEvent,
	taskIdFor,
	upsertEvent,
	type EntityInput,
	type FollowupMode,
	type IngestContext,
	type LedgerRequirement,
} from "./ingest.ts";
import {
	collectDiagnostics,
	projectCompletion,
	projectMain,
	projectObserver,
	projectSubagentSlice,
	projectWatchmaker,
	renderSummary,
	type GraphDiagnostics,
} from "./projections.ts";
import type { TaskEntity, TaskEntityStatus, TaskEvent, TaskGraph, TaskLinkKind } from "./types.ts";

export const TASK_STATE_SERVICE = Symbol.for("yunus-pi.task-state.v1");

export interface TaskStateStats {
	taskId: string;
	label: string;
	entities: number;
	links: number;
	events: number;
	requirements: number;
	verified: number;
	staleEvidence: number;
	failures: number;
	degraded: boolean;
	quarantined: boolean;
}

const safe = <T>(service: TaskStateService | undefined, what: string, fallback: T, run: () => T): T => {
	try {
		return run();
	} catch (error) {
		try {
			service?.noteFailure(`${what}: ${error instanceof Error ? error.message : String(error)}`);
		} catch {
			/* never throw from the safety net */
		}
		return fallback;
	}
};

export class TaskStateService {
	private state: TaskGraph;
	private paths: TaskStatePaths;
	private readonly baseDir: string;
	private readonly sessionId: string;
	private epoch: number;
	private pendingSnapshot = 0;
	private disabled = false;

	constructor(sessionId: string, baseDir: string = defaultTaskStateDir()) {
		this.sessionId = sessionId || "unknown";
		this.baseDir = baseDir;
		this.epoch = TaskStateService.latestEpoch(baseDir, this.sessionId);
		this.paths = taskStatePaths(baseDir, this.sessionId, taskIdFor(this.sessionId, this.epoch));
		this.state = emptyGraph(this.paths && taskIdFor(this.sessionId, this.epoch), this.sessionId);
		this.load();
	}

	private static latestEpoch(baseDir: string, sessionId: string): number {
		const tasks = listSessionTasks(baseDir, sessionId);
		let epoch = 0;
		for (const id of tasks) {
			const match = /-(\d+)$/.exec(id);
			if (match) epoch = Math.max(epoch, Number(match[1]));
		}
		return epoch;
	}

	get taskId(): string {
		return this.state.taskId;
	}

	get available(): boolean {
		return !this.disabled;
	}

	private ctx(ts: number = Date.now()): IngestContext {
		return { sessionId: this.sessionId, taskId: this.state.taskId, ts };
	}

	private persist(events: readonly TaskEvent[]): void {
		if (this.disabled || !events.length) return;
		try {
			appendTaskEvents(this.paths, events);
			this.pendingSnapshot += events.length;
			if (this.pendingSnapshot >= TASK_STATE_SNAPSHOT_EVERY) {
				this.pendingSnapshot = 0;
				writeTaskSnapshot(this.paths, this.state);
			}
		} catch (error) {
			this.noteFailure(`persist failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private load(): void {
		try {
			const loaded = loadTaskState(this.paths, this.sessionId, this.state.taskId);
			this.state = loaded.graph;
			if (loaded.quarantinedSnapshot || loaded.skippedLines > 0) {
				this.state.health.warnings.push(
					`recovered state: snapshot ${loaded.quarantinedSnapshot ? "quarantined" : "ok"}, ${loaded.skippedLines} log lines skipped`,
				);
			}
			if (!this.state.taskId) {
				this.state.taskId = taskIdFor(this.sessionId, this.epoch);
				this.state.sessionId = this.sessionId;
			}
		} catch (error) {
			this.disabled = false; // memory-only degraded mode, never a bricked session
			this.state = emptyGraph(taskIdFor(this.sessionId, this.epoch), this.sessionId);
			this.noteFailure(`load failed, memory-only: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	noteFailure(message: string): void {
		try {
			this.state.health.degraded = true;
			this.state.health.lastError = String(message).slice(0, 280);
			if (this.state.health.errors.length < 32) this.state.health.errors.push(this.state.health.lastError);
		} catch {
			/* the safety net never throws */
		}
	}

	/** Apply raw events (ingest mappers, replay, tests). Returns applied count. */
	apply(events: readonly TaskEvent[]): number {
		return safe(this, "apply", 0, () => {
			let applied = 0;
			for (const event of events) {
				if (applyEvent(this.state, event)) applied += 1;
			}
			this.persist(events);
			return applied;
		});
	}

	// ── typed mutation API ──────────────────────────────────────────────

	record(entity: EntityInput, dedup = ""): string {
		return safe(this, "record", entity.id, () => {
			this.apply([upsertEvent(this.ctx(), entity, dedup)]);
			return entity.id;
		});
	}

	link(from: string, to: string, kind: TaskLinkKind): boolean {
		return safe(this, "link", false, () => this.apply([linkEvent(this.ctx(), from, to, kind)]) > 0);
	}

	updateStatus(id: string, status: TaskEntityStatus, why = ""): boolean {
		return safe(this, "updateStatus", false, () => this.apply([statusEvent(this.ctx(), id, status, why)]) > 0);
	}

	invalidate(id: string, reason: string): boolean {
		return safe(this, "invalidate", false, () => {
			const entity = this.state.entities[id];
			const invalidator = `inv-${createHash("sha256").update(`${this.state.taskId}${id}${reason}`).digest("hex").slice(0, 16)}`;
			const events: TaskEvent[] = [
				upsertEvent(this.ctx(), {
					id: invalidator,
					kind: "gap",
					status: "active",
					title: `invalidation: ${reason}`.slice(0, 240),
					provenance: entity?.provenance ?? "main-agent",
				}, `invalidate:${this.state.taskId}:${id}`),
				linkEvent(this.ctx(), invalidator, id, "invalidates"),
			];
			return this.apply(events) > 0;
		});
	}

	supersede(oldId: string, newId: string): boolean {
		return safe(this, "supersede", false, () => this.apply([linkEvent(this.ctx(), newId, oldId, "supersedes")]) > 0);
	}

	// ── task lifecycle ──────────────────────────────────────────────────

	/**
	 * Open or continue the session task from a user prompt. Returns the
	 * classification; genuinely new tasks rotate to a fresh graph while the
	 * prior task's state stays archived on disk.
	 */
	userInput(text: string, relation?: string, label = ""): { mode: FollowupMode; taskId: string } {
		return safe(this, "userInput", { mode: "followup" as FollowupMode, taskId: this.state.taskId }, () => {
			const { mode, reason } = classifyUserInput(text, relation);
			const ts = Date.now();
			const rotated = mode === "new-task" && !!this.state.label;
			if (rotated) {
				this.rotate(reason || "new task");
			}
			if (!this.state.label) {
				const objective = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000) || "(empty prompt)";
				const taskLabel = (label || objective).slice(0, 200);
				this.apply([{
					eventId: `ev-task-${createHash("sha256").update(`${this.state.taskId}${objective}`).digest("hex").slice(0, 20)}`,
					ts,
					sessionId: this.sessionId,
					taskId: this.state.taskId,
					kind: "task-opened",
					label: taskLabel,
					objective,
					provenance: "literal-user",
				}]);
				return { mode: rotated ? "new-task" : "followup", taskId: this.state.taskId };
			}
			const promptHash = createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
			this.apply([{
				eventId: `ev-followup-${this.state.taskId}-${promptHash}`,
				ts,
				sessionId: this.sessionId,
				taskId: this.state.taskId,
				kind: "task-followup",
				mode: mode === "new-task" ? "followup" : mode,
				summary: String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
				promptHash,
			}]);
			return { mode, taskId: this.state.taskId };
		});
	}

	/** Fold requirement-ledger items into the graph (ledger stays authoritative). */
	syncRequirements(items: readonly LedgerRequirement[], mode: FollowupMode = "followup"): number {
		return safe(this, "syncRequirements", 0, () => {
			const prior = new Map<string, string>();
			for (const entity of Object.values(this.state.entities)) {
				if (entity.kind === "requirement" && entity.status !== "superseded" && entity.status !== "invalidated") {
					prior.set(entity.id, `${entity.title} ${entity.detail ?? ""}`);
				}
			}
			return this.apply(requirementEvents(this.ctx(), items, mode, prior));
		});
	}

	private rotate(reason: string): void {
		try {
			writeTaskSnapshot(this.paths, this.state);
		} catch {
			/* rotation must not fail on snapshot trouble */
		}
		const priorTaskId = this.state.taskId;
		const priorLabel = this.state.label;
		this.epoch += 1;
		const next = taskIdFor(this.sessionId, this.epoch);
		this.paths = taskStatePaths(this.baseDir, this.sessionId, next);
		this.state = emptyGraph(next, this.sessionId);
		this.pendingSnapshot = 0;
		this.apply([{
			eventId: `ev-rotate-${next}-${Date.now()}`,
			ts: Date.now(),
			sessionId: this.sessionId,
			taskId: next,
			kind: "task-rotated",
			priorTaskId,
			priorLabel,
			reason: reason.slice(0, 280),
		}]);
	}

	// ── queries ─────────────────────────────────────────────────────────

	query(predicate: (entity: TaskEntity) => boolean, limit = 32): TaskEntity[] {
		return safe(this, "query", [], () =>
			Object.values(this.state.entities).filter((entity) => {
				try {
					return predicate(entity) === true;
				} catch {
					return false;
				}
			}).slice(0, Math.max(1, Math.min(200, limit))));
	}

	entity(id: string): TaskEntity | undefined {
		return safe(this, "entity", undefined, () => this.state.entities[id]);
	}

	graph(): TaskGraph {
		return this.state;
	}

	project(kind: "main" | "observer" | "watchmaker" | "summary", maxChars = 2000): string {
		return safe(this, "project", "(task state unavailable)", () => {
			const budgets = { maxChars, maxItems: 12 };
			switch (kind) {
				case "observer": return projectObserver(this.state, budgets);
				case "watchmaker": return projectWatchmaker(this.state, budgets);
				case "summary": return renderSummary(this.state);
				default: return projectMain(this.state, budgets);
			}
		});
	}

	subagentSlice(focus: string[] = [], maxChars = 1500): string {
		return safe(this, "subagentSlice", "(task state unavailable)", () => projectSubagentSlice(this.state, { focus, maxChars }));
	}

	completionBlockers(): string[] {
		return safe(this, "completionBlockers", [], () => projectCompletion(this.state).blockers);
	}

	diagnostics(): GraphDiagnostics {
		return safe(this, "diagnostics", collectDiagnostics(this.state), () => collectDiagnostics(this.state));
	}

	stats(): TaskStateStats {
		return safe(this, "stats", {
			taskId: this.state.taskId, label: "", entities: 0, links: 0, events: 0,
			requirements: 0, verified: 0, staleEvidence: 0, failures: 0, degraded: true, quarantined: false,
		}, () => {
			const entities = Object.values(this.state.entities);
			const completion = projectCompletion(this.state);
			return {
				taskId: this.state.taskId,
				label: this.state.label,
				entities: entities.length,
				links: this.state.links.length,
				events: this.state.health.eventCount,
				requirements: completion.total,
				verified: completion.verified,
				staleEvidence: entities.filter((entry) => entry.kind === "evidence" && entry.stale).length,
				failures: entities.filter((entry) => entry.kind === "failure").length,
				degraded: this.state.health.degraded,
				quarantined: this.state.health.quarantined,
			};
		});
	}

	/** Flush snapshot (compaction, shutdown, session switch). */
	checkpoint(): void {
		safe(this, "checkpoint", undefined, () => {
			writeTaskSnapshot(this.paths, this.state);
			this.pendingSnapshot = 0;
		});
	}
}

const services = new Map<string, TaskStateService>();

/** Session-scoped singleton; concurrent sessions never share a graph. */
export function getTaskStateService(sessionId: string, baseDir?: string): TaskStateService {
	const key = `${baseDir ?? defaultTaskStateDir()}\0${sessionId || "unknown"}`;
	let service = services.get(key);
	if (!service) {
		service = new TaskStateService(sessionId, baseDir);
		services.set(key, service);
		try {
			sessionObservability()[TASK_STATE_SERVICE] = service;
		} catch {
			/* observability publish is best-effort */
		}
	}
	return service;
}

/** Fail-open accessor for subsystems that must not construct state. */
export function currentTaskStateService(): TaskStateService | undefined {
	try {
		const service = sessionObservability()[TASK_STATE_SERVICE] as TaskStateService | undefined;
		if (service && typeof service.project === "function") return service;
	} catch {
		/* fall through */
	}
	return undefined;
}

/** Test/turnover helper: drop cached services (persisted state stays on disk). */
export function clearTaskStateServices(): void {
	services.clear();
	try {
		if (sessionObservability()[TASK_STATE_SERVICE]) delete sessionObservability()[TASK_STATE_SERVICE];
	} catch {
		/* ignore */
	}
}
