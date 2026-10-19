/** Narration (ElevenLabs or local Piper), standalone procedural audio and the
 * video QA loop shared by every film, whatever engine rendered it. */
import { createWriteStream, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { FFMPEG_FLAGS, inputArgs, inputFile, probe, produced, run, number } from "./media-process.ts";
import { studioFolder } from "./design-studio.ts";
import { containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { runGuarded, type Progress } from "./guarded-process.ts";
import { memoryBudgetMb } from "./memory-guard.ts";
import { elevenStatus, elevenSpeech, elevenVoices, narrationBackend, speechRequest, writeSpeechCaptions, retainedSpeechError, elevenRecover } from './elevenlabs.ts';
import { fileDigest, videoFingerprint } from './video-segments.ts';
import { sampledColorEvidence } from './video-color-evidence.ts';
import { videoMotion, videoLoopBoundary } from './video-motion.ts';
import { referenceEvidence } from './video-art.ts';
import { captionChunks, estimateSeconds, toSrt, toVtt } from "./captions.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const VIDEO_PATHS = {
  synth: path.join(AGENT_ROOT, "skills/audio/scripts/synth.py"),
  narrate: path.join(AGENT_ROOT, "scripts/narrate.py"),
};
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const piperHome = () => path.join(agentDir(), "local-models", "piper");
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
/** Heuristic English syllable count. Perceived pace tracks syllables per
 * second (≈3.3-4.3 is comfortable narration), not words per minute. */
export function syllables(text: unknown): number {
  if (typeof text !== "string") return 0;
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).reduce((sum, word) => {
    const groups = word.replace(/'/g, "").replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
    return sum + Math.max(1, groups?.length ?? 0);
  }, 0);
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

export async function contactSheet(images: Array<{ path: string; label: string }>, output: string, signal?: AbortSignal) {
  const args = [...FFMPEG_FLAGS, "-loglevel", "error"];
  for (const image of images) args.push("-i", image.path);
  args.push("-filter_complex", contactSheetFilter(images.map((i) => i.label)), "-map", "[sheet]", "-frames:v", "1", "-update", "1", output);
  await run("ffmpeg", args, signal, 60_000);
  return (await produced(output)).path;
}

const QA_CRITERIA=['art-direction','composition','typography','motion','sync','audio'];
/** Evidence each verdict may rest on. playback and listening are human senses; a model
 * proves motion with decoded frame sequences it looked at, and sync and audio with a
 * current listen report (measured). */
const QA_EVIDENCE: Record<string, string[]> = {'art-direction':['frames','sequence','playback'],composition:['frames','sequence','playback'],typography:['frames','sequence','playback'],motion:['sequence','playback'],sync:['measured','playback'],audio:['measured','listening']};
/** The listen report for these exact video bytes, or undefined when missing or stale. */
async function currentListen(file: string, sha256: string) {
  try {
    const report = JSON.parse(await fs.readFile(path.join(path.dirname(file), `${path.basename(file)}.listen.json`), 'utf8'));
    return report?.format === 'yunuspi-listen-v1' && report.path === file && report.sha256 === sha256 ? report : undefined;
  } catch { return undefined; }
}
async function ambientRecipe(file: string) {
  const recipePath = path.join(path.dirname(file),'ambient.json');
  try {
    if ((await fs.stat(recipePath)).size > 256*1024) return undefined;
    const recipe = JSON.parse(await fs.readFile(recipePath,'utf8'));
    if (recipe.output !== file || recipe.direction?.camera !== 'locked' || recipe.direction?.colorSpace !== 'RGB') return undefined;
    return { ...recipe, path:recipePath };
  } catch { return undefined; }
}
async function qaIdentity(file: string, dir: string | undefined, signal?: AbortSignal, references: any[] = []) {
  const current=await referenceEvidence(references.map(r=>r.source),dir ?? path.dirname(file),signal);
  const recipe = await ambientRecipe(file);
  return {renderRecipe: recipe ? await fileDigest(recipe.path,signal) : null, video:await fileDigest(file,signal),project:dir?await videoFingerprint(dir,{purpose:'video-qa-v2'},signal):null,references:createHash('sha256').update(JSON.stringify(current)).digest('hex')};
}

/** Existing QA artifacts own their reviews. Technical passes never populate
 * perceptual verdicts, and edited bytes invalidate every prior attestation. */
async function qaReview(params: any, cwd: string, signal?: AbortSignal) {
  const reportPath=await inputFile(params.report,cwd), file=await inputFile(params.path,cwd);
  if((await fs.stat(reportPath)).size>2*1024*1024)throw Error('QA report exceeds 2 MiB');
  const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
  if(report.format!=='yunuspi-video-qa-v2' || report.path!==file || !report.identity)throw Error('Use the qa.json returned by video_qa analyze for this video');
  const identity=await qaIdentity(file,report.project,signal,report.references ?? []);
  if(params.action==='supersede') {
    const replacement = await inputFile(params.replacement,cwd);
    if(replacement === file) throw Error('A replacement must be a different delivered video');
    if(!(await probe(replacement,signal)).streams.some((s:any)=>s.codec_type==='video')) throw Error('The replacement needs a decoded video stream');
    if(typeof params.reason!=='string' || params.reason.trim().length<12 || params.reason.length>1200) throw Error('Superseding a delivery needs a concrete reason');
    const denial=selfMutationDenial(reportPath,await fs.realpath(cwd));if(denial)throw Error(denial);
    report.supersededBy={path:replacement,sha256:await fileDigest(replacement,signal),reason:params.reason.trim(),at:new Date().toISOString()};
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    return {path:file,report:reportPath,reportSha256:await fileDigest(reportPath,signal),supersededBy:report.supersededBy,deliveryReady:false,note:'The rejected delivery remains preserved. Its replacement requires its own current video_qa analysis and visual/playback/listening review.'};
  }
  let evidenceChanged=false;
  for(const sample of report.evidence ?? []) if(await fileDigest(sample.path,signal).catch(()=>null)!==sample.sha256)evidenceChanged=true;
  signal?.throwIfAborted();
  const stale=identity.video!==report.identity.video || identity.project!==report.identity.project || identity.references!==report.identity.references || (identity.renderRecipe ?? null)!==(report.identity.renderRecipe ?? null) || evidenceChanged;
  if(params.action==='status') return {path:file,identity,report:reportPath,reportSha256:await fileDigest(reportPath,signal),stale,supersededBy:report.supersededBy,deliveryReady:!report.supersededBy && !stale && report.passedAutomatedChecks === true && report.reviewStatus === 'passed',reviewStatus:stale?'stale':report.reviewStatus,reviews:report.reviews ?? [],sampledScenes:report.sampledScenes,nextScene:report.nextScene,note:'Verdicts are explicit reviewer attestations on this evidence scope; technical checks do not establish design, playback or listening quality'};
  if(report.supersededBy) throw Error('This delivery was superseded. Analyze and review the replacement; the old take cannot be approved again through this report.');
  if(stale)throw Error('QA evidence is stale: video or project bytes changed. Analyze the current render before recording verdicts.');
  const denial=selfMutationDenial(reportPath,await fs.realpath(cwd));if(denial)throw Error(denial);
  if(!Array.isArray(params.reviews) || !params.reviews.length || params.reviews.length>6)throw Error('record needs 1..6 explicit review verdicts');
  const seen=new Set(), reviews=new Map<string,any>((report.reviews ?? []).map((r: any)=>[r.criterion,r]));
  const listen=params.reviews.some((r:any)=>r?.evidence==='measured') ? await currentListen(file,identity.video) : undefined;
  for(const review of params.reviews) {
    if(!review || !QA_CRITERIA.includes(review.criterion) || seen.has(review.criterion) || !['pass','fail','unreviewed'].includes(review.verdict) || typeof review.note!=='string' || !review.note.trim() || review.note.length>1200)throw Error('Reviews need distinct known criteria, verdicts and concrete notes');
    if(review.comparedReferences !== undefined && (!Array.isArray(review.comparedReferences) || review.comparedReferences.length>8 || review.comparedReferences.some((r:any)=>typeof r!=='string' || r.length>4096)))throw Error('comparedReferences needs at most 8 reference paths/URLs');
    if(!QA_EVIDENCE[review.criterion]?.includes(review.evidence))throw Error('Art direction, composition and typography need frames, sequence or playback; motion needs sequence (decoded frame sequences you looked at) or playback; sync needs measured or playback; audio needs measured (a current video_qa action:"listen" report) or listening');
    if(review.evidence==='measured') {
      // A model cannot listen: a current listen report on these exact bytes is the evidence.
      if(!listen)throw Error('measured evidence needs a current video_qa action:"listen" report for this exact file; run listen on it first');
      if(review.verdict==='pass' && review.criterion==='audio' && listen.verdicts?.passed!==true)throw Error(`The listen check did not pass: ${(listen.findings ?? []).filter((f:any)=>f.severity==='error').map((f:any)=>f.message).join(' ') || 'see its report'} Fix the mix and listen again, or record audio as fail.`);
      if(review.verdict==='pass' && review.criterion==='sync' && listen.verdicts?.intelligible!==true)throw Error('Sync cannot pass on measured evidence while the listen report finds the narration unintelligible.');
    }
    if(review.criterion==='art-direction' && review.verdict==='pass' && (report.references ?? []).some((r:any)=>r.unavailable || !review.comparedReferences?.includes(r.source)))throw Error('An art-direction pass must name every inspected reference in comparedReferences; unavailable references need repair or a revised brief');
    seen.add(review.criterion);reviews.set(review.criterion,{...review,note:review.note.trim(),reviewer:params.reviewer ?? 'model',at:new Date().toISOString()});
  }
  report.reviews=[...reviews.values()];
  const required=QA_CRITERIA.filter(c=>report.hasAudio || !['audio','sync'].includes(c));
  report.reviewStatus=report.reviews.some((r: any)=>r.verdict==='fail')?'needs-work':required.every(c=>reviews.get(c)?.verdict==='pass')?(report.nextScene!==null || report.startScene>0?'passed-scope':'passed'):'partial';
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  return {path:file,identity,report:reportPath,reportSha256:await fileDigest(reportPath,signal),reviewStatus:report.reviewStatus,deliveryReady:report.passedAutomatedChecks && report.reviewStatus==='passed',reviews:report.reviews,sampledScenes:report.sampledScenes,nextScene:report.nextScene,note:'Recorded review attestations; automated technical checks remain separate'};
}

export async function videoQa(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  if(params.action==='listen') { const { videoListen } = await import('./video-listen.ts'); return videoListen(params,cwd,signal,progress); }
  if(['record','status','supersede'].includes(params.action))return qaReview(params,cwd,signal);
  if(params.action!==undefined && params.action!=='analyze')throw Error('action must be analyze, listen, record, status or supersede');
  const file = await inputFile(params.path, cwd);
  const info = await probe(file, signal);
  const video = info.streams?.find((s: any) => s.codec_type === "video");
  if (!video) throw new Error("Input has no video stream");
  const audio = info.streams?.find((s: any) => s.codec_type === "audio");
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unknown video duration");
  let scenes: TimedScene[] = [];
  let projectSpec: any, assets: any[]=[];
  let timelineIssues: Issue[] = [];
  let platformTarget = -16;
  const dir: string | undefined = undefined;
  const native = await ambientRecipe(file);
  if(params.references!==undefined && (!Array.isArray(params.references) || params.references.length>8 || params.references.some(r=>typeof r!=='string' || !r || r.length>4096)))throw Error('references needs up to 8 image paths or reference URLs');
  const references=await referenceEvidence(params.references ?? projectSpec?.direction?.references ?? native?.direction?.references?.map(r=>r.source) ?? [],dir ?? cwd,signal);

  const identity=await qaIdentity(file,dir,signal,references);
  const targetLufs = typeof params.targetLufs === "number" ? params.targetLufs : platformTarget;
  progress?.("Analyzing picture and sound (black/freeze detection, silence, EBU R128 loudness)…");
  const analysis = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, 0), "-map", "0:v:0", "-vf", "blackdetect=d=0.25:pix_th=0.08,freezedetect=n=0.002:d=1.5",
    ...(audio ? ["-map", "0:a:0", "-af", "silencedetect=noise=-50dB:d=1.2,ebur128=peak=true:framelog=info"] : []),
    "-f", "null", "-"], signal, Math.round(Math.min(3_600_000, 60_000 + duration * 4000)));
  const metrics = parseQaLog(`${analysis.stdout}\n${analysis.stderr}`, duration);
  const findings = [...timelineIssues.filter((i) => i.severity !== "info").map(i=>/is a preview render|is an explicit (?:blockout|draft) asset/.test(i.message)?{...i,severity:'error' as const}:i), ...qaFindings(metrics, {
    duration, hasAudio: Boolean(audio), targetLufs,
    videoDuration: Number(video.duration ?? duration), ...(audio ? { audioDuration: Number(audio.duration ?? duration) } : {}),
  }, scenes)];
  if (native && (native.direction.sourceStage !== 'final' || /preview\.mp4$/.test(file))) findings.push({severity:'error',message:'This ambient output is a draft/preview; approve the source and render full delivery before recording a final pass.'});
  const [num,den]=String(video.avg_frame_rate).split('/').map(Number), deliveredFps=den?num/den:num;
  if(params.checkMotion!==undefined && typeof params.checkMotion!=='boolean')throw Error('checkMotion must be boolean');
  if(params.loop!==undefined && typeof params.loop!=='boolean')throw Error('loop must be boolean');
  const loopIntent=params.loop ?? (native?.plan?.loop === true && native?.plan?.seconds===native?.plan?.loopSeconds);
  let motionEvidence:any;
  if((params.checkMotion===true || params.loop===true || native?.version===2) && Number(video.duration ?? duration)*deliveredFps>=2){
    const windowSeconds=Math.min(Number(video.duration ?? duration),30,1800/deliveredFps);
    motionEvidence=await videoMotion({path:file,duration:windowSeconds,expectedFps:deliveredFps},cwd,signal);
    motionEvidence.coverage={seconds:windowSeconds,totalSeconds:Number(video.duration ?? duration),complete:windowSeconds>=Number(video.duration ?? duration)-1/deliveredFps};
    if(loopIntent)motionEvidence.deliveryLoop=await videoLoopBoundary(file,Number(video.duration ?? duration),deliveredFps,motionEvidence.pixelChange.medianMeanDelta,signal);
    for(const finding of [...motionEvidence.findings,...(motionEvidence.deliveryLoop?.findings ?? [])])findings.push({severity:finding.severity==='FAIL'?'error':'warning',message:`Decoded motion ${finding.id}: ${finding.detail}`});
  }
  const projectMatches=!projectSpec || (video.width===projectSpec.width && video.height===projectSpec.height && Math.abs(deliveredFps-projectSpec.fps)<.001 && Math.abs(Number(video.duration ?? duration)-(scenes.at(-1)?.end ?? 0))<=1/projectSpec.fps+.01);
  if(!projectMatches)findings.push({severity:'error',message:'Delivered dimensions, frame rate or duration differ from video.json. Use the matching full-film render/project; scene labels and cue samples cannot describe this file.'});
  if(!projectMatches)scenes=[];
  const first = Number(params.startScene ?? 0), selected = scenes.slice(first, first + 8);
  if(!Number.isInteger(first) || first<0)throw Error('startScene must be a non-negative integer');
  if (scenes.length && !selected.length) throw Error(`startScene must be below ${scenes.length}`);
  const times = Array.from({ length: 12 }, (_, i) => { const t = duration * (i + 0.5) / 12; return { t, label: `${t.toFixed(1)}s` }; });
  const out = path.join(path.dirname(file), `qa-${path.basename(file, path.extname(file))}-${randomBytes(3).toString("hex")}`);
  const denial = selfMutationDenial(out, await fs.realpath(cwd));
  if (denial) throw new Error(denial);
  await fs.mkdir(out, { recursive: true });
  const frames: Array<{ path: string; label: string }> = [];
  for (const [i, { t, label }] of times.entries()) {
    const framePath = path.join(out, `frame-${String(i + 1).padStart(2, "0")}.png`);
    await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", ...inputArgs(file, Math.max(0,Math.min(t,Number(video.duration ?? duration)-1/(deliveredFps || 30)))), "-frames:v", "1", "-update", "1", framePath], signal, 30_000);
    await produced(framePath);
    frames.push({ path: framePath, label });
  }
  const sheet = await contactSheet(frames, path.join(out, "contact-sheet.png"), signal);
  const colorEvidence = await sampledColorEvidence(frames, signal);
  if (colorEvidence.samples.filter(sample => sample.magentaFraction > .5).length > frames.length / 2) findings.push({severity:'warning',message:'Most sampled frames are dominated by magenta RGB pixels. Compare this measured cast with the intended palette; screen/light blending in YUV instead of RGB can cause an unintended purple wash.'});
  const report = {
    format:'yunuspi-video-qa-v2',identity,project:dir ?? null,startScene:first,
    direction:projectSpec?.direction ?? native?.direction ?? null,references,assets:assets.filter(a=>!selected.length || selected.some(s=>s.id===a.scene)),
    path: file, seconds: Number(duration.toFixed(3)), size: `${video.width}x${video.height}`, fps: video.avg_frame_rate, hasAudio: Boolean(audio),
    loudness: { integratedLufs: metrics.integratedLufs, loudnessRangeLu: metrics.loudnessRange, peakDbfs: metrics.truePeak, targetLufs },
    black: metrics.black, freeze: metrics.freeze, silence: metrics.silence,
    findings, colorEvidence, ...(motionEvidence?{motionEvidence}:{}), passedAutomatedChecks: !findings.some((f) => f.severity === "error"),
    contactSheet: sheet,detailFrame:frames[Math.min(3,frames.length-1)]?.path,frames:frames.map((f,i)=>({...f,seconds:times[i].t})),report:path.join(out,'qa.json'),
    sampledScenes: selected.map(s => s.id), nextScene: first + selected.length < scenes.length ? first + selected.length : null,
    reviewStatus: 'unreviewed',reviews:[],projectMatches,
    reviewPrompts:{'art-direction':'Compare full-size hero/detail frames against the brief and references: specific silhouette, accurate subject, intentional materials/texture, coherent light/shadow, grounded depth, palette and style. A primitive stand-in, decorative blob or noisy unfinished material needs work even if the file decodes. Intentional abstract and flat artwork can pass when they serve the brief.',composition:'Check hierarchy, spacing, focal balance and intentional overlap in the final canvas.',typography:'Check actual glyphs, wrapping, readable holds and unclipped labels.',motion:'Inspect continuous playback for acceleration, transitions, continuity and artifacts; stills cannot establish timing.',sync:'Inspect playback against spoken words and observed actions.',audio:'Listen to the delivery encoding for voice clarity, balance, accents and endings.'},
    review: "Automated checks find technical defects only. Open the contact sheet and full-size detail frames against the stored creative brief and reference pixels, inspect actual playback, and listen where audio exists. Record separate art-direction, composition, typography, motion, sync and audio verdicts with video_qa record; honest unreviewed criteria remain open.",
  };
  (report as any).evidence=await Promise.all([...frames.map(f=>f.path),sheet].map(async sample=>({path:sample,sha256:await fileDigest(sample,signal)})));
  if(await fileDigest(file,signal)!==identity.video)throw Error('Video changed during QA; analyze the stable final render again');
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify(report, null, 2) + "\n");
  return {...report,reportSha256:await fileDigest(report.report,signal)};
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

