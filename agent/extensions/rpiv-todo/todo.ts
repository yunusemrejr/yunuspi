/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the pre-refactor import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { PLAN_GUIDANCE, renderPlan } from "./state/plan.ts";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { t } from "./state/i18n-bridge.js";
import { selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { commitState, getRenderState, getState, sid } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import {
	renderTodoCall,
	renderTodoResult,
} from "./view/format.js";

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export {
	__resetState,
	getNextId,
	getTodos,
	setActiveRenderSession,
	sid,
} from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type {
	Task,
	TaskAction,
	TaskDetails,
	TaskStatus,
} from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET =
	"Maintain an actionable hierarchical plan";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [PLAN_GUIDANCE];

export function registerTodoTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Maintain hierarchical action plans. Batch edits are atomic; negative IDs alias earlier creates. list view=frontier shows active/ready work, tree shows hierarchy; get retrieves criteria and evidence. Reopen completed nodes when scope changes. Execution modes describe native orchestration intent.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTaskMutation(
				getState(sid(ctx)),
				params.action,
				params as TaskMutationParams,
			);
			commitState(sid(ctx), result.state);
			try { if (result.op.kind !== "error" && !["get", "list"].includes(params.action)) pi.events?.emit("todo-plan-changed", {sessionId:sid(ctx), cwd:ctx.cwd, tasks:result.state.tasks}); } catch { /* Optional peer publication cannot invalidate a committed plan. */ }
			return buildToolResult(
				params.action,
				params as TaskMutationParams,
				result.state,
				result.op,
			);
		},

		// renderCall reflects the FOREGROUND slot, not the calling session's. Pi's
		// `ToolRenderContext` carries no session identity (no sessionManager/sessionId),
		// so this ctx-less hook cannot re-key by caller. For the foreground session's
		// own transcript that is exactly right. A detached/child call rendered in the
		// lane-transcript viewer whose task lives only in the child's slot misses the
		// foreground lookup and falls back to `#<id>` (see renderTodoCall). That is the
		// safe outcome: per-session ids restart at 1, so searching sibling slots could
		// surface the WRONG subject — the `#<id>` fallback is intentional, not a gap.
		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getRenderState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show the current hierarchical action plan",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE),
					"error",
				);
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			ctx.ui.notify(renderPlan(state.tasks, "tree", 16000), "info");
			return;
		},
	});
}
