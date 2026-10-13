/**
 * Preset goals — /noslop, /3d and /video, alone or chained.
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
 * core subset so a three-way chain still fits the goal system's criteria
 * budget. Bare invocations survey the current project for work of their
 * kind, improve what exists, and say so plainly when there is none.
 */
import { createPresetGoal, type GoalState } from "./goal-state.ts";
import { createNoslopGoal, noslopFocus, noslopGoalText, NOSLOP_CRITERIA } from "./noslop.ts";

export type PresetId = "noslop" | "3d" | "video";
export const PRESET_IDS: readonly PresetId[] = ["noslop", "3d", "video"];
export const PRESET_LABELS: Record<PresetId, string> = { noslop: "Noslop", "3d": "3D", video: "Video" };

const MAX_TASK = 4000;
const CHAIN_TOKEN = /^\/(noslop|3d|video)(?=\s|$)/i;

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

/** Fronts that stay tracked when presets chain; the briefs themselves never compress. */
const CORE_INDEXES: Record<PresetId, readonly number[]> = {
	noslop: [1, 4, 5],
	"3d": [1, 2, 4],
	video: [1, 2, 4],
};
const CRITERIA: Record<PresetId, readonly string[]> = { noslop: NOSLOP_CRITERIA, "3d": THREE_D_CRITERIA, video: VIDEO_CRITERIA };

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
	const criteria = presets.flatMap((id) => CORE_INDEXES[id].map((index) => `${PRESET_LABELS[id]}: ${CRITERIA[id][index]}`));
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
