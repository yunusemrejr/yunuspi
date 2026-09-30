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
import { masterMedia } from "./audio-studio.ts";
import { canonicalMutationPath, containsPath, guardedCommand, selfMutationDenial } from "./self-mutation-guard.ts";
import { createRenderQueue } from "./render-queue.ts";
import { memoryBudgetMb, watchMemory } from "./memory-guard.ts";
import { ownProcessGroup } from "./process-owner.ts";
import { DEFAULT_LOOK, LOOKS, fontDependencies, fontsSource, lintDesign, lookById, suggestLook } from "./video-looks.ts";
import { chapterList, descriptionDraft, formatChapters, isPublishing, planCtas, publishFindings, validatePublishSpec } from "./video-publish.ts";
// The template's caption timing is the single source for burned-in captions
// and sidecar subtitles; it is plain TypeScript with no Remotion imports.
import { captionChunks, captionPace, estimateSeconds, toSrt, toVtt } from "../../skills/remotion-video/assets/template/src/captions.ts";

const AGENT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const VIDEO_PATHS = {
  template: path.join(AGENT_ROOT, "skills/remotion-video/assets/template"),
  runner: path.join(AGENT_ROOT, "scripts/video-render.mjs"),
  optional: path.join(AGENT_ROOT, "skills/remotion-video/assets/optional"),
  synth: path.join(AGENT_ROOT, "skills/procedural-audio/scripts/synth.py"),
  narrate: path.join(AGENT_ROOT, "skills/code-first-video/scripts/narrate.py"),
};
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const piperHome = () => path.join(agentDir(), "local-models", "piper");
const acquireRender = createRenderQueue(4);
/** Render workers for one project: half the cores (Remotion's own rule), but never more Chrome tabs than the
 * memory budget holds. A worker costs roughly 300 MB plus 200 MB per output megapixel (software GL), so 4K
 * renders run fewer in parallel instead of exhausting RAM. YUNUSPI_VIDEO_CONCURRENCY overrides. */
