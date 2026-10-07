/**
 * Task State Graph — local-first persistence.
 *
 * Append-only `events.jsonl` plus a materialized `snapshot.json` per session
 * task. Snapshots are an optimization: any corruption quarantines the snapshot
 * and rebuilds deterministically from the event log. Total failure degrades to
 * memory-only operation — the graph never bricks a session.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { TASK_ENTITY_KINDS, TASK_PROVENANCE, TASK_STATUSES } from "./types.ts";
import { applyEvent, emptyGraph } from "./reducer.ts";
import type { TaskEvent, TaskGraph } from "./types.ts";

export const TASK_STATE_ENV_DIR = "PI_TASK_STATE_DIR";
export const TASK_STATE_SNAPSHOT_EVERY = 50;

export function defaultTaskStateDir(): string {
	const override = process.env[TASK_STATE_ENV_DIR];
	if (override && override.trim()) return override;
	return path.join(os.homedir(), ".pi", "task-state");
}

export interface TaskStatePaths {
	dir: string;
	events: string;
	snapshot: string;
	meta: string;
}

export function taskStatePaths(baseDir: string, sessionId: string, taskId: string): TaskStatePaths {
	const dir = path.join(baseDir, safeSegment(sessionId), safeSegment(taskId));
	return {
		dir,
		events: path.join(dir, "events.jsonl"),
		snapshot: path.join(dir, "snapshot.json"),
		meta: path.join(dir, "meta.json"),
	};
}

function safeSegment(value: string): string {
	const safe = String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "unknown";
	return safe === "." || safe === ".." ? "_" : safe;
}

type ReplayCursor = { bytes: number; sha256: string };
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
function validGraph(value: unknown, sessionId: string, taskId: string): value is TaskGraph {
	if (!record(value) || value.sessionId !== sessionId || value.taskId !== taskId) return false;
	return typeof value.label === "string" && typeof value.objective === "string"
		&& count(value.seq) && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)
		&& record(value.entities) && Object.entries(value.entities).every(([id, entity]) => record(entity)
			&& entity.id === id && TASK_ENTITY_KINDS.includes(entity.kind) && TASK_STATUSES.includes(entity.status)
			&& TASK_PROVENANCE.includes(entity.provenance) && typeof entity.title === "string" && count(entity.version)
			&& Number.isFinite(entity.createdAt) && Number.isFinite(entity.updatedAt) && typeof entity.eventId === "string"
			&& (entity.refs === undefined || record(entity.refs)))
		&& record(value.files) && Object.values(value.files).every(file => record(file) && count(file.version) && Number.isFinite(file.ts))
		&& Array.isArray(value.links) && value.links.every(link => record(link)
			&& typeof link.from === "string" && typeof link.to === "string" && typeof link.kind === "string")
		&& Array.isArray(value.eventIds) && value.eventIds.every(id => typeof id === "string")
		&& Array.isArray(value.rotations) && record(value.health)
		&& typeof value.health.degraded === "boolean" && typeof value.health.quarantined === "boolean"
		&& ["eventCount", "appliedCount", "duplicateEvents"].every(key => count(value.health[key]))
		&& ["errors", "warnings", "impossibleTransitions"].every(key => Array.isArray(value.health[key]));
}

export interface TaskStateLoadResult {
	graph: TaskGraph;
	/** Event-log lines that failed to parse (skipped, never fatal). */
	skippedLines: number;
	quarantinedSnapshot?: string;
}