export function planNarration(params: any) {
  if (typeof params.text !== "string" || !params.text.trim() || params.text.length > 8000) throw Error("Narration needs text of 1..8000 characters");
  const text = params.text.trim(), display = text.replace(/\s+/g, " ");
  if (estimateSeconds(display) > 120) throw Error("Standalone narration is bounded to about 120 seconds; split the script");
  const lexicon = validateLexicon(params.lexicon), spoken = applyLexicon(text, lexicon);
  if (narrationBackend(params) === 'elevenlabs') {
    if (!elevenStatus().configured) throw Error(elevenStatus().setup);
    const request = speechRequest(params, spoken.text);
    return { text, display, spoken, counts: display.split(' ').map(token => spokenWordCount(token, lexicon)), voice: request.voiceId, style: params.style ?? 'documentary', speed: params.speed ?? 1, backend: 'elevenlabs' };
  }
  const voice = params.voice ?? "en_US-ryan-high", style = params.style ?? "documentary";
  if (!PIPER_VOICES[voice]) throw Error(`Unknown Piper voice ${voice}`);
  if (!VOICE_STYLES[style]) throw Error(`Unknown narration style ${style}`);
  const speed = number(params.speed, 1, 0.6, 1.5, "speed");
  if (!existsSync(piperPython()) || !voiceFiles(voice).every(f => existsSync(f.path))) throw Error(`Piper voice ${voice} is not installed; run narration_tts action:install voice:${voice}`);
  return { text, display, spoken, counts: display.split(" ").map(token => spokenWordCount(token, lexicon)), voice, style, speed };
}

