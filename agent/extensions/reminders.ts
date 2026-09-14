/**
 * Soft Reminders — todo-list upkeep, context-drift check-in, and reliable
 * user-registered /reminder scheduling.
 *
 * Problem class (user-observed): agents forget their initial briefing, forget
 * to update the todo list as they complete items (list looks unfinished when
 * the work is nearly done), and overthink scope the task never asked for.
 * The user asked for soft, infrequent nudges — not an obsessive loop.
 *
 * 2026-09-02 governor removal: this extension used to gate every injection
 * through the governor broker (decide/consume + budget rationing). The broker
 * is gone — reminders now inject directly, with their own deterministic
 * hysteresis (per-session caps) and the exact per-reminder schedule below.
 *
 * 2026-09-02 caution trigger: fourth automatic reminder. A run that performed
 * mutating actions (write/edit tools, destructive-class bash) arms ONE caution
 * check-in for the NEXT submission — gap/cap/freshness limited like the rest.
 * Signal-driven, not time-based: an untouched session is never nagged.
 *
 * 2026-09-04 idle-wake fix: the mid-run turn_end steer used to fire on ANY
 * turn_end with a due reminder — including the run's FINAL turn (no tool
 * calls). pi's agent loop drains the steering queue immediately after the
 * turn_end emit and its inner loop continues while messages are pending, so
 * a steer queued at the final turn RE-LAUNCHED the LLM after the run had
 * finished. With the 2-min reminder grid and ~2-min ack cycles that became a
 * self-sustaining idle loop (observed: delivered=45, streakTurns=21,
 * promptCount=2 — the agent woke every ~2 min to answer "Idle — nothing
 * pending"). Steers now require toolResults.length > 0: the turn executed
 * tools, the run is genuinely continuing, and the message lands BETWEEN
 * turns. A reminder that falls due at run end simply stays due (schedule
 * untouched) and fires at the next before_agent_start — the documented
 * first-available-lifecycle-event rule.
 *
 * 2026-09-08 reasoning guard: strong repeated-passage evidence during active
 * thinking can queue one normal steer before completion. It never aborts the
 * stream, starts an idle agent, or uses elapsed time as evidence. The native
 * loop consumes that steer at its next boundary; Stop remains authoritative.
 *
 * Manual /reminder schedule (the reliability contract):
 *  - A newly registered `/reminder` is delivered immediately; its first
 *    repeat is `nextFireAt = createdAt + 2 min`, then every `previous
 *    nextFireAt + 2 min` thereafter — a grid anchored at createdAt, never
 *    `now + 2 min`, so the cadence cannot drift.
 *  - Each reminder has an INDEPENDENT schedule; firing one never resets,
 *    delays, or merges another.
 *  - The agent may be busy inside a tool call or inference, so exact
 *    wall-clock interruption is impossible: a reminder whose `nextFireAt` has
 *    passed fires at the FIRST available lifecycle event (before_agent_start,
 *    or a mid-run turn_end steer), with its cadence preserved.
 *  - Several overdue reminders are delivered together in ONE compact message;
 *    each reminder's schedule advances independently.
 *  - After a long tool, idle period, or restore, overdue reminders are
 *    delivered at the first opportunity and their `nextFireAt` is advanced by
 *    WHOLE two-minute intervals until it lies in the future (never `now + 2m`),
 *    so a long downtime cannot drift the grid or spawn a catch-up burst.
 *  - Persisted atomically per session: id, text, createdAt, nextFireAt,
 *    active/completed state. Delivery dedup is structural — a delivered
 *    occurrence has its nextFireAt advanced (persisted), so it cannot fire
 *    twice; there is no generic cooldown that could suppress an independent
 *    reminder.
 *  - Comprehension: a reminder looping every 2 min carries the user's full
 *    bounded text on EVERY occurrence. Post-compaction, checkpoints.ts
 *    re-injects the full active texts.
 *  - Delivery framing (2026-09-02 audit fix): a manual delivery is a
 *    directive — the header tells the agent to comply now, and the line is
 *    the user's own words with no filler. Ambient-only check-ins keep the
 *    soft "not a new instruction" framing. Manual-bearing injections use
 *    display: true so the cadence is visible in the TUI and session export
 *    (both filter custom messages on display); ambient-only stay silent.
 *
 * Automatic reminders keep their per-session caps and share one message with
 * due manual reminders. Loop checks compare bounded hashes of tool inputs and
 * results across continuing turns; 3 unchanged observations trigger at most
 * one short nudge per run, 3 per session, with an independent 12-minute gap.
 * Successful actions reset the evidence. No inference, timers, reasoning-token
 * guesses, forced edits, or automatic thinking-level changes.
 *
 * Cost: one tiny state file (~/.pi/reminders/state-<sid>.json) plus a
 * metadata-only first-prompt orientation receipt; ambient-only injections are
 * display:false; manual-bearing ones are also shown in the TUI/export. Delete
 * the state file to remove scheduled reminders.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { registerHarnessActivity } from "./lib/harness-activity.ts";
import { registerToolDiscovery, compactSkillCatalog } from "./lib/tool-discovery.ts";
import { createRelevantGuidance } from "./lib/relevant-guidance.ts";
import { createLoopTracker, repeatedReasoningNotice, reduceRepeatedReasoningBudget } from "./lib/stall-core.ts";
import { replayFromBranch } from "./rpiv-todo/state/replay.ts";
import {
	MANUAL_INTERVAL_MS,
	readRemindersState,
	remindersStateFile,
	type ManualReminder,
	type ReminderState,
	writeRemindersState,
} from "./lib/reminders-state.ts";
import {
	COOLDOWN_MS,
	WINDOW_MS,
} from "../scripts/patches/retry-429-policy.mjs";
import {
	buildHarnessOrientation,
	hasOrientationReceipt,
	markOrientationDelivered,
} from "./lib/harness-orientation.ts";

const STATE_DIR = path.join(os.homedir(), ".pi", "reminders");

// Drift / todo tuning — the anti-nag knobs.
const TODO_IDLE_MS = 8 * 60_000; // open todos, no mutation this long -> nudge
const TODO_GAP_MS = 10 * 60_000; // min gap between todo reminders
const TODO_MAX = 3; // per-session cap
const DRIFT_MIN_AGE_MS = 25 * 60_000; // session this old -> drift may fire
const DRIFT_MIN_RUNS = 8; // ...or this many user submissions
const REMIND_GAP_MS = 12 * 60_000; // min gap between drift reminders
const DRIFT_MAX = 2; // per-session cap
// Long answers and slow reasoning are not evidence of a loop. Observe repeated
// tool inputs AND unchanged results instead; no tokenizer or model-name ladder.
const OT_GAP_MS = 2 * 60_000; // independent cooldown; one nudge per run, not a lifetime quota
// Caution (mutating-action) reminder — fires on the submission AFTER a run
// that mutated something (write/edit tools, destructive-class bash).
const CAUTION_GAP_MS = REMIND_GAP_MS; // min gap between caution reminders
const CAUTION_MAX = 3; // per-session cap
const CAUTION_FRESH_MS = 30 * 60_000; // mutations older than this are stale
const CUSTOM_MAX = 4000; // max chars of a registered reminder text (long reminders allowed)
// Bound whole reminder lines, not a truncated tail marked as delivered.
const MANUAL_TEXT_MAX = 2 * (CUSTOM_MAX + 20);

// Contextual safety one-liners — injected only when the prompt touches the
// topic, each at most once per session.
const CONTEXT_RULES: Array<{ tag: string; match: RegExp; text: string }> = [
	{
		tag: "harness",
		match:
			/\b(?:Yunus Pi|Pi harness|harness)\b|verify-harness|scripts\/patches|\.pi\/agent/i,
		text:
			"Preservation: harness edits go in ~/.pi/agent/extensions/*.ts or scripts/patches/*.mjs; verify-harness.mjs --fix re-applies patches after ANY update; never hand-edit node_modules.",
	},
	{
		tag: "rateLimit",
		match:
			/^(?=[\s\S]*\b(?:pi|harness|llm|inference|openrouter|cerebras|deepseek|friendli|orcarouter|runinfra|together)\b)(?=[\s\S]*(?:\b(?:429|503)\b|rate[- ]?limit|service unavailable|upstream_unavailable|backoff|cooldown|retry every))/i,
		// WHY templated: retry-429-policy.mjs is the policy authority; restating
		// its constants here drifted once (audit F7). Derived, never duplicated.
		text: `Cooldown-class provider errors (429 / provider-unavailable 503 / gateway or upstream stream failure): retry every ${Math.round(COOLDOWN_MS / 1000)}s (no exponential backoff); ~${Math.round(WINDOW_MS / 60000)} min continuous failure -> pause until the user's next message.`,
	},
	{
		tag: "providers",
		match:
			/^(?=[\s\S]*\b(?:pi|harness|llm|inference|openrouter|cerebras|deepseek|friendli|orcarouter|runinfra|together)\b)(?=[\s\S]*\b(?:providers?|failover|outage)\b)/i,
		// Provider list mirrors live-models.ts REFRESHER_IDS (baseten/lmstudio
		// removed 2026-09-01 — no longer registered).
		text:
			"Providers: provider outage != model failure — fail over to a compatible provider for the same model.",
	},
];
// Conservative destructive-bash heuristic for the caution reminder. False
// negatives are fine (we merely skip a nudge); false positives would nag on
// every benign command, so the list stays short: write/append redirects
// (excluding => arrows and 2>&1-style merges), delete/move/block tools,
// in-place sed, permission changes, and git history mutations.
const BASH_MUT_RE = new RegExp(
	[
		">>|(^|[^>|=])>[^|&>]",
		"\\b(?:rm|mv|dd|shred|truncate|wipefs)\\b",
		"\\bsed\\b[^\\n|;&]*\\s-i\\b",
		"\\b(?:chmod|chown|chgrp)\\b",
		"\\bgit\\s+(?:reset|checkout|restore|clean|rebase|commit|merge)\\b",
	].join("|"),
	"i",
);

/** WHY: the caution trigger must classify the same way everywhere (state
 * shadowing and text drift apart when the predicate is inlined at both sites).
 * Failed (isError) actions are excluded by the caller — a failed rm taught
 * nothing and needs no nudge. */
