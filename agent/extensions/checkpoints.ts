/**
 * Checkpoints — guaranteed safeguard checkpoints at meaningful events.
 *
 * reminders.ts nudges on time heuristics. What was missing: deterministic
 * checkpoints at the events where LLM failure is most predictable
 * (post-compaction amnesia, unverified edit streaks, repeated verification
 * failures).
 *
 * Every injection is model-only, tiny, and injected directly. 2026-09-02:
 * the governor broker was removed — checkpoints carry their own deterministic
 * hysteresis/dedup (strike counters, once-per-window flags) and fire
 * unconditionally, which is their minimum-guarantee contract.
 *
 * Checks (each once per cycle, hysteresis by design):
 *   - session_compact -> session reminder snapshot and cached todo counts.
 *     Whole reminders only; oversized text is retrievable, never cut mid-constraint.
 *     Per-file receipts are projected from branch history.
 *   - failed verification: 2 consecutive failed bash results -> checkpoint
 *     (strike counter; any successful command resets).
 *   - substantial edits without verification: 8 edit/write calls with zero
 *     successful command/changed-file readback between them -> checkpoint (the minimum-guarantee
 *     independent-verification nudge; the reviewer stays escalation-gated).
 *   - context telemetry is owned by session-signals.ts
 *
 * Shadow mode: PI_CHECKPOINTS=shadow logs would-fire events to
 * ~/.pi/checkpoints/shadow-<sid>.jsonl instead of injecting; PI_CHECKPOINTS=0
 * disables. Default: live.
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@yunuspi/ai";
import { readRemindersRestore } from "./lib/reminders-state.ts";
import {
	checkpointPath,
	fileCheckpoints,
	fileCheckpointText,
} from "./lib/checkpoint-files.ts";
import { createProjectTestLifecycle, createWorkspaceRevision } from "./lib/project-tests.ts";
import { createQualityReviewLifecycle } from "./lib/quality-review.ts";
import { checkpointHistoryIntent } from "./lib/intervention-intents.ts";
import { registerShadowSource } from "./lib/intervention-registry.ts";
import { enforceShared, getSharedSession, noteUserInput, sharedSourceAudit } from "./lib/intervention-shared.ts";
import {
	SESSION_STOP_ENTRY,
	STOP_ALL_RUNS,
	isSessionStopped,
	noteSessionStopped,
	stopGates,
	stopInputUnlocks,
	unlockSessionStop,
} from "./lib/session-stop.ts";

const STATE_DIR = path.join(os.homedir(), ".pi", "checkpoints");
const MODE = process.env.PI_CHECKPOINTS; // undefined | "0" | "shadow"
const SHADOW = MODE === "shadow";
const DISABLED = MODE === "0";

// Tuning (hysteresis: every gate needs repeated/strong evidence, never one
// weak signal).
const VERIFY_STRIKES = 2; // consecutive failed bash results before checkpoint
const EDITS_WITHOUT_VERIFY = 8; // edits with no successful command between
const RESTORE_MAX = 1800; // canonical restore text budget
const STATE_TTL_MS = 30 * 24 * 3600_000; // stale state/shadow files pruned

export interface CheckpointState {
	sid: string;
	verifyStrikes: number; // consecutive failed bash commands
	verifyCheckpoints: number; // fired for the CURRENT failure streak
	editsSinceCommand: number; // successful mutations since a command/readback
	editCheckpointShown: boolean; // one per unverified window
	pendingReadbackPaths: string[];
}

export function defaultState(sid = ""): CheckpointState {
	return {
		sid,
		verifyStrikes: 0,
		verifyCheckpoints: 0,
		editsSinceCommand: 0,
		editCheckpointShown: false,
		pendingReadbackPaths: [],
	};
}

// ── pure logic ──────────────────────────────────────────────────────────

/** One bash result = one evidence sample. Failure needs VERIFY_STRIKES
 * consecutive failures (hysteresis); any success clears the streak AND the
 * unverified-edit window. Returns "verify" when a checkpoint is due. */
