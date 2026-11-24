/**
 * Session facts — one stored, model-only line at each human message: local
 * time, session spend, context occupancy, prompt-cache hits and the last run's
 * time and cost. A message that
 * asks for speed adds the haste sentence to that same line, once; a request that
 * names a subject adds the installed guides that match it (at most three).
 *
 * The line is returned once from before_agent_start and stored in the session,
 * so later requests replay the same bytes. Regenerating it per request would
 * change the prompt prefix every step and re-bill the whole transcript; a
 * figure that is not known is left out of the line, never invented.
 *
 * A run is everything the session does after one message from the user. The
 * extension owns the run's soft budget (`run.softMinutes`, `run.softUsd`, both
 * from lib/team.ts): when one passes, the model gets one advisory note; at
 * twice the budget, one closing note. A note is a message of its own, sent
 * after the tool results in hand and shown in the transcript: text appended
 * to a tool result reads as part of a file, and a model rightly distrusts
 * instructions it finds there. Nothing is stopped or refused. The live run is
 * shared with cost-governor's /budget through Symbol.for("yunus-pi.run.v1").
 *
 * Child processes (PI_SUBAGENT_CHILD=1) register nothing.
 */
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { collectSessionCost, collectSessionMetrics } from "@yunuspi/coding-agent/session-accounting";
import { DEFAULT_TEAM_CONFIG, loadTeamConfig, type RunBudget } from "./lib/team.ts";
import { resolveTimeZone } from "./lib/session-signals.ts";
import { goalUserWords } from "./lib/goal-state.ts";
import { goalAssignment } from "./lib/presets.ts";
import { catalogSkills, matchingGuides, type CatalogSkill } from "./lib/skill-review.ts";
import { askJev } from "./lib/jev-client.ts";
import { askTypedDecision, BOLD_EXAMPLE_SCALES, EXAMPLE_SCALE_DESCRIPTIONS, MAX_BOLD_PICKS, type ExampleScale } from "./lib/micro-intelligence/jev-decisions.ts";
import type { JudgeFn } from "./lib/micro-intelligence/review.ts";
import { uiPromptCue } from "./lib/ui-doctrine.ts";

const RUN_STATE = Symbol.for("yunus-pi.run.v1");
const CUSTOM_TYPE = "session-facts";
const BUDGET_NOTE_TYPE = "run-budget";
const HURRY_NOTE_TYPE = "session-hurry";
/** Events further apart than this are idle time, not run time. */
const GAP_MS = 10 * 60_000;
/** All local commands behind the Where line share this budget. */
const WHERE_LIMIT_MS = 1_000;
const WHERE_MAX_CHARS = 320;

function gitText(cwd: string, args: string[], left: () => number): string | undefined {
	const timeout = left();
	if (timeout <= 0) return undefined;
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
	} catch {
		return undefined;
	}
}

