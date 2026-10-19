/** The film pipeline. cinetic's Remotion starter is the one project format: src/timeline.ts
 * drives picture, cues and sound. This module installs the Python tools cinetic's scripts
 * need, scaffolds a film with its pinned dependencies (three.js included), type-checks and
 * lints it, and renders stills, previews and the master through cinetic's own render.sh. */
import fs from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runGuarded, type Progress } from "./guarded-process.ts";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { FFMPEG_FLAGS, probe, produced, run } from "./media-process.ts";
import { contactSheetFilter } from "./video-studio.ts";

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CINETIC = path.join(AGENT_ROOT, "skills/cinetic");
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
/** Python for cinetic's render gates, blur and QA scripts; Remotion and three.js install per film. */
export const filmPython = () => path.join(agentDir(), "local-tools", "film", "venv", "bin", "python");
export const FILM_PYTHON_PACKAGES = ["numpy==2.5.4", "scipy==1.18.1", "soundfile==0.14.0", "opencv-python-headless==4.14.0.94", "pyloudnorm==0.2.0", "fonttools==4.67.0", "pillow==13.0.0"];
/** three.js in Remotion (@remotion/three) and the renderer used for fast stills, pinned to the starter's Remotion. */
export const FILM_EXTRA_PACKAGES: Record<string, string> = {
	"@remotion/three": "4.0.529", "@remotion/renderer": "4.0.529", "@remotion/bundler": "4.0.529",
	"@react-three/fiber": "9.8.2", three: "0.186.1",
};
const FILM_EXTRA_DEV: Record<string, string> = { "@types/three": "0.186.0" };
const SIZES: Record<string, string> = { landscape: "1920x1080", vertical: "1080x1920", square: "1080x1080" };
const STILLS_RUNNER = path.join(AGENT_ROOT, "scripts/video-render.mjs");

/** A Chromium the renderer can drive without downloading one (Playwright's headless shell). */
export function filmBrowser(): string | undefined {
	if (process.env.YUNUSPI_VIDEO_BROWSER && existsSync(process.env.YUNUSPI_VIDEO_BROWSER)) return process.env.YUNUSPI_VIDEO_BROWSER;
	const cache = path.join(os.homedir(), ".cache", "ms-playwright");
	try {
		const shells = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
		for (const shell of shells) for (const sub of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
			const candidate = path.join(cache, shell, sub);
			if (existsSync(candidate)) return candidate;
		}
	} catch { /* no Playwright cache: Remotion downloads its own shell on first render */ }
	return undefined;
}

async function pythonReady(signal?: AbortSignal): Promise<boolean> {
	if (!existsSync(filmPython())) return false;
	try { await run(filmPython(), ["-c", "import numpy, scipy, soundfile, cv2, pyloudnorm"], signal, 60_000); return true; } catch { return false; }
}

/** A film directory inside the workspace (the folder holding src/index.ts once scaffolded). */
export async function filmDir(value: unknown, cwd: string, mustExist = true): Promise<string> {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("dir must be a film directory inside the workspace");
	const root = await fs.realpath(cwd);
	const dir = canonicalMutationPath(value, root);
	if (!containsPath(root, dir)) throw new Error("The film directory must be inside the current workspace");
	const denial = selfMutationDenial(path.join(dir, "src"), root);
	if (denial) throw new Error(denial);
	if (mustExist && !existsSync(path.join(dir, "src/timeline.ts"))) throw new Error(`${dir} is not a film (no src/timeline.ts); create one with video_project action:"init"`);
	return dir;
}

/** The film's out/ folder. A symlink that leads outside the film is refused before anything is written there. */
export function checkedOut(dir: string): string {
	const base = canonicalMutationPath(dir);
	const out = canonicalMutationPath(path.join(base, "out"));
	if (!containsPath(base, out)) throw new Error("out/ must stay inside the film folder");
	return out;
}

/** The soundtrack render.sh muxes: a file inside the workspace, relative to the film folder. */
export function checkedAudio(value: unknown, dir: string, root: string): string {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("audio must be a file path inside the workspace");
	const file = canonicalMutationPath(value, dir);
	if (!containsPath(root, file)) throw new Error(`audio ${value} must be inside the workspace (${root})`);
	if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`audio ${value} is not a file`);
	return file;
}

/** measure-speed.py options that render.sh's --measure may pass on. Path-reading options (--analytic, --cues, --copy)
 * and options render.sh already sets (--offset, --budget) are left out. */