export function isMutatingToolResult(
	toolName: string,
	input: Record<string, unknown> | undefined,
): boolean {
	if (toolName === "write" || toolName === "edit") return true;
	if (toolName === "bash") {
		const cmd = (input as { command?: unknown } | undefined)?.command;
		return typeof cmd === "string" && BASH_MUT_RE.test(cmd);
	}
	return false;
}

const STATE_TTL_MS = 30 * 24 * 3600_000; // stale state files pruned

export type { ManualReminder, ReminderState } from "./lib/reminders-state.ts";

// ------------------------------------------------------------- pure logic

export function shouldFire(
	st: ReminderState,
	now: number,
	opts?: Partial<{
		todoIdleMs: number;
		todoGapMs: number;
		todoMax: number;
		driftMinAgeMs: number;
		driftMinRuns: number;
		remindGapMs: number;
		driftMax: number;
		cautionMax: number;
		cautionGapMs: number;
		cautionFreshMs: number;
	}>,
): { todo: boolean; drift: boolean; caution: boolean } {
	const o = {
		todoIdleMs: TODO_IDLE_MS,
		todoGapMs: TODO_GAP_MS,
		todoMax: TODO_MAX,
		driftMinAgeMs: DRIFT_MIN_AGE_MS,
		driftMinRuns: DRIFT_MIN_RUNS,
		remindGapMs: REMIND_GAP_MS,
		driftMax: DRIFT_MAX,
		cautionMax: CAUTION_MAX,
		cautionGapMs: CAUTION_GAP_MS,
		cautionFreshMs: CAUTION_FRESH_MS,
		...opts,
	};
	// Todo: open tasks + no mutation for a while + gap + cap + not the first shot.
	const todo =
		st.hasPending &&
		st.lastTodoActionAt > 0 &&
		now - st.lastTodoActionAt >= o.todoIdleMs &&
		now - st.lastTodoRemindAt >= o.todoGapMs &&
		st.todoReminders < o.todoMax &&
		st.promptCount >= 2;
	// Drift: session old enough (or enough submissions) + gap + cap.
	const drift =
		st.hasPending &&
		st.driftReminders < o.driftMax &&
		now - st.lastRemindAt >= o.remindGapMs &&
		(now - st.startedAt >= o.driftMinAgeMs || st.promptCount >= o.driftMinRuns);
	// Caution: a recent run mutated something (write/edit tools or
	// destructive-class bash). Armed by tool_result, consumed by ONE fire;
	// gap/cap/freshness keep it a soft, infrequent nudge.
	const caution =
		st.mutPending &&
		st.cautionReminders < o.cautionMax &&
		now - st.lastCautionAt >= o.cautionGapMs &&
		now - st.lastMutAt <= o.cautionFreshMs &&
		st.promptCount >= 2;
	return { todo, drift, caution };
}

