/** The model route of a child. Each agent has a role (main, helper or legwork);
 * a role runs on the model the user set for it in the `team` settings, and on
 * the session's own model unless set. A child that forks the conversation
 * always runs on the session's model: the history it replays is cached only
 * there. Its effort controller (Jev) picks the thinking level at launch, from
 * the session's ceiling lowered by the caps and the role's own ceiling. */
import { loadTeamConfig, resolveAgentRole, resolveRoleRoute, roleThinkingCeiling, TEAM_ROLES, type TeamRole, type TeamSettings } from "../../../../lib/team.ts";
import { mapChildren } from "./session-siblings.ts";
import { splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo, type ThinkingLevel } from "../../shared/model-info.ts";

export type { AvailableModelInfo };

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/** The session's own provider/id. An explicit `provider/id` keeps each session's
 * children on that session's model instead of the shared settings default
 * another open session may have changed. */
export function sessionChildModel(parentModel: ParentModel | undefined): string {
	if (!parentModel) throw new Error("Subagents run on the session's model, and this session has no model selected.");
	return `${parentModel.provider}/${parentModel.id}`;
}

export interface ChildRoute {
	model: string;
	/** The role, only when the child runs on another model than the session's: what a line about the child shows. */
	shownRole?: TeamRole;
	/** The role's thinking ceiling; none for a forked child and for the main role. */
	maxThinking?: ThinkingLevel;
}

export function resolveChildRoute(input: {
	agent: { name: string; extraFields?: Record<string, string> };
	callRole?: TeamRole;
	forked: boolean;
	parentModel: ParentModel | undefined;
	availableModels?: AvailableModelInfo[] | (() => AvailableModelInfo[]);
	cwd: string;
	team?: TeamSettings;
}): ChildRoute {
	if (input.forked) return { model: sessionChildModel(input.parentModel) };
	const team = input.team ?? loadTeamConfig(input.cwd).team;
	const role = resolveAgentRole(input.agent, team, input.callRole);
	const maxThinking = roleThinkingCeiling(role, team);
	const model = resolveRoleRoute(role, team, input.parentModel, input.availableModels);
	// A configured role model needs no session model; only the comparison with it does.
	const onSessionModel = input.parentModel !== undefined && model === sessionChildModel(input.parentModel);
	return {
		model,
		...(!onSessionModel ? { shownRole: role } : {}),
		...(maxThinking ? { maxThinking } : {}),
	};
}

/** The call's `role` as the default of every `tasks` item and `chain` step that has none of its own. */
export function withCallRole<T extends { role?: TeamRole }>(params: T): T {
	const { role } = params;
	if (!role) return params;
	return mapChildren(params, (item) => (item.role === undefined ? { ...item, role } : item));
}

/** Refuse a `role` that is not main, helper or legwork on the call or on any task or step. */
export function validateCallRoles(params: { role?: unknown; tasks?: unknown[]; chain?: unknown[] }): string | undefined {
	const values: unknown[] = [params.role];
	const visit = (item: unknown): void => {
		if (!item || typeof item !== "object") return;
		values.push((item as { role?: unknown }).role);
		const group = (item as { parallel?: unknown }).parallel;
		if (Array.isArray(group)) group.forEach(visit);
		else if (group) visit(group);
	};
	params.tasks?.forEach(visit);
	params.chain?.forEach(visit);
	const valid = (value: unknown): boolean => value === undefined || (TEAM_ROLES as readonly unknown[]).includes(value);
	return values.every(valid) ? undefined : `role must be ${TEAM_ROLES.join(", ")}.`;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colon = model.lastIndexOf(":");
	if (colon < 0) return splitKnownThinkingSuffix(model);
	const parsed = splitKnownThinkingSuffix(`${model.slice(0, colon)}:${model.slice(colon + 1).toLowerCase()}`);
	return parsed.thinkingSuffix ? parsed : { baseModel: model, thinkingSuffix: "" };
}

export function formatSubagentModelVerificationError(expectedModel: string, observedModel: string, availableModels: AvailableModelInfo[] | undefined): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: child reported a different model than the one it was launched on. Expected '${expectedModel}' but observed '${observedModel}'.`;
}

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

/**
 * Context-overflow signals: the input was too large for the model's context
 * window, so rerunning the same input cannot succeed. Callers treat overflow
 * as terminal and surface a clear "input too large" error.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/token limit/i,
	/context_length_exceeded/i,
	/length_required/i,
	/maximum.*tokens/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
	/context.*overflow/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}
