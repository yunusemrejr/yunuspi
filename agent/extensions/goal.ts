/**
 * /goal — a session goal with a real definition of done.
 *
 * The user states one demand; the harness turns it into criteria, keeps the
 * definition of done in context every turn, refuses to close the goal without
 * evidence, and continues the session (bounded, stall-aware) while criteria
 * remain open. State is persisted as whole snapshots on the session branch so
 * resume, fork and compaction all see the same goal. Fail-open: any error here
 * leaves the session running as if no goal existed.
 */
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@yunuspi/ai";
import { isTestLikeCommand } from "./lib/task-state/ingest.ts";
import { collectVerificationReceipts } from './lib/continuation-notice.ts';
import {
	block, complete, createGoal, goalAnchor, goalCompletionGate, goalIsLive, goalKickoff, goalSummary,
	parseGoalArgs, recordEvidence, restoreGoal, setCriteria, stopGate, reopenRejectedGoal, MAX_CRITERIA, type GoalState,
} from "./lib/goal-state.ts";

const ENTRY = "goal-state-v1";
const CONTEXT = "goal-anchor";
const STATUS_KEY = "goal";
const WRITE_TOOLS = new Set(["edit", "write", "bulk_edit"]);
/** Tools whose successful run is itself a verification of built output. */
const VERIFY_TOOLS = new Set(["render_see", "video_qa", "video_render", "visual_diff"]);

