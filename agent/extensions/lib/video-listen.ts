/** Objective listen check for a delivered video or audio master. Local speech
 * recognition (faster-whisper through agent/scripts/asr-listen.py) proves the
 * narration is intelligible and measures how far it sits above the music; EBU
 * R128 measures loudness and true peak. Machine listening stands in for a human
 * ear: it does not judge voice timbre or music taste. Nothing is installed or
 * downloaded here. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { FFMPEG_FLAGS, inputArgs, inputFile, number, probe, run } from "./media-process.ts";
import { runGuarded, throttled, type Progress } from "./guarded-process.ts";
import { fileDigest } from "./video-segments.ts";
import { parseQaLog } from "./video-studio.ts";

export const LISTEN_FORMAT = "yunuspi-listen-v1";
export const ASR_MODELS = ["small.en", "base.en", "medium", "large-v3-turbo"] as const;
export const DEFAULT_ASR_MODEL = "small.en";
/** Pass/fail limits. Changing one changes every verdict built from it; say so in the report. */
export const LISTEN_THRESHOLDS = {
  werMax: 0.15,              // word error rate of the transcript against the script
  meanLogprobMin: -0.6,      // ASR mean log-probability, used only when no script is given
  speechOverMusicDbMin: 10,  // narration RMS minus music RMS over voiced narration (stems)
  speechOverBedDbMin: 8,     // estimate from the master alone (speech windows vs gaps)
  loudnessToleranceLu: 1.5,  // |integrated loudness - target|
  truePeakMaxDbtp: -1,       // true peak ceiling
  voicedDbfs: -45,           // a narration frame counts as voiced above this level
  bedSilenceDbfs: -60,       // gap frames at or below this are silence, not a music bed
  gapSeconds: 0.5,           // minimum wordless gap used for the bed estimate
} as const;
export type ListenThresholds = Record<keyof typeof LISTEN_THRESHOLDS, number>;
const THRESHOLDS: ListenThresholds = { ...LISTEN_THRESHOLDS };
export const LISTEN_NOTE = "Machine listening: speech recognition and loudness measurements stand in for human listening; they do not judge voice timbre or music taste.";

const ANALYSIS_RATE = 16000;
const FRAME_SECONDS = 0.05;
const LISTEN_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/asr-listen.py");
const PROGRESS_PREFIX = "LISTEN_PROGRESS ";
const RESULT_PREFIX = "LISTEN_RESULT ";
const ERROR_PREFIX = "LISTEN_ERROR ";
const INSTALL_HINT = "Speech recognition is not installed. Create it once with: python3 -m venv ~/.pi/agent/local-models/asr/venv && ~/.pi/agent/local-models/asr/venv/bin/pip install faster-whisper==1.2.1 (or set PI_ASR_PYTHON to a Python that has faster_whisper).";

