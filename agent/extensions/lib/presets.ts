/**
 * Preset goals — /noslop, /nobug, /3d, /video and /anatomy, alone or chained.
 *
 * Each preset is a /goal with its aim already written: a working brief plus
 * the fronts it is judged on. The commands live in goal.ts on the shared
 * goal machinery; this module is the pure part (parsing, briefs, criteria
 * assembly) so the wording and the chaining grammar can be tested without
 * loading an extension.
 *
 * Chaining: `/3d /video /noslop make a film about X` starts ONE goal whose
 * brief stacks every named directive set onto the same assignment. The
 * briefs always run in full; the tracked fronts compress to each preset's
 * core subset (fewer per preset as the chain grows) so even a four-way chain
 * fits the goal system's criteria budget. Bare invocations survey the current project for work of their
 * kind, improve what exists, and say so plainly when there is none.
 */
import { createGoal, createPresetGoal, MAX_CRITERIA, MAX_GOAL_TEXT, type GoalCriterion, type GoalState } from "./goal-state.ts";
import { createNoslopGoal, noslopFocus, noslopGoalText, NOSLOP_CRITERIA } from "./noslop.ts";

export type PresetId = "noslop" | "nobug" | "3d" | "video" | "anatomy";
export const PRESET_IDS: readonly PresetId[] = ["noslop", "nobug", "3d", "video", "anatomy"];
export const PRESET_LABELS: Record<PresetId, string> = { noslop: "Noslop", nobug: "Nobug", "3d": "3D", video: "Video", anatomy: "Anatomy" };

const MAX_TASK = 4000;
const VERIFY_ID = "V";
/** A preset or /goal token: opened by start, whitespace or ( " ', closed by end, whitespace, or punctuation that itself ends the word
 * (`/3d.` at a sentence end) — so paths, URLs and file names (`src/3d`, `/video.mp4`, `/3d/models`) never match. */
