/**
 * /team — the `team` block and the run budget, read and edited in one place.
 *
 * With no argument the command opens a picker over the values loadTeamConfig
 * resolves (the global settings file overridden per key by the project one).
 * A change is written only to the global file, through the settings owner's
 * locked writer, and keeps every key it does not touch. `/team show` prints
 * the same values as text; without a UI that is all the command can do.
 */
import {
	DynamicBorder,
	SettingsManager,
	getAgentDir,
	getSelectListTheme,
	rawKeyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@yunuspi/coding-agent";
import { Container, Input, SelectList, Spacer, Text, fuzzyFilter, getKeybindings } from "@yunuspi/tui";
import {
	BUILTIN_AGENT_ROLES,
	SIDE_CALL_PLACES,
	TEAM_ROLES,
	loadTeamConfig,
	readTeamPatch,
	type TeamConfig,
	type TeamPatch,
	type TeamRole,
} from "./lib/team.ts";
import { getProjectAgentSettingsPath, getUserAgentSettingsPath } from "./pi-subagents/src/agents/agents.ts";
import { THINKING_LEVELS } from "./pi-subagents/src/shared/model-info.ts";

export const USAGE = "Usage: /team [show]";

export const ROW_LABELS = {
	helper: "Helper model: long stretches that need judgment (worker, reviewer)",
	legwork: "Legwork model: finding, reading, checks, mechanical edits (scout, researcher, delegate)",
	advisor: "Advisor model: answers one hard question",
	helperThinking: "Helper thinking ceiling",
	legworkThinking: "Legwork thinking ceiling",
	sideCalls: "Side calls (observer notes, memory summaries) run on",
	minutes: "Run budget: minutes",
	usd: "Run budget: dollars",
	roles: "Agent roles",
} as const;

export type TeamRowId = keyof typeof ROW_LABELS;
export const ROW_ORDER: readonly TeamRowId[] = [
	"helper",
	"legwork",
	"advisor",
	"helperThinking",
	"legworkThinking",
	"sideCalls",
	"minutes",
	"usd",
	"roles",
];

export interface TeamRow {
	id: TeamRowId;
	label: string;
	value: string;
}

export interface TeamChange {
	row: TeamRowId;
	value: string | number;
	/** The agent whose role changes, for the `roles` row. */
	agent?: string;
}

const ROLE_MODEL_ROW = { helper: "helper", legwork: "legwork", advisor: "advisor" } as const;
const modelText = (setting: string): string => (setting === "inherit" ? "same as the session" : setting);
const budgetText = (value: number): string => (value === 0 ? "off" : String(value));

/** Agents whose role can be set here: the built-in six, then any agent the settings already name. */
export function knownAgents(roles: Record<string, TeamRole> = {}): string[] {
	const builtin = Object.keys(BUILTIN_AGENT_ROLES);
	const extra = Object.keys(roles)
		.filter((agent) => !builtin.includes(agent))
		.sort();
	return [...builtin, ...extra];
}

/** The role of every agent that matters here, built-in table with settings merged over it. */
export function effectiveRoles(roles: Record<string, TeamRole> = {}): [string, TeamRole][] {
	return knownAgents(roles).map((agent) => [agent, roles[agent] ?? BUILTIN_AGENT_ROLES[agent] ?? "main"]);
}

export function teamRows(config: TeamConfig): TeamRow[] {
	const { team, run } = config;
	const set = Object.keys(team.roles);
	return ROW_ORDER.map((id) => {
		const label = ROW_LABELS[id];
		switch (id) {
			case "helper":
			case "legwork":
			case "advisor":
				return { id, label, value: modelText(team[id]) };
			case "helperThinking":
				return { id, label, value: team.maxThinking.helper };
			case "legworkThinking":
				return { id, label, value: team.maxThinking.legwork };
			case "sideCalls":
				return { id, label, value: team.sideCalls };
			case "minutes":
				return { id, label, value: budgetText(run.softMinutes) };
			case "usd":
				return { id, label, value: budgetText(run.softUsd) };
			case "roles":
				return {
					id,
					label,
					value: set.length ? set.map((agent) => `${agent}=${team.roles[agent]}`).join(", ") : "built-in",
				};
		}
	});
}

function aligned(rows: [string, string][]): string {
	const width = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}

/** `/team show`: the effective values as short aligned lines, with no UI. */
export function showText(config: TeamConfig): string {
	const { team, run } = config;
	const rows: [string, string][] = [
		["Helper model", modelText(team.helper)],
		["Legwork model", modelText(team.legwork)],
		["Advisor model", team.advisor],
		["Helper thinking ceiling", team.maxThinking.helper],
		["Legwork thinking ceiling", team.maxThinking.legwork],
		["Side calls", team.sideCalls],
		["Run budget minutes", budgetText(run.softMinutes)],
		["Run budget dollars", budgetText(run.softUsd)],
	];
	const roles = effectiveRoles(team.roles);
	const roleWidth = Math.max(...roles.map(([agent]) => agent.length));
	const roleLines = roles.map(([agent, role]) => `  ${agent.padEnd(roleWidth)}  ${role}`);
	return [aligned(rows), "Agent roles", ...roleLines].join("\n");
}

/** Options for a model row: the role's own first choice, every available model, then the stored one. */
export function modelChoices(role: TeamRole, current: string, models: readonly string[]): string[] {
	const first = role === "advisor" ? "Off" : "Same as the session";
	const options = [first];
	for (const route of models) if (!options.includes(route)) options.push(route);
	if (current !== "inherit" && current !== "off" && !options.includes(current)) options.push(current);
	return options;
}

/** The stored value an option stands for. */
export function modelChoiceValue(option: string): string {
	if (option === "Same as the session") return "inherit";
	if (option === "Off") return "off";
	return option;
}

/** A model as the picker searches it: the route plus the display name the registry gives it. */
export interface ModelEntry {
	route: string;
	name?: string;
}

/**
 * The options a search leaves, best first. Every word must appear in the
 * provider, id or name ("codex", "openrouter qwen", "gpt-5"); when no option
 * holds every word, a looser fuzzy match runs so a typo still finds something.
 * The role's first option (session model / off) stays at the top of an empty search.
 */
export function filterModelOptions(options: readonly string[], query: string, names: ReadonlyMap<string, string> = new Map()): string[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...options];
	const text = (option: string) => `${option} ${names.get(option) ?? ""}`.toLowerCase();
	const exact = options.filter((option) => words.every((word) => text(option).includes(word)));
	if (exact.length) return exact;
	return fuzzyFilter([...options], query, text);
}

