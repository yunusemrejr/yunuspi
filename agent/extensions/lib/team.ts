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
import { vendorModelAlias } from "@yunuspi/coding-agent";
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSettingsFileStrict } from "../pi-subagents/src/agents/agents.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../pi-subagents/src/shared/model-info.ts";
import { latestOfTier, routeOf, type ModelRef } from "./model-tiers.ts";
import { forbiddenPaidRoute } from "./vendor-policy.ts";

export const TEAM_ROLES = ["main", "helper", "legwork"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const SIDE_CALL_PLACES = ["legwork", "session"] as const;
export type SideCallPlace = (typeof SIDE_CALL_PLACES)[number];
export const FREE_SETTINGS = ["on", "off"] as const;
export type FreeSetting = (typeof FREE_SETTINGS)[number];
export const PAID_VENDOR_SETTINGS = ["block", "allow"] as const;
export type PaidVendorSetting = (typeof PAID_VENDOR_SETTINGS)[number];

/** Role of each built-in agent; any other agent is `main` unless told otherwise. */
export const BUILTIN_AGENT_ROLES: Readonly<Record<string, TeamRole>> = Object.freeze({
	scout: "legwork",
	researcher: "legwork",
	delegate: "legwork",
	worker: "helper",
	reviewer: "helper",
	oracle: "main",
});

/** The agent a child runs when it names none, or names only a role: the plain worker of that role. */
export const ROLE_DEFAULT_AGENT: Readonly<Record<TeamRole, string>> = Object.freeze({
	legwork: "delegate",
	helper: "worker",
	main: "delegate",
});

const isTeamRole = (value: unknown): value is TeamRole => (TEAM_ROLES as readonly unknown[]).includes(value);

/**
 * The agent for a child that gave no `agent`, or gave a role name ("legwork",
 * "helper", "main") that no agent answers to, with the role that name stood for
 * unless the child or call already set one. Undefined when `agent` names a real
 * agent, or is not a string at all: it runs as written and the caller's own
 * checks report it. A `role` that is not a role is ignored here and refused
 * later by the caller's own role check.
 */
export function agentForRole(agent: unknown, role: unknown, isAgent: (name: string) => boolean): { agent: string; role?: TeamRole } | undefined {
	const given = isTeamRole(role) ? role : undefined;
	if (agent === undefined || agent === null) return { agent: ROLE_DEFAULT_AGENT[given ?? "legwork"] };
	if (typeof agent !== "string") return undefined;
	const named = agent.trim().toLowerCase();
	if (!isTeamRole(named) || isAgent(agent)) return undefined;
	return { agent: ROLE_DEFAULT_AGENT[named], role: given ?? named };
}

export interface TeamSettings {
	/** "inherit" (the session's model), "provider/model-id" or "provider/latest-<tier>" (the newest model of that tier the provider lists). */
	helper: string;
	legwork: string;
	/** "inherit" (the legwork model) or a model setting: the model of a legwork child launched by a legwork child. */
	sublegwork: string;
	/** "off" or a model setting. */
	advisor: string;
	/** "off" or a model setting: a second consult model next to the advisor. */
	consultant: string;
	/** Weekly ChatGPT-quota percentage points one session may add before helper routes on openai-codex fall back to the legwork model; 0 never falls back. */
	subscriptionPoints: number;
	roles: Record<string, TeamRole>;
	maxThinking: { helper: ThinkingLevel; legwork: ThinkingLevel };
	sideCalls: SideCallPlace;
	/** "on": legwork children use free OpenRouter models while the day's free quota allows. */
	free: FreeSetting;
	/** "block": a request to Claude, GPT or Gemini outside a subscription is stopped before it is sent; "allow" lets it through. */
	paidVendors: PaidVendorSetting;
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
		sublegwork?: string;
		advisor?: string;
		consultant?: string;
		subscriptionPoints?: number;
		roles?: Record<string, TeamRole>;
		maxThinking?: { helper?: ThinkingLevel; legwork?: ThinkingLevel };
		sideCalls?: SideCallPlace;
		free?: FreeSetting;
		paidVendors?: PaidVendorSetting;
	};
	run: { softMinutes?: number; softUsd?: number };
}