export const renderConcurrency = (width = 1920, height = 1080, scale = 1, budgetMb = memoryBudgetMb()) => {
  const override = Number(process.env.YUNUSPI_VIDEO_CONCURRENCY);
  if (Number.isInteger(override) && override > 0) return override;
  const workerMb = 300 + 200 * ((width * scale) * (height * scale)) / 1e6;
  const byMemory = Math.floor((budgetMb - 1500) / workerMb);
  return Math.max(1, Math.min(Math.max(2, Math.floor(os.availableParallelism() / 2)), byMemory));
};

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
  "en_US-amy-medium": { note: "US English female, medium quality (≈63 MB)", files: [
    { name: "en_US-amy-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx", sha256: "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18", bytes: 63201294 },
    { name: "en_US-amy-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/en_US-amy-medium.onnx.json", sha256: "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77", bytes: 4882 },
  ] },
  "en_US-lessac-high": { note: "US English female, high quality (≈114 MB)", files: [
    { name: "en_US-lessac-high.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/high/en_US-lessac-high.onnx", sha256: "4cabf7c3a638017137f34a1516522032d4fe3f38228a843cc9b764ddcbcd9e09", bytes: 113895201 },
    { name: "en_US-lessac-high.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/high/en_US-lessac-high.onnx.json", sha256: "db42b97d9859f257bc1561b8ed980e7fb2398402050a74ddd6cbec931a92412f", bytes: 4883 },
  ] },
  "en_GB-jenny_dioco-medium": { note: "British English female, medium quality (≈63 MB)", files: [
    { name: "en_GB-jenny_dioco-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx", sha256: "469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01", bytes: 63201294 },
    { name: "en_GB-jenny_dioco-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx.json", sha256: "a9a7a93a317c9a3cb6563e37eb057df9ef09c06188a8a4341b0fcb58cba54dd4", bytes: 4895 },
  ] },
  "en_GB-northern_english_male-medium": { note: "Northern English male, medium quality (≈63 MB)", files: [
    { name: "en_GB-northern_english_male-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx", sha256: "57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689", bytes: 63201294 },
    { name: "en_GB-northern_english_male-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json", sha256: "69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47", bytes: 4847 },
  ] },
  "en_GB-alan-medium": { note: "British English male, medium quality (≈63 MB)", files: [
    { name: "en_GB-alan-medium.onnx", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx", sha256: "0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330", bytes: 63201294 },
    { name: "en_GB-alan-medium.onnx.json", url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json", sha256: "c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e", bytes: 4888 },
  ] },
};
/** Alignments need the onnx wheel; both install as binary wheels only. */
const PIPER_PACKAGES = ["piper-tts==1.8.0", "onnx==1.23.0"];
/** Pace and variability per delivery style (Piper length/noise scales). */
export const VOICE_STYLES: Record<string, { length: number; noise: number; noiseW: number; sentence: number; paragraph: number }> = {
  documentary: { length: 1.36, noise: 0.667, noiseW: 0.8, sentence: 0.42, paragraph: 0.85 },
  calm: { length: 1.5, noise: 0.6, noiseW: 0.7, sentence: 0.5, paragraph: 1.0 },
  energetic: { length: 1.18, noise: 0.75, noiseW: 0.9, sentence: 0.3, paragraph: 0.6 },
  intimate: { length: 1.42, noise: 0.55, noiseW: 0.6, sentence: 0.46, paragraph: 0.9 },
};
/** Integrated loudness each narrated scene is set to before mixing. */
const NARRATION_LUFS = -18;

// ───────────────────────────── pure helpers ─────────────────────────────

export type Issue = { severity: "error" | "warn" | "info"; scene?: string; message: string };
export type TimedScene = { id: string; component: string; seconds: number; start: number; end: number; narrationAudio?: string | null; narrationOffset?: number; narrationSeconds?: number | null; narration?: string | null; narrationWords?: Array<{ w: string; s: number; e: number }>; cues?: Record<string, number>; cueWords?: Record<string, string>; chapter?: string; energy?: number; transition?: { type: string; seconds?: number } };

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
  const object = (value: any) => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!object(spec)) return { issues: [{ severity: "error", message: "video.json is not an object" }], scenes: [], seconds: 0 };
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
    if (raw.cues !== undefined && !object(raw.cues)) err("cues must be an object of scene-relative seconds", id);
    for (const [name, value] of Object.entries(object(raw.cues) ? raw.cues : {})) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= seconds) err(`cue "${name}" must be inside the scene (0..${seconds})`, id);
    }
    if (raw.energy !== undefined && (typeof raw.energy !== "number" || !Number.isFinite(raw.energy) || raw.energy < 0 || raw.energy > 1)) err("energy must be a number 0..1", id);
    if (raw.chapter !== undefined && (typeof raw.chapter !== "string" || !raw.chapter.trim() || raw.chapter.length > 60)) err("chapter must be a title of at most 60 characters", id);
    if (raw.cueWords !== undefined) {
      if (!object(raw.cueWords)) err("cueWords must be an object of spoken words", id);
      const tokens = typeof raw.narration === "string" ? raw.narration.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [] : [];
      for (const [name, word] of Object.entries(object(raw.cueWords) ? raw.cueWords : {})) {
        if (typeof word !== "string" || !word.trim()) { err(`cueWords.${name} must name a spoken word`, id); continue; }
        if (!(name in (object(raw.cues) ? raw.cues : {}))) err(`cueWords.${name} needs a placeholder cue of the same name in cues (narration_tts overwrites it with the time of the word; scenes read cues before narration exists)`, id);
        const [text] = word.toLowerCase().split("#");
        if (tokens.length && !tokens.includes(text.replace(/[^\p{L}\p{N}']/gu, ""))) err(`cueWords.${name} = "${word}" does not occur in the narration`, id);
      }
    }
    if (raw.narrationWords !== undefined && !Array.isArray(raw.narrationWords)) err("narrationWords must be an array of measured words", id);
    if (Array.isArray(raw.narrationWords) && typeof raw.narration === "string") {
      const spoken = raw.narration.trim().split(/\s+/);
      if (raw.narrationWords.length !== spoken.length || raw.narrationWords.some((entry: any, i: number) => entry?.w !== spoken[i])) warn("narrationWords no longer match the narration text; re-run narration_tts for this scene so captions and cues use measured timing", id);
      if (raw.narrationWords.some((entry: any, i: number, entries: any[]) => !entry || typeof entry.s !== "number" || typeof entry.e !== "number" || !Number.isFinite(entry.s) || !Number.isFinite(entry.e) || entry.s < 0 || entry.e <= entry.s || (i > 0 && entry.s < entries[i - 1]?.e) || (Number(raw.narrationSeconds) > 0 && entry.e > Number(raw.narrationSeconds) + 0.05))) err("narrationWords timings must be finite, ordered and inside the measured narration", id);
    }
    if (raw.transition !== undefined) {
      const kind = raw.transition?.type, length = raw.transition?.seconds ?? 0.5;
      if (!["fade", "slide", "slideup", "slidedown", "wipe", "zoom", "blur", "none"].includes(kind)) err('transition.type must be fade, slide, slideup, slidedown, wipe, zoom, blur or none', id);
      else if (typeof length !== "number" || !Number.isFinite(length) || length < 0.05 || length > Math.min(3, seconds / 2)) err(`transition.seconds must be 0.05..${Math.min(3, seconds / 2)}`, id);
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
        const pace = typeof raw.narration === "string" ? captionPace(raw.narration, spoken) : null;
        if (pace !== null && pace > 24) warn(`caption text runs at ${pace} characters/s; viewers read ~17-20 (shorten the line or lengthen the scene)`, id);
      }
    } else if (words(raw.narration)) {
      const needed = syllables(raw.narration) / 3.8 + offset + 0.6;
      if (needed > seconds) warn(`narration text (~${needed.toFixed(1)}s at a comfortable pace) likely exceeds the ${seconds}s scene`, id);
    }
    // Match src/timeline.ts: Remotion rounds each scene to whole frames before
    // summing them. Rounding only the total drifts for fractional durations.
    const duration = Number.isInteger(spec.fps) && spec.fps > 0 ? Math.max(1, Math.round(seconds * spec.fps)) / spec.fps : seconds;
    scenes.push({ id, component: raw.component, seconds: duration, start: at, end: at + duration, narration: raw.narration ?? null, narrationAudio: raw.narrationAudio ?? null, narrationOffset: offset, narrationSeconds: raw.narrationSeconds ?? null, narrationWords: raw.narrationWords, cues: raw.cues ?? {}, cueWords: raw.cueWords, chapter: raw.chapter, energy: raw.energy, transition: raw.transition });
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
  if (spec.audio !== undefined && !object(spec.audio)) err("audio must be an object");
  const audio = object(spec.audio) ? spec.audio : {};
  if (audio.music && !exists(audio.music)) err(`music public/${audio.music} is missing`);
  for (const key of ["musicVolume", "musicDuckedVolume", "narrationVolume"]) {
    const volume = audio[key];
    if (volume !== undefined && (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 2)) err(`${key} must be a number 0..2`);
  }
  if (typeof audio.musicVolume === "number" && typeof audio.musicDuckedVolume === "number" && audio.musicDuckedVolume >= audio.musicVolume) warn("musicDuckedVolume should sit below musicVolume or ducking under narration does nothing");
  if (audio.sfx !== undefined && !Array.isArray(audio.sfx)) err("audio.sfx must be an array");
  for (const sfx of Array.isArray(audio.sfx) ? audio.sfx : []) {
    if (!sfx?.src || !exists(sfx.src)) err(`sfx public/${sfx?.src} is missing`);
    if (typeof sfx?.at !== "number" || !Number.isFinite(sfx.at) || sfx.at < 0 || sfx.at >= at) err(`sfx ${sfx?.src} at ${sfx?.at}s is outside the timeline`);
    if (sfx.volume !== undefined && (typeof sfx.volume !== "number" || !Number.isFinite(sfx.volume) || sfx.volume < 0 || sfx.volume > 2)) err(`sfx ${sfx?.src} volume must be a number 0..2`);
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
    return captionChunks(text, spoken, maxWords, 42, scene.narrationWords).map((chunk) => ({ text: chunk.text, start: origin + chunk.start, end: Math.min(scene.end, origin + chunk.end) })).filter((c) => c.end > c.start);
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
    const entrance = b.end - b.start < 1 && scenes.some((s) => b.start >= s.start - 0.1 && b.start < s.start + 1.2);
    const edge = b.start < 0.6 || b.end > info.duration - 0.6 || entrance;
    if (!edge) add("warn", `Frame is almost entirely background ${b.start.toFixed(2)}–${b.end.toFixed(2)}s (≥98% near-black pixels): an empty composition or unintended gap unless it is a deliberate beat.`, sceneAt(b.start));
  }
  // Short holds under narration are normal reading time; long ones stall.
  for (const f of metrics.freeze) if (f.end - f.start >= 4) add("warn", `Picture is static for ${(f.end - f.start).toFixed(1)}s (${f.start.toFixed(1)}–${f.end.toFixed(1)}s); give the hold a purpose or add motion that advances the idea.`, sceneAt(f.start));
  // Several short holds can add up to a slideshow that no single hold flags.
  const held = metrics.freeze.reduce((sum, f) => sum + Math.max(0, Math.min(f.end, info.duration) - f.start), 0);
  if (info.duration >= 6 && held / info.duration >= 0.35) add("warn", `${Math.round((held / info.duration) * 100)}% of the runtime (${held.toFixed(1)}s of ${info.duration.toFixed(1)}s) is static in holds of 1.5s or more; add motion that advances each idea, or cut the holds.`);
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
async function runGuarded(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number; guard?: boolean; nice?: number; memoryMb?: number; env?: Record<string, string | undefined>; onLine?: (line: string) => void }) {
  options.signal?.throwIfAborted();
  // Heavy local work yields to whatever the person is doing at the keyboard.
  const niced = options.nice ? { command: "nice", args: ["-n", String(options.nice), command, ...args] } : { command, args };
  const target = options.guard === false ? niced : guardedCommand(niced.command, niced.args);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(target.command, target.args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } });
    ownProcessGroup(child.pid);
    let stdout = "", stderr = "", pending = "", settled = false;
    const tail = (text: string, add: string) => (text + add).slice(-200_000);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
    const timer = setTimeout(() => { kill(); finish(new Error(`${path.basename(command)} exceeded ${Math.round(options.timeoutMs / 1000)}s`)); }, options.timeoutMs);
    timer.unref?.();
    const stopWatching = watchMemory(child.pid!, options.memoryMb ?? memoryBudgetMb(), (message, pids) => {
      kill();
      for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      finish(new Error(`${path.basename(command)} stopped: ${message}. Nothing else was affected. Lower the resolution (render scale), render scene by scene with scene/from/to, or shorten the audio, then retry.`));
    });
    const abort = () => { kill(); finish(new Error("Video operation cancelled")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching();
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

export async function projectDir(value: unknown, cwd: string, mustExist = true): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error("dir must be a local project directory");
  const root = await fs.realpath(cwd);
  const dir = canonicalMutationPath(value, root);
  const denial = selfMutationDenial(path.join(dir, "video.json"), root);
  if (denial) throw new Error(denial);
  if (mustExist && !existsSync(path.join(dir, "video.json"))) throw new Error(`${dir} is not a video project (no video.json); create one with video_project action:"init"`);
  return dir;
}

export async function readSpec(dir: string) {
  const spec = JSON.parse(await fs.readFile(path.join(dir, "video.json"), "utf8"));
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("video.json must be an object");
  return spec;
}

/** Project-owned output paths must remain inside the physical project, even
 * when an output directory or existing output file is a symbolic link. */
export function projectWritePath(dir: string, ...parts: string[]): string {
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
  const structural = validatePublishSpec(spec, result.seconds);
  const design = lintDesign(spec).map(({ severity, message }) => ({ severity, message: `Design: ${message}` }));
  const audience = structural.some((i) => i.severity === "error") ? [] : publishFindings(spec, result.scenes, result.seconds);
  return { spec, components, ...result, issues: [...result.issues, ...structural, ...design, ...audience] };
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

const FORMATS: Record<string, [number, number]> = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] };

/** Write a look into the project: theme, fonts.ts and the fontsource dependencies. Returns true when packages changed. */
async function applyLook(dir: string, spec: any, look: (typeof LOOKS)[number]): Promise<boolean> {
  spec.look = look.id;
  spec.theme = { ...look.theme };
  await fs.writeFile(path.join(dir, "src/fonts.ts"), fontsSource(look.fonts));
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  const before = JSON.stringify(pkg.dependencies);
  const kept = Object.entries(pkg.dependencies).filter(([name]) => !name.startsWith("@fontsource/"));
  pkg.dependencies = Object.fromEntries([...kept, ...Object.entries(fontDependencies(look.fonts))].sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return before !== JSON.stringify(pkg.dependencies);
}
const writeSpec = (dir: string, spec: any) => fs.writeFile(path.join(dir, "video.json"), JSON.stringify(spec, null, 2) + "\n");

export async function videoProject(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const action = params.action ?? "check";
  if (action === "init") {
    const dir = await projectDir(params.dir, cwd, false);
    if (existsSync(dir)) throw new Error(`${dir} already exists; choose a new project directory`);
    if (!containsPath(await fs.realpath(cwd), dir)) throw new Error("Create video projects inside the current workspace");
    if (params.look !== undefined && !lookById(params.look)) throw new Error(`look must be one of ${LOOKS.map((l) => l.id).join(", ")}`);
    await fs.cp(VIDEO_PATHS.template, dir, { recursive: true, errorOnExist: true });
    const spec = await readSpec(dir);
    spec.title = typeof params.title === "string" && params.title.trim() ? params.title.trim().slice(0, 120) : spec.title;
    const look = lookById(params.look) ?? suggestLook(`${params.topic ?? ""} ${params.title ?? ""}`);
    await applyLook(dir, spec, look);
    const [width, height] = FORMATS[params.format ?? "landscape"] ?? FORMATS.landscape;
    Object.assign(spec, { width, height });
    for (const key of ["fps", "width", "height"]) if (params[key] !== undefined) spec[key] = params[key];
    const brand = Object.fromEntries(["name", "handle", "website", "tagline", "logo"].flatMap((key) => typeof params.brand?.[key] === "string" && params.brand[key].trim() ? [[key, params.brand[key].trim()]] : []));
    if (Object.keys(brand).length) spec.brand = brand;
    const intent = params.intent === "personal" ? "personal" : "publish";
    const platforms = Array.isArray(params.platforms) && params.platforms.length ? params.platforms : params.format === "vertical" ? ["shorts"] : ["youtube"];
    spec.publish = { intent, platforms, ...(intent === "publish" && spec.brand ? { cta: { enabled: true } } : {}) };
    if (intent === "personal") spec.captions = { ...spec.captions, enabled: params.captions === true };
    await writeSpec(dir, spec);
    if (params.install !== false) await npmInstall(dir, signal, progress);
    return {
      project: dir, installed: params.install !== false, look: { id: look.id, why: look.why, fits: look.fits, voice: look.audio.voice, music: look.audio.music },
      intent, platforms, size: `${spec.width}x${spec.height}`,
      files: ["video.json (master timeline: look, brand, publish, scenes, narration, cues, transitions, captions, audio)", "src/scenes/*.tsx + index.ts (scene registry: TitleCard, DiagramScene, OutroScene)", "src/primitives/* (Stage, Heading, KineticText, LowerThird, Counter, ProgressBar, Callout, TokenRow, NeuralNet, Matrix, Graph, BarChart, TimelineAxis, CodeBlock, ParticleField, Backdrop, MediaFrame, Clip, Captions, AudioSpectrum, FilmGrain, LightLeak, CameraMove, Glitch, BrandBug, CtaLayer)", "src/motion.ts, src/timing.ts (beat/loop helpers), src/theme.tsx, src/timeline.ts, src/captions.ts", "public/audio/ (narration, music, sfx), public/assets/ (fetched media)"],
      next: ["Write storyboard.md (beats, visual metaphor per beat, on-screen text ≤ 8 words) before coding; open on the payoff, not a title card", "Replace video.json scenes; build scene components from primitives (scenes do not fade themselves: transitions in video.json own entry and exit)", "video_project check → video_render stills → inspect the contact sheet → fix → repeat", `narration_tts synthesize (voice ${look.audio.voice.voice}, style ${look.audio.voice.style}) → audio_synth music (${look.audio.music.style}, ${look.audio.music.bpm} bpm, ${look.audio.music.key} ${look.audio.music.mode}) and kind sound_design → video_project action:"cta" if a brand is set → video_render preview → final → video_qa`],
      note: "The template scenes are mechanical examples with placeholder text; replace them with components designed for this video. The look is a starting identity derived from the subject: change it with action look, or adjust theme colors and fonts if the subject calls for something else.",
    };
  }
  const dir = await projectDir(params.dir, cwd);
  if (action === "install") { await npmInstall(dir, signal, progress); return { project: dir, installed: true }; }
  if (action === "look") {
    const look = lookById(params.look);
    if (!look) throw new Error(`look must be one of ${LOOKS.map((l) => `${l.id} (${l.fits})`).join("; ")}`);
    const spec = await readSpec(dir);
    const changed = await applyLook(dir, spec, look);
    await writeSpec(dir, spec);
    if (changed && params.install !== false) await npmInstall(dir, signal, progress);
    return { project: dir, look: look.id, why: look.why, fontsChanged: changed, voice: look.audio.voice, music: look.audio.music, note: "Theme, src/fonts.ts and font packages were replaced. Scene code that hard-codes colors or font families must be updated to use useTheme()." };
  }
  if (action === "cta") {
    const spec = await readSpec(dir);
    if (!isPublishing(spec)) throw new Error("publish.intent is personal; calls to action are not wanted");
    const { scenes, seconds } = await inspectProject(dir);
    spec.publish = { ...spec.publish, intent: "publish", cta: planCtas(scenes, seconds, spec.publish?.cta, { commentPrompt: params.commentPrompt, sharePrompt: params.sharePrompt }) };
    await writeSpec(dir, spec);
    const single = (spec.publish.platforms ?? ["youtube"]).length === 1 && ["youtube", "shorts"].includes(spec.publish.platforms[0]);
    return { project: dir, cta: spec.publish.cta, variant: single ? "youtube (Subscribe, bell)" : "generic (Follow, Like)", note: "Moments are placed at scene boundaries after the viewer has had value. Edit publish.cta.<kind>.at to move one; set a kind to null to drop it; publish.cta.enabled false removes all." };
  }
  if (action === "feature") {
    if (params.feature !== "3d") throw new Error('feature must be "3d"');
    // three.js is opt-in: about 40 MB of packages that only 3D scenes need.
    await fs.copyFile(path.join(VIDEO_PATHS.optional, "three/Model3D.tsx"), projectWritePath(dir, "src", "primitives", "Model3D.tsx"));
    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    pkg.dependencies = Object.fromEntries(Object.entries({ ...pkg.dependencies, "@react-three/fiber": "9.8.1", "@remotion/three": "4.0.527", three: "0.186.1" }).sort(([a], [b]) => a.localeCompare(b)));
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    if (params.install !== false) await npmInstall(dir, signal, progress);
    return { project: dir, feature: "3d", primitive: 'import { Model3D } from "../primitives/Model3D";', use: '<Model3D src="assets/models/<id>/<id>.gltf" width={900} height={700} turns={0.5} />', note: "Software GL renders each frame on the CPU; keep models at 1k textures and the canvas near the size it is shown." };
  }
  if (action !== "check") throw new Error("action must be init, check, install, look, cta or feature");
  const { spec, issues, scenes, seconds, components } = await inspectProject(dir);
  return {
    project: dir, title: spec.title, look: spec.look ?? null, intent: spec.publish?.intent ?? "publish", fps: spec.fps, size: `${spec.width}x${spec.height}`, seconds: Number(seconds.toFixed(2)),
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
  if (blocking.length && mode !== "stills" && mode !== "thumbnail") throw new Error(`Fix timeline errors first: ${blocking.map((i) => `${i.scene ? `[${i.scene}] ` : ""}${i.message}`).join("; ")}`);
  const release = await acquireRender(signal);
  const report = throttled(progress);
  try {
    const out = await freshOut(dir, mode);
    const request: any = { project: dir, outDir: out, mode, composition: "Main", browserExecutable: browserExecutable(), concurrency: renderConcurrency(spec.width, spec.height) };
    if (mode === "stills") {
      const plan = planStillFrames(scenes, spec.fps, { scene: params.scene, count: params.count, times: params.times });
      request.frames = plan.map((p) => p.frame);
      const result = await runRenderer(dir, request, signal, report, 600_000);
      const stills = result.stills.map((s: any, i: number) => ({ ...s, label: plan[i].label }));
      const sheet = await contactSheet(stills.map((s: any) => ({ path: s.path, label: s.label })), path.join(out, "contact-sheet.png"), signal);
      return { mode, contactSheet: sheet, stills, bundleCached: result.bundleCached, timelineIssues: issues,
        review: "Open contact-sheet.png (and full-size stills where detail matters) with the read tool and judge it: hierarchy, clipping, text size/density, spacing rhythm, contrast, empty or overcrowded composition, consistency with neighbouring scenes. A successful render is not visual approval." };
    }
    if (mode === "thumbnail") {
      if (!spec.publish?.thumbnail) throw new Error('Set publish.thumbnail {text, image?} in video.json first (three or four words; wrap the emphasised word in asterisks)');
      const result = await runRenderer(dir, { ...request, mode: "stills", composition: "thumbnail", frames: [0] }, signal, report, 300_000);
      const png = result.stills[0].path;
      // Platforms cap covers at 2 MB; a high-quality JPEG is the safe delivery format.
      const jpg = path.join(out, "thumbnail.jpg");
      await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", "-i", png, "-q:v", "2", jpg], signal, 30_000);
      return { mode, thumbnail: jpg, png, size: `${result.width}x${result.height}`, bytes: (await fs.stat(jpg)).size, review: "Open the image with the read tool and shrink your judgement to a phone: can the claim be read in one second at 160 px wide, is there one focal point, does the emphasised word carry the hook?" };
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
      request.concurrency = renderConcurrency(spec.width, spec.height, request.scale);
      request.crf = params.crf;
      const frames = request.range ? request.range[1] - request.range[0] + 1 : total;
      const timeoutMs = Math.min(3_600_000, 120_000 + frames * (mode === "final" ? 600 : 250));
      const result = await runRenderer(dir, request, signal, report, timeoutMs);
      let mastered: Awaited<ReturnType<typeof masterMedia>> | undefined;
      if (mode === "final" && params.master !== false && !request.muted && (await probe(result.output, signal)).streams?.some((st: any) => st.codec_type === "audio")) mastered = await masterFinal(result.output, targetLoudness(spec), signal);
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
          captions = { srt: path.join(out, "captions.srt"), vtt: path.join(out, "captions.vtt"), cues: track.length, timing: scenes.some((sc) => sc.narrationWords?.length) ? "measured word timings where narration_tts stored them, estimated elsewhere" : "estimated from narration length and syllables, not speech-aligned" };
        }
      }
      let publish: any;
      if (mode === "final" && !request.range && isPublishing(spec)) {
        const chapters = chapterList(scenes);
        await fs.writeFile(path.join(out, "description.md"), descriptionDraft(spec, chapters), { flag: "wx" });
        if (chapters.length) await fs.writeFile(path.join(out, "chapters.txt"), formatChapters(chapters) + "\n", { flag: "wx" });
        publish = { description: path.join(out, "description.md"), ...(chapters.length ? { chapters: path.join(out, "chapters.txt") } : {}), note: "description.md is a skeleton: write the hook line and add links. Chapters follow the YouTube rules (first at 0:00, three or more, each at least 10 s)." };
      }
      return { mode, output: result.output, ...(mastered ? { loudness: { ...mastered, mixLufs: mastered.before.integratedLufs, deliveredLufs: mastered.after.integratedLufs, note: "delivery encoding measured after normalization (video stream copied); silence is preserved" } } : {}), ...(captions ? { captions } : {}), ...(publish ? { publish } : {}), frameRange: request.range ?? [0, total - 1], seconds: Number(info.format?.duration), size: `${info.streams?.find((s: any) => s.codec_type === "video")?.width}x${info.streams?.find((s: any) => s.codec_type === "video")?.height}`, hasAudio: info.streams?.some((s: any) => s.codec_type === "audio") ?? false, renderMs: result.renderMs, decodeVerified: true,
        review: mode === "final" ? "Run video_qa on this file, then inspect its contact sheet and listen-check narration timing before delivery." : "Watch the motion: extract frames around transitions with video_frames, or check timing against cues in video.json. Stills cannot show pacing, easing or transitions." };
    }
    throw new Error("mode must be stills, preview, final or thumbnail");
  } finally { release(); }
}

/** Delivery loudness per platform: feeds normalize to about -14 LUFS, and
 * anything quieter is not raised, so a quiet mix loses to its neighbours. */
export const targetLoudness = (spec: any): number => (isPublishing(spec) && (spec?.publish?.platforms ?? ["youtube"]).length ? -14 : -16);

/** Two-pass EBU R128 normalization of the audio stream (video is copied, not
 * re-encoded), so the final file lands on the delivery loudness whatever
 * balance the mix started with. Measures the delivered encoding as well. */
async function masterFinal(file: string, target: number, signal?: AbortSignal) {
  return masterMedia(file, target, signal);
}

async function runRenderer(dir: string, request: any, signal: AbortSignal | undefined, report: Progress, timeoutMs: number) {
  projectWritePath(dir, ".video-cache");
  const requestPath = path.join(request.outDir, "render-request.json");
  await fs.writeFile(requestPath, JSON.stringify(request));
  let result: any;
  await runGuarded(process.execPath, [VIDEO_PATHS.runner, requestPath], {
    cwd: dir, signal, timeoutMs, nice: 10,
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
  let scenes: TimedScene[] = [];
  let timelineIssues: Issue[] = [];
  let platformTarget = -16;
  if (params.dir) { const project = await inspectProject(await projectDir(params.dir, cwd)); scenes = project.scenes; timelineIssues = project.issues; platformTarget = targetLoudness(project.spec); }
  const targetLufs = typeof params.targetLufs === "number" ? params.targetLufs : platformTarget;
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

/** Pronunciation lexicon: display spelling -> spoken respelling, applied to
 * the text sent to Piper while video.json keeps the display spelling (used
 * for captions and on-screen text). Longest spellings win, so "GPT-4" beats
 * "GPT". Pure. */
export function validateLexicon(input: unknown): Array<[string, string]> {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("lexicon must be an object of spelling to pronunciation");
  const entries = Object.entries(input);
  if (entries.length > 64) throw new Error("lexicon accepts at most 64 entries");
  for (const [from, to] of entries) {
    if (typeof from !== "string" || !from.trim() || from.length > 64) throw new Error("lexicon spellings must be 1..64 characters");
    if (typeof to !== "string" || !to.trim() || to.length > 128) throw new Error("lexicon pronunciations must be 1..128 characters");
  }
  return (entries as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length);
}
export function applyLexicon(text: string, lexicon: Array<[string, string]>): { text: string; edits: number } {
  let edits = 0, out = text;
  for (const [from, to] of lexicon) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    edits++;
  }
  return { text: out, edits };
}

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

async function piperHasAlignment(): Promise<boolean> {
  if (!existsSync(piperPython())) return false;
  return runGuarded(piperPython(), ["-c", "import piper, onnx"], { cwd: piperHome(), timeoutMs: 60_000, guard: false }).then(() => true, () => false);
}
async function piperStatus() {
  const installed = existsSync(piperPython());
  const voices = Object.fromEntries(Object.entries(PIPER_VOICES).map(([name, v]) => [name, { installed: voiceFiles(name).every((f) => existsSync(f.path)), note: v.note }]));
  return { engine: "piper", packages: PIPER_PACKAGES, installed, wordAlignment: await piperHasAlignment(), styles: Object.keys(VOICE_STYLES), home: piperHome(), voices };
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
    }
    if (!await piperHasAlignment()) {
      progress?.(`Installing ${PIPER_PACKAGES.join(" and ")} (binary wheels only)…`);
      // Wheels only: no package build scripts run during installation.
      await runGuarded(piperPython(), ["-m", "pip", "install", "--quiet", "--only-binary=:all:", ...PIPER_PACKAGES], { cwd: piperHome(), signal, timeoutMs: 600_000, guard: false });
    }
    for (const file of voiceFiles(voice)) {
      if (existsSync(file.path) && await sha256(file.path) === file.sha256) continue;
      progress?.(`Downloading voice ${file.name} (${Math.round(file.bytes / 1e6)} MB, checksum-pinned)…`);
      await download(file.url, file.path, file.sha256, signal);
    }
    return { ...(await piperStatus()), installedVoice: voice };
  }
  if (action !== "synthesize") throw new Error("action must be status, install or synthesize");
  const lexicon = validateLexicon(params.lexicon);
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
  // pace (~150-170 wpm); lower is slower. The style sets pace and variability.
  const styleName = params.style ?? lookById(spec.look)?.audio.voice.style ?? "documentary";
  const style = VOICE_STYLES[styleName] ?? VOICE_STYLES.documentary;
  const speed = typeof params.speed === "number" ? Math.min(1.5, Math.max(0.6, params.speed)) : 1;
  await fs.mkdir(outDir, { recursive: true });
  const jobs = selected.flatMap((scene: any) => {
    const text = typeof scene.narration === "string" ? scene.narration.trim() : "";
    if (!text) return [];
    const display = text.replace(/\s+/g, " ");
    const spoken = applyLexicon(text, lexicon);
    return [{ scene, text, display, spoken, counts: display.split(" ").map((token) => spokenWordCount(token, lexicon)) }];
  });
  if (!jobs.length) return { voice, narrated: [], note: "No selected scene has narration text." };
  const requestPath = projectWritePath(dir, "public", "audio", "narration", ".request.json");
  await fs.writeFile(requestPath, JSON.stringify({ model: voiceFiles(voice)[0].path, outDir, threads: Math.max(2, Math.floor(os.availableParallelism() / 3)), lengthScale: style.length / speed, noiseScale: style.noise, noiseW: style.noiseW, sentenceSilence: style.sentence, paragraphSilence: style.paragraph,
    scenes: jobs.map((job) => ({ id: job.scene.id, text: job.spoken.text, display: job.display, counts: job.counts })) }));
  let result: any;
  try {
    await runGuarded(piperPython(), ["-I", VIDEO_PATHS.narrate, requestPath], { cwd: dir, signal, timeoutMs: 900_000, nice: 10, onLine: (line) => {
      if (line.startsWith("NARRATE_RESULT ")) result = JSON.parse(line.slice(15));
      else if (line.startsWith("NARRATE_PROGRESS ")) progress?.(`Narrating ${line.slice(17)}…`);
    } });
  } finally { await fs.rm(requestPath, { force: true }); }
  if (!result) throw new Error("Narration produced no result");
  const results: any[] = [];
  const lead = typeof params.cueLead === "number" ? params.cueLead : 0.08;
  for (const job of jobs) {
    const { scene } = job;
    const made = result.scenes.find((s: any) => s.id === job.scene.id);
    const wav = projectWritePath(dir, "public", "audio", "narration", `${scene.id}.wav`);
    const mastered = await masterNarration(made.raw, wav, signal);
    const seconds = Number((await probe(wav, signal)).format?.duration);
    const offset = scene.narrationOffset ?? 0.4;
    scene.narrationOffset = offset;
    scene.narrationSeconds = Number(seconds.toFixed(3));
    scene.narrationAudio = `audio/narration/${scene.id}.wav`;
    scene.narrationWords = made.words;
    const recued = resolveCueWords(scene, offset, lead);
    const needed = Number((offset + seconds + (params.tailSeconds ?? 0.8)).toFixed(2));
    let adjusted: number | undefined;
    if (params.fitScenes === true && needed > scene.seconds) { adjusted = needed; scene.seconds = needed; }
    results.push({ scene: scene.id, audio: scene.narrationAudio, seconds: scene.narrationSeconds, words: words(job.text), timing: made.exact ? "measured" : "estimated", syllablesPerSecond: Number((syllables(job.text) / seconds).toFixed(2)), loudnessLufs: mastered.lufs, sceneSeconds: scene.seconds,
      ...(recued.length ? { cues: recued } : {}), ...(job.spoken.edits ? { lexiconEdits: job.spoken.edits } : {}), ...(adjusted ? { lengthenedTo: adjusted } : needed > scene.seconds ? { overrun: Number((needed - scene.seconds).toFixed(2)) } : {}) });
    await fs.rm(made.raw, { force: true });
  }
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + "\n");
  return { voice, style: styleName, aligned: result.aligned, narrated: results, note: result.aligned
    ? "Word timings are measured from the synthesized speech and drive captions. Cues named in cueWords were re-timed to their spoken word; other cues are unchanged (scene-relative seconds) so re-time them to the narration if they should follow it. Listen-check pronunciation of names and acronyms (respell them in the lexicon)."
    : "Piper's alignment support is missing, so caption timing is estimated. Run narration_tts action:install once to add it." };
}