const MEASURE_OPTIONS = new Set(["--shutter", "--step", "--min", "--max", "--still", "--width", "--mask-thr", "--dense-pct", "--dense-min-px", "--track-pct", "--track-support", "--fb-tol", "--spike", "--maxfilter", "--cut-mad", "--cut-frac", "--too-fast", "--min-shutter", "--no-short-shutter", "--pace", "--workers", "--quiet"]);
/** render.sh options a preview or final may take from flags; null = a switch with no value. Mode, audio and budget have their own parameters. */
const RENDER_FLAGS = new Map<string, { shape: string; valid: (value: string) => boolean } | null>([
	["--frames", { shape: "A-B", valid: (value) => /^\d+-\d+$/.test(value) }],
	["--accept-fast", { shape: "A-B", valid: (value) => /^\d+(?:-\d+)?$/.test(value) }],
	["--accept-cut", { shape: "A-B", valid: (value) => /^\d+(?:-\d+)?$/.test(value) }],
	["--floor", { shape: "A-B:N", valid: (value) => /^\d+-\d+:\d+(?:,\d+-\d+:\d+)*$/.test(value) }],
	["--measure", { shape: "ARGS (measure-speed.py options such as --max 64 --step 2)", valid: (value) => value.split(/\s+/).filter(Boolean).every((token) => !token.startsWith("-") || MEASURE_OPTIONS.has(token)) }],
	["--crf", { shape: "N", valid: (value) => /^\d{1,2}$/.test(value) }],
	["--concurrency", { shape: "N or a percentage", valid: (value) => /^\d{1,3}%?$/.test(value) }],
	["--10bit", null], ["--keep", null], ["--no-check", null],
]);
const FLAG_HINTS = new Map<string, string>([
	["--", "a bare -- would pass raw arguments to Remotion"],
	["--audio", "the audio parameter sets it"], ["--no-audio", "the audio parameter sets it"], ["--budget", "the budget parameter sets it"],
	["--preview", "the mode decides"], ["--blur", "the mode decides"], ["--master", "the mode decides"],
]);

/** flags are raw render.sh options. Entries are one option each, or "option value" pairs (an entry may hold both). */
export function checkedFlags(flags: unknown): string[] {
	if (flags === undefined || flags === null) return [];
	if (!Array.isArray(flags) || flags.length > 12) throw new Error("flags must be a list of up to 12 render options");
	const tokens: string[] = [];
	for (const entry of flags) {
		const text = String(entry);
		if (/[\x00-\x1f]/.test(text)) throw new Error("flags cannot contain control characters");
		const space = text.indexOf(" ");
		if (space > 0) tokens.push(text.slice(0, space), text.slice(space + 1));
		else tokens.push(text);
	}
	const allowed = [...RENDER_FLAGS].map(([name, rule]) => (rule ? `${name} ${rule.shape}` : name)).join(", ");
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const flag = tokens[i];
		if (!RENDER_FLAGS.has(flag)) {
			const hint = FLAG_HINTS.get(flag);
			throw new Error(`flags: "${flag}" is not an allowed render option${hint ? ` (${hint})` : ""}. Allowed: ${allowed}`);
		}
		out.push(flag);
		const rule = RENDER_FLAGS.get(flag);
		if (!rule) continue;
		const value = tokens[++i];
		if (value === undefined) throw new Error(`flags: ${flag} needs a value: ${rule.shape}`);
		if (!rule.valid(value)) throw new Error(`flags: ${flag} takes ${rule.shape}; got "${value}"`);
		out.push(value);
	}
	return out;
}

const filmEnv = (): Record<string, string> => {
	const browser = filmBrowser();
	const venv = path.dirname(filmPython());
	return { PATH: [...(existsSync(venv) ? [venv] : []), process.env.PATH ?? ""].join(path.delimiter), ...(browser ? { REMOTION_BROWSER: browser } : {}) };
};

const tail = (text: string, lines = 30) => text.trim().split("\n").slice(-lines).join("\n");