/** `owner/repo` from the usual remote URLs; the last two path parts otherwise. */
function remoteLabel(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const clean = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
	const scp = /^[^/@]+@[^:]+:(.+)$/.exec(clean);
	const path = scp ? scp[1] : clean.replace(/^[a-z]+:\/\/[^/]+\//i, "");
	const parts = path.split("/").filter(Boolean);
	return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}

/** What the repository's top level shows that a push or deploy would reach. */
function liveSigns(root: string, remotes: readonly string[]): string[] {
	const signs: string[] = remotes.filter((name) => name !== "origin");
	for (const name of ["deploy.sh", "wrangler.toml", "vercel.json", "netlify.toml", "firebase.json", "fly.toml", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
		if (existsSync(join(root, name))) signs.push(name);
	}
	try {
		const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.scripts ?? {};
		for (const name of ["deploy", "publish"]) if (scripts[name]) signs.push(`script ${name}`);
	} catch {
		/* no package scripts */
	}
	if (existsSync(join(root, ".github", "workflows"))) signs.push(".github/workflows");
	return [...new Set(signs)];
}

/** Repositories one or two levels below a folder, bounded and sorted. */
function repositoriesBelow(cwd: string): string[] {
	const found: string[] = [];
	const visit = (dir: string, depth: number): void => {
		if (depth > 2 || found.length >= 50) return;
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
			const child = join(dir, entry.name);
			if (existsSync(join(child, ".git"))) found.push(entry.name);
			else if (depth < 2) visit(child, depth + 1);
		}
	};
	visit(cwd, 1);
	return found.sort();
}

/** One line saying which folder this session is in and what it is, from the machine. */
export function whereLine(cwd: string, home = homedir()): string {
	const folder = resolve(String(cwd || "."));
	const resolvedHome = resolve(home);
	const start = Date.now();
	const left = (): number => Math.max(0, WHERE_LIMIT_MS - (Date.now() - start));
	const shortFolder = folder === resolvedHome || folder.startsWith(`${resolvedHome}/`) ? `~${folder.slice(resolvedHome.length)}` : folder;
	let kind: string;
	let signs: string[] = [];
	const top = gitText(folder, ["rev-parse", "--show-toplevel"], left);
	if (top) {
		const root = resolve(top);
		let prefix = "";
		const prefixTimeout = left();
		if (prefixTimeout > 0) {
			try {
				prefix = execFileSync("git", ["-C", folder, "rev-parse", "--show-prefix"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: prefixTimeout }).trim();
			} catch {
				/* treat as the root */
			}
		}
		const remotes = (gitText(root, ["remote"], left) ?? "").split("\n").map((name) => name.trim()).filter(Boolean);
		const remoteName = remotes.includes("origin") ? "origin" : remotes[0];
		const remote = remoteName ? remoteLabel(gitText(root, ["remote", "get-url", remoteName], left)) ?? "none" : "none";
		const branch = gitText(root, ["branch", "--show-current"], left) || "detached";
		const name = basename(root);
		if (prefix) {
			kind = `a subfolder of the git repository ${name} (remote ${remote}, branch ${branch})`;
		} else {
			const changed = (gitText(root, ["status", "--porcelain"], left) ?? "").split("\n").filter(Boolean).length;
			kind = `the git repository ${name} (remote ${remote}, branch ${branch}, ${changed} uncommitted files)`;
		}
		signs = liveSigns(root, remotes);
	} else {
		const repos = repositoriesBelow(folder);
		if (repos.length) kind = `a folder holding ${repos.length} repositories (${repos.slice(0, 4).join(", ")})`;
		else if (folder === resolvedHome) kind = "the home folder, no project: a general or system task unless the message names a project";
		else kind = "a plain folder with no repository";
	}
	const live = signs.length ? ` Live system in reach: ${signs.slice(0, 3).join(", ")}; a push or deploy from here changes it.` : "";
	const line = `Where: ${shortFolder} is ${kind}.${live}`;
	return line.length <= WHERE_MAX_CHARS ? line : `${line.slice(0, WHERE_MAX_CHARS - 1)}…`;
}

/** A message asking for speed, in English or Turkish. */
const HURRY_PATTERNS: RegExp[] = [
	/\brush\b/,
	/\bhurry\b/,
	/\bbe quick\b/,
	/\bquickly\b/,
	/\bfaster\b/,
	/\basap\b/,
	/\btaking (?:too|so) long\b/,
	/\bwe don'?t have all day\b/,
	/\bno time\b/,
	/\bacele\b/,
	/çabuk/,
	/\bhızlı ol\b/,
	/\bhemen\b/,
	/\buzun sürdü/,
	/\bvakit yok\b/,
];

/**
 * True when the message asks for speed. Code is not prose, and a technical
 * term that merely contains one of the words ("faster-whisper") is not a
 * request to hurry.
 */
export function hurryRequested(text: unknown): boolean {
	if (typeof text !== "string" || !text) return false;
	const prose = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/faster[-_](?:whisper|than)/gi, " ");
	// Turkish lowercases I to ı: fold both spellings so an upper-case message matches too.
	const folded = prose.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
	return HURRY_PATTERNS.some((pattern) => pattern.test(folded));
}

/** Granted once, with the message that asked for speed. */
export const HURRY_NOTE =
	"The user wants speed now. Finish the open demands with the fewest steps: no new surveys, no optional checks or polish, one final check of what changed, then report. Stop subagents whose part is no longer needed.";

/** Whole minutes, rounded; at least 1 once the run has any time. */
export function wholeMinutes(ms: number): number {
	return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
}

const compactTokens = (tokens: number): string =>
	tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(2))}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(Math.round(tokens));

/** Spend as people read it: `$1.24`, `$0.034`, `$0.0004`; empty for an amount that rounds to nothing. */
const money = (usd: number): string => {
	const text = usd >= 0.1 ? usd.toFixed(2) : usd >= 0.001 ? usd.toFixed(3) : usd.toFixed(4);
	return Number(text) > 0 ? `$${text}` : "";
};

