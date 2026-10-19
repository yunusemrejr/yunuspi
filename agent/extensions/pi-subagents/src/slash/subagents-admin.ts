import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import {
	agentHasFrontmatterField,
	discoverAgentsAll,
	EXTRA_AGENT_DIRS_ENV,
	frontmatterNameForConfig,
	mergeBuiltinAgentOverride,
	removeBuiltinAgentOverrideFields,
	type AgentConfig,
	type BuiltinAgentOverrideBase,
} from "../agents/agents.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { editableAgentConfig, preservedAgentFrontmatterFields } from "../agents/agent-management.ts";
import { SelectorComponent, type SelectorItem, type SelectorResult } from "./selector.ts";

const ADMIN_MESSAGE_TYPE = "subagents-admin";

function sourceRank(source: AgentConfig["source"]): number {
	if (source === "project") return 0;
	if (source === "user") return 1;
	if (source === "package") return 2;
	return 3;
}

function allVisibleAgents(cwd: string): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	return [...d.project, ...d.user, ...d.package, ...d.builtin]
		.filter((agent) => !agent.disabled)
		.sort((a, b) => a.name.localeCompare(b.name) || sourceRank(a.source) - sourceRank(b.source));
}

function agentLabel(agent: AgentConfig): string {
	return `${agent.name} [${agent.source}] — ${agent.description}`;
}

function agentChoices(agents: AgentConfig[]): Map<string, AgentConfig> {
	const labels = agents.map(agentLabel);
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return new Map(agents.map((agent, index) => {
		const label = labels[index]!;
		return [counts.get(label) === 1 ? label : `${label} · ${agent.filePath}`, agent] as const;
	}));
}

function agentSelectItems(byLabel: Map<string, AgentConfig>): SelectorItem[] {
	return [...byLabel.keys()].map((label) => ({ value: label, label }));
}

function agentMatches(agent: AgentConfig, rawName: string): boolean {
	const name = rawName.trim();
	return agent.name === name || frontmatterNameForConfig(agent) === name;
}

function sendAdminMessage(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({
		customType: ADMIN_MESSAGE_TYPE,
		content,
		display: true,
	});
}

function buildBuiltinBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritGlobalContext: agent.inheritGlobalContext,
		inheritSkills: agent.inheritSkills,
		...(agent.defaultContext !== undefined ? { defaultContext: agent.defaultContext } : {}),
		...(agent.acceptanceRole !== undefined ? { acceptanceRole: agent.acceptanceRole } : {}),
		...(agent.disabled !== undefined ? { disabled: agent.disabled } : {}),
		systemPrompt: agent.systemPrompt,
		...(agent.skills !== undefined ? { skills: [...agent.skills] } : {}),
		...(agent.tools !== undefined ? { tools: [...agent.tools] } : {}),
		...(agent.excludeTools !== undefined ? { excludeTools: [...agent.excludeTools] } : {}),
		...(agent.mcpDirectTools !== undefined ? { mcpDirectTools: [...agent.mcpDirectTools] } : {}),
		...(agent.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: [...agent.subagentOnlyExtensions] } : {}),
		...(agent.mutationTools !== undefined ? { mutationTools: [...agent.mutationTools] } : {}),
		...(agent.completionGuard !== undefined ? { completionGuard: agent.completionGuard } : {}),
		...(agent.toolBudget !== undefined ? { toolBudget: agent.toolBudget } : {}),
	};
}

type EditableOverrideField = "systemPrompt";

type AgentSelection =
	| { kind: "selected"; agent: AgentConfig }
	| { kind: "cancelled" }
	| { kind: "not-found"; agents: AgentConfig[]; requestedName?: string }
	| { kind: "ambiguous"; requestedName: string; matches: AgentConfig[] };

function savesThroughSettings(agent: AgentConfig, field: EditableOverrideField): boolean {
	if (agent.source === "builtin") return true;
	if (agent.source === "package") {
		if (field === "systemPrompt") return false;
		return !agentHasFrontmatterField(agent, field);
	}
	if (!agent.override) return false;
	// A lower-scope override can flow into a higher-scope custom agent with the
	// same name. Persist that agent's edits in its own frontmatter instead of
	// rewriting the shared lower-scope override used by another agent.
	if (agent.source !== agent.override.scope) return false;
	// Custom-agent overrides fill only fields absent from frontmatter. Compare the
	// effective value with the pre-override base so an override on one field does
	// not redirect edits to an unrelated frontmatter-owned field.
	return agent[field] !== agent.override.base[field];
}