/** The model picker: type to narrow the list, arrows to move, Enter to choose. */
function pickModel(ctx: ExtensionCommandContext, title: string, options: string[], current: string, names: ReadonlyMap<string, string>): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const box = new Container();
		const input = new Input();
		const listArea = new Container();
		let list: SelectList | undefined;
		let query = "";
		input.focused = true;
		const fill = () => {
			listArea.clear();
			const shown = filterModelOptions(options, query, names);
			if (!shown.length) {
				list = undefined;
				listArea.addChild(new Text(theme.fg("muted", "  No model matches."), 0, 0));
				return;
			}
			list = new SelectList(
				shown.map((option) => ({ value: option, label: option, description: option === current ? "current" : names.get(option) })),
				12,
				getSelectListTheme(),
			);
			const at = query ? 0 : shown.indexOf(current);
			if (at > 0) list.setSelectedIndex(at);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			listArea.addChild(list);
		};
		box.addChild(new DynamicBorder());
		box.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		box.addChild(new Spacer(1));
		box.addChild(input);
		box.addChild(new Spacer(1));
		box.addChild(listArea);
		box.addChild(new Spacer(1));
		box.addChild(new Text(rawKeyHint("type", "search") + "  " + rawKeyHint("↑↓", "move") + "  " + rawKeyHint("enter", "choose") + "  " + rawKeyHint("esc", "back"), 1, 0));
		box.addChild(new DynamicBorder());
		fill();
		return {
			render: (width: number) => box.render(width),
			invalidate: () => box.invalidate(),
			handleInput(data: string) {
				const keys = getKeybindings();
				if (keys.matches(data, "tui.select.cancel")) return done(undefined);
				if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.confirm")) {
					list?.handleInput(data);
				} else {
					input.handleInput(data);
					if (input.getValue() !== query) {
						query = input.getValue();
						fill();
					}
				}
				tui.requestRender();
			},
		};
	});
}