/** `Sat 14 Nov 2026, 16:02 (Europe/Istanbul).` in the session's own zone. */
function nowText(now: Date, zone: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	}).formatToParts(now);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
	return `Now: ${pick("weekday")} ${pick("day")} ${pick("month")} ${pick("year")}, ${time} (${zone}).`;
}

export interface SessionFactsInput {
	now: Date;
	zone: string;
	/** Measured session spend; absent when no price is known or the plan is flat. */
	usd?: number;
	/** `context 41k of 128k tokens`. */
	context?: string;
	/** Share of prompt tokens served from the provider cache. */
	cachePercent?: number;
	lastRun?: { minutes: number; usd?: number };
	/** The folder this session is in and what it is, computed from the machine. */
	where?: string;
	/** Installed guides that match the request; the line is left out when there are none. */
	guides?: readonly CatalogSkill[];
	/** The picked example libraries for visual work, as one complete sentence. */
	examples?: string;
}

/** `name: description clipped at a word (file)`, as the facts line lists a guide. */
function guideText(skill: CatalogSkill): string {
	const flat = skill.description.replace(/\s+/g, " ").trim();
	const description = flat.length > 110 ? `${flat.slice(0, 109).replace(/\s+\S*$/, "")}…` : flat;
	return `${skill.name}: ${description} (${skill.file})`;
}

/** The stored facts line: unknown figures drop out, the time is always there. */
export function sessionFactsText(input: SessionFactsInput): string {
	const pieces = [
		input.usd === undefined ? "" : money(input.usd),
		input.context ?? "",
		input.cachePercent === undefined ? "" : `cache hits ${Math.round(input.cachePercent)}%`,
	].filter(Boolean);
	let line = nowText(input.now, input.zone);
	if (pieces.length) line += ` Session: ${pieces.join(", ")}.`;
	if (input.lastRun) {
		const spend = input.lastRun.usd === undefined ? "" : money(input.lastRun.usd);
		line += ` Last run: ${input.lastRun.minutes} min${spend ? `, ${spend}` : ""}.`;
	}
	if (input.where) line += `\n${input.where}`;
	const guides = input.guides?.length
		? `\nGuides that match this request (read the ones that bear on it before choosing the approach): ${input.guides.map(guideText).join("; ")}`
		: "";
	const examples = input.examples ? `\n${input.examples}` : "";
	return line + guides + examples;
}

/**
 * The guides that fit what the user asked. A goal kickoff is matched on the
 * goal sentence only: its criteria and standards would match every skill. The
 * line is advisory, so a failure here leaves it out and not the facts.
 */
function matchingGuidesFor(event: any): CatalogSkill[] {
	try {
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		const words = goalUserWords(prompt);
		return matchingGuides(catalogSkills(event), words === undefined ? prompt : goalAssignment(words));
	} catch {
		return [];
	}
}

/** The example pick may take this long; a slow judge falls back to the static pick. */
export const DESIGN_EXAMPLES_TIMEOUT_MS = 3_500;
const MAX_EXAMPLE_CANDIDATES = 12;
/** The static pick for a clearly visual request when the judge abstains or fails. */
const STATIC_EXAMPLE_IDS = ["scrolltide:landing-pages", "scrolltide:heroes", "refero"];

export interface ExampleCandidate {
	/** Short id the judge chooses among. */
	id: string;
	/** Where to read it: an installed reference file or a public URL. */
	path: string;
	/** What it offers, for the judge's choice. */
	about: string;
}

const SCROLLTIDE_REFERENCES: ReadonlyArray<readonly [string, string]> = [
	["landing-pages", "whole pages told on the scrollbar"],
	["heroes", "first screens people remember"],
	["3d-websites", "pages built around a 3D scene"],
	["components", "buttons, cards, loaders, navigation and text with a physical idea"],
	["sections", "features, pricing, contact, call to action and footer sections"],
	["shaders", "moving gradient, aurora, metal, halftone and fluid backgrounds"],
	["ui-screens", "dashboard, finance and commerce app screens"],
];