function isReadOnlyExtraAgent(agent: AgentConfig): boolean {
	const configured = process.env[EXTRA_AGENT_DIRS_ENV];
	if (!configured || agent.source !== "user") return false;
	const filePath = path.resolve(agent.filePath);
	return configured.split(path.delimiter).map((dir) => dir.trim()).filter(Boolean).some((dir) => {
		const root = path.resolve(dir);
		const relative = path.relative(root, filePath);
		return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	});
}

function readOnlyAgentMessage(agent: AgentConfig, field: EditableOverrideField): string | undefined {
	if (agent.source === "package") {
		return `Cannot update '${agent.name}' ${field} because that field is owned by its read-only package definition.`;
	}
	return isReadOnlyExtraAgent(agent)
		? `Cannot update '${agent.name}' because its definition in PI_SUBAGENT_EXTRA_AGENT_DIRS is read-only.`
		: undefined;
}

async function selectAgent(ctx: ExtensionContext, args: string): Promise<AgentSelection> {
	const agents = allVisibleAgents(ctx.cwd);
	const requestedName = args.trim().split(/\s+/)[0] ?? "";
	if (agents.length === 0) return { kind: "not-found", agents, requestedName: requestedName || undefined };

	if (requestedName) {
		const matches = agents.filter((agent) => agentMatches(agent, requestedName));
		if (matches.length === 1) return { kind: "selected", agent: matches[0]! };
		if (matches.length > 1 && !ctx.hasUI) return { kind: "ambiguous", requestedName, matches };
		if (matches.length > 1) {
			const byLabel = agentChoices(matches);
			const choice = await selectFromList(ctx, `Multiple subagents named '${requestedName}'`, agentSelectItems(byLabel));
			return choice ? { kind: "selected", agent: byLabel.get(choice)! } : { kind: "cancelled" };
		}
		return { kind: "not-found", agents, requestedName };
	}

	if (!ctx.hasUI) return { kind: "not-found", agents };
	const byLabel = agentChoices(agents);
	const choice = await selectFromList(ctx, "Select subagent", agentSelectItems(byLabel));
	return choice ? { kind: "selected", agent: byLabel.get(choice)! } : { kind: "cancelled" };
}

