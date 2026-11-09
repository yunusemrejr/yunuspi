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
	const description = `Wait for background work that has no native completion notice, then return. Ordinary async subagent runs notify you on their own, so in interactive chat return control instead of waiting for them. Use this for provider jobs, detached foreground runs and other work with no notification path. In headless runs, subagent work drains at agent_end; use this only when the current turn needs those results. With no arguments it returns when the first active run or provider job finishes, or when a subagent needs attention. A nonBlocking wait registers a wake and shows in subagent status. In a child agent, keep bg_wait in the tool allowlist and load each provider through extensions or subagentOnlyExtensions; this tool loads no providers.${enabled ? "" : "\n\nDisabled by config: returns at once without blocking."}`;
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