/** Uncommon Web families, with the words that make each one relevant. */
const UNCOMMON_REFERENCES: ReadonlyArray<readonly [string, string, string]> = [
	["dither-pixel-ascii", "1-bit screens, halftone, newsprint, CRT and live ASCII", "dither ascii 1-bit pixel crt halftone newsprint screen"],
	["text-mode-braille-graphics", "characters as pictures: braille, glyph maps, terminal UI", "braille terminal text characters glyph banner"],
	["paper-shaders-in-depth", "shader fills, filters and borders for product UI", "paper shader filter border card"],
	["typography-text", "text split, scrambled, annotated, hand-written or set like print", "type typography text headline font letter heading"],
	["shaders-webgl-3d", "GPU backdrops: globes, fluid, gradients with depth", "shader webgl gpu 3d globe fluid gradient background hero"],
	["materials-3d-splats", "refracting glass, soft surfaces and 3D scenes", "glass surface material splat 3d product"],
	["visual-effects-generative-art", "glitch, generative patterns and low-poly fields", "glitch generative pattern effect visual noise"],
	["audio-visual-feedback", "music visualisers and feedback loops", "audio music visualiser sound feedback"],
	["generative-art-plotters", "ink landscapes, plotter lines, pigment and procedural plants", "ink landscape plotter pigment plant drawing art"],
	["data-maps-graphs-as-art", "data as the picture: flight arcs, graphs, projections", "map graph chart data projection flight network"],
	["hand-drawn-sketchy", "wobbly, sketched shapes, charts and whiteboards", "sketch hand-drawn wobbly whiteboard drawing"],
	["retro-os-themed-css", "a whole operating-system look as a stylesheet", "retro operating system os window desktop 90s"],
	["css-only-stylesheets", "CSS paint worklets, patterns, foil and typographic stylesheets", "css pattern foil stylesheet paint"],
	["motion-physics-interaction", "springs, timelines, layout transitions and smooth scroll", "motion animation spring transition scroll interaction"],
	["scroll-pages-transitions", "page curls, folds, zooming and scrollytelling", "scroll scrollytelling page transition curl fold zoom"],
	["physics-simulation", "water, cloth and rigid bodies that behave like matter", "physics water cloth rigid body simulation"],
	["tactile-odd-widgets", "split-flap boards, knobs, counters and brushes", "widget split-flap knob counter brush interactive control"],
	["react-component-registries", "copy-in React components and the usual primitives", "react component registry ui"],
	["react-bits-in-depth", "animated React components installed as editable source", "react animated component motion"],
	["opinionated-component-kits", "component kits with an identity: 8-bit, neo-brutalist, with sound", "component kit 8-bit brutalist sound"],
	["creative-coding-sound", "sketchbooks, live-coded visuals and tiny engines", "creative coding live sketch engine"],
	["music-synths-notation", "synths, trackers, sheet music and tabs", "music synth tracker sheet tabs"],
	["games-consoles-emulators", "small game engines, fantasy consoles and emulators", "game console emulator engine"],
];