function metadataFor(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
	const lines = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	lines.push("Model: session (subagents run on the session model)");
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.excludeTools?.length) lines.push(`Excluded tools: ${agent.excludeTools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit global context: ${agent.inheritGlobalContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.override) lines.push(`Override: ${agent.override.scope} (${agent.override.path})`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

async function selectFromList(ctx: ExtensionContext, title: string, items: SelectorItem[]): Promise<string | undefined> {
	if (ctx.mode !== "rpc" && typeof ctx.ui.custom === "function") {
		const result = await ctx.ui.custom<SelectorResult>(
			(tui, theme, kb, done) => new SelectorComponent(tui, theme, kb, { title, items, done }),
			{ overlay: false },
		);
		return result?.confirmed ? result.value : undefined;
	}
	const labelToValue = new Map(items.map((item) => [item.label, item.value] as const));
	const choice = await ctx.ui.select(title, items.map((item) => item.value));
	return choice ? (items.find((item) => item.value === choice)?.value ?? labelToValue.get(choice)) : undefined;
}

async function chooseOverrideScope(ctx: ExtensionContext, agent: AgentConfig): Promise<"user" | "project" | undefined> {
	if (agent.override?.scope) return agent.override.scope;
	const d = discoverAgentsAll(ctx.cwd);
	if (!d.projectSettingsPath || !ctx.hasUI) return "user";
	const choice = await ctx.ui.select(`Save builtin override for ${agent.name}`, ["user", "project"]);
	return choice === "user" || choice === "project" ? choice : undefined;
}

function persistSettingsField(
	ctx: ExtensionContext,
	agent: AgentConfig,
	scope: "user" | "project",
	field: EditableOverrideField,
	value: string | undefined,
): { filePath: string; overridden: boolean } {
	const base = agent.override?.base ?? buildBuiltinBase(agent);
	if (value === undefined || value === base[field]) {
		return {
			filePath: removeBuiltinAgentOverrideFields(ctx.cwd, agent.name, scope, [field]).path,
			overridden: false,
		};
	}
	return {
		filePath: mergeBuiltinAgentOverride(ctx.cwd, agent.name, scope, { [field]: value }),
		overridden: true,
	};
}

async function saveAgentSystemPrompt(ctx: ExtensionContext, agent: AgentConfig, systemPrompt: string): Promise<string | null> {
	const nextPrompt = systemPrompt.replace(/\s+$/, "");
	if (savesThroughSettings(agent, "systemPrompt")) {
		const scope = await chooseOverrideScope(ctx, agent);
		if (!scope) return null;
		const { filePath, overridden } = persistSettingsField(ctx, agent, scope, "systemPrompt", nextPrompt);
		return overridden
			? `Saved ${scope} settings override for '${agent.name}' system prompt in ${filePath}.`
			: `Cleared system prompt settings override for '${agent.name}' in ${filePath}.`;
	}
	const readOnlyMessage = readOnlyAgentMessage(agent, "systemPrompt");
	if (readOnlyMessage) return readOnlyMessage;
	const updated: AgentConfig = { ...editableAgentConfig(agent), systemPrompt: nextPrompt };
	fs.writeFileSync(updated.filePath, serializeAgent(updated, {
		preserveFrontmatterFields: preservedAgentFrontmatterFields(agent, { systemPrompt: nextPrompt }),
	}), "utf-8");
	return `Updated '${agent.name}' system prompt in ${updated.filePath}.`;
}

async function editSystemPrompt(ctx: ExtensionContext, agent: AgentConfig): Promise<string | null> {
	if (!savesThroughSettings(agent, "systemPrompt")) {
		const readOnlyMessage = readOnlyAgentMessage(agent, "systemPrompt");
		if (readOnlyMessage) return readOnlyMessage;
	}
	const edited = await ctx.ui.editor(`Edit '${agent.name}' system prompt`, agent.systemPrompt ?? "");
	if (edited === undefined) return null;
	if (edited.replace(/\s+$/, "") === (agent.systemPrompt ?? "").replace(/\s+$/, "")) {
		return `System prompt for '${agent.name}' left unchanged.`;
	}
	return saveAgentSystemPrompt(ctx, agent, edited);
}

export async function openSubagentsAdmin(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
	const selection = await selectAgent(ctx, args);
	if (selection.kind === "cancelled") return;
	if (selection.kind === "ambiguous") {
		sendAdminMessage(pi, `Subagent '${selection.requestedName}' is ambiguous. Choose a scope in interactive mode:\n${selection.matches.map((agent) => `- ${agent.source}: ${agent.filePath}`).join("\n")}`);
		return;
	}
	if (selection.kind === "not-found") {
		const text = selection.requestedName
			? `Subagent '${selection.requestedName}' not found.\n\nAvailable subagents:\n${selection.agents.map((agent) => `- ${agent.name} (${agent.source})`).join("\n") || "- (none)"}`
			: `Available subagents:\n${selection.agents.map((agent) => `- ${agent.name} (${agent.source})`).join("\n") || "- (none)"}`;
		sendAdminMessage(pi, text);
		return;
	}
	const agent = selection.agent;

	if (!ctx.hasUI) {
		// Non-interactive (tool/headless): emit full metadata as the inspection result.
		sendAdminMessage(pi, metadataFor(agent));
		return;
	}

	const requestedAction = args.trim().split(/\s+/)[1]?.toLowerCase();
	let action: string | undefined;
	if (requestedAction === "prompt" || requestedAction === "system-prompt" || requestedAction === "edit") action = "Edit system prompt";
	else if (requestedAction === "details" || requestedAction === "info") action = "Show details";
	if (!action) {
		action = await ctx.ui.select(
			`Administer ${agent.name}\nSource: ${agent.source}`,
			["Edit system prompt", "Show details", "Done"],
		);
	}

	try {
		if (action === "Edit system prompt") {
			const message = await editSystemPrompt(ctx, agent);
			if (message === null) return;
			ctx.ui.notify(message, "info");
			sendAdminMessage(pi, message);
		} else if (action === "Show details") {
			// Full metadata is now opt-in (previously always posted to the thread).
			sendAdminMessage(pi, metadataFor(agent));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(message, "error");
		sendAdminMessage(pi, `Failed to update '${agent.name}': ${message}`);
	}
}
