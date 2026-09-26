/**
 * Asset registry — provenance, roles and reuse for creative artifacts.
 *
 * WHY: creative workflows scatter hero-final2-new-v3.png across artifact
 * folders with no record of why an asset exists, which source or prompt
 * produced it, where it is used, or which crop is current. The registry
 * records role, source, derivation, dimensions, palette, hash, variants,
 * usage and provenance in one workspace-local store so agents reuse instead
 * of regenerating. Roles carry constraints (a background must not hold a
 * focal point; an icon must stay legible tiny) that generation and review
 * read. Search is lexical plus palette distance today; descriptions are
 * stored so a future vector pass can embed meaning without re-ingesting.
 *
 * Store: `<workspace>/.pi/assets/registry.json` (git-ignored, atomic
 * writes, bounded). File helpers are async; validation/search are pure.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const ASSET_REGISTRY_VERSION = 1;
const MAX_ASSETS = 500;
const MAX_TEXT = 500;

export type AssetRole =
  | "hero-focal" | "editorial-support" | "diagram" | "texture" | "icon"
  | "illustration" | "background" | "product-shot" | "avatar" | "generic";

export const ASSET_ROLES: readonly AssetRole[] = [
  "hero-focal", "editorial-support", "diagram", "texture", "icon",
  "illustration", "background", "product-shot", "avatar", "generic",
];

export type AssetKind = "generated" | "cropped" | "traced" | "authored" | "plate" | "captured";

/** Role constraints read by generation and review. Advisory strings, not
 * enforcement: the reviewer judges fit. */
export const ROLE_CONSTRAINTS: Record<AssetRole, readonly string[]> = {
  "hero-focal": ["must survive responsive crops", "reserved text-safe area", "dominant subject placement", "high semantic relevance to the page promise"],
  "editorial-support": ["supports adjacent copy without competing", "caption/credit recorded when authorship matters"],
  diagram: ["labels legible at display size", "data claims traceable to a source", "readable without color alone"],
  texture: ["tiles or fades without visible seams", "low information density", "no accidental focal point"],
  icon: ["transparent background unless specified", "legible at 16px", "shares the set grid/stroke/corner language"],
  illustration: ["shares the visual vocabulary (geometry, stroke, palette)", "scales across placements without redraw"],
  background: ["low information density", "no strong focal point", "safe contrast behind overlaid text"],
  "product-shot": ["accurate color and proportion", "clean isolation edge when cut out"],
  avatar: ["recognizable at 32px", "centered subject surviving circular crops"],
  generic: ["role unassigned: set a role before shipping so review knows the constraints"],
};

export const roleConstraints = (role: string): readonly string[] =>
  (ROLE_CONSTRAINTS as Record<string, readonly string[]>)[role] ?? ROLE_CONSTRAINTS.generic;

export interface AssetRecord {
  id: string;
  role: AssetRole;
  file: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alpha: boolean | null;
  palette: string[];
  hash: string;
  kind: AssetKind;
  prompt: string | null;
  sourceImage: string | null;
  parent: string | null;
  variants: string[];
  usage: string[];
  license: string | null;
  description: string;
  createdAt: number;
}

export interface AssetRegistry {
  version: number;
  assets: AssetRecord[];
}

export const emptyRegistry = (): AssetRegistry => ({ version: ASSET_REGISTRY_VERSION, assets: [] });

const cleanText = (value: unknown, max = MAX_TEXT): string => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};

const cleanList = (value: unknown, max = 32): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry, 256);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
};

const sanitizeRecord = (raw: unknown): AssetRecord | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.file !== "string" || !r.file) return undefined;
  if (typeof r.hash !== "string" || !r.hash) return undefined;
  const role = ASSET_ROLES.includes(r.role as AssetRole) ? (r.role as AssetRole) : "generic";
  const kind = ["generated", "cropped", "traced", "authored", "plate", "captured"].includes(String(r.kind)) ? (String(r.kind) as AssetKind) : "authored";
  return {
    id: r.id.slice(0, 64),
    role, file: r.file.slice(0, 1024),
    bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? Math.max(0, Math.floor(r.bytes)) : 0,
    width: typeof r.width === "number" && Number.isFinite(r.width) ? r.width : null,
    height: typeof r.height === "number" && Number.isFinite(r.height) ? r.height : null,
    alpha: typeof r.alpha === "boolean" ? r.alpha : null,
    palette: Array.isArray(r.palette) ? r.palette.filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 8) : [],
    hash: r.hash.slice(0, 64),
    kind,
    prompt: typeof r.prompt === "string" ? r.prompt.slice(0, 2000) : null,
    sourceImage: typeof r.sourceImage === "string" ? r.sourceImage.slice(0, 1024) : null,
    parent: typeof r.parent === "string" ? r.parent.slice(0, 64) : null,
    variants: Array.isArray(r.variants) ? r.variants.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 64)).slice(0, 32) : [],
    usage: Array.isArray(r.usage) ? r.usage.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 1024)).slice(0, 64) : [],
    license: typeof r.license === "string" ? r.license.slice(0, 256) : null,
    description: typeof r.description === "string" ? r.description.slice(0, MAX_TEXT) : "",
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
  };
};

