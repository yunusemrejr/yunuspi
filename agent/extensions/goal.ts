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
 * This extension also owns the preset goals /noslop, /nobug, /3d, /video and /anatomy (briefs,
 * fronts and the chaining grammar in lib/presets.ts and lib/noslop.ts) so
 * every command shares the one persisted goal state instead of writing
 * competing snapshots. `/3d /video /noslop <task>` stacks their aims onto
 * one goal.
 */
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@yunuspi/ai";
import { RATIONALE_INTAKE } from "./lib/tool-schema.ts";
import { isTestLikeCommand } from "./lib/task-state/ingest.ts";
import { collectVerificationReceipts, resumesElsewhere } from './lib/continuation-notice.ts';
import { completionReport, createStaticCompletionCheck, staticAdvisories } from "./lib/completion-check.ts";
import { selfVerificationPrompt } from "./lib/lean-policy.ts";
import {
	block, complete, createGoal, goalAnchor, goalCompletionGate, goalCompletionReceipts, goalIsLive, goalKickoff, goalSummary,
	parseGoalArgs, recordEvidence, recordEvidenceBatch, restoreGoal, setCriteria, stopGate, reopenRejectedGoal, MAX_CRITERIA, type GoalState,
} from "./lib/goal-state.ts";
import { addBoosts, boostedGoalNotice, createBoostedGoal, createPresetChainGoal, extractPresetTokens, presetNotice, presetUserText, PRESET_LABELS, type PresetChain, type PresetId, type PresetTokens } from "./lib/presets.ts";