/** Automatic routing may fall back to the local Piper voice for ElevenLabs
 * credential, quota, rate or pre-connect network failures. An explicit
 * backend:"elevenlabs" keeps the provider error. */
const FALLBACK_HTTP = new Set([401, 402, 403, 429]);
const PRE_CONNECT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const PIPER_HINT = 'Piper is not installed; narration_tts action:install sets it up for a local fallback.';
type ElevenFallback = { from: { backend: 'elevenlabs'; status?: number; reason: string }; advice: string };
const automaticBackend = (params: any) => (params.backend ?? 'auto') === 'auto';
const piperReady = (voice: string) => existsSync(piperPython()) && voiceFiles(voice).every(file => existsSync(file.path));
function withPiperHint(error: unknown) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.message = `${failure.message.replace(/\.$/, '')}. ${PIPER_HINT}`;
  return failure;
}
/** Why an automatic ElevenLabs attempt may hand speech to Piper, or undefined.
 * Paid audio already retained for this cache keeps the provider error for recovery. */
async function elevenFallback(error: any, dir: string): Promise<ElevenFallback | undefined> {
  const retained = Boolean(error?.retainedSpeechCache);
  if (retained && (await fs.readdir(dir).catch(() => [] as string[])).some(file => /^speech-[a-f0-9]{64}\.(?:mp3|json|response\.json)$/.test(file))) return undefined;
  const cause = retained ? error.cause : error, status = cause?.providerStatus;
  if (FALLBACK_HTTP.has(status)) return { from: { backend: 'elevenlabs', status, reason: `ElevenLabs returned HTTP ${status}` },
    advice: status === 402 ? 'restore ElevenLabs credits or billing to use ElevenLabs' : status === 429 ? 'wait for ElevenLabs quota or rate limits to clear to use ElevenLabs' : 'configure a valid ELEVENLABS_API_KEY to use ElevenLabs' };
  const code = cause?.cause?.code ?? cause?.cause?.errors?.[0]?.code;
  if (cause instanceof TypeError && PRE_CONNECT.has(code)) return { from: { backend: 'elevenlabs', reason: `ElevenLabs could not be reached (${code})` }, advice: 'restore network access to api.elevenlabs.io to use ElevenLabs' };
  return undefined;
}
async function narrationFallback(params: any, cwd: string, signal: AbortSignal | undefined, progress: Progress | undefined, fallback: ElevenFallback) {
  const delivery = await narrationPiper({ ...params, backend: 'piper', voiceId: undefined, model: undefined }, cwd, signal, progress);
  return { ...delivery, backend: 'piper', fallbackFrom: fallback.from, note: `${fallback.from.reason}, so this narration used the local Piper voice ${delivery.voice}; ${fallback.advice}. ${delivery.note}` };
}