/** Up to three Uncommon Web families whose own vocabulary appears in the request. */
export function uncommonReferencesFor(prompt: string): string[] {
	const words = new Set(String(prompt ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
	return UNCOMMON_REFERENCES
		.map(([id, , terms]) => ({ id, hits: terms.split(" ").filter((term) => words.has(term)).length }))
		.filter((entry) => entry.hits > 0)
		.sort((a, b) => b.hits - a.hits)
		.slice(0, 3)
		.map((entry) => entry.id);
}

/** The installed skill's directory, with a trailing slash, from the prompt catalogue. */
function skillReferenceRoot(event: any, name: string): string | undefined {
	const skill = catalogSkills(event).find((entry) => entry.name === name);
	if (!skill) return undefined;
	const file = String(skill.file).replaceAll("\\", "/");
	const slash = file.lastIndexOf("/");
	return slash >= 0 ? file.slice(0, slash + 1) : undefined;
}

/** The example index for this request: the scrolltide files, the relevant Uncommon Web families, the galleries and Refero. */
export function exampleCandidates(event: any, prompt: string): ExampleCandidate[] {
	const candidates: ExampleCandidate[] = [];
	const scrolltide = skillReferenceRoot(event, "scrolltide");
	if (scrolltide) {
		for (const [id, about] of SCROLLTIDE_REFERENCES) {
			candidates.push({ id: `scrolltide:${id}`, path: `${scrolltide}references/${id}.md`, about });
		}
	}
	const uncommon = skillReferenceRoot(event, "uncommon-web");
	if (uncommon) {
		for (const id of uncommonReferencesFor(prompt)) {
			const about = UNCOMMON_REFERENCES.find((entry) => entry[0] === id)?.[1] ?? id;
			candidates.push({ id: `uncommon:${id}`, path: `${uncommon}references/${id}.md`, about });
		}
	}
	const design = skillReferenceRoot(event, "ui-design");
	if (design) {
		candidates.push({ id: "ui-design:galleries", path: `${design}references/patterns.md`, about: "navigation bar, footer and call-to-action galleries" });
	}
	candidates.push({ id: "refero", path: "https://styles.refero.design/", about: "written style systems of real products" });
	return candidates.slice(0, MAX_EXAMPLE_CANDIDATES);
}

/**
 * One line naming the example libraries to open. The judge picks the best one
 * and an optional second; a failure, timeout or abstention falls back to
 * landing pages, heroes and Refero. The line is advisory and never blocks the
 * turn beyond its 3.5 s deadline.
 */
const SCALE_ORDER: readonly ExampleScale[] = ["keep-design", "polish", "improve", "redesign", "fresh-build"];
/** An explicit wish to keep the existing design, in English or Turkish. */
const KEEP_DESIGN_ASKED: readonly RegExp[] = [
	/\bkeep (?:the )?(?:design|layout|colou?rs?)(?: as (?:it is|is|they are))?\b/i,
	/\b(?:don'?t|do not) change (?:the )?(?:design|layout|colou?rs?)\b/i,
	/\bonly polish\b/i,
	/\bjust a small fix\b/i,
	/\b(?:tasar[ıi]m|d[üu]zen|renkler)\s+(?:ayn[ıi] kals[ıi]n|de[ğg]i[şs]mesin)\b/i,
	/\btasar[ıi]ma dokunma\b/i,
	/\bsadece k[üu][çc][üu]k bir d[üu]zeltme\b/i,
];

/**
 * The boldest design scale this session has judged, held across prompts. A
 * later complaint never lowers it; only an explicit wish to keep the design
 * does. Reset where the session's other per-session state is reset.
 */
export function designScaleMemory(): {
	remember: (prompt: string) => (judged?: ExampleScale) => ExampleScale | undefined;
	get: () => ExampleScale | undefined;
	reset: () => void;
} {
	let held: ExampleScale | undefined;
	return {
		remember: (prompt) => (judged) => {
			if (KEEP_DESIGN_ASKED.some((pattern) => pattern.test(prompt))) held = "keep-design";
			else if (judged && (!held || SCALE_ORDER.indexOf(judged) > SCALE_ORDER.indexOf(held))) held = judged;
			return held;
		},
		get: () => held,
		reset: () => { held = undefined; },
	};
}

export async function pickExampleLine(
	candidates: readonly ExampleCandidate[],
	request: string,
	judge: JudgeFn | undefined,
	signal?: AbortSignal,
	rememberScale?: (judged?: ExampleScale) => ExampleScale | undefined,
): Promise<string | undefined> {
	if (!candidates.length) return undefined;
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const judged = await askTypedDecision(
		"design-examples",
		{
			state: {
				request: request.slice(0, 1500),
				examples: candidates.map((candidate) => `${candidate.id} = ${candidate.about}`).join("; "),
			},
			candidates: candidates.map((candidate) => candidate.id),
		},
		{ judge, signal },
	);
	const picked: string[] = [];
	let scale: ExampleScale | undefined;
	let effective: ExampleScale | undefined;
	if (judged.ok) {
		const best = typeof judged.verdict?.best === "string" ? judged.verdict.best : "";
		const second = typeof judged.verdict?.second === "string" ? judged.verdict.second : "";
		const judgedScale = judged.verdict?.scale;
		if (typeof judgedScale === "string" && Object.hasOwn(EXAMPLE_SCALE_DESCRIPTIONS, judgedScale)) scale = judgedScale as ExampleScale;
		effective = rememberScale ? rememberScale(scale) : scale;
		const rawPicks = judged.verdict?.picks;
		const wide = Array.isArray(rawPicks) ? rawPicks.filter((id): id is string => typeof id === "string") : [];
		// A bold scale names up to four, already ranked, with one index that has a point of view among them.
		if (effective && BOLD_EXAMPLE_SCALES.has(effective) && wide.length) picked.push(...wide);
		else {
			if (best) picked.push(best);
			if (second && second !== best) picked.push(second);
		}
	}
	else if (rememberScale) effective = rememberScale(undefined);
	const bold = effective !== undefined && BOLD_EXAMPLE_SCALES.has(effective);
	let ids = [...new Set(picked)].filter((id) => byId.has(id)).slice(0, bold ? MAX_BOLD_PICKS : 2);
	if (!ids.length) ids = STATIC_EXAMPLE_IDS.filter((id) => byId.has(id));
	if (!ids.length) return undefined;
	const paths = ids.map((id) => byId.get(id)!.path);
	const galleries = byId.get("ui-design:galleries")?.path;
	const guide = galleries ? `Read ${galleries.replace(/patterns\.md$/, "bold-redesign.md")} first: it says how this kind of request is worked and lists every gallery, example and library. ` : "";
	const tail = effective === "keep-design"
		? "Keep the existing design; use the examples only for the detail being fixed."
		: bold
			? `${guide}The safe, familiar page is the failure here. Open at least three of them live in the browser, from different sources and past the first familiar one (read the index, then the pages). Commit to one strong idea that suits this brand (3D, scroll motion, a shader, kinetic type or a tactile part where it serves; a tool people work in daily keeps a stable layout), build, then iterate on the screenshot at least twice: a first pass that looks nice is usually the median, so name what is generic and replace it. Name what you took from each.`
			: "Open several, take the parts that fit, adapt them to this project, iterate on screenshots.";
	let line = `Examples for this request: ${paths.join(", ")}. ${tail}`;
	if (effective) line += ` Change scale the request implies: ${effective} (${EXAMPLE_SCALE_DESCRIPTIONS[effective]}); ${bold
		? "the name, the logo and what the product says stay unless asked; nothing else is kept only because it is there."
		: "the logo stays unless asked, and colors and layout stay unless the scale or the user says otherwise."}`;
	return line;
}

/**
 * The example line for a message that reads as visual work, and nothing for
 * any other message. Clear visual vocabulary needs no judge to enter; the
 * judge only picks among the installed examples.
 */
export async function designExamplesLineFor(event: any, judge: JudgeFn | undefined, rememberScale?: (judged?: ExampleScale) => ExampleScale | undefined): Promise<string | undefined> {
	const prompt = typeof event?.prompt === "string" ? event.prompt : "";
	if (uiPromptCue(prompt).strength !== "strong") return undefined;
	const candidates = exampleCandidates(event, prompt);
	if (!candidates.length) return undefined;
	const deadline = AbortSignal.timeout(DESIGN_EXAMPLES_TIMEOUT_MS);
	const signal = event?.signal ? AbortSignal.any([event.signal, deadline]) : deadline;
	try {
		return await pickExampleLine(candidates, prompt, judge, signal, rememberScale);
	} catch {
		return undefined;
	}
}

/** Spend in a budget note; `$?` when no price is known. */
const noteSpend = (usd: number | undefined): string => (usd === undefined ? "$?" : money(usd) || "$0");

/** Only the limits that are switched on. */
export const limitText = (limits: RunBudget, joiner: string): string =>
	[limits.softMinutes > 0 ? `${limits.softMinutes} min` : "", limits.softUsd > 0 ? `$${Math.round(limits.softUsd * 100) / 100 === limits.softUsd ? limits.softUsd.toFixed(2) : limits.softUsd}` : ""]
		.filter(Boolean)
		.join(joiner);

/** The one note per budget level; level 2 is twice the budget. */
export function runBudgetNote(level: 1 | 2, minutes: number, usd: number | undefined, limits: RunBudget): string {
	if (level === 2) return `[run budget] ${minutes} min and ${noteSpend(usd)} since the user's last message, twice the soft budget. Focus on the remaining requested work and the checks it needs. Reuse current evidence and report any genuine blocker.`;
	return `[run budget] You do not have much time left: this run has worked for ${minutes} min and spent ${noteSpend(usd)} since the user's last message (budget: ${limitText(limits, " or ")}). Finish the item in hand, complete and verify every demand of the user that is still open, start nothing new that was not asked for, and report what is done, what is not and the next step.`;
}

interface Run {
	/** Session spend when the user's message arrived; 0 before anything was priced. */
	startedUsd: number | undefined;
	limits: RunBudget;
	activeMs: number;
	lastEventAt: number;
	/** Spend of this run as last measured. */
	usd: number | undefined;
	/** Budget level already noted: 0 none, 1 first limit, 2 twice the budget. */
	noted: 0 | 1 | 2;
	/** True between the end of the agent's work and its next start: waiting for the user is not run time. */
	resting: boolean;
}

export default function sessionFacts(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let run: Run | undefined;
	let runOwner: object | undefined;
	let measured: { manager: object; revision: number; usd?: number } | undefined;
	let lastRun: { minutes: number; usd?: number } | undefined;
	/**
	 * True while the last input was a human message that no run has started
	 * for yet. A steering or follow-up message joins the run in progress
	 * without a new start, and a refused prompt never starts one; neither may
	 * leave its line behind for a message the harness sends later.
	 */
	let pending: { signal?: AbortSignal } | undefined;
	/** True once the speed note reached this run, on either path. */
	let hurrySent = false;
	/** The boldest design scale judged in this session; a complaint never lowers it. */
	const designScale = designScaleMemory();
	/** The Where line, computed once and recomputed only when the working folder changes. */
	let where: { cwd: string; line: string } | undefined;
	const whereFor = (cwd: string): string => {
		if (!where || where.cwd !== cwd) where = { cwd, line: whereLine(cwd) };
		return where.line;
	};

	const entriesOf = (ctx: any): any[] => {
		try {
			const entries = ctx?.sessionManager?.getAccountingEntries?.() ?? ctx?.sessionManager?.getEntries?.();
			if (Array.isArray(entries)) return entries;
			const branch = ctx?.sessionManager?.getBranch?.();
			return Array.isArray(branch) ? branch : [];
		} catch {
			return [];
		}
	};
	/** Measured session spend; undefined when the price or the plan makes it unknown. */
	const sessionUsd = (ctx: any, entries?: any[]): number | undefined => {
		try {
			const manager = ctx?.sessionManager;
			if (manager?.isAccountingIncomplete?.()) return undefined;
			const revision = manager?.getAccountingEntriesRevision?.();
			if (measured && measured.manager === manager && measured.revision === revision) return measured.usd;
			const cost = collectSessionCost(entries ?? entriesOf(ctx));
			const usd = cost.seen ? cost.total : undefined;
			if (Number.isSafeInteger(revision)) measured = { manager, revision, usd };
			return usd;
		} catch {
			return undefined;
		}
	};
	const refreshUsd = (total: number | undefined): number | undefined => {
		if (!run) return undefined;
		run.usd = total === undefined || run.startedUsd === undefined ? undefined : Math.max(0, total - run.startedUsd);
		return run.usd;
	};
	/** Count the time since the last event of this run; a longer gap is idle. */
	const touch = (): void => {
		if (!run) return;
		const now = Date.now();
		const gap = now - run.lastEventAt;
		if (!run.resting && gap > 0 && gap <= GAP_MS) run.activeMs += gap;
		run.lastEventAt = now;
	};

	// /budget reads the live run from here; each extension has its own copy of
	// this module, so the symbol on globalThis is the one shared place.
	const readRun = (ctx?: any) => {
		if (!run || ctx && ctx.sessionManager !== runOwner) return undefined;
		if (ctx) {
			touch();
			refreshUsd(sessionUsd(ctx));
		}
		return { minutes: wholeMinutes(run.activeMs), usd: run.usd, limits: run.limits, budget: limitText(run.limits, " / ") };
	};
	(globalThis as any)[RUN_STATE] = readRun;

	const reset = (): void => {
		run = undefined;
		runOwner = undefined;
		measured = undefined;
		lastRun = undefined;
		pending = undefined;
		hurrySent = false;
		designScale.reset();
		where = undefined;
	};
	pi.on("session_start", reset);
	pi.on("session_switch", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", () => {
		reset();
		try {
			if ((globalThis as any)[RUN_STATE] === readRun) delete (globalThis as any)[RUN_STATE];
		} catch {
			/* a closing session leaves no state behind that matters */
		}
	});

	pi.on("input", (event: any) => {
		try {
			if (event?.source === "extension") {
				pending = undefined;
				return undefined;
			}
			const steer = (event?.source === "interactive" || event?.source === "rpc") && Boolean(event?.streamingBehavior);
			if (steer) {
				if (!hurrySent && hurryRequested(event?.originalText ?? event?.text)) {
					hurrySent = true;
					void Promise.resolve(
						pi.sendMessage({ customType: HURRY_NOTE_TYPE, content: HURRY_NOTE, display: false }, { deliverAs: "steer" }),
					).catch(() => { /* optional guidance */ });
				}
				return undefined;
			}
			pending = { signal: event?.signal };
		} catch {
			/* facts are advisory; a failure must not break the prompt */
		}
		return undefined;
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		try {
			touch();
			if (run) run.resting = false;
			const input = pending;
			pending = undefined;
			if (!input || input.signal?.aborted) return undefined;
			const entries = entriesOf(ctx);
			const spend = sessionUsd(ctx, entries);
			if (run) {
				const lastSpend = refreshUsd(spend);
				lastRun = { minutes: wholeMinutes(run.activeMs), ...(lastSpend === undefined ? {} : { usd: lastSpend }) };
			}
			let limits: RunBudget = DEFAULT_TEAM_CONFIG.run;
			try { limits = loadTeamConfig(ctx?.cwd ?? process.cwd()).run; } catch { /* use defaults */ }
			hurrySent = false;
			run = { startedUsd: ctx?.sessionManager?.isAccountingIncomplete?.() ? undefined : spend ?? 0, limits, activeMs: 0, lastEventAt: Date.now(), usd: undefined, noted: 0, resting: false };
			runOwner = ctx?.sessionManager;
			const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
			const window = Number(ctx?.model?.contextWindow);
			const tokens = usage?.tokens === null ? Number.NaN : Number(usage?.tokens);
			const context = Number.isFinite(tokens) && tokens > 0 && Number.isFinite(window) && window > 0
				? `context ${compactTokens(tokens)} of ${compactTokens(window)} tokens`
				: undefined;
			let cachePercent: number | undefined;
			try {
				const metrics = collectSessionMetrics(entries);
				if (metrics.cacheRead > 0 && metrics.cacheRate !== null) cachePercent = metrics.cacheRate;
			} catch {
				/* no usable cache data: the figure stays out */
			}
			const prompt = typeof event?.prompt === "string" ? event.prompt : "";
			const rememberScale = designScale.remember(prompt);
			const examples = await designExamplesLineFor(event, (site, state, questions, options) =>
				askJev(site, state, questions, { pi, signal: options?.signal, timeoutMs: DESIGN_EXAMPLES_TIMEOUT_MS }), rememberScale);
			// An explicit wish to keep the design registers even when the prompt is not read as visual work.
			rememberScale(undefined);
			const content = sessionFactsText({
				now: new Date(),
				zone: resolveTimeZone().zone,
				usd: spend,
				context,
				cachePercent,
				lastRun,
				where: whereFor(ctx?.cwd ?? process.cwd()),
				guides: matchingGuidesFor(event),
				examples,
			});
			const hurry = hurryRequested(event?.prompt) ? `\n${HURRY_NOTE}` : "";
			if (hurry) hurrySent = true;
			return { message: { customType: CUSTOM_TYPE, content: content + hurry, display: false } };
		} catch {
			return undefined;
		}
	});

	pi.on("turn_end", (_event: any, ctx: any) => {
		try {
			touch();
			if (run) refreshUsd(sessionUsd(ctx));
		} catch {
			/* timing is advisory */
		}
	});
	pi.on("agent_end", () => {
		pending = undefined;
		try {
			touch();
			if (run) run.resting = true;
			// The run is over: a run the harness starts next may be hurried again.
			hurrySent = false;
		} catch {
			/* timing is advisory */
		}
	});

	pi.on("tool_result", (_event: any, ctx: any) => {
		try {
			if (!run) return undefined;
			touch();
			const limits = run.limits;
			if (limits.softMinutes <= 0 && limits.softUsd <= 0) return undefined;
			if (run.noted >= 2) return undefined;
			const activeMs = run.activeMs;
			const minutes = wholeMinutes(run.activeMs);
			const usd = limits.softUsd > 0 || activeMs >= limits.softMinutes * 60_000
				? refreshUsd(sessionUsd(ctx))
				: run.usd;
			const passed = (factor: number): boolean =>
				(limits.softMinutes > 0 && activeMs >= limits.softMinutes * factor * 60_000) ||
				(limits.softUsd > 0 && usd !== undefined && usd >= limits.softUsd * factor);
			let level: 1 | 2 | undefined;
			if (passed(2)) level = 2;
			else if (passed(1)) level = 1;
			// Each level is noted once. A run that passes both thresholds before
			// its next tool result gets the closing note only; the first note
			// would be out of date already.
			if (!level || level <= run.noted) return undefined;
			run.noted = level;
			void Promise.resolve(
				pi.sendMessage({ customType: BUDGET_NOTE_TYPE, content: runBudgetNote(level, minutes, usd, limits), display: true }, { deliverAs: "steer" }),
			).catch(() => {
				/* a note that could not be queued changes nothing about the run */
			});
		} catch {
			/* the budget is advisory */
		}
		return undefined;
	});
}
