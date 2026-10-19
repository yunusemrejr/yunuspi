/**
 * Preset goals — /noslop, /nobug, /3d, /video and /anatomy, alone or chained.
 *
 * Each preset is a /goal with a short standard and the few fronts it is judged
 * on. Chained, the standards share one assignment: a chain that makes a video
 * turns noslop and nobug into checks on the picture and the file instead of a
 * codebase audit, and video with 3d or anatomy adds one film paragraph naming
 * the lead skill. Pure, so the wording and the chaining grammar are testable.
 */
import path from "node:path";
import { createGoal, createPresetGoal, MAX_CRITERIA, MAX_GOAL_TEXT, type GoalCriterion, type GoalState } from "./goal-state.ts";

export type PresetId = "noslop" | "nobug" | "3d" | "video" | "anatomy";
export const PRESET_IDS: readonly PresetId[] = ["noslop", "nobug", "3d", "video", "anatomy"];
export const PRESET_LABELS: Record<PresetId, string> = { noslop: "Noslop", nobug: "Nobug", "3d": "3D", video: "Video", anatomy: "Anatomy" };

const MAX_TASK = 4000;
const VERIFY_ID = "V";
/** A preset or /goal token: opened by start, whitespace or ( " ', closed by end, whitespace, or punctuation that itself ends the word
 * (`/3d.` at a sentence end) — so paths, URLs and file names (`src/3d`, `/video.mp4`, `/3d/models`) never match. */
const TOKEN = /(?<=^|[\s("'])\/(noslop|nobug|3d|video|anatomy|goal)(?=$|\s|[,.;:!?)"'](?=$|[\s,.;:!?)"']))/gi;
/** Fenced blocks and inline code spans: tokens inside them are text. */
const CODE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[\s\S]*?(?<!`)\1(?!`)/g;
/** Connector words and punctuation that a removed token can leave at either edge of the task. */
const LEAD_CONNECTOR = /^(?:(?:and|with|then|plus|also)(?!\w)|[&+](?=\s|$)|[,;])\s*/i;
const TAIL_CONNECTOR = /(?:^|\s)(?:and|with|then|plus|also|[&+])$|[,;]$/i;
/** Text that holds nothing but connector words and punctuation: what a token leaves stranded at an edge. */
const ONLY_CONNECTORS = /^[\s,;&+]*(?:(?:and|with|then|plus|also)(?!\w)[\s,;&+]*)*$/i;

export interface PresetChain {
	/** Invoked preset first, then the rest of the chain in written order, deduped. */
	presets: PresetId[];
	/** Remaining assignment text (may be empty: bare survey-and-fix). */
	task: string;
}

export interface PresetTokens extends PresetChain {
	/** A /goal token appeared: the text asks for a goal, not only a preset run. */
	goal: boolean;
	/** The user's text as typed, whitespace flattened, for authored-input analysis. */
	literal: string;
}

const clipTask = (text: string) => (text.length > MAX_TASK ? `${text.slice(0, MAX_TASK - 1)}…` : text);

function trimConnectors(text: string, lead: boolean, tail: boolean): string {
	let out = text.trim();
	for (let previous = ""; previous !== out; ) {
		previous = out;
		if (lead) out = out.replace(LEAD_CONNECTOR, "");
		if (tail) out = out.replace(TAIL_CONNECTOR, "");
		out = out.trim();
	}
	return out;
}

/**
 * Every preset and /goal token in a text, wherever it stands. The task is the
 * text with the tokens removed: the spacing they leave closes up, and a
 * connector word is dropped only where a token stranded it at an edge (the
 * text on that side held nothing but connectors). Text without any token comes
 * back trimmed and otherwise untouched.
 */