export async function narrationSpeak(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  if (narrationBackend(params) !== 'elevenlabs') return narrationPiper(params, cwd, signal, progress);
  const automatic = automaticBackend(params), voice = params.voice ?? 'en_US-ryan-high';
  if (automatic && !elevenStatus().configured) {
    if (!piperReady(voice)) throw withPiperHint(new Error(elevenStatus().setup));
    return narrationFallback(params, cwd, signal, progress, { from: { backend: 'elevenlabs', reason: 'ElevenLabs is not configured' }, advice: 'set ELEVENLABS_API_KEY to use ElevenLabs' });
  }
  const plan = planNarration(params), dir = await studioFolder(params.outputDir, cwd, 'narration');
  try {
    const made = await elevenSpeech({ ...params, text: plan.spoken.text }, dir, signal, progress);
    const file = path.join(dir, 'narration.wav');
    const mastered = await masterNarration(made.raw, file, signal);
    const seconds = Number((await probe(file, signal)).format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw Error('Standalone narration exceeds 120 seconds; synthesize project scenes instead');
    const words = displayWordTiming(plan.display, made.words, plan.counts);
    const delivery = { ...made, raw: undefined, words, artifact: await produced(file), seconds, captions: await writeSpeechCaptions(dir, plan.display, seconds, words), loudnessLufs: mastered.lufs,
      note: 'ElevenLabs speech, with provider character alignment. Listen to pronunciation and delivery. Captions and cueWords share these spans; provider alignment is not independent transcription.' };
    await fs.rm(made.raw, { force: true });
    await fs.writeFile(path.join(dir, 'narration.json'), JSON.stringify(delivery, null, 2) + '\n'); return delivery;
  } catch (error) {
    const fallback = automatic ? await elevenFallback(error, dir) : undefined;
    if (fallback && piperReady(voice)) { await fs.rm(dir, { recursive: true, force: true }); return narrationFallback(params, cwd, signal, progress, fallback); }
    const retained = await retainedSpeechError(dir, error);
    if (retained) throw fallback ? withPiperHint(retained) : retained;
    await fs.rm(dir, { recursive: true, force: true }); throw fallback ? withPiperHint(error) : error;
  }
}

async function narrationPiper(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const plan = planNarration(params), style = VOICE_STYLES[plan.style];
  signal?.throwIfAborted();
  const dir = await studioFolder(params.outputDir, cwd, "narration"), requestPath = path.join(dir, "request.json");
  try {
    await fs.writeFile(requestPath, JSON.stringify({ model: voiceFiles(plan.voice)[0].path, outDir: dir, threads: Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 3))), lengthScale: style.length / plan.speed, noiseScale: style.noise, noiseW: style.noiseW, sentenceSilence: style.sentence, paragraphSilence: style.paragraph, scenes: [{ id: "voice", text: plan.spoken.text, display: plan.display, counts: plan.counts }] }), { flag: "wx" });
    let result: any;
    await runGuarded(piperPython(), ["-I", VIDEO_PATHS.narrate, requestPath], { cwd: dir, signal, timeoutMs: 180000, nice: 10, onLine: line => { if (line.startsWith("NARRATE_RESULT ")) result = JSON.parse(line.slice(15)); else if (line.startsWith("NARRATE_PROGRESS ")) progress?.("Synthesizing standalone narration"); } });
    const made = result?.scenes?.find((scene: any) => scene.id === "voice");
    if (!made) throw Error("Narration worker returned no speech");
    const raw = path.join(dir, "voice.raw.wav"), file = path.join(dir, "narration.wav");
    const mastered = await masterNarration(raw, file, signal);
    const seconds = Number((await probe(file, signal)).format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw Error("Narration rendered outside the 0..120 second delivery bound");
    const track = captionChunks(plan.display, seconds, 7, 42, made.words).map(chunk => ({ text: chunk.text, start: chunk.start, end: chunk.end }));
    await fs.writeFile(path.join(dir, "captions.srt"), toSrt(track), { flag: "wx" });
    await fs.writeFile(path.join(dir, "captions.vtt"), toVtt(track), { flag: "wx" });
    await fs.rm(raw, { force: true });
    const delivery = { voice: plan.voice, style: plan.style, speed: plan.speed, artifact: await produced(file), seconds, timing: made.exact ? "measured" : "estimated", words: made.words, captions: { srt: path.join(dir, "captions.srt"), vtt: path.join(dir, "captions.vtt") }, loudnessLufs: mastered.lufs, lexiconEdits: plan.spoken.edits, note: "Local Piper speech; listen for intelligibility, pacing and pronunciation. Caption timing is labeled measured or estimated. Use role:voice in audio_mix to duck a music bed." };
    await fs.writeFile(path.join(dir, "narration.json"), JSON.stringify(delivery, null, 2) + "\n", { flag: "wx" });
    signal?.throwIfAborted();
    return delivery;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
  finally { await fs.rm(requestPath, { force: true }); }
}