const TOKEN = /(?<=^|[\s("'])\/(noslop|nobug|3d|video|anatomy|goal)(?=$|\s|[,.;:!?)"'](?=$|[\s,.;:!?)"']))/gi;
/** Fenced blocks and inline code spans: tokens inside them are text. */
const CODE = /```[\s\S]*?(?:```|$)|(`+)[\s\S]*?(?<!`)\1(?!`)/g;
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

/** The user's literal invocation, for authored-input analysis: `/3d /video make X`. */
export function presetUserText(presets: readonly PresetId[], task: string): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return `${presets.map((id) => `/${id}`).join(" ")}${flat ? ` ${flat}` : ""}`;
}

export const NOBUG_CRITERIA: readonly string[] = [
	"Baseline first: the project's existing checks (build, types, lint, tests) were run and recorded, and the in-scope surfaces (code paths, screens, outputs, pipelines) mapped before hunting.",
	"Logic and edge cases: every bug fixed was reproduced first (failing test, command or capture) and fixed at its root; empty, huge, malformed, concurrent and failure inputs were exercised.",
	"Broken code and dependencies: no syntax, type, import or build errors; dependencies declared, used, locked and version-consistent, with no missing, unused, deprecated or conflicting package on the main path.",
	"Drifting duplicates resolved: copies of one rule that disagree or will drift are unified behind the surviving implementation, callers moved; harmless repetition left alone.",
	"The interface works wherever it runs: states, keyboard and focus, narrow to wide layouts, and target browsers or terminals checked on the real rendered output; a project without an interface waives this.",
	"Fixes are honest: nothing masked (swallowed errors, skipped tests, disabled lints, loosened types), no unrelated rewrites; unproven suspicions reported as such and unchecked environments named.",
];

export const THREE_D_CRITERIA: readonly string[] = [
	"Grounding first: the subject is researched with real references (proportions, materials, motion) and the harness's 3D skills/tooling for the chosen route (Blender, three.js/WebGL) are actually loaded and used.",
	"Real assets and geometry: models, materials/textures and lighting are purpose-built or properly sourced for the subject — no placeholder boxes, primitive-only scenes or flat unlit output passed off as finished.",
	"Craft at inspection distance: silhouette, proportions, materials and light hold up in rendered stills from multiple angles and distances, not only in code or one screenshot.",
	"Motion and interaction behave: animation and interaction hold a stable frame rate within sane budgets (geometry, draw calls, texture memory) and degrade honestly instead of stalling.",
	"Deliverable is real: the scene or app runs end to end from a clean start, with every asset resolving and no errors on the main path.",
];

export const VIDEO_CRITERIA: readonly string[] = [
	"Plan before render: script or shot list and audio plan are settled first (what is shown, said and heard, in what order), with the harness's video skills/tooling for the chosen route actually used.",
	"Picture quality: every shot is purposeful (composition, light, legible text), effects and transitions serve the cut instead of decorating it, and no placeholder or mistimed frames survive.",
	"Sound is finished, not attached: narration/TTS is intelligible and timed to the picture, music and effects sit under speech, levels stay consistent with no clipping or dead air.",
	"Pacing and sync: cuts, captions and on-screen text line up with what they describe, and the runtime earns its length with no filler stretches.",
	"Verified master: the final export is watched end to end with audio (video_qa or equivalent) at the intended resolution, frame rate and format, and plays outside the build setup.",
];

export const ANATOMY_CRITERIA: readonly string[] = [
	"Right skill, real spec: anatomy (how a system or mechanism works) or anatomy-reveal (one object's dissection page or reveal film) read first; dimensions, features, parts by assembly and moving features written down, guesses named.",
	"Built from real parts: convex solids at real dimensions and counts, made with the skill's kit from its closest example or template; no traced or embedded images, no placeholder blocks, generic markings unless a replica was asked.",
	"One truthful model: motion, explode, poses, readouts and captions come from one model, and the skill's checks (kit audit, scan-apart from five views, motion scan) report no parts passing through each other and no forced picks.",
	"Seen, not assumed: stills and frames from several angles and states were looked at, and the interactive page was driven in a real browser (drag, keys, take-apart, light and dark, reduced motion).",
	"Deliverable is real: figure pages build and open from a clean start; a film, when asked, is encoded at the asked length and ratio and checked from frames of the MP4 itself; anything unverified is named.",
];

/**
 * Fronts that stay tracked when presets chain, most important first; a long
 * chain keeps fewer per preset. The briefs themselves never compress.
 */
const CORE_INDEXES: Record<PresetId, readonly number[]> = {
	noslop: [1, 2, 6],
	nobug: [1, 4, 2],
	"3d": [1, 2, 4],
	video: [1, 2, 4],
	anatomy: [2, 1, 3],
};
const CRITERIA: Record<PresetId, readonly string[]> = { noslop: NOSLOP_CRITERIA, nobug: NOBUG_CRITERIA, "3d": THREE_D_CRITERIA, video: VIDEO_CRITERIA, anatomy: ANATOMY_CRITERIA };

/** A criterion as createPresetGoal stores it (flattened, clipped), so fronts can be matched against a goal. */
const fit = (text: string) => {
	const flat = String(text).replace(/\s+/g, " ").trim();
	return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
};

/** A preset's first `count` core fronts, labelled and in the brief's order. */
function labelledFronts(id: PresetId, count: number): string[] {
	return CORE_INDEXES[id].slice(0, count).sort((a, b) => a - b).map((index) => `${PRESET_LABELS[id]}: ${CRITERIA[id][index]}`);
}

function nobugGoalText(task: string): string {
	const scope = task
		? `Assignment: ${task}\nHunt bugs in that work and everything it touches, deeply. Fronts it does not touch get waived with that reason through the goal tool — not silently skipped.`
		: "Scope: the whole codebase of the current project. Start from what its users run and see, then work inward to the code paths behind it.";
	return [
		"Debug this work: find the real bugs, prove each one, fix it at its root, and leave proof that it stays fixed.",
		scope,
		"Baseline before hunting: learn what the project is and how it runs, run its existing checks (build, type check, lint, tests) and record what already fails, and map the in-scope surfaces — entry points, code paths, screens, outputs, pipelines. A check that is already red is a finding, not background noise.",
		"Hunt across every front. Logic: wrong conditions and off-by-one, inverted or missing branches, null and undefined paths, unit, time-zone and rounding mistakes, stale or shared state, async races and unawaited promises, errors swallowed or reported wrong. Edge cases: empty, single, huge and malformed input, unicode and whitespace, boundaries, concurrency and retries, slow or failed network, missing files and permissions, first run versus upgrade. Broken code: syntax and type errors, broken imports and references, dead config, scripts that no longer run. Dependencies: missing, unused, duplicated or conflicting packages, lockfile drift, versions that disagree across workspaces, deprecated or vulnerable packages on the main path, code that only works on the author's machine. Duplication that matters: copies of one rule that already disagree or will drift — a DRY violation is a bug when the copies can diverge, and is left alone when it is harmless repetition.",
		"Where there is an interface, test the real rendered thing, not the code. GUI and web: broken, unreachable or misleading states (loading, empty, error, disabled), keyboard and focus order, forms and validation, layouts from a 360px phone to a wide desktop with no overflow, clipping or horizontal scroll, and the browsers the project targets (Chromium, Firefox and WebKit where available; name any you could not run). Terminal apps: narrow and resized terminals, piped and non-TTY output, NO_COLOR, Ctrl-C and cleanup, long lines and wide characters. Media and 3D, including work from chained boosts: watch and inspect the actual output — for video, audio/picture sync, dropped or duplicated frames, wrong aspect, color or levels, clipping, captions out of time, files that only play in one player; for 3D, z-fighting, inverted normals, missing textures, NaN or exploding transforms, device-pixel-ratio and resize bugs, context loss and frame-rate stalls — and treat weird or low-quality looks as bugs to explain and fix.",
		"Rules of engagement. Reproduce before fixing: each bug gets a repro first (a failing test where the project has tests, otherwise a recorded command, request or capture), then the smallest root-cause fix, then the repro passes and the surrounding checks still pass. Never mask a bug: no swallowed errors, skipped or deleted tests, disabled lints, loosened types or retry loops around a defect. Do not rewrite working code for taste or add features. A suspicion you could not prove is reported as suspected, with its reasoning, never as fixed; an environment you could not check is named, never implied.",
		"Order of work: baseline and map; list findings per front with severity and a repro; fix the highest-impact ones first in reviewable steps; rerun the baseline checks after each front and compare. Record each front's evidence through the goal tool as it settles, and finish with what was fixed, what was only suspected, and what could not be checked.",
	].join("\n\n");
}

function threeDGoalText(task: string): string {
	const scope = task
		? `Assignment: ${task}`
		: "No assignment was given. Survey the current project for existing 3D work — Blender scenes and scripts, three.js/WebGL code, models, textures, shaders — and improve and fix what is there: quality, correctness, performance. If the project contains no 3D work at all, say so plainly in one line, waive these fronts with that reason through the goal tool, and stop. Do not invent a 3D project nobody asked for.";
	return [
		"3D boost in force: do this 3D work at full craft, using the harness's real 3D capability instead of approximating it.",
		scope,
		"Choose the route deliberately and use the installed skills and tools for it: Blender (the blender tools and the 3d-cad skill) for real geometry, scenes and offline realism; the anatomy skill for an isometric figure or mechanism that turns in true 3D, and anatomy-reveal for one object built part by part to take apart and film; three.js/WebGL for browser and interactive work; a hybrid — assets modeled in Blender, presented in three.js — when the subject wants both. Read the relevant skill before building; it carries the workflow, this brief carries the standard.",
		"Ground the subject before modeling: research real references for proportions, materials and motion, and keep them beside the work. Sourced assets and images from the web are legitimate inputs when they fit the subject — prefer own or generated assets, check the license of anything fetched, and never pass a found asset off as modeled. Build real geometry with real materials and motivated lighting; placeholder boxes, primitive-only scenes and flat unlit renders are scaffolding, never the delivery.",
		"Iterate against renders, not intentions: render stills (render_see where available) from several angles and distances, compare with the references, fix what the comparison exposes. Keep performance honest — sane geometry, draw-call and texture budgets for the target, stable frame rate under interaction, honest degradation instead of stalls. Finish means the scene or app runs end to end from a clean start with every asset resolving.",
	].join("\n\n");
}

function videoGoalText(task: string): string {
	const scope = task
		? `Assignment: ${task}`
		: "No assignment was given. Survey the current project for existing video work — timelines and render scripts, narration and music assets, captions, exports — and improve and fix what is there: picture, sound, pacing, export quality. If the project contains no video work at all, say so plainly in one line, waive these fronts with that reason through the goal tool, and stop. Do not invent a video nobody asked for.";
	return [
		"Video boost in force: make this video finished on every track — picture, sound and timing — not a silent render with music attached.",
		scope,
		"Plan before rendering: settle the script or shot list and the audio plan first (what is shown, said and heard, in what order), then build with the installed video skills and tools for the route (code-first-video, remotion-video, video-editing, audio; Blender or three.js scenes rendered to frames when the picture needs real 3D; anatomy-reveal for a product reveal or exploded-view film of one object). Read the relevant skill before building; it carries the workflow, this brief carries the standard.",
		"Sound is a track, not an afterthought. Narration (TTS where no voice exists) must be intelligible, naturally paced and timed to the picture it describes — listen to it, do not trust the transcript. Music and sound effects are mixed under speech, levels stay consistent across cuts, nothing clips and no stretch is accidentally silent. Effects and transitions exist to serve the cut — orientation, emphasis, continuity — never as decoration; captions or on-screen text appear where speech carries information, legible and in sync.",
		"Verify the master, not the timeline: watch the final export end to end with audio (video_qa where available), checking sync at the joins, loudness against speech, and that the runtime earns its length. Deliver at the intended resolution, frame rate and format, as a file that plays outside the build setup.",
	].join("\n\n");
}

function anatomyGoalText(task: string): string {
	const scope = task
		? `Assignment: ${task}`
		: "No assignment was given. Survey the current project for existing anatomy work — figures built with the Anatomy kit (iso-kit, turn, lathe, tube), anatomy-reveal projects (object/geometry.mjs, object/film.mjs, motion/timeline.mjs), isometric or exploded-view figures and their films — and improve and fix what is there: geometry truth, depth order, motion, readouts, film framing. If the project contains no such work at all, say so plainly in one line, waive these fronts with that reason through the goal tool, and stop. Do not invent a figure nobody asked for.";
	return [
		"Anatomy boost in force: show this subject as a crafted anatomy figure, a real object of real parts whose motion and numbers come from one truthful model, using the two installed anatomy skills instead of approximating them.",
		scope,
		"Choose the skill by what the reader should understand, and read its SKILL.md before building. anatomy explains how a system, algorithm, machine or component works: an isometric SVG instrument with live readouts, cutaways, dials and gears, an interactive explainer, or parts turning in true 3D (its references/3d.md; references/webgl.md for fire, water or light) — open its closest example first and copy the kit and example into the project. anatomy-reveal shows off one physical object and its parts: scaffold with its scripts/new-project.mjs, then build an interactive dissection page to drag, turn and take apart, and, when asked, a product-reveal film (MP4, 3–60 s, 9:16, 4:5, 1:1 or 16:9) that tumbles in, whips to macro details, works one feature, explodes and snaps back. When the work wants both — an object that is also a working mechanism — say which skill leads and why. Resolve every kit, template and script path against the installed skill directory and never write output into it.",
		"Ground it before geometry. From a photo, read silhouette, proportions, materials, controls and moving parts; from a name, research the real product (dimensions in millimetres, materials, every control and port, how it opens and what is inside — teardowns are the best source), pick the common variant of an ambiguous name and say which. Write the short spec first: dimensions, features, parts grouped by assembly, the one or two features that move. The figure is geometry only: no user, web or generated image traced, embedded or mapped into it; real counts of screws and buttons; detail from real parts, never noise; neutral markings unless a faithful replica was asked for.",
		"Check what the reader sees, not what the code intends. Run the skill's own checks (the kit audit, scan-apart from front, back, top, below and side, the motion scan) until they report clean, and look at every image they make; drive the interactive page in a real browser; for a film, frame poses and timing with stills before the full render, render a short low-cost preview first (the full blur render costs about two minutes per second of film — run it in the background, one browser at a time), then extract frames from the encoded MP4 and look at a contact sheet. The reveal film is silent by design: when /video is also in force, its sound and master checks apply to this film; when /3d is in force, its rendered-proof standard covers these figures too. Deliver the pages, the film and the project folder, and name what was not verified.",
	].join("\n\n");
}

const BRIEFS: Record<PresetId, (task: string) => string> = {
	noslop: (task) => noslopGoalText(noslopFocus(task)),
	nobug: nobugGoalText,
	"3d": threeDGoalText,
	video: videoGoalText,
	anatomy: anatomyGoalText,
};

/**
 * Build the goal for a parsed chain. Solo /noslop keeps its shipped goal
 * byte for byte; chains stack full briefs under one header and track each
 * preset's core fronts under its label.
 */
export function createPresetChainGoal(chain: PresetChain, now = Date.now()): GoalState {
	const { presets, task } = chain;
	if (presets.length === 1) {
		const only = presets[0];
		if (only === "noslop") return createNoslopGoal(noslopFocus(task), now);
		return { ...createPresetGoal(BRIEFS[only](task), CRITERIA[only], now), boosts: [only] };
	}
	const header = task
		? `Assignment: ${task}\n\nBoosts in force — ${presets.map((id) => PRESET_LABELS[id]).join(" + ")} — all applied to this same work together. Every directive set below is binding on the result; where they pull against each other, the assignment's purpose wins and the conflict is named in the open, never silently dropped.`
		: `Boosts in force — ${presets.map((id) => PRESET_LABELS[id]).join(" + ")} — with no assignment: survey the current project and apply every directive set below to the work of its kind that exists. A boost whose kind of work does not exist here is waived with that reason, exactly as its own brief says.`;
	const text = [header, ...presets.map((id) => `[${PRESET_LABELS[id]}]\n${BRIEFS[id](task)}`)].join("\n\n");
	const perPreset = Math.min(3, Math.floor((MAX_CRITERIA - 1) / presets.length));
	const criteria = presets.flatMap((id) => labelledFronts(id, perPreset));
	return { ...createPresetGoal(text, criteria, now), boosts: [...presets] };
}