export function extractPresetTokens(text: string): PresetTokens {
	const raw = String(text ?? "");
	const literal = raw.replace(/\s+/g, " ").trim();
	const masked = raw.replace(CODE, (code) => "\u0000".repeat(code.length));
	const presets: PresetId[] = [];
	const spans: [number, number][] = [];
	let goal = false;
	for (const match of masked.matchAll(TOKEN)) {
		const name = match[1].toLowerCase();
		if (name === "goal") goal = true;
		else if (!presets.includes(name as PresetId)) presets.push(name as PresetId);
		const start = match.index ?? 0;
		spans.push([start, start + match[0].length]);
	}
	if (!spans.length) return { presets, goal, task: clipTask(raw.trim()), literal };
	let out = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		out = (out + raw.slice(cursor, start)).replace(/[ \t]+$/, "");
		cursor = end + /^[ \t]*/.exec(raw.slice(end))![0].length;
		const next = raw[cursor];
		// One space where the token stood, unless it sat at a line edge or before punctuation.
		if (out && !/[\r\n]$/.test(out) && next !== undefined && !/[\r\n,.;:!?)"']/.test(next)) out += " ";
	}
	const lead = ONLY_CONNECTORS.test(raw.slice(0, spans[0][0]));
	const tail = ONLY_CONNECTORS.test(raw.slice(spans[spans.length - 1][1]));
	return { presets, goal, task: clipTask(trimConnectors(out + raw.slice(cursor), lead, tail)), literal };
}

/**
 * `/3d /video /noslop make X` grammar: the core dispatches only the invoked
 * name, so the rest of the chain arrives in the args, anywhere in them. The
 * invoked preset leads, then the others in written order, deduped. A /goal
 * token is not part of the chain (see extractPresetTokens); an unknown /word
 * is not a preset and stays part of the assignment, typo and all.
 */
export function parsePresetChain(invoked: PresetId, args: string): PresetChain {
	const found = extractPresetTokens(`/${invoked} ${String(args ?? "")}`);
	return { presets: found.presets, task: found.task };
}

/** One line per chain member, for completion menus and command lists. */
export const CHAIN_SUMMARIES: Record<PresetId | "goal", string> = {
	goal: "track it as a goal with a real definition of done",
	noslop: "cut AI slop and clutter from UI, copy and code",
	nobug: "hunt, reproduce and fix bugs at the root",
	"3d": "real 3D assets and rendered proof (Blender, three.js)",
	video: "finished video: narration, music, effects, verified export",
	anatomy: "animated anatomy figures and reveal films from real parts",
};

/**
 * Completions for the token being typed after a chainable command: `/3d /no`
 * offers /noslop and /nobug. The invoked command and members already in the
 * text are not offered again.
 * Each value is the whole argument text with the partial token completed, since
 * the editor replaces the full argument prefix.
 */
export function chainCompletions(argumentPrefix: string, invoked?: PresetId | "goal"): { value: string; label: string; description: string }[] | null {
	const text = String(argumentPrefix ?? "");
	const partial = /(?:^|\s)(\/[\w-]*)$/.exec(text)?.[1];
	if (!partial) return null;
	const typed = partial.slice(1).toLowerCase();
	const present = extractPresetTokens(text.slice(0, text.length - partial.length));
	const base = text.slice(0, text.length - partial.length);
	const items = (["goal", ...PRESET_IDS] as const)
		.filter((id) => id !== invoked && id.startsWith(typed) && !(id === "goal" ? present.goal : present.presets.includes(id)))
		.map((id) => ({ value: `${base}/${id} `, label: `/${id}`, description: `boost · ${CHAIN_SUMMARIES[id]}` }));
	return items.length ? items : null;
}

/** The user's literal invocation, for authored-input analysis: `/3d /video make X`. */
export function presetUserText(presets: readonly PresetId[], task: string): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return `${presets.map((id) => `/${id}`).join(" ")}${flat ? ` ${flat}` : ""}`;
}

const skill = (name: string) => path.resolve(import.meta.dirname, "../../skills", name, "SKILL.md");

/** A generated photo with 3D decoration on top once shipped as a "3D film"; every picture-making boost says so. */
const NO_IMAGE_STANDIN = "Generated or stock images never stand in for the 3D picture: no photo plate with 3D decoration laid over it. Use image_generate only when the user asks for an image, or for a texture or reference the scene itself uses.";

interface Boost {
	/** The standard this boost holds the work to. */
	standard: string;
	/** What the bare command surveys for; empty means the whole project. */
	kind: string;
	/** Fronts, most important first; a chain keeps fewer. */
	fronts: readonly string[];
	/** In a chain that makes a video, noslop and nobug judge the picture and the file instead of a codebase. */
	media?: { standard: string; front: string };
}

