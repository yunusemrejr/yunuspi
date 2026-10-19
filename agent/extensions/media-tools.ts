/** Local media tools. Fixed operations, bounded subprocesses, no shell or uploads. */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, outputFolder, probe, produced, requireStream, run, windowParams, mediaMap } from "./lib/media-process.ts";
import { composeMusic } from "./lib/music-score.ts";
import { audioMix } from "./lib/media-timeline.ts";
import { videoMotion } from "./lib/video-motion.ts";
import { choices } from "./lib/tool-schema.ts";

export async function mediaInfo(params: any, cwd: string, signal?: AbortSignal) {
  const action = params.action ?? "probe";
  if (action === "capabilities") {
    // One round of subprocesses instead of six sequential spawns. The
    // result shape, error tolerance and abort behavior are unchanged.
    const probeBinary = async (binary: string, flag: string) => {
      try { const r = await run(binary, [flag], signal, 10000); return { available: true, version: r.stdout.split("\n")[0] }; }
      catch (e: any) { if (signal?.aborted) throw e; return { available: false, reason: e.message }; }
    };
    const [ffmpeg, ffprobe, tesseract] = await Promise.all([probeBinary("ffmpeg", "-version"), probeBinary("ffprobe", "-version"), probeBinary("tesseract", "--version")]);
    const binaries: Record<string, any> = { ffmpeg, ffprobe, tesseract };
    const detail: Promise<void>[] = [];
    if (binaries.tesseract.available) detail.push((async () => {
      try {
        const langs = (await run("tesseract", ["--list-langs"], signal, 10000)).stdout;
        binaries.tesseract.languages = langs.split("\n").slice(1).map((s: string) => s.trim()).filter(Boolean).slice(0, 32);
      } catch (error) { if (signal?.aborted) throw error; binaries.tesseract.languages = []; }
    })());
    if (binaries.ffmpeg.available) detail.push((async () => {
      const [filters, encoders] = await Promise.all([
        run("ffmpeg", ["-hide_banner", "-filters"], signal, 10000).then(r => r.stdout),
        run("ffmpeg", ["-hide_banner", "-encoders"], signal, 10000).then(r => r.stdout),
      ]);
      binaries.filters = Object.fromEntries(["scdet", "showinfo", "loudnorm", "silencedetect", "astats", "showspectrumpic", "scale", "fps", "xfade", "concat", "amix", "alimiter", "pan", "afade", "aecho", "aloop", "atempo", "afftdn", "sidechaincompress"].map(x => [x, new RegExp(`\\b${x}\\b`).test(filters)]));
      binaries.encoders = Object.fromEntries(["libx264", "aac", "pcm_s16le", "png"].map(x => [x, new RegExp(`\\b${x}\\b`).test(encoders)]));
    })());
    await Promise.all(detail);
    signal?.throwIfAborted();
    return { ...binaries, musicCompose: { available: true, engine: "built-in MIDI writer and sine/triangle audition synth" } };
  }
  if (action === "motion") return videoMotion(params, cwd, signal);
  if (!["probe", "scenes"].includes(action)) throw new Error("action must be probe, capabilities, scenes or motion");
  const file = await inputFile(params.path, cwd), info = await probe(file, signal);
  if (action === "probe") return { path: file, ...info };
  requireStream(info, "video");
  const { start, duration } = windowParams(params);
  const threshold = number(params.threshold, 10, 0, 100, "threshold");
  const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, start), "-t", String(duration), "-an", "-vf", `scale=320:-2,scdet=threshold=${threshold}`, "-f", "null", "-"], signal);
  const matches = [...r.stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g)];
  return { path: file, window: { start, duration }, threshold, candidates: matches.slice(0, 200).map(m => ({ seconds: start + Number(m[2]), score: Number(m[1]) })), truncated: matches.length > 200, note: "Approximate cut candidates on a 320-pixel proxy; motion, flashes and fades can produce false positives. Times are relative to the source presentation start." };
}