/** Oldest due reminders that fit whole in one message. Unselected reminders
 * remain due for the next continuing turn or user prompt; no timer wake. */
export function dueManualReminders(
	st: ReminderState,
	now: number,
): ManualReminder[] {
	const due = st.manual
		.filter((r) => r.active && r.nextFireAt <= now)
		.sort((a, b) => a.nextFireAt - b.nextFireAt);
	let length = 0;
	const selected: ManualReminder[] = [];
	for (const r of due) {
		const size = manualLine(r).length + 1;
		if (length + size > MANUAL_TEXT_MAX) break;
		selected.push(r);
		length += size;
	}
	return selected;
}

/** Normal fire: advance exactly one 2-min interval (grid anchored at createdAt;
 * never `now + 2min`). */
export function advanceOne(r: ManualReminder): void {
	r.nextFireAt += MANUAL_INTERVAL_MS;
}

/** Coalesce missed ticks on the original grid, including long live tools. */
export function catchUp(r: ManualReminder, now: number): void {
	if (r.nextFireAt <= now) {
		r.nextFireAt +=
			(Math.floor((now - r.nextFireAt) / MANUAL_INTERVAL_MS) + 1) *
			MANUAL_INTERVAL_MS;
	}
}

function fmtAgo(now: number, ts: number): string {
	return `${Math.max(1, Math.round((now - ts) / 60_000))}m`;
}

