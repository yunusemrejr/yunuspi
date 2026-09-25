/** Image-to-code studio. Bounded FFmpeg pipes decode and encode images (the
 * bytes arrive on stdin, so no filename ever reaches a demuxer: no sequence
 * patterns, playlists or protocols), URLs download through the SSRF-guarded
 * fetchBinary, and four tools build on the pure measurements in
 * image-analysis.ts:
 *   image_analyze  design map, annotated overlay, CSS tokens, build plan
 *   image_crop     cut assets from a reference (regions or mapped blocks)
 *   image_trace    vectorize flat icons and logos with a fidelity check
 *   visual_diff    compare a build (image, HTML or URL) with the reference
 * Everything returned is measurement and suggestion, not design intent. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { integer, number, run, textPath } from "./media-process.ts";
import {
  annotateRoles, borderColor, compareImages, componentGroups, composeRow, contrastRatio, cropRgba, deltaE, detectBlocks,
  drawBox, extractPalette, hex, keyBackground, KIND_COLORS, layoutGrid, paintLabels, parseHex,
  designPalette, INK_PER_EM, nameTypeLevels, sectionRoles, segmentSections, spacingRhythm, traceToSvg, tracePalette, trimBox, typeScale,
  type Block, type Box, type Rgb, type Rgba,
} from "./image-analysis.ts";

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
export async function decodeImage(bytes: Buffer, options: { maxWidth?: number; maxPixels?: number; crop?: Box; exactWidth?: number; upscale?: number; probed?: { width: number; height: number } } = {}, signal?: AbortSignal): Promise<Decoded> {
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
  const outH = Math.max(1, Math.round(inH * outW / inW));
  const filters = [...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []), ...(outW !== inW ? [`scale=${outW}:${outH}:flags=${outW < inW ? "area" : "lanczos"}`] : [])];
  const out = await pipe("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-threads", "2", ...INPUT, "-max_pixels", String(DECODE_MAX_PIXELS), "-i", "pipe:0", "-frames:v", "1",
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
  if (!(await fs.stat(parent)).isDirectory()) throw new Error("Output directory must already exist");
  const output = path.join(parent, `${prefix}-${randomBytes(5).toString("hex")}`);
  const denial = selfMutationDenial(output, root);
  if (denial) throw new Error(denial);
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
const viewportClass = (cssWidth: number) => cssWidth <= 480 ? "phone" : cssWidth <= 1024 ? "tablet" : "desktop";

// ─────────────────────────────── analyze ──────────────────────────────────

function tokensCss(map: any): string {
  const lines = [`/* Measured from ${map.source.name} by image_analyze. Starting values, not the designer's tokens: check them against the reference by eye. CSS px assume a ${map.source.dpr}x export. */`, ":root {"];
  const seen = new Set<string>();
  for (const color of map.palette) {
    const name = color.role === "neutral" || color.role === "secondary-accent" ? `--color-${color.role}-${color.hex.slice(1)}` : `--color-${color.role}`;
    if (seen.has(name)) continue;
    seen.add(name); lines.push(`  ${name}: ${color.hex};`);
  }
  lines.push(`  --space-unit: ${map.spacing.unit}px;`);
  map.spacing.values.forEach((value: number, index: number) => lines.push(`  --space-${index + 1}: ${value}px;`));
  const radii = [...new Set<number>(map.blocks.filter((b: any) => b.radius).map((b: any) => b.radius))].sort((a, b) => a - b).slice(0, 3);
  radii.forEach((radius, index) => lines.push(`  --radius-${["sm", "md", "lg"][index]}: ${radius}px;`));
  if (map.layout.container.width) lines.push(`  --container: ${map.layout.container.width}px;`);
  for (const level of map.typography) lines.push(`  --font-size-${level.name}: ${level.fontSize}px;${level.ratio ? ` --line-height-${level.name}: ${level.ratio};` : ""}`);
  lines.push("}");
  return lines.join("\n") + "\n";
}

const ADVICE: Record<string, string> = {
  text: "real HTML text (copy from OCR or the image); never an image of text",
  flat: "CSS background and border-radius",
  container: "CSS box (background, radius, padding) holding its child blocks",
  gradient: "CSS linear-gradient",
  divider: "CSS border or <hr>",
  icon: "SVG: image_trace, or the matching icon from the project's icon set",
  image: "raster asset: image_crop, then WebP/AVIF with explicit width/height",
  mixed: "look closer: an illustration (raster or SVG) or composed UI",
};

export async function imageAnalyze(params: any, cwd: string, signal?: AbortSignal) {
  const source = await loadImage(params, cwd, signal);
  const info = await probeImage(source.bytes, signal);
  const dprInfo = inferDpr(info.width, info.height, params.scale === undefined ? undefined : number(params.scale, 1, 0.5, 4, "scale"));
  const cssWidth = Math.round(info.width / dprInfo.dpr);
  // Analyze near CSS resolution: detection thresholds are tuned for it.
  const maxWidth = integer(params.maxWidth, Math.min(1920, Math.max(cssWidth, Math.min(info.width, 480))), 240, 2560, "maxWidth");
  const img = await decodeImage(source.bytes, { maxWidth, maxPixels: 14_000_000, probed: info }, signal);
  const cssPerPx = 1 / (img.scale * dprInfo.dpr);
  const dir = await studioFolder(params.outputDir, cwd, "analyze");
  let savedSource: string | undefined;
  if (!source.path) { savedSource = path.join(dir, `reference.${source.format === "jpeg" ? "jpg" : source.format}`); await write(savedSource, source.bytes); }
  const sourcePath = source.path ?? savedSource!;
  const frame = borderColor(img);
  const sections = segmentSections(img);
  const blocks = detectBlocks(img, sections, { maxBlocks: integer(params.maxBlocks, 160, 8, 400, "maxBlocks"), unit: 1 / cssPerPx });
  annotateRoles(blocks, sections, cssPerPx);
  // Photographs are content, not tokens: leave them out of the palette.
  const photos = blocks.filter(block => block.implement === "raster");
  const palette = designPalette(extractPalette(img, { max: 14, mergeDelta: 3.5, exclude: photos }), frame.rgb, blocks, sections, cssPerPx, img.width);
  const toCss = (v: number) => Math.round(v * cssPerPx);
  const cssBox = (b: Box) => ({ x: toCss(b.x), y: toCss(b.y), width: toCss(b.width), height: toCss(b.height) });
  const grid = layoutGrid(blocks, img.width, 60 / cssPerPx), rhythm = spacingRhythm(blocks), type = typeScale(blocks);
  const roles = sectionRoles(sections, blocks, img.width, cssPerPx, frame.rgb);
  const groups = componentGroups(blocks);

  // Optional OCR assigns recognized lines to text blocks for real copy.
  let ocr: any;
  if (params.ocr === true) {
    try {
      const language = typeof params.language === "string" && /^[A-Za-z]{2,3}([+][A-Za-z]{2,3})*$/.test(params.language) ? params.language : "eng";
      const ocrInput = source.path ?? savedSource!;
      const tsv = (await run("tesseract", [ocrInput, "stdout", "-l", language, "--psm", "3", "tsv"], signal, 90_000)).stdout;
      ocr = assignOcr(tsv, blocks, img.scale);
    } catch (error: any) { if (signal?.aborted) throw error; ocr = { unavailable: String(error.message).slice(0, 200) }; }
  }

  const overlay: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let i = 0; i < overlay.width * overlay.height; i++) for (let c = 0; c < 3; c++) overlay.data[i * 4 + c] = Math.round(overlay.data[i * 4 + c] * 0.55 + 255 * 0.45);
  for (const section of sections) drawBox(overlay, { x: 0, y: section.y, width: img.width, height: section.height }, [15, 23, 42], undefined, 1);
  blocks.forEach(block => drawBox(overlay, block, KIND_COLORS[block.kind], Number(block.id.slice(1)), block.parent ? 1 : 2));
  const overlayPath = path.join(dir, "overlay.png");
  await write(overlayPath, await encodeImage(overlay, "png", { maxWidth: 1600 }, signal));

  const map: any = {
    format: MAP_FORMAT,
    source: { name: path.basename(source.path ?? source.url ?? "reference"), path: sourcePath, ...(source.url ? { url: source.url } : {}), width: info.width, height: info.height, dpr: dprInfo.dpr, dprAssumed: dprInfo.assumed, dprReason: dprInfo.reason, cssWidth, cssHeight: Math.round(info.height / dprInfo.dpr), viewport: viewportClass(cssWidth) },
    analysis: { width: img.width, height: img.height, scale: img.scale, cssPerPx: Math.round(cssPerPx * 10000) / 10000, units: "blocks and sections are analysis pixels; css fields are CSS pixels; multiply analysis pixels by 1/scale for source pixels" },
    frame: { background: hex(frame.rgb), uniformity: frame.uniformity },
    palette,
    sections: sections.map(section => ({ ...section, background: hex(section.background), css: { y: toCss(section.y), height: toCss(section.height) }, ...roles.find(role => role.id === section.id) })),
    blocks: blocks.map(block => ({ ...block, css: cssBox(block), ...(block.radius ? { radius: toCss(block.radius) } : {}), ...(block.ink ? { fontSize: Math.max(8, Math.round(block.ink * cssPerPx / INK_PER_EM)) } : {}), ...(block.pitch ? { lineHeight: toCss(block.pitch) } : {}), ...(ocr?.byBlock?.[block.id] ? { text: ocr.byBlock[block.id] } : {}) })),
    layout: { container: { x: toCss(grid.container.x), width: toCss(grid.container.width), margin: toCss(grid.container.margin) }, alignment: grid.alignment.map(toCss), columns: grid.columns.map(column => ({ ...column, gutter: toCss(column.gutter) })) },
    spacing: { unit: rhythm.unit, values: [...new Set(rhythm.values.map(v => Math.max(rhythm.unit, Math.round(toCss(v) / rhythm.unit) * rhythm.unit)))], samples: rhythm.samples },
    typography: nameTypeLevels(type.map(level => { const fontSize = Math.max(8, Math.round(level.ink * cssPerPx / INK_PER_EM)); return { fontSize, ...(level.pitch ? { lineHeight: toCss(level.pitch), ratio: Math.round(toCss(level.pitch) / fontSize * 100) / 100 } : {}), blocks: level.blocks }; })),
    components: groups.map(group => ({ ...group, width: toCss(group.width), height: toCss(group.height), ...(group.radius ? { radius: toCss(group.radius) } : {}), ...(group.inset ? { inset: { x: toCss(group.inset.x), y: toCss(group.inset.y) } } : {}) })),
    ...(ocr ? { ocr: ocr.unavailable ? { unavailable: ocr.unavailable } : { lines: ocr.lines, meanConfidence: ocr.meanConfidence, unassigned: ocr.unassigned } } : {}),
    implementation: Object.fromEntries(Object.keys(ADVICE).map(kind => [kind, { count: blocks.filter(block => block.kind === kind).length, how: ADVICE[kind] }]).filter(([, value]: any) => value.count)),
  };
  const mapPath = path.join(dir, "design-map.json"), tokensPath = path.join(dir, "tokens.css");
  await write(mapPath, JSON.stringify(map, null, 1) + "\n");
  await write(tokensPath, tokensCss(map));

  const raster = blocks.filter(block => block.implement === "raster").slice(0, 12).map(block => block.id);
  const icons = blocks.filter(block => block.kind === "icon").slice(0, 12).map(block => block.id);
  const pageBg = palette.find(color => color.role === "background"), text = palette.find(color => color.role === "text");
  const lowContrast = palette.filter(color => ["text", "muted-text"].includes(color.role) && color.contrastOnBackground < 4.5).map(color => `${color.role} ${color.hex} is ${color.contrastOnBackground}:1 on the background (WCAG AA body text needs 4.5:1)`);
  return {
    files: { map: relative(cwd, mapPath), overlay: relative(cwd, overlayPath), tokens: relative(cwd, tokensPath), ...(savedSource ? { reference: relative(cwd, savedSource) } : {}) },
    source: map.source,
    sections: map.sections.map((section: any) => `${section.id} ${section.role ?? "content"} y${section.css.y} h${section.css.height} bg ${section.background}${section.reason ? ` (${section.reason})` : ""}`).slice(0, 24),
    palette: palette.slice(0, 12).map(color => `${color.role}: ${color.hex}${color.role === "background" ? "" : ` (${color.contrastOnBackground}:1)`} — ${color.evidence}`),
    typography: map.typography.map((level: any) => `${level.name} ~${level.fontSize}px${level.lineHeight ? `/${level.lineHeight}px` : ""} ×${level.blocks}`),
    layout: { container: map.layout.container, columns: map.layout.columns.slice(0, 6), spacingUnit: map.spacing.unit, spacing: map.spacing.values },
    components: map.components.slice(0, 6).map((group: any) => `${group.count}× ${group.role ?? group.kind} ${group.width}×${group.height}${group.fill ? ` ${group.fill}` : ""}${group.border ? ` border ${group.border}` : ""}${group.radius ? ` r${group.radius}` : ""}${group.inset ? ` inset ${group.inset.x}/${group.inset.y}` : ""} [${group.children}] ${group.blocks.slice(0, 4).join(",")}`),
    implementation: Object.fromEntries(Object.entries(map.implementation).map(([kind, value]: any) => [kind, value.count])),
    assets: { raster, icons },
    ...(pageBg && text ? { contrast: `text on background ${contrastRatio(text.rgb, pageBg.rgb)}:1` } : {}),
    ...(lowContrast.length ? { accessibility: lowContrast } : {}),
    ...(ocr ? { ocr: ocr.unavailable ? `unavailable: ${ocr.unavailable}` : `${ocr.lines.length} lines, mean confidence ${ocr.meanConfidence ?? "n/a"}; text is on text blocks in design-map.json` } : { ocr: "not run; pass ocr:true to attach recognized copy to text blocks" }),
    next: [
      `Look at ${relative(cwd, overlayPath)} (block ids drawn by kind) next to the reference before deciding anything`,
      "Build structure first: sections → containers → text, using tokens.css values as starting points",
      raster.length ? `Cut raster assets: image_crop {map, blocks:[${raster.slice(0, 6).map(id => `"${id}"`).join(",")}]}` : "No photographic blocks detected: expect CSS/SVG only",
      icons.length ? `Vectorize icons/logos: image_trace {map, block:"${icons[0]}"} (or use the project's icon set)` : "No icon-sized flat blocks detected",
      `Compare the build: visual_diff {reference:"${relative(cwd, sourcePath)}", source:"<page or URL>", width:${cssWidth}}`,
    ],
    note: "Measurements and guesses from pixels: roles, font sizes and component groupings are estimates. Hover, focus, motion, responsive behavior and fonts are not in a still image; decide them from the brief and design doctrine.",
  };
}