async function freshOut(dir: string, kind: string): Promise<string> {
	const out = path.join(checkedOut(dir), `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
	await fs.mkdir(out, { recursive: true });
	return out;
}

async function sheet(images: Array<{ path: string; label: string }>, output: string, signal?: AbortSignal): Promise<string> {
	const args = [...FFMPEG_FLAGS, "-loglevel", "error"];
	for (const image of images) args.push("-i", image.path);
	args.push("-filter_complex", contactSheetFilter(images.map((image) => image.label)), "-map", "[sheet]", "-frames:v", "1", "-update", "1", output);
	await run("ffmpeg", args, signal, 60_000);
	return (await produced(output)).path;
}

/** Evenly spaced frames from an encoded film, as a labelled contact sheet. */
async function sheetFromVideo(video: string, out: string, count: number, signal?: AbortSignal): Promise<{ contactSheet: string; frames: string[] }> {
	const info = await probe(video, signal);
	const seconds = Number(info.format?.duration) || 0;
	const frames: Array<{ path: string; label: string }> = [];
	for (let i = 0; i < count; i++) {
		const at = seconds * (i + 0.5) / count;
		const file = path.join(out, `frame-${String(i).padStart(2, "0")}.png`);
		await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-update", "1", file], signal, 60_000);
		frames.push({ path: file, label: `${at.toFixed(1)}s` });
	}
	return { contactSheet: await sheet(frames, path.join(out, "contact-sheet.png"), signal), frames: frames.map((frame) => frame.path) };
}

export async function filmStatus(signal?: AbortSignal) {
	const python = await pythonReady(signal);
	return {
		python: python ? filmPython() : null, browser: filmBrowser() ?? null, skill: path.join(CINETIC, "SKILL.md"),
		ready: python,
		...(python ? {} : { next: 'video_project action:"install" creates the Python tools cinetic\'s render and QA scripts need' }),
	};
}

export async function filmInstall(signal?: AbortSignal, progress?: Progress) {
	const venv = path.dirname(path.dirname(filmPython()));
	await fs.mkdir(path.dirname(venv), { recursive: true });
	if (!existsSync(filmPython())) {
		progress?.("Creating the film Python environment…");
		await runGuarded("python3", ["-m", "venv", venv], { cwd: path.dirname(venv), signal, timeoutMs: 120_000, guard: false });
	}
	progress?.(`Installing ${FILM_PYTHON_PACKAGES.join(", ")} (binary wheels only)…`);
	await runGuarded(filmPython(), ["-m", "pip", "install", "--quiet", "--only-binary=:all:", ...FILM_PYTHON_PACKAGES], { cwd: venv, signal, timeoutMs: 900_000, guard: false });
	return filmStatus(signal);
}

/** Scaffold a film with cinetic's new-film.sh, add three.js and the stills renderer at pinned versions, install. */
export async function filmInit(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
	const dir = await filmDir(params.dir, cwd, false);
	if (existsSync(dir) && (await fs.readdir(dir)).length && params.force !== true) throw new Error(`${dir} is not empty; choose a new folder or pass force:true`);
	const size = params.size ?? SIZES[params.format ?? "landscape"];
	if (!/^\d{3,4}x\d{3,4}$/.test(String(size))) throw new Error("size must be WxH, e.g. 1920x1080, or use format landscape|vertical|square");
	const args = [path.join(CINETIC, "scripts/new-film.sh"), dir, "--no-install", "--size", String(size)];
	if (params.fps !== undefined) args.push("--fps", String(params.fps));
	if (params.bpm !== undefined) args.push("--bpm", String(params.bpm));
	if (params.pace !== undefined) args.push("--pace", String(params.pace));
	if (params.name !== undefined) args.push("--name", String(params.name));
	for (const font of params.fonts ?? []) args.push("--font", String(font));
	const browser = filmBrowser();
	if (browser) args.push("--browser", browser);
	if (params.force === true) args.push("--force");
	await fs.mkdir(dir, { recursive: true });
	progress?.("Scaffolding the film from cinetic's starter…");
	const made = await runGuarded("bash", args, { cwd: dir, signal, timeoutMs: 300_000 });
	const pkgFile = path.join(dir, "package.json");
	const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8"));
	pkg.dependencies = { ...pkg.dependencies, ...FILM_EXTRA_PACKAGES };
	pkg.devDependencies = { ...pkg.devDependencies, ...FILM_EXTRA_DEV };
	await fs.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
	progress?.("Installing Remotion and three.js (first install downloads about 300 MB; later films reuse the npm cache)…");
	await runGuarded("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline"], { cwd: dir, signal, timeoutMs: 900_000 });
	const status = await filmStatus(signal);
	return {
		dir, engine: "remotion", composition: "Film", size, scaffold: tail(made.stdout + made.stderr, 12),
		guide: path.join(CINETIC, "SKILL.md"),
		files: { timeline: "src/timeline.ts", brand: "src/brand/tokens.ts", acts: "src/acts/", score: "audio/score.json" },
		threejs: "three, @remotion/three and @react-three/fiber are installed: mount a <ThreeCanvas> scene inside an act and drive every transform from useCurrentFrame().",
		...(status.ready ? {} : { next: status.next }),
		note: "The starter's brand is a placeholder that lint-film rejects until replaced: set the palette and type in src/brand/tokens.ts from the subject, write the beats in src/timeline.ts, build the acts, then video_render mode:\"stills\".",
	};
}

/** cinetic's own gate: TypeScript, lint-film (placeholder brand, banned looks) and the beat grid. */
export async function filmCheck(params: any, cwd: string, signal?: AbortSignal) {
	const dir = await filmDir(params.dir, cwd);
	const steps = [["npx", ["tsc", "--noEmit"]], ["node", ["scripts/lint-film.mjs", "src"]], ["npx", ["tsx", "scripts/grid-check.ts", "src/timeline.ts"]]] as const;
	const results = [];
	for (const [command, args] of steps) {
		try {
			const outcome = await runGuarded(command, [...args], { cwd: dir, signal, timeoutMs: 300_000, env: filmEnv() });
			results.push({ step: [command, ...args].join(" "), ok: true, output: tail(outcome.stdout + outcome.stderr, 8) });
		} catch (error: any) {
			results.push({ step: [command, ...args].join(" "), ok: false, output: tail(String(error?.message ?? error), 30) });
		}
	}
	return { dir, ok: results.every((result) => result.ok), steps: results };
}

/** stills: chosen frames through one bundle and one browser; preview and final: cinetic's render.sh. */
export async function filmRender(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
	const dir = await filmDir(params.dir, cwd);
	const root = await fs.realpath(cwd);
	if (!existsSync(path.join(dir, "node_modules/remotion"))) throw new Error('Film dependencies are missing; run npm install in the film folder or re-run video_project action:"init"');
	const mode = params.mode ?? "stills";
	const composition = params.composition ?? "Film";
	if (mode === "stills") {
		if (params.flags?.length) throw new Error("flags apply to preview and final renders");
		const out = await freshOut(dir, "stills");
		const request = { project: dir, outDir: out, mode: "stills", composition, frames: params.frames, count: params.count ?? (params.frames ? undefined : 6), browserExecutable: filmBrowser(), concurrency: 1 };
		const requestPath = path.join(out, "render-request.json");
		await fs.writeFile(requestPath, JSON.stringify(request));
		let result: any;
		await runGuarded(process.execPath, [STILLS_RUNNER, requestPath], {
			cwd: dir, signal, timeoutMs: 600_000, nice: 10,
			onLine: (line) => {
				if (line.startsWith("VIDEO_RENDER_RESULT ")) result = JSON.parse(line.slice(20));
				else if (line.startsWith("VIDEO_RENDER_PROGRESS ")) { const p = JSON.parse(line.slice(22)); progress?.(p.stage === "bundle" ? `Bundling ${p.percent}%` : `Stills ${p.done}/${p.total}`); }
			},
		}).catch((error) => { throw new Error(`Stills failed: ${result?.error ?? error?.message ?? error}`); });
		if (!result || result.error) throw new Error(`Stills failed: ${result?.error ?? "no result"}`);
		const stills = result.stills.map((still: any) => ({ ...still, label: `f${still.frame} ${still.seconds.toFixed(1)}s` }));
		return { mode, composition: result.composition, fps: result.fps, size: `${result.width}x${result.height}`, durationInFrames: result.durationInFrames,
			contactSheet: await sheet(stills, path.join(out, "contact-sheet.png"), signal), stills,
			review: "Look at the contact sheet and the full-size stills that matter: composition, type, colour against the brand tokens, the 3D subject's detail and light. Fix what is weak, then look again." };
	}
	if (mode !== "preview" && mode !== "final") throw new Error("mode must be stills, preview or final");
	const flags = checkedFlags(params.flags);
	const audio = params.audio != null ? checkedAudio(params.audio, dir, root)
		: existsSync(path.join(dir, "public/audio/soundtrack.wav")) ? checkedAudio("public/audio/soundtrack.wav", dir, root) : undefined;
	const output = path.join(checkedOut(dir), mode === "final" ? "film.mp4" : "preview.mp4");
	const args = [path.join(dir, "scripts/render.sh"), composition, output, mode === "final" ? "--blur" : "--preview", ...(audio ? ["--audio", audio] : ["--no-audio"])];
	if (mode === "final") args.push("--budget", String(params.budget ?? 6));
	args.push(...flags);
	progress?.(mode === "final" ? "Rendering the motion-blurred master (several times a sharp render)…" : "Rendering a preview…");
	let rendered: { stdout: string; stderr: string };
	try {
		rendered = await runGuarded("bash", args, { cwd: dir, signal, timeoutMs: mode === "final" ? 5_400_000 : 1_800_000, nice: 10, env: filmEnv() });
	} catch (error: any) {
		throw new Error(`render.sh ${mode} failed (its gates or a step):\n${tail(String(error?.message ?? error), 40)}`);
	}
	const out = await freshOut(dir, `${mode}-sheet`);
	const frames = await sheetFromVideo(output, out, 9, signal);
	const info = await probe(output, signal);
	return { mode, output, seconds: Number(info.format?.duration), hasAudio: info.streams?.some((stream: any) => stream.codec_type === "audio") ?? false,
		contactSheet: frames.contactSheet, log: tail(rendered.stdout + rendered.stderr, 15),
		next: mode === "final"
			? 'video_qa action:"analyze" and action:"listen" on this file, frames from it, then deliver.'
			: 'Watch the timing in the contact sheet, measure the mix with video_qa action:"listen", fix, and render the final once.' };
}