const NOSLOP_STANDARD = [
	"Desloppify: remove what is there to look finished, designed or smart rather than to serve the user or the code's reader, and replace it plainly only where it did a real job. Test each element: what concretely gets worse if it goes? \"Less flashy\" is not worse.",
	"Interface: made-up labels and eyebrow pills, decorative pill badges, fake state (LIVE or ACTIVE badges, pulsing or haloed dots), invented colours outside the project's palette, neon, glows, glass and stock gradients (the indigo-to-purple default and its cream-and-terracotta inverse), emoji icons, monospace as a costume, build narration in product copy, boilerplate sections nobody asked for. Swap test: if the logo and headline could be swapped for an unrelated company's and the screen still works, it is not yet about this subject. Density: on every screen keep the few things its user comes for and move or delete the rest (as a calibration, 20 KPIs, 4 charts and a 10-item sidebar become about 4, 2 and 5); count elements before and after. A terminal app's output is its interface: no banners, chatter or decorative colour, and honor NO_COLOR. Where a wall of text explains a mechanism or product, one crafted figure (the anatomy skill) may replace it; never motion or 3D as decoration.",
	"Copy: no stock phrases (seamless, robust, unlock, elevate), filler, or numbers and endorsements without a source. Code: delete comments that narrate the code, commented-out code, dead code and files, unused dependencies and duplicate implementations; keep only the non-obvious why.",
	"Subtract first. Real things stay: genuine state, a deliberate brand system, motion that carries meaning, behavior and public interfaces. Match the project's own style and add no abstractions or files. Verify each front on the real artifact: build or tests, rendered screens before and after, the diff.",
].join("\n\n");

export const NOSLOP_CRITERIA: readonly string[] = [
	"No made-up labels, decorative pills, fake state, invented colours, neon or glow, emoji icons or boilerplate sections; each screen cut to what its user comes for, element counts recorded before and after.",
	"No stock phrases or unsourced numbers; narrating comments, dead code, unused dependencies and duplicate implementations removed.",
	"Behavior, public interfaces and the deliberate design kept; checks pass and rendered screens were compared before and after.",
];