/** Group tesseract words into lines and attach each line to the text block
 * containing its center (analysis pixels = source pixels × scale). */
function assignOcr(tsv: string, blocks: Block[], scale: number) {
  const lines = new Map<string, { words: string[]; conf: number[]; left: number; top: number; right: number; bottom: number }>();
  for (const row of tsv.split("\n").slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const text = (cols[11] ?? "").trim(), conf = Number(cols[10]);
    if (!text || !(conf >= 0)) continue;
    const [left, top, width, height] = cols.slice(6, 10).map(Number);
    const key = cols.slice(1, 5).join("/");
    const line = lines.get(key) ?? { words: [], conf: [], left, top, right: left + width, bottom: top + height };
    line.words.push(text); line.conf.push(conf);
    line.left = Math.min(line.left, left); line.top = Math.min(line.top, top); line.right = Math.max(line.right, left + width); line.bottom = Math.max(line.bottom, top + height);
    lines.set(key, line);
  }
  const byBlock: Record<string, string> = {};
  const out: Array<{ text: string; confidence: number; block?: string }> = [];
  let unassigned = 0, confSum = 0, confCount = 0;
  const textBlocks = blocks.filter(block => block.kind === "text" || block.kind === "mixed" || block.role === "button");
  for (const line of [...lines.values()].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const text = line.words.join(" ").slice(0, 300), confidence = Math.round(line.conf.reduce((s, v) => s + v, 0) / line.conf.length);
    confSum += confidence; confCount++;
    const cx = (line.left + line.right) / 2 * scale, cy = (line.top + line.bottom) / 2 * scale;
    const home = textBlocks.filter(block => cx >= block.x && cx <= block.x + block.width && cy >= block.y && cy <= block.y + block.height).sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (home) { const joined = byBlock[home.id] ? `${byBlock[home.id]}\n${text}` : text; byBlock[home.id] = joined.slice(0, 600); } else unassigned++;
    if (out.length < 400) out.push({ text, confidence, ...(home ? { block: home.id } : {}) });
  }
  return { byBlock, lines: out, unassigned, meanConfidence: confCount ? Math.round(confSum / confCount) : null };
}

