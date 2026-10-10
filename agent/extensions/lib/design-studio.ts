/** Image-to-code studio. Bounded FFmpeg pipes decode and encode images (the
 * bytes arrive on stdin, so no filename ever reaches a demuxer: no sequence
 * patterns, playlists or protocols), URLs download through the SSRF-guarded
 * fetchBinary, and image_crop cuts assets at full source resolution from
 * explicit regions or from block boxes of a design map. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { integer, number, run, textPath } from "./media-process.ts";
import { borderColor, cropRgba, extractPalette, hex, keyBackground, parseHex, trimBox, type Block, type Box, type Rgb, type Rgba } from "./image-analysis.ts";

export const MAP_FORMAT = "yunuspi-design-map-v1";
const SOURCE_MAX_BYTES = 40 * 1024 * 1024;
// Decoder-side bound: FFmpeg refuses frames above this before allocating.
const DECODE_MAX_PIXELS = 64 * 1024 * 1024;
const IMAGE_FORMATS = "png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif,gif_pipe,tiff_pipe,qoi_pipe,pam_pipe,ppm_pipe,pgm_pipe,pbm_pipe";

export interface ImageSource { bytes: Buffer; path?: string; url?: string; format: string; }
export interface Decoded extends Rgba { sourceWidth: number; sourceHeight: number; scale: number; crop?: Box; }

/** Content sniffing: the decoder is chosen by bytes, never by file name. */
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("latin1") === "BM") return "bmp";
  if (bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 0x2a])))) return "tiff";
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "qoif") return "qoi";
  if (bytes.length >= 2 && /^P[1-7]$/.test(bytes.subarray(0, 2).toString("latin1"))) return "pnm";
  return undefined;
}
const looksLikeSvg = (bytes: Buffer) => /^\s*(<\?xml[^>]*>\s*)?(<!--[^]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 2048).toString("utf8"));

/** Load a reference from a local path or an http(s) URL. URL bytes are kept
 * so callers can save them once and reuse the local copy. */
export async function loadImage(spec: { path?: unknown; url?: unknown }, cwd: string, signal?: AbortSignal): Promise<ImageSource> {
  let bytes: Buffer, file: string | undefined, url: string | undefined;
  if (typeof spec.url === "string" && spec.url) {
    if (spec.path !== undefined) throw new Error("Pass path or url, not both");
    if (["1", "true"].includes(String(process.env.PI_OFFLINE ?? "").toLowerCase())) throw new Error("Offline session (PI_OFFLINE): download the reference yourself or pass a local path");
    const { fetchBinary } = await import("../http-tools.ts");
    const fetched = await fetchBinary({ url: spec.url, maxBytes: SOURCE_MAX_BYTES, timeoutMs: 45_000, accept: /^(image\/[a-z0-9.+-]+|application\/octet-stream|binary\/octet-stream|)$/i }, signal);
    bytes = fetched.bytes; url = fetched.url;
  } else {
    if (spec.path === undefined) throw new Error("Pass path (local image) or url");
    file = canonicalMutationPath(textPath(spec.path), cwd);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error("Input must be a regular local file");
    if (stat.size > SOURCE_MAX_BYTES) throw new Error(`Input exceeds ${SOURCE_MAX_BYTES / 1024 / 1024} MiB`);
    bytes = await fs.readFile(file);
  }
  const format = sniffImage(bytes);
  if (!format) {
    if (looksLikeSvg(bytes)) throw new Error("SVG is vector already: read its source, or render it to PNG with render_see (output:image) and analyze that capture");
    throw new Error("Unsupported or unrecognized image (PNG, JPEG, WebP, GIF, BMP, TIFF, QOI, PNM supported)");
  }
  return { bytes, ...(file ? { path: file } : {}), ...(url ? { url } : {}), format };
}

