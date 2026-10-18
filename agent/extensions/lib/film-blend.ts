/**
 * Film blend — how the motion skills combine when /3d (or /anatomy) and /video chain.
 *
 * Three installed skills each own part of a film: anatomy (a mechanism or system
 * explained as real parts in true 3D), anatomy-reveal (one object taken apart and
 * revealed) and cinetic (the film itself: one beat-locked timeline driving picture
 * and sound, transitions, a sound kit, finishing and a measured review loop).
 * Listing them as "skills" left the model to pick one and ignore the rest. This
 * module reads what the user asked for and writes a blend: which skill leads and
 * why, what each other skill contributes, which engine carries the film, and how
 * their defaults are reconciled where they disagree. It is pure, so the plan for
 * a given request is testable and stable.
 */
import path from "node:path";

export type FilmMode = "mechanism" | "reveal" | "brand" | "world";
export type FilmSkill = "anatomy" | "anatomy-reveal" | "cinetic" | "three-world";

export interface FilmBlend {
	mode: FilmMode;
	lead: FilmSkill;
	/** The words in the request that decided the mode; empty when the default applied. */
	signals: string[];
	pace: "calm" | "crisp";
	narration: "asked" | "explains" | "optional";
	text: string;
}

const SIGNALS: Record<FilmMode, RegExp> = {
	mechanism: /\bhow\b[^.\n]{0,60}\bworks?\b|\bmechanisms?\b|\bengines?\b|\binternals?\b|\binside\b|\bcross[- ]sections?\b|\bcutaways?\b|\bprocess(?:es)?\b|\balgorithms?\b|\bphysics\b|\bexplain\w*\b|\beducational\b|\bgears?\b|\bpumps?\b|\bvalves?\b|\bcircuits?\b|\bturbines?\b|\bpistons?\b|\breactors?\b|\bcells?\b|\borgans?\b/gi,
	reveal: /\bexploded\b|\bteardown\b|\btear[- ]down\b|\btake[- ]apart\b|\bdissect\w*\b|\breveal\w*\b|\bunbox\w*\b|\bparts of\b|\bcomponents of\b|\banatomy of\b|\bhero shots?\b|\bproduct shots?\b/gi,
	brand: /\blaunch\w*\b|\bteasers?\b|\bpromo\w*\b|\bads?\b|\badvert\w*\b|\bcommercials?\b|\btrailers?\b|\blogos?\b|\bstings?\b|\bintros?\b|\bbrand\w*\b|\bfeature (?:video|film|loop)s?\b|\bapps?\b|\bsaas\b|\bui\b|\bwalkthroughs?\b|\bdemos?\b|\bsocial\b|\bkinetic\b|\btitle sequences?\b|\bloops?\b/gi,
	world: /\bcit(?:y|ies)\b|\blandscapes?\b|\benvironments?\b|\bworlds?\b|\bflythrough\w*\b|\bfly[- ]through\w*\b|\bcharacters?\b|\bplanets?\b|\binteriors?\b|\barchitectur\w*\b|\bterrain\b/gi,
};
const CRISP = /\b(?:energetic|hype|punchy|fast|crisp|high[- ]energy|aggressive|drop)\b/i;
const NARRATION = /\b(?:narrat\w*|voice[- ]?over|voiceover|vo\b|spoken|tts|speech)\b/i;

const skillFile = (name: string) => path.resolve(import.meta.dirname, "../../skills", name, "SKILL.md");

const LEADS: Record<FilmMode, FilmSkill> = { mechanism: "anatomy", reveal: "anatomy-reveal", brand: "cinetic", world: "three-world" };

/**
 * Score the request against each mode. The highest score leads; a tie or no
 * signal falls back to the mechanism mode, because the user asked for animated
 * anatomy to lead 3D films unless the subject plainly calls for something else.
 */