const BOOSTS: Record<PresetId, Boost> = {
	noslop: {
		standard: NOSLOP_STANDARD,
		kind: "",
		fronts: NOSLOP_CRITERIA,
		media: {
			standard: "Noslop on the picture: every element on screen does a job for the viewer. No made-up labels, captions, numbers or interface chrome the subject does not have; no invented colours (the palette comes from the brand or the subject); no neon, glows, lens flares, gradient washes, pill badges, template lower thirds or decorative arrows; little on-screen text.",
			front: "every on-screen element does a job; no made-up labels or numbers, invented colours, glows, pills, decorative arrows or template graphics.",
		},
	},
	nobug: {
		standard: [
			"Debug: find real bugs, prove each, fix it at its root, and leave proof it stays fixed.",
			"Baseline first: run the project's checks (build, types, lint, tests), record what already fails, and map the entry points and surfaces users touch. Hunt logic errors (conditions, off-by-one, null paths, units and time zones, stale state, races, swallowed errors), edge cases (empty, huge and malformed input, failed network, missing files, first run versus upgrade), broken imports and scripts, and dependency drift. Where there is an interface, test the rendered thing: loading, empty and error states, keyboard and focus, 360px to wide layouts, the target browsers; a terminal app in narrow terminals, piped output and Ctrl-C.",
			"Each fix: a repro first (a failing test where the project has tests), the smallest root-cause change, then the repro and the existing checks pass. Never mask a bug with swallowed errors, skipped tests, disabled lints or retry loops. Report what you could not prove as suspected and name environments you could not check.",
		].join("\n\n"),
		kind: "",
		fronts: [
			"Every fix reproduced first, fixed at its root, and the repro and existing checks pass; nothing masked.",
			"The project's checks were run and the in-scope surfaces mapped before fixing.",
			"The interface checked where it runs: states, keyboard, narrow to wide layouts and target browsers or terminals checked on the real output; a project without an interface waives this.",
		],
		media: {
			standard: "Nobug on the output: check the encoded file, not the timeline. Picture and sound in sync at every cut, no dropped or duplicated frames, nothing clipped, consistent loudness, correct aspect and colour, and it plays in standard players. In 3D: no z-fighting, flipped normals, missing textures or popping.",
			front: "the delivered file was checked from its own frames and audio measurements: in sync, no dropped frames, clipping, wrong aspect or 3D artefacts.",
		},
	},
	"3d": {
		standard: `3D: build the picture from real geometry, materials and motivated light. Pick the route and read its guide first: Blender (the blender tool and the 3d-cad skill) to model assets, three.js for browser and real-time scenes, the anatomy skills for a figure made of real parts. Ground proportions and materials in real references. Render stills from several angles, look at them, fix what is weak and look again. ${NO_IMAGE_STANDIN} Placeholder primitives are scaffolding, not the delivery. It runs from a clean start with every asset resolving.`,
		kind: "3D (Blender scenes, three.js or WebGL code, models, shaders)",
		fronts: [
			"Purpose-built geometry, materials and light grounded in references; no placeholder primitives and no generated or stock image standing in for the 3D.",
			"Rendered stills from several angles were looked at and the weak ones fixed.",
			"Runs end to end from a clean start with every asset resolving, at a steady frame rate where interactive.",
		],
	},
	video: {
		standard: `Video: a finished film on every track. Write PRODUCTION.md first: script lines with target times, a shot list saying what each shot shows and why, the look, and the audio plan; facts the film states come from real sources. Build on one pipeline and read its guide first: cinetic (${skill("cinetic")}) for motion design, ads and launch films; video-editing for cutting existing footage. Look at a hero still before any long render, a contact sheet of every shot, and frames from the final MP4 (read returns images; on a text-only model use image_understand); fix what a director would reject. Sound: narration timed to the picture it describes, music ducked under speech, effects only on visible motion; measure the master with video_qa listen and analyze (about -16 LUFS, true peak under -1 dBTP). Render previews small and the final once; deliver one file at the asked length, size and frame rate.`,
		kind: "video (timelines, render scripts, narration and music, exports)",
		fronts: [
			"Every shot is purposeful in stills you looked at, transitions follow motion, and no placeholder or mistimed frames survive.",
			"Narration intelligible and in sync, music under speech, nothing clipped; video_qa listen and analyze pass on the delivered file.",
			"PRODUCTION.md holds the script with timings, the shot list and the audio plan before the render.",
		],
	},
	anatomy: {
		standard: `Anatomy: show the subject as a real object made of real parts, with motion and numbers from one model. Choose and read the guide first: anatomy (${skill("anatomy")}) to explain how something works; anatomy-reveal (${skill("anatomy-reveal")}) to show one object taken apart, as a page or a reveal film. Start from the closest example, copy the kit into the project and never write into the skill folder. Write a short spec from real references first: dimensions, parts by assembly, the feature that moves. No traced or embedded images. Run the skill's checks (kit audit, scan-apart, motion scan), look at every image they make, and drive pages in a real browser.`,
		kind: "anatomy (figures built with the anatomy kit, anatomy-reveal projects, exploded views)",
		fronts: [
			"Built with the chosen anatomy skill's kit at real dimensions from a written spec; its checks report clean.",
			"Stills, frames and the page in a real browser were looked at.",
			"Anatomy for how it works, anatomy-reveal for one object taken apart; the choice and its reason are stated.",
		],
	},
};

const isMedia = (ids: readonly PresetId[]) => ids.length > 1 && ids.includes("video");
const isFilm = (ids: readonly PresetId[]) => ids.includes("video") && (ids.includes("3d") || ids.includes("anatomy"));

/** The standard a boost contributes in this chain. */
function standardOf(id: PresetId, ids: readonly PresetId[]): string {
	const boost = BOOSTS[id];
	return isMedia(ids) && boost.media ? boost.media.standard : boost.standard;
}

/** A boost's first `count` fronts for this chain, labelled. */
function labelledFronts(id: PresetId, count: number, ids: readonly PresetId[]): string[] {
	const boost = BOOSTS[id];
	const fronts = isMedia(ids) && boost.media ? [boost.media.front] : boost.fronts;
	return fronts.slice(0, count).map((text) => `${PRESET_LABELS[id]}: ${text}`);
}

const FILM_LEADS: readonly [RegExp, string][] = [
	[/\bexploded\b|\bteardown\b|\btake[- ]apart\b|\bdissect\w*\b|\breveal\w*\b|\bunbox\w*\b|\bparts of\b/i, "anatomy-reveal"],
	[/\bhow\b[^.\n]{0,60}\bworks?\b|\bmechanisms?\b|\binternals?\b|\bcutaways?\b|\bexplain\w*\b|\bgears?\b|\bengines?\b/i, "anatomy"],
];