/** Spoken words a display token produces: exact when the lexicon respells it,
 * unknown (null) where the engine expands it (digits, hyphenated compounds, dotted abbreviations). */
function spokenWordCount(token: string, lexicon: Array<[string, string]>): number | null {
  const respelled = applyLexicon(token, lexicon);
  if (respelled.edits) return respelled.text.trim().split(/\s+/).length;
  return /\d|[-–—/]|\w\.\w/.test(token) ? null : 1;
}

/** Point every cue named in cueWords at the measured start of its word (a
 * "word#2" suffix picks the second occurrence), a short lead before it so the
 * visual lands as the word is heard. Returns what moved. */
export function resolveCueWords(scene: any, offset: number, lead: number): Array<{ cue: string; word: string; from: number | null; to: number }> {
  const moved: Array<{ cue: string; word: string; from: number | null; to: number }> = [];
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  for (const [name, target] of Object.entries<string>(scene.cueWords ?? {})) {
    const [text, nth] = String(target).split("#");
    const hits = (scene.narrationWords ?? []).filter((w: any) => norm(w.w) === norm(text));
    const hit = hits[Math.max(0, Number(nth ?? 1) - 1)];
    if (!hit) continue;
    const to = Number(Math.min(scene.seconds - 0.05, Math.max(0, offset + hit.s - lead)).toFixed(2));
    moved.push({ cue: name, word: target, from: scene.cues?.[name] ?? null, to });
    scene.cues = { ...scene.cues, [name]: to };
  }
  return moved;
}

