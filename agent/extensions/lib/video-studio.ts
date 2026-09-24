/** Code-first video production: Remotion projects driven by one master
 * timeline (video.json), local narration, procedural audio, and a visual/audio
 * QA loop. Project code (npm, Remotion, Python) runs through guardedCommand. */
import fs from "node:fs/promises";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { FFMPEG_FLAGS, inputArgs, inputFile, probe, produced, run } from "./media-process.ts";
import { canonicalMutationPath, containsPath, guardedCommand, selfMutationDenial } from "./self-mutation-guard.ts";
import { createRenderQueue } from "./render-queue.ts";
// The template's caption timing is the single source for burned-in captions
// and sidecar subtitles; it is plain TypeScript with no Remotion imports.
import { captionChunks, estimateSeconds, toSrt, toVtt } from "../../skills/remotion-video/assets/template/src/captions.ts";

const AGENT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const VIDEO_PATHS = {
  template: path.join(AGENT_ROOT, "skills/remotion-video/assets/template"),
  runner: path.join(AGENT_ROOT, "scripts/video-render.mjs"),
  synth: path.join(AGENT_ROOT, "skills/procedural-audio/scripts/synth.py"),
};
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const piperHome = () => path.join(agentDir(), "local-models", "piper");
const acquireRender = createRenderQueue(4);

/** Pinned local voices (rhasspy/piper-voices tag v1.0.0, MIT/CC-BY per voice card). */
export const PIPER_VOICES: Record<string, { files: Array<{ name: string; url: string; sha256: string; bytes: number }>; note: string }> = {
  "en_US-ryan-high": { note: "US English male, high quality (≈120 MB)", files: [
    { name: "en_US-ryan-high.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx", sha256: "b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca", bytes: 120786792 },
    { name: "en_US-ryan-high.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx.json", sha256: "c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011", bytes: 4166 },
  ] },
  "en_US-lessac-medium": { note: "US English female, medium quality (≈63 MB)", files: [
    { name: "en_US-lessac-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx", sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f", bytes: 63201294 },
    { name: "en_US-lessac-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json", sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0", bytes: 4885 },
  ] },
  "en_GB-alan-medium": { note: "British English male, medium quality (≈63 MB)", files: [
    { name: "en_GB-alan-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx", sha256: "0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330", bytes: 63201294 },
    { name: "en_GB-alan-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json", sha256: "c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e", bytes: 4888 },
  ] },
};
const PIPER_PACKAGE = "piper-tts==1.8.0";

// ───────────────────────────── pure helpers ─────────────────────────────

export type Issue = { severity: "error" | "warn" | "info"; scene?: string; message: string };
export type TimedScene = { id: string; component: string; seconds: number; start: number; end: number; narrationAudio?: string | null; narrationOffset?: number; narrationSeconds?: number | null; narration?: string | null; cues?: Record<string, number> };

const words = (text: unknown) => typeof text === "string" ? text.trim().split(/\s+/).filter(Boolean).length : 0;
const validSceneId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
/** Heuristic English syllable count. Perceived pace tracks syllables per
 * second (≈3.3-4.3 is comfortable narration), not words per minute. */
export function syllables(text: unknown): number {
  if (typeof text !== "string") return 0;
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).reduce((sum, word) => {
    const groups = word.replace(/'/g, "").replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
    return sum + Math.max(1, groups?.length ?? 0);
  }, 0);
}

/** Validate video.json against the template contract and derive scene times.
 * `components` are names registered in src/scenes/index.ts; `exists` checks
 * files under public/. Pure apart from those two injected facts. */
export function validateVideoSpec(spec: any, components: Set<string>, exists: (publicPath: string) => boolean): { issues: Issue[]; scenes: TimedScene[]; seconds: number } {
  const issues: Issue[] = [];
  const err = (message: string, scene?: string) => issues.push({ severity: "error", message, ...(scene ? { scene } : {}) });
  const warn = (message: string, scene?: string) => issues.push({ severity: "warn", message, ...(scene ? { scene } : {}) });
  if (!spec || typeof spec !== "object") return { issues: [{ severity: "error", message: "video.json is not an object" }], scenes: [], seconds: 0 };
  if (!Number.isInteger(spec.fps) || spec.fps < 1 || spec.fps > 60) err("fps must be an integer 1..60");
  for (const key of ["width", "height"]) if (!Number.isInteger(spec[key]) || spec[key] < 64 || spec[key] > 3840 || spec[key] % 2) err(`${key} must be an even integer 64..3840`);
  if (!Array.isArray(spec.scenes) || !spec.scenes.length) { err("scenes must be a non-empty array"); return { issues, scenes: [], seconds: 0 }; }
  const ids = new Set<string>();
  const scenes: TimedScene[] = [];
  let at = 0;
  for (const raw of spec.scenes) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!validSceneId(id)) { err(`scene id ${JSON.stringify(raw?.id)} must be lowercase kebab-case`); continue; }
    if (ids.has(id)) err("duplicate scene id", id);
    ids.add(id);
    const seconds = Number(raw.seconds);
    if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 600) { err("seconds must be 0.5..600", id); continue; }
    if (!components.has(raw.component)) err(`component "${raw.component}" is not registered in src/scenes/index.ts`, id);
    for (const [name, value] of Object.entries(raw.cues ?? {})) {
      if (typeof value !== "number" || value < 0 || value >= seconds) err(`cue "${name}" must be inside the scene (0..${seconds})`, id);
    }
    if (raw.transition !== undefined) {
      const kind = raw.transition?.type, length = raw.transition?.seconds ?? 0.5;
      if (!["fade", "slide", "wipe", "zoom", "blur", "none"].includes(kind)) err('transition.type must be fade, slide, wipe, zoom, blur or none', id);
      else if (typeof length !== "number" || length < 0.05 || length > Math.min(3, seconds / 2)) err(`transition.seconds must be 0.05..${Math.min(3, seconds / 2)}`, id);
    }
    const offset = raw.narrationOffset ?? 0;
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) { err("narrationOffset must be a non-negative number", id); continue; }
    if (raw.narrationAudio) {
      if (!exists(raw.narrationAudio)) err(`narration audio public/${raw.narrationAudio} is missing`, id);
      const spoken = Number(raw.narrationSeconds);
      if (!Number.isFinite(spoken) || spoken <= 0) warn("narrationSeconds is unknown; run narration_tts or record measured duration", id);
      else {
        if (offset + spoken > seconds - 0.25) err(`narration (${offset}s + ${spoken.toFixed(2)}s) overruns the scene (${seconds}s); lengthen the scene or tighten the line`, id);
        else if (seconds - offset - spoken > 3.5) warn(`${(seconds - offset - spoken).toFixed(1)}s of the scene has no narration; make sure the visuals carry that time`, id);
        const rate = syllables(raw.narration) / spoken;
        if (rate > 4.6) warn(`narration pace ${rate.toFixed(1)} syllables/s is hard to follow; aim for 3.3-4.3 (slower speed or shorter line)`, id);
      }
    } else if (words(raw.narration)) {
      const needed = syllables(raw.narration) / 3.8 + offset + 0.6;
      if (needed > seconds) warn(`narration text (~${needed.toFixed(1)}s at a comfortable pace) likely exceeds the ${seconds}s scene`, id);
    }
    // Match src/timeline.ts: Remotion rounds each scene to whole frames before
    // summing them. Rounding only the total drifts for fractional durations.
    const duration = Number.isInteger(spec.fps) && spec.fps > 0 ? Math.max(1, Math.round(seconds * spec.fps)) / spec.fps : seconds;
    scenes.push({ id, component: raw.component, seconds: duration, start: at, end: at + duration, narration: raw.narration ?? null, narrationAudio: raw.narrationAudio ?? null, narrationOffset: offset, narrationSeconds: raw.narrationSeconds ?? null, cues: raw.cues ?? {} });
    at += duration;
  }
  if (at > 1800) err(`total duration ${at.toFixed(1)}s exceeds 30 minutes`);
  if (spec.captions !== undefined) {
    const c = spec.captions;
    if (!c || typeof c !== "object" || typeof c.enabled !== "boolean") err("captions must be an object with enabled: true|false");
    else {
      if (c.style !== undefined && !["chunks", "karaoke"].includes(c.style)) err('captions.style must be "chunks" or "karaoke"');
      if (c.maxWords !== undefined && (!Number.isInteger(c.maxWords) || c.maxWords < 2 || c.maxWords > 14)) err("captions.maxWords must be an integer 2..14");
      if (c.position !== undefined && !["bottom", "top"].includes(c.position)) err('captions.position must be "bottom" or "top"');
    }
  }
  const audio = spec.audio ?? {};
  if (audio.music && !exists(audio.music)) err(`music public/${audio.music} is missing`);
  for (const sfx of audio.sfx ?? []) {
    if (!sfx?.src || !exists(sfx.src)) err(`sfx public/${sfx?.src} is missing`);
    if (typeof sfx?.at !== "number" || sfx.at < 0 || sfx.at >= at) err(`sfx ${sfx?.src} at ${sfx?.at}s is outside the timeline`);
  }
  return { issues, scenes, seconds: at };
}