export const DEFAULT_TEAM_CONFIG: Readonly<TeamConfig> = Object.freeze({
	team: Object.freeze({
		helper: "inherit",
		legwork: "inherit",
		sublegwork: "inherit",
		advisor: "off",
		consultant: "off",
		subscriptionPoints: 3,
		roles: Object.freeze({}) as Record<string, TeamRole>,
		maxThinking: Object.freeze({ helper: "xhigh", legwork: "high" }) as { helper: ThinkingLevel; legwork: ThinkingLevel },
		sideCalls: "legwork",
		free: "on",
		paidVendors: "block",
	}) as TeamSettings,
	run: Object.freeze({ softMinutes: 60, softUsd: 1 }),
});

const MODEL_ID = /^[^\s/]+\/\S+$/;
const TEAM_KEYS: readonly string[] = ["helper", "legwork", "advisor", "roles", "maxThinking", "sideCalls", "free", "consultant", "sublegwork", "subscriptionPoints", "paidVendors"];

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function invalid(file: string, field: string, accepted: string): Error {
	return new Error(`Team settings in '${file}' have invalid '${field}'; expected ${accepted}.`);
}

function parseModelSetting(value: unknown, file: string, field: string, none: "inherit" | "off"): string {
	if (typeof value === "string" && (value === none || MODEL_ID.test(value))) return value;
	throw invalid(file, field, `"${none}" or a model as "provider/model-id", or "provider/latest-<tier>" for the newest model of a tier`);
}

function parseRole(value: unknown, file: string, field: string): TeamRole {
	if (typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value)) return value as TeamRole;
	throw invalid(file, field, TEAM_ROLES.map((role) => `"${role}"`).join(", "));
}

function parseCeiling(value: unknown, file: string, field: string): ThinkingLevel {
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw invalid(file, field, `one of ${THINKING_LEVELS.join(", ")}`);
}

function parseLimit(value: unknown, file: string, field: string, zeroMeans = "0 switches the limit off"): number {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	throw invalid(file, field, `a number of 0 or more (${zeroMeans})`);
}