export async function narrationTts(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const action = params.action ?? "status";
  if (action === 'recover') {
    if (typeof params.dir !== 'string' || !params.dir) throw Error('recover requires dir of the retained narration cache');
    const manifest = await inputFile(path.join(params.dir ?? '', 'speech-request.json'), cwd), dir = path.dirname(manifest);
    const root = await fs.realpath(cwd);
    if (!containsPath(root, dir)) throw Error('Narration recovery cache must be inside the current workspace');
    const denial = selfMutationDenial(manifest, root);
    if (denial) throw Error(denial);
    const made = await elevenRecover(dir, signal, progress);
    return { ...made, artifact: await produced(made.raw), captions: await writeSpeechCaptions(dir, made.words.map(w => w.w).join(' '), made.seconds, made.words), decodeVerified: true,
      note: 'Recovered decoded speech from saved responses only. Use the artifact as a voice track; words/captions describe cached spoken text before display-lexicon mapping. No new generation or mastering occurs.' };
  }
  if (action === "speak") return narrationSpeak(params, cwd, signal, progress);
  let voice = params.voice ?? "en_US-ryan-high";
  if (action === "status") return { ...await piperStatus(), preferredBackend: narrationBackend(params), elevenlabs: elevenStatus() };
  if (action === 'voices') return elevenVoices(signal);
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
  throw new Error("action must be status, voices, install, speak or recover");
}

