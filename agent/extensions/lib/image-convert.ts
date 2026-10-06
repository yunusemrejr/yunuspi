/** Explicit raster conversion with display framing, alpha and bounded pixels.
 * Source files stay intact; conversion receipts describe the actual encoding. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadImage, probeImage, decodeImage, encodeImage, studioFolder } from "./design-studio.ts";
import { integer, mediaMap } from "./media-process.ts";
import type { Rgba, Rgb } from "./image-analysis.ts";

const PIXELS = 16000000;
export function animatedRaster(bytes: Buffer, format: string) {
  if (format === "gif") return true;
  const png = format === "png";
  if (!png && format !== "webp") return false;
  for (let offset = png ? 8 : 12; offset + (png ? 12 : 8) <= bytes.length;) {
    const length = png ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset + 4);
    const kind = bytes.toString("ascii", offset + (png ? 4 : 0), offset + (png ? 8 : 4));
    if (png ? kind === "acTL" : kind === "ANIM" || kind === "ANMF") return true;
    const overhead = png ? 12 : 8;
    if (length > bytes.length - offset - overhead) break;
    offset += overhead + length + (png ? 0 : length % 2);
  }
  return false;
}
export function conversionPlan(params: any, source: { width: number; height: number }) {
  const format = params.format ?? "png";
  if (!["png", "jpg", "webp"].includes(format)) throw Error("format must be png, jpg or webp");
  const fit = params.fit ?? "contain";
  if (!["contain", "cover", "stretch"].includes(fit)) throw Error("fit must be contain, cover or stretch");
  const rotate = params.rotate ?? 0;
  if (![0, 90, 180, 270].includes(rotate)) throw Error("rotate must be 0, 90, 180 or 270 degrees clockwise");
  for (const key of ["flipX", "flipY"]) if (params[key] !== undefined && typeof params[key] !== "boolean") throw Error(`${key} must be boolean`);
  if (params.background !== undefined && !/^#[\da-f]{6}$/i.test(params.background)) throw Error("background must be #rrggbb");
  const quality = integer(params.quality, 90, 1, 100, "quality");
  const swapped = rotate === 90 || rotate === 270;
  const inWidth = swapped ? source.height : source.width, inHeight = swapped ? source.width : source.height;
  const width = integer(params.width, params.height === undefined ? inWidth : Math.max(1, Math.round(inWidth * params.height / inHeight)), 1, 4096, "width");
  const height = integer(params.height, Math.max(1, Math.round(inHeight * width / inWidth)), 1, 4096, "height");
  if (width * height > PIXELS) throw Error("Converted image exceeds 16M pixels");
  const scale = fit === "cover" ? Math.max(width / inWidth, height / inHeight) : Math.min(width / inWidth, height / inHeight);
  const scaledWidth = fit === "stretch" ? width : Math.max(1, Math.round(inWidth * scale));
  const scaledHeight = fit === "stretch" ? height : Math.max(1, Math.round(inHeight * scale));
  if (scaledWidth * scaledHeight > PIXELS) throw Error("Resize intermediate exceeds 16M pixels; reduce the size or crop the source first");
  return { width, height, scaledWidth, scaledHeight, format, fit, rotate, quality, background: params.background ?? (format === "jpg" ? "#ffffff" : null), flipX: params.flipX === true, flipY: params.flipY === true };
}

export function orientPixels(img: Rgba, rotate: number, flipX = false, flipY = false): Rgba {
  const swapped = rotate === 90 || rotate === 270;
  const width = swapped ? img.height : img.width, height = swapped ? img.width : img.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    let tx = rotate === 90 ? img.height - y - 1 : rotate === 180 ? img.width - x - 1 : rotate === 270 ? y : x;
    let ty = rotate === 90 ? x : rotate === 180 ? img.height - y - 1 : rotate === 270 ? img.width - x - 1 : y;
    if (flipX) tx = width - tx - 1;
    if (flipY) ty = height - ty - 1;
    data.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x + 1) * 4), (ty * width + tx) * 4);
  }
  return { width, height, data };
}

function framePixels(img: Rgba, plan: ReturnType<typeof conversionPlan>): Rgba {
  const data = new Uint8Array(plan.width * plan.height * 4);
  const matte: Rgb | undefined = plan.background ? [1, 3, 5].map(i => parseInt(plan.background!.slice(i, i + 2), 16)) as Rgb : undefined;
  if (matte) for (let i = 0; i < plan.width * plan.height; i++) data.set([...matte, 255], i * 4);
  const dx = Math.floor((plan.width - img.width) / 2), dy = Math.floor((plan.height - img.height) / 2);
  for (let y = Math.max(0, -dy); y < Math.min(img.height, plan.height - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(img.width, plan.width - dx); x++) {
    const from = (y * img.width + x) * 4, to = ((y + dy) * plan.width + x + dx) * 4;
    if (!matte) data.set(img.data.subarray(from, from + 4), to);
    else { const alpha = img.data[from + 3] / 255; for (let c = 0; c < 3; c++) data[to + c] = Math.round(img.data[from + c] * alpha + matte[c] * (1 - alpha)); data[to + 3] = 255; }
  }
  return { width: plan.width, height: plan.height, data };
}

export async function imageConvert(params: any, cwd: string, signal?: AbortSignal) {
  const paths = params.paths === undefined ? [params.path] : params.paths;
  if (params.path !== undefined && params.paths !== undefined) throw Error("Provide path or paths, not both");
  if (!Array.isArray(paths) || !paths.length || paths.length > 12 || paths.some(p => typeof p !== "string" || !p)) throw Error("Conversion needs path or 1..12 paths");
  // Validate every input before allocating outputs, including total work.
  const prepared = [];
  let totalBytes = 0, totalPixels = 0;
  for (const file of paths) {
    signal?.throwIfAborted();
    const source = await loadImage({ path: file }, cwd, signal);
    totalBytes += source.bytes.length;
    if (totalBytes > 80 * 1024 * 1024) throw Error("Conversion inputs exceed the aggregate 80 MiB bound");
    // Explicit still-image contract: GIF and animated WebP/APNG are not
    // silently reduced to a frame. Containers belong to media_edit.
    if (animatedRaster(source.bytes, source.format)) throw Error("Animated images need a frame/video workflow; image_convert preserves still images only");
    const info = await probeImage(source.bytes, signal), plan = conversionPlan(params, info);
    totalPixels += plan.scaledWidth * plan.scaledHeight + plan.width * plan.height;
    if (totalPixels > 96000000) throw Error("Conversion batch exceeds 96M output/intermediate pixels");
    prepared.push({ source, info, plan });
  }
  const dir = await studioFolder(params.outputDir, cwd, "convert");
  try {
    const files = await mediaMap(prepared, async ({ source, info, plan }, i, active) => {
      const targetWidth = plan.rotate === 90 || plan.rotate === 270 ? plan.scaledHeight : plan.scaledWidth;
      const targetHeight = plan.rotate === 90 || plan.rotate === 270 ? plan.scaledWidth : plan.scaledHeight;
      const decoded = await decodeImage(source.bytes, { exactWidth: targetWidth, exactHeight: targetHeight, maxPixels: PIXELS, probed: info }, active);
      const oriented = orientPixels(decoded, plan.rotate, plan.flipX, plan.flipY);
      const pixels = framePixels(oriented, plan), bytes = await encodeImage(pixels, plan.format, { quality: plan.quality }, active);
      const verified = await decodeImage(bytes, { maxWidth: 512, maxPixels: 512 * 512 }, active);
      if (verified.sourceWidth !== plan.width || verified.sourceHeight !== plan.height) throw Error("Converted encoding has unexpected dimensions");
      const output = path.join(dir, `image-${String(i + 1).padStart(2, "0")}.${plan.format}`);
      await fs.writeFile(output, bytes, { flag: "wx" });
      return { source: source.path, sourceHash: createHash("sha256").update(source.bytes).digest("hex"), path: output, bytes: bytes.length, sourceSize: info, ...plan, decodeVerified: true, alpha: pixels.data.some((v, index) => index % 4 === 3 && v < 255) };
    }, signal, 2);
    const result = { files, originalsPreserved: true, note: "Still-image conversion in stored pixel axes; EXIF orientation is not applied. contain pads, cover center-crops, stretch changes aspect ratio; explicit rotations are clockwise. Metadata is removed; JPEG and an explicit background flatten alpha. Inspect the converted files before integration." };
    await fs.writeFile(path.join(dir, "conversion.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    signal?.throwIfAborted();
    return result;
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}
