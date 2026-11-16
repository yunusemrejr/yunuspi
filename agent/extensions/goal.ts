/**
 * /goal — a session goal with a real definition of done and one completion check.
 *
 * The user states one demand; the harness turns it into criteria, keeps the
 * definition of done in context every turn, refuses to close the goal without
 * evidence, and continues the session (bounded, stall-aware) while criteria
 * remain open. State is persisted as whole snapshots on the session branch so
 * resume, fork and compaction all see the same goal. Fail-open: any error here
 * leaves the session running as if no goal existed.
 *
 * /goal is the only command a user needs. The kickoff offers the standards a
 * kind of work is held to (design, noslop, nobug, 3d, video, anatomy, research,
 * browser; lib/presets.ts) and the model adopts the ones that apply through the
 * goal tool; work that plainly is video or 3D adopts its standard even when the
 * model did not. The older shortcuts /noslop, /nobug, /3d, /video and /anatomy
 * still start a goal with that standard already in force, and share this
 * extension's one persisted goal state.
 */
import { GUARDIAN_REQUEST_META, type ExtensionAPI, type ExtensionContext } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@yunuspi/ai";
import { RATIONALE_INTAKE } from "./lib/tool-schema.ts";
import { isTestLikeCommand, uncountedCheck } from "./lib/task-state/ingest.ts";
import { collectVerificationReceipts, resumesElsewhere } from './lib/continuation-notice.ts';
import { completionReport, createStaticCompletionCheck } from "./lib/completion-check.ts";
import { isPromptAmendment, isPromptPivot, isReferentialFollowup } from "./lib/intent-context.ts";
import { noteSessionStopped, unlockSessionStop } from "./lib/session-stop.ts";
import {
	block, complete, createGoal, goalAnchor, goalCompletionGate, goalCompletionReceipts, goalIsLive, goalKickoff, goalRestoreNotice, goalStatusText, goalSummary,
	parseGoalArgs, GOAL_USAGE, recordEvidence, recordEvidenceBatch, restoreGoal, setCriteria, stopGate, reopenRejectedGoal, MAX_CRITERIA, MAX_GOAL_TEXT, type GoalState,
} from "./lib/goal-state.ts";
import {
	addBoosts, boostedGoalNotice, chainCompletions, createBoostedGoal, createPresetChainGoal, extractPresetTokens, presetNotice, presetUserText, resolveStandards,
	standardsBrief, standardsInForce, standardsOffer, standardTools, CHAIN_SUMMARIES, PRESET_IDS, PRESET_LABELS, STANDARD_IDS, type PresetChain, type PresetId, type PresetTokens, type StandardId,
} from "./lib/presets.ts";