export function planFilmBlend(task: string): FilmBlend {
	const text = String(task ?? "");
	let mode: FilmMode = "mechanism";
	let best = 0, signals: string[] = [];
	for (const candidate of ["mechanism", "reveal", "brand", "world"] as const) {
		const found = [...new Set([...text.matchAll(SIGNALS[candidate])].map((match) => match[0].toLowerCase()))];
		if (found.length > best) { best = found.length; mode = candidate; signals = found; }
	}
	const pace = CRISP.test(text) ? "crisp" : "calm";
	const narration = NARRATION.test(text) ? "asked" : mode === "mechanism" ? "explains" : "optional";
	const lead = LEADS[mode];
	const why = signals.length ? `the request says ${signals.slice(0, 4).map((word) => `"${word}"`).join(", ")}` : "nothing in the request points elsewhere, and animated anatomy leads 3D films by default";
	const leadLine: Record<FilmMode, string> = {
		mechanism: `Lead: anatomy (${skillFile("anatomy")}), because ${why}. The film explains how the subject works: its hero shots are an anatomy figure turning in true 3D (references/3d.md), assembling, cutting away and running, with readouts that come from the same model.`,
		reveal: `Lead: anatomy-reveal (${skillFile("anatomy-reveal")}), because ${why}. The film shows one object off and takes it apart: tumble in, macro details, one feature working, explode and snap back, built from the skill's convex parts.`,
		brand: `Lead: cinetic (${skillFile("cinetic")}), because ${why}. The film is a launch, product or brand piece: one idea the product owns, one story device, kinetic type in fragments, and the subject's 3D object as the device that travels through every shot.`,
		world: `Lead: a three.js world built from Blender assets, because ${why}. The film moves through a place: the camera path, light and scale carry it, with anatomy figures as inserts wherever a part of that world needs explaining.`,
	};
	const roles = [
		mode === "brand"
			? "cinetic directs the whole film: BRIEF.md, TREATMENT.md with the pick.py technique draw, brand tokens, the timeline, the act-by-act build, the sound and the review loop."
			: `cinetic (${skillFile("cinetic")}) is the film system around the lead: its BRIEF.md and treatment discipline, the technique draw (scripts/pick.py), one timeline.ts driving picture and sound, its transition catalogue (references/transitions.md), its sound kit and score, its finishing and its contact-sheet review loop. Read its SKILL.md alongside the lead's.`,
		mode === "mechanism"
			? `anatomy-reveal joins only if one physical product must be shown whole and taken apart; otherwise it stays out.`
			: mode === "reveal"
				? `anatomy (${skillFile("anatomy")}) supplies any shot that explains how a part works inside: a cutaway or a mechanism running with live readouts.`
				: `anatomy (${skillFile("anatomy")}) or anatomy-reveal (${skillFile("anatomy-reveal")}) supplies the hero 3D object: the product, part or mechanism the film's device is made of, built from real parts rather than a placeholder shape.`,
		"Blender is the asset workshop only: model, bake and simplify there (blender action run), export GLB at most 2K textures, register it (asset_register), and draw it in three.js. Never render the film in Blender.",
	];
	const engine = "One clock for everything. The film's spine is cinetic's Remotion starter (scripts/new-film.sh; HyperFrames when the work is HTML and GSAP): mount the anatomy figure or the three.js scene inside an act as a pure function of the frame, so picture, cues and sound share timeline.ts. Splice a separately rendered clip (an anatomy-reveal film.mjs render) only when it cannot be driven from the timeline, conformed to the film's fps and size and treated as one act. Run new-film.sh with --link-modules when a node_modules already exists, and ask before any npm install the user has not approved.";
	const conflicts = [
		"Where the skills disagree, decide in this order: the user's own words and brand, then cinetic's hard bans (no serif or italic type, no orange, amber, cream, purple, indigo or neon, no glow, particles or lens flares), then the lead skill's defaults. Re-colour the anatomy figure from the film's tokens.ts so it belongs to the film.",
		narration === "asked"
			? "Narration was asked for: cinetic's \"visual, not narrated\" default yields. Write the script for the ear, synthesize it (narration_tts, measured durations), place each line on timeline cues, and duck the score under it; the picture still reads with the sound off."
			: narration === "explains"
				? "An explainer usually wants a voice: narrate where the picture alone cannot carry the how (narration_tts, timed to cues, score ducked), and keep cinetic's rule that the picture reads with the sound off."
				: "Narration is optional here: follow cinetic's default (picture carries the idea, copy in short fragments) unless the user asks for a voice.",
		`Pace: ${pace} (cinetic's ${pace} profile)${pace === "crisp" ? ", because the request asks for energy" : ", the default; switch to crisp only if the user asks for energy"}. Sound effects come from cinetic's kit and score with every hit caused by something visible; the harness's audio_synth and music_compose are the fallback when the kit cannot render.`,
		"Machine budget: previews at low resolution and preview scale, one browser and one render at a time, long renders in the background; cinetic's motion-blur master once at the end with --budget, after the last review round.",
	];
	const body = [
		`Film blend (${mode}): the skills below work as one crew on this film, each in its role. Write the blend into BRIEF.md, and re-plan it if the user's direction changes.`,
		leadLine[mode],
		`Supporting roles:\n- ${roles.join("\n- ")}`,
		engine,
		conflicts.join(" "),
	].join("\n\n");
	return { mode, lead, signals, pace, narration, text: body };
}