/** Video with 3D or Anatomy: one film, one lead skill, one clock. */
export function filmDirective(task: string): string {
	const lead = FILM_LEADS.find(([pattern]) => pattern.test(task))?.[1] ?? "cinetic";
	return `Film: one film whose hero in every shot is the real 3D subject. Lead skill: ${lead} (${skill(lead)}); other guides only where it lacks something. Drive the 3D scene from the film's one timeline (the three.js or anatomy scene mounted in the composition as a function of the frame) so picture, cues and sound share a clock; Blender only builds GLB assets for it. Transitions follow motion: match cuts, whips, a part becoming the next shot, never default crossfades.`;
}

function chainText(task: string, ids: readonly PresetId[]): string {
	const labels = ids.map((id) => PRESET_LABELS[id]).join(" + ");
	const scope = task
		? `Boosts in force — ${labels}. Where they pull against each other or against the user's words and brand, the user's words win.`
		: `Boosts in force — ${labels} — with no assignment: survey this project for work of each kind and improve it; a boost whose kind of work is absent is waived with that reason through the goal tool.`;
	return [scope, ...(isFilm(ids) ? [filmDirective(task)] : []), ...ids.map((id) => `[${PRESET_LABELS[id]}]\n${standardOf(id, ids)}`)].join("\n\n");
}

function soloText(id: PresetId, task: string): string {
	const boost = BOOSTS[id];
	const scope = task
		? `Assignment: ${task}`
		: boost.kind
			? `No assignment was given: survey this project for existing ${boost.kind} work and improve it. If there is none, say so in one line, waive the fronts with that reason through the goal tool, and stop.`
			: "Scope: the whole project, starting from what its users run and see.";
	return `${boost.standard}\n\n${scope}`;
}

/** The /noslop goal text; a focus narrows it and the fronts it does not touch are waived. */
export function noslopGoalText(focus: string): string {
	return focus ? `${NOSLOP_STANDARD}\n\nFocus: ${focus}. Fronts outside it are waived with that reason through the goal tool.` : soloText("noslop", "");
}

const MAX_FOCUS = 500;
export function noslopFocus(args: string): string {
	const flat = String(args ?? "").replace(/\s+/g, " ").trim();
	return flat.length > MAX_FOCUS ? `${flat.slice(0, MAX_FOCUS - 1)}…` : flat;
}

/** Fronts per boost: three alone, two in a pair, one in a longer chain. */
const perBoost = (count: number) => (count === 1 ? 3 : count === 2 ? 2 : 1);

function chainCriteria(task: string, ids: readonly PresetId[], now: number): string[] {
	const fronts = ids.flatMap((id) => labelledFronts(id, perBoost(ids.length), ids));
	const own = task ? createGoal(task, now).criteria.filter((criterion) => criterion.id !== VERIFY_ID).map((criterion) => criterion.text) : [];
	return [...own.slice(0, Math.max(3, MAX_CRITERIA - 1 - fronts.length)), ...fronts];
}

/**
 * Build the goal for a parsed chain: a solo preset tracks its own fronts; a
 * chain tracks the user's requirements first, then each boost's fronts.
 */
export function createPresetChainGoal(chain: PresetChain, now = Date.now()): GoalState {
	const { presets, task } = chain;
	if (presets.length === 1) {
		const only = presets[0];
		const text = only === "noslop" ? noslopGoalText(noslopFocus(task)) : soloText(only, task);
		return { ...createPresetGoal(text, BOOSTS[only].fronts, now), boosts: [only] };
	}
	const text = task ? `Assignment: ${task}\n\n${chainText(task, presets)}` : chainText(task, presets);
	return { ...createPresetGoal(text, chainCriteria(task, presets, now), now), boosts: [...presets] };
}

/** /goal with boosts: the user's words open the text, the boosts' standards follow. */
export function createBoostedGoal(task: string, presets: readonly PresetId[], now = Date.now()): GoalState {
	const ids = [...new Set(presets)];
	return { ...createPresetGoal(`${task}\n\n${chainText(task, ids)}`, chainCriteria(task, ids, now), now), boosts: ids };
}