const ENTRY = "goal-state-v1";
const CONTEXT = "goal-anchor";
const STATUS_KEY = "goal";
const WRITE_TOOLS = new Set(["edit", "write", "bulk_edit"]);
/** Tools whose successful run is itself a verification of built output. */
const VERIFY_TOOLS = new Set([
	"render_see", "video_qa", "video_render",
	"ui_explore", "ui_consistency", "motion_inspect",
	"deliverable_check", "svg_inspect", "svg_render",
	"media_sync", "sandbox_run", "lsp_diagnostics", "lens_diagnostics",
]);
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
		checkStatic = createStaticCompletionCheck();
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
		if (WRITE_TOOLS.has(name)) {
			if (name === "bulk_edit" && (event.input?.action === "preview" || event.details?.bulkEdit?.changedFiles === 0 || event.details?.changedFiles === 0)) return;
			const file = event.details?.fileMutation?.resolved ?? event.input?.path;
			// Reading the final documentation diff satisfies V; appending release notes after a green check
			// must not manufacture another test run. Executable MDX and unknown/batched paths stay conservative.
			if (typeof file !== "string" || !/\.(?:md|markdown|rst)$/i.test(file)) persist({ ...goal, verification: { revision: (goal.verification?.revision ?? 0) + 1, checked: goal.verification?.checked ?? 0 } }, ctx);
		}
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
		else if (isVerificationToolResult(name, event.input)) cover(observed, ctx);
	});

	// One continuation per settled run; bounded and stall-aware inside stopGate.
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const stop = lastStop;
			lastStop = undefined;
			// Recording the last criterion used to wake a model just to call complete. Close that exact checked goal
			// here instead; unresolved receipts still take the normal bounded continuation path, never an auto-waiver.
			if (stop === "stop" && goal?.status === "active" && !ctx.hasPendingMessages() && !debt() && goal.criteria.every(c => c.status !== "open")) {
				if (resumesElsewhere(ctx.sessionManager)) return;
				const closing = goal;
				const verification = await checkStatic(ctx.cwd, ctx.signal);
				if (goal !== closing || ctx.signal?.aborted || ctx.hasPendingMessages() || resumesElsewhere(ctx.sessionManager)) return;
				const checked = goalCompletionGate(goal, { unverifiedWrites: 0, refused: new Set(), verification: [...collectVerificationReceipts(32, ctx.sessionManager), ...verification] });
				if (!checked.block) {
					persist(complete(goal, false), ctx);
					ctx.ui?.notify?.(`Goal ${goal.id} achieved.`, "info");
					return;
				}
			}
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
			const command = parseGoalArgs(args);
			const notify = (text: string, level: "info" | "warning" = "info") => ctx.ui?.notify?.(text, level);
			// The kickoff starts a full agent run; the command must return immediately so
			// the editor and working indicator stay live while that run streams. It carries the
			// user's own words, so it is authored input: prompt analysis, Guardian constraints,
			// the requirement ledger and memory must see it (continuations below stay synthetic).
			// `userText` keeps the user's literal words apart from the criteria the harness adds, so
			// analysis, the Guardian and memory work from what was asked, not from our wrapper.
			// A goal set while a turn is streaming starts after it instead of failing as "already processing".
			const kickoff = (state: GoalState) => void Promise.resolve(pi.sendUserMessage(goalKickoff(state), { authored: true, userText: state.text, deliverAs: "followUp" }))
				.catch((error) => notify(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
			switch (command.kind) {
				case "status": return notify(goalSummary(goal));
				case "set": {
					// Preset tokens anywhere in the text: with a task they make one boosted goal; alone they are a bare preset run.
					const found = extractPresetTokens(command.text);
					if (found.presets.length && found.task) return startBoosted(found, ctx);
					if (found.presets.length) return startPreset(found.presets[0])(found.presets.slice(1).map((id) => `/${id}`).join(" "), ctx);
					const next = createGoal(command.text);
					checkStatic = createStaticCompletionCheck();
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
	};

	// A /goal that names boosts: one goal carrying the user's words, each brief and its core fronts.
	const startBoosted = (found: PresetTokens, ctx: ExtensionContext) => {
		const next = createBoostedGoal(found.task, found.presets, found.literal);
		checkStatic = createStaticCompletionCheck();
		checkStarts.clear(); backgroundChecks.clear(); lastStop = undefined;
		refused.clear();
		persist(next, ctx);
		ctx.ui?.notify?.(boostedGoalNotice(found.presets, next), "info");
		// The literal is the user's own words; the expanded briefs travel as the kickoff text.
		void Promise.resolve(pi.sendUserMessage(goalKickoff(next), { authored: true, userText: found.literal, deliverAs: "followUp" }))
			.catch((error: unknown) => ctx.ui?.notify?.(`Goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
	};
	// A bare boost while a goal is live joins that goal: its brief is appended and its fronts take the free criteria slots.
	const boostLive = (live: GoalState, presets: PresetId[], ctx: ExtensionContext) => {
		const { goal: updated, fresh, fronts } = addBoosts(live, presets);
		if (!fresh.length) return ctx.ui?.notify?.(`${presets.map((id) => PRESET_LABELS[id]).join(" + ")} already in force on goal ${live.id}. /goal shows progress.`, "info");
		persist(updated, ctx);
		const labels = fresh.map((id) => PRESET_LABELS[id]).join(" + ");
		const tracked = fronts ? `${fronts} front(s) tracked` : "no free criteria slots, so it applies through the brief";
		ctx.ui?.notify?.(`${labels} boost added to goal ${updated.id} — ${tracked}, ${updated.criteria.length} criteria to settle with evidence. /goal shows progress, /goal pause stops it.`, "info");
		// Steered into a running turn, so the work already underway picks the boost up at its next step.
		void Promise.resolve(pi.sendUserMessage(goalKickoff(updated), { authored: true, userText: presetUserText(fresh, ""), deliverAs: "steer" }))
			.catch((error: unknown) => ctx.ui?.notify?.(`${labels} kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
	};

	const startPreset = (invoked: PresetId) => async (args: string, ctx: ExtensionContext) => {
		const trimmed = String(args ?? "").trim().toLowerCase();
		if (goal && goal.status !== "cleared" && ["status", "pause", "resume", "clear", "done", "retry"].includes(trimmed)) {
			return goalCommandHandler(trimmed, ctx);
		}
		// The invoked name leads, so the whole invocation is one text: its tokens count wherever they stand.
		const found = extractPresetTokens(`/${invoked} ${String(args ?? "")}`);
		const chain: PresetChain = { presets: found.presets, task: found.task };
		const label = chain.presets.map((id) => PRESET_LABELS[id]).join(" + ");
		const live = goal;
		try {
			if (found.goal && found.task) return startBoosted(found, ctx);
			if (!found.task && goalIsLive(live)) return boostLive(live, found.presets, ctx);
			const next = createPresetChainGoal(chain);
			checkStatic = createStaticCompletionCheck();
			checkStarts.clear(); backgroundChecks.clear(); lastStop = undefined;
			refused.clear();
			persist(next, ctx);
			ctx.ui?.notify?.(presetNotice(chain, next), "info");
			// Authored like a typed /goal, but userText stays the user's own
			// short demand; the expanded briefs are the harness's wording and
			// travel as the kickoff message (and the goal text) instead.
			void Promise.resolve(pi.sendUserMessage(goalKickoff(next), { authored: true, userText: presetUserText(chain.presets, chain.task), deliverAs: "followUp" }))
				.catch((error: unknown) => ctx.ui?.notify?.(`${label} kickoff failed: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		} catch (error) {
			ctx.ui?.notify?.(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.registerCommand("goal", {
		description: "Set a goal with a real definition of done: /goal <what you want>, then /goal to inspect, pause, resume, retry, done or clear.",
		handler: goalCommandHandler,
	});
	pi.registerCommand("noslop", {
		description: "Desloppify the codebase: remove AI slop across UI, copy, comments and dead/duplicate code, cut every screen down to a calm low-density essential, and replace what had a real job plainly. Runs as a goal until every front has evidence. Chains with /nobug, /3d, /video and /anatomy.",
		argumentHint: "[focus — an area, surface or front; omit for the whole codebase]",
		handler: startPreset("noslop"),
	});
	pi.registerCommand("nobug", {
		description: "Debug the codebase: hunt logic, edge-case, broken-code, dependency, duplication, UI/UX, responsive and cross-browser bugs; reproduce each, fix it at its root, prove it. Runs as a goal. Chains with /noslop, /3d, /video and /anatomy.",
		argumentHint: "[focus or assignment — an area, pipeline or output; omit for the whole codebase]",
		handler: startPreset("nobug"),
	});
	pi.registerCommand("3d", {
		description: "3D boost: build or fix 3D work (Blender, three.js/WebGL) with real assets, grounded references and rendered proof. Bare /3d improves this project's existing 3D work, or says there is none. Chains: /3d /video /noslop /nobug /anatomy <task>.",
		argumentHint: "[assignment — what to make; omit to fix this project's 3D work]",
		handler: startPreset("3d"),
	});
	pi.registerCommand("video", {
		description: "Video boost: make or fix video with finished sound (narration/TTS, music, effects), purposeful visuals and a verified final export. Bare /video improves this project's existing video work, or says there is none. Chains with /3d, /anatomy, /noslop and /nobug.",
		argumentHint: "[assignment — what to make; omit to fix this project's video work]",
		handler: startPreset("video"),
	});
	pi.registerCommand("anatomy", {
		description: "Anatomy boost: an object or mechanism built from real parts with the anatomy and anatomy-reveal skills — interactive explainers, exploded/dissection pages, product-reveal films — checked by audit and rendered frames. Bare /anatomy improves this project's anatomy figures, or says there are none. Chains: /anatomy /3d /video <task>.",
		argumentHint: "[assignment — an object, mechanism or system to show; omit to fix this project's anatomy figures]",
		handler: startPreset("anatomy"),
	});

	const text = (value: string, details?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: value }], details: details ?? {} });
	pi.registerTool({
		name: "goal",
		label: "goal",
		description: "Track the user's /goal. Finish in one call: complete with results:[{id,evidence}] records observed evidence for every criterion and checks completion. Per-result status may be met (default) or waived with a reason. Existing single-criterion met/waive calls also work. check is optional diagnostics for unresolved criteria, tests, reviews, delivery, audit and syntax; it is not a prerequisite. Reuse current passing checks. criteria refines open criteria; blocked reports a concrete user-action blocker; status shows progress.",
		parameters: Type.Object({
			action: StringEnum(["status", "check", "met", "waive", "criteria", "blocked", "complete"] as const),
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
			reason: Type.Optional(Type.String({ maxLength: 400 * RATIONALE_INTAKE })),
			summary: Type.Optional(Type.String({ maxLength: 800 * RATIONALE_INTAKE })),
		}),
		async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			if (!goal || !goalIsLive(goal)) return text("No live goal in this session; nothing to record.");
			switch (params.action) {
				case "status": return text(goalSummary(goal));
				case "check": {
					// The one completion check: criteria plus every test, review, delivery, media, audit and syntax step.
					const receipts = [...goalCompletionReceipts(goal, { unverifiedWrites: debt(), writeRevision: goal.verification?.revision }).filter((receipt) => receipt.id === "writes"), ...collectVerificationReceipts(32, ctx.sessionManager), ...await checkStatic(ctx.cwd, signal)];
					const report = completionReport(goal.criteria, receipts);
					const advisories = await staticAdvisories(ctx.cwd, signal);
					// Same-model self-verification replaces external quality/observer gates:
					// the model that did the work checks it against the goal and its own session journey.
					const verify = selfVerificationPrompt(goal.text, goal.criteria.filter((c) => c.status === "open"));
					return text(`${report.lines.join("\n")}${advisories.length ? `\nAdvisory (never blocks): ${advisories.join(" ")}` : ""}\n${report.clear ? "Every step is settled; call goal complete." : `Open steps above: do the work, then record evidence with met/waive or check again.\n\n${verify}`}`);
				}
				case "criteria": {
					persist(setCriteria(goal, params.items ?? []), ctx);
					return text(goalSummary(goal));
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
					ctx.ui?.notify?.(`Goal blocked: ${reason}`, "warning");
					return text("Goal marked blocked and shown to the user. Stop and wait for their answer; /goal resume continues afterwards.");
				}
				case "complete": {
					if (params.results !== undefined) {
						const outcome = recordEvidenceBatch(goal, params.results);
						if (outcome.error) return text(outcome.error);
						persist(outcome.goal, ctx);
					}
					const closing = goal;
					const verification = await checkStatic(ctx.cwd, signal);
					signal?.throwIfAborted();
					if (goal !== closing) return text("Goal changed during completion; use its current criteria and verification.");
					const decision = goalCompletionGate(goal, { unverifiedWrites: debt(), writeRevision: goal.verification?.revision, refused, verification: [...collectVerificationReceipts(32, ctx.sessionManager), ...verification] });
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
