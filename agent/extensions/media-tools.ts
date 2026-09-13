/** Local media tools. Fixed operations, bounded subprocesses, no shell or uploads. */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, outputFolder, probe, produced, requireStream, run, windowParams } from "./lib/media-process.ts";
import { composeMusic } from "./lib/music-score.ts";

export async function mediaInfo(params: any, cwd: string, signal?: AbortSignal) {
  const action = params.action ?? "probe";
  if (action === "capabilities") {
    const binaries: Record<string, any> = {};
    for (const binary of ["ffmpeg", "ffprobe"]) {
      try { const r = await run(binary, ["-version"], signal, 10000); binaries[binary] = { available: true, version: r.stdout.split("\n")[0] }; }
      catch (e: any) { if (signal?.aborted) throw e; binaries[binary] = { available: false, reason: e.message }; }
    }
    if (binaries.ffmpeg.available) {
      const filters = (await run("ffmpeg", ["-hide_banner", "-filters"], signal, 10000)).stdout;
      const encoders = (await run("ffmpeg", ["-hide_banner", "-encoders"], signal, 10000)).stdout;
      binaries.filters = Object.fromEntries(["scdet", "showinfo", "loudnorm", "silencedetect", "astats", "showspectrumpic", "scale", "fps"].map(x => [x, new RegExp(`\\b${x}\\b`).test(filters)]));
      binaries.encoders = Object.fromEntries(["libx264", "aac", "pcm_s16le", "png"].map(x => [x, new RegExp(`\\b${x}\\b`).test(encoders)]));
    }
    return { ...binaries, musicCompose: { available: true, engine: "built-in MIDI writer and sine/triangle audition synth" } };
  }
  if (!["probe", "scenes"].includes(action)) throw new Error("action must be probe, capabilities or scenes");
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
  const dir = await outputFolder(params.outputDir, cwd), frames: any[] = [];
  try {
    for (let i = 0; i < times.length; i++) {
      signal?.throwIfAborted();
      const output = path.join(dir, `frame-${String(i + 1).padStart(2, "0")}.png`);
      const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, times[i]), "-map", `0:${stream.index}`, "-frames:v", "1", "-vf", `scale=${width}:${width}:force_original_aspect_ratio=decrease:reset_sar=1,showinfo`, "-update", "1", output], signal, 20000);
      const match = /\bn:\s*0\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/.exec(r.stderr);
      frames.push({ ...await produced(output), requestedSeconds: times[i], decodedSeconds: match ? times[i] + Number(match[1]) : null });
    }
    const result = { source: file, timestampOrigin: "seconds from source presentation start; decodedSeconds adds post-seek PTS and may reflect decoder rounding", frames, note: "Sparse frames do not establish continuous motion or events between samples." };
    await fs.writeFile(path.join(dir, "frames.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
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

export async function mediaEdit(params: any, cwd: string, signal?: AbortSignal) {
  const action = params.action;
  if (!["clip", "audio", "normalize"].includes(action)) throw new Error("action must be clip, audio or normalize");
  const file = await inputFile(params.path, cwd), info = await probe(file, signal);
  const { start, duration } = windowParams(params);
  const video = action === "clip" ? requireStream(info, "video") : undefined;
  const audio = action === "clip" ? info.streams?.find((s: any) => s.codec_type === "audio") : requireStream(info, "audio");
  const rate = integer(params.sampleRate, 48000, 8000, 96000, "sampleRate");
  const width = integer(params.width, 1280, 64, 3840, "width");
  if (width % 2) throw new Error("width must be even");
  const crf = integer(params.crf, 20, 0, 40, "crf");
  const target = number(params.targetLufs, -16, -36, -5, "targetLufs");
  let filter = "", normalization: any;
  if (action === "normalize") {
    const measured = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, start), "-t", String(duration), "-map", `0:${audio.index}`, "-vn", "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], signal);
    const raw = /\{\s*"input_i"[^]*?\}/.exec(measured.stderr)?.[0];
    if (!raw) throw new Error("Normalization measurement failed");
    const m = JSON.parse(raw);
    for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) if (!Number.isFinite(Number(m[key]))) throw new Error("Cannot normalize silent/undefined loudness");
    filter = `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${Number(m.input_i)}:measured_TP=${Number(m.input_tp)}:measured_LRA=${Number(m.input_lra)}:measured_thresh=${Number(m.input_thresh)}:offset=${Number(m.target_offset)}:linear=true:print_format=json`;
  }
  const dir = await outputFolder(params.outputDir, cwd), output = path.join(dir, video ? "edit.mp4" : "audio.wav");
  try {
    const args = [...FFMPEG_FLAGS, "-loglevel", filter ? "info" : "error", ...inputArgs(file, start), "-t", String(duration)];
    if (video) {
      // Basic SDR delivery only. A dedicated color-managed workflow owns HDR.
      if (["smpte2084", "arib-std-b67"].includes(video.color_transfer)) throw new Error("HDR source needs explicit tone mapping; use the video-editing skill");
      args.push("-map", `0:${video.index}`);
      if (audio) args.push("-map", `0:${audio.index}`);
      args.push("-vf", `scale=${width}:-2:reset_sar=1`, "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      if (audio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", String(rate));
    } else {
      args.push("-map", `0:${audio.index}`, "-vn", "-c:a", "pcm_s16le", "-ar", String(rate));
      if (filter) args.push("-af", filter);
    }
    args.push("-map_metadata", "-1", "-map_chapters", "-1", output);
    const rendered = await run("ffmpeg", args, signal);
    if (filter) normalization = JSON.parse(/\{\s*"input_i"[^]*?\}/.exec(rendered.stderr)?.[0] ?? "{}");
    const artifact = await produced(output), outputInfo = await probe(output, signal);
    await run("ffmpeg", [...FFMPEG_FLAGS, "-v", "error", "-xerror", ...inputArgs(output, 0), "-f", "null", "-"], signal);
    const result = { action, source: file, window: { start, duration }, artifact, output: outputInfo, decodeVerified: true, ...(normalization ? { normalization } : {}), note: "Selected primary streams only; subtitles, data, attachments, chapters and source metadata are omitted. Inspect representative playback for content, sync and audible quality." };
    await fs.writeFile(path.join(dir, "edit.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

const localPath = Type.String({ minLength: 1, maxLength: 4096 });
const windowSchema = { start: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })), duration: Type.Optional(Type.Number({ minimum: 0.05, maximum: 600, description: "Window seconds; default 30, maximum 600" })) };
const outputSchema = { outputDir: Type.Optional(localPath) };
const choices = (values: string[]) => Type.Union(values.map(v => Type.Literal(v)));

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
  register("media_info", "Probe local media streams, check installed FFmpeg capabilities or find approximate scene cuts in a bounded window. No uploads. Probe is the default action.", Type.Object({ action: Type.Optional(choices(["probe", "capabilities", "scenes"])), path: Type.Optional(localPath), ...windowSchema, threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })) }), mediaInfo);
  register("video_frames", "Extract 1..12 PNG frames at explicit seconds or evenly spaced timestamps (default 6). Returns frame paths and timing manifest. Fresh output folder inside cwd; originals preserved. Use read/vision to inspect returned images.", Type.Object({ path: localPath, times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 86400 }), { minItems: 1, maxItems: 12 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), ...outputSchema }), videoFrames);
  register("audio_analyze", "Measure windowed LUFS, true/sample peak, RMS, DC offset and silence; optionally render a spectrum PNG. Default first 30 seconds, maximum 600. Numeric evidence, no speech transcription or music recognition.", Type.Object({ path: localPath, ...windowSchema, silenceDb: Type.Optional(Type.Number({ minimum: -100, maximum: -1 })), silenceDuration: Type.Optional(Type.Number({ minimum: 0.05, maximum: 10 })), spectrum: Type.Optional(Type.Boolean()), ...outputSchema }), audioAnalyze);
  register("media_edit", "Create a bounded SDR H.264/AAC clip, extract WAV audio, or perform measured two-pass loudness normalization to WAV. Default first 30 seconds, maximum 600. Fresh output folder; probe and decode validation included. For long/complex edits use FFmpeg through existing background tools.", Type.Object({ action: choices(["clip", "audio", "normalize"]), path: localPath, ...windowSchema, width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), crf: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })), sampleRate: Type.Optional(Type.Integer({ minimum: 8000, maximum: 96000 })), targetLufs: Type.Optional(Type.Number({ minimum: -36, maximum: -5 })), ...outputSchema }), mediaEdit);
  const note = Type.Object({ pitch: Type.Integer({ minimum: 0, maximum: 127 }), start: Type.Number({ minimum: 0, maximum: 256 }), duration: Type.Number({ minimum: 1 / 480, maximum: 256 }), velocity: Type.Optional(Type.Integer({ minimum: 1, maximum: 127 })) });
  const scoreTrack = Type.Object({ name: Type.Optional(Type.String({ maxLength: 64 })), program: Type.Optional(Type.Integer({ minimum: 0, maximum: 127 })), waveform: Type.Optional(choices(["sine", "triangle"])), notes: Type.Array(note, { minItems: 1, maxItems: 1024 }) });
  register("music_compose", "Render an explicit score to editable type-1 MIDI, JSON and a mono sine/triangle WAV audition without external dependencies. Compose notes yourself, then call this tool. All beats are quarter notes, MIDI programs are zero-based. Maximum 8 tracks, 1024 notes, 120 seconds; no same-pitch overlap within a track.", Type.Object({ score: Type.Object({ bpm: Type.Optional(Type.Number({ minimum: 30, maximum: 300 })), beats: Type.Optional(Type.Number({ minimum: 1, maximum: 256 })), numerator: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })), denominator: Type.Optional(Type.Union([2, 4, 8, 16].map(v => Type.Literal(v)))), tracks: Type.Array(scoreTrack, { minItems: 1, maxItems: 8 }) }), ...outputSchema }), composeMusic);
}