export function verifyResult(
	st: CheckpointState,
	failed: boolean,
): "verify" | null {
	if (failed) {
		st.verifyStrikes += 1;
		if (st.verifyStrikes === VERIFY_STRIKES) return "verify";
		return null;
	}
	st.verifyStrikes = 0;
	st.verifyCheckpoints = 0;
	return null;
}

/** An edit with no intervening successful command. Returns "unverified" when
 * the streak hits EDITS_WITHOUT_VERIFY (once per window — a second checkpoint
 * without a command in between would be spam, not signal). */
export function editMade(st: CheckpointState): "unverified" | null {
	st.editsSinceCommand += 1;
	if (st.editsSinceCommand >= EDITS_WITHOUT_VERIFY && !st.editCheckpointShown) {
		st.editCheckpointShown = true;
		return "unverified";
	}
	return null;
}

export function commandRan(st: CheckpointState, failed: boolean): void {
	if (failed) return; // a failed command is not verification evidence
	st.editsSinceCommand = 0;
	st.editCheckpointShown = false;
	st.pendingReadbackPaths = [];
}

// ── bounded reminder snapshot (post-compaction) ──────────────────────────

export interface RestoreInput {
	customReminders?: string[];
	todoCounts?: { pending: number; inProgress: number };
	stateAvailable?: boolean;
	canReadReminders?: boolean;
}

/** Reminder registration is not task scope; later user corrections still win. */
export function restoreText(inp: RestoreInput): string {
	let text =
		"[checkpoints] Post-compaction session reminder snapshot, not a new task. Apply reminders within the current scope; later user corrections take precedence.";
	if (inp.stateAvailable === false)
		return (
			text +
			"\nReminder state unavailable; do not infer that no constraints exist."
		);
	const counts = inp.todoCounts;
	if (
		counts &&
		[counts.pending, counts.inProgress].every(
			(n) => Number.isSafeInteger(n) && n >= 0,
		) &&
		counts.pending + counts.inProgress > 0
	)
		text += `\nCached todo counts (not a completion verdict): ${counts.inProgress} in_progress, ${counts.pending} pending.`;
	const reminders = inp.customReminders ?? [];
	let included = 0;
	for (const reminder of reminders) {
		const line = `\n[custom-reminder] ${JSON.stringify(reminder)}`;
		// Reserve room for an omission notice and its recovery route.
		if (text.length + line.length > RESTORE_MAX - 240) break;
		text += line;
		included++;
	}
	if (included < reminders.length)
		text +=
			`\n${reminders.length - included} reminder(s) omitted, not truncated. ` +
			(inp.canReadReminders === false
				? "Full reminder retrieval is unavailable here; ask the user if missing constraints affect the next action."
				: 'Read complete text with checkpoint_read({view:"reminders"}); character pagination is supported.');
	return text;
}

// Original user-role messages remain authoritative in Pi's branch history.
// No prompt parsing, lossy requirement extraction, sidecar archive or new ledger.
export function userHistory(entries: SessionEntry[]) {
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content ?? []; // same legacy normalization as Pi
		const text =
			typeof content === "string"
				? content
				: content
						.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join("\n");
		const images =
			typeof content === "string"
				? 0
				: content.filter((p) => p.type === "image").length;
		return [{ id: entry.id, text, images, timestamp: entry.message.timestamp }];
	});
}