/** Absolute-time caption chunks for every narrated scene, clipped to its
 * scene. Uses the template's caption timing so sidecars match the video. */
export function captionTrack(spec: any, scenes: TimedScene[]): Array<{ text: string; start: number; end: number }> {
  const maxWords = spec?.captions?.maxWords ?? 7;
  return scenes.flatMap((scene) => {
    const text = typeof scene.narration === "string" ? scene.narration.trim() : "";
    if (!text) return [];
    const spoken = Number(scene.narrationSeconds) > 0 ? Number(scene.narrationSeconds) : estimateSeconds(text);
    const origin = scene.start + (scene.narrationOffset ?? 0);
    return captionChunks(text, spoken, maxWords).map((chunk) => ({ text: chunk.text, start: origin + chunk.start, end: Math.min(scene.end, origin + chunk.end) })).filter((c) => c.end > c.start);
  });
}

/** Scene-relative seconds of a representative, fully built frame: after the
 * last cue has had time to settle, never earlier than 60% of the scene. */
export function settledSeconds(scene: Pick<TimedScene, "seconds" | "cues">): number {
  const lastCue = Math.max(0, ...Object.values(scene.cues ?? {}).filter((v) => typeof v === "number"));
  return Math.min(scene.seconds * 0.92, Math.max(scene.seconds * 0.6, lastCue + 1.5));
}

/** Representative stills: one per scene once its cues have settled, or
 * `count` spread across a single scene. Frames are absolute to `Main`. */
