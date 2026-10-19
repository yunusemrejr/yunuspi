import type { AgentToolResult } from "@yunuspi/agent-core";
import type { ExtensionContext } from "@yunuspi/coding-agent";
import type { Details } from "../shared/types.ts";
import { buildWatchdogStatus } from "./register-main.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function buildCheckText(runtime: MainWatchdogRuntime | undefined, ctx: ExtensionContext): string {
	if (!runtime) return "Subagent watchdog runtime is unavailable.";
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) return ["Subagent watchdog config check", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	return ["Subagent watchdog config check", "Config: ok", `LSP diagnostics: ${snapshot.lsp.enabled ? "on" : "off"} · ${snapshot.lsp.status}`].join("\n");
}

export function handleWatchdogToolAction(action: string, _params: object, ctx: ExtensionContext, runtime?: MainWatchdogRuntime): AgentToolResult<Details> {
	try {
		if (action === "watchdog.status") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			return result(buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		}
		if (action === "watchdog.check") return result(buildCheckText(runtime, ctx));
		if (action === "watchdog.configure") {
			return result("Subagent watchdog has no configurable model or thinking. Reviews run on the session model at its current thinking level; use /subagents-watchdog on or off to change enablement.", true);
		}
		return result(`Unknown watchdog action: ${action}`, true);
	} catch (error) {
		return result(`Subagent watchdog action failed: ${error instanceof Error ? error.message : String(error)}`, true);
	}
}

export const WATCHDOG_TOOL_ACTIONS = ["watchdog.status", "watchdog.check", "watchdog.configure"] as const;