export async function videoFrames(params: any, cwd: string, signal?: AbortSignal) {
  const file = await inputFile(params.path, cwd), info = await probe(file, signal);
  const stream = requireStream(info, "video");
  const width = integer(params.width, 640, 64, 1920, "width");
  const total = Number(info.format?.duration ?? stream.duration);
  let times: number[];
  if (params.times !== undefined) {
    if (!Array.isArray(params.times) || !params.times.length || params.times.length > 12) throw new Error("times accepts 1..12 timestamps in seconds");
    times = params.times.map((t: unknown) => number(t, 0, 0, 86400, "timestamp"));
  } else {
    if (!Number.isFinite(total) || total <= 0) throw new Error("Unknown duration: provide explicit times");
    const count = integer(params.count, 6, 1, 12, "count");
    times = Array.from({ length: count }, (_, i) => total * (i + 0.5) / count);
  }
  if (Number.isFinite(total) && times.some(t => t >= total)) throw new Error("Timestamp is outside the source duration");
  const dir = await outputFolder(params.outputDir, cwd);
  const extract = async (_time: number, index: number, active: AbortSignal) => {
    active.throwIfAborted();
    const output = path.join(dir, `frame-${String(index + 1).padStart(2, "0")}.png`);
    // Fit display aspect ratio (including non-square input pixels) inside
    // the box, then emit square pixels. reset_sar requires newer FFmpeg
    // than Ubuntu LTS supplies; these expressions also work on FFmpeg 6.
    const scale = `scale=w='if(gte(dar,1),${width},max(1,round(${width}*dar)))':h='if(gte(dar,1),max(1,round(${width}/dar)),${width})',setsar=1`;
    const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, times[index]), "-map", `0:${stream.index}`, "-frames:v", "1", "-vf", `${scale},showinfo`, "-update", "1", output], active, 20000);
    const match = /\bn:\s*0\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/.exec(r.stderr);
    return { ...await produced(output), requestedSeconds: times[index], decodedSeconds: match ? times[index] + Number(match[1]) : null };
  };
  try {
    const frames = await mediaMap(times, extract, signal);
    let sheet: any;
    if (params.contactSheet === true) sheet = await contactSheet(frames, dir, signal);
    const result = { source: file, timestampOrigin: "seconds from source presentation start; decodedSeconds adds post-seek PTS and may reflect decoder rounding", frames, ...(sheet ? { contactSheet: sheet } : {}), note: "Sparse frames do not establish continuous motion or events between samples." };
    await fs.writeFile(path.join(dir, "frames.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    signal?.throwIfAborted();
    return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

/** Tile extracted frames into one contact sheet so a single visual read
 * covers the whole sample. Cells are 480 px wide regardless of the
 * extraction width; the grid prefers landscape for video frames. Pure
 * layout: gridForFrames is tested without FFmpeg. */
export function gridForFrames(count: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count) * 16 / 9)));
  return { cols, rows: Math.max(1, Math.ceil(Math.max(1, count) / cols)) };
}

async function contactSheet(frames: any[], dir: string, signal?: AbortSignal) {
  const { cols, rows } = gridForFrames(frames.length);
  const inputs = frames.flatMap(frame => ["-i", frame.path]);
  const scaled = frames.map((_, i) => `[${i}:v]scale=480:-1,setsar=1[x${i}]`).join(";");
  const filter = `${scaled};${frames.map((_, i) => `[x${i}]`).join("")}concat=n=${frames.length}:v=1:a=0[c];[c]tile=${cols}x${rows}:margin=4:padding=4:color=black`;
  const output = path.join(dir, "contact-sheet.png");
  await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", ...inputs, "-filter_complex", filter, "-update", "1", output], signal, 60000);
  return { ...await produced(output), grid: { cols, rows, cellWidth: 480 },
    cells: frames.map((frame, i) => ({ frame: i + 1, row: Math.floor(i / cols), col: i % cols, requestedSeconds: frame.requestedSeconds, decodedSeconds: frame.decodedSeconds })),
    note: "One image for the whole sample: inspect this sheet first and open individual frames only for detail." };
}