/** Narration polish: rumble filter, gentle compression, a touch of presence,
 * then a gain that lands each scene at the same integrated loudness so the
 * mix does not jump between scenes. 48 kHz mono. */
async function masterNarration(input: string, output: string, signal?: AbortSignal): Promise<{ lufs: number }> {
  const chain = "highpass=f=75,acompressor=threshold=-21dB:ratio=2.2:attack=6:release=140,equalizer=f=3000:t=q:w=1.1:g=1.5,aresample=48000";
  const measured = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(input, 0), "-af", `${chain},ebur128=peak=true`, "-f", "null", "-"], signal, 60_000);
  const lufs = Number(/I:\s*(-?[\d.]+) LUFS/.exec(measured.stderr.slice(measured.stderr.lastIndexOf("Summary:")))?.[1]);
  const gain = Number.isFinite(lufs) ? Math.max(-12, Math.min(18, NARRATION_LUFS - lufs)) : 0;
  // The shared FFmpeg flags refuse to overwrite; a re-synthesized scene replaces its old file.
  await fs.rm(output, { force: true });
  await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", ...inputArgs(input, 0), "-af", `${chain},volume=${gain.toFixed(2)}dB,alimiter=limit=0.9`, "-ac", "1", output], signal, 60_000);
  return { lufs: Number((Number.isFinite(lufs) ? lufs + gain : NARRATION_LUFS).toFixed(1)) };
}