/** Run FFmpeg/FFprobe with the input on stdin and bounded binary output. */
function pipe(binary: string, args: string[], input: Buffer, maxOutput: number, signal?: AbortSignal, timeoutMs = 60_000): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" } });
    const chunks: Buffer[] = [];
    let size = 0, stderr = "", settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { try { child.kill("SIGKILL"); } catch { /* already exited */ } reject(error); } else resolve(value!);
    };
    const abort = () => finish(new Error("Image operation cancelled"));
    const timer = setTimeout(() => finish(new Error(`${binary} exceeded its time bound`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error: any) => finish(error?.code === "ENOENT" ? new Error(`${binary} is not installed or not on PATH`) : error));
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxOutput) finish(new Error(`${binary} output exceeds its bound`)); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("close", code => code === 0 ? finish(undefined, Buffer.concat(chunks)) : finish(new Error(`${binary} failed: ${stderr.trim().slice(-1200) || `exit ${code}`}`)));
    child.stdin.on("error", () => { /* FFmpeg may stop reading early; close reports the outcome. */ });
    child.stdin.end(input);
  });
}
const INPUT = ["-protocol_whitelist", "pipe", "-format_whitelist", IMAGE_FORMATS];

export async function probeImage(bytes: Buffer, signal?: AbortSignal): Promise<{ width: number; height: number; codec: string }> {
  const out = await pipe("ffprobe", ["-v", "error", ...INPUT, "-show_entries", "stream=width,height,codec_name", "-select_streams", "v:0", "-of", "json", "-i", "pipe:0"], bytes, 65536, signal, 20_000);
  const stream = JSON.parse(out.toString("utf8")).streams?.[0];
  if (!stream || !(stream.width > 0) || !(stream.height > 0)) throw new Error("Image has no decodable picture");
  if (stream.width * stream.height > DECODE_MAX_PIXELS) throw new Error(`Image is ${stream.width}x${stream.height}; the decode limit is ${DECODE_MAX_PIXELS / 1024 / 1024}M pixels`);
  return { width: stream.width, height: stream.height, codec: String(stream.codec_name ?? "") };
}

/** Decode to RGBA, optionally cropping (source pixels) and bounding the
 * output by width and total pixels. Returns the scale applied. Callers
 * that already probed these bytes pass `probed` to skip a repeat ffprobe. */
export async function decodeImage(bytes: Buffer, options: { maxWidth?: number; maxPixels?: number; crop?: Box; exactWidth?: number; exactHeight?: number; upscale?: number; probed?: { width: number; height: number } } = {}, signal?: AbortSignal): Promise<Decoded> {
  const info = options.probed ?? await probeImage(bytes, signal);
  const crop = options.crop ? clampBox(options.crop, info.width, info.height) : undefined;
  const inW = crop?.width ?? info.width, inH = crop?.height ?? info.height;
  let outW: number;
  if (options.exactWidth) outW = options.exactWidth;
  else {
    const maxWidth = options.maxWidth ?? inW * (options.upscale ?? 1), maxPixels = options.maxPixels ?? 40_000_000;
    outW = Math.min(maxWidth, inW * (options.upscale ?? 1), Math.floor(Math.sqrt(maxPixels * inW / inH)));
  }
  outW = Math.max(1, Math.round(outW));
  let outH = options.exactHeight ?? Math.max(1, Math.round(inH * outW / inW));
  const pixelLimit = Math.min(DECODE_MAX_PIXELS, options.maxPixels ?? 40000000);
  // Rounding the aspect-ratio height can put a legitimate bounded resize a
  // few pixels above its budget (390×844 into 240k, for example). Tighten an
  // automatic width; explicit caller dimensions still fail rather than drift.
  if (options.exactWidth === undefined && options.exactHeight === undefined && outW * outH > pixelLimit && Math.floor(pixelLimit / outH) >= 1) {
    outW = Math.min(outW, Math.floor(pixelLimit / outH));
    outH = Math.max(1, Math.round(inH * outW / inW));
  }
  if (options.exactHeight !== undefined && options.exactWidth === undefined) throw Error("exactHeight requires exactWidth");
  if (!Number.isSafeInteger(outW) || !Number.isSafeInteger(outH) || outW < 1 || outH < 1 || outW * outH > pixelLimit) throw Error("Requested decoded dimensions exceed the pixel bound");
  const filters = [...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []), ...(outW !== inW || outH !== inH ? [`scale=${outW}:${outH}:flags=${outW < inW || outH < inH ? "area" : "lanczos"}`] : [])];
  // Crops and source coordinates use stored pixel axes. Auto-rotating from
  // EXIF would invalidate the probed dimensions and region coordinates.
  const out = await pipe("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", ...INPUT, "-max_pixels", String(DECODE_MAX_PIXELS), "-noautorotate", "-i", "pipe:0", "-frames:v", "1",
    ...(filters.length ? ["-vf", filters.join(",")] : []), "-pix_fmt", "rgba", "-c:v", "pam", "-f", "image2pipe", "pipe:1"], bytes, outW * outH * 4 + 4096, signal);
  const header = /^P7\nWIDTH (\d+)\nHEIGHT (\d+)\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n/.exec(out.subarray(0, 128).toString("latin1"));
  if (!header) throw new Error("Decoder returned an unexpected frame format");
  const width = Number(header[1]), height = Number(header[2]), offset = header[0].length;
  if (out.length < offset + width * height * 4) throw new Error("Decoder returned a truncated frame");
  return { width, height, data: new Uint8Array(out.buffer, out.byteOffset + offset, width * height * 4), sourceWidth: info.width, sourceHeight: info.height, scale: width / inW, ...(crop ? { crop } : {}) };
}

