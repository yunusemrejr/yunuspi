/**
 * Goal standards — what a kind of work is held to, and the few fronts it is judged on.
 *
 * `/goal <task>` is the only command a user needs: the kickoff offers the
 * standards in one line each and the model adopts the ones its work calls for
 * through the goal tool, which returns the standard in full, tracks its fronts
 * as criteria and stages its tools. Five of them can also be named in the text
 * (`/goal /3d /video <task>`, or the older `/3d <task>` shortcuts). Standards
 * in force together share one assignment: with video, noslop, nobug and anatomy
 * judge the picture and the file instead of a codebase or a kit, and video with
 * 3d or anatomy adds one film paragraph naming the lead guide. Pure, so the
 * wording and the grammar are testable.
 */
import path from "node:path";
import { createGoal, createPresetGoal, MAX_CRITERIA, MAX_GOAL_TEXT, type GoalCriterion, type GoalState } from "./goal-state.ts";

/** Standards a user can also name in the text as a `/token`. */
export type PresetId = "noslop" | "nobug" | "3d" | "video" | "anatomy";
export const PRESET_IDS: readonly PresetId[] = ["noslop", "nobug", "3d", "video", "anatomy"];
/** Every standard a goal can adopt, in the order the kickoff offers them. */
export type StandardId = PresetId | "design" | "research" | "browser";
export const STANDARD_IDS: readonly StandardId[] = ["design", "noslop", "nobug", "3d", "video", "anatomy", "research", "browser"];
export const PRESET_LABELS: Record<StandardId, string> = { design: "Design", noslop: "Noslop", nobug: "Nobug", "3d": "3D", video: "Video", anatomy: "Anatomy", research: "Research", browser: "Browser" };

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

/** Typed chains glue or garble tokens: "/anatom,y/noslop" is "/anatomy /noslop". A chunk is split only when
 * every piece, commas dropped, is a token name; a slash-only chunk such as "/video/3d" is split only in the
 * leading run of commands, so the same text later in a sentence stays a path. */