// ───────────────────────────── procedural audio ─────────────────────────────

export const SFX_TYPES = ["whoosh", "riser", "downlifter", "impact", "tick", "pop", "chime", "swell"];
/** Relative volume of each sound when the harness places it (under narration). */
const SFX_VOLUME: Record<string, number> = { whoosh: 0.3, swell: 0.26, riser: 0.28, impact: 0.42, pop: 0.26, chime: 0.28, tick: 0.2, downlifter: 0.26 };

/** Music intensity that follows the video: the shape of a good edit (a strong
 * opening, room under explanation, a build into the last third, a resolve),
 * bent by any per-scene `energy` (0..1) the author set. */
export function autoIntensity(scenes: TimedScene[], seconds: number): Array<[number, number]> {
  const arc: Array<[number, number]> = [[0, 0.3], [0.15, 0.62], [0.5, 0.58], [0.8, 0.88], [1, 0.35]].map(([p, v]) => [Number((p * seconds).toFixed(2)), v] as [number, number]);
  const points = new Map<number, number>(arc);
  for (const scene of scenes as any[]) {
    const mid = Number(((scene.start + scene.end) / 2).toFixed(2));
    if (typeof scene.energy === "number") points.set(mid, Math.min(1, Math.max(0, scene.energy)));
    else if (scene.component === "OutroScene") points.set(Number(scene.start.toFixed(2)), 0.35);
  }
  return [...points.entries()].sort((a, b) => a[0] - b[0]);
}