export function planStillFrames(scenes: TimedScene[], fps: number, options: { scene?: string; count?: number; times?: number[] } = {}): Array<{ frame: number; label: string }> {
  const total = Math.round((scenes.at(-1)?.end ?? 0) * fps);
  const clamp = (frame: number) => Math.max(0, Math.min(total - 1, Math.round(frame)));
  if (options.times?.length) return options.times.slice(0, 24).map((t) => ({ frame: clamp(t * fps), label: `${t.toFixed(2)}s` }));
  if (options.scene) {
    const scene = scenes.find((s) => s.id === options.scene);
    if (!scene) throw new Error(`Unknown scene ${options.scene}`);
    const count = Math.max(1, Math.min(12, options.count ?? 6));
    return Array.from({ length: count }, (_, i) => {
      const t = scene.start + (count === 1 ? settledSeconds(scene) : scene.seconds * (0.08 + 0.86 * i / (count - 1)));
      return { frame: clamp(t * fps), label: `${scene.id} ${t.toFixed(2)}s` };
    });
  }
  return scenes.slice(0, 24).map((scene) => {
    const t = scene.start + settledSeconds(scene);
    return { frame: clamp(t * fps), label: `${scene.id} ${t.toFixed(2)}s` };
  });
}

/** FFmpeg filter graph that labels and tiles N images into one sheet. */
export function contactSheetFilter(labels: string[]): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9 .:_-]/g, "").slice(0, 48);
  // Few frames get large cells: typography must stay judgeable in the sheet.
  const n = labels.length;
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const cellWidth = n <= 4 ? 960 : n <= 9 ? 640 : 480;
  const cellHeight = Math.round(cellWidth * 9 / 16 / 2) * 2;
  const parts = labels.map((label, i) => `[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=font=Sans:text='${safe(label)}':x=10:y=10:fontsize=${Math.round(cellWidth / 24)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6[c${i}]`);
  if (labels.length === 1) return `${parts[0]};[c0]copy[sheet]`;
  const layout = labels.map((_, i) => `${(i % cols) * cellWidth}_${Math.floor(i / cols) * cellHeight}`).join("|");
  return `${parts.join(";")};${labels.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${labels.length}:layout=${layout}:fill=black[sheet]`;
}

export type QaMetrics = {
  black: Array<{ start: number; end: number }>; freeze: Array<{ start: number; end: number }>; silence: Array<{ start: number; end: number }>;
  integratedLufs: number | null; loudnessRange: number | null; truePeak: number | null; momentary: Array<[number, number]>;
};
/** Parse one FFmpeg analysis pass (blackdetect, freezedetect, silencedetect,
 * ebur128 with per-100ms momentary loudness). Pure. */
export function parseQaLog(stderr: string, duration: number): QaMetrics {
  const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
  const pair = (startKey: string, endKey: string) => {
    const out: Array<{ start: number; end: number }> = [];
    let open: number | undefined;
    for (const m of stderr.matchAll(new RegExp(`(${startKey}|${endKey}):\\s*(-?[\\d.]+)`, "g"))) {
      if (m[1] === startKey) open = Number(m[2]);
      else if (open !== undefined) { out.push({ start: open, end: Number(m[2]) }); open = undefined; }
    }
    if (open !== undefined) out.push({ start: open, end: duration });
    return out;
  };
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const momentary = [...stderr.matchAll(/t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  return {
    black, freeze: pair("lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end"), silence: pair("silence_start", "silence_end"),
    integratedLufs: num(/I:\s*(-?[\d.]+) LUFS/.exec(summary)?.[1]), loudnessRange: num(/LRA:\s*([\d.]+) LU/.exec(summary)?.[1]),
    truePeak: num(/True peak:\s*[\s\S]*?Peak:\s*(-?[\d.]+) dBFS/.exec(summary)?.[1]), momentary,
  };
}

/** Turn measurements into review findings. Automated checks can only find
 * technical defects; visual and narrative quality need frame/playback review. */
export function qaFindings(metrics: QaMetrics, info: { duration: number; videoDuration?: number; audioDuration?: number; hasAudio: boolean; targetLufs: number }, scenes: TimedScene[] = []): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], message: string, scene?: string) => issues.push({ severity, message, ...(scene ? { scene } : {}) });
  const sceneAt = (t: number) => scenes.find((s) => t >= s.start && t < s.end)?.id;
  if (!info.hasAudio) add(scenes.some((s) => s.narrationAudio) ? "error" : "warn", "The render has no audio stream.");
  if (info.videoDuration !== undefined && info.audioDuration !== undefined && Math.abs(info.videoDuration - info.audioDuration) > 0.1) add("error", `Audio (${info.audioDuration.toFixed(2)}s) and video (${info.videoDuration.toFixed(2)}s) durations differ; check sync.`);
  for (const b of metrics.black) {
    // Video edges and sub-second scene entrances (content still building) are expected.
    const entrance = b.end - b.start < 1 && scenes.some((s) => Math.abs(s.start - b.start) < 0.1);
    const edge = b.start < 0.6 || b.end > info.duration - 0.6 || entrance;
    if (!edge) add("warn", `Frame is almost entirely background ${b.start.toFixed(2)}–${b.end.toFixed(2)}s (≥98% near-black pixels): an empty composition or unintended gap unless it is a deliberate beat.`, sceneAt(b.start));
  }
  // Short holds under narration are normal reading time; long ones stall.
  for (const f of metrics.freeze) if (f.end - f.start >= 4) add("warn", `Picture is static for ${(f.end - f.start).toFixed(1)}s (${f.start.toFixed(1)}–${f.end.toFixed(1)}s); give the hold a purpose or add motion that advances the idea.`, sceneAt(f.start));
  if (info.hasAudio) {
    for (const s of metrics.silence) if (s.start > 0.5 && s.end < info.duration - 0.5 && s.end - s.start >= 1.5) add("warn", `Audio is silent ${s.start.toFixed(1)}–${s.end.toFixed(1)}s; add room tone or music under visual-only beats.`, sceneAt(s.start));
    if (metrics.integratedLufs !== null && Math.abs(metrics.integratedLufs - info.targetLufs) > 2) add("warn", `Integrated loudness ${metrics.integratedLufs} LUFS is off target ${info.targetLufs} LUFS; adjust narration/music gain (or normalize the mix).`);
    if (metrics.truePeak !== null && metrics.truePeak > -1) add("error", `Peak ${metrics.truePeak} dBFS risks clipping after lossy encoding; keep peaks at or below -1 dBFS.`);
    if (metrics.loudnessRange !== null && metrics.loudnessRange > 15) add("warn", `Loudness range ${metrics.loudnessRange} LU is wide for online viewing; tame loud stingers or raise quiet narration.`);
    for (const scene of scenes) {
      if (!scene.narrationAudio || !scene.narrationSeconds) continue;
      const from = scene.start + (scene.narrationOffset ?? 0), to = from + scene.narrationSeconds;
      const window = metrics.momentary.filter(([t]) => t >= from + 0.4 && t <= to);
      if (!window.length) continue;
      const loudness = window.reduce((sum, [, m]) => sum + m, 0) / window.length;
      if (loudness < info.targetLufs - 12) add("error", `Narration is barely audible (mean momentary ${loudness.toFixed(1)} LUFS).`, scene.id);
    }
  }
  return issues;
}