/** Encode RGBA as PNG, JPEG or WebP (optionally downscaled). JPEG has no
 * alpha, so transparent pixels are flattened onto `matte`. */
export async function encodeImage(img: Rgba, format: "png" | "jpg" | "webp", options: { quality?: number; maxWidth?: number; matte?: Rgb } = {}, signal?: AbortSignal): Promise<Buffer> {
  let input = img;
  if (format === "jpg") {
    const matte = options.matte ?? [255, 255, 255];
    input = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
    for (let i = 0; i < img.width * img.height; i++) { const a = img.data[i * 4 + 3] / 255; for (let c = 0; c < 3; c++) input.data[i * 4 + c] = Math.round(img.data[i * 4 + c] * a + matte[c] * (1 - a)); input.data[i * 4 + 3] = 255; }
  }
  const scale = options.maxWidth && img.width > options.maxWidth ? [`scale=${options.maxWidth}:-1:flags=area`] : [];
  const quality = Math.max(1, Math.min(100, options.quality ?? 85));
  const codec = format === "png" ? ["-c:v", "png", "-pred", "mixed"] : format === "jpg" ? ["-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", String(Math.round(2 + (100 - quality) / 100 * 20))] : ["-c:v", "libwebp", "-quality", String(quality), "-compression_level", "5"];
  return pipe("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", "-protocol_whitelist", "pipe", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${img.width}x${img.height}`, "-i", "pipe:0", "-frames:v", "1",
    ...(scale.length ? ["-vf", scale.join(",")] : []), ...codec, "-f", "image2pipe", "pipe:1"], Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength), 80 * 1024 * 1024, signal);
}

function clampBox(box: Box, width: number, height: number): Box {
  const x = Math.max(0, Math.min(width - 1, Math.floor(box.x))), y = Math.max(0, Math.min(height - 1, Math.floor(box.y)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.ceil(box.width))), height: Math.max(1, Math.min(height - y, Math.ceil(box.height))) };
}

/** Fresh artifact folder. Default parent is .pi/design in the workspace,
 * which gets a `*` .gitignore so scratch artifacts never reach commits. */
export async function studioFolder(value: unknown, cwd: string, prefix: string): Promise<string> {
  const root = await fs.realpath(cwd);
  let parent: string;
  if (value === undefined) {
    parent = path.join(root, ".pi", "design");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(parent, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
  } else parent = canonicalMutationPath(textPath(value), root);
  if (!containsPath(root, parent)) throw new Error("Output directory must be inside the current workspace");
  const output = path.join(parent, `${prefix}-${randomBytes(5).toString("hex")}`);
  const denial = selfMutationDenial(output, root);
  if (denial) throw new Error(denial);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Output directory must be a directory");
  await fs.mkdir(output, { mode: 0o700 });
  return output;
}
const write = (file: string, data: string | Buffer) => fs.writeFile(file, data, { flag: "wx" });
const relative = (cwd: string, file: string) => { const r = path.relative(cwd, file); return r.startsWith("..") ? file : r; };

/** Device pixel ratio of a mockup export. Explicit values win; otherwise
 * common export widths decide (2880 desktop @2x, 1125–1290 phone @3x). */
export function inferDpr(width: number, height: number, explicit?: number): { dpr: number; assumed: boolean; reason: string } {
  if (explicit) return { dpr: explicit, assumed: false, reason: "given" };
  const tall = height / width > 1.6;
  if (width >= 2400) return { dpr: 2, assumed: true, reason: `width ${width}px ≥ 2400 looks like a @2x desktop export` };
  if (tall && width >= 1060 && width <= 1320) return { dpr: 3, assumed: true, reason: `tall ${width}px image looks like a @3x phone export` };
  if (tall && width >= 700 && width <= 860) return { dpr: 2, assumed: true, reason: `tall ${width}px image looks like a @2x phone export` };
  return { dpr: 1, assumed: width > 480 || !tall, reason: "treated as 1x" };
}
// ──────────────────────────────── maps ────────────────────────────────────

export async function readMap(file: unknown, cwd: string): Promise<any> {
  const mapPath = canonicalMutationPath(textPath(file), cwd);
  const stat = await fs.stat(mapPath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("map must be a design-map.json that matches the design-map format");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  if (map?.format !== MAP_FORMAT || !map.analysis?.scale || !Array.isArray(map.blocks)) throw new Error("map is not a design-map.json that matches the design-map format");
  return map;
}
/** Resolve block ids from a map to source-pixel boxes. */
function mapBoxes(map: any, ids: string[]): Array<{ name: string; box: Box; kind?: string }> {
  return ids.map(id => {
    const block = map.blocks.find((b: any) => b.id === id);
    if (!block) throw new Error(`Block ${id} is not in the map (ids look like b12)`);
    const s = map.analysis.scale;
    return { name: id, kind: block.kind, box: { x: block.x / s, y: block.y / s, width: block.width / s, height: block.height / s } };
  });
}
async function mapSource(params: any, map: any, cwd: string, signal?: AbortSignal): Promise<ImageSource> {
  if (params.path !== undefined || params.url !== undefined) return loadImage(params, cwd, signal);
  if (!map) throw new Error("Pass path or url (or an existing design-map.json)");
  return loadImage({ path: map.source.path }, cwd, signal);
}
const safeName = (value: unknown, fallback: string) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && !value.includes("..") ? value.replace(/\.(png|jpe?g|webp|svg)$/i, "") : fallback;

// ──────────────────────────────── crop ────────────────────────────────────

export async function imageCrop(params: any, cwd: string, signal?: AbortSignal) {
  const map = params.map !== undefined ? await readMap(params.map, cwd) : undefined;
  const source = await mapSource(params, map, cwd, signal);
  const info = await probeImage(source.bytes, signal);
  const dpr = map?.source?.dpr ?? inferDpr(info.width, info.height, params.scale).dpr;
  const targets: Array<{ name: string; box: Box; kind?: string }> = [];
  if (Array.isArray(params.blocks) && params.blocks.length) {
    if (!map) throw new Error("blocks need the map that matches the design-map format");
    targets.push(...mapBoxes(map, params.blocks.slice(0, 24).map(String)));
  }
  if (Array.isArray(params.kinds) && params.kinds.length) {
    if (!map) throw new Error("kinds need the map that matches the design-map format");
    const ids = map.blocks.filter((b: any) => params.kinds.includes(b.kind) && !targets.some(t => t.name === b.id)).slice(0, 24 - targets.length).map((b: any) => b.id);
    targets.push(...mapBoxes(map, ids));
  }
  if (Array.isArray(params.regions)) params.regions.slice(0, 24).forEach((region: any, index: number) => {
    const unit = params.units === "css" ? dpr : 1;
    const box = { x: number(region.x, 0, 0, 100000, "x") * unit, y: number(region.y, 0, 0, 100000, "y") * unit, width: number(region.width, 1, 1, 100000, "width") * unit, height: number(region.height, 1, 1, 100000, "height") * unit };
    targets.push({ name: safeName(region.name, `region-${index + 1}`), box });
  });
  if (!targets.length) throw new Error("Nothing to crop: pass regions, or map with blocks or kinds");
  if (targets.length > 24) targets.length = 24;
  const padding = number(params.padding, 0, 0, 512, "padding");
  const key = params.key ?? "none";
  if (typeof key !== "string" || !(["none", "auto"].includes(key) || parseHex(key))) throw new Error('key must be "none", "auto" or a #rrggbb background color');
  const tolerance = number(params.tolerance, 8, 1, 40, "tolerance");
  const format = params.format ?? "auto";
  if (!["auto", "png", "jpg", "webp"].includes(format)) throw new Error("format must be auto, png, jpg or webp");
  const quality = integer(params.quality, 85, 1, 100, "quality");
  const outputWidth = params.outputWidth === undefined ? undefined : integer(params.outputWidth, 0, 8, 4096, "outputWidth");
  const dir = await studioFolder(params.outputDir, cwd, "assets");
  // One decode serves every target when the source fits the per-target
  // pixel bound: no path downscales, so in-memory crops are pixel-identical
  // to per-target decodes. The scale guard keeps float edge cases on the
  // proven per-target path.
  const full = info.width * info.height <= 24_000_000 ? await decodeImage(source.bytes, { maxPixels: 24_000_000, probed: info }, signal) : undefined;
  const assets: any[] = [], used = new Set<string>();
  for (const target of targets) {
    signal?.throwIfAborted();
    const box = clampBox({ x: target.box.x - padding, y: target.box.y - padding, width: target.box.width + 2 * padding, height: target.box.height + 2 * padding }, info.width, info.height);
    let img: Rgba = full && full.scale === 1 ? cropRgba(full, box) : await decodeImage(source.bytes, { crop: box, maxPixels: 24_000_000, probed: info }, signal);
    let keyed: number | undefined, background: Rgb | undefined;
    if (key !== "none") {
      background = key === "auto" ? borderColor(img).rgb : parseHex(key)!;
      keyed = keyBackground(img, background, { tolerance }).keyed;
    }
    let trimmed: Box | undefined;
    if (params.trim === true) {
      const inner = trimBox(img, key === "none" ? borderColor(img).rgb : undefined);
      if (inner.width < img.width || inner.height < img.height) { img = cropRgba(img, inner); trimmed = inner; }
    }
    let transparent = false;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) { transparent = true; break; }
    const unique = extractPalette(img, { max: 24, mergeDelta: 3 }).length;
    const chosen = format !== "auto" ? format : transparent ? (unique >= 20 ? "webp" : "png") : unique >= 20 || target.kind === "image" ? "webp" : "png";
    let bytes: Buffer, ext = chosen;
    try { bytes = await encodeImage(img, chosen as any, { quality, maxWidth: outputWidth }, signal); }
    catch (error: any) {
      if (chosen !== "webp" || signal?.aborted) throw error;
      bytes = await encodeImage(img, transparent ? "png" : "jpg", { quality, maxWidth: outputWidth }, signal); ext = transparent ? "png" : "jpg";
    }
    let name = target.name; for (let n = 2; used.has(name); n++) name = `${target.name}-${n}`; used.add(name);
    const file = path.join(dir, `${name}.${ext}`);
    await write(file, bytes);
    const outW = outputWidth && img.width > outputWidth ? outputWidth : img.width, outH = Math.round(img.height * outW / img.width);
    assets.push({ name, file: relative(cwd, file), format: ext, bytes: bytes.length, pixels: { width: outW, height: outH },
      css: { width: Math.round(img.width / dpr), height: Math.round(img.height / dpr) },
      sourceBox: { x: box.x + (trimmed?.x ?? 0), y: box.y + (trimmed?.y ?? 0), width: img.width, height: img.height },
      ...(target.kind ? { kind: target.kind } : {}), ...(keyed !== undefined ? { keyed: `${keyed}% transparent`, background: hex(background!) } : {}), ...(transparent ? { alpha: true } : {}) });
  }
  const manifest = { source: source.path ?? source.url, dpr, assets };
  await write(path.join(dir, "assets.json"), JSON.stringify(manifest, null, 1) + "\n");
  return { dir: relative(cwd, dir), ...manifest,
    note: "Crops come from the reference pixels: text, UI chrome or neighbouring content inside a box comes along, so inspect each asset. Photographs cut from a mockup are placeholders unless the user supplied them as final assets; flat shapes are better rebuilt in CSS or SVG. Use css sizes for width/height attributes and export @2x pixels for sharp rendering." };
}