type SoundEvent = { type: string; at: number; volume: number; seconds?: number; pitch?: number; note: string };
/** Where sound belongs in this timeline: a whoosh through each moving
 * transition, a riser into and an impact on each reveal cue, a chime on
 * resolutions and a soft pop when a like or follow lands. Nothing else. */
export function planSoundDesign(spec: any, scenes: TimedScene[], seconds: number): SoundEvent[] {
  const events: SoundEvent[] = [];
  const push = (event: SoundEvent) => { if (event.at >= 0 && event.at < seconds - 0.05) events.push({ ...event, at: Number(event.at.toFixed(2)) }); };
  scenes.forEach((scene, i) => {
    const t = Number(scene.transition?.seconds ?? 0.5), kind = scene.transition?.type;
    if (i > 0 && kind && ["slide", "slideup", "slidedown", "wipe", "zoom"].includes(kind)) push({ type: "whoosh", at: scene.start - 0.12, seconds: Math.min(1.1, Math.max(0.5, t * 1.5)), pitch: i % 2 ? 0.85 : 1.05, volume: SFX_VOLUME.whoosh, note: `${kind} into ${scene.id}` });
    else if (i > 0 && kind === "blur") push({ type: "swell", at: scene.start - 0.3, seconds: 1.4, volume: SFX_VOLUME.swell, note: `blur into ${scene.id}` });
    for (const [name, value] of Object.entries(scene.cues ?? {})) {
      const at = scene.start + value;
      if (/^(hit|reveal|drop|slam|impact|punch)/i.test(name)) {
        if (value >= 1.4) push({ type: "riser", at: at - 1.5, seconds: 1.5, volume: SFX_VOLUME.riser, note: `into ${scene.id}.${name}` });
        push({ type: "impact", at, volume: SFX_VOLUME.impact, note: `${scene.id}.${name}` });
      } else if (/^(chime|win|done|success|resolve|answer)/i.test(name)) push({ type: "chime", at, volume: SFX_VOLUME.chime, note: `${scene.id}.${name}` });
      else if (/^(pop|badge|stamp)/i.test(name)) push({ type: "pop", at, volume: SFX_VOLUME.pop, note: `${scene.id}.${name}` });
    }
  });
  if (isPublishing(spec) && spec.publish?.cta?.enabled !== false) {
    const cta = spec.publish?.cta ?? {};
    if (cta.like) push({ type: "pop", at: cta.like.at + 0.28 * (cta.like.seconds ?? 3.4), volume: SFX_VOLUME.pop, note: "like press" });
    if (cta.follow) push({ type: "pop", at: cta.follow.at + 0.4 * (cta.follow.seconds ?? 4.2), volume: SFX_VOLUME.pop, note: "follow press" });
    const outro = scenes.find((s) => s.component === "OutroScene");
    if (outro && typeof outro.cues?.follow === "number") push({ type: "pop", at: outro.start + outro.cues.follow + 0.4 * 5, volume: SFX_VOLUME.pop, note: "outro follow press" });
  }
  // A whoosh and an impact inside 0.6 s of each other read as one gesture; keep the first of any crowd.
  events.sort((a, b) => a.at - b.at);
  return events.filter((event, i) => !events.slice(0, i).some((prior) => Math.abs(prior.at - event.at) < 0.6 && prior.type === event.type));
}

