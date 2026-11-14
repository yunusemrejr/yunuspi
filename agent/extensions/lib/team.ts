/**
 * The one reader of the `team` and `run` settings blocks.
 *
 * `team` says which model each role of a session runs on, `run` is the soft
 * budget of one run (everything the session does after one user message).
 * Both live in <agentDir>/settings.json and may be overridden per key by the
 * project settings file; the files are read with the same strict reader the
 * subagent settings use. With no block everything resolves to today's
 * behaviour: every role runs on the session's model.
 */
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSettingsFileStrict } from "../pi-subagents/src/agents/agents.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../pi-subagents/src/shared/model-info.ts";

export const TEAM_ROLES = ["main", "helper", "legwork"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const SIDE_CALL_PLACES = ["legwork", "session"] as const;
export type SideCallPlace = (typeof SIDE_CALL_PLACES)[number];

/** Role of each built-in agent; any other agent is `main` unless told otherwise. */
export const BUILTIN_AGENT_ROLES: Readonly<Record<string, TeamRole>> = Object.freeze({
	scout: "legwork",
	researcher: "legwork",
	delegate: "legwork",
	worker: "helper",
	reviewer: "helper",
	oracle: "main",
});

export interface TeamSettings {
	/** "inherit" (the session's model) or "provider/model-id". */
	helper: string;
	legwork: string;
	/** "off" or "provider/model-id". */
	advisor: string;
	roles: Record<string, TeamRole>;
	maxThinking: { helper: ThinkingLevel; legwork: ThinkingLevel };
	sideCalls: SideCallPlace;
}

export interface RunBudget {
	/** 0 switches the limit off. */
	softMinutes: number;
	softUsd: number;
}

export interface TeamConfig {
	team: TeamSettings;
	run: RunBudget;
}

/** What one settings file holds: only the keys it sets. */
export interface TeamPatch {
	team: {
		helper?: string;
		legwork?: string;
		advisor?: string;
		roles?: Record<string, TeamRole>;
		maxThinking?: { helper?: ThinkingLevel; legwork?: ThinkingLevel };
		sideCalls?: SideCallPlace;
	};
	run: { softMinutes?: number; softUsd?: number };
}

export const DEFAULT_TEAM_CONFIG: Readonly<TeamConfig> = Object.freeze({
	team: Object.freeze({
		helper: "inherit",
		legwork: "inherit",
		advisor: "off",
		roles: Object.freeze({}) as Record<string, TeamRole>,
		maxThinking: Object.freeze({ helper: "xhigh", legwork: "high" }) as { helper: ThinkingLevel; legwork: ThinkingLevel },
		sideCalls: "legwork",
	}) as TeamSettings,
	run: Object.freeze({ softMinutes: 60, softUsd: 1 }),
});

const MODEL_ID = /^[^\s/]+\/\S+$/;

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function invalid(file: string, field: string, accepted: string): Error {
	return new Error(`Team settings in '${file}' have invalid '${field}'; expected ${accepted}.`);
}

function parseModelSetting(value: unknown, file: string, field: string, none: "inherit" | "off"): string {
	if (typeof value === "string" && (value === none || MODEL_ID.test(value))) return value;
	throw invalid(file, field, `"${none}" or a model as "provider/model-id"`);
}

function parseRole(value: unknown, file: string, field: string): TeamRole {
	if (typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value)) return value as TeamRole;
	throw invalid(file, field, TEAM_ROLES.map((role) => `"${role}"`).join(", "));
}

function parseCeiling(value: unknown, file: string, field: string): ThinkingLevel {
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw invalid(file, field, `one of ${THINKING_LEVELS.join(", ")}`);
}

function parseLimit(value: unknown, file: string, field: string): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	throw invalid(file, field, "a number of 0 or more (0 switches the limit off)");
}

/** Validate the `team` and `run` blocks of one parsed settings file. */
export function parseTeamPatch(settings: Record<string, unknown>, file: string): TeamPatch {
	const patch: TeamPatch = { team: {}, run: {} };
	if ("team" in settings) {
		const team = plainObject(settings.team);
		if (!team) throw invalid(file, "team", "an object");
		for (const key of Object.keys(team)) {
			if (!["helper", "legwork", "advisor", "roles", "maxThinking", "sideCalls"].includes(key)) {
				throw invalid(file, `team.${key}`, "one of helper, legwork, advisor, roles, maxThinking, sideCalls");
			}
		}
		if ("helper" in team) patch.team.helper = parseModelSetting(team.helper, file, "team.helper", "inherit");
		if ("legwork" in team) patch.team.legwork = parseModelSetting(team.legwork, file, "team.legwork", "inherit");
		if ("advisor" in team) patch.team.advisor = parseModelSetting(team.advisor, file, "team.advisor", "off");
		if ("sideCalls" in team) {
			if (typeof team.sideCalls !== "string" || !(SIDE_CALL_PLACES as readonly string[]).includes(team.sideCalls)) {
				throw invalid(file, "team.sideCalls", SIDE_CALL_PLACES.map((place) => `"${place}"`).join(" or "));
			}
			patch.team.sideCalls = team.sideCalls as SideCallPlace;
		}
		if ("roles" in team) {
			const roles = plainObject(team.roles);
			if (!roles) throw invalid(file, "team.roles", "an object of agent name to role");
			patch.team.roles = {};
			for (const [agent, role] of Object.entries(roles)) patch.team.roles[agent] = parseRole(role, file, `team.roles.${agent}`);
		}
		if ("maxThinking" in team) {
			const ceilings = plainObject(team.maxThinking);
			if (!ceilings) throw invalid(file, "team.maxThinking", "an object with helper and legwork levels");
			patch.team.maxThinking = {};
			for (const [role, level] of Object.entries(ceilings)) {
				if (role !== "helper" && role !== "legwork") throw invalid(file, `team.maxThinking.${role}`, "helper or legwork");
				patch.team.maxThinking[role] = parseCeiling(level, file, `team.maxThinking.${role}`);
			}
		}
	}
	if ("run" in settings) {
		const run = plainObject(settings.run);
		if (!run) throw invalid(file, "run", "an object");
		for (const key of Object.keys(run)) {
			if (key !== "softMinutes" && key !== "softUsd") throw invalid(file, `run.${key}`, "softMinutes or softUsd");
		}
		if ("softMinutes" in run) patch.run.softMinutes = parseLimit(run.softMinutes, file, "run.softMinutes");
		if ("softUsd" in run) patch.run.softUsd = parseLimit(run.softUsd, file, "run.softUsd");
	}
	return patch;
}