// ───────────────────────────── process plumbing ─────────────────────────────

type Progress = (text: string) => void;
/** Spawn a (guarded) process, stream lines, enforce a deadline, kill the
 * whole process group on abort. Returns stdout/stderr tails. */
async function runGuarded(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number; guard?: boolean; env?: Record<string, string | undefined>; onLine?: (line: string) => void }) {
  options.signal?.throwIfAborted();
  const target = options.guard === false ? { command, args } : guardedCommand(command, args);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(target.command, target.args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } });
    let stdout = "", stderr = "", pending = "", settled = false;
    const tail = (text: string, add: string) => (text + add).slice(-200_000);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
    const timer = setTimeout(() => { kill(); finish(new Error(`${path.basename(command)} exceeded ${Math.round(options.timeoutMs / 1000)}s`)); }, options.timeoutMs);
    timer.unref?.();
    const abort = () => { kill(); finish(new Error("Video operation cancelled")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ stdout, stderr });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = tail(stdout, text);
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = tail(stderr, chunk.toString("utf8")); });
    child.on("error", (error: any) => finish(error.code === "ENOENT" ? new Error(`${command} is not installed`) : error));
    child.on("close", (code) => {
      if (pending) options.onLine?.(pending);
      if (code === 0) finish();
      else finish(new Error(`${path.basename(command)} exited with ${code}: ${(stderr || stdout).slice(-3000)}`));
    });
  });
}

function throttled(progress: Progress | undefined, ms = 2500): Progress {
  let last = 0;
  return (text) => { const now = Date.now(); if (progress && now - last >= ms) { last = now; progress(text); } };
}

// ───────────────────────────── project helpers ─────────────────────────────

async function projectDir(value: unknown, cwd: string, mustExist = true): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("dir must be a local project directory");
  const root = await fs.realpath(cwd);
  const dir = canonicalMutationPath(value, root);
  const denial = selfMutationDenial(path.join(dir, "video.json"), root);
  if (denial) throw new Error(denial);
  if (mustExist && !existsSync(path.join(dir, "video.json"))) throw new Error(`${dir} is not a video project (no video.json); create one with video_project action:"init"`);
  return dir;
}

async function readSpec(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, "video.json"), "utf8"));
}

/** Project-owned output paths must remain inside the physical project, even
 * when an output directory or existing output file is a symbolic link. */