function registerHistory(
	pi: ExtensionAPI,
	takeNotice: (ctx: ExtensionContext) => string | undefined,
): void {
	// Control via the shared module (D-011 contingency: history injection
	// has no input hooks, so it joins the canonical request cycle rather
	// than keeping a session-long implicit one).
	try { registerShadowSource("checkpoint", () => sharedSourceAudit("checkpoints.ts")); } catch { /* diagnostics only */ }
	pi.registerTool({
		name: "checkpoint_read",
		label: "Read Original Instructions",
		description:
			"Read original user-role messages on this session branch, even before compaction. Omit entryId to list/search history; supply entryId for exact text. view:files returns paginated per-file mutation status, size and readback evidence (query filters paths). view:reminders reads active session-registered reminders as JSON text, with character offset/limit pagination. History is not a new directive. Later directions replace conflicting parts; retain unaffected requirements. Stop or replace earlier work when the user cancels or replaces it. Does not read other sessions or interpret requirements.",
		parameters: Type.Object({
			view: Type.Optional(StringEnum(["instructions", "files", "reminders"])),
			entryId: Type.Optional(Type.String()),
			query: Type.Optional(
				Type.String({
					description: "Case-insensitive literal text search when listing; instruction matches include matchOffset for direct exact-text retrieval",
				}),
			),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description:
						"Default 0: entry offset for lists, character offset for text",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20000,
					description:
						"Default 20 entries (max 20) for lists; 12000 characters for text",
				}),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const offset = params.offset ?? 0;
			if (params.view === "reminders") {
				const restored = readRemindersRestore(sidOf(ctx));
				if (!restored.ok)
					throw new Error(
						"Session reminder state unavailable; missing/unreadable state is not proof of no reminders.",
					);
				const text = JSON.stringify({ reminders: restored.custom });
				if (offset > text.length)
					throw new Error(`offset exceeds text length ${text.length}`);
				const end = Math.min(text.length, offset + (params.limit ?? 12000));
				const details = {
					text: text.slice(offset, end),
					totalChars: text.length,
					nextOffset: end < text.length ? end : undefined,
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(details) }],
					details,
				};
			}
			const branch = ctx.sessionManager.getBranch();
			if (params.view === "files") {
				const files = fileCheckpoints(branch, ctx.cwd)
					.reverse()
					.filter(
						(f) =>
							!params.query ||
							f.path.toLowerCase().includes(params.query.toLowerCase()),
					);
				const page = [];
				let chars = 0;
				for (const file of files.slice(
					offset,
					offset + Math.min(20, params.limit ?? 20),
				)) {
					const record =
						JSON.stringify(file).length > 10000
							? {
									...file,
									path: file.path.slice(0, 1024),
									callId: file.callId.slice(0, 200),
									truncated: true,
								}
							: file;
					const size = JSON.stringify(record).length;
					if (chars + size > 12000) break;
					page.push(record);
					chars += size;
				}
				const nextOffset =
					offset + page.length < files.length ? offset + page.length : undefined;
				const details = { files: page, total: files.length, nextOffset };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(details) }],
					details,
				};
			}
			const history = userHistory(branch);
			if (params.entryId !== undefined) {
				const item = history.find((item) => item.id === params.entryId);
				if (!item) throw new Error("User message not found on the current branch.");
				if (offset > item.text.length)
					throw new Error(`offset exceeds text length ${item.text.length}`);
				const end = Math.min(item.text.length, offset + (params.limit ?? 12000));
				const nextOffset = end < item.text.length ? end : undefined;
				return {
					content: [
						{
							type: "text" as const,
							text:
								item.text.slice(offset, end) +
								(nextOffset === undefined
									? ""
									: `\n[More: checkpoint_read({entryId:${JSON.stringify(item.id)},offset:${nextOffset}})]`) +
								(item.images
									? `\n[${item.images} image attachment(s) remain in the original transcript; this tool retrieves text only.]`
									: ""),
						},
					],
					details: {
						entryId: item.id,
						totalChars: item.text.length,
						nextOffset,
						images: item.images,
					},
				};
			}
			// Escape literal input; RegExp indices refer to the original UTF-16 text.
			// Lowercasing the whole message first can shift offsets (e.g. Turkish İ).
			const query = params.query === undefined ? undefined
				: new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
			const matches = history.flatMap((item) => {
				const matchOffset = query ? item.text.search(query) : undefined;
				return matchOffset === -1 ? [] : [{ ...item, matchOffset }];
			});
			const page = matches.slice(
				offset,
				offset + Math.min(20, params.limit ?? 20),
			);
			const nextOffset =
				offset + page.length < matches.length ? offset + page.length : undefined;
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							entries: page.map((item) => ({
								entryId: item.id,
								chars: item.text.length,
								images: item.images,
								preview: item.text.slice(item.matchOffset ?? 0, (item.matchOffset ?? 0) + 160),
								...(item.matchOffset === undefined ? {} : { matchOffset: item.matchOffset }),
							})),
							total: matches.length,
							nextOffset,
						}),
					},
				],
				details: { total: matches.length, nextOffset },
			};
		},
	});

	pi.registerTool({
		name: "session_stop",
		label: "Stop Session",
		promptGuidelines: [
			"When requested work is complete, session_stop({action:\"stop\", reason:\"...\"}) ends the session cleanly, stopping its active subagent runs and silencing automatic quality/test follow-ups. State observed verification and any remaining gaps honestly. Do not launch reviews, delegates, optional polish or repeated checks just to qualify for stopping; prior review and delegation are informational, not prerequisites. Any new user message resumes the session normally.",
		],
		description:
			"End the main session when requested work is complete, with honest verification and remaining gaps. action:status reports current state and informational review/delegation evidence; action:stop (concrete 20+ character reason) stops this session's active subagent runs, records the stop, silences automatic quality/test follow-ups and ends the turn. It requires no extra review or delegation to become available and does not certify the work. Main session only. Any new user message resumes normally.",
		parameters: Type.Object({
			action: StringEnum(["status", "stop"]),
			reason: Type.Optional(
				Type.String({
					minLength: 20,
					maxLength: 1200,
						description: "Required for stop: completed work, observed verification and any remaining gaps, 20–1200 characters.",
				}),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (process.env.PI_SUBAGENT_CHILD === "1")
				throw new Error("session_stop is main-session only; children cannot stop the parent session.");
			if (SHADOW)
				throw new Error("Session stop is unavailable while checkpoints run in shadow mode.");
			let branch: unknown;
			try {
				branch = ctx.sessionManager.getBranch();
			} catch {
				branch = undefined;
			}
			const gates = stopGates(branch);
			if (params.action === "status") {
				const data = { stopped: isSessionStopped(ctx), gates };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(data) }],
					details: data,
				};
			}
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			if (reason.length < 20)
				throw new Error("Stopping requires a concrete reason of at least 20 characters: what is done and verified.");
			const sessionId = ctx.sessionManager.getSessionId?.();
			const runs: { stopped: string[]; failed: { id: string; error: string }[]; bridge: string } = {
				stopped: [],
				failed: [],
				bridge: "unavailable",
			};
			const bridge = (globalThis as any)[STOP_ALL_RUNS];
			if (typeof sessionId === "string" && sessionId && typeof bridge === "function") {
				try {
					const result = bridge(sessionId) ?? {};
					runs.stopped = Array.isArray(result.stopped) ? result.stopped : [];
					runs.failed = Array.isArray(result.failed) ? result.failed : [];
					runs.bridge = "ok";
				} catch (error) {
					runs.bridge = `error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
				}
			}
			const stopId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			if (!noteSessionStopped(ctx, stopId))
				throw new Error("Cannot identify the session scope; stop refused.");
			try {
				pi.appendEntry?.(SESSION_STOP_ENTRY, {
					stopId,
					reason: reason.slice(0, 1200),
					gates,
					runs: { stopped: runs.stopped.slice(0, 64), failed: runs.failed.slice(0, 16) },
				});
			} catch {
				// The stop holds process-locally; a ledger write failure must not revive the session.
			}
			const data = { stopped: true, stopId, gates, runs };
			return {
				content: [{ type: "text" as const, text: JSON.stringify(data) }],
				details: data,
				terminate: true,
			};
		},
	});

	pi.on("context", (event, ctx) => {
		// Retire only this extension's transient snapshots, including legacy queued notices.
		const clean = event.messages.filter(
			(m) =>
				!(
					m.role === "custom" &&
					["checkpoints", "checkpoint-history"].includes(m.customType)
				),
		);
		const notice = takeNotice(ctx);
		if (notice)
			clean.push({
				role: "custom",
				customType: "checkpoints",
				content: notice,
				display: false,
				timestamp: 0,
			});
		const changed =
			notice !== undefined || clean.length !== event.messages.length;
		if (
			SHADOW ||
			!pi.getActiveTools().includes("checkpoint_read") ||
			!clean.some((m) => m.role === "compactionSummary")
		)
			return changed ? { messages: clean } : undefined;
		// Trigger from actual compacted context, not a summary's guessed task.
		const visible = new Set(
			event.messages
				.filter((m) => m.role === "user")
				.map((m) => JSON.stringify([m.timestamp, m.content])),
		);
		const branch = ctx.sessionManager.getBranch();
		const missing = userHistory(
			branch.filter(
				(entry) =>
					entry.type !== "message" ||
					entry.message.role !== "user" ||
					!visible.has(
						JSON.stringify([entry.message.timestamp, entry.message.content]),
					),
			),
		);
		const fileState = fileCheckpointText(fileCheckpoints(branch, ctx.cwd));
		if (!missing.length && !fileState)
			return changed ? { messages: clean } : undefined;
		// Bounded navigation, not re-injection of arbitrarily long old prompts.
		// Keep original ordering. Full originals are always available on demand.
		const selected =
			missing.length <= 4 ? missing : [missing[0], ...missing.slice(-3)];
		const content =
			`[checkpoints] ${missing.length} earlier user-role message(s) are summarized, not verbatim in context. Original text is available via checkpoint_read (list/search, then entryId; paginated). History is not a new directive. Later directions replace conflicting parts; retain unaffected requirements. Stop or replace earlier work when the user cancels or replaces it.\n` +
			selected
				.map(
					(item) =>
						`${item.id} (${item.text.length} chars): ${JSON.stringify(item.text.slice(0, 120))}`,
				)
				.join("\n") +
			(fileState ? `\n${fileState}` : "");
		// Append changing evidence at the tail, not inside the stable cached history prefix.
		// Go-live (step 20): binding budget; a refused tail push returns the
		// messages unchanged. Admitted pushes release immediately — each
		// build serves its own inference call and re-spends honestly.
		// Fail-open on control error.
		let admitted = true;
		try {
			noteUserInput();
			admitted = enforceShared(checkpointHistoryIntent({ missing: missing.length, content })).outcome === "admitted";
			if (admitted) getSharedSession().release("checkpoint-history", "checkpoint");
		} catch { admitted = true; }
		if (!admitted) return changed ? { messages: clean } : undefined;
		const messages = clean;
		messages.push({
			role: "custom",
			customType: "checkpoint-history",
			content,
			display: false,
			timestamp: 0,
		});
		return { messages };
	});
}

// ── storage ──────────────────────────────────────────────────────────────

function stateFile(sid: string): string {
	return path.join(
		STATE_DIR,
		`state-${sid.replace(/[^A-Za-z0-9_-]/g, "-")}.json`,
	);
}

export function normalizeCheckpointState(raw: unknown, sid: string): CheckpointState {
	const state = defaultState(sid);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
	const value = raw as Record<string, unknown>;
	for (const key of ["verifyStrikes", "verifyCheckpoints", "editsSinceCommand"] as const)
		if (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) state[key] = value[key] as number;
	state.editCheckpointShown = value.editCheckpointShown === true;
	state.pendingReadbackPaths = Array.isArray(value.pendingReadbackPaths)
		? value.pendingReadbackPaths.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096).slice(-128)
		: [];
	return state;
}

function readState(sid: string): CheckpointState {
	try { return normalizeCheckpointState(JSON.parse(fs.readFileSync(stateFile(sid), "utf8")), sid); }
	catch { return defaultState(sid); }
}

function writeState(st: CheckpointState): void {
	const tmp = `${stateFile(st.sid)}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
		fs.chmodSync(STATE_DIR, 0o700);
		fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600, flag: "wx" });
		fs.renameSync(tmp, stateFile(st.sid));
	} catch {
		/* checkpoints must never break a session */
	} finally { try { fs.unlinkSync(tmp); } catch {} }
}