/** Preserve display spellings after a pronunciation lexicon expands a token. */
export function displayWordTiming(display: string, words: Array<{ w: string; s: number; e: number }>, counts: Array<number | null>) {
  let at = 0;
  const mapped = display.split(/\s+/u).map((w, i) => {
    const length = counts[i] ?? 1, first = words[at], last = words[at + length - 1];
    if (!first || !last) throw Error('Pronunciation lexicon no longer matches aligned word coverage');
    at += length; return { w, s: first.s, e: last.e };
  });
  if (at !== words.length) throw Error('Extra aligned words remain after applying the pronunciation lexicon');
  return mapped;
}

/** Spoken words a display token produces: exact when the lexicon respells it,
 * unknown (null) where the engine expands it (digits, hyphenated compounds, dotted abbreviations). */
function spokenWordCount(token: string, lexicon: Array<[string, string]>): number | null {
  const respelled = applyLexicon(token, lexicon);
  if (respelled.edits) return respelled.text.trim().split(/\s+/).length;
  return /\d|[-–—/]|\w\.\w/.test(token) ? null : 1;
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

/** Standalone local generation reuses the same synthesis script as film audio. */
export async function audioSynthStandalone(params: any, cwd: string, signal?: AbortSignal) {
  const seconds = number(params.seconds, params.kind === 'music' ? 15 : .5, .02, 600, 'seconds');
  if (!['music', 'sfx'].includes(params.kind)) throw Error('kind must be music or sfx');
  if (params.kind === 'sfx' && !SFX_TYPES.includes(params.sfxType)) throw Error('Local SFX needs sfxType: ' + SFX_TYPES.join(', '));
  const dir = await studioFolder(params.outputDir, cwd, 'audio');
  const spec = { kind: params.kind, seconds, brief: typeof params.prompt === "string" ? params.prompt.slice(0, 3000) : undefined, seed: params.seed ?? 7, ...(params.kind === 'music' ? { style: params.style ?? 'focused', bpm: params.bpm } : { type: params.sfxType }) };
  const specPath = path.join(dir, 'synthesis.json'), output = path.join(dir, 'generated.wav');
  try {
    await fs.writeFile(specPath, JSON.stringify(spec));
    const made = await runGuarded('python3', ['-I', VIDEO_PATHS.synth, specPath, output], { cwd, signal, timeoutMs: 300_000, nice: 10, env: { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' } });
    const stats = JSON.parse(made.stdout.trim().split('\n').at(-1) ?? '{}');
    const info = await probe(output, signal);
    if (!info.streams?.some((stream: any) => stream.codec_type === "audio")) throw Error("Local synthesis produced no audio stream");
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(output, 0), '-f', 'null', '-'], signal);
    return { artifact: await produced(output), provider: 'local', model: 'procedural', seconds: Number(info.format?.duration), stats, generationCostUsd: 0, decodeVerified: true, note: 'Style, seed and instrument parameters direct local synthesis; the freeform prompt is retained as a brief, not a semantic music model.' };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