export async function audioAnalyze(params: any, cwd: string, signal?: AbortSignal) {
  const file = await inputFile(params.path, cwd), info = await probe(file, signal);
  const stream = requireStream(info, "audio"), { start, duration } = windowParams(params);
  const noise = number(params.silenceDb, -45, -100, -1, "silenceDb");
  const silenceDuration = number(params.silenceDuration, 0.3, 0.05, 10, "silenceDuration");
  const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, start), "-t", String(duration), "-map", `0:${stream.index}`, "-vn", "-af", `silencedetect=noise=${noise}dB:d=${silenceDuration},astats=metadata=0:reset=0,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], signal);
  const raw = /\{\s*"input_i"[^]*?\}/.exec(r.stderr)?.[0];
  if (!raw) throw new Error("No loudness measurements returned (empty or undecodable audio window)");
  const loudness = JSON.parse(raw);
  const measurement = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const overall = r.stderr.split("Overall").at(-1) ?? "";
  const field = (name: string) => measurement(new RegExp(`${name}: ([^\\s]+)`).exec(overall)?.[1]);
  const silence = [...r.stderr.matchAll(/silence_(start|end):\s*([\d.e+-]+)/g)];
  const result: any = {
    source: file, stream: stream.index, window: { start, duration },
    integratedLufs: measurement(loudness.input_i), truePeakDbtp: measurement(loudness.input_tp), loudnessRangeLu: measurement(loudness.input_lra),
    samplePeakDbfs: field("Peak level dB"), rmsDbfs: field("RMS level dB"), dcOffset: field("DC offset"),
    silenceThresholdDb: noise, silenceMinimumSeconds: silenceDuration,
    silenceEvents: silence.slice(0, 200).map(m => ({ event: m[1], seconds: start + Number(m[2]) })), truncated: silence.length > 200,
    note: "Measurements cover only the requested window. Null means undefined/nonfinite, often silence or insufficient duration. Silence thresholds do not detect speech; no transcription, key or tempo inference is performed.",
  };
  if (params.spectrum === true) {
    const dir = await outputFolder(params.outputDir, cwd), output = path.join(dir, "spectrum.png");
    try {
      await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", ...inputArgs(file, start), "-filter_complex", `[0:${stream.index}]atrim=duration=${duration},asetpts=PTS-STARTPTS,showspectrumpic=s=1200x600:legend=1:scale=log:fscale=log[v]`, "-map", "[v]", "-frames:v", "1", "-update", "1", output], signal);
      result.spectrum = await produced(output);
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
  }
  return result;
}

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const windowSchema = { start: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })), duration: Type.Optional(Type.Number({ minimum: 0.05, maximum: 600, description: "Window seconds; default 30, maximum 600" })) };
const outputSchema = { outputDir: Type.Optional(localPath) };

export default function mediaTools(pi: any) {
  function register(name: string, description: string, parameters: any, handler: any) {
    pi.registerTool({ name, label: name.replaceAll("_", " "), description, parameters,
      async execute(_id: any, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
        // One deadline also covers multi-pass edits and sequential frame extraction.
        const deadline = AbortSignal.timeout(180000);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const result = await handler(params, ctx?.cwd || process.cwd(), bounded);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  register("media_info", "Probe streams, capabilities or scene cuts. motion decodes every frame in up to 30 seconds/1800 frames without resampling: original timestamp cadence, low-change holds and optional last→first loop boundary. expectedFps checks the export clock. Compact technical evidence; pixel change cannot approve motion aesthetics. No uploads. Probe is the default action.", Type.Object({ action: Type.Optional(choices(["probe", "capabilities", "scenes", "motion"])), path: Type.Optional(localPath), ...windowSchema, threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })), loop: Type.Optional(Type.Boolean({ description: "motion: compare last→first decoded frames; window must cover the intended loop" })), expectedFps: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "motion: requested export clock; differing cadence becomes a failure" })) }), mediaInfo);
  register("video_frames", "Extract 1..12 PNG frames at explicit seconds or evenly spaced timestamps (default 6). Returns frame paths and timing manifest. contactSheet:true also writes one tiled contact-sheet.png with a cell map: inspect that single image first instead of opening every frame. Fresh output folder inside cwd; originals preserved. Use read/vision to inspect returned images.", Type.Object({ path: localPath, times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 86400 }), { minItems: 1, maxItems: 12 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), contactSheet: Type.Optional(Type.Boolean()), ...outputSchema }), videoFrames);
  register("audio_analyze", "Measure windowed LUFS, true/sample peak, RMS, DC offset and silence; optionally render a spectrum PNG. Default first 30 seconds, maximum 600. Numeric evidence, no speech transcription or music recognition.", Type.Object({ path: localPath, ...windowSchema, silenceDb: Type.Optional(Type.Number({ minimum: -100, maximum: -1 })), silenceDuration: Type.Optional(Type.Number({ minimum: 0.05, maximum: 10 })), spectrum: Type.Optional(Type.Boolean()), ...outputSchema }), audioAnalyze);
  const note = Type.Object({ pitch: Type.Integer({ minimum: 0, maximum: 127 }), start: Type.Number({ minimum: 0, maximum: 256 }), duration: Type.Number({ minimum: 1 / 480, maximum: 256 }), velocity: Type.Optional(Type.Integer({ minimum: 1, maximum: 127 })) });
  const scoreTrack = Type.Object({ name: Type.Optional(Type.String({ maxLength: 64 })), program: Type.Optional(Type.Integer({ minimum: 0, maximum: 127 })), percussion: Type.Optional(Type.Boolean({ description: "One optional drum track on GM channel 10; pitch selects the drum. Requires a SoundFont drum bank." })), waveform: Type.Optional(choices(["sine", "triangle", "square", "saw"])), pan: Type.Optional(Type.Number({ minimum: -1, maximum: 1, description: "Stereo position, -1 left to +1 right; applies when score stereo is true" })), notes: Type.Array(note, { minItems: 1, maxItems: 1024 }) });
  const scoreSchema = Type.Object({ bpm: Type.Optional(Type.Number({ minimum: 30, maximum: 300 })), beats: Type.Optional(Type.Number({ minimum: 1, maximum: 256 })), numerator: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })), denominator: Type.Optional(choices([2, 4, 8, 16])), stereo: Type.Optional(Type.Boolean()), tracks: Type.Array(scoreTrack, { minItems: 1, maxItems: 8 }) });
  const scoreRender = { backend: Type.Optional(choices(["auto", "soundfont", "oscillator"])), soundfont: Type.Optional(localPath), releaseTail: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "SoundFont release tail seconds; default 1.5" })) };
  register("music_compose", "Render your score to editable type-1 MIDI and JSON plus WAV. auto prefers real stereo SoundFont instruments when soundfont or YUNUSPI_SOUNDFONT is configured; otherwise returns an explicitly labeled oscillator audition. soundfont needs local SF2/SF3 and libfluidsynth, preserves instrument programs/pan/note timing with release tails, and fails explicitly if unavailable. One percussion:true track uses GM drum channel 10 and requires a SoundFont drum bank. No uploads or bank downloads. Quarter-note beats, zero-based GM programs. At most 8 tracks, 1024 notes, 120 score seconds; no same-pitch overlap within a track.", Type.Object({ score: scoreSchema, ...scoreRender, ...outputSchema }), composeMusic);
  const audioTrack = Type.Object({ path: localPath, start: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })), at: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), duration: Type.Optional(Type.Number({ minimum: 0.01, maximum: 120 })), gain: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })), pan: Type.Optional(Type.Number({ minimum: -1, maximum: 1, description: 'Stereo balance: -1 left, 0 unchanged, +1 right' })), fadeIn: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), fadeOut: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), highpass: Type.Optional(Type.Number({ minimum: 20, maximum: 5000 })), lowpass: Type.Optional(Type.Number({ minimum: 200, maximum: 20000 })), delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 500, description: 'Single bounded echo; tails trimmed to track duration' })), role: Type.Optional(choices(['voice', 'music', 'effect'], 'Voice/music roles activate signal-driven ducking by default; otherwise effect')), loop: Type.Optional(Type.Boolean({ description: 'Repeat the source remainder to fill duration (music beds); defaults false' })), speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2, description: 'Pitch-preserving tempo multiplier; duration is rendered seconds' })), denoise: Type.Optional(Type.Number({ minimum: 0, maximum: 30, description: 'FFT noise reduction in dB, 0 disables; use lightly to avoid speech artifacts' })) });
  const mastering = { ducking: Type.Optional(Type.Union([Type.Boolean(), Type.Object({ thresholdDb: Type.Optional(Type.Number({ minimum: -50, maximum: -6 })), ratio: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })), attackMs: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })), releaseMs: Type.Optional(Type.Number({ minimum: 20, maximum: 2000 })) })], { description: 'Music ducks from voice signal automatically when both roles exist. false disables; true/options require both roles. Included clip audio is treated as voice.' })), targetLufs: Type.Optional(Type.Number({ minimum: -36, maximum: -8, description: 'Optional two-pass mastering; delivered encoding is remeasured. Silence is preserved.' })) };
  register('audio_mix', 'Edit/mix 1..8 local tracks into stereo 48kHz WAV: offsets, trims, looping, pitch-preserving speed, FFT denoise, gain/balance, fades, filters, short echo and sample-peak limiting. role:voice and role:music activate signal-driven music ducking; optional targetLufs masters in two passes and measures the delivered file. At most 120 seconds, default 30; fresh outputs preserve originals.', Type.Object({ tracks: Type.Array(audioTrack, { minItems: 1, maxItems: 8 }), duration: Type.Optional(Type.Number({ minimum: 0.1, maximum: 120 })), ...mastering, ...outputSchema }), audioMix);
}
