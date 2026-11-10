import type { ExtensionAPI, ToolDefinition } from "@yunuspi/coding-agent";
import { SubagentWaitParams } from "../../extension/schemas.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
import { finalizeToolResult } from "../../extension/tool-result.ts";

export function registerWaitTool(
	pi: ExtensionAPI,
	state: SubagentState,
	enabled = resolveWaitToolConfig().enabled,
	subscriptions?: Pick<WaitSubscriptionManager, "arm">,
	defaultTimeoutMs?: number,
): void {
	const description = `Wait for background work that sends no completion notice (provider jobs, detached runs), then return. Async subagent runs and bg_run tasks report on their own (in a headless run, when the turn ends): wait for those only when this turn needs the result. With no arguments it returns when the first active run or provider job finishes, or a subagent needs attention.${enabled ? "" : "\n\nDisabled by config: returns at once without blocking."}`;
	const execute: ToolDefinition<typeof SubagentWaitParams, Details>["execute"] = async (_id, params, signal, onUpdate, ctx) => finalizeToolResult(await waitForSubagents(params, signal, {
		state,
		events: pi.events,
		enabled,
		...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
		onUpdate,
		...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
	}));
	const primaryTool: ToolDefinition<typeof SubagentWaitParams, Details> = {
		name: "bg_wait",
		label: "Background Wait",
		description,
		parameters: SubagentWaitParams,
		execute,
	};
	pi.registerTool(primaryTool);
}
