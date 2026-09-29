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
import {
	block, complete, createGoal, goalAnchor, goalCompletionGate, goalIsLive, goalKickoff, goalSummary,
	parseGoalArgs, recordEvidence, restoreGoal, setCriteria, stopGate, MAX_CRITERIA, type GoalState,
} from "./lib/goal-state.ts";

const ENTRY = "goal-state-v1";
const CONTEXT = "goal-anchor";
const STATUS_KEY = "goal";
const WRITE_TOOLS = new Set(["edit", "write", "bulk_edit"]);
/** Tools whose successful run is itself a verification of built output. */
const VERIFY_TOOLS = new Set(["project_tests", "render_see", "browser_session", "video_qa", "video_render", "visual_diff", "desktop_session", "quality_review"]);

export default function goalExtension(pi: ExtensionAPI): void {
	if (process.env.PI_GOAL === "0") return;
	let goal: GoalState | undefined;
	let unverifiedWrites = 0;
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
		unverifiedWrites = 0;
		refused.clear();
		show(ctx);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("context", (event) => {
		const messages = event.messages.filter((message: any) => message.customType !== CONTEXT);
		const anchor = goalAnchor(goal);
		if (!anchor) return messages.length !== event.messages.length ? { messages } : undefined;
		return { messages: [...messages, { role: "custom", customType: CONTEXT, content: anchor, display: false, timestamp: 0 } as any] };
	});

	// A resumed session with a live goal must be able to record evidence even
	// though tool discovery starts from the small default tool set.
	pi.on("before_agent_start", () => {
		try {
			if (!goalIsLive(goal)) return;
			const active = pi.getActiveTools();
			if (!active.includes("goal")) pi.setActiveTools([...active, "goal"]);
		} catch { /* discovery still stages the tool from the kickoff marker */ }
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") lastStop = event.message.stopReason;
		else if ((event.message as any).customType === "background-task-notification") settleBackgroundCheck((event.message as any).details);
	});

	/**
	 * A background run settles its own debt. `bg_run` returns a task id at once, so
	 * clearing on the call cleared the debt before a single test had run — a failing
	 * background suite then still left the goal free to close. The terminal receipt
	 * carries the original command and the real exit state, so verify there instead.
	 */
	const settleBackgroundCheck = (details: any) => {
		if (!goalIsLive(goal) || !details || details.status !== "completed" || details.signal) return;
		const exit = details.exitCode;
		if (typeof exit === "number" && exit !== 0) return;
		if (isTestLikeCommand(String(details.command ?? ""))) unverifiedWrites = 0;
	};

	pi.on("tool_result", (event: { toolName?: string; input?: Record<string, unknown>; isError?: boolean }) => {
		if (!goalIsLive(goal) || event.isError) return;
		const name = event.toolName ?? "";
		if (WRITE_TOOLS.has(name)) unverifiedWrites++;
		else if (VERIFY_TOOLS.has(name)) unverifiedWrites = 0;
		else if (name === "bash" && isTestLikeCommand(String(event.input?.command ?? ""))) unverifiedWrites = 0;
	});

	// One continuation per settled run; bounded and stall-aware inside stopGate.
	pi.on("agent_settled", (_event, ctx) => {
		try {
			const decision = stopGate(goal, { lastStop, hasPendingMessages: ctx.hasPendingMessages() });
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
				// the editor and working indicator stay live while that run streams.
				const kickoff = (state: GoalState) => void Promise.resolve(pi.sendUserMessage(goalKickoff(state)))
					.catch((error) => notify(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
				switch (command.kind) {
					case "status": return notify(goalSummary(goal));
					case "set": {
						const next = createGoal(command.text);
						unverifiedWrites = 0;
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
					const decision = goalCompletionGate(goal, { unverifiedWrites, refused });
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