function unglue(text: string): string {
	const code = [...text.matchAll(CODE)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
	const lead = /^(?:\s*\/[A-Za-z0-9,/]+(?=\s|$))*/.exec(text)?.[0].length ?? 0;
	return text.replace(/(?<=^|\s)\/(?=[A-Za-z0-9,/]*[,/])[A-Za-z0-9,/]*(?=$|\s)/g, (chunk, offset: number) => {
		if (code.some(([start, end]) => offset >= start && offset < end)) return chunk;
		if (!chunk.includes(",") && offset >= lead) return chunk;
		const names = chunk.replace(/,/g, "").split("/").slice(1).map((name) => name.toLowerCase());
		return names.length && names.every((name) => name === "goal" || (PRESET_IDS as readonly string[]).includes(name)) ? names.map((name) => `/${name}`).join(" ") : chunk;
	});
}

/**
 * Every preset and /goal token in a text, wherever it stands. The task is the
 * text with the tokens removed: the spacing they leave closes up, and a
 * connector word is dropped only where a token stranded it at an edge (the
 * text on that side held nothing but connectors). Text without any token comes
 * back trimmed and otherwise untouched.
 */
export function extractPresetTokens(text: string): PresetTokens {
	const literal = String(text ?? "").replace(/\s+/g, " ").trim();
	const raw = unglue(String(text ?? ""));
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
const NO_IMAGE_STANDIN = "Images support the 3D at most (a texture, a backdrop, a reference); the subject is never a generated or stock photo with 3D decoration laid over it.";
/** Every making boost weighs its tools instead of following a fixed recipe; the user's explicit choices are not options. */
const CHOOSE = "a tool, engine or provider the user named is the one to use";

interface Boost {
	/** The standard this boost holds the work to. */
	standard: string;
	/** The work it is for, as the kickoff offers it. */
	when: string;
	/** What a bare shortcut surveys for; empty means the whole project. */
	kind: string;
	/** Fronts, most important first; a chain keeps fewer. */
	fronts: readonly string[];
	/** Tools this work needs on the wire; adoption stages them so no keyword has to guess. */
	tools?: readonly string[];
	/** In a chain that makes a video, noslop, nobug and anatomy judge the picture and the file instead of a codebase or a kit. */
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

const BOOSTS: Record<StandardId, Boost> = {
	design: {
		standard: `Design: an interface made for this subject and its users, not a template. Read the guide first (${skill("ui-design")}). Before any code, write who uses this and what they come for, then the palette, the type and the layout, each with a reason taken from the subject or the existing brand. Inside an existing product, extend its tokens, components and voice instead of restyling it. Real content only: no invented metrics, testimonials or placeholder copy. Design every state a user can reach (empty, loading, error, long text). Render it in a real browser at 360, 768 and 1440 px (render_see), look at the screenshots, and fix what a designer would reject before reporting.`,
		when: "building or redesigning an interface, page, deck or other visual surface",
		kind: "",
		fronts: [
			"Palette, type and layout each have a stated reason from the subject or the existing brand; no template look, invented content or decorative filler.",
			"Rendered in a real browser at phone, tablet and desktop width and the screenshots looked at; nothing overflows, overlaps or shifts on hover and focus.",
			"Empty, loading, error and long-content states work; keyboard focus is visible and text contrast is readable.",
		],
		tools: ["render_see"],
	},
	noslop: {
		standard: NOSLOP_STANDARD,
		when: "removing AI slop and clutter from an existing interface, copy or codebase",
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
		when: "hunting and fixing bugs in existing code",
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
		standard: `3D: build the picture from real geometry, materials and motivated light. Choose the route from the subject, the deliverable and this machine (Blender through the blender tool and the 3d-cad skill, three.js in code, the anatomy kit for an object made of real parts, or a mix such as a Blender-built GLB in three.js); ${CHOOSE}. Ground proportions and materials in references. Render stills from several angles, look at them, fix what is weak and look again. ${NO_IMAGE_STANDIN} Placeholder primitives are scaffolding, not the delivery. It runs from a clean start with every asset resolving.`,
		when: "real 3D assets or scenes",
		kind: "3D (Blender scenes, three.js or WebGL code, models, shaders)",
		tools: ["blender", "video_frames"],
		fronts: [
			"Purpose-built geometry, materials and light grounded in references; no placeholder primitives and no generated or stock image standing in for the 3D.",
			"Rendered stills from several angles were looked at and the weak ones fixed.",
			"Runs end to end from a clean start with every asset resolving, at a steady frame rate where interactive.",
		],
	},
	video: {
		standard: `Video: a finished film on every track, at a standard a viewer would rank. Plan it before building: the script with timings, what each shot shows and why, the look and the sound; facts the film states come from real sources. Choose the engine from the subject, this machine and the user's words: cinetic (${skill("cinetic")}, Remotion with three.js for 3D, through video_project) for designed films of any kind, Blender for photoreal scenes, the media guide (${skill("media")}) for editing supplied footage; ${CHOOSE}. Choose the voice the same way: the provider the user named, else the best one available here (ElevenLabs with a key, a /models speech route, local Piper). Look at a hero still before any long render, a contact sheet of every shot and frames from the final file (read returns images; a text-only model uses image_understand); fix what a director would reject. Sound: narration on the picture it describes, music ducked under speech, effects on visible motion, the master measured (video_qa listen; about -16 LUFS, true peak under -1 dBTP). Previews small, the final once; one file at the asked length, size and frame rate.`,
		when: "a finished video or film",
		kind: "video (timelines, render scripts, narration and music, exports)",
		tools: ["video_project", "video_render", "video_qa", "narration_tts", "video_frames", "media_info"],
		fronts: [
			"Every shot is purposeful in stills you looked at, transitions follow motion, and no placeholder or mistimed frames survive.",
			"Narration intelligible and in sync, music under speech, nothing clipped, measured on the delivered file.",
			"The script with timings, the shots and the sound were planned before the render, and the film delivers that plan.",
		],
	},
	anatomy: {
		standard: `Anatomy: show the subject as a real object made of real parts, with motion and numbers from one model. Choose and read the guide first: anatomy (${skill("anatomy")}) to explain how something works; anatomy-reveal (${skill("anatomy-reveal")}) to show one object taken apart, as a page or a reveal film. Start from the closest example, copy the kit into the project and never write into the skill folder. Write a short spec from real references first: dimensions, parts by assembly, the feature that moves. No traced or embedded images. Run the skill's checks (kit audit, scan-apart, motion scan), look at every image they make, and drive pages in a real browser.`,
		when: "a figure or film that shows a real object's parts or how a mechanism works",
		kind: "anatomy (figures built with the anatomy kit, anatomy-reveal projects, exploded views)",
		fronts: [
			"Built with the chosen anatomy skill's kit at real dimensions from a written spec; its checks report clean.",
			"Stills, frames and the page in a real browser were looked at.",
			"Anatomy for how it works, anatomy-reveal for one object taken apart; the choice and its reason are stated.",
		],
		media: {
			standard: `Anatomy in a film: the subject's real parts, proportions and motion, taken from references, and shots that show how it is built or how it works. The anatomy guides (${skill("anatomy")}, ${skill("anatomy-reveal")}) supply technique where they fit the film's engine; no traced or embedded images.`,
			front: "the subject's parts, proportions and motion match real references, and the shots show how it is built or works.",
		},
	},
	research: {
		standard: `Research: an answer a careful reader can check. Read the guide first (${skill("research")}). Search with web_search, then open the pages that matter (fetch_content) instead of trusting snippets, and prefer the primary source (the paper, the documentation, the filing, the dataset) to a write-up about it. Every claim the conclusion rests on gets a source you opened, with its date; one that carries real weight gets a second, independent source. Give a number with its unit, its date and what it is a share of. Say what the sources disagree on and what you could not find, and keep what a source states apart from what you infer. Lead with the answer, then the support.`,
		when: "an answer or report built from sources found on the web",
		kind: "",
		fronts: [
			"Every claim the conclusion rests on cites a source that was opened, with its date; the weightiest have a second independent source.",
			"What the sources disagree on and what could not be found is stated; inference is marked as inference.",
		],
		tools: ["web_search", "fetch_content"],
	},
	browser: {
		standard: `Browser: operate the site the way a careful person would. Read the guide first (${skill("browser")}). With browser_session, snapshot and read the page before each action, act on what is actually there, and confirm each step on the page (the new state, a confirmation, the changed value) before the next. A login, CAPTCHA or verification code goes to the user. Go up to but not through paying, sending, posting, deleting or submitting in the user's name unless they asked for exactly that; after an uncertain submit, check whether it went through before trying again. Type no secret the user did not give for this site. Report what was done, what was read off the page, and where it ended.`,
		when: "operating a live website",
		kind: "",
		fronts: [
			"The end state was confirmed on the page itself after the last step (snapshot or screenshot), not assumed from a click.",
			"Nothing was paid, sent, posted or deleted beyond what the user asked for; logins and verification prompts went to the user.",
		],
		tools: ["browser_session"],
	},
};

/**
 * Standard names as a model or user writes them (`video`, `/3D`, `Design`),
 * resolved to ids. Anything that is not a standard comes back in `unknown`.
 */
export function resolveStandards(items: readonly unknown[]): { ids: StandardId[]; unknown: string[] } {
	const ids: StandardId[] = [];
	const unknown: string[] = [];
	for (const item of items ?? []) {
		const name = String(item ?? "").trim().replace(/^\//, "").toLowerCase();
		const id = STANDARD_IDS.find((candidate) => candidate === name);
		if (!id) { if (name) unknown.push(name.slice(0, 40)); }
		else if (!ids.includes(id)) ids.push(id);
	}
	return { ids, unknown };
}

/** The goal's standards as recorded, ignoring anything another build wrote that this one does not know. */
export const standardsInForce = (goal: Pick<GoalState, "boosts">): StandardId[] => resolveStandards(goal.boosts ?? []).ids;

/** Standards already in force, in full, for a model that lost them to compaction. */
export function standardsBrief(ids: readonly StandardId[], inForce: readonly StandardId[]): string {
	return ids.map((id) => `[${PRESET_LABELS[id]}]\n${standardOf(id, inForce)}`).join("\n\n");
}

/** Tools the given standards need on the wire. */
export const standardTools = (ids: readonly StandardId[]): string[] => [...new Set(ids.flatMap((id) => BOOSTS[id].tools ?? []))];

/**
 * The offer that closes a goal kickoff: one line per standard not yet in
 * force, so the model picks what its work calls for instead of the user typing
 * a command per kind of work. Empty once every standard is in force.
 */
export function standardsOffer(goal: Pick<GoalState, "boosts">): string {
	const inForce = standardsInForce(goal);
	const open = STANDARD_IDS.filter((id) => !inForce.includes(id));
	if (!open.length) return "";
	return [
		`Standards${inForce.length ? ` (in force: ${inForce.map((id) => PRESET_LABELS[id]).join(", ")})` : ""}: before starting, adopt each one this goal's work calls for with goal({action:"adopt", items:[…]}). It returns the standard in full, tracks its checks and readies its tools. Adopt another when the work turns out to need it; make no call when none fits.`,
		...open.map((id) => `- ${id}: ${BOOSTS[id].when}`),
	].join("\n");
}

const isMedia = (ids: readonly StandardId[]) => ids.length > 1 && ids.includes("video");
const isFilm = (ids: readonly StandardId[]) => ids.includes("video") && (ids.includes("3d") || ids.includes("anatomy"));

/** The standard a boost contributes in this chain. */
function standardOf(id: StandardId, ids: readonly StandardId[]): string {
	const boost = BOOSTS[id];
	return isMedia(ids) && boost.media ? boost.media.standard : boost.standard;
}

/** A boost's first `count` fronts for this chain, labelled. */
function labelledFronts(id: StandardId, count: number, ids: readonly StandardId[]): string[] {
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
	return `Film: one film whose hero in every shot is the subject built in 3D. Lead guide: ${lead} (${skill(lead)}); read others only where it lacks something. Keep picture, cues and sound on one clock: a three.js or anatomy scene mounted in the composition as a function of the frame, or Blender renders cut to the timeline. Transitions follow motion (match cuts, whips, a part becoming the next shot) rather than default crossfades.`;
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
	const cut = text.search(/\n\n(?:Boosts in force|Boosts added to this goal|Standards added to this goal)/);
	const base = (cut >= 0 ? text.slice(0, cut) : text).replace(/\s+/g, " ").trim();
	return /^(?:Boosts in force|Desloppify:|Debug:|3D:|Video:|Anatomy:)/.test(base) ? "" : base;
}

/**
 * Standards added to a live goal: each new one joins the goal text and its
 * fronts take the free criteria slots ahead of V. One already in force is
 * skipped; when nothing is new the goal comes back unchanged with `fresh`
 * empty. The continuation budget is re-armed because the goal has new work.
 * `appended` is the text that joined the goal, for the caller to hand over.
 */
export function addBoosts(goal: GoalState, presets: readonly StandardId[], now = Date.now()): { goal: GoalState; fresh: StandardId[]; fronts: number; clipped: boolean; appended: string } {
	const recorded = standardsInForce(goal);
	const requested = [...new Set(presets)];
	const all = [...new Set([...recorded, ...requested])];
	const tracked = (text: string) => goal.criteria.some((criterion) => criterion.text === fit(text));
	const carried = (id: StandardId) => labelledFronts(id, 3, all).every((text) => tracked(text) || tracked(text.slice(PRESET_LABELS[id].length + 2)));
	const fresh = requested.filter((id) => !recorded.includes(id) && !carried(id));
	if (!fresh.length) return { goal, fresh, fronts: 0, clipped: false, appended: "" };
	const queued = fresh.flatMap((id) => labelledFronts(id, perBoost(all.length), all)).filter((text) => !tracked(text));
	const body = goal.criteria.filter((criterion) => criterion.id !== VERIFY_ID);
	const tail = goal.criteria.filter((criterion) => criterion.id === VERIFY_ID);
	const room = Math.max(0, MAX_CRITERIA - goal.criteria.length);
	let counter = body.reduce((max, criterion) => Math.max(max, Number(/^C(\d+)$/.exec(criterion.id)?.[1] ?? 0)), 0);
	const added = queued.slice(0, room).map((text): GoalCriterion => ({ id: `C${++counter}`, text: fit(text), status: "open" }));
	const film = isFilm(all) && !isFilm(recorded) ? [filmDirective(goalAssignment(goal.text))] : [];
	const appended = [
		`Standards added to this goal — ${fresh.map((id) => PRESET_LABELS[id]).join(" + ")} — in force from here on, alongside everything above.`,
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
	return { goal: next, fresh, fronts: added.length, clipped: full.length > MAX_GOAL_TEXT, appended };
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