function oneLine(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function manualLine(r: ManualReminder): string {
	// The user's accepted text is the instruction. Repeat it exactly on every
	// occurrence so an important suffix cannot disappear between re-anchors.
	// Selection is bounded by MANUAL_TEXT_MAX before this line is rendered.
	return `[custom-reminder] ${r.text}`;
}

export function reminderText(
	st: ReminderState,
	sid: string,
	now: number,
	fire: { todo: boolean; drift: boolean; caution?: boolean },
	dueManual: ManualReminder[],
	context?: string[],
	todoTasks: Array<{id?: number; subject?: string; status?: string; blockedBy?: number[]}> = [],
): string {
	const lines: string[] = dueManual.length > 0
		? [`[reminders] sid ${sid.slice(0, 6)} — ${dueManual.length} user-registered reminder(s) due. Comply with them in your current task now; they re-fire every ~2 min until cleared with /reminder clear.`]
		: [];
	if (context && context.length) lines.push(context.join("\n"));
	if (fire.todo && st.hasPending) {
		const parts: string[] = [];
		if (st.inProgressCount > 0) parts.push(`${st.inProgressCount} in_progress`);
		if (st.pendingCount > 0) parts.push(`${st.pendingCount} pending`);
		const open = todoTasks.filter(t => (t.status === "pending" || t.status === "in_progress") && Number.isSafeInteger(t.id) && typeof t.subject === "string");
		const items = open.slice(0,3).map(t => `#${t.id} [${t.status}] ${JSON.stringify(oneLine(t.subject!,160))}${t.blockedBy?.length ? ` (blocked by ${t.blockedBy.slice(0,5).map(id=>"#"+id).join(", ")})` : ""}`).join("; ");
		lines.push(`Open todos: ${parts.join(", ")} — last todo checkpoint ${fmtAgo(now, st.lastTodoActionAt)} ago.` +
			(items ? ` Recorded items: ${items}${open.length>3 ? `; ${open.length-3} more (todo list)` : ""}.` : ' Use todo list to inspect the current items.') +
			` Reconcile the hierarchical plan with the user's latest scope; add missing executable children, use todo list view=frontier for ready work, and record evidence before completion. Concurrent steps need separate owners/scopes; keep your own session purpose.`);

	}
	if (fire.caution) {
		lines.push(
			`[signal] Since the previous mutation caution (or session start), ${st.runMutCount > 0 ? st.runMutCount : "an uncounted number of"} successful mutation-capable tool call(s) were recognized. ` +
				"This is not a filesystem audit: failed/partial operations and unrecognized shell mutations may be missing. " +
				"When editing or appending to a file, make sure you do not accidentally replace its full contents if that is not your intention; prefer targeted edits, and verify the result afterwards.",
		);
	}
	if (fire.drift) {
		lines.push(
			"Stay within the user's requested scope. Finish when the requested result and required checks are done; report any remaining blocker. " +
				"Do not add work merely because this check-in appeared.",
		);
	}
	for (const r of dueManual) lines.push(manualLine(r));
	const deferred =
		st.manual.filter((r) => r.active && r.nextFireAt <= now).length -
		dueManual.length;
	if (deferred > 0)
		lines.push(
			`${deferred} more reminder(s) remain due for the next continuing turn or user prompt.`,
		);
	// The selected manual lines are bounded; ambient lines are fixed templates.
	// Never truncate here: every selected reminder is about to count as delivered.
	return lines.join("\n");
}

// ---------------------------------------------------------------- storage
// Schema + file layout live in lib/reminders-state.ts (shared with
// checkpoints.ts's canonical restore reader).

const readState = readRemindersState;
const writeState = writeRemindersState;
function cleanupStale(currentSid: string): void {
	try {
		const cutoff = Date.now() - STATE_TTL_MS;
		const currentFile = remindersStateFile(currentSid);
		for (const name of fs.readdirSync(STATE_DIR)) {
			if (!/^state-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
			const p = path.join(STATE_DIR, name);
			if (p === currentFile) continue;
			const stat = fs.lstatSync(p);
			if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(p);
		}
	} catch {
		/* no dir yet — fine */
	}
}

// ---------------------------------------------------------------- helpers

function sidOf(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId() || "";
}

/** WHY on purpose, never silent: every reminders handler used to be a bare
 * `catch {}` that erased failures with zero trace — an exception raised
 * inside before_agent_start looks EXACTLY like "reminder never fired" with no
 * way to know why. console.error is the harness convention (checkpoints.ts
 * logs restores this way). Behavior is otherwise unchanged. */
function logReminderErr(where: string, err: unknown): void {
	try {
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(`[reminders] ${where}: ${msg}`);
	} catch {
		/* logging itself must never throw */
	}
}

// ---------------------------------------------------------------- extension

export default function remindersExtension(pi: ExtensionAPI) {
  registerToolDiscovery(pi);
  if (process.env.PI_SUBAGENT_CHILD !== "1") registerHarnessActivity(pi);
	// Children share skill routing/read receipts without inheriting the parent's
	// manual reminder timers, todo nudges or continuation messages.
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		const guidance = createRelevantGuidance(pi);
		for (const hook of ["session_start", "session_switch", "session_compact"] as const)
			pi.on(hook, (_event, ctx) => { guidance.restore(ctx); });
		pi.on("input", (event) => { if (event.source !== "extension") guidance.userInput(); });
		pi.on("before_agent_start", (event, ctx) => { guidance.start(event, ctx); });
		pi.on("tool_call", (event, ctx) => { if (!ctx.signal?.aborted) return guidance.beforeToolCall(event); });
		pi.on("tool_result", (event) => { guidance.record(event); });
		return;
	}
	// Per-session live state; sid "" (unknown) is tolerated.
	const live = new Map<string, ReminderState>();
	const todoSnapshots = new WeakMap<ReminderState, Array<{id?: number; subject?: string; status?: string; blockedBy?: number[]}>>();
	const guidance = createRelevantGuidance(pi);
	let loop = createLoopTracker();
	let recoveryRoute: { provider: string; model: string } | undefined;
	let thinkingChars = 0, scannedChars = 0, streamingSteered = false;
	const terminatingTools = new Set<string>();
	// before_agent_start does not carry the input source. Track the real human
	// input event so an extension wake before the first prompt cannot consume
	// the one orientation opportunity, while continuation wakes stay silent.
	const pendingHumanPrompts = new Set<string>();
	const load = (sid: string): ReminderState => {
		let st = live.get(sid);
		if (!st) {
			st = readState(sid);
			live.set(sid, st);
		}
		return st;
	};

	const advanceDelivered = (r: ManualReminder, now: number) => {
		r.delivered += 1;
		catchUp(r, now);
	};
	const updateTodoCounts = (st: ReminderState, tasks: Array<{ id?: number; subject?: string; status?: unknown; blockedBy?: number[] }>) => {
		todoSnapshots.set(st, tasks.filter(t => t.status === "pending" || t.status === "in_progress").map(t=>({id:t.id,subject:t.subject,status:String(t.status),blockedBy:t.blockedBy})));
		st.pendingCount = tasks.filter((t) => t?.status === "pending").length;
		st.inProgressCount = tasks.filter((t) => t?.status === "in_progress").length;
		st.hasPending = st.pendingCount + st.inProgressCount > 0;
	};
	const restoreTodos = (ctx: ExtensionContext, st: ReminderState) => {
		if (typeof ctx.sessionManager.getBranch !== "function") return;
		// The todo tool owns branch replay; the reminder sidecar is only a cache.
		updateTodoCounts(st, replayFromBranch(ctx).tasks);
		// Branch navigation/reload starts a fresh idle window, not immediate nagging.
		st.lastTodoActionAt = st.hasPending ? Date.now() : 0;
	};

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		recoveryRoute = undefined;
		loop = createLoopTracker();
		try {
			guidance.restore(ctx);
			const sid = sidOf(ctx);
			if (event.reason === "startup" || event.reason === "new") cleanupStale(sid);
			const st = load(sid);
			restoreTodos(ctx, st);
			writeState(sid, st);
		} catch (err) {
			logReminderErr("session_start", err);
		}
	});

	pi.on("session_compact", (_event, ctx) => { recoveryRoute = undefined; loop = createLoopTracker(); guidance.restore(ctx); });

	pi.on("session_tree", (_event, ctx) => {
		recoveryRoute = undefined;
		loop = createLoopTracker();
		try {
			guidance.restore(ctx);
			const sid = sidOf(ctx);
			const st = load(sid);
			restoreTodos(ctx, st);
			writeState(sid, st);
		}
		catch (err) { logReminderErr("session_tree", err); }
	});

	// Shadow the todo tool's per-session state from its result details —
	// machine-readable, no text parsing. Inert when rpiv-todo is not loaded.
	// Completed tool results also feed loop evidence and arm mutation caution.
	pi.on("tool_result", async (event, ctx) => {
		try {
			loop.record(event);
			guidance.record(event);
			if (event.toolName === "todo" && !event.isError) {
				const d = event.details as
					| { action?: unknown; error?: unknown; tasks?: Array<{ status?: unknown }> }
					| undefined;
				if (Array.isArray(d?.tasks)) {
					const sid = sidOf(ctx);
					const st = load(sid);
					updateTodoCounts(st, d.tasks);
					if (
						d.error === undefined &&
						d.action &&
						d.action !== "list" &&
						d.action !== "get" &&
						d.action !== "error"
					) {
						st.lastTodoActionAt = Date.now();
					}
					writeState(sid, st);
				}
				return;
			}
			// Caution arm: a completed mutating action nudges the NEXT check-in.
			// (isError excluded — a failed rm taught nothing and needs no nudge.)
			if (!event.isError && isMutatingToolResult(event.toolName, event.input)) {
				const sid = sidOf(ctx);
				if (!sid) return;
				const st = load(sid);
				st.mutPending = true;
				st.lastMutAt = Date.now();
				st.runMutCount += 1;
				writeState(sid, st);
			}
		} catch (err) {
			logReminderErr("tool_result", err);
		}
	});

	// One combined check-in per user submission: todo/drift/caution +
	// every due manual reminder + any contextual safety rule — a single message.
	const prepareReminderStart = async (_event: any, ctx: ExtensionContext) => {
		try {
			const sid = sidOf(ctx);
			if (!sid) return undefined;
			guidance.start(_event, ctx);
			const hints = guidance.candidates();
			const st = load(sid);
			st.promptCount += 1;
			const now = Date.now();
			// A single fixed orientation belongs beside the human's first prompt.
			// It is optional, capability-grounded, and persisted independently of
			// the reminder schema so reload/resume cannot repeat it. Children and
			// extension-generated continuations never receive this note.
			const activeTools = pi.getActiveTools?.() ?? [];
			const humanFirstPrompt =
				process.env.PI_SUBAGENT_CHILD !== "1" &&
				pendingHumanPrompts.has(sid) &&
				!hasOrientationReceipt(sid);
			if (pendingHumanPrompts.has(sid)) pendingHumanPrompts.delete(sid);
			const orientation =
				humanFirstPrompt && buildHarnessOrientation(activeTools, _event.prompt);
			// An explicit opt-out consumes the first-prompt opportunity too.
			if (humanFirstPrompt && !orientation) markOrientationDelivered(sid);
			const fire = shouldFire(st, now);
			const dueManual = dueManualReminders(st, now);
			// Contextual safety rules: inject only the slices whose topic the
			// prompt actually touches, each at most once per session.
			const ctxMatches = CONTEXT_RULES.filter(
				(r) => !st.shownCtx.includes(r.tag) && r.match.test(_event.prompt ?? ""),
			);
			if (
				hints.length === 0 &&
				!orientation &&
				ctxMatches.length === 0 &&
				!fire.todo &&
				!fire.drift &&
				!fire.caution &&
				dueManual.length === 0
			) {
				writeState(sid, st);
				return undefined;
			}
			const content = reminderText(
				st,
				sid,
				now,
				fire,
				dueManual,
				[
					...(orientation ? [orientation] : []),
					...ctxMatches.map((r) => r.text),
					...hints.map((h) => `[capability hint] ${h.text}`),
				],
				todoSnapshots.get(st),
			);
			if (!content.trim()) { writeState(sid, st); return undefined; }
			// Advance schedules BEFORE returning: a delivered occurrence cannot
			// re-fire from a later lifecycle event (structural dedup).
			for (const r of dueManual) advanceDelivered(r, now);
			for (const r of ctxMatches) st.shownCtx.push(r.tag);
			if (orientation) markOrientationDelivered(sid);
			guidance.commit(hints);
			if (fire.todo) {
				st.todoReminders += 1;
				st.lastTodoRemindAt = now;
			}
			if (fire.drift) st.driftReminders += 1;
			if (fire.caution) {
				st.cautionReminders += 1;
				st.lastCautionAt = now;
				st.mutPending = false; // consumed: one fire per armed mutation
				st.runMutCount = 0; // consumed here, never by an internal recovery run
			}
			st.lastRemindAt = now;
			writeState(sid, st);
			return {
				message: {
					customType: "reminders",
					content,
					// Manual reminders are the user's own feature: they must be
					// visible where the user looks (TUI + session export both
					// filter on display). Ambient-only injections stay quiet.
					display: dueManual.length > 0,
				},
			};
		} catch (err) {
			logReminderErr("before_agent_start", err);
			return undefined;
		}
	};
	pi.on("before_agent_start", async (event, ctx) => {
		const result = await prepareReminderStart(event, ctx);
		// Local guidance captures the full inventory before its wire projection.
		const systemPrompt = compactSkillCatalog(event, pi.getActiveTools?.() ?? []);
		return systemPrompt === undefined ? result : {...(result ?? {}), systemPrompt};
	});

	// Only current-run observations are relevant; never blame the next task/model.
	pi.on("agent_start", () => {
		recoveryRoute = undefined;
		loop = createLoopTracker();
	});
	pi.on("model_select", () => {
		recoveryRoute = undefined;
		const nudged = loop.nudged;
		loop = createLoopTracker();
		loop.nudged = nudged;
	});
	pi.on("turn_start", () => {
		thinkingChars = scannedChars = 0;
		streamingSteered = false;
		terminatingTools.clear();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.result.terminate === true) terminatingTools.add(event.toolCallId);
	});

	// Streaming detection queues normal Pi steering; never abort/restart the
	// transport or insert a synthetic user turn. User steering takes priority.
	pi.on("message_update", (event, ctx) => {
		if (loop.nudged || ctx.signal?.aborted || ctx.isIdle?.() !== false || ctx.hasPendingMessages?.()) return;
		const delta = event.assistantMessageEvent;
		if (delta?.type !== "thinking_delta" || typeof delta.delta !== "string") return;
		thinkingChars += delta.delta.length;
		if (thinkingChars > 128_000 || thinkingChars - scannedChars < 2_048) return;
		scannedChars = thinkingChars;
		const m = event.message;
		if (m.role !== "assistant" || m.content.some(b => b.type === "toolCall" || b.type === "text" && b.text.trim())) return;
		const sid = sidOf(ctx);
		if (!sid) return;
		const st = load(sid), now = Date.now();
		if (st.lastOverthinkAt && now - st.lastOverthinkAt < OT_GAP_MS) return;
		const nudge = repeatedReasoningNotice(m);
		if (!nudge) return;
		try {
			pi.sendMessage({ customType: "reminders", content: nudge, display: false }, { deliverAs: "steer" });
			loop.nudged = true;
			streamingSteered = true;
			if (ctx.model) recoveryRoute = { provider: ctx.model.provider, model: ctx.model.id };
			st.overthinkReminders++;
			st.lastOverthinkAt = now;
			writeState(sid, st);
		} catch (err) { logReminderErr("reasoning steering", err); }
	});

	pi.on("input", (event, ctx) => {
		recoveryRoute = undefined;
		if (event.source !== "extension") {
			try {
				const sid = sidOf(ctx);
				if (sid) pendingHumanPrompts.add(sid);
			} catch { /* a closing session has no orientation opportunity */ }
			loop = createLoopTracker();
			guidance.userInput();
		}
	});
	pi.on("tool_call", (event, ctx) => {
		if (ctx.signal?.aborted) return;
		const review = guidance.beforeToolCall(event);
		if (review) return review;
		const reason = loop.block(event);
		if (reason) return {block: true, reason};
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!recoveryRoute || ctx.signal?.aborted) return;
		if (ctx.model?.provider !== recoveryRoute.provider || ctx.model?.id !== recoveryRoute.model || event.payload?.model !== recoveryRoute.model) return;
		recoveryRoute = undefined;
		const next = reduceRepeatedReasoningBudget(event.payload);
		return next === event.payload ? undefined : next;
	});

	pi.on("turn_end", async (event, ctx) => {
		try {
			const sid = sidOf(ctx);
			const m = event.message;
			if (!sid || m.role !== "assistant") return;
			// Never enqueue into a final/failed/aborted turn: a steer would revive it.
			if (
				!event.toolResults?.length ||
				ctx.signal?.aborted ||
				event.toolResults.every((r) => terminatingTools.has(r.toolCallId)) ||
				(m.stopReason && m.stopReason !== "toolUse")
			) {
				const nudged = loop.nudged;
				loop = createLoopTracker();
				loop.nudged = nudged;
				if (!streamingSteered || ctx.signal?.aborted || m.stopReason === "error" || m.stopReason === "aborted") recoveryRoute = undefined;
				return;
			}
			const st = load(sid);
			const now = Date.now();
			const reasoning = loop.nudged ? undefined : repeatedReasoningNotice(m);
			const candidate = loop.finishTurn() ?? reasoning;
			const nudge =
				!loop.nudged &&
				(st.lastOverthinkAt === 0 || now - st.lastOverthinkAt >= OT_GAP_MS)
					? candidate
					: undefined;
			const dueManual = dueManualReminders(st, now);
			const hints = guidance.candidates();
			if (!nudge && !hints.length && dueManual.length === 0) return;
			pi.sendMessage(
				{
					customType: "reminders",
					content: reminderText(
						st,
						sid,
						now,
						{ todo: false, drift: false },
						dueManual,
						[...(nudge ? [nudge] : []), ...hints.map((h) => `[capability hint] ${h.text}`)],
					),
					display: dueManual.length > 0,
				},
				{ deliverAs: "steer" },
			);
			// A rejected queue operation must not consume the reminder or nudge.
			guidance.commit(hints);
			if (nudge) {
				loop.nudged = true;
				if (reasoning && ctx.model) recoveryRoute = { provider: ctx.model.provider, model: ctx.model.id };
				st.overthinkReminders += 1;
				st.lastOverthinkAt = now;
			}
			for (const r of dueManual) advanceDelivered(r, now);
			writeState(sid, st);
		} catch (err) {
			logReminderErr("turn_end", err);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		recoveryRoute = undefined;
		loop = createLoopTracker();
		try {
			const sid = sidOf(ctx);
			if (sid) writeState(sid, load(sid));
			live.clear();
		} catch (err) {
			logReminderErr("session_shutdown", err);
		}
	});

	// /reminder — register a line that reliably re-reminds the main agent every
	// 2 min of active work, on an exact per-reminder schedule.
	pi.registerCommand("reminder", {
		description:
			"Remind the main agent every ~2 min — usage: /reminder <text> | list | clear [n|all]",
		argumentHint: "<text|list|clear [n|all]>",
		handler: async (args, ctx) => {
			try {
				const sid = sidOf(ctx);
				if (!sid) {
					ctx.ui.notify(
						"reminder: no session id yet — retry in a moment",
						"warning",
					);
					return;
				}
				const st = load(sid);
				const arg = args.trim();
				const m = arg.match(/^(list|clear(?:\s+(\d+|all|\*))?)$/i);
				if (m) {
					const active = st.manual.filter((r) => r.active);
					if (m[1].toLowerCase() === "list") {
						if (!active.length) return ctx.ui.notify("No active reminders.", "info");
						const now = Date.now();
						const lines = active.map((r, i) => {
							const dueIn = Math.max(0, Math.round((r.nextFireAt - now) / 60_000));
							return `${i + 1}. "${oneLine(r.text, 80)}" — next in ~${dueIn}m (delivered ${r.delivered}x)`;
						});
						return ctx.ui.notify(lines.join("\n"), "info");
					}
					if (!active.length) return ctx.ui.notify("Nothing to clear.", "info");
					const all = !m[2] || /^(all|\*)$/i.test(m[2]);
					const n = all ? active.length : Number(m[2]);
					if (!all && (n < 1 || n > active.length))
						return ctx.ui.notify(
							`No active reminder #${n} (range 1-${active.length}).`,
							"warning",
						);
					// Mark active=false (completed) rather than splice: stable ids
					// survive, and clearing one cannot renumber/affect the others.
					const removed = all ? [...active] : [active[n - 1]];
					for (const r of removed) r.active = false;
					if (!writeState(sid, st)) {
						// Keep live state aligned with durable state when the atomic write fails.
						for (const r of removed) r.active = true;
						return ctx.ui.notify(
							"reminder: failed to persist the clear operation; nothing was cleared",
							"error",
						);
					}
					const suffix = removed.length === 1 ? "" : "s";
					return ctx.ui.notify(
						all
							? `Cleared ${removed.length} reminder${suffix}.`
							: `Cleared #${n}: "${oneLine(removed[0]?.text ?? "", 60)}".`,
						"info",
					);
				}
				if (!arg)
					return ctx.ui.notify(
						"Usage: /reminder <text> | list | clear [n|all]",
						"info",
					);
				if (arg.length > CUSTOM_MAX)
					return ctx.ui.notify(
						`reminder: keep the text under ${CUSTOM_MAX} chars.`,
						"warning",
					);
				// Duplicate text is the reminder the user already relies on —
				// refuse a second queue entry instead of double-nagging.
				const dup = st.manual.find((r) => r.active && r.text === arg);
				if (dup)
					return ctx.ui.notify(
						`Reminder already set: "${oneLine(arg, 80)}" — it re-anchors every ~${Math.round(MANUAL_INTERVAL_MS / 60_000)} min while you work. /reminder clear <n> to stop.`,
						"info",
					);
				const now = Date.now();
				const reminder: ManualReminder = {
					id: randomUUID(),
					text: arg,
					createdAt: now,
					nextFireAt: now + MANUAL_INTERVAL_MS,
					active: true,
					delivered: 0,
				};
				st.manual.push(reminder);
				if (!writeState(sid, st)) {
					// The user was told it failed, so it must not remain live and fire.
					st.manual = st.manual.filter((entry) => entry.id !== reminder.id);
					return ctx.ui.notify(
						"reminder: failed to persist the new reminder; it was not set",
						"error",
					);
				}
				// The explicit slash command authorizes one immediate steer, even
				// while the agent is idle. Periodic repeats remain turn-bound in
				// before_agent_start/turn_end and cannot wake completed work.
				const immediateMessage = {
					customType: "reminders",
					content: reminderText(
						st,
						sid,
						now,
						{ todo: false, drift: false },
						[reminder],
					),
					display: true,
				};
				try {
					if (typeof pi.sendMessage !== "function")
						throw new Error("message delivery unavailable");
					pi.sendMessage(immediateMessage, { deliverAs: "steer", triggerTurn: true });
				} catch {
					// A rejected queue must be due at the next available boundary;
					// leave delivered=0 and retain the original createdAt grid for
					// catchUp after that missed first occurrence is delivered.
					reminder.nextFireAt = now;
					writeState(sid, st);
					ctx.ui.notify(
						"Reminder set, but immediate delivery failed; it remains due for the next available active turn.",
						"warning",
					);
					return;
				}
				// Keep the repeat anchored at registration+2min; the immediate
				// delivery only records that the text was queued once. Persistence
				// and notification are outside the queue-failure boundary so a UI
				// problem cannot re-arm an already accepted delivery.
				reminder.delivered += 1;
				if (!writeState(sid, st)) {
					try {
						ctx.ui.notify(
							`Reminder queued, but its delivery receipt could not be saved; it remains scheduled for ~${Math.round(MANUAL_INTERVAL_MS / 60_000)} min.`,
							"warning",
						);
					} catch (err) { logReminderErr("reminder delivery notice", err); }
					return;
				}
				try {
					ctx.ui.notify(
						`Reminder set and queued: "${oneLine(arg, 80)}" — it repeats every ~${Math.round(MANUAL_INTERVAL_MS / 60_000)} min for the rest of this session. Manage: /reminder list | clear <n|all>.`,
						"info",
					);
				} catch (err) { logReminderErr("reminder delivery notice", err); }
			} catch {
				ctx.ui.notify("reminder: failed to update state", "error");
			}
		},
	});
}
