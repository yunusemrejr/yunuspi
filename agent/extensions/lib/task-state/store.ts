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
	const safe = (value: string): string => String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "unknown";
	const dir = path.join(baseDir, safe(sessionId), safe(taskId));
	return {
		dir,
		events: path.join(dir, "events.jsonl"),
		snapshot: path.join(dir, "snapshot.json"),
		meta: path.join(dir, "meta.json"),
	};
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
	let snapshotSeq = 0;
	try {
		if (fs.existsSync(paths.snapshot)) {
			const raw = fs.readFileSync(paths.snapshot, "utf8");
			const parsed = JSON.parse(raw) as TaskGraph;
			if (parsed && parsed.taskId === taskId && parsed.entities && Array.isArray(parsed.eventIds)) {
				graph = parsed;
				snapshotSeq = parsed.seq;
			} else {
				throw new Error("snapshot identity mismatch");
			}
		}
	} catch (error) {
		// Corrupt snapshots must never become authoritative false state.
		try {
			quarantinedSnapshot = `${paths.snapshot}.quarantine-${Date.now()}`;
			fs.renameSync(paths.snapshot, quarantinedSnapshot);
		} catch {
			quarantinedSnapshot = paths.snapshot;
		}
		graph = emptyGraph(taskId, sessionId);
		graph.health.quarantined = true;
		graph.health.errors.push(`snapshot quarantined: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
		snapshotSeq = 0;
	}
	try {
		if (!fs.existsSync(paths.events)) return { graph, skippedLines, quarantinedSnapshot };
		const lines = fs.readFileSync(paths.events, "utf8").split("\n");
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
			if (!event || typeof event.eventId !== "string") {
				skippedLines += 1;
				continue;
			}
			if (event.taskId !== taskId) continue;
			applyEvent(graph, event);
		}
	} catch (error) {
		graph.health.degraded = true;
		graph.health.lastError = `event log unreadable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280);
	}
	// A snapshot older than the log is fine (replay covers the tail); a
	// snapshot newer than anything replayed just stands as loaded.
	void snapshotSeq;
	return { graph, skippedLines, quarantinedSnapshot };
}

/** Append events atomically enough for a local harness (single writer per session). */
export function appendTaskEvents(paths: TaskStatePaths, events: readonly TaskEvent[]): void {
	if (!events.length) return;
	fs.mkdirSync(paths.dir, { recursive: true });
	const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
	fs.appendFileSync(paths.events, payload, "utf8");
}

/** Write materialized snapshot via tmp + rename. */
export function writeTaskSnapshot(paths: TaskStatePaths, graph: TaskGraph): void {
	fs.mkdirSync(paths.dir, { recursive: true });
	const tmp = `${paths.snapshot}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(graph), "utf8");
	fs.renameSync(tmp, paths.snapshot);
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
		const safe = String(sessionId ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 96) || "unknown";
		const dir = path.join(baseDir, safe);
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