export function registryFile(cwd: string): string {
  return path.join(cwd, ".pi", "assets", "registry.json");
}

export async function readRegistry(cwd: string): Promise<AssetRegistry> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(registryFile(cwd), "utf8"));
    const assets = Array.isArray((raw as AssetRegistry)?.assets) ? (raw as AssetRegistry).assets : [];
    return {
      version: ASSET_REGISTRY_VERSION,
      assets: assets.map(sanitizeRecord).filter((a): a is AssetRecord => !!a).slice(0, MAX_ASSETS),
    };
  } catch {
    return emptyRegistry();
  }
}

export async function writeRegistry(cwd: string, registry: AssetRegistry): Promise<void> {
  const dir = path.join(cwd, ".pi", "assets");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n!registry.json\n", { flag: "wx" }).catch(() => {});
  const file = registryFile(cwd);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: ASSET_REGISTRY_VERSION, assets: registry.assets.slice(0, MAX_ASSETS) }), { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
}

// ─────────────────────────── measurement ─────────────────────────────────

/** Header-sniffed raster dimensions: dependency-free and hermetic (no
 * ffprobe needed for registration). PNG/GIF exact; JPEG via SOF scan;
 * WebP via VP8/VP8L/VP8X headers; SVG via its own measure. */
export function sniffDimensions(bytes: Buffer): { width: number | null; height: number | null; alpha: boolean | null } {
  const unknown = { width: null, height: null, alpha: null };
  if (bytes.length < 10) return unknown;
  if (bytes.length >= 33 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: [4, 6].includes(bytes[25]) ? true : bytes[25] === 3 ? null : false };
  }
  if (bytes.subarray(0, 6).toString("latin1").startsWith("GIF8") && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), alpha: null };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length && i < 1_000_000) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0x01 || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8)) {
        if (marker === 0x01) { i += 2; continue; }
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5), alpha: false };
      }
      const len = bytes.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return unknown;
  }
  if (bytes.length >= 21 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("latin1");
    if (chunk === "VP8 " && bytes.length >= 30) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, alpha: null };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b = bytes.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, alpha: true };
    }
    if (chunk === "VP8X" && bytes.length >= 30) {
      const w = bytes.readUIntLE(24, 3) + 1, h = bytes.readUIntLE(27, 3) + 1;
      return { width: w, height: h, alpha: (bytes[20] & 0x10) !== 0 ? true : null };
    }
  }
  return unknown;
}

/** Normalize a registration request. Pure. */
export function normalizeAssetInput(raw: unknown): {
  role: AssetRole; kind: AssetKind; prompt: string | null; parent: string | null;
  usage: string[]; license: string | null; description: string; id: string | null;
} {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const role = ASSET_ROLES.includes(input.role as AssetRole) ? (input.role as AssetRole) : "generic";
  const kind = ["generated", "cropped", "traced", "authored", "plate", "captured"].includes(String(input.kind)) ? (String(input.kind) as AssetKind) : "authored";
  return {
    role, kind,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim().slice(0, 2000) : null,
    parent: typeof input.parent === "string" && input.parent.trim() ? input.parent.trim().slice(0, 64) : null,
    usage: cleanList(input.usage, 64).map((u) => u.slice(0, 1024)),
    license: typeof input.license === "string" && input.license.trim() ? input.license.trim().slice(0, 256) : null,
    description: cleanText(input.description),
    id: typeof input.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id) ? input.id : null,
  };
}