/** Validate the `team` and `run` blocks of one parsed settings file. */
export function parseTeamPatch(settings: Record<string, unknown>, file: string): TeamPatch {
	const patch: TeamPatch = { team: {}, run: {} };
	if ("team" in settings) {
		const team = plainObject(settings.team);
		if (!team) throw invalid(file, "team", "an object");
		for (const key of Object.keys(team)) {
			if (!TEAM_KEYS.includes(key)) {
				throw invalid(file, `team.${key}`, `one of ${TEAM_KEYS.join(", ")}`);
			}
		}
		if ("helper" in team) patch.team.helper = parseModelSetting(team.helper, file, "team.helper", "inherit");
		if ("legwork" in team) patch.team.legwork = parseModelSetting(team.legwork, file, "team.legwork", "inherit");
		if ("advisor" in team) patch.team.advisor = parseModelSetting(team.advisor, file, "team.advisor", "off");
		if ("consultant" in team) patch.team.consultant = parseModelSetting(team.consultant, file, "team.consultant", "off");
		if ("sublegwork" in team) patch.team.sublegwork = parseModelSetting(team.sublegwork, file, "team.sublegwork", "inherit");
		if ("subscriptionPoints" in team) patch.team.subscriptionPoints = parseLimit(team.subscriptionPoints, file, "team.subscriptionPoints", "0 never falls back");
		if ("sideCalls" in team) {
			if (typeof team.sideCalls !== "string" || !(SIDE_CALL_PLACES as readonly string[]).includes(team.sideCalls)) {
				throw invalid(file, "team.sideCalls", SIDE_CALL_PLACES.map((place) => `"${place}"`).join(" or "));
			}
			patch.team.sideCalls = team.sideCalls as SideCallPlace;
		}
		if ("free" in team) {
			if (typeof team.free !== "string" || !(FREE_SETTINGS as readonly string[]).includes(team.free)) {
				throw invalid(file, "team.free", FREE_SETTINGS.map((value) => `"${value}"`).join(" or "));
			}
			patch.team.free = team.free as FreeSetting;
		}
		if ("paidVendors" in team) {
			if (typeof team.paidVendors !== "string" || !(PAID_VENDOR_SETTINGS as readonly string[]).includes(team.paidVendors)) {
				throw invalid(file, "team.paidVendors", PAID_VENDOR_SETTINGS.map((value) => `"${value}"`).join(" or "));
			}
			patch.team.paidVendors = team.paidVendors as PaidVendorSetting;
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
		if (team.sublegwork !== undefined) merged.team.sublegwork = team.sublegwork;
		if (team.advisor !== undefined) merged.team.advisor = team.advisor;
		if (team.consultant !== undefined) merged.team.consultant = team.consultant;
		if (team.subscriptionPoints !== undefined) merged.team.subscriptionPoints = team.subscriptionPoints;
		if (team.sideCalls !== undefined) merged.team.sideCalls = team.sideCalls;
		if (team.free !== undefined) merged.team.free = team.free;
		if (team.paidVendors !== undefined) merged.team.paidVendors = team.paidVendors;
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
	if (project) {
		const patch = readTeamPatch(project);
		// A repository must not be able to switch off the guard on paid Claude, GPT and Gemini routes.
		if (patch.team.paidVendors === "allow") throw invalid(project, "team.paidVendors", `"block"; "allow" is accepted only in the global settings file (${getUserAgentSettingsPath()})`);
		patches.push(patch);
	}
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

const TIER_SELECTOR = /^([^\s/]+)\/latest-([a-z0-9]+)$/i;

/**
 * The concrete route a model setting stands for among the available models: the
 * setting itself when listed, the id the vendor lists now for a retired one,
 * or for `provider/latest-<tier>` the highest version of that provider's models
 * ending in `-<tier>` (gpt-6.1-terra over gpt-6-terra over gpt-5.6-terra).
 * Undefined when nothing matches.
 */
export function resolveModelSetting(setting: string, available: readonly ModelRef[]): string | undefined {
	if (available.some((model) => routeOf(model) === setting)) return setting;
	const slash = setting.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = setting.slice(0, slash);
	// A route saved under an id the vendor has since retired runs on the id it lists now.
	const alias = vendorModelAlias(provider, setting.slice(slash + 1));
	if (alias && available.some((model) => routeOf(model) === `${provider}/${alias}`)) return `${provider}/${alias}`;
	const tier = TIER_SELECTOR.exec(setting);
	return tier ? latestOfTier(tier[1]!, tier[2]!, available) : undefined;
}

/**
 * The route a `team.<field>` model setting runs on, or an error naming the
 * setting: not among the available models, a `latest-` selector with no model
 * list to read, or a route to Claude, GPT or Gemini that is not a subscription.
 * With no list known (none given, or empty) an exact setting passes through.
 */
export function resolveTeamModel(field: string, setting: string, models: readonly ModelRef[] | undefined): string {
	let route = setting;
	if (models && models.length > 0) {
		const resolved = resolveModelSetting(setting, models);
		if (!resolved) throw new Error(`team.${field} is set to '${setting}', which is not among the available models. Pick another with /team.`);
		route = resolved;
	} else if (TIER_SELECTOR.test(setting)) {
		throw new Error(`team.${field} is set to '${setting}', a latest- selector, and the available models are not known here to pick from. Pick a model with /team.`);
	}
	const reason = forbiddenPaidRoute(route);
	if (reason) throw new Error(`team.${field} is set to '${setting}', which ${reason}. Pick another with /team.`);
	return route;
}

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
	return resolveTeamModel(role, setting, typeof available === "function" ? available() : available);
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
	const available = ctx.modelRegistry?.getAvailable() ?? [];
	const route = resolveModelSetting(legwork, available);
	// A route to Claude, GPT or Gemini that is not a subscription is never a side call's model.
	if (!route || forbiddenPaidRoute(route)) return ctx.model;
	return available.find((model) => routeOf(model) === route) ?? ctx.model;
}