function shadowLog(sid: string, kind: string, detail: string): void {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
		fs.chmodSync(STATE_DIR, 0o700);
		const file = path.join(STATE_DIR, `shadow-${sid.replace(/[^A-Za-z0-9_-]/g, "-")}.jsonl`);
		try { fs.chmodSync(file, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		fs.appendFileSync(
			file,
			JSON.stringify({ ts: Date.now(), kind, detail: detail.slice(0, 200) }) +
				"\n",
			{ mode: 0o600 },
		);
	} catch {
		/* best-effort */
	}
}

// ── extension wiring ─────────────────────────────────────────────────

/** Per-session state files (state-*.json + shadow-*.jsonl) accumulate with no
 * reader after the session ends — prune anything older than the TTL (same 30d
 * policy as reminders.ts). Never deletes the CURRENT session's file. */
function cleanupStale(currentSid: string): void {
	try {
		const cutoff = Date.now() - STATE_TTL_MS;
		const currentFile = stateFile(currentSid);
		for (const name of fs.readdirSync(STATE_DIR)) {
			if (!/^state-.*\.json$|^shadow-.*\.jsonl$/.test(name)) continue;
			const p = path.join(STATE_DIR, name);
			if (p === currentFile) continue;
			if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
		}
	} catch {
		/* retention must never break startup */
	}
}

function sidOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "";
	} catch {
		return "";
	}
}