function projectWritePath(dir: string, ...parts: string[]): string {
  const target = canonicalMutationPath(path.join(dir, ...parts));
  if (!containsPath(dir, target)) throw new Error(`Video output must stay inside the project: ${parts.join("/")}`);
  const denial = selfMutationDenial(target, dir);
  if (denial) throw new Error(denial);
  return target;
}
async function registeredComponents(dir: string): Promise<Set<string>> {
  const source = await fs.readFile(path.join(dir, "src/scenes/index.ts"), "utf8").catch(() => "");
  const block = /scenes\s*:[^=]*=\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
  return new Set([...block.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
}
async function inspectProject(dir: string) {
  const spec = await readSpec(dir);
  const components = await registeredComponents(dir);
  const result = validateVideoSpec(spec, components, (p) => typeof p === "string" && !p.includes("..") && existsSync(path.join(dir, "public", p)));
  return { spec, components, ...result };
}

function browserExecutable(): string | undefined {
  if (process.env.YUNUSPI_VIDEO_BROWSER && existsSync(process.env.YUNUSPI_VIDEO_BROWSER)) return process.env.YUNUSPI_VIDEO_BROWSER;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const shells = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const shell of shells) {
      for (const sub of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const candidate = path.join(cache, shell, sub);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* no Playwright cache */ }
  return undefined;
}

async function npmInstall(dir: string, signal: AbortSignal | undefined, progress?: Progress) {
  const args = ["install", "--no-audit", "--no-fund", "--ignore-scripts"];
  progress?.("Installing pinned Remotion dependencies (first install downloads ≈250 MB; later installs use the npm cache)…");
  try {
    await runGuarded("npm", [...args, "--prefer-offline"], { cwd: dir, signal, timeoutMs: 900_000 });
  } catch (error: any) {
    // A stale cached registry document can reject a version that exists.
    if (!/ETARGET|notarget|No matching version/i.test(String(error?.message))) throw error;
    await runGuarded("npm", args, { cwd: dir, signal, timeoutMs: 900_000 });
  }
}

// ───────────────────────────── tool operations ─────────────────────────────

export async function videoProject(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const action = params.action ?? "check";
  if (action === "init") {
    const dir = await projectDir(params.dir, cwd, false);
    if (existsSync(dir)) throw new Error(`${dir} already exists; choose a new project directory`);
    if (!containsPath(await fs.realpath(cwd), dir)) throw new Error("Create video projects inside the current workspace");
    await fs.cp(VIDEO_PATHS.template, dir, { recursive: true, errorOnExist: true });
    const spec = await readSpec(dir);
    spec.title = typeof params.title === "string" && params.title.trim() ? params.title.trim().slice(0, 120) : spec.title;
    for (const key of ["fps", "width", "height"]) if (params[key] !== undefined) spec[key] = params[key];
    await fs.writeFile(path.join(dir, "video.json"), JSON.stringify(spec, null, 2) + "\n");
    if (params.install !== false) await npmInstall(dir, signal, progress);
    return {
      project: dir, installed: params.install !== false,
      files: ["video.json (master timeline: scenes, narration, cues, transitions, captions, audio)", "src/scenes/*.tsx + index.ts (scene registry)", "src/primitives/* (Stage, Heading, KineticText, TokenRow, NeuralNet, Matrix, Graph, BarChart, TimelineAxis, CodeBlock, ParticleField, Backdrop, Captions, AudioSpectrum, FilmGrain, LightLeak, CameraMove, Glitch)", "src/motion.ts, src/theme.tsx, src/timeline.ts, src/captions.ts", "public/audio/ (narration, music, sfx)"],
      next: ["Write storyboard.md (beats, visual metaphor per beat, on-screen text ≤ 8 words) before coding", "Replace video.json scenes; build scene components from primitives", "video_project check → video_render stills → inspect the contact sheet → fix → repeat", "narration_tts synthesize → audio_synth music/sfx → video_render preview → video_render final → video_qa"],
      note: "The two template scenes are mechanical examples; replace them with components designed for this video.",
    };
  }
  const dir = await projectDir(params.dir, cwd);
  if (action === "install") { await npmInstall(dir, signal, progress); return { project: dir, installed: true }; }
  if (action !== "check") throw new Error("action must be init, check or install");
  const { spec, issues, scenes, seconds, components } = await inspectProject(dir);
  return {
    project: dir, title: spec.title, fps: spec.fps, size: `${spec.width}x${spec.height}`, seconds: Number(seconds.toFixed(2)),
    installed: existsSync(path.join(dir, "node_modules/@remotion/renderer")),
    components: [...components],
    scenes: scenes.map((s) => ({ id: s.id, component: s.component, start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), narration: s.narrationAudio ? `${s.narrationSeconds ?? "?"}s audio` : s.narration ? "text only" : "none" })),
    issues, ok: !issues.some((i) => i.severity === "error"),
  };
}

async function contactSheet(images: Array<{ path: string; label: string }>, output: string, signal?: AbortSignal) {
  const args = [...FFMPEG_FLAGS, "-loglevel", "error"];
  for (const image of images) args.push("-i", image.path);
  args.push("-filter_complex", contactSheetFilter(images.map((i) => i.label)), "-map", "[sheet]", "-frames:v", "1", "-update", "1", output);
  await run("ffmpeg", args, signal, 60_000);
  return (await produced(output)).path;
}

async function freshOut(dir: string, kind: string) {
  const out = projectWritePath(dir, "out", `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  await fs.mkdir(out, { recursive: true });
  return out;
}

export async function videoRender(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const dir = await projectDir(params.dir, cwd);
  if (!existsSync(path.join(dir, "node_modules/@remotion/renderer"))) throw new Error('Project dependencies are not installed; run video_project action:"install"');
  const { spec, issues, scenes } = await inspectProject(dir);
  const blocking = issues.filter((i) => i.severity === "error");
  const mode = params.mode ?? "stills";
  if (blocking.length && mode !== "stills") throw new Error(`Fix timeline errors first: ${blocking.map((i) => `${i.scene ? `[${i.scene}] ` : ""}${i.message}`).join("; ")}`);
  const release = await acquireRender(signal);
  const report = throttled(progress);
  try {
    const out = await freshOut(dir, mode);
    const request: any = { project: dir, outDir: out, mode, composition: "Main", browserExecutable: browserExecutable() };
    if (mode === "stills") {
      const plan = planStillFrames(scenes, spec.fps, { scene: params.scene, count: params.count, times: params.times });
      request.frames = plan.map((p) => p.frame);
      const result = await runRenderer(dir, request, signal, report, 600_000);
      const stills = result.stills.map((s: any, i: number) => ({ ...s, label: plan[i].label }));
      const sheet = await contactSheet(stills.map((s: any) => ({ path: s.path, label: s.label })), path.join(out, "contact-sheet.png"), signal);
      return { mode, contactSheet: sheet, stills, bundleCached: result.bundleCached, timelineIssues: issues,
        review: "Open contact-sheet.png (and full-size stills where detail matters) with the read tool and judge it: hierarchy, clipping, text size/density, spacing rhythm, contrast, empty or overcrowded composition, consistency with neighbouring scenes. A successful render is not visual approval." };
    }
    if (mode === "preview" || mode === "final") {
      const fps = spec.fps;
      const total = Math.round(scenes.at(-1)!.end * fps);
      if (params.scene) {
        const scene = scenes.find((s) => s.id === params.scene);
        if (!scene) throw new Error(`Unknown scene ${params.scene}`);
        request.range = [Math.round(scene.start * fps), Math.min(total - 1, Math.round(scene.end * fps) - 1)];
      } else if (params.from !== undefined || params.to !== undefined) {
        const from = Math.max(0, Math.round((params.from ?? 0) * fps)), to = Math.min(total - 1, Math.round((params.to ?? total / fps) * fps) - 1);
        if (to <= from) throw new Error("to must be after from");
        request.range = [from, to];
      }
      request.scale = mode === "preview" ? (params.scale ?? 0.5) : (params.scale ?? 1);
      request.crf = params.crf;
      const frames = request.range ? request.range[1] - request.range[0] + 1 : total;
      const timeoutMs = Math.min(3_600_000, 120_000 + frames * (mode === "final" ? 600 : 250));
      const result = await runRenderer(dir, request, signal, report, timeoutMs);
      const info = await probe(result.output, signal);
      await run("ffmpeg", [...FFMPEG_FLAGS, "-v", "error", "-xerror", ...inputArgs(result.output, 0), "-f", "null", "-"], signal, timeoutMs);
      // Sidecar subtitles use the same timing as the burned-in captions.
      let captions: any;
      if (mode === "final") {
        const from = (request.range?.[0] ?? 0) / fps, to = ((request.range?.[1] ?? total - 1) + 1) / fps;
        const track = captionTrack(spec, scenes).filter((c) => c.end > from && c.start < to).map((c) => ({ ...c, start: Math.max(0, c.start - from), end: Math.min(to, c.end) - from }));
        if (track.length) {
          await fs.writeFile(path.join(out, "captions.srt"), toSrt(track), { flag: "wx" });
          await fs.writeFile(path.join(out, "captions.vtt"), toVtt(track), { flag: "wx" });
          captions = { srt: path.join(out, "captions.srt"), vtt: path.join(out, "captions.vtt"), cues: track.length, timing: "estimated from narration length and syllables, not speech-aligned" };
        }
      }
      return { mode, output: result.output, ...(captions ? { captions } : {}), frameRange: request.range ?? [0, total - 1], seconds: Number(info.format?.duration), size: `${info.streams?.find((s: any) => s.codec_type === "video")?.width}x${info.streams?.find((s: any) => s.codec_type === "video")?.height}`, hasAudio: info.streams?.some((s: any) => s.codec_type === "audio") ?? false, renderMs: result.renderMs, decodeVerified: true,
        review: mode === "final" ? "Run video_qa on this file, then inspect its contact sheet and listen-check narration timing before delivery." : "Watch the motion: extract frames around transitions with video_frames, or check timing against cues in video.json. Stills cannot show pacing, easing or transitions." };
    }
    throw new Error("mode must be stills, preview or final");
  } finally { release(); }
}

async function runRenderer(dir: string, request: any, signal: AbortSignal | undefined, report: Progress, timeoutMs: number) {
  projectWritePath(dir, ".video-cache");
  const requestPath = path.join(request.outDir, "render-request.json");
  await fs.writeFile(requestPath, JSON.stringify(request));
  let result: any;
  await runGuarded(process.execPath, [VIDEO_PATHS.runner, requestPath], {
    cwd: dir, signal, timeoutMs,
    onLine: (line) => {
      if (line.startsWith("VIDEO_RENDER_RESULT ")) result = JSON.parse(line.slice(20));
      else if (line.startsWith("VIDEO_RENDER_PROGRESS ")) {
        const p = JSON.parse(line.slice(22));
        report(p.stage === "render" ? `Rendering ${p.percent}% (${p.renderedFrames} frames)` : p.stage === "bundle" ? `Bundling ${p.percent}%` : `Stills ${p.done}/${p.total}`);
      }
    },
  }).catch((error) => { if (result?.error) throw new Error(`Render failed: ${result.error}`); throw error; });
  if (!result || result.error) throw new Error(`Render failed: ${result?.error ?? "no result"}`);
  return result;
}

export async function videoQa(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const file = await inputFile(params.path, cwd);
  const info = await probe(file, signal);
  const video = info.streams?.find((s: any) => s.codec_type === "video");
  if (!video) throw new Error("Input has no video stream");
  const audio = info.streams?.find((s: any) => s.codec_type === "audio");
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unknown video duration");
  const targetLufs = typeof params.targetLufs === "number" ? params.targetLufs : -16;
  let scenes: TimedScene[] = [];
  let timelineIssues: Issue[] = [];
  if (params.dir) { const project = await inspectProject(await projectDir(params.dir, cwd)); scenes = project.scenes; timelineIssues = project.issues; }
  progress?.("Analyzing picture and sound (black/freeze detection, silence, EBU R128 loudness)…");
  const analysis = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, 0), "-map", "0:v:0", "-vf", "blackdetect=d=0.25:pix_th=0.08,freezedetect=n=0.002:d=1.5",
    ...(audio ? ["-map", "0:a:0", "-af", "silencedetect=noise=-50dB:d=1.2,ebur128=peak=true:framelog=info"] : []),
    "-f", "null", "-"], signal, Math.round(Math.min(3_600_000, 60_000 + duration * 4000)));
  const metrics = parseQaLog(`${analysis.stdout}\n${analysis.stderr}`, duration);
  const findings = [...timelineIssues.filter((i) => i.severity !== "info"), ...qaFindings(metrics, {
    duration, hasAudio: Boolean(audio), targetLufs,
    videoDuration: Number(video.duration ?? duration), ...(audio ? { audioDuration: Number(audio.duration ?? duration) } : {}),
  }, scenes)];
  const times = scenes.length
    ? scenes.slice(0, 24).map((s) => ({ t: s.start + settledSeconds(s), label: `${s.id} ${(s.start + settledSeconds(s)).toFixed(1)}s` }))
    : Array.from({ length: 12 }, (_, i) => { const t = duration * (i + 0.5) / 12; return { t, label: `${t.toFixed(1)}s` }; });
  const out = path.join(path.dirname(file), `qa-${path.basename(file, path.extname(file))}-${randomBytes(3).toString("hex")}`);
  const denial = selfMutationDenial(out, await fs.realpath(cwd));
  if (denial) throw new Error(denial);
  await fs.mkdir(out, { recursive: true });
  const frames: Array<{ path: string; label: string }> = [];
  for (const [i, { t, label }] of times.entries()) {
    const framePath = path.join(out, `frame-${String(i + 1).padStart(2, "0")}.png`);
    await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", ...inputArgs(file, Math.min(t, duration - 0.05)), "-frames:v", "1", "-update", "1", framePath], signal, 30_000);
    frames.push({ path: framePath, label });
  }
  const sheet = await contactSheet(frames, path.join(out, "contact-sheet.png"), signal);
  const report = {
    path: file, seconds: Number(duration.toFixed(3)), size: `${video.width}x${video.height}`, fps: video.avg_frame_rate, hasAudio: Boolean(audio),
    loudness: { integratedLufs: metrics.integratedLufs, loudnessRangeLu: metrics.loudnessRange, peakDbfs: metrics.truePeak, targetLufs },
    black: metrics.black, freeze: metrics.freeze, silence: metrics.silence,
    findings, passedAutomatedChecks: !findings.some((f) => f.severity === "error"),
    contactSheet: sheet,
    review: "Automated checks find technical defects only. Now open the contact sheet with the read tool and review every frame against the storyboard (hierarchy, legibility, clipping, density, consistency, meaning), then spot-check transitions with video_frames and confirm narration lines land on their visual cues.",
  };
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

// ───────────────────────────── narration (Piper) ─────────────────────────────

const piperPython = () => path.join(piperHome(), "venv", "bin", "python");
function voiceFiles(voice: string) {
  const entry = PIPER_VOICES[voice];
  if (!entry) throw new Error(`Unknown voice ${voice}; choose ${Object.keys(PIPER_VOICES).join(", ")}`);
  return entry.files.map((file) => ({ ...file, path: path.join(piperHome(), "voices", file.name) }));
}
async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of (await fs.open(file)).createReadStream()) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function download(url: string, dest: string, expected: string, signal?: AbortSignal) {
  const partial = `${dest}.part-${randomBytes(4).toString("hex")}`;
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const sink = createWriteStream(partial, { mode: 0o600 });
  try {
    for await (const chunk of response.body as any) if (!sink.write(chunk)) await new Promise((r) => sink.once("drain", r));
    await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => error ? reject(error) : resolve()));
    const actual = await sha256(partial);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${path.basename(dest)} (got ${actual})`);
    await fs.rename(partial, dest);
  } finally { await fs.rm(partial, { force: true }); }
}