/** A criterion as createPresetGoal stores it (flattened, clipped), so fronts can be matched against a goal. */
const fit = (text: string) => {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
};

/** The user's own words in a goal, without the boost text that follows them. */
function goalAssignment(text: string): string {
	const assignment = /(?:^|\n\n)Assignment: ([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1];
	if (assignment !== undefined) return assignment.replace(/\s+/g, " ").trim();
	const cut = text.search(/\n\n(?:Boosts in force|Boosts added to this goal)/);
	const base = (cut >= 0 ? text.slice(0, cut) : text).replace(/\s+/g, " ").trim();
	return /^(?:Boosts in force|Desloppify:|Debug:|3D:|Video:|Anatomy:)/.test(base) ? "" : base;
}

/**
 * Bare boosts added to a live goal: each new standard joins the goal text and
 * its fronts take the free criteria slots ahead of V. A boost already in force
 * is skipped; when nothing is new the goal comes back unchanged with `fresh`
 * empty. The continuation budget is re-armed because the goal has new work.
 */
export function addBoosts(goal: GoalState, presets: readonly PresetId[], now = Date.now()): { goal: GoalState; fresh: PresetId[]; fronts: number; clipped: boolean } {
	const recorded = goal.boosts ?? [];
	const requested = [...new Set(presets)];
	const all = [...new Set([...recorded, ...requested])];
	const tracked = (text: string) => goal.criteria.some((criterion) => criterion.text === fit(text));
	const carried = (id: PresetId) => labelledFronts(id, 3, all).every((text) => tracked(text) || tracked(text.slice(PRESET_LABELS[id].length + 2)));
	const fresh = requested.filter((id) => !recorded.includes(id) && !carried(id));
	if (!fresh.length) return { goal, fresh, fronts: 0, clipped: false };
	const queued = fresh.flatMap((id) => labelledFronts(id, perBoost(all.length), all)).filter((text) => !tracked(text));
	const body = goal.criteria.filter((criterion) => criterion.id !== VERIFY_ID);
	const tail = goal.criteria.filter((criterion) => criterion.id === VERIFY_ID);
	const room = Math.max(0, MAX_CRITERIA - goal.criteria.length);
	let counter = body.reduce((max, criterion) => Math.max(max, Number(/^C(\d+)$/.exec(criterion.id)?.[1] ?? 0)), 0);
	const added = queued.slice(0, room).map((text): GoalCriterion => ({ id: `C${++counter}`, text: fit(text), status: "open" }));
	const film = isFilm(all) && !isFilm(recorded) ? [filmDirective(goalAssignment(goal.text))] : [];
	const appended = [
		`Boosts added to this goal — ${fresh.map((id) => PRESET_LABELS[id]).join(" + ")} — in force from here on, alongside everything above.`,
		...film,
		...fresh.map((id) => `[${PRESET_LABELS[id]}]\n${standardOf(id, all)}`),
	].join("\n\n");
	const full = `${goal.text}\n\n${appended}`;
	const next: GoalState = {
		...goal,
		text: full.length > MAX_GOAL_TEXT ? `${full.slice(0, MAX_GOAL_TEXT - 1)}…` : full,
		criteria: [...body, ...added, ...tail],
		boosts: all,
		status: "active", nudges: 0, progressMark: "", stalls: 0, note: undefined, updatedAt: now,
	};
	return { goal: next, fresh, fronts: added.length, clipped: full.length > MAX_GOAL_TEXT };
}

/** One-line notice when a /goal starts with preset boosts. */
export function boostedGoalNotice(presets: readonly PresetId[], goal: GoalState): string {
	const labels = presets.map((id) => PRESET_LABELS[id]).join(" + ");
	return `Goal ${goal.id} with ${labels} boosts — ${goal.criteria.length} criteria to settle with evidence. /goal shows progress, /goal pause stops it.`;
}

/** One-line user notice when a preset goal starts. */
export function presetNotice(chain: PresetChain, goal: GoalState): string {
	const { presets, task } = chain;
	const labels = presets.map((id) => PRESET_LABELS[id]).join(" + ");
	return `${labels} boost on${task ? ` — ${task}` : " — surveying this project"} · goal ${goal.id}, ${goal.criteria.length} fronts to settle with evidence. /goal shows progress, /goal pause stops it.`;
}