/** The text of a goal with boosts: the user's task first, then the order of the boosts, then each brief. */
function boostedText(task: string, ids: readonly PresetId[], literal: string): string {
	const order = ids.map((id) => PRESET_LABELS[id]).join(" → ");
	const header = `Boosts in force, in the order written — ${order} — all applied to this goal. Where a boost was written next to a particular part of the goal, it applies chiefly to that part; where boosts pull against each other the goal's purpose wins and the conflict is named. The user wrote: «${literal}»`;
	return [task, header, ...ids.map((id) => `[${PRESET_LABELS[id]}]\n${BRIEFS[id](task)}`)].join("\n\n");
}

/**
 * A real goal with boosts: the user's own requirements first (what createGoal
 * extracts from the task), then each boost's core fronts under its label, then
 * V. Every brief joins the text, so each boost applies in full even where only
 * its fronts are tracked. The budget gives the fronts k per boost (3, 2, or 1
 * from one to five boosts); the user's requirements take what is left, at least 3.
 */
export function createBoostedGoal(task: string, presets: readonly PresetId[], literal: string, now = Date.now()): GoalState {
	const ids = [...new Set(presets)];
	const perPreset = ids.length === 1 ? 3 : ids.length === 2 ? 2 : 1;
	const fronts = ids.flatMap((id) => labelledFronts(id, perPreset));
	const room = Math.max(3, MAX_CRITERIA - 1 - fronts.length);
	const own = createGoal(task, now).criteria.filter((criterion) => criterion.id !== VERIFY_ID).map((criterion) => criterion.text);
	return { ...createPresetGoal(boostedText(task, ids, literal), [...own.slice(0, room), ...fronts], now), boosts: ids };
}