const ENTRY = "goal-state-v1";
const GOAL_SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
	["resume", "continue this session's goal; words after it go to the agent as a note"],
	["status", "show the goal and each criterion"],
	["pause", "stop the automatic continuations"],
	["retry", "try a stalled goal again"],
	["done", "mark the goal achieved yourself"],
	["clear", "drop the goal"],
	["criteria", "replace the open criteria: criteria a; b"],
	["help", "every /goal form"],
];
const CONTEXT = "goal-anchor";
const STATUS_KEY = "goal";
const STOP_GOAL = /^(?:please\s+)?(?:stop(?: now| working| (?:this|the) goal)?|pause(?: (?:this|the) goal)?|don['’]t continue|do not continue)[.!]?$/i;
const WRITE_TOOLS = new Set(["edit", "write"]);
/** Tools whose successful run is itself a verification of built output. */
const VERIFY_TOOLS = new Set([
	"render_see", "video_qa", "video_render",
	"ui_explore", 
	"deliverable_check", "svg_inspect", 
	"sandbox_run", "lsp_diagnostics", "lens_diagnostics",
]);
/** Tools whose use shows what kind of work is under way, whatever the request called it. */
const WORK_STANDARD: Readonly<Record<string, StandardId>> = { video_project: "video", video_render: "video", blender: "3d" };
/** A kickoff carries the goal and, while any is left to adopt, the standards on offer. */
const kickoffText = (state: GoalState) => [goalKickoff(state), standardsOffer(state)].filter(Boolean).join("\n\n");
function isVerificationToolResult(name: string, input?: Record<string, unknown>): boolean {
	const action = String(input?.action ?? "");
	if (name === "blender") return ["render", "inspect", "qa", "verify"].includes(action);
	if (name === "browser_session") return ["verify", "screenshot", "snapshot", "console", "network"].includes(action);
	if (name === "office_doc") return ["verify", "render", "inspect", "check"].includes(action);
	if (name === "visual_review") return (action || "record") === "record";
	return VERIFY_TOOLS.has(name) && !["plan", "status", "list"].includes(action);
}

export default function goalExtension(pi: ExtensionAPI): void {
	if (process.env.PI_GOAL === "0") return;
	let goal: GoalState | undefined;
	let checkStatic = createStaticCompletionCheck();
	type CheckStart = { goalId: string; revision: number; command: string; tool: string };
	const checkStarts = new Map<string, CheckStart>();
	const backgroundChecks = new Map<string, CheckStart>();
	const debt = () => Math.max(0, (goal?.verification?.revision ?? 0) - (goal?.verification?.checked ?? 0));
	const remember = <T>(map: Map<string, T>, key: string, value: T) => {
		map.set(key, value);
		while (map.size > 64) map.delete(map.keys().next().value!);
	};
	const refused = new Set<string>();
	let lastStop: string | undefined;
	// Input is screened when a message is queued, not when it is delivered.
	// Four identical copies of an 18k-character kickoff were queued at once and
	// each cost a turn restating "still blocked" after the goal was blocked. A
	// kickoff for a goal that is no longer active is dropped, and so is a copy
	// of one already waiting in the queue; delivery forgets the waiting copy.
	const queuedKickoffs = new Set<string>();
	const authoredInputs = new Map<string, { goalId: string; text: string; steer: boolean }>();
	let detour = false;
	pi.on("input", (event: any) => {
		const text = typeof event?.text === "string" ? event.text : "";
		// A continuation queued for a goal that was cleared or replaced is dropped too.
		const continued = /^\[goal (\S+), continuation /.exec(text)?.[1];
		if (continued && event.source === "extension") {
			return goal?.id !== continued || goal.status !== "active" || detour ? { action: "handled" as const } : undefined;
		}
		const id = /^\[goal-tracked (\S+)\]/.exec(text)?.[1];
		if (!id) {
			// A rejected or cleared input must never steer or reopen a goal. Match the
			// native request ID when it is actually delivered to the agent.
			if (goal && event.requestId && (event.source === "interactive" || event.source === "rpc")) {
				remember(authoredInputs, event.requestId, {
					goalId: goal.id, text: event.originalText ?? text, steer: event.streamingBehavior === "steer",
				});
			}
			return undefined;
		}
		if (goal?.id !== id || goal.status !== "active" || queuedKickoffs.has(text)) return { action: "handled" as const };
		if (event.streamingBehavior) queuedKickoffs.add(text);
		return undefined;
	});
	pi.on("message_start", (event: any, ctx) => {
		const message = event?.message;
		if (message?.role !== "user") return;
		const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: any) => part?.text ?? "").join("\n") : "";
		queuedKickoffs.delete(text);
		if (/^\[goal-tracked (\S+)\]/.exec(text)?.[1] === goal?.id && goal?.status === "active") detour = false;
		const requestId = message[GUARDIAN_REQUEST_META]?.requestId;
		const input = authoredInputs.get(requestId);
		authoredInputs.delete(requestId);
		if (!input || !goal || input.goalId !== goal.id) return;
		const stopping = STOP_GOAL.test(input.text.trim());
		if (stopping && goal.status === "active") {
			persist({ ...goal, status: "paused", note: "Paused at your request.", updatedAt: Date.now() }, ctx);
			return;
		}
		const pivot = isPromptPivot(input.text);
		const reopened = !pivot && !detour ? reopenRejectedGoal(goal, input.text) : undefined;
		if (reopened) {
			resetChecks();
			persist({ ...reopened, verification: { revision: 0, checked: 0 } }, ctx);
			ctx.ui?.notify?.("Goal reopened for your correction. Verify the revised result.", "info");
		} else {
			detour ||= pivot || !(input.steer || isPromptAmendment(input.text) || isReferentialFollowup(input.text));
		}
	});
	// A cleared queue (Stop, session switch) delivers nothing; forget what was waiting.
	pi.on("agent_settled", (_event: any, ctx: any) => { if (!ctx?.hasPendingMessages?.()) queuedKickoffs.clear(); });
	pi.on("session_start", () => queuedKickoffs.clear());
	// project-tests-plan-passed and this extension's tool_result arrive in either order.
	const planCandidates = new Map<string, CheckStart>();
	const passedPlanCalls = new Map<string, CheckStart>();
	let lastCtx: ExtensionContext | undefined;
	pi.events?.on?.("project-tests-plan-passed", (data: any) => {
		const callId = typeof data?.callId === "string" ? data.callId : "";
		if (!callId) return;
		const start = planCandidates.get(callId);
		if (start && lastCtx) { planCandidates.delete(callId); cover(start, lastCtx); }
		else remember(passedPlanCalls, callId, { goalId: goal?.id ?? "", revision: 0, command: "", tool: "bash" });
	});

	let unsaved: GoalState | undefined;
	// A failed append used to leave the session running on state the disk never
	// accepted: `/goal clear` said "Goal cleared." while reopening the session
	// brought the goal back. Report it, and retry at the next turn boundary.
	const persist = (next: GoalState | undefined, ctx?: ExtensionContext) => {
		// A finished or blocked goal silences automatic follow-ups; a goal that
		// becomes active again (new, resumed, retried, reopened) lifts that.
		if (next?.status === "active" && goal?.status !== "active" && ctx) unlockSessionStop(ctx);
		goal = next;
		if (next) {
			try { pi.appendEntry(ENTRY, next); unsaved = undefined; }
			catch (error) {
				unsaved = next;
				ctx?.ui?.notify?.(`Goal state could not be saved (${error instanceof Error ? error.message : String(error)}); it will not survive a restart.`, "warning");
			}
		}
		else unsaved = undefined;
		show(ctx);
	};
	const persistPending = () => {
		if (!unsaved || !goal) return;
		try { pi.appendEntry(ENTRY, goal); unsaved = undefined; } catch { /* retried at the next boundary */ }
	};
	const show = (ctx?: ExtensionContext) => {
		// A stalled goal stays visible too: it is waiting for /goal retry, not gone.
		try { ctx?.ui?.setStatus?.(STATUS_KEY, goalStatusText(goal)); } catch { /* status is cosmetic */ }
	};
	const resetChecks = () => {
		checkStatic = createStaticCompletionCheck();
		checkStarts.clear(); backgroundChecks.clear(); planCandidates.clear(); passedPlanCalls.clear();
		lastCtx = undefined; uncounted = undefined; pointedOut = -1; refused.clear();
	};
	const startGoal = (next: GoalState, ctx: ExtensionContext) => {
		resetChecks();
		lastStop = undefined;
		// A kickoff queued behind another run owns its work only once delivered.
		detour = ctx.isIdle?.() === false;
		persist(next, ctx);
	};
	const currentVerification = (ctx: ExtensionContext) => collectVerificationReceipts(32, ctx.sessionManager)
		.filter((receipt) => receipt.source !== "deliverables");
	const restore = (ctx: ExtensionContext) => {
		try { goal = restoreGoal(ctx.sessionManager.getBranch()); } catch { goal = undefined; }
		resetChecks();
		lastStop = undefined; unsaved = undefined; detour = false; authoredInputs.clear();
		show(ctx);
		// A reopened session (after an update, a crash or a closed window) must say it still holds unfinished work.
		const notice = ctx.hasUI ? goalRestoreNotice(goal) : undefined;
		if (notice) ctx.ui?.notify?.(notice, goal?.status === "blocked" ? "warning" : "info");
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("context", (event) => {
		const messages = event.messages.filter((message: any) => message.customType !== CONTEXT);
		const anchor = detour ? undefined : goalAnchor(goal);
		if (!anchor) return messages.length !== event.messages.length ? { messages } : undefined;
		return { messages: [...messages, { role: "custom", customType: CONTEXT, content: anchor, display: false, timestamp: 0 } as any] };
	});

	// A resumed session with a live goal must be able to record evidence even
	// though tool discovery starts from the small default tool set. A blocked
	// goal keeps the tool too: "go on" after a budget stop must be able to close
	// it, and releasing the schema then made the closing call "not found".
	pi.on("before_agent_start", (_event, ctx) => {
		lastStop = undefined;
		persistPending();
		try {
			const unfinished = !!goal && ["active", "paused", "blocked"].includes(goal.status);
			pi.events?.emit('adaptive-pipeline-selection', { sessionManager: ctx.sessionManager, names: ['goal'], persistent: unfinished, beforeStart: true });
		} catch { /* discovery still stages the tool from the kickoff marker */ }
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") lastStop = event.message.stopReason;
		else if ((event.message as any).customType === "background-task-notification") settleBackgroundCheck((event.message as any).details, ctx);
	});
	pi.on("agent_end", (event) => {
		if (event.aborted) lastStop = "aborted";
	});

	/**
	 * A background run settles its own debt. `bg_run` returns a task id at once, so
	 * clearing on the call cleared the debt before a single test had run — a failing
	 * background suite then still left the goal free to close. The terminal receipt
	 * carries the original command and the real exit state, so verify there instead.
	 */
	// A check run since the last change that could not count, kept so a refusal can say why.
	let uncounted: { command: string; reason: string; alone?: string } | undefined;
	// The write revision an uncounted run was last pointed out for, so the note is said once per change.
	let pointedOut = -1;
	const cover = (start: CheckStart | undefined, ctx: ExtensionContext) => {
		if (!goalIsLive(goal) || !start || start.goalId !== goal.id) return;
		uncounted = undefined;
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
		if (detour || !goalIsLive(goal)) return;
		remember(checkStarts, event.toolCallId, { goalId: goal.id, revision: goal.verification?.revision ?? 0,
			command: String(event.input?.command ?? ""), tool: event.toolName });
	});
	// Adopting a standard: its text joins the goal, its fronts become criteria and its tools go on the wire.
	const adopt = (live: GoalState, ids: readonly StandardId[], ctx: ExtensionContext, resume = true) => {
		const added = addBoosts(live, ids, Date.now(), resume);
		if (!added.fresh.length) return added;
		persist(added.goal, ctx);
		try { pi.events?.emit?.("adaptive-pipeline-selection", { sessionManager: ctx.sessionManager, names: standardTools(added.fresh) }); } catch { /* tool_search still finds them */ }
		return added;
	};
	pi.on("tool_result", (event: { toolName?: string; toolCallId?: string; input?: Record<string, unknown>; details?: any; isError?: boolean }, ctx) => {
		const start = event.toolCallId ? checkStarts.get(event.toolCallId) : undefined;
		if (event.toolCallId) checkStarts.delete(event.toolCallId);
		if (detour || !goalIsLive(goal) || event.isError || start && start.goalId !== goal.id) return;
		const name = event.toolName ?? "";
		// A model that started a film or a 3D scene without adopting its standard gets it at the first such call.
		const shown = WORK_STANDARD[name];
		if (shown && goal.status === "active" && !standardsInForce(goal).includes(shown)) {
			const added = adopt(goal, [shown], ctx);
			if (added.fresh.length) {
				ctx.ui?.notify?.(`Goal ${added.goal.id}: ${PRESET_LABELS[shown]} standard in force, taken from the work under way.`, "info");
				void Promise.resolve(pi.sendUserMessage(`[goal ${added.goal.id}] ${added.appended}`, { deliverAs: "steer" })).catch(() => { /* the goal anchor still names the standard */ });
			}
		}
		// The command as it ran: project tests may have put `set -o pipefail;` in front of it after this
		// extension saw the call, and whether a filtered check counts turns on that prefix.
		const ran = typeof event.input?.command === "string" ? event.input.command : undefined;
		const observed = start ? (ran === undefined ? start : { ...start, command: ran })
			: { goalId: goal.id, revision: goal.verification?.revision ?? 0, command: ran ?? "", tool: name };
		if (WRITE_TOOLS.has(name)) {
			const file = event.details?.fileMutation?.resolved ?? event.input?.path;
			// Reading the final documentation diff satisfies V; appending release notes after a green check
			// must not manufacture another test run. Executable MDX and unknown/batched paths stay conservative.
			if (typeof file !== "string" || !/\.(?:md|markdown|rst)$/i.test(file)) {
				uncounted = undefined;
				persist({ ...goal, verification: { revision: (goal.verification?.revision ?? 0) + 1, checked: goal.verification?.checked ?? 0 } }, ctx);
			}
		}
		else if (name === "bg_run" && isTestLikeCommand(observed.command)) {
			if (event.toolCallId && !start) return;
			const id = event.details?.task?.id ?? event.details?.taskId;
			remember(backgroundChecks, id ? String(id) : `command:${observed.command}`, observed);
			if (event.details?.task) settleBackgroundCheck(event.details.task, ctx);
		}
		else if (event.toolCallId && !start) return;
		else if (name === "bash" && isTestLikeCommand(observed.command) && (event.details?.exitCode === undefined || event.details.exitCode === 0)) cover(observed, ctx);
		else if (name === "bash" && event.toolCallId) {
			// A planned project runner (`make && ./build/app --selftest`) is recognised
			// by project tests, which announces the call that passed the whole plan.
			remember(planCandidates, event.toolCallId, observed);
			lastCtx = ctx;
			const missed = event.details?.exitCode === undefined || event.details.exitCode === 0 ? uncountedCheck(observed.command) : undefined;
			if (missed) uncounted = { command: observed.command, ...missed };
			const passed = passedPlanCalls.get(event.toolCallId);
			if (passed) { passedPlanCalls.delete(event.toolCallId); cover(observed, ctx); }
			// Said with the run's own output, where the model can act on it at once. Left for the completion
			// call, the same fact cost a refused completion and a second reading of the whole gap list.
			const revision = goal.verification?.revision ?? 0;
			if (missed && !passed && debt() > 0 && pointedOut !== revision) {
				pointedOut = revision;
				const note = `[goal] This run does not count as the check for your last change: ${missed.reason}. ${missed.alone ? `Run \`${missed.alone}\` as its own command` : "Run the check command by itself"} before completing the goal.`;
				return { content: [...((event as any).content ?? []), { type: "text" as const, text: note }] };
			}
		}
		else if (name === "project_tests" && event.details?.need === null && event.details?.projectTests?.plannedChecks?.length
			&& event.details.projectTests.plannedChecks.every((check: any) => check.outcome === "passed")) cover(observed, ctx);
		else if (isVerificationToolResult(name, event.input)) cover(observed, ctx);
	});

	// One continuation per settled run; bounded and stall-aware inside stopGate.
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			persistPending();
			const stop = lastStop;
			lastStop = undefined;
			if (detour || stop === "stop" && resumesElsewhere(ctx.sessionManager)) return;
			// Recording the last criterion used to wake a model just to call complete. Close that exact checked goal
			// here instead; unresolved receipts still take the normal bounded continuation path, never an auto-waiver.
			if (stop === "stop" && goal?.status === "active" && !ctx.hasPendingMessages() && !debt() && goal.criteria.every(c => c.status !== "open")) {
				const closing = goal;
				const verification = await checkStatic(ctx.cwd, ctx.signal);
				if (goal !== closing || ctx.signal?.aborted || ctx.hasPendingMessages() || resumesElsewhere(ctx.sessionManager)) return;
				const checked = goalCompletionGate(goal, { unverifiedWrites: 0, refused: new Set(), verification: [...currentVerification(ctx), ...verification] });
				if (!checked.block) {
					persist(complete(goal, false), ctx);
					noteSessionStopped(ctx, `goal:${goal.id}:achieved`);
					ctx.ui?.notify?.(`Goal ${goal.id} achieved.`, "info");
					return;
				}
			}
			const decision = stopGate(goal, { lastStop: stop, hasPendingMessages: ctx.hasPendingMessages() });
			if (!decision) return;
			persist(decision.goal, ctx);
			// A stalled or budget-spent goal waits for the user; automatic test,
			// review and delivery follow-ups must not keep waking the model.
			if (decision.goal.status === "blocked") noteSessionStopped(ctx, `goal:${decision.goal.id}:blocked`);
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

	// Preset goals are /goal with the aim already written: /noslop desloppifies,
	// /nobug debugs, /3d boosts 3D work, /video boosts video work, /anatomy builds
	// anatomy figures and reveal films with the two anatomy skills. They share
	// this extension's goal state on purpose — one owner for the persisted
	// snapshots — so /goal status, pause, resume and clear all work on a
	// preset run, and its fronts close through the same goal tool. Preset tokens count
	// anywhere in the text: `/3d /video /noslop make X` dispatches here once, as /3d, and
	// `/goal build X /noslop` is one goal with the boost applied. A bare boost on a live
	// goal joins that goal. Parsing lives in lib/presets.ts.
	const goalCommandHandler = async (args: string, ctx: ExtensionContext) => {
		try {
			const command = parseGoalArgs(args, !!goal && goal.status !== "cleared");
			const notify = (text: string, level: "info" | "warning" = "info") => ctx.ui?.notify?.(text, level);
			// The kickoff starts a full agent run; the command must return immediately so
			// the editor and working indicator stay live while that run streams. It carries the
			// user's own words, so it is authored input: prompt analysis, Guardian constraints,
			// the requirement ledger and memory must see it (continuations below stay synthetic).
			// `userText` keeps the user's literal words apart from the criteria the harness adds, so
			// analysis, the Guardian and memory work from what was asked, not from our wrapper.
			// A goal set while a turn is streaming starts after it instead of failing as "already processing".
			const kickoff = (state: GoalState) => void Promise.resolve(pi.sendUserMessage(kickoffText(state), { authored: true, userText: state.text, deliverAs: "followUp" }))
				.catch((error) => notify(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
			switch (command.kind) {
				case "status": return notify(goalSummary(goal));
				case "help": return notify(GOAL_USAGE);
				case "set": {
					// Preset tokens anywhere in the text: with a task they make one boosted goal; alone they are a bare preset run.
					const found = extractPresetTokens(command.text);
					if (found.presets.length && found.task) return startBoosted(found, ctx);
					if (found.presets.length) return startPreset(found.presets[0])(found.presets.slice(1).map((id) => `/${id}`).join(" "), ctx);
					const replaced = goalIsLive(goal) ? goal : undefined;
					const next = createGoal(command.text);
					if (replaced) notify(`Goal ${replaced.id} replaced (${replaced.criteria.filter((c) => c.status === "open").length} criteria were open).`);
					startGoal(next, ctx);
					notify(`Goal ${next.id} set with ${next.criteria.length} criteria. The session keeps working until each has evidence. /goal shows progress.`);
					kickoff(next);
					return;
				}
				case "criteria":
					if (!goalIsLive(goal)) return notify("No live goal. Start one with /goal <text>.", "warning");
					persist(setCriteria(goal!, command.items), ctx);
					return notify(goalSummary(goal));
			}
			if (!goal || goal.status === "cleared") return notify(`No goal in this session to ${command.kind}.\n${GOAL_USAGE}`);
			const now = Date.now();
			if (command.kind === "pause") { persist({ ...goal, status: "paused", updatedAt: now }, ctx); return notify("Goal paused. /goal resume continues it."); }
			if (command.kind === "clear") { persist({ ...goal, status: "cleared", updatedAt: now }, ctx); return notify("Goal cleared."); }
			if (command.kind === "done") { persist(complete(goal, true, now), ctx); return notify("Goal marked achieved by you."); }
			// resume and retry both re-arm the continuation budget and fingerprint.
			const rearmed: GoalState = { ...goal, status: "active", nudges: 0, stalls: 0, progressMark: "", note: undefined, updatedAt: now };
			detour = ctx.isIdle?.() === false;
			refused.clear();
			persist(rearmed, ctx);
			const open = rearmed.criteria.filter((criterion) => criterion.status === "open").length;
			const note = "note" in command ? command.note : undefined;
			notify(`Goal ${rearmed.id} resumed: ${open} of ${rearmed.criteria.length} criteria open, continuation budget reset.${note ? " Your note goes with it." : ""}`);
			void Promise.resolve(pi.sendUserMessage(`${kickoffText(rearmed)}${note ? `\n\nThe user's note on resuming: ${note}` : ""}`, { authored: true, userText: note ?? rearmed.text, deliverAs: "followUp" }))
				.catch((error) => notify(`Goal resume failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		} catch (error) {
			ctx.ui?.notify?.(`Goal unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	// A /goal that names boosts: one goal carrying the user's words, each brief and its core fronts.
	const startBoosted = (found: PresetTokens, ctx: ExtensionContext) => {
		const next = createBoostedGoal(found.task, found.presets);
		startGoal(next, ctx);
		ctx.ui?.notify?.(boostedGoalNotice(found.presets, next), "info");
		// The literal is the user's own words; the expanded briefs travel as the kickoff text.
		void Promise.resolve(pi.sendUserMessage(kickoffText(next), { authored: true, userText: found.literal, deliverAs: "followUp" }))
			.catch((error: unknown) => ctx.ui?.notify?.(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
	};
	// A bare boost while a goal is live joins that goal: its brief is appended and its fronts take the free criteria slots.
	const boostLive = (live: GoalState, presets: PresetId[], ctx: ExtensionContext) => {
		const { goal: updated, fresh, fronts, clipped } = adopt(live, presets, ctx);
		if (!fresh.length) return ctx.ui?.notify?.(`${presets.map((id) => PRESET_LABELS[id]).join(" + ")} already in force on goal ${live.id}. /goal shows progress.`, "info");
		const labels = fresh.map((id) => PRESET_LABELS[id]).join(" + ");
		const tracked = fronts ? `${fronts} front(s) tracked` : "no free criteria slots, so it applies through the brief";
		ctx.ui?.notify?.(`${labels} boost added to goal ${updated.id} — ${tracked}, ${updated.criteria.length} criteria to settle with evidence.${clipped ? ` The goal text is at its ${MAX_GOAL_TEXT}-character cap, so this brief was clipped — /goal clear then re-run the boost for the full brief.` : ""} /goal shows progress, /goal pause stops it.`, "info");
		// Steered into a running turn, so the work already underway picks the boost up at its next step.
		void Promise.resolve(pi.sendUserMessage(kickoffText(updated), { authored: true, userText: presetUserText(fresh as PresetId[], ""), deliverAs: "steer" }))
			.catch((error: unknown) => ctx.ui?.notify?.(`${labels} kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
	};

	const startPreset = (invoked: PresetId) => async (args: string, ctx: ExtensionContext) => {
		const text = String(args ?? "").trim();
		const [head = "", ...rest] = text.split(/\s+/);
		const word = head.toLowerCase();
		// `resume|retry|continue <note>` are /goal forms with a note; keep the note's case.
		const subcommand = ["status", "help", "pause", "resume", "continue", "clear", "stop", "done", "retry"].includes(word)
			&& (!rest.length || ["resume", "retry", "continue"].includes(word));
		if (goal && goal.status !== "cleared" && subcommand) return goalCommandHandler(text, ctx);
		// The invoked name leads, so the whole invocation is one text: its tokens count wherever they stand.
		const found = extractPresetTokens(`/${invoked} ${String(args ?? "")}`);
		const chain: PresetChain = { presets: found.presets, task: found.task };
		const label = chain.presets.map((id) => PRESET_LABELS[id]).join(" + ");
		const live = goal;
		try {
			if (found.goal && found.task) return startBoosted(found, ctx);
			if (!found.task && goalIsLive(live)) return boostLive(live, found.presets, ctx);
			const next = createPresetChainGoal(chain);
			startGoal(next, ctx);
			ctx.ui?.notify?.(presetNotice(chain, next), "info");
			// Authored like a typed /goal, but userText stays the user's own
			// short demand; the expanded briefs are the harness's wording and
			// travel as the kickoff message (and the goal text) instead.
			void Promise.resolve(pi.sendUserMessage(kickoffText(next), { authored: true, userText: presetUserText(chain.presets, chain.task), deliverAs: "followUp" }))
				.catch((error: unknown) => ctx.ui?.notify?.(`${label} kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		} catch (error) {
			ctx.ui?.notify?.(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.registerCommand("goal", {
		description: "Set a goal with a real definition of done: /goal <what you want>. The session works until each criterion has evidence and holds the work to the standards it needs (design, bugs, 3D, video, research, browser) without being told. /goal shows progress; /goal pause, resume [note], retry, done, clear, help.",
		chainable: true,
		// `/goal ` lists its subcommands; a `/` token lists the boosts that can join.
		getArgumentCompletions: (prefix: string) => {
			const word = /^\s*([a-z]*)$/i.exec(prefix)?.[1]?.toLowerCase();
			const items = word === undefined ? [] : GOAL_SUBCOMMANDS.filter(([name]) => name.startsWith(word)).map(([name, description]) => ({ value: `${name} `, label: name, description }));
			return items.length ? items : chainCompletions(prefix, "goal");
		},
		handler: goalCommandHandler,
	});
	// Shortcuts from before /goal chose its own standards: `/3d <task>` is `/goal <task>` with 3D already in
	// force. They keep working and chaining, and stay out of the command menus.
	for (const id of PRESET_IDS) {
		pi.registerCommand(id, {
			description: `Shortcut for /goal with the ${PRESET_LABELS[id]} standard in force: ${CHAIN_SUMMARIES[id]}.`,
			argumentHint: "[task]",
			chainable: true,
			hidden: true,
			getArgumentCompletions: (prefix: string) => chainCompletions(prefix, id),
			handler: startPreset(id),
		});
	}

	const text = (value: string, details?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: value }], details: details ?? {} });
	pi.registerTool({
		name: "goal",
		label: "goal",
		// Check and commit against the results of earlier calls in the same batch.
		executionMode: "sequential",
		description: "Track the user's /goal. adopt with items:[standard names from the kickoff] returns each standard in full and tracks its checks. Finish in one call: complete with results:[{id,evidence}] records observed evidence for every criterion and checks completion. Per-result status may be met (default) or waived with a reason. Existing single-criterion met/waive calls also work. check is optional diagnostics for unresolved criteria, tests, reviews, delivery, audit and syntax; it is not a prerequisite. Reuse current passing checks. criteria refines open criteria; blocked reports a concrete user-action blocker (credentials, a decision, access) — difficulty, uncertainty or remaining work is not a blocker; status shows progress.",
		parameters: Type.Object({
			action: StringEnum(["status", "check", "adopt", "met", "waive", "criteria", "blocked", "complete"] as const),
			id: Type.Optional(Type.String({ maxLength: 8, description: "Criterion id such as C1 or V" })),
			// The owner clips each text and keeps at most MAX_CRITERIA - 1 items; a
			// schema refusal of longer input only cost a retry turn per call.
			evidence: Type.Optional(Type.String({ maxLength: 500 * RATIONALE_INTAKE, description: "What was observed: command and result, file and line, screenshot finding" })),
			results: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ maxLength: 8 }),
				evidence: Type.String({ maxLength: 500 * RATIONALE_INTAKE }),
				status: Type.Optional(StringEnum(["met", "waived"] as const)),
			}), { maxItems: MAX_CRITERIA, description: "Batch criterion evidence, including V, with met/waive or complete. Each result needs its own observed evidence or waiver reason; the batch validates before any state changes." })),
			items: Type.Optional(Type.Array(Type.String({ maxLength: 240 * RATIONALE_INTAKE }), { maxItems: (MAX_CRITERIA - 1) * 2 })),
			reason: Type.Optional(Type.String({ maxLength: 400 * RATIONALE_INTAKE, description: "blocked: the concrete user action needed. complete: only to waive checks that genuinely cannot run here, naming each and why" })),
			summary: Type.Optional(Type.String({ maxLength: 800 * RATIONALE_INTAKE })),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			if (params.action === "status") return text(goalSummary(goal));
			if (goal?.status === "blocked") return text("This goal is blocked. /goal resume or /goal retry reactivates it.");
			if (!goal || !goalIsLive(goal)) return text("No live goal in this session; nothing to record.");
			switch (params.action) {
				case "check": {
					const checking = goal;
					const verification = await checkStatic(ctx.cwd, signal);
					if (goal !== checking) return text("Goal changed during the check. Use its current criteria.");
					const receipts = goalCompletionReceipts(goal, { unverifiedWrites: debt(), writeRevision: goal.verification?.revision, uncounted })
						.filter((receipt) => receipt.id === "writes");
					const report = completionReport(goal.criteria, [...receipts, ...currentVerification(ctx), ...verification]);
					return text(`${report.lines.join("\n")}\n${report.clear ? "Every step is settled; call goal complete." : "Resolve the open steps and use goal complete with the observed evidence."}`);
				}
				case "criteria": {
					persist(setCriteria(goal, params.items ?? []), ctx);
					return text(goalSummary(goal));
				}
				case "adopt": {
					const { ids, unknown } = resolveStandards(params.items ?? []);
					const strangers = unknown.length ? `Not a standard: ${unknown.join(", ")}. ` : "";
					if (!ids.length) return text(`${strangers}adopt takes standard names in items: ${STANDARD_IDS.join(", ")}.`);
					const held = standardsInForce(goal);
					// The agent's own call never lifts a pause the user set.
					const added = adopt(goal, ids, ctx, false);
					const again = ids.filter((id) => held.includes(id));
					const criteria = added.goal.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n");
					return text([
						strangers.trim(),
						added.appended,
						again.length ? `Already in force:\n\n${standardsBrief(again, standardsInForce(added.goal))}` : "",
						added.fresh.length ? `Criteria now:\n${criteria}` : "",
					].filter(Boolean).join("\n\n"), { adopted: added.fresh, inForce: standardsInForce(added.goal) });
				}
				case "met":
				case "waive": {
					const outcome = params.results !== undefined
						? recordEvidenceBatch(goal, params.results, params.action === "met" ? "met" : "waived")
						: recordEvidence(goal, params.id ?? "", params.action === "met" ? "met" : "waived", params.evidence ?? params.reason ?? "");
					if (outcome.error) return text(outcome.error);
					persist(outcome.goal, ctx);
					const left = outcome.goal.criteria.filter((criterion) => criterion.status === "open");
					return text(left.length ? `Recorded. Open: ${left.map((criterion) => criterion.id).join(", ")}.` : "Recorded. Every criterion has evidence; call goal complete.");
				}
				case "blocked": {
					const reason = String(params.reason ?? "").trim();
					if (reason.length < 8) return text("blocked needs a concrete reason the user can act on.");
					persist(block(goal, reason), ctx);
					noteSessionStopped(ctx, `goal:${goal.id}:blocked`);
					ctx.ui?.notify?.(`Goal blocked: ${reason}`, "warning");
					return text("Goal marked blocked and shown to the user. Stop and wait for their answer; /goal resume continues afterwards.");
				}
				case "complete": {
					if (params.results !== undefined) {
						const outcome = recordEvidenceBatch(goal, params.results);
						if (outcome.error) return text(outcome.error);
						persist(outcome.goal, ctx);
					}
					if (goal.criteria.some(criterion => criterion.status === "open")) {
						return text(goalCompletionGate(goal, { unverifiedWrites: 0, refused }).reason!);
					}
					if (ctx.hasPendingMessages()) return text("Read the queued messages before completing the goal.");
					const closing = goal;
					const verification = await checkStatic(ctx.cwd, signal);
					signal?.throwIfAborted();
					if (goal !== closing || ctx.hasPendingMessages()) return text("Goal or queued input changed during completion. Use the current instructions.");
					// Unopened intermediate files (stems, previews, QA builds) stay in the user's verification
					// footer; gating on them paged three at a time through every refusal.
					const gated = [...currentVerification(ctx), ...verification];
					const decision = goalCompletionGate(goal, { unverifiedWrites: debt(), writeRevision: goal.verification?.revision, uncounted, refused, verification: gated });
					const why = String(params.reason ?? "").trim();
					if (decision.block) {
						refused.add(decision.key);
						return text(decision.reason ?? "Completion refused: verification is unresolved.");
					}
					// A repeated call used to waive silently, and models repeated it on their
					// own. A waiver needs the reason each gap cannot close here; it is
					// recorded on the goal and shown to the user.
					if (decision.waived && why.length < 12) return text("The same checks are still unresolved. Resolve the ones that bear on the requested deliverable, or call complete again with reason naming each remaining item and why. That waiver is recorded and shown to the user.");
					refused.clear();
					const done = decision.waived ? { ...complete(goal, true), note: `Completed with a recorded waiver: ${why.slice(0, 380)}` } : complete(goal, false);
					persist(done, ctx);
					noteSessionStopped(ctx, `goal:${done.id}:achieved`);
					ctx.ui?.notify?.(`Goal ${done.id} achieved${decision.waived ? " with recorded waiver" : ""}.`, "info");
					return text(`Goal achieved${decision.waived ? " with a recorded waiver; name each unresolved item in the final report" : ""}. Give the user a short evidence-based summary.`);
				}
				default: return text("Unknown goal action.");
			}
		},
	});
}