// ──────────────────────────────── maps ────────────────────────────────────

export async function readMap(file: unknown, cwd: string): Promise<any> {
  const mapPath = canonicalMutationPath(textPath(file), cwd);
  const stat = await fs.stat(mapPath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("map must be a design-map.json written by image_analyze");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  if (map?.format !== MAP_FORMAT || !map.analysis?.scale || !Array.isArray(map.blocks)) throw new Error("map is not a design-map.json written by image_analyze");
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
  if (!map) throw new Error("Pass path or url (or a map from image_analyze)");
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
    if (!map) throw new Error("blocks need the map written by image_analyze");
    targets.push(...mapBoxes(map, params.blocks.slice(0, 24).map(String)));
  }
  if (Array.isArray(params.kinds) && params.kinds.length) {
    if (!map) throw new Error("kinds need the map written by image_analyze");
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

// ──────────────────────────────── trace ───────────────────────────────────

export async function imageTrace(params: any, cwd: string, signal?: AbortSignal) {
  const map = params.map !== undefined ? await readMap(params.map, cwd) : undefined;
  const source = await mapSource(params, map, cwd, signal);
  const info = await probeImage(source.bytes, signal);
  const dpr = map?.source?.dpr ?? inferDpr(info.width, info.height, params.scale).dpr;
  let box: Box, name: string;
  if (params.block !== undefined) {
    if (!map) throw new Error("block needs the map written by image_analyze");
    const [target] = mapBoxes(map, [String(params.block)]); box = target.box; name = target.name;
  } else if (params.region) {
    const r = params.region; box = { x: number(r.x, 0, 0, 100000, "x"), y: number(r.y, 0, 0, 100000, "y"), width: number(r.width, 1, 1, 100000, "width"), height: number(r.height, 1, 1, 100000, "height") }; name = safeName(params.name, "trace");
  } else box = { x: 0, y: 0, width: info.width, height: info.height }, name = safeName(params.name, "trace");
  const padding = number(params.padding, 2, 0, 64, "padding");
  box = clampBox({ x: box.x - padding, y: box.y - padding, width: box.width + 2 * padding, height: box.height + 2 * padding }, info.width, info.height);
  if (box.width * box.height > 4_000_000) throw new Error("Region too large to trace (over 4M pixels); tracing suits icons, logos and flat illustrations");
  const colors = integer(params.colors, 4, 1, 8, "colors");
  let background: Rgb | null | undefined;
  if (params.background === "none") background = null;
  else if (typeof params.background === "string" && params.background !== "auto") { background = parseHex(params.background); if (!background) throw new Error('background must be "auto", "none" or #rrggbb'); }
  // Palette from native pixels (few anti-aliased pixels), tracing on an
  // upscaled copy so contours follow sub-pixel edges instead of the grid.
  const native = await decodeImage(source.bytes, { crop: box, probed: info }, signal);
  const nativeBackground = background === null ? undefined : background ?? borderColor(native).rgb;
  const palette = tracePalette(native, nativeBackground, colors);
  if (!palette.length) throw new Error("No fill colors distinct from the background: nothing to trace");
  const upscale = Math.max(1, Math.min(8, Math.floor(512 / Math.max(box.width, box.height))));
  const big = upscale > 1 ? await decodeImage(source.bytes, { crop: box, upscale, maxPixels: 4_200_000, probed: info }, signal) : native;
  const epsilon = number(params.epsilon, 0.6 * Math.max(1, big.width / box.width), 0.2, 16, "epsilon");
  const traced = traceToSvg(big, { x: 0, y: 0, width: big.width, height: big.height }, { background: background === null ? null : nativeBackground, palette, epsilon, outputWidth: Math.round(box.width / dpr), outputHeight: Math.round(box.height / dpr) });
  const dir = await studioFolder(params.outputDir, cwd, "trace");
  const svgPath = path.join(dir, `${name}.svg`), previewPath = path.join(dir, `${name}-preview.png`);
  await write(svgPath, traced.svg + "\n");
  const matte: Rgb = nativeBackground ?? [255, 255, 255];
  const preview = composeRow([big, paintLabels(traced.predicted, big.width, big.height, traced.palette, matte)], 12);
  await write(previewPath, await encodeImage(preview, "png", { maxWidth: 1400 }, signal));
  // Fidelity: do the paths match the pixel labels? Posterization error: do
  // the flat fills match the pixels? Photos fail the second, not the first.
  const verdict = traced.fidelity >= 0.92 && traced.meanError <= 4 ? "good" : traced.fidelity >= 0.8 && traced.meanError <= 7 ? "usable; check curves, small details and shading" : "poor; this region is probably photographic or softly shaded, so crop it as a raster (image_crop) or redraw it";
  return {
    svg: relative(cwd, svgPath), preview: relative(cwd, previewPath), bytes: Buffer.byteLength(traced.svg), layers: traced.layers,
    background: traced.background, css: { width: Math.round(box.width / dpr), height: Math.round(box.height / dpr) }, sourceBox: box, upscale,
    fidelity: traced.fidelity, posterizationError: traced.meanError, unexplained: `${traced.unexplained}%`, verdict,
    note: "Fidelity compares the re-rasterized paths with the pixel labels (1 = identical); posterization error is the mean ΔE between pixels and their flat fill (under 4 is flat artwork). Tracing reproduces shapes, not intent: prefer the project's icon set or a known logo file when one exists; hand-tune curves for large marks. preview.png shows source (left) and traced result (right).",
  };
}

// ─────────────────────────────── compare ──────────────────────────────────

export type Capture = (params: { source: string; width: number; height: number; fullPage: boolean; clip?: { y: number; height: number }; colorScheme?: string; timeoutMs?: number }, destination: string, cwd: string, signal?: AbortSignal) => Promise<any>;
const SLICE = 4000;
const COMPARE_MAX_PIXELS = 10_000_000;

function stack(images: Rgba[]): Rgba {
  const width = Math.min(...images.map(img => img.width)), height = images.reduce((sum, img) => sum + img.height, 0);
  const out: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  let y0 = 0;
  for (const img of images) { for (let y = 0; y < img.height; y++) out.data.set(img.data.subarray(y * img.width * 4, (y * img.width + width) * 4), (y0 + y) * width * 4); y0 += img.height; }
  return out;
}

export async function visualDiff(params: any, cwd: string, signal: AbortSignal | undefined, capture: Capture | undefined) {
  const map = params.map !== undefined ? await readMap(params.map, cwd) : undefined;
  const reference = typeof params.reference === "string" && /^https?:\/\//i.test(params.reference) ? await loadImage({ url: params.reference }, cwd, signal) : params.reference !== undefined ? await loadImage({ path: params.reference }, cwd, signal) : await mapSource({}, map, cwd, signal);
  const info = await probeImage(reference.bytes, signal);
  const dpr = params.referenceScale !== undefined ? number(params.referenceScale, 1, 0.5, 4, "referenceScale") : map?.source?.dpr ?? inferDpr(info.width, info.height).dpr;
  const notes: string[] = [];
  let region: Box | undefined;
  if (params.region) { const r = params.region; region = clampBox({ x: number(r.x, 0, 0, 100000, "x"), y: number(r.y, 0, 0, 100000, "y"), width: number(r.width, 1, 1, 100000, "width"), height: number(r.height, 1, 1, 100000, "height") }, info.width, info.height); }
  const refCssWidth = Math.round((region?.width ?? info.width) / dpr);
  if (refCssWidth > 2048) throw new Error("Reference is wider than 2048 CSS px; pass referenceScale (its pixel ratio) or a region");
  const maxCssHeight = Math.min(6000, Math.floor(COMPARE_MAX_PIXELS / refCssWidth));
  if (Math.round((region?.height ?? info.height) / dpr) > maxCssHeight) {
    region = { x: region?.x ?? 0, y: region?.y ?? 0, width: region?.width ?? info.width, height: Math.floor(maxCssHeight * dpr) };
    notes.push(`Compared the top ${maxCssHeight} CSS px of the reference${params.region ? " region" : ""}; pass region to compare lower parts.`);
  }
  const ref = await decodeImage(reference.bytes, { crop: region, exactWidth: refCssWidth, probed: info }, signal);
  const dir = await studioFolder(params.outputDir, cwd, "diff");
  let cand: Rgba, candidateInfo: any;
  if (params.candidate !== undefined) {
    const candidate = await loadImage({ path: params.candidate }, cwd, signal);
    const candInfo = await probeImage(candidate.bytes, signal);
    // Candidate pixels per CSS pixel: 1 for ordinary screenshots, 2 for @2x.
    const k = candInfo.width / Math.round(info.width / dpr);
    const crop = region ? clampBox({ x: region.x / dpr * k, y: region.y / dpr * k, width: region.width / dpr * k, height: region.height / dpr * k }, candInfo.width, candInfo.height) : undefined;
    if (Math.abs(k - Math.round(k)) > 0.02) notes.push(`Candidate is ${candInfo.width}px wide for a ${Math.round(info.width / dpr)} CSS px reference and was scaled; capture at the reference width for a faithful comparison.`);
    cand = await decodeImage(candidate.bytes, { crop, exactWidth: refCssWidth, probed: candInfo }, signal);
    candidateInfo = { image: relative(cwd, candidate.path!), pixelsPerCssPx: Math.round(k * 100) / 100 };
  } else if (typeof params.source === "string") {
    if (!capture) throw new Error("Rendering is unavailable here; capture the page with render_see and pass its PNG as candidate");
    const pageWidth = Math.round(info.width / dpr);
    const viewportHeight = params.height !== undefined ? integer(params.height, 900, 64, 2048, "height") : pageWidth <= 480 ? 844 : pageWidth <= 1024 ? 1024 : 900;
    const top = Math.round((region?.y ?? 0) / dpr);
    let end = top + ref.height, pageSize: { width: number; height: number } | undefined, errors: string[] = [];
    const slices: Rgba[] = [];
    for (let y = top, index = 0; y < end && index < 4; y += SLICE, index++) {
      const file = path.join(dir, `slice-${index + 1}.png`);
      const details = await capture({ source: params.source, width: pageWidth, height: viewportHeight, fullPage: true, clip: { y, height: Math.min(SLICE, end - y) }, ...(params.colorScheme ? { colorScheme: params.colorScheme } : {}), timeoutMs: 20_000 }, file, cwd, signal);
      pageSize ??= details?.conditions?.documentSize;
      if (Array.isArray(details?.errors)) errors.push(...details.errors.slice(0, 5 - errors.length));
      const bytes = await fs.readFile(file);
      await fs.rm(file, { force: true });
      slices.push(await decodeImage(bytes, {}, signal));
      if (pageSize) end = Math.min(end, pageSize.height);
    }
    let stitched = stack(slices);
    if (region) stitched = cropRgba(stitched, { x: Math.round(region.x / dpr), y: 0, width: Math.min(refCssWidth, stitched.width - Math.round(region.x / dpr)), height: stitched.height });
    if (stitched.width !== refCssWidth) {
      notes.push(`Rendered ${stitched.width}px wide; scaled to ${refCssWidth}px.`);
      stitched = await decodeImage(await encodeImage(stitched, "png", {}, signal), { exactWidth: refCssWidth }, signal);
    }
    cand = stitched;
    const shot = path.join(dir, "candidate.png");
    await write(shot, await encodeImage(cand, "png", {}, signal));
    if (pageSize && pageSize.width > pageWidth) notes.push(`The page is ${pageSize.width - pageWidth}px wider than its ${pageWidth}px viewport (horizontal overflow).`);
    candidateInfo = { rendered: relative(cwd, shot), source: params.source, viewport: { width: pageWidth, height: viewportHeight }, ...(pageSize ? { pageHeight: pageSize.height, referenceHeight: Math.round(info.height / dpr) } : {}), ...(errors.length ? { pageErrors: errors } : {}) };
  } else throw new Error("Pass candidate (screenshot path) or source (HTML path or URL to render)");
  const sections = segmentSections(ref);
  const { comparison, heat } = compareImages(ref, cand, { threshold: number(params.threshold, 6, 1, 40, "threshold"), sections });
  const heatPath = path.join(dir, "heat.png"), comparePath = path.join(dir, "compare.png");
  await write(heatPath, await encodeImage(heat, "png", { maxWidth: 1600 }, signal));
  const overlap = Math.min(ref.height, cand.height);
  const panels = [cropRgba(ref, { x: 0, y: 0, width: ref.width, height: Math.max(ref.height, 1) }), cropRgba(cand, { x: 0, y: 0, width: cand.width, height: Math.max(cand.height, 1) }), heat];
  const side = composeRow(panels, 16);
  const sideCap = side.height > 12000 ? cropRgba(side, { x: 0, y: 0, width: side.width, height: 12000 }) : side;
  await write(comparePath, await encodeImage(sideCap, "png", { maxWidth: 2400 }, signal));
  const zooms: string[] = [];
  for (const [index, r] of comparison.regions.slice(0, 3).entries()) {
    const pad = 12, zone = clampBox({ x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad }, ref.width, overlap);
    const pair = composeRow([cropRgba(ref, zone), cropRgba(cand, zone)], 8, [255, 0, 128]);
    const file = path.join(dir, `region-${index + 1}.png`);
    await write(file, await encodeImage(pair, "png", { maxWidth: 1400 }, signal));
    zooms.push(relative(cwd, file));
  }
  // Name the reference blocks under each hot region when a map is available.
  const blocksAt = (r: Box) => {
    if (!map) return undefined;
    const k = map.analysis.cssPerPx, offX = (region?.x ?? 0) / dpr, offY = (region?.y ?? 0) / dpr;
    return map.blocks.filter((b: any) => !b.parent || b.kind !== "text").filter((b: any) => {
      const bx = b.x * k - offX, by = b.y * k - offY, bw = b.width * k, bh = b.height * k;
      return bx < r.x + r.width && bx + bw > r.x && by < r.y + r.height && by + bh > r.y;
    }).slice(0, 4).map((b: any) => `${b.id} ${b.role ?? b.kind}`);
  };
  const verdict = comparison.ssim >= 0.95 && comparison.changed < 3 ? "close" : comparison.ssim >= 0.85 && comparison.changed < 15 ? "similar with visible differences" : comparison.ssim >= 0.6 ? "noticeably different" : "substantially different";
  const shifted = comparison.sections.filter(s => s.shift !== 0).map(s => `${s.id} (y${s.y}) matches the candidate ${Math.abs(s.shift)}px ${s.shift > 0 ? "lower" : "higher"} (${s.shiftImprovement}% better aligned): spacing above it differs`);
  const worst = [...comparison.sections].sort((a, b) => b.meanDelta * b.height - a.meanDelta * a.height).slice(0, 4).map(s => `${s.id} y${s.y}-${s.y + s.height}: mean ΔE ${s.meanDelta}, ${s.changed}% changed`);
  const palette = map?.palette ?? [];
  // Whole-page height difference: the rendered page's own height, or the
  // candidate image's height when neither side was cropped.
  const heightDelta = candidateInfo.pageHeight !== undefined && !params.region ? candidateInfo.pageHeight - candidateInfo.referenceHeight
    : params.candidate !== undefined && !region ? comparison.heightDelta : undefined;
  const result = {
    verdict, ssim: comparison.ssim, meanDelta: comparison.meanDelta, changedPercent: comparison.changed,
    size: { reference: { width: ref.width, height: ref.height }, compared: { width: ref.width, height: Math.min(ref.height, cand.height) }, ...(heightDelta !== undefined ? { heightDelta } : {}) },
    candidate: candidateInfo, ...(notes.length ? { notes } : {}),
    worstSections: worst, shifts: shifted,
    regions: comparison.regions.slice(0, 6).map((r, i) => { const under = blocksAt(r); return { x: r.x, y: r.y, width: r.width, height: r.height, meanDelta: r.score, ...(i < zooms.length ? { zoom: zooms[i] } : {}), ...(under?.length ? { referenceBlocks: under } : {}) }; }),
    missingColors: comparison.missingColors.map(color => { const role = palette.find((p: any) => deltaE(parseHex(p.hex)!, parseHex(color.hex)!) < 6)?.role; return `${color.hex} ${color.coverage}%${role ? ` (${role})` : ""}`; }),
    extraColors: comparison.extraColors.map(color => `${color.hex} ${color.coverage}% in the build, absent from the reference`),
    files: { compare: relative(cwd, comparePath), heat: relative(cwd, heatPath), zooms },
    next: heightDelta !== undefined && Math.abs(heightDelta) > 16 ? [`The page is ${Math.abs(heightDelta)}px ${heightDelta > 0 ? "taller" : "shorter"} than the reference: fix section heights and vertical spacing first (shifts cascade into every later region)`, "Then fix the largest regions and re-run visual_diff on the same reference"] : ["Fix the largest regions first, then re-run visual_diff on the same reference"],
    note: "Pixel comparison at CSS resolution. Font rasterization, anti-aliasing and placeholder imagery differ legitimately, so aim for matching structure, spacing, color and scale rather than zero difference; look at compare.png (reference | build | heat) and the zooms before editing.",
  };
  await write(path.join(dir, "diff.json"), JSON.stringify({ ...result, comparison }, null, 1) + "\n");
  return { dir: relative(cwd, dir), ...result };
}
