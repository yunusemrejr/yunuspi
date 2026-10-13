/**
 * Preset goals — /noslop, /nobug, /3d and /video, alone or chained.
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
import { createPresetGoal, MAX_CRITERIA, type GoalState } from "./goal-state.ts";
import { createNoslopGoal, noslopFocus, noslopGoalText, NOSLOP_CRITERIA } from "./noslop.ts";

export type PresetId = "noslop" | "nobug" | "3d" | "video";
export const PRESET_IDS: readonly PresetId[] = ["noslop", "nobug", "3d", "video"];
export const PRESET_LABELS: Record<PresetId, string> = { noslop: "Noslop", nobug: "Nobug", "3d": "3D", video: "Video" };

const MAX_TASK = 4000;
const CHAIN_TOKEN = /^\/(noslop|nobug|3d|video)(?=\s|$)/i;

export interface PresetChain {
	/** Invoked preset first, then peeled chain tokens in written order, deduped. */
	presets: PresetId[];
	/** Remaining assignment text (may be empty: bare survey-and-fix). */
	task: string;
}

/**
 * `/3d /video /noslop make X` grammar: the core dispatches only the first
 * token as a command, so chained presets arrive as leading `/name` tokens in
 * the args. Peel them (any order, repeats ignored); an unknown `/word` is
 * not a preset and stays part of the assignment, typo and all.
 */
export function parsePresetChain(invoked: PresetId, args: string): PresetChain {
	const presets: PresetId[] = [invoked];
	let rest = String(args ?? "").trim();
	for (;;) {
		const match = CHAIN_TOKEN.exec(rest);
		if (!match) break;
		const id = match[1].toLowerCase() as PresetId;
		if (!presets.includes(id)) presets.push(id);
		rest = rest.slice(match[0].length).trim();
	}
	const task = rest.length > MAX_TASK ? `${rest.slice(0, MAX_TASK - 1)}…` : rest;
	return { presets, task };
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

/**
 * Fronts that stay tracked when presets chain, most important first; a long
 * chain keeps fewer per preset. The briefs themselves never compress.
 */
const CORE_INDEXES: Record<PresetId, readonly number[]> = {
	noslop: [1, 2, 6],
	nobug: [1, 4, 2],
	"3d": [1, 2, 4],
	video: [1, 2, 4],
};
const CRITERIA: Record<PresetId, readonly string[]> = { noslop: NOSLOP_CRITERIA, nobug: NOBUG_CRITERIA, "3d": THREE_D_CRITERIA, video: VIDEO_CRITERIA };

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
		"Choose the route deliberately and use the installed skills and tools for it: Blender (the blender tools, the 3d-cad and anatomy skills) for real geometry, scenes and offline realism; three.js/WebGL for browser and interactive work; a hybrid — assets modeled in Blender, presented in three.js — when the subject wants both. Read the relevant skill before building; it carries the workflow, this brief carries the standard.",
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
		"Plan before rendering: settle the script or shot list and the audio plan first (what is shown, said and heard, in what order), then build with the installed video skills and tools for the route (code-first-video, remotion-video, video-editing, audio; Blender or three.js scenes rendered to frames when the picture needs real 3D). Read the relevant skill before building; it carries the workflow, this brief carries the standard.",
		"Sound is a track, not an afterthought. Narration (TTS where no voice exists) must be intelligible, naturally paced and timed to the picture it describes — listen to it, do not trust the transcript. Music and sound effects are mixed under speech, levels stay consistent across cuts, nothing clips and no stretch is accidentally silent. Effects and transitions exist to serve the cut — orientation, emphasis, continuity — never as decoration; captions or on-screen text appear where speech carries information, legible and in sync.",
		"Verify the master, not the timeline: watch the final export end to end with audio (video_qa where available), checking sync at the joins, loudness against speech, and that the runtime earns its length. Deliver at the intended resolution, frame rate and format, as a file that plays outside the build setup.",
	].join("\n\n");
}

const BRIEFS: Record<PresetId, (task: string) => string> = {
	noslop: (task) => noslopGoalText(noslopFocus(task)),
	nobug: nobugGoalText,
	"3d": threeDGoalText,
	video: videoGoalText,
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
		return createPresetGoal(BRIEFS[only](task), CRITERIA[only], now);
	}
	const header = task
		? `Assignment: ${task}\n\nBoosts in force — ${presets.map((id) => PRESET_LABELS[id]).join(" + ")} — all applied to this same work together. Every directive set below is binding on the result; where they pull against each other, the assignment's purpose wins and the conflict is named in the open, never silently dropped.`
		: `Boosts in force — ${presets.map((id) => PRESET_LABELS[id]).join(" + ")} — with no assignment: survey the current project and apply every directive set below to the work of its kind that exists. A boost whose kind of work does not exist here is waived with that reason, exactly as its own brief says.`;
	const text = [header, ...presets.map((id) => `[${PRESET_LABELS[id]}]\n${BRIEFS[id](task)}`)].join("\n\n");
	const perPreset = Math.min(3, Math.floor((MAX_CRITERIA - 1) / presets.length));
	const criteria = presets.flatMap((id) => CORE_INDEXES[id].slice(0, perPreset).sort((a, b) => a - b).map((index) => `${PRESET_LABELS[id]}: ${CRITERIA[id][index]}`));
	return createPresetGoal(text, criteria, now);
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