async function piperStatus() {
  const installed = existsSync(piperPython());
  const voices = Object.fromEntries(Object.entries(PIPER_VOICES).map(([name, v]) => [name, { installed: voiceFiles(name).every((f) => existsSync(f.path)), note: v.note }]));
  return { engine: "piper", package: PIPER_PACKAGE, installed, home: piperHome(), voices };
}

export async function narrationTts(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const action = params.action ?? "status";
  const voice = params.voice ?? "en_US-ryan-high";
  if (action === "status") return piperStatus();
  if (action === "install") {
    await fs.mkdir(path.join(piperHome(), "voices"), { recursive: true, mode: 0o700 });
    if (!existsSync(piperPython())) {
      progress?.("Creating the Piper virtual environment…");
      await runGuarded("python3", ["-m", "venv", path.join(piperHome(), "venv")], { cwd: piperHome(), signal, timeoutMs: 120_000, guard: false });
      progress?.(`Installing ${PIPER_PACKAGE} (binary wheels only)…`);
      // Wheels only: no package build scripts run during installation.
      await runGuarded(piperPython(), ["-m", "pip", "install", "--quiet", "--only-binary=:all:", PIPER_PACKAGE], { cwd: piperHome(), signal, timeoutMs: 600_000, guard: false });
    }
    for (const file of voiceFiles(voice)) {
      if (existsSync(file.path) && await sha256(file.path) === file.sha256) continue;
      progress?.(`Downloading voice ${file.name} (${Math.round(file.bytes / 1e6)} MB, checksum-pinned)…`);
      await download(file.url, file.path, file.sha256, signal);
    }
    return { ...(await piperStatus()), installedVoice: voice };
  }
  if (action !== "synthesize") throw new Error("action must be status, install or synthesize");
  const dir = await projectDir(params.dir, cwd);
  const spec = await readSpec(dir);
  const only = Array.isArray(params.scenes) ? new Set(params.scenes) : undefined;
  if (!Array.isArray(spec.scenes)) throw new Error("scenes must be an array");
  const selected = spec.scenes.filter((scene: any) => !only || only.has(scene?.id));
  const ids = new Set<string>();
  for (const scene of selected) {
    if (!validSceneId(scene?.id)) throw new Error(`scene id ${JSON.stringify(scene?.id)} must be lowercase kebab-case`);
    if (ids.has(scene.id)) throw new Error(`duplicate scene id ${scene.id}`);
    ids.add(scene.id);
    if (scene.narrationOffset !== undefined && (typeof scene.narrationOffset !== "number" || !Number.isFinite(scene.narrationOffset) || scene.narrationOffset < 0)) throw new Error(`narrationOffset for ${scene.id} must be a non-negative number`);
  }
  const specPath = projectWritePath(dir, "video.json");
  const outDir = projectWritePath(dir, "public", "audio", "narration");
  if (!existsSync(piperPython()) || !voiceFiles(voice).every((f) => existsSync(f.path))) throw new Error(`Piper voice ${voice} is not installed; run narration_tts action:"install" voice:"${voice}" (downloads a pinned local model once)`);
  // Piper voices default to ~200+ wpm. speed 1 is calibrated to a documentary
  // pace (~150-170 wpm); lower is slower. Sentence pauses stay fixed.
  const lengthScale = 1.2 / (typeof params.speed === "number" ? Math.min(1.5, Math.max(0.6, params.speed)) : 1);
  await fs.mkdir(outDir, { recursive: true });
  const results: any[] = [];
  for (const scene of selected) {
    const text = typeof scene.narration === "string" ? scene.narration.trim() : "";
    if (!text) continue;
    progress?.(`Narrating ${scene.id}…`);
    const textPath = projectWritePath(dir, "public", "audio", "narration", `.${scene.id}.txt`);
    const wav = projectWritePath(dir, "public", "audio", "narration", `${scene.id}.wav`);
    await fs.writeFile(textPath, text + "\n");
    try {
      await runGuarded(piperPython(), ["-m", "piper", "-m", voiceFiles(voice)[0].path, "-f", wav, "--length-scale", String(lengthScale), "--sentence-silence", "0.45", "-i", textPath], { cwd: dir, signal, timeoutMs: 300_000 });
    } finally { await fs.rm(textPath, { force: true }); }
    const seconds = Number((await probe(wav, signal)).format?.duration);
    const sentences = await sentenceOnsets(wav, text, signal);
    scene.narrationSeconds = Number(seconds.toFixed(3));
    const offset = scene.narrationOffset ?? 0.4;
    scene.narrationOffset = offset;
    scene.narrationAudio = `audio/narration/${scene.id}.wav`;
    const needed = Number((offset + seconds + (params.tailSeconds ?? 0.8)).toFixed(2));
    let adjusted: number | undefined;
    if (params.fitScenes === true && needed > scene.seconds) { adjusted = needed; scene.seconds = needed; }
    results.push({ scene: scene.id, audio: scene.narrationAudio, seconds: scene.narrationSeconds,
      sentences: sentences.map((sentence) => ({ ...sentence, at: Number((sentence.at + offset).toFixed(2)) })), words: words(text), syllablesPerSecond: Number((syllables(text) / seconds).toFixed(2)), sceneSeconds: scene.seconds, ...(adjusted ? { lengthenedTo: adjusted } : needed > scene.seconds ? { overrun: Number((needed - scene.seconds).toFixed(2)) } : {}) });
  }
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + "\n");
  return { voice, narrated: results, note: "Durations are measured from the synthesized audio and written to video.json. Cues are scene-relative seconds: re-time cues to the narration's key words, then render stills/previews again. Listen-check pronunciation of names and acronyms (spell them phonetically in the narration text if needed)." };
}