export type ListenFinding = { severity: "error" | "warning"; message: string };
export type ListenMeasurements = {
  wer: number | null;
  meanLogprob: number | null;
  /** Present (even if null) when narration and music stems were measured. */
  speechOverMusicDb?: number | null;
  /** Present (even if null) when the master alone was estimated. */
  speechOverBedDb?: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  targetLufs: number;
  numberNotes?: string[];
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const toDb = (power: number) => 10 * Math.log10(Math.max(power, 1e-12));

const SPOKEN_KEYS = ["spoken", "narration", "text", "line", "display", "script", "caption"];
const CONTAINER_KEYS = ["scenes", "lines", "segments", "items"];

/** Lowercase, drop apostrophes, split on anything that is not a letter or digit. */
export function normalizeWords(text: string): string[] {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/['’`]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Spoken text of a narration file: plain text as-is, or a JSON structure whose
 * scenes/lines/text/narration/display fields hold the lines to be spoken. */
function scriptStrings(value: unknown, out: string[], spoken = false): void {
  if (typeof value === "string") { if (spoken) out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) scriptStrings(item, out, spoken); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const key = SPOKEN_KEYS.find((k) => typeof record[k] === "string" || Array.isArray(record[k]));
  if (key) { scriptStrings(record[key], out, true); return; }
  for (const [k, child] of Object.entries(record)) {
    if (CONTAINER_KEYS.includes(k)) scriptStrings(child, out, true);
    else if (child && typeof child === "object") scriptStrings(child, out, false);
  }
}

export function scriptWords(fileText: string, fileName: string): string[] {
  if (!/\.json$/i.test(fileName)) return normalizeWords(fileText);
  let parsed: unknown;
  try { parsed = JSON.parse(fileText); } catch { throw new Error(`${path.basename(fileName)} is not valid JSON`); }
  const lines: string[] = [];
  scriptStrings(parsed, lines, Array.isArray(parsed)); // a bare array of strings is a list of lines
  if (!lines.length) throw new Error(`${path.basename(fileName)} has no narration text (expected scenes, lines or text fields)`);
  return normalizeWords(lines.join(" "));
}

/** Word error rate: word-level Levenshtein distance divided by the script length. */
export function wordErrorRate(expected: string[], actual: string[]): number {
  if (!expected.length) return actual.length ? 1 : 0;
  let prev = Array.from({ length: actual.length + 1 }, (_, j) => j);
  for (let i = 1; i <= expected.length; i++) {
    const cur = [i];
    for (let j = 1; j <= actual.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[actual.length] / expected.length;
}

/** Digits in the script that the transcript does not contain. Reported, never failed on its own. */
export function numberNotes(expected: string[], actual: string[]): string[] {
  const heard = new Set(actual);
  return expected.filter((w) => /^\d+$/.test(w) && !heard.has(w)).slice(0, 10)
    .map((w) => `"${w}" in the script is not in the transcript (speech recognition may have spelled the number out); not a failure on its own`);
}

/** Pure verdicts from measurements. Boundaries are inclusive except the ASR log-probability floor. */
export function listenVerdicts(m: ListenMeasurements, thresholds: Partial<ListenThresholds> = {}) {
  const t: ListenThresholds = { ...THRESHOLDS, ...thresholds };
  const findings: ListenFinding[] = [];
  const add = (severity: ListenFinding["severity"], message: string) => findings.push({ severity, message });
  const pct = (v: number) => `${round(v * 100, 1)}%`;

  // Intelligibility: the script decides when there is one; otherwise ASR confidence.
  let intelligible: boolean;
  if (m.wer == null) {
    intelligible = m.meanLogprob !== null && m.meanLogprob > t.meanLogprobMin;
    if (!intelligible) {
      add("error", m.meanLogprob == null
        ? "Speech recognition produced no words from the master, so the narration is not intelligible. Check that the narration is audible and not muted, and re-render."
        : `Speech recognition confidence is low (mean log-probability ${round(m.meanLogprob, 3)}, minimum ${t.meanLogprobMin}) and no script was given to compare against. Raise the narration above the music (see balance) and re-render, or pass the script for a word-level check.`);
    }
  } else {
    intelligible = m.wer <= t.werMax;
    if (!intelligible) {
      add("error", `Transcript word error rate is ${pct(m.wer)} against the script (limit ${pct(t.werMax)}): the narration is not intelligible to speech recognition or does not say the script. Raise the narration above the music, check the narration voice and level, and re-render.`);
    }
  }
  for (const note of m.numberNotes ?? []) add("warning", note);

  // Balance: narration over music (stems) or over the bed estimated from the master.
  const stems = m.speechOverMusicDb !== undefined;
  const balanceValue = stems ? m.speechOverMusicDb ?? null : m.speechOverBedDb ?? null;
  const balanceMin = stems ? t.speechOverMusicDbMin : t.speechOverBedDbMin;
  const balanced = balanceValue !== null && balanceValue >= balanceMin;
  const bedLabel = stems ? "music" : "music bed";
  if (balanceValue === null) {
    add("error", stems
      ? "Speech over music could not be measured: the narration stem has no voiced windows above -45 dBFS. Check that the narration stem contains speech."
      : "Speech over the bed could not be estimated: the master has no word spans or no wordless gap of at least 0.5 s with sound in it. Supply the narration and music stems for an exact check.");
  } else if (!balanced) {
    const duck = Math.ceil(balanceMin - balanceValue);
    add("error", `Narration sits only ${round(balanceValue, 2)} dB above the ${bedLabel}${stems ? "" : " (estimated from the master)"}; it needs ${balanceMin} dB. Duck the music at least ${duck} dB under narration (sidechain compression or volume automation over the voiced windows) and re-master.`);
  }

  // Loudness and true peak.
  const target = m.targetLufs;
  const integratedOk = m.integratedLufs !== null && Math.abs(m.integratedLufs - target) <= t.loudnessToleranceLu;
  const peakOk = m.truePeakDbtp !== null && m.truePeakDbtp <= t.truePeakMaxDbtp;
  const loudnessOk = integratedOk && peakOk;
  if (m.integratedLufs === null) {
    add("error", "Integrated loudness could not be measured (EBU R128 produced no summary). Check that the master has an audio stream.");
  } else if (!integratedOk) {
    add("error", `Integrated loudness is ${round(m.integratedLufs, 1)} LUFS, ${round(Math.abs(m.integratedLufs - target), 1)} LU from the ${target} LUFS target (tolerance ${t.loudnessToleranceLu} LU). Re-master the delivery to ${target} LUFS with loudnorm and check again.`);
  }
  if (m.truePeakDbtp === null) {
    add("error", "True peak could not be measured (EBU R128 produced no true-peak value).");
  } else if (!peakOk) {
    add("error", `True peak is ${round(m.truePeakDbtp, 1)} dBTP, above the ${t.truePeakMaxDbtp} dBTP ceiling. Re-master with a true-peak limiter at -1.5 dBTP and check again.`);
  }

  const order = { error: 0, warning: 1 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { intelligible, balanced, loudnessOk, passed: intelligible && balanced && loudnessOk, balanceMode: stems ? "stems" as const : "estimate" as const, findings, thresholds: t };
}

/** Narration over music from two stems on the same timeline. Frames are the
 * narration's voiced 50 ms frames (above voicedDbfs); both inputs are mean-square
 * power per frame. Returns null when the narration has no voiced frames. */
export function speechOverMusicDb(narration: ArrayLike<number>, music: ArrayLike<number>, voicedDbfs = THRESHOLDS.voicedDbfs): number | null {
  const gate = 10 ** (voicedDbfs / 10);
  const n = Math.min(narration.length, music.length);
  let speech = 0, bed = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (narration[i] > gate) { speech += narration[i]; bed += music[i]; count++; }
  }
  if (!count) return null;
  return round(toDb(speech / count) - toDb(bed / count));
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Estimate from the master alone: mean power inside word spans minus mean power in
 * wordless gaps of at least gapSeconds (gap frames at or below bedSilenceDbfs are
 * digital silence, not a bed, and are excluded). Returns db null when either side is empty. */
export function speechOverBedDb(master: ArrayLike<number>, spans: Array<[number, number]>, duration: number, frameSeconds = FRAME_SECONDS) {
  const frames = master.length;
  const label = new Uint8Array(frames); // 1 = speech window, 2 = wordless gap
  const mark = (s: number, e: number, value: number) => {
    const from = Math.max(0, Math.ceil(s / frameSeconds - 0.5));
    const to = Math.min(frames - 1, Math.ceil(e / frameSeconds - 0.5) - 1);
    for (let i = from; i <= to; i++) label[i] = value;
  };
  const speech = mergeSpans(spans.filter(([s, e]) => e > s));
  for (const [s, e] of speech) mark(s, e, 1);
  let cursor = 0;
  const limit = Math.min(duration, frames * frameSeconds);
  for (const [s, e] of [...speech, [limit, limit] as [number, number]]) {
    if (s - cursor >= THRESHOLDS.gapSeconds) mark(cursor, s, 2);
    cursor = Math.max(cursor, e);
  }
  const silence = 10 ** (THRESHOLDS.bedSilenceDbfs / 10);
  let speechSum = 0, speechFrames = 0, bedSum = 0, bedFrames = 0, silentGapFrames = 0;
  for (let i = 0; i < frames; i++) {
    if (label[i] === 1) { speechSum += master[i]; speechFrames++; }
    else if (label[i] === 2) {
      if (master[i] > silence) { bedSum += master[i]; bedFrames++; } else silentGapFrames++;
    }
  }
  const db = speechFrames && bedFrames ? round(toDb(speechSum / speechFrames) - toDb(bedSum / bedFrames)) : null;
  return { db, speechFrames, bedFrames, silentGapFrames };
}

/** Mean-square power per 50 ms frame of the first audio stream, mono 16 kHz, streamed
 * from ffmpeg so a long master never needs its full PCM in memory. */
export async function frameMeanSquare(file: string, signal?: AbortSignal, timeoutMs = 300_000): Promise<Float64Array> {
  const frame = Math.round(ANALYSIS_RATE * FRAME_SECONDS);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [...FFMPEG_FLAGS, "-v", "error", ...inputArgs(file, 0), "-map", "0:a:0", "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
      { stdio: ["ignore", "pipe", "pipe"], signal, timeout: timeoutMs, env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" } });
    const frames: number[] = [];
    let leftover = Buffer.alloc(0), sum = 0, count = 0, stderr = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(Float64Array.from(frames));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const bytes = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = bytes.length - (bytes.length % 4);
      leftover = Buffer.from(bytes.subarray(usable));
      const samples = new Float32Array(new Uint8Array(bytes.buffer, bytes.byteOffset, usable).slice().buffer);
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
        if (++count === frame) { frames.push(sum / frame); sum = 0; count = 0; }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.on("error", (error: any) => finish(error.code === "ENOENT" ? new Error("ffmpeg is not installed or not on PATH") : error));
    child.on("close", (code) => {
      if (signal?.aborted) return finish(new Error("Listen check cancelled"));
      if (code !== 0) return finish(new Error(`ffmpeg could not decode ${path.basename(file)}: ${stderr.trim().slice(-600) || `exit ${code}`}`));
      finish();
    });
  });
}

// Python resolution: an explicit interpreter, then the local ASR venv. Nothing is installed.
const probeCache = new Map<string, Promise<boolean>>();
/** Forget cached import probes (tests, or after installing faster-whisper in a running session). */
export function resetListenProbeCache() { probeCache.clear(); }
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const asrVenvPython = () => path.join(agentDir(), "local-models", "asr", "venv", "bin", "python");

function canImportFasterWhisper(python: string, cwd: string): Promise<boolean> {
  if (!existsSync(python)) return Promise.resolve(false);
  let cached = probeCache.get(python);
  if (!cached) {
    cached = runGuarded(python, ["-I", "-c", "import faster_whisper"], { cwd, timeoutMs: 60_000, guard: false }).then(() => true, () => false);
    probeCache.set(python, cached);
  }
  return cached;
}

export async function listenPython(cwd: string): Promise<string> {
  const candidates = [process.env.PI_ASR_PYTHON, asrVenvPython()].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (await canImportFasterWhisper(candidate, cwd)) return candidate;
  }
  throw new Error(INSTALL_HINT);
}

const transcriptText = (raw: any) => String(raw?.text ?? "");

export async function videoListen(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  signal?.throwIfAborted();
  const file = await inputFile(params?.path, cwd);
  const narrationFile = params.narration ? await inputFile(params.narration, cwd) : undefined;
  const musicFile = params.music ? await inputFile(params.music, cwd) : undefined;
  if (Boolean(narrationFile) !== Boolean(musicFile)) throw new Error("Give both narration and music stems for an exact speech-over-music check, or neither to estimate the balance from the master");
  const model = params.model ?? DEFAULT_ASR_MODEL;
  if (!(ASR_MODELS as readonly string[]).includes(model)) throw new Error(`model must be one of ${ASR_MODELS.join(", ")}`);
  const language = params.language === undefined ? "en" : params.language;
  if (language !== null && !(typeof language === "string" && /^[a-z]{2,3}$/.test(language))) throw new Error("language must be a two or three letter code such as \"en\", or null");
  const targetLufs = number(params.targetLufs, -16, -40, -5, "targetLufs");

  let script: { file: string; words: string[]; sha256: string } | undefined;
  if (params.script) {
    const scriptFile = await inputFile(params.script, cwd);
    if (!/\.(txt|md|json)$/i.test(scriptFile)) throw new Error("script must be a .txt, .md or narration .json file");
    const words = scriptWords(await fs.readFile(scriptFile, "utf8"), scriptFile);
    if (!words.length) throw new Error("script has no words to compare against");
    script = { file: scriptFile, words, sha256: await fileDigest(scriptFile, signal) };
  }

  const python = await listenPython(cwd);
  const info = await probe(file, signal);
  if (!info.streams?.some((s: any) => s.codec_type === "audio")) throw new Error("Input has no audio stream; there is nothing to listen to");
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Unknown master duration");

  // Speech recognition: the helper writes the full result to a private file; its stdout
  // line is bounded by runGuarded and only used when the file is missing.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `yunuspi-listen-${randomBytes(4).toString("hex")}-`));
  const requestPath = path.join(scratch, "request.json"), resultFile = path.join(scratch, "result.json");
  const report = throttled(progress, 2000);
  let errorLine: string | undefined, resultLine: string | undefined;
  try {
    await fs.writeFile(requestPath, JSON.stringify({ audio: file, model, language, speechWindows: true, resultFile }), { mode: 0o600, flag: "wx" });
    progress?.(`Transcribing the master with ${model} (speech recognition runs locally)`);
    const timeoutMs = Math.min(1_800_000, 180_000 + duration * 3_000);
    await runGuarded(python, ["-I", LISTEN_SCRIPT, requestPath], {
      cwd: scratch, signal, timeoutMs, nice: 10,
      env: { OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" },
      onLine: (line) => {
        if (line.startsWith(PROGRESS_PREFIX)) report(line.slice(PROGRESS_PREFIX.length));
        else if (line.startsWith(ERROR_PREFIX)) errorLine = line.slice(ERROR_PREFIX.length);
        else if (line.startsWith(RESULT_PREFIX)) resultLine = line.slice(RESULT_PREFIX.length);
      },
    }).catch((error: unknown) => {
      if (errorLine) throw new Error(`Speech recognition failed: ${errorLine}`);
      throw error;
    });
    let raw: any;
    try {
      raw = JSON.parse(existsSync(resultFile) ? await fs.readFile(resultFile, "utf8") : resultLine ?? "null");
    } catch {
      throw new Error("Speech recognition result could not be read (empty or truncated)");
    }
    if (!raw || typeof raw !== "object") throw new Error("Speech recognition returned no result");

    const transcript = transcriptText(raw);
    const asrWords = normalizeWords(transcript);
    const wer = script ? wordErrorRate(script.words, asrWords) : null;
    const notes = script ? numberNotes(script.words, asrWords) : [];

    // Loudness (EBU R128 integrated, loudness range, true peak) on the master.
    progress?.("Measuring loudness and true peak (EBU R128)");
    const analysis = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, 0), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], signal, Math.round(Math.min(3_600_000, 60_000 + duration * 4000)));
    const qa = parseQaLog(`${analysis.stdout}\n${analysis.stderr}`, duration);

    // Balance: stems give an exact narration-over-music figure; the master alone gives an estimate.
    let stemsBalance: { speechOverMusicDb: number | null } | undefined;
    let bedBalance: { db: number | null; speechFrames: number; bedFrames: number; silentGapFrames: number } | undefined;
    if (narrationFile && musicFile) {
      progress?.("Measuring speech over music from the narration and music stems");
      const narration = await frameMeanSquare(narrationFile, signal);
      const music = await frameMeanSquare(musicFile, signal);
      stemsBalance = { speechOverMusicDb: speechOverMusicDb(narration, music) };
    } else {
      progress?.("Estimating speech over the music bed from the master");
      const master = await frameMeanSquare(file, signal);
      const windows: Array<[number, number]> = Array.isArray(raw.speechWindows)
        ? raw.speechWindows.map((w: number[]) => [Number(w[0]), Number(w[1])] as [number, number])
        : (raw.words ?? []).map((w: any) => [Number(w.s), Number(w.e)] as [number, number]);
      bedBalance = speechOverBedDb(master, windows, duration);
    }

    const measurements: ListenMeasurements = {
      wer,
      meanLogprob: typeof raw.meanLogprob === "number" ? raw.meanLogprob : null,
      ...(stemsBalance ? { speechOverMusicDb: stemsBalance.speechOverMusicDb } : { speechOverBedDb: bedBalance?.db ?? null }),
      integratedLufs: qa.integratedLufs,
      truePeakDbtp: qa.truePeak,
      targetLufs,
      numberNotes: notes,
    };
    const verdict = listenVerdicts(measurements);
    const sha256 = await fileDigest(file, signal);
    const createdAt = new Date().toISOString();
    const reportPath = path.join(path.dirname(file), `${path.basename(file)}.listen.json`);
    const balanceValue = stemsBalance ? stemsBalance.speechOverMusicDb : bedBalance?.db ?? null;
    const full = {
      format: LISTEN_FORMAT,
      createdAt,
      path: file,
      sha256,
      durationSeconds: round(duration, 3),
      stems: narrationFile && musicFile ? {
        narration: { path: narrationFile, sha256: await fileDigest(narrationFile, signal) },
        music: { path: musicFile, sha256: await fileDigest(musicFile, signal) },
      } : null,
      script: script ? { path: script.file, sha256: script.sha256, wordCount: script.words.length } : null,
      model: raw.model ?? model,
      language: raw.language ?? language,
      transcript: {
        text: transcript,
        wordCount: asrWords.length,
        meanLogprob: measurements.meanLogprob,
        speechSeconds: raw.speechSeconds ?? null,
        segments: raw.segments ?? [],
        words: raw.words ?? [],
        wordsTruncated: Boolean(raw.wordsTruncated),
      },
      measurements: {
        wer: wer === null ? null : round(wer, 4),
        scriptWordCount: script?.words.length ?? null,
        transcriptWordCount: asrWords.length,
        speechOverMusicDb: stemsBalance ? stemsBalance.speechOverMusicDb : undefined,
        speechOverBedDb: bedBalance ? { db: bedBalance.db, speechFrames: bedBalance.speechFrames, bedFrames: bedBalance.bedFrames, silentGapFrames: bedBalance.silentGapFrames } : undefined,
        balanceValueDb: balanceValue,
        integratedLufs: qa.integratedLufs,
        truePeakDbtp: qa.truePeak,
        loudnessRange: qa.loudnessRange,
        targetLufs,
      },
      verdicts: { intelligible: verdict.intelligible, balanced: verdict.balanced, loudnessOk: verdict.loudnessOk, passed: verdict.passed, balanceMode: verdict.balanceMode },
      findings: verdict.findings,
      thresholds: verdict.thresholds,
      note: LISTEN_NOTE,
    };
    await fs.writeFile(reportPath, `${JSON.stringify(full, null, 2)}\n`);

    return {
      path: file,
      report: reportPath,
      sha256,
      transcriptPreview: transcript.slice(0, 600),
      wer: wer === null ? null : round(wer, 4),
      meanLogprob: measurements.meanLogprob,
      loudness: { integratedLufs: qa.integratedLufs, truePeakDbtp: qa.truePeak, lra: qa.loudnessRange },
      ...(stemsBalance ? { speechOverMusicDb: stemsBalance.speechOverMusicDb } : { speechOverBedDb: bedBalance?.db ?? null }),
      intelligible: verdict.intelligible,
      balanced: verdict.balanced,
      loudnessOk: verdict.loudnessOk,
      passed: verdict.passed,
      findings: verdict.findings,
      note: LISTEN_NOTE,
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
