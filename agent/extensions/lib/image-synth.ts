/** Procedural image synthesis: deterministic RGBA plates (solid fills,
 * multi-stop linear gradients, checkerboards, seeded grain, grid paper) for
 * backgrounds, mattes, QA plates and motion-graphics assets. Pure pixel math
 * plus one handler that encodes through the design-studio pipeline into a
 * fresh git-ignored folder. No models, no network, no fonts: text, logos and
 * photographic content stay in SVG/HTML rendered by render_see. */
import fs from "node:fs/promises";
import path from "node:path";
import { integer, number, produced } from "./media-process.ts";
import { hex, parseHex, type Rgb, type Rgba } from "./image-analysis.ts";
import { encodeImage, studioFolder } from "./design-studio.ts";

export const SYNTH_OPS = ["solid", "linear-gradient", "checker", "noise", "grid"] as const;

const blank = (width: number, height: number): Rgba => ({ width, height, data: new Uint8Array(width * height * 4) });
const clamp8 = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);

export function synthSolid(width: number, height: number, color: Rgb): Rgba {
  const img = blank(width, height);
  for (let i = 0; i < width * height; i++) img.data.set([color[0], color[1], color[2], 255], i * 4);
  return img;
}

/** Multi-stop gradient. Angle is degrees clockwise from left-to-right in
 * image coordinates (0 = left→right, 90 = top→bottom); corners pin t = 0/1
 * exactly. Stops interpolate in sRGB. */
export function synthLinearGradient(width: number, height: number, stops: Array<{ color: Rgb; at: number }>, angleDeg: number): Rgba {
  const rad = angleDeg * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad);
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => x * dx + y * dy);
  const lo = Math.min(...corners), span = Math.max(...corners) - lo;
  const sample = (t: number): Rgb => {
    if (t <= stops[0].at) return stops[0].color;
    for (let i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i + 1].at || i === stops.length - 2) {
        const length = stops[i + 1].at - stops[i].at;
        if (length <= 0) return stops[i + 1].color;
        const k = Math.max(0, Math.min(1, (t - stops[i].at) / length));
        return [0, 1, 2].map(c => Math.round(stops[i].color[c] + (stops[i + 1].color[c] - stops[i].color[c]) * k)) as Rgb;
      }
    }
    return stops[stops.length - 1].color;
  };
  const img = blank(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = span > 0 ? ((x + 0.5) * dx + (y + 0.5) * dy - lo) / span : 0;
    img.data.set([...sample(Math.max(0, Math.min(1, t))), 255], (y * width + x) * 4);
  }
  return img;
}

export function synthChecker(width: number, height: number, size: number, a: Rgb, b: Rgb): Rgba {
  const img = blank(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = (Math.floor(x / size) + Math.floor(y / size)) % 2 ? b : a;
    img.data.set([color[0], color[1], color[2], 255], (y * width + x) * 4);
  }
  return img;
}

/** Deterministic seeded PRNG (mulberry32) for grain. Pure. */
export function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grain plate: uniform noise around a base color. Mono varies luminance
 * only (film-grain overlay); color varies each channel independently. */
export function synthNoise(width: number, height: number, base: Rgb, strength: number, mono: boolean, seed: number): Rgba {
  const rand = mulberry32(seed), img = blank(width, height);
  for (let i = 0; i < width * height; i++) {
    if (mono) {
      const delta = Math.round((rand() * 2 - 1) * strength);
      img.data.set([clamp8(base[0] + delta), clamp8(base[1] + delta), clamp8(base[2] + delta), 255], i * 4);
    } else {
      const channels = [0, 1, 2].map(c => clamp8(base[c] + Math.round((rand() * 2 - 1) * strength)));
      img.data.set([channels[0], channels[1], channels[2], 255], i * 4);
    }
  }
  return img;
}

export function synthGrid(width: number, height: number, step: number, background: Rgb, line: Rgb, lineWidth: number): Rgba {
  const img = synthSolid(width, height, background);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x % step < lineWidth || y % step < lineWidth) img.data.set([line[0], line[1], line[2], 255], (y * width + x) * 4);
  }
  return img;
}

const swatch = (value: unknown, fallback: string, name: string): Rgb => {
  if (value === undefined) return parseHex(fallback)!;
  const color = typeof value === "string" ? parseHex(value) : undefined;
  if (!color) throw new Error(`${name} must be #rrggbb`);
  return color;
};

/** Resolve stop positions: missing ends default to 0/1, missing interior
 * positions space evenly between their defined neighbours. Pure. */