/** Scene-relative start of each sentence, from the fixed pauses Piper inserts
 * between sentences. Falls back to evenly scaled estimates when the pause
 * count does not match the sentence count. */
async function sentenceOnsets(wav: string, text: string, signal?: AbortSignal): Promise<Array<{ text: string; at: number }>> {
  const sentences = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(wav, 0), "-af", "silencedetect=noise=-40dB:d=0.3", "-f", "null", "-"], signal, 60_000);
  const ends = [...r.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const onsets = [0, ...ends].slice(0, sentences.length);
  if (onsets.length === sentences.length) return sentences.map((sentence, i) => ({ text: sentence, at: onsets[i] }));
  const total = sentences.reduce((sum, sentence) => sum + syllables(sentence), 0) || 1;
  const duration = Number((await probe(wav, signal)).format?.duration) || 0;
  let at = 0;
  return sentences.map((sentence) => { const start = at; at += duration * syllables(sentence) / total; return { text: sentence, at: Number(start.toFixed(2)), estimated: true } as any; });
}

// ───────────────────────────── procedural audio ─────────────────────────────

export async function audioSynth(params: any, cwd: string, signal?: AbortSignal) {
  const dir = await projectDir(params.dir, cwd);
  const name = typeof params.name === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(params.name) ? params.name : params.kind === "music" ? "music" : `sfx-${params.type}`;
  const spec: any = { kind: params.kind, seed: params.seed ?? 7 };
  if (params.kind === "music") {
    const { seconds } = await inspectProject(dir);
    Object.assign(spec, { seconds: params.seconds ?? Math.ceil(seconds + 1), bpm: params.bpm, key: params.key, mode: params.mode, progression: params.progression, barsPerChord: params.barsPerChord, layers: params.layers, intensity: params.intensity });
  } else if (params.kind === "sfx") Object.assign(spec, { type: params.type, seconds: params.seconds, pitch: params.pitch });
  else throw new Error("kind must be music or sfx");
  for (const key of Object.keys(spec)) if (spec[key] === undefined) delete spec[key];
  const outDir = projectWritePath(dir, "public", "audio");
  await fs.mkdir(outDir, { recursive: true });
  const specPath = projectWritePath(dir, "public", "audio", `.${name}.json`);
  const output = projectWritePath(dir, "public", "audio", `${name}.wav`);
  await fs.writeFile(specPath, JSON.stringify(spec));
  try {
    const result = await runGuarded("python3", ["-I", VIDEO_PATHS.synth, specPath, output], { cwd: dir, signal, timeoutMs: 300_000 });
    const stats = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    return { ...stats, output, publicPath: `audio/${name}.wav`, spec,
      next: params.kind === "music" ? 'Set video.json audio.music to publicPath. Music ducks automatically under narration windows; check balance with video_qa.' : 'Add {"src": publicPath, "at": seconds} to video.json audio.sfx at the visual event it punctuates. Use sound sparingly: one accent per idea, not per animation.' };
  } finally { await fs.rm(specPath, { force: true }); }
}