async function synthRun(dir: string, spec: any, name: string, signal?: AbortSignal) {
  const specPath = projectWritePath(dir, "public", "audio", `.${name}.json`);
  const output = projectWritePath(dir, "public", "audio", `${name}.wav`);
  await fs.writeFile(specPath, JSON.stringify(spec));
  try {
    const result = await runGuarded("python3", ["-I", VIDEO_PATHS.synth, specPath, output], { cwd: dir, signal, timeoutMs: 300_000, nice: 10, env: { OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" } });
    return { stats: JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"), output, publicPath: `audio/${name}.wav` };
  } finally { await fs.rm(specPath, { force: true }); }
}

export async function audioSynth(params: any, cwd: string, signal?: AbortSignal) {
  const dir = await projectDir(params.dir, cwd);
  // A sound named after its type ("whoosh", "impact-2") is the common way to
  // leave `type` out; anything else fails here instead of inside Python.
  if (params.kind === "sfx" && !params.type) {
    params = { ...params, type: SFX_TYPES.find(type => typeof params.name === "string" && (params.name === type || params.name.startsWith(`${type}-`))) };
    if (!params.type) throw new Error(`kind sfx needs type: one of ${SFX_TYPES.join(", ")} (name only sets the file name)`);
  }
  await fs.mkdir(projectWritePath(dir, "public", "audio"), { recursive: true });
  if (params.kind === "sound_design") return soundDesign(dir, signal);
  const name = typeof params.name === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(params.name) ? params.name : params.kind === "music" ? "music" : `sfx-${params.type}`;
  const spec: any = { kind: params.kind, seed: params.seed ?? 7 };
  let project: any;
  if (params.kind === "music") {
    project = await inspectProject(dir);
    const look = lookById(project.spec.look)?.audio.music;
    const intensity = params.intensity === "auto" || params.intensity === undefined ? autoIntensity(project.scenes, project.seconds) : params.intensity;
    Object.assign(spec, { seconds: params.seconds ?? Math.ceil(project.seconds + 1), style: params.style ?? look?.style, bpm: params.bpm ?? look?.bpm, key: params.key ?? look?.key, mode: params.mode ?? look?.mode,
      progression: params.progression, barsPerChord: params.barsPerChord, layers: params.layers, intensity, swing: params.swing, drumPattern: params.drumPattern, melodyVoice: params.melodyVoice });
  } else if (params.kind === "sfx") Object.assign(spec, { type: params.type, seconds: params.seconds, pitch: params.pitch });
  else throw new Error("kind must be music, sfx or sound_design");
  for (const key of Object.keys(spec)) if (spec[key] === undefined) delete spec[key];
  const made = await synthRun(dir, spec, name, signal);
  if (params.kind === "music") {
    // The grid rides beside the audio so visuals can lock to bars and entries.
    const { downbeats, chords, layerEntries, ...stats } = made.stats;
    const gridPath = projectWritePath(dir, "public", "audio", `${name}.grid.json`);
    await fs.writeFile(gridPath, JSON.stringify({ bpm: stats.bpm, barSeconds: stats.barSeconds, downbeats, chords, layerEntries, endsAt: stats.endsAt }));
    if (params.wire !== false) {
      const next = await readSpec(dir);
      next.audio = { ...next.audio, music: made.publicPath, musicBpm: stats.bpm };
      await fs.writeFile(path.join(dir, "video.json"), JSON.stringify(next, null, 2) + "\n");
    }
    return { ...stats, output: made.output, publicPath: made.publicPath, grid: `audio/${name}.grid.json`, bars: downbeats.length, chords: chords.length, layerEntries, wired: params.wire !== false,
      next: "video.json audio.music and audio.musicBpm are set. Music ducks automatically under narration windows and builds with the intensity arc (scene `energy` values bend it). Run audio_synth kind sound_design to place transition and cue sounds, then check the mix with video_qa." };
  }
  return { ...made.stats, output: made.output, publicPath: made.publicPath, spec,
    next: 'Add {"src": publicPath, "at": seconds} to video.json audio.sfx at the visual event it punctuates. Use sound sparingly: one accent per idea, not per animation.' };
}

/** Generate the sounds a timeline calls for and place them in video.json
 * audio.sfx, replacing only earlier automatic placements. */
async function soundDesign(dir: string, signal?: AbortSignal) {
  const { spec, scenes, seconds } = await inspectProject(dir);
  const events = planSoundDesign(spec, scenes, seconds);
  const files = new Map<string, string>();
  for (const event of events) {
    const key = `${event.type}-${event.pitch ?? 1}-${event.seconds ?? 0}`;
    if (files.has(key)) continue;
    const name = `sd-${event.type}${event.pitch ? `-${Math.round(event.pitch * 100)}` : ""}${event.seconds ? `-${Math.round(event.seconds * 100)}` : ""}`;
    const made = await synthRun(dir, { kind: "sfx", type: event.type, seed: 11 + files.size, ...(event.seconds ? { seconds: event.seconds } : {}), ...(event.pitch ? { pitch: event.pitch } : {}) }, name, signal);
    files.set(key, made.publicPath);
  }
  const placed = events.map((event) => ({ src: files.get(`${event.type}-${event.pitch ?? 1}-${event.seconds ?? 0}`)!, at: event.at, volume: event.volume, auto: true }));
  const next = await readSpec(dir);
  next.audio = { ...next.audio, sfx: [...(next.audio?.sfx ?? []).filter((s: any) => !s.auto), ...placed] };
  await fs.writeFile(path.join(dir, "video.json"), JSON.stringify(next, null, 2) + "\n");
  return { placed: events.map((e) => ({ at: e.at, type: e.type, why: e.note })), files: files.size, note: "Placements are marked auto: true in video.json audio.sfx; re-running replaces only those, so hand-placed sounds stay. Sounds sit 10+ dB under narration; remove any you cannot tie to a visual event." };
}