/** Load snapshot + replay newer events; quarantine and rebuild on corruption. */
export function loadTaskState(paths: TaskStatePaths, sessionId: string, taskId: string): TaskStateLoadResult {
	let graph = emptyGraph(taskId, sessionId);
	let skippedLines = 0;
	let quarantinedSnapshot: string | undefined;
	let cursor: ReplayCursor | undefined;
	let hasSnapshot = false;
	const quarantine = (error: unknown): void => {
		try {
			quarantinedSnapshot = `${paths.snapshot}.quarantine-${Date.now()}`;
			fs.renameSync(paths.snapshot, quarantinedSnapshot);
		} catch {
			quarantinedSnapshot = paths.snapshot;
		}
		graph = emptyGraph(taskId, sessionId);
		graph.health.quarantined = true;
		graph.health.errors.push(`snapshot quarantined: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
		cursor = undefined;
	};
	try {
		if (fs.existsSync(paths.snapshot)) {
			const raw = fs.readFileSync(paths.snapshot, "utf8");
			const { replayCursor, ...parsed } = JSON.parse(raw);
			if (!validGraph(parsed, sessionId, taskId)) throw new Error("snapshot identity or shape mismatch");
			graph = parsed;
			hasSnapshot = true;
			if (replayCursor !== undefined) {
				if (!record(replayCursor) || !count(replayCursor.bytes) || !/^[a-f0-9]{64}$/.test(replayCursor.sha256)) {
					throw new Error("invalid snapshot replay cursor");
				}
				cursor = replayCursor as ReplayCursor;
			}
		}
	} catch (error) {
		// Corrupt snapshots must never become authoritative false state.
		quarantine(error);
	}
	try {
		if (!fs.existsSync(paths.events)) return { graph, skippedLines, quarantinedSnapshot };
		const log = fs.readFileSync(paths.events);
		let offset = 0;
		if (cursor) {
			if (cursor.bytes <= log.length && (cursor.bytes === 0 || log[cursor.bytes - 1] === 10)
				&& digest(log.subarray(0, cursor.bytes)) === cursor.sha256) offset = cursor.bytes;
			else quarantine(new Error("snapshot log prefix changed"));
		} else if (hasSnapshot && !quarantinedSnapshot) {
			// Legacy snapshots have no durable cursor. Rebuild from the log once;
			// bounded id receipts cannot establish which prefix was applied.
			graph = emptyGraph(taskId, sessionId);
		}
		const lines = log.subarray(offset).toString("utf8").split("\n");
		const seen = new Set<string>();
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event: TaskEvent;
			try {
				event = JSON.parse(trimmed) as TaskEvent;
			} catch {
				skippedLines += 1;
				continue;
			}
			if (!event || typeof event.eventId !== "string" || !event.eventId || !Number.isFinite(event.ts) || typeof event.kind !== "string") {
				skippedLines += 1;
				continue;
			}
			if (event.taskId !== taskId || event.sessionId !== sessionId) continue;
			// Full rebuilds can span many bounded live-id windows. Their local
			// replay index lasts only for this read, never in model context.
			if (seen.has(event.eventId)) continue;
			seen.add(event.eventId);
			applyEvent(graph, event);
		}
	} catch (error) {
		graph.health.degraded = true;
		graph.health.lastError = `event log unreadable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280);
	}
	if (skippedLines) {
		graph.health.degraded = true;
		graph.health.lastError = `${skippedLines} malformed event log lines skipped`;
	}
	return { graph, skippedLines, quarantinedSnapshot };
}

/** Append events atomically enough for a local harness (single writer per session). */
export function appendTaskEvents(paths: TaskStatePaths, events: readonly TaskEvent[]): void {
	if (!events.length) return;
	fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
	const fd = fs.openSync(paths.events, "a+", 0o600);
	try {
		const size = fs.fstatSync(fd).size;
		const last = Buffer.alloc(1);
		const interrupted = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
		// Preserve the broken record for diagnostics, but don't concatenate the
		// next good event onto it after an interrupted append.
		fs.writeFileSync(fd, (interrupted ? "\n" : "") + payload, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Write materialized snapshot via tmp + rename. */
export function writeTaskSnapshot(paths: TaskStatePaths, graph: TaskGraph): void {
	fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	const tmp = `${paths.snapshot}.tmp-${process.pid}`;
	let replayCursor: ReplayCursor | undefined;
	try {
		const log = fs.readFileSync(paths.events);
		if (!log.length || log[log.length - 1] === 10) replayCursor = { bytes: log.length, sha256: digest(log) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		fs.writeFileSync(tmp, JSON.stringify({ ...graph, ...(replayCursor ? { replayCursor } : {}) }), { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tmp, paths.snapshot);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
	try {
		fs.writeFileSync(paths.meta, JSON.stringify({
			sessionId: graph.sessionId,
			taskId: graph.taskId,
			label: graph.label,
			seq: graph.seq,
			entities: Object.keys(graph.entities).length,
			links: graph.links.length,
			updatedAt: graph.updatedAt,
			degraded: graph.health.degraded,
			quarantined: graph.health.quarantined,
		}), "utf8");
	} catch {
		/* meta is a convenience; the snapshot is authoritative */
	}
}

/** List task ids with stored state for one session (resume support). */
export function listSessionTasks(baseDir: string, sessionId: string): string[] {
	try {
		const dir = path.join(baseDir, safeSegment(sessionId));
		if (!fs.existsSync(dir)) return [];
		return fs.readdirSync(dir)
			.filter((entry) => {
				try {
					return fs.statSync(path.join(dir, entry)).isDirectory()
						&& (fs.existsSync(path.join(dir, entry, "events.jsonl")) || fs.existsSync(path.join(dir, entry, "snapshot.json")));
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}