/** A run-budget answer: a finite number of 0 or more, or null when it is refused. */
export function parseBudgetValue(text: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const value = Number(trimmed);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The patch a change produces; only the changed key is added, every stored key is kept. */
export function withTeamChange(patch: TeamPatch, change: TeamChange): TeamPatch {
	const next: TeamPatch = { team: { ...patch.team }, run: { ...patch.run } };
	if (patch.team.roles) next.team.roles = { ...patch.team.roles };
	if (patch.team.maxThinking) next.team.maxThinking = { ...patch.team.maxThinking };
	switch (change.row) {
		case "helper":
		case "legwork":
		case "advisor":
			next.team[change.row] = String(change.value);
			return next;
		case "helperThinking":
		case "legworkThinking": {
			const role = change.row === "helperThinking" ? "helper" : "legwork";
			next.team.maxThinking = { ...next.team.maxThinking, [role]: String(change.value) };
			return next;
		}
		case "sideCalls":
			next.team.sideCalls = String(change.value) as TeamConfig["team"]["sideCalls"];
			return next;
		case "minutes":
			next.run.softMinutes = Number(change.value);
			return next;
		case "usd":
			next.run.softUsd = Number(change.value);
			return next;
		case "roles": {
			const agent = change.agent;
			const role = String(change.value);
			if (!agent) throw new Error("A role change needs the agent it belongs to.");
			if (!(TEAM_ROLES as readonly string[]).includes(role)) {
				throw new Error(`Unknown role '${role}'; expected ${TEAM_ROLES.join(", ")}.`);
			}
			next.team.roles = { ...next.team.roles, [agent]: role as TeamRole };
			return next;
		}
	}
}

/** The settings path a change writes, for the project-override note. */
export function changePath(change: TeamChange): string {
	switch (change.row) {
		case "minutes":
			return "run.softMinutes";
		case "usd":
			return "run.softUsd";
		case "helperThinking":
			return "team.maxThinking.helper";
		case "legworkThinking":
			return "team.maxThinking.legwork";
		case "roles":
			return `team.roles.${change.agent ?? ""}`;
		default:
			return `team.${change.row}`;
	}
}

/** Whether a patch sets one `team`/`run` path, e.g. "team.maxThinking.helper". */
export function patchSetsPath(patch: TeamPatch, key: string): boolean {
	const [block, field, nested] = key.split(".");
	const value: unknown = block === "run" ? (patch.run as Record<string, unknown>)[field] : (patch.team as Record<string, unknown>)[field];
	if (value === undefined) return false;
	if (nested === undefined) return true;
	return typeof value === "object" && value !== null && nested in (value as Record<string, unknown>);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function chooseChange(
	ctx: ExtensionCommandContext,
	row: TeamRow,
	config: TeamConfig,
	models: readonly ModelEntry[],
): Promise<TeamChange | undefined> {
	switch (row.id) {
		case "helper":
		case "legwork":
		case "advisor": {
			const current = config.team[row.id];
			const options = modelChoices(row.id, current, models.map((model) => model.route));
			const names = new Map(models.filter((model) => model.name && model.name !== model.route).map((model) => [model.route, model.name as string]));
			// RPC clients (the desktop app) draw their own pickers and only answer plain selects.
			const shownCurrent = current === "inherit" || current === "off" ? options[0] : current;
			const picked =
				ctx.mode === "rpc" || typeof ctx.ui.custom !== "function"
					? await ctx.ui.select(row.label, options)
					: await pickModel(ctx, row.label, options, shownCurrent, names);
			if (!picked || !options.includes(picked)) return undefined;
			return { row: row.id, value: modelChoiceValue(picked) };
		}
		case "helperThinking":
		case "legworkThinking": {
			const picked = await ctx.ui.select(row.label, [...THINKING_LEVELS]);
			if (!picked || !(THINKING_LEVELS as readonly string[]).includes(picked)) return undefined;
			return { row: row.id, value: picked };
		}
		case "sideCalls": {
			const picked = await ctx.ui.select(row.label, [...SIDE_CALL_PLACES]);
			if (!picked || !(SIDE_CALL_PLACES as readonly string[]).includes(picked)) return undefined;
			return { row: row.id, value: picked };
		}
		case "minutes":
		case "usd": {
			const hint = row.id === "minutes" ? "minutes, 0 switches the limit off" : "dollars, 0 switches the limit off";
			const answer = await ctx.ui.input(row.label, hint);
			if (answer === undefined) return undefined;
			const value = parseBudgetValue(answer);
			if (value === null) {
				ctx.ui.notify(`${row.label} must be a number of 0 or more; nothing was changed.`, "error");
				return undefined;
			}
			return { row: row.id, value };
		}
		case "roles": {
			const agents = effectiveRoles(config.team.roles);
			const options = agents.map(([agent, role]) => `${agent}: ${role}`);
			const picked = await ctx.ui.select(row.label, options);
			const agent = agents.find(([name, role]) => `${name}: ${role}` === picked)?.[0];
			if (!agent) return undefined;
			const role = await ctx.ui.select(`Role for ${agent}`, [...TEAM_ROLES]);
			if (!role || !(TEAM_ROLES as readonly string[]).includes(role)) return undefined;
			return { row: row.id, value: role, agent };
		}
	}
}

/** The note the project file earns when it sets the key just changed. */
function projectOverrideNote(cwd: string, change: TeamChange): string | undefined {
	const file = getProjectAgentSettingsPath(cwd);
	if (!file) return undefined;
	let patch: TeamPatch;
	try {
		patch = readTeamPatch(file);
	} catch {
		return undefined;
	}
	const path = changePath(change);
	if (!patchSetsPath(patch, path)) return undefined;
	return `Project settings also set ${path} here, which overrides the global file for this project.`;
}

async function writeChange(ctx: ExtensionCommandContext, change: TeamChange): Promise<void> {
	const globalFile = getUserAgentSettingsPath();
	const next = withTeamChange(readTeamPatch(globalFile), change);
	const settings = SettingsManager.create(ctx.cwd, getAgentDir());
	// What failed while loading (a broken project file, say) is not this write's failure.
	settings.drainErrors();
	settings.setTeamSettings(next.team, next.run);
	await settings.flush();
	if (settings.drainErrors().length) throw new Error(`Could not save the team settings to '${globalFile}'.`);
}

async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		let config: TeamConfig;
		try {
			config = loadTeamConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			return;
		}
		const rows = teamRows(config);
		const rowTexts = rows.map((row) => `${row.label} — ${row.value}`);
		const done = "Done";
		const picked = await ctx.ui.select("Team", [...rowTexts, done]);
		if (!picked || picked === done) return;
		const row = rows[rowTexts.indexOf(picked)];
		if (!row) return;
		const models: ModelEntry[] = (ctx.modelRegistry?.getAvailable() ?? []).map((model) => ({ route: `${model.provider}/${model.id}`, name: model.name }));
		const change = await chooseChange(ctx, row, config, models);
		if (!change) continue;
		try {
			await writeChange(ctx, change);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
			continue;
		}
		const lines = ["Change saved; it applies to children launched from now on."];
		if (change.row === "advisor") lines.push("The advisor tool is added at your next message if it is missing; turning the advisor off makes its calls refuse.");
		const note = projectOverrideNote(ctx.cwd, change);
		if (note) lines.push(note);
		ctx.ui.notify(lines.join(" "), "info");
	}
}

export default function teamCommand(pi: ExtensionAPI) {
	pi.registerCommand("team", {
		description: "Which model takes each kind of delegated work, and the soft budget of one run",
		argumentHint: "[show]",
		async handler(args, ctx) {
			const verb = args.trim().toLowerCase();
			if (verb && verb !== "show") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			let config: TeamConfig;
			try {
				config = loadTeamConfig(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
				return;
			}
			if (verb === "show" || !ctx.hasUI) {
				ctx.ui.notify(showText(config), "info");
				return;
			}
			await openPicker(ctx);
		},
	});
}