export default function goalExtension(pi: ExtensionAPI): void {
	if (process.env.PI_GOAL === "0") return;
	let goal: GoalState | undefined;
	type CheckStart = { goalId: string; revision: number; command: string; tool: string };
	const checkStarts = new Map<string, CheckStart>();
	const backgroundChecks = new Map<string, CheckStart>();
	const debt = () => Math.max(0, (goal?.verification?.revision ?? 0) - (goal?.verification?.checked ?? 0));
	const remember = (map: Map<string, CheckStart>, key: string, value: CheckStart) => {
		map.set(key, value);
		while (map.size > 64) map.delete(map.keys().next().value!);
	};
	const refused = new Set<string>();
	let lastStop: string | undefined;

	const persist = (next: GoalState | undefined, ctx?: ExtensionContext) => {
		goal = next;
		if (next) {
			try { pi.appendEntry(ENTRY, next); } catch { /* the in-memory goal still drives this run */ }
		}
		show(ctx);
	};
	const show = (ctx?: ExtensionContext) => {
		try {
			const settled = goal?.criteria.filter((criterion) => criterion.status !== "open").length ?? 0;
			ctx?.ui?.setStatus?.(STATUS_KEY, goalIsLive(goal) ? `goal ${goal!.status === "paused" ? "⏸" : "◎"} ${settled}/${goal!.criteria.length}` : undefined);
		} catch { /* status is cosmetic */ }
	};
	const restore = (ctx: ExtensionContext) => {
		try { goal = restoreGoal(ctx.sessionManager.getBranch()); } catch { goal = undefined; }
		checkStarts.clear(); backgroundChecks.clear(); lastStop = undefined;
		refused.clear();
		show(ctx);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on('input', (event, ctx) => {
		if (event.source !== 'interactive' && event.source !== 'rpc') return;
		const next = reopenRejectedGoal(goal, event.originalText ?? event.text);
		if (!next) return;
		checkStarts.clear(); backgroundChecks.clear(); refused.clear(); persist({ ...next, verification: { revision: 0, checked: 0 } }, ctx);
		ctx.ui?.notify?.('Goal reopened for your correction; prior completion evidence needs verification on the revised result.', 'info');
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message: any) => message.customType !== CONTEXT);
		const anchor = goalAnchor(goal);
		if (!anchor) return messages.length !== event.messages.length ? { messages } : undefined;
		return { messages: [...messages, { role: "custom", customType: CONTEXT, content: anchor, display: false, timestamp: 0 } as any] };
	});

	// A resumed session with a live goal must be able to record evidence even
	// though tool discovery starts from the small default tool set.
	pi.on("before_agent_start", (_event, ctx) => {
		lastStop = undefined;
		try {
			pi.events?.emit('adaptive-pipeline-selection', { sessionManager: ctx.sessionManager, names: ['goal'], persistent: goalIsLive(goal), beforeStart: true });
		} catch { /* discovery still stages the tool from the kickoff marker */ }
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") lastStop = event.message.stopReason;
		else if ((event.message as any).customType === "background-task-notification") settleBackgroundCheck((event.message as any).details, ctx);
	});

	/**
	 * A background run settles its own debt. `bg_run` returns a task id at once, so
	 * clearing on the call cleared the debt before a single test had run — a failing
	 * background suite then still left the goal free to close. The terminal receipt
	 * carries the original command and the real exit state, so verify there instead.
	 */
	const cover = (start: CheckStart | undefined, ctx: ExtensionContext) => {
		if (!goalIsLive(goal) || !start || start.goalId !== goal.id) return;
		const revision = goal.verification?.revision ?? 0;
		const checked = Math.max(goal.verification?.checked ?? 0, Math.min(revision, start.revision));
		if (checked !== (goal.verification?.checked ?? 0)) persist({ ...goal, verification: { revision, checked } }, ctx);
	};
	const settleBackgroundCheck = (details: any, ctx: ExtensionContext) => {
		if (!goalIsLive(goal) || !details) return;
		const key = String(details.id ?? details.taskId ?? `command:${details.command ?? ""}`);
		const start = backgroundChecks.get(key) ?? backgroundChecks.get(`command:${details.command ?? ""}`);
		if (["completed", "failed", "killed"].includes(details.status)) {
			backgroundChecks.delete(key);
			backgroundChecks.delete(`command:${details.command ?? ""}`);
		}
		if (details.status === "completed" && details.exitCode === 0 && !details.signal && isTestLikeCommand(String(details.command ?? ""))) cover(start, ctx);
	};

	pi.on("tool_call", (event) => {
		if (!goalIsLive(goal)) return;
		remember(checkStarts, event.toolCallId, { goalId: goal.id, revision: goal.verification?.revision ?? 0,
			command: String(event.input?.command ?? ""), tool: event.toolName });
	});
	pi.on("tool_result", (event: { toolName?: string; toolCallId?: string; input?: Record<string, unknown>; details?: any; isError?: boolean }, ctx) => {
		const start = event.toolCallId ? checkStarts.get(event.toolCallId) : undefined;
		if (event.toolCallId) checkStarts.delete(event.toolCallId);
		if (!goalIsLive(goal) || event.isError || start && start.goalId !== goal.id) return;
		const name = event.toolName ?? "";
		const observed = start ?? { goalId: goal.id, revision: goal.verification?.revision ?? 0, command: String(event.input?.command ?? ""), tool: name };
		if (WRITE_TOOLS.has(name)) persist({ ...goal, verification: { revision: (goal.verification?.revision ?? 0) + 1, checked: goal.verification?.checked ?? 0 } }, ctx);
		else if (name === "bg_run" && isTestLikeCommand(observed.command)) {
			if (event.toolCallId && !start) return;
			const id = event.details?.task?.id ?? event.details?.taskId;
			remember(backgroundChecks, id ? String(id) : `command:${observed.command}`, observed);
			if (event.details?.task) settleBackgroundCheck(event.details.task, ctx);
		}
		else if (event.toolCallId && !start) return;
		else if (name === "bash" && isTestLikeCommand(observed.command) && (event.details?.exitCode === undefined || event.details.exitCode === 0)) cover(observed, ctx);
		else if (name === "project_tests" && event.details?.need === null && event.details?.projectTests?.plannedChecks?.length
			&& event.details.projectTests.plannedChecks.every((check: any) => check.outcome === "passed")) cover(observed, ctx);
		else if (name === "quality_review" && event.details?.status === "accepted" && !event.details.staleReports) cover(observed, ctx);
		else if (VERIFY_TOOLS.has(name) && !["plan", "status", "inspect", "list"].includes(String(event.input?.action ?? ""))) cover(observed, ctx);
	});

	// One continuation per settled run; bounded and stall-aware inside stopGate.
	pi.on("agent_settled", (_event, ctx) => {
		try {
			const stop = lastStop;
			lastStop = undefined;
			const decision = stopGate(goal, { lastStop: stop, hasPendingMessages: ctx.hasPendingMessages() });
			if (!decision) return;
			persist(decision.goal, ctx);
			if (decision.notice) ctx.ui?.notify?.(decision.notice.text, decision.notice.level);
			if (decision.nudge) {
				ctx.ui?.notify?.(`Goal ${decision.goal.id}: continuing (${decision.goal.nudges}) — ${decision.goal.criteria.filter((c) => c.status === "open").length} criteria open.`, "info");
				// The kickoff reports a failed send; the continuation must too. A nudge that
				// never left the harness told the user work was continuing, then looked like a
				// silent stall with criteria still open and no explanation for either.
				void Promise.resolve(pi.sendUserMessage(decision.nudge)).catch((error: unknown) =>
					ctx.ui?.notify?.(`Goal ${decision.goal.id}: could not continue (${error instanceof Error ? error.message : String(error)}). ${decision.goal.criteria.filter((c) => c.status === "open").length} criteria are still open; /goal resume restarts it.`, "warning"));
			}
		} catch { /* a gate failure must never wedge the session */ }
	});

	pi.registerCommand("goal", {
		description: "Set a goal with a real definition of done: /goal <what you want>, then /goal to inspect, pause, resume, retry, done or clear.",
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				const command = parseGoalArgs(args);
				const notify = (text: string, level: "info" | "warning" = "info") => ctx.ui?.notify?.(text, level);
				// The kickoff starts a full agent run; the command must return immediately so
				// the editor and working indicator stay live while that run streams. It carries the
				// user's own words, so it is authored input: prompt analysis, Guardian constraints,
				// the requirement ledger and memory must see it (continuations below stay synthetic).
				// `userText` keeps the user's literal words apart from the criteria the harness adds, so
				// analysis, the Guardian and memory work from what was asked, not from our wrapper.
				const kickoff = (state: GoalState) => void Promise.resolve(pi.sendUserMessage(goalKickoff(state), { authored: true, userText: state.text }))
					.catch((error) => notify(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
				switch (command.kind) {
					case "status": return notify(goalSummary(goal));
					case "set": {
						const next = createGoal(command.text);
						checkStarts.clear(); backgroundChecks.clear(); lastStop = undefined;
						refused.clear();
						persist(next, ctx);
						notify(`Goal ${next.id} set with ${next.criteria.length} criteria. The session keeps working until each has evidence. /goal shows progress.`);
						kickoff(next);
						return;
					}
					case "criteria":
						if (!goalIsLive(goal)) return notify("No live goal. Start one with /goal <text>.", "warning");
						persist(setCriteria(goal!, command.items), ctx);
						return notify(goalSummary(goal));
				}
				if (!goal || goal.status === "cleared") return notify("No goal set. /goal <what you want done> starts one.");
				const now = Date.now();
				if (command.kind === "pause") { persist({ ...goal, status: "paused", updatedAt: now }, ctx); return notify("Goal paused. /goal resume continues it."); }
				if (command.kind === "clear") { persist({ ...goal, status: "cleared", updatedAt: now }, ctx); return notify("Goal cleared."); }
				if (command.kind === "done") { persist(complete(goal, true, now), ctx); return notify("Goal marked achieved by you."); }
				// resume and retry both re-arm the continuation budget and fingerprint.
				const rearmed: GoalState = { ...goal, status: "active", nudges: 0, stalls: 0, progressMark: "", note: undefined, updatedAt: now };
				persist(rearmed, ctx);
				notify(`Goal ${rearmed.id} resumed.`);
				kickoff(rearmed);
			} catch (error) {
				ctx.ui?.notify?.(`Goal unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});

	const text = (value: string, details?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: value }], details: details ?? {} });
	pi.registerTool({
		name: "goal",
		label: "goal",
		description: "Track the user's /goal definition of done. met records evidence for one criterion (what you ran or saw and its result); waive drops an unnecessary or impossible criterion with the reason; criteria replaces the open criteria with a sharper list; blocked reports that only the user can unblock the work; complete closes the goal after every criterion has evidence and nothing changed since the last verification; status prints progress.",
		parameters: Type.Object({
			action: StringEnum(["status", "met", "waive", "criteria", "blocked", "complete"] as const),
			id: Type.Optional(Type.String({ maxLength: 8, description: "Criterion id such as C1 or V" })),
			evidence: Type.Optional(Type.String({ maxLength: 600, description: "What was observed: command and result, file and line, screenshot finding" })),
			items: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: MAX_CRITERIA - 1 })),
			reason: Type.Optional(Type.String({ maxLength: 400 })),
			summary: Type.Optional(Type.String({ maxLength: 800 })),
		}),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			if (!goal || !goalIsLive(goal)) return text("No live goal in this session; nothing to record.");
			switch (params.action) {
				case "status": return text(goalSummary(goal));
				case "criteria": {
					persist(setCriteria(goal, params.items ?? []), ctx);
					return text(goalSummary(goal));
				}
				case "met":
				case "waive": {
					const outcome = recordEvidence(goal, params.id ?? "", params.action === "met" ? "met" : "waived", params.evidence ?? params.reason ?? "");
					if (outcome.error) return text(outcome.error);
					persist(outcome.goal, ctx);
					const left = outcome.goal.criteria.filter((criterion) => criterion.status === "open");
					return text(left.length ? `Recorded. Open: ${left.map((criterion) => criterion.id).join(", ")}.` : "Recorded. Every criterion has evidence; call goal complete.");
				}
				case "blocked": {
					const reason = String(params.reason ?? "").trim();
					if (reason.length < 8) return text("blocked needs a concrete reason the user can act on.");
					persist(block(goal, reason), ctx);
					ctx.ui?.notify?.(`Goal blocked: ${reason}`, "warning");
					return text("Goal marked blocked and shown to the user. Stop and wait for their answer; /goal resume continues afterwards.");
				}
				case "complete": {
					const decision = goalCompletionGate(goal, { unverifiedWrites: debt(), writeRevision: goal.verification?.revision, refused, verification: collectVerificationReceipts(32, ctx.sessionManager) });
					if (decision.block) {
						refused.add(decision.key);
						return text(decision.reason ?? "Completion refused: verification is unresolved.");
					}
					// A waiver is spent by the call that used it. The refusal keys on the
				// shape of the gaps, so keeping a spent key for the whole session let
				// any later gap of the same shape auto-waive — a fresh unverified edit
				// then closed the goal as though the user had approved that one too.
				if (decision.waived) refused.delete(decision.key);
				const done = complete(goal, decision.waived);
					persist(done, ctx);
					ctx.ui?.notify?.(`Goal ${done.id} achieved${decision.waived ? " with recorded waiver" : ""}.`, "info");
					return text(`Goal achieved${decision.waived ? " with a recorded waiver; name each unresolved item in the final report" : ""}. Give the user a short evidence-based summary.`);
				}
				default: return text("Unknown goal action.");
			}
		},
	});
}