function batchOf(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager
		.getBranch?.()
		.findLast(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		)?.id;
}

/** Keep one pending snapshot per kind; no next-user-prompt queue. */
function emit(
	pending: Map<string, string>,
	sid: string,
	kind: string,
	content: string,
): void {
	if (SHADOW) {
		shadowLog(sid, kind, content.slice(0, 200));
		return;
	}
	pending.set(kind, content);
}

export default function checkpointsExtension(pi: ExtensionAPI) {
	// Keep all tools/hooks disabled under the documented PI_CHECKPOINTS=0 contract.
	if (DISABLED) return;
	// One workspace revision for tests and reviews of the same tree.
	const revision = createWorkspaceRevision();
	const quality = createQualityReviewLifecycle(pi, { shadow: SHADOW, refresh: ctx => projectTests.start(ctx), tests: () => projectTests.snapshot(), revision });
	const projectTests = createProjectTestLifecycle(pi, { shadow: SHADOW, onFacts: (facts, observe, token) => quality.observe(facts, observe, token), revision });
	let st: CheckpointState | null = null;
	const pending = new Map<string, string>();
	let mutationVersion = 0;
	let lastMutationBatch: string | undefined;
	const starts = new Map<string, { version: number; batch?: string }>();

	const load = (sid: string): CheckpointState => {
		if (!st || st.sid !== sid) st = readState(sid);
		return st;
	};

	registerHistory(pi, (ctx) => {
		const s = load(sidOf(ctx));
		if (s.editsSinceCommand < EDITS_WITHOUT_VERIFY)
			pending.delete("unverified-edits");
		if (s.verifyStrikes < VERIFY_STRIKES) pending.delete("verify-failed");
		const content = [...pending.values(), projectTests.notice(), quality.notice()].filter(Boolean).join("\n");
		pending.clear();
		return content || undefined;
	});
	pi.on("input", (event, ctx) => { projectTests.input(event); quality.input(event); stopInputUnlocks(event, ctx); });
	pi.on("agent_settled", async (event, ctx) => {
		// A stopped session stays silent: no test/review follow-ups revive it.
		if (isSessionStopped(ctx)) return;
		await projectTests.settled(event, ctx);
		await quality.settled(event, ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		pending.delete("unverified-edits");
		pending.delete("verify-failed");
		starts.clear();
		await projectTests.start(ctx);
	});
	pi.on("message_end", async (event, ctx) => {
		if (
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
			pending.clear();
			starts.clear();
		}
		await projectTests.message(event, ctx);
		quality.message(event);
	});
	pi.on("tool_call", async (event, ctx) => {
		if (
			["bash", "read", "read_symbol", "read_enclosing"].includes(event.toolName)
		)
			starts.set(event.toolCallId, {
				version: mutationVersion,
				batch: batchOf(ctx),
			});
		await projectTests.call(event, ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		// A heuristic window is branch-local; authoritative file history remains reconstructible.
		st = defaultState(sidOf(ctx));
		pending.clear();
		starts.clear();
		mutationVersion = 0;
		lastMutationBatch = undefined;
		writeState(st);
		quality.restore(ctx); await projectTests.restore(ctx);
		// A branch rewrite is a new work context; a stop for the old one ends here.
		unlockSessionStop(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => { quality.restore(ctx); await projectTests.restore(ctx); });
	pi.on("session_start", async (_event, ctx) => {
		try {
			quality.restore(ctx); await projectTests.restore(ctx);
			// Restart/reload begins a new heuristic window, not a claim about inherited edits.
			st = defaultState(sidOf(ctx));
			pending.clear();
			starts.clear();
			mutationVersion = 0;
			lastMutationBatch = undefined;
			writeState(st);
			cleanupStale(st.sid);
		} catch {
			/* never break startup */
		}
	});

	// Restore only session-scoped reminders, never the shared cross-project scratchpad.
	pi.on("session_compact", async (event, ctx) => {
		try {
			const sid = sidOf(ctx);
			const s = load(sid);
			writeState(s);
			const rem = readRemindersRestore(sid);
			const restore = restoreText({
				customReminders: rem.custom,
				todoCounts: { pending: rem.pending, inProgress: rem.inProgress },
				stateAvailable: rem.ok,
				canReadReminders: pi.getActiveTools().includes("checkpoint_read"),
			});
			emit(pending, sid, "restore", restore);
			void (event as { reason?: string }).reason; // observability only
		} catch {
			/* restore is best-effort; compaction itself must not fail */
		}
	});

	// A changed-file readback is useful evidence in pure-writing workflows.
	pi.on("tool_result", async (event, ctx) => {
		try {
			await projectTests.result(event, ctx);
			quality.result(event, ctx);
			const sid = sidOf(ctx);
			const s = load(sid);
			const start = starts.get(event.toolCallId);
			starts.delete(event.toolCallId);
			const earlierEvidence =
				start !== undefined &&
				start.version === mutationVersion &&
				(!start.batch || start.batch !== lastMutationBatch);
			if (event.toolName === "bash") {
				if (
					event.content.some(
						(p) =>
							p.type === "text" &&
							p.text.includes("[managed bash] Still running — detached"),
					)
				)
					return;
				const failed = event.isError === true;
				if (earlierEvidence) commandRan(s, failed);
				const due = verifyResult(s, failed);
				if (due) {
					s.verifyCheckpoints += 1;
					writeState(s);
					emit(
						pending,
						sid,
						"verify-failed",
						`[checkpoints] ${s.verifyStrikes} consecutive bash calls failed. If these were checks, fix the smallest failure or report the blocker. A command's exit status alone does not prove task completion.`,
					);
				} else {
					writeState(s);
				}
				return;
			}
			if (
				["read", "read_symbol", "read_enclosing"].includes(event.toolName) &&
				!event.isError &&
				earlierEvidence &&
				typeof event.input.path === "string"
			) {
				if (
					s.pendingReadbackPaths.includes(checkpointPath(event.input.path, ctx.cwd))
				) {
					commandRan(s, false);
					writeState(s);
				}
				return;
			}
			if (event.toolName === "edit" || event.toolName === "write") {
				if (event.isError) return;
				mutationVersion++;
				lastMutationBatch = batchOf(ctx);
				if (typeof event.input.path === "string")
					s.pendingReadbackPaths = [
						...new Set([
							...s.pendingReadbackPaths,
							checkpointPath(event.input.path, ctx.cwd),
						]),
					].slice(-128);
				const due = editMade(s);
				writeState(s);
				if (due)
					emit(
						pending,
						sid,
						"unverified-edits",
						`[checkpoints] ${s.editsSinceCommand} mutating actions without a successful command or readback of a changed file. For a writing workflow, read back the changed regions; for code, use focused diagnostics/tests. Existing background checks may already cover this. This counter is not a verification verdict.`,
					);
				return;
			}
		} catch {
			/* ignore */
		}
	});

	// Effective context telemetry is owned by session-signals.ts.

	pi.on("session_shutdown", async (_event, ctx) => {
		projectTests.shutdown();
		quality.shutdown();
		try {
			writeState(load(sidOf(ctx)));
		} catch {
			/* ignore */
		}
	});
}