export function resolveStops(raw: unknown): Array<{ color: Rgb; at: number }> {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) throw new Error("stops need 2..8 {color, at?} entries");
  const stops = raw.map((entry: any, index: number) => {
    if (!entry || typeof entry !== "object") throw new Error(`stops[${index}] must be {color, at?}`);
    const color = typeof entry.color === "string" ? parseHex(entry.color) : undefined;
    if (!color) throw new Error(`stops[${index}].color must be #rrggbb`);
    const at = entry.at === undefined ? undefined : number(entry.at, 0, 0, 1, `stops[${index}].at`);
    return { color, at };
  });
  if (stops[0].at === undefined) stops[0].at = 0;
  if (stops[stops.length - 1].at === undefined) stops[stops.length - 1].at = 1;
  let anchor = 0;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].at !== undefined) {
      const gap = i - anchor;
      for (let k = anchor + 1; k < i; k++) stops[k].at = stops[anchor].at! + (stops[i].at! - stops[anchor].at!) * (k - anchor) / gap;
      anchor = i;
    }
  }
  for (let i = 1; i < stops.length; i++) if (stops[i].at! < stops[i - 1].at!) throw new Error("stops must ascend from 0 to 1; repeat a position for a hard edge");
  return stops as Array<{ color: Rgb; at: number }>;
}

const relative = (cwd: string, file: string) => { const r = path.relative(cwd, file); return r.startsWith("..") ? file : r; };

export async function imageCreate(params: any, cwd: string, signal?: AbortSignal) {
  const op = params.op;
  if (!(SYNTH_OPS as readonly string[]).includes(op)) throw new Error(`op must be one of ${SYNTH_OPS.join(", ")}`);
  // 4096² RGBA caps allocation at 64 MiB, inside the per-target budgets the studio already decodes.
  const width = integer(params.width, 1280, 1, 4096, "width"), height = integer(params.height, 720, 1, 4096, "height");
  const format = params.format ?? "png";
  if (!["png", "jpg", "webp"].includes(format)) throw new Error("format must be png, jpg or webp");
  const quality = integer(params.quality, 90, 1, 100, "quality");
  signal?.throwIfAborted();
  let img: Rgba, design: Record<string, unknown>;
  if (op === "solid") {
    const color = swatch(params.color, "#3b82f6", "color");
    img = synthSolid(width, height, color); design = { color: hex(color) };
  } else if (op === "linear-gradient") {
    const stops = resolveStops(params.stops), angle = number(params.angle, 90, 0, 360, "angle");
    img = synthLinearGradient(width, height, stops, angle);
    design = { angle, stops: stops.map(s => ({ color: hex(s.color), at: Math.round(s.at * 1000) / 1000 })) };
  } else if (op === "checker") {
    const size = integer(params.size, 32, 1, 512, "size");
    const pair = params.colors === undefined ? ["#ffffff", "#cccccc"] : params.colors;
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("colors must be [a, b] #rrggbb pair");
    const [a, b] = [swatch(pair[0], "#ffffff", "colors[0]"), swatch(pair[1], "#cccccc", "colors[1]")];
    img = synthChecker(width, height, size, a, b); design = { size, colors: [hex(a), hex(b)] };
  } else if (op === "noise") {
    const base = swatch(params.color, "#808080", "color");
    const strength = integer(params.strength, 24, 1, 128, "strength"), mono = params.mono ?? true, seed = integer(params.seed, 1, 0, 4294967295, "seed");
    if (typeof mono !== "boolean") throw new Error("mono must be boolean");
    img = synthNoise(width, height, base, strength, mono, seed);
    design = { color: hex(base), strength, mono, seed };
  } else {
    const step = integer(params.step, 64, 2, 1024, "step"), lineWidth = integer(params.lineWidth, 1, 1, 32, "lineWidth");
    const background = swatch(params.background, "#ffffff", "background"), line = swatch(params.line, "#94a3b8", "line");
    img = synthGrid(width, height, step, background, line, lineWidth);
    design = { step, lineWidth, background: hex(background), line: hex(line) };
  }
  signal?.throwIfAborted();
  const dir = await studioFolder(params.outputDir, cwd, "synth");
  const file = path.join(dir, `image.${format}`);
  await fs.writeFile(file, await encodeImage(img, format as any, { quality }, signal), { flag: "wx" });
  const artifact = await produced(file);
  return {
    op, file: relative(cwd, file), dir: relative(cwd, dir), format, bytes: artifact.bytes,
    pixels: { width, height }, design,
    note: "Deterministic pixels from explicit parameters: the same inputs render the same bytes. Verify appearance with read/render_see. Text, logos and photographic content are out of scope: author SVG/HTML and render it instead.",
  };
}