/** Defaults, then the global file, then the project file, key by key. */
export function mergeTeamPatches(...patches: TeamPatch[]): TeamConfig {
	const merged: TeamConfig = {
		team: { ...DEFAULT_TEAM_CONFIG.team, roles: {}, maxThinking: { ...DEFAULT_TEAM_CONFIG.team.maxThinking } },
		run: { ...DEFAULT_TEAM_CONFIG.run },
	};
	for (const { team, run } of patches) {
		if (team.helper !== undefined) merged.team.helper = team.helper;
		if (team.legwork !== undefined) merged.team.legwork = team.legwork;
		if (team.advisor !== undefined) merged.team.advisor = team.advisor;
		if (team.sideCalls !== undefined) merged.team.sideCalls = team.sideCalls;
		Object.assign(merged.team.roles, team.roles);
		Object.assign(merged.team.maxThinking, team.maxThinking);
		Object.assign(merged.run, run);
	}
	return merged;
}

export function readTeamPatch(file: string): TeamPatch {
	return parseTeamPatch(readSettingsFileStrict(file), file);
}

/** The settings that apply in `cwd`: the global file overridden per key by the project file. */
export function loadTeamConfig(cwd: string): TeamConfig {
	const patches = [readTeamPatch(getUserAgentSettingsPath())];
	const project = getProjectAgentSettingsPath(cwd);
	if (project) patches.push(readTeamPatch(project));
	return mergeTeamPatches(...patches);
}

/** Role of an agent: call > settings roles > the agent's `role:` frontmatter > built-in table > main. */
export function resolveAgentRole(
	agent: { name: string; extraFields?: Record<string, string> },
	team: Pick<TeamSettings, "roles">,
	callRole?: TeamRole,
): TeamRole {
	if (callRole) return callRole;
	const configured = team.roles[agent.name];
	if (configured) return configured;
	const frontmatter = agent.extraFields?.role;
	if (frontmatter !== undefined) {
		if (!(TEAM_ROLES as readonly string[]).includes(frontmatter)) {
			throw new Error(`Agent '${agent.name}' has invalid role frontmatter '${frontmatter}'; expected ${TEAM_ROLES.join(", ")}.`);
		}
		return frontmatter as TeamRole;
	}
	return BUILTIN_AGENT_ROLES[agent.name] ?? "main";
}

export interface ModelRef {
	provider: string;
	id: string;
}

const routeOf = (model: ModelRef): string => `${model.provider}/${model.id}`;

/**
 * Route of the model a role runs on. `main` and an "inherit" role run on the
 * session's model; a configured model must be among the available ones, else
 * the error names the setting and the model. The list is read only when a
 * configured model has to be checked, so a session that sets no team models
 * never asks the registry.
 */
export function resolveRoleRoute(
	role: TeamRole,
	team: Pick<TeamSettings, "helper" | "legwork">,
	sessionModel: ModelRef | undefined,
	available?: readonly ModelRef[] | (() => readonly ModelRef[]),
): string {
	const setting = role === "main" ? "inherit" : team[role];
	if (setting === "inherit") {
		if (!sessionModel) throw new Error("Subagents run on the session's model, and this session has no model selected.");
		return routeOf(sessionModel);
	}
	const models = typeof available === "function" ? available() : available;
	if (models && models.length > 0 && !models.some((model) => routeOf(model) === setting)) {
		throw new Error(`team.${role} is set to '${setting}', which is not among the available models. Pick another with /team.`);
	}
	return setting;
}

/** Thinking ceiling a role adds to the existing caps; the main role has none. */
export function roleThinkingCeiling(role: TeamRole, team: Pick<TeamSettings, "maxThinking">): ThinkingLevel | undefined {
	return role === "main" ? undefined : team.maxThinking[role];
}

/**
 * The model for calls the harness makes on its own behalf (observer notes,
 * memory summaries): the legwork model when `team.sideCalls` allows it and one
 * is set and available, else the session's. Calls that judge what the user
 * allowed never use this.
 */
export function sideCallModel<T extends ModelRef>(
	ctx: { model?: T; modelRegistry?: { getAvailable(): readonly T[] }; cwd?: string },
	config: TeamConfig = loadTeamConfig(ctx.cwd ?? process.cwd()),
): T | undefined {
	const { sideCalls, legwork } = config.team;
	if (sideCalls === "session" || legwork === "inherit") return ctx.model;
	return ctx.modelRegistry?.getAvailable().find((model) => routeOf(model) === legwork) ?? ctx.model;
}
