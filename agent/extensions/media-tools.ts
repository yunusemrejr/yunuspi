/** Local media tools. Fixed operations, bounded subprocesses, no shell or uploads. */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { FFMPEG_FLAGS, inputArgs, inputFile, integer, number, outputFolder, probe, produced, requireStream, run, windowParams } from "./lib/media-process.ts";
import { composeMusic } from "./lib/music-score.ts";
import { sceneCapabilities, sceneCreate, sceneRender } from "./lib/scene-studio.ts";
import { audioMix, videoCompose } from "./lib/media-timeline.ts";
export { sceneCreate, sceneRender, audioMix, videoCompose };

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
      } catch { binaries.tesseract.languages = []; }
    })());
    if (binaries.ffmpeg.available) detail.push((async () => {
      const [filters, encoders] = await Promise.all([
        run("ffmpeg", ["-hide_banner", "-filters"], signal, 10000).then(r => r.stdout),
        run("ffmpeg", ["-hide_banner", "-encoders"], signal, 10000).then(r => r.stdout),
      ]);
      binaries.filters = Object.fromEntries(["scdet", "showinfo", "loudnorm", "silencedetect", "astats", "showspectrumpic", "scale", "fps", "xfade", "concat", "amix", "alimiter", "pan", "afade", "aecho"].map(x => [x, new RegExp(`\\b${x}\\b`).test(filters)]));
      binaries.encoders = Object.fromEntries(["libx264", "aac", "pcm_s16le", "png"].map(x => [x, new RegExp(`\\b${x}\\b`).test(encoders)]));
    })());
    await Promise.all(detail);
    return { ...binaries, musicCompose: { available: true, engine: "built-in MIDI writer and sine/triangle audition synth" }, sceneStudio: sceneCapabilities() };
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
  const dir = await outputFolder(params.outputDir, cwd);
  const extract = async (index: number) => {
    signal?.throwIfAborted();
    const output = path.join(dir, `frame-${String(index + 1).padStart(2, "0")}.png`);
    const r = await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "info", ...inputArgs(file, times[index]), "-map", `0:${stream.index}`, "-frames:v", "1", "-vf", `scale=${width}:${width}:force_original_aspect_ratio=decrease:reset_sar=1,showinfo`, "-update", "1", output], signal, 20000);
    const match = /\bn:\s*0\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/.exec(r.stderr);
    return { ...await produced(output), requestedSeconds: times[index], decodedSeconds: match ? times[index] + Number(match[1]) : null };
  };
  try {
    // Identical per-frame commands, bounded-parallel: four workers share the
    // queue and results land by index, so output order never changes.
    const frames: any[] = new Array(times.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(4, times.length) }, async () => { while (next < times.length) { const i = next++; frames[i] = await extract(i); } });
    const settled = await Promise.allSettled(workers);
    for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
    let sheet: any;
    if (params.contactSheet === true) sheet = await contactSheet(frames, dir, signal);
    const result = { source: file, timestampOrigin: "seconds from source presentation start; decodedSeconds adds post-seek PTS and may reflect decoder rounding", frames, ...(sheet ? { contactSheet: sheet } : {}), note: "Sparse frames do not establish continuous motion or events between samples." };
    await fs.writeFile(path.join(dir, "frames.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
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

/** Parse one tesseract TSV run into text plus word-confidence evidence. Pure. */
export function parseTesseractTsv(tsv: string, maxChars: number) {
  const lines = new Map<string, { page: number; words: { text: string; conf: number; left: number; top: number; width: number; height: number }[] }>();
  let pages = 0;
  for (const row of tsv.split("\n").slice(1)) {
    const cols = row.split("\t");
    if (cols[0] === "1" && Number.isFinite(Number(cols[1]))) { pages = Math.max(pages, Number(cols[1])); continue; }
    if (cols.length < 12 || cols[0] !== "5") continue;
    const nums = cols.slice(1, 11).map(Number);
    if (nums.some(n => !Number.isFinite(n))) continue;
    const [page, block, par, line] = nums as [number, number, number, number];
    const text = (cols[11] ?? "").trim();
    if (!text) continue;
    const key = `${page}/${block}/${par}/${line}`;
    let entry = lines.get(key);
    if (!entry) { entry = { page, words: [] }; lines.set(key, entry); }
    entry.words.push({ text, conf: nums[9] as number, left: nums[5] as number, top: nums[6] as number, width: nums[7] as number, height: nums[8] as number });
  }
  const ordered = [...lines.values()];
  const words = ordered.flatMap(l => l.words);
  const scored = words.filter(w => w.conf >= 0);
  const full = ordered.map(l => l.words.map(w => w.text).join(" ")).join("\n");
  const truncated = full.length > maxChars;
  return {
    pages, words: words.length,
    meanConfidence: scored.length ? Math.round(scored.reduce((n, w) => n + w.conf, 0) / scored.length * 10) / 10 : null,
    text: truncated ? full.slice(0, maxChars) : full, truncated,
    lowConfidence: words.filter(w => w.conf >= 0 && w.conf < 80).slice(0, 20)
      .map(w => ({ text: w.text, confidence: Math.round(w.conf * 10) / 10, box: { left: w.left, top: w.top, width: w.width, height: w.height } })),
  };
}

export async function imageOcr(params: any, cwd: string, signal?: AbortSignal) {
  const file = await inputFile(params.path, cwd);
  if ((await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error("Input exceeds 20 MiB");
  const language = params.language ?? "eng";
  if (typeof language !== "string" || !/^[A-Za-z]{2,3}([+][A-Za-z]{2,3})*$/.test(language)) throw new Error("language must look like eng or eng+deu");
  const psm = integer(params.psm, 3, 0, 13, "psm");
  const maxChars = integer(params.maxChars, 20000, 100, 100000, "maxChars");
  const r = await run("tesseract", [file, "stdout", "-l", language, "--psm", String(psm), "tsv"], signal, 60000);
  const parsed = parseTesseractTsv(r.stdout, maxChars);
  return {
    path: file, engine: "tesseract", language, psm, ...parsed,
    note: "OCR text is a recognition hypothesis with engine confidence, not verified reading. Boxes are stored-pixel left/top/width/height from the upper-left origin. Verify names, numbers and dates against the source image when a decision depends on them; layout, color, composition and meaning need visual inspection instead.",
  };
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
  register("media_info", "Probe local media streams, check installed FFmpeg/Tesseract capabilities or find approximate scene cuts in a bounded window. No uploads. Probe is the default action.", Type.Object({ action: Type.Optional(choices(["probe", "capabilities", "scenes"])), path: Type.Optional(localPath), ...windowSchema, threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })) }), mediaInfo);
  register("video_frames", "Extract 1..12 PNG frames at explicit seconds or evenly spaced timestamps (default 6). Returns frame paths and timing manifest. contactSheet:true also writes one tiled contact-sheet.png with a cell map: inspect that single image first instead of opening every frame. Fresh output folder inside cwd; originals preserved. Use read/vision to inspect returned images, or image_ocr for printed text in them.", Type.Object({ path: localPath, times: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 86400 }), { minItems: 1, maxItems: 12 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920 })), contactSheet: Type.Optional(Type.Boolean()), ...outputSchema }), videoFrames);
  register("image_ocr", "Extract printed text from a local image or PDF with on-device Tesseract (default English, see media_info capabilities for installed languages). Text only: it cannot judge layout, color, composition or meaning — use a vision model for those. Fast local path for text questions; no uploads, no delegation.", Type.Object({ path: localPath, language: Type.Optional(Type.String({ minLength: 3, maxLength: 31, pattern: "^[A-Za-z]{2,3}([+][A-Za-z]{2,3})*$" })), psm: Type.Optional(Type.Integer({ minimum: 0, maximum: 13 })), maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 100000 })) }), imageOcr);
  register("audio_analyze", "Measure windowed LUFS, true/sample peak, RMS, DC offset and silence; optionally render a spectrum PNG. Default first 30 seconds, maximum 600. Numeric evidence, no speech transcription or music recognition.", Type.Object({ path: localPath, ...windowSchema, silenceDb: Type.Optional(Type.Number({ minimum: -100, maximum: -1 })), silenceDuration: Type.Optional(Type.Number({ minimum: 0.05, maximum: 10 })), spectrum: Type.Optional(Type.Boolean()), ...outputSchema }), audioAnalyze);
  register("media_edit", "Create a bounded SDR H.264/AAC clip, extract WAV audio, or perform measured two-pass loudness normalization to WAV. Default first 30 seconds, maximum 600. Fresh output folder; probe and decode validation included. For long/complex edits use FFmpeg through existing background tools.", Type.Object({ action: choices(["clip", "audio", "normalize"]), path: localPath, ...windowSchema, width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840 })), crf: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })), sampleRate: Type.Optional(Type.Integer({ minimum: 8000, maximum: 96000 })), targetLufs: Type.Optional(Type.Number({ minimum: -36, maximum: -5 })), ...outputSchema }), mediaEdit);
  const note = Type.Object({ pitch: Type.Integer({ minimum: 0, maximum: 127 }), start: Type.Number({ minimum: 0, maximum: 256 }), duration: Type.Number({ minimum: 1 / 480, maximum: 256 }), velocity: Type.Optional(Type.Integer({ minimum: 1, maximum: 127 })) });
  const scoreTrack = Type.Object({ name: Type.Optional(Type.String({ maxLength: 64 })), program: Type.Optional(Type.Integer({ minimum: 0, maximum: 127 })), waveform: Type.Optional(choices(["sine", "triangle"])), notes: Type.Array(note, { minItems: 1, maxItems: 1024 }) });
  register("music_compose", "Render an explicit score to editable type-1 MIDI, JSON and a mono sine/triangle WAV audition without external dependencies. Compose notes yourself, then call this tool. All beats are quarter notes, MIDI programs are zero-based. Maximum 8 tracks, 1024 notes, 120 seconds; no same-pitch overlap within a track.", Type.Object({ score: Type.Object({ bpm: Type.Optional(Type.Number({ minimum: 30, maximum: 300 })), beats: Type.Optional(Type.Number({ minimum: 1, maximum: 256 })), numerator: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })), denominator: Type.Optional(Type.Union([2, 4, 8, 16].map(v => Type.Literal(v)))), tracks: Type.Array(scoreTrack, { minItems: 1, maxItems: 8 }) }), ...outputSchema }), composeMusic);
  const vector = Type.Array(Type.Number({ minimum: -1000, maximum: 1000 }), { minItems: 3, maxItems: 3 });
  const positionVector = Type.Array(Type.Number({ minimum: -100, maximum: 100 }), { minItems: 3, maxItems: 3 });
  const scaleVector = Type.Array(Type.Number({ minimum: 0.01, maximum: 40 }), { minItems: 3, maxItems: 3 });
  const hex = Type.String({ pattern: '^#[a-fA-F0-9]{6}$' });
  const style = choices(['studio', 'clay', 'toon', 'wireframe', 'luminous']);
  const resolution = { width: Type.Optional(Type.Integer({ minimum: 64, maximum: 1920, description: 'Even pixels' })), height: Type.Optional(Type.Integer({ minimum: 64, maximum: 1080, description: 'Even pixels' })), fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })) };
  const sceneObject = Type.Object({ id: Type.String({ pattern: '^[a-zA-Z][\\w-]{0,47}$' }), parent: Type.Optional(Type.String({ maxLength: 48 })), geometry: Type.Optional(choices(['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'icosahedron', 'plane', 'arch', 'capsule', 'disc', 'group'])), position: Type.Optional(positionVector), rotation: Type.Optional(vector), scale: Type.Optional(scaleVector), color: Type.Optional(hex), roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), metalness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), opacity: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })), material: Type.Optional(choices(['auto', 'glass', 'matte', 'metal', 'emissive'])), transmission: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), iridescence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), emissive: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })), tube: Type.Optional(Type.Number({ minimum: 0.01, maximum: 0.8, description: 'Tube radius for torus, torusKnot and arch' })), arc: Type.Optional(Type.Number({ minimum: 0.1, maximum: 6.2832, description: 'Sweep in radians for torus and arch' })) });
  const animationKey = Type.Object({ time: Type.Number({ minimum: 0, maximum: 30 }), value: Type.Union([vector, Type.Number({ minimum: 15, maximum: 100 })]), ease: Type.Optional(choices(['linear', 'smooth', 'hold'])) });
  const scene = Type.Object({ version: Type.Optional(Type.Literal(1)), title: Type.Optional(Type.String({ maxLength: 80 })), duration: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })), ...resolution, style: Type.Optional(style), background: Type.Optional(hex), backgroundGradient: Type.Optional(Type.Object({ from: Type.Optional(hex), to: Type.Optional(hex), angle: Type.Optional(Type.Number({ minimum: 0, maximum: 360 })), glow: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) })), beams: Type.Optional(Type.Array(Type.Object({ from: positionVector, to: positionVector, width: Type.Optional(Type.Number({ minimum: 0.05, maximum: 40 })), color: Type.Optional(hex), intensity: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })) }), { maxItems: 4 })), softShadows: Type.Optional(Type.Number({ minimum: 0, maximum: 24 })), post: Type.Optional(Type.Object({ bloom: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })), bloomRadius: Type.Optional(Type.Number({ minimum: 1, maximum: 64 })), grain: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), vignette: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) })), exposure: Type.Optional(Type.Number({ minimum: 0.1, maximum: 3 })), camera: Type.Optional(Type.Object({ position: Type.Optional(positionVector), target: Type.Optional(positionVector), fov: Type.Optional(Type.Number({ minimum: 15, maximum: 100 })) })), lights: Type.Optional(Type.Array(Type.Object({ type: Type.Optional(choices(['hemisphere', 'directional', 'point', 'spot'])), color: Type.Optional(hex), ground: Type.Optional(hex), position: Type.Optional(positionVector), intensity: Type.Optional(Type.Number({ minimum: 0, maximum: 2000, description: 'Spot lights use physical intensity (tens to hundreds); others at most 100' })), target: Type.Optional(positionVector), angle: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1.5 })), penumbra: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) }), { minItems: 1, maxItems: 4 })), objects: Type.Array(sceneObject, { minItems: 1, maxItems: 64 }), tracks: Type.Optional(Type.Array(Type.Object({ target: Type.String({ maxLength: 48 }), property: Type.Optional(choices(['position', 'rotation', 'scale', 'target', 'fov'])), keys: Type.Array(animationKey, { minItems: 2, maxItems: 64 }) }), { maxItems: 128 })) });
  register('scene_create', 'Author a real local Three.js 3D scene as editable JSON plus self-contained HTML (bundled Three.js, no network). Provide scene or an orbital/kinetic/sculpture/keyvisual preset, then edit the JSON. Studio/clay/toon/wireframe/luminous styles; luminous and material:glass give frosted physical glass (transmission, clearcoat, iridescence) for premium brand key visuals, with backgroundGradient, volumetric beams, softShadows and post bloom/grain/vignette; parented geometry, camera/lights and absolute-time keyframes. Rotation is radians; ease applies after its key. Maximum 64 objects, 512 keys, 30 seconds, 900 frames and 900 million pixel-frames. Creation is not render evidence.', Type.Object({ scene: Type.Optional(scene), preset: Type.Optional(choices(['orbital', 'kinetic', 'sculpture', 'keyvisual'])), style: Type.Optional(style), ...outputSchema }), sceneCreate);
  register('scene_render', 'Render validated scene JSON to actual WebGL pixels: frame PNG or deterministic fixed-time H.264 video, poster and three sample frames. Optional local audio is padded/trimmed to video length. No arbitrary JS, HTML, remote assets or uploads. 180-second deadline; reduce dimensions/fps/duration for large scenes. Inspect returned samples and playback before delivery.', Type.Object({ path: localPath, mode: Type.Optional(choices(['frame', 'video'])), time: Type.Optional(Type.Number({ minimum: 0, maximum: 30, description: 'Frame mode only' })), ...resolution, audio: Type.Optional(localPath), ...outputSchema }), sceneRender);
  const audioTrack = Type.Object({ path: localPath, start: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })), at: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), duration: Type.Optional(Type.Number({ minimum: 0.01, maximum: 120 })), gain: Type.Optional(Type.Number({ minimum: 0, maximum: 4 })), pan: Type.Optional(Type.Number({ minimum: -1, maximum: 1, description: 'Stereo balance: -1 left, 0 unchanged, +1 right' })), fadeIn: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), fadeOut: Type.Optional(Type.Number({ minimum: 0, maximum: 120 })), highpass: Type.Optional(Type.Number({ minimum: 20, maximum: 5000 })), lowpass: Type.Optional(Type.Number({ minimum: 200, maximum: 20000 })), delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 500, description: 'Single bounded echo; tails trimmed to track duration' })) });
  register('video_compose', 'Finish a local SDR video timeline from 1..8 clips with cut/fade/wipeleft/fadeblack transitions, normalized letterboxed framing and optional music/voice/effects tracks. Clip durations are required; transitions overlap adjacent clips. Source audio is included by default with transition fades; set includeClipAudio:false for replacement. At most 120 seconds and 1.5 billion pixel-frames; output is fresh H.264/AAC MP4 with probe/decode evidence.', Type.Object({ clips: Type.Array(Type.Object({ path: localPath, start: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 })), duration: Type.Number({ minimum: 1 / 60, maximum: 120, description: 'At least one output frame; fractional boundaries round to output frames' }) }), { minItems: 1, maxItems: 8 }), transition: Type.Optional(choices(['cut', 'fade', 'wipeleft', 'fadeblack'])), transitionDuration: Type.Optional(Type.Number({ minimum: 1 / 60, maximum: 3, description: 'At least one output frame, at most half each adjacent clip' })), includeClipAudio: Type.Optional(Type.Boolean()), audio: Type.Optional(Type.Array(audioTrack, { maxItems: 8 })), ...resolution, ...outputSchema }), videoCompose);
  register('audio_mix', 'Mix 1..8 local sound/music/voice tracks into a fresh stereo 48kHz WAV with offsets, trims, gains, stereo balance, fades, high/low-pass filters, short echo and a latency-compensated sample-peak limiter. All timing is seconds; source start and timeline at are distinct. Maximum 120 seconds, default 30. Use music_compose for score synthesis and audio_analyze for loudness evidence.', Type.Object({ tracks: Type.Array(audioTrack, { minItems: 1, maxItems: 8 }), duration: Type.Optional(Type.Number({ minimum: 0.1, maximum: 120 })), ...outputSchema }), audioMix);
}