export async function registerAsset(
  params: { path: string } & Record<string, unknown>, cwd: string,
): Promise<{ record: AssetRecord; duplicateOf: string | null }> {
  if (typeof params.path !== "string" || !params.path) throw new Error("asset_register needs a workspace-relative path");
  const root = await fs.realpath(cwd);
  const resolved = path.resolve(root, params.path.replace(/^@/, ""));
  if (!resolved.startsWith(root)) throw new Error("Asset path must stay inside the workspace");
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error("Asset must be a regular file under 40 MiB");
  const bytes = await fs.readFile(resolved);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const input = normalizeAssetInput(params);
  const registry = await readRegistry(root);
  const duplicate = registry.assets.find((a) => a.hash === hash);
  if (duplicate && !input.id) return { record: duplicate, duplicateOf: duplicate.id };
  if (input.id && registry.assets.some((a) => a.id === input.id)) throw new Error(`Asset id "${input.id}" is already registered`);
  let dims = sniffDimensions(bytes);
  let palette: string[] = [];
  if (/\.svg$/i.test(resolved)) {
    try {
      const { measureSvg } = await import("./svg-inspect.ts");
      const measured = measureSvg(bytes.toString("utf8"), resolved);
      const vb = measured.viewBox;
      dims = { width: vb?.width ?? measured.width, height: vb?.height ?? measured.height, alpha: null };
      palette = measured.fills.filter((f) => /^#[0-9a-fA-F]{6}$/.test(f)).slice(0, 8);
    } catch { /* measurement is advisory; registration still records the file */ }
  }
  const record: AssetRecord = {
    id: input.id ?? `asset-${hash.slice(0, 8)}`,
    role: input.role, file: path.relative(root, resolved) || path.basename(resolved),
    bytes: stat.size, width: dims.width, height: dims.height, alpha: dims.alpha, palette,
    hash, kind: input.kind, prompt: input.prompt,
    sourceImage: typeof params.sourceImage === "string" ? params.sourceImage.slice(0, 1024) : null,
    parent: input.parent && registry.assets.some((a) => a.id === input.parent) ? input.parent : null,
    variants: [], usage: input.usage, license: input.license, description: input.description, createdAt: Date.now(),
  };
  if (record.parent) {
    const parent = registry.assets.find((a) => a.id === record.parent)!;
    if (!parent.variants.includes(record.id)) parent.variants = [...parent.variants, record.id].slice(0, 32);
  }
  registry.assets = [...registry.assets.filter((a) => a.id !== record.id), record].slice(-MAX_ASSETS);
  await writeRegistry(root, registry);
  return { record, duplicateOf: null };
}

// ─────────────────────────── search ──────────────────────────────────────

const hexRgb = (hexColor: string): [number, number, number] | null => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hexColor);
  if (!match) return null;
  const v = Number.parseInt(match[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

const colorDistance = (a: string, b: string): number => {
  const ra = hexRgb(a), rb = hexRgb(b);
  if (!ra || !rb) return Infinity;
  return Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2]);
};

export interface AssetQuery {
  role?: unknown;
  query?: unknown;
  paletteNear?: unknown;
  parent?: unknown;
  kind?: unknown;
  limit?: unknown;
}

/** Deterministic asset search: role/kind/parent filters plus lexical
 * description/prompt/file match and palette proximity. Pure. */
export function searchAssets(registry: AssetRegistry, params: AssetQuery): AssetRecord[] {
  const role = typeof params.role === "string" && ASSET_ROLES.includes(params.role as AssetRole) ? params.role : undefined;
  const kind = typeof params.kind === "string" ? params.kind : undefined;
  const parent = typeof params.parent === "string" ? params.parent : undefined;
  const terms = cleanText(params.query, 200).toLowerCase().split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
  const near = typeof params.paletteNear === "string" && hexRgb(params.paletteNear) ? params.paletteNear : undefined;
  const limit = Math.max(1, Math.min(32, Math.round(Number(params.limit) || 10)));
  const scored: Array<{ record: AssetRecord; score: number }> = [];
  for (const record of registry.assets) {
    if (role && record.role !== role) continue;
    if (kind && record.kind !== kind) continue;
    if (parent && record.parent !== parent) continue;
    let score = 0;
    if (terms.length) {
      const haystack = `${record.description} ${record.prompt ?? ""} ${record.file} ${record.id} ${record.role}`.toLowerCase();
      const hits = terms.filter((t) => haystack.includes(t));
      if (!hits.length) continue;
      score += hits.length * 10;
      if (record.description.toLowerCase().includes(terms[0])) score += 5;
    }
    if (near && record.palette.length) {
      const best = Math.min(...record.palette.map((c) => colorDistance(c, near)));
      if (best > 200) continue;
      score += Math.max(0, 12 - Math.floor(best / 20));
    }
    scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt);
  return scored.slice(0, limit).map((s) => s.record);
}

export async function recordAssetUsage(cwd: string, id: string, location: string): Promise<AssetRecord> {
  const root = await fs.realpath(cwd);
  const registry = await readRegistry(root);
  const record = registry.assets.find((a) => a.id === id);
  if (!record) throw new Error(`Asset "${id}" is not registered`);
  const loc = cleanText(location, 1024);
  if (!loc) throw new Error("usage location must be a non-empty path or URL");
  if (!record.usage.includes(loc)) record.usage = [...record.usage, loc].slice(0, 64);
  await writeRegistry(root, registry);
  return record;
}