/** Core fronts of a boost that the goal does not track yet (plain or labelled), most important first. */
function untrackedFronts(goal: GoalState, id: PresetId): string[] {
	return CORE_INDEXES[id]
		.map((index) => CRITERIA[id][index])
		.filter((text) => !goal.criteria.some((criterion) => criterion.text === fit(text) || criterion.text === fit(`${PRESET_LABELS[id]}: ${text}`)));
}

/**
 * Bare boosts added to a live goal: each new brief joins the goal text under
 * its label, and its core fronts take the free criteria slots ahead of V. A
 * boost already in force (recorded, or with every front tracked) is skipped;
 * when nothing is new the goal comes back unchanged with `fresh` empty. The
 * continuation budget is re-armed, as a resume does, because the goal has new work.
 */
export function addBoosts(goal: GoalState, presets: readonly PresetId[], now = Date.now()): { goal: GoalState; fresh: PresetId[]; fronts: number } {
	const recorded = goal.boosts ?? [];
	const requested = [...new Set(presets)];
	const fresh = requested.filter((id) => !recorded.includes(id) && untrackedFronts(goal, id).length > 0);
	if (!fresh.length) return { goal, fresh, fronts: 0 };
	const total = new Set([...recorded, ...requested]).size;
	const perPreset = total === 1 ? 3 : total === 2 ? 2 : 1;
	const queued: string[] = [];
	for (let round = 0; round < perPreset; round++) {
		for (const id of fresh) {
			const text = untrackedFronts(goal, id)[round];
			if (text) queued.push(`${PRESET_LABELS[id]}: ${text}`);
		}
	}
	const body = goal.criteria.filter((criterion) => criterion.id !== VERIFY_ID);
	const tail = goal.criteria.filter((criterion) => criterion.id === VERIFY_ID);
	const room = Math.max(0, MAX_CRITERIA - goal.criteria.length);
	let counter = body.reduce((max, criterion) => Math.max(max, Number(/^C(\d+)$/.exec(criterion.id)?.[1] ?? 0)), 0);
	const added = queued.slice(0, room).map((text): GoalCriterion => ({ id: `C${++counter}`, text: fit(text), status: "open" }));
	const flat = goal.text.replace(/\s+/g, " ").trim();
	const summary = flat.length > 600 ? `${flat.slice(0, 599)}…` : flat;
	const labels = fresh.map((id) => PRESET_LABELS[id]).join(" + ");
	const appended = [
		`Boosts added to this goal — ${labels} — in force from here on, alongside everything above. Where a boost pulls against the goal's purpose, the purpose wins and the conflict is named.`,
		...fresh.map((id) => `[${PRESET_LABELS[id]}]\n${BRIEFS[id](summary)}`),
	].join("\n\n");
	const full = `${goal.text}\n\n${appended}`;
	const next: GoalState = {
		...goal,
		text: full.length > MAX_GOAL_TEXT ? `${full.slice(0, MAX_GOAL_TEXT - 1)}…` : full,
		criteria: [...body, ...added, ...tail],
		boosts: [...new Set([...recorded, ...requested])],
		status: "active", nudges: 0, progressMark: "", stalls: 0, note: undefined, updatedAt: now,
	};
	return { goal: next, fresh, fronts: added.length };
}

/** One-line notice when a /goal starts with preset boosts. */
export function boostedGoalNotice(presets: readonly PresetId[], goal: GoalState): string {
	const labels = presets.map((id) => PRESET_LABELS[id]).join(" + ");
	return `Goal ${goal.id} with ${labels} boosts — ${goal.criteria.length} criteria to settle with evidence. /goal shows progress, /goal pause stops it.`;
}

/** One-line user notice when a preset goal starts; solo /noslop keeps its shipped wording. */
export function presetNotice(chain: PresetChain, goal: GoalState): string {
	const { presets, task } = chain;
	if (presets.length === 1 && presets[0] === "noslop") {
		const focus = noslopFocus(task);
		return `Desloppifying ${focus ? focus : "this codebase"} — goal ${goal.id}, ${goal.criteria.length} fronts to settle with evidence. /goal shows progress, /goal pause stops it.`;
	}
	const labels = presets.map((id) => PRESET_LABELS[id]).join(" + ");
	return `${labels} boost on${task ? ` — ${task}` : " — surveying this project"} · goal ${goal.id}, ${goal.criteria.length} fronts to settle with evidence. /goal shows progress, /goal pause stops it.`;
}
