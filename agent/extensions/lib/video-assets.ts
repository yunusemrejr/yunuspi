/** Media for video projects from the open web and from disk, with the license
 * of every file recorded. Search covers Openverse and Wikimedia Commons
 * (photographs, illustration, footage) and Poly Haven (CC0 3D models and
 * textures); fetch downloads through the SSRF-guarded client into
 * public/assets, shrinks oversized images, appends to a provenance manifest
 * and adds attribution lines to video.json when the license asks for them. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspectGltf, stageGltfBundle } from "./gltf-inspect.ts";
import { registerAsset } from "./asset-registry.ts";
import { inputFile } from "./media-process.ts";
import { decodeImage, encodeImage, probeImage } from "./design-studio.ts";
import { projectDir, projectWritePath, readSpec } from "./video-studio.ts";

type Progress = (text: string) => void;
export type AssetHit = { source: string; id: string; kind: "image" | "video" | "model" | "texture"; title: string; creator: string; license: string; licenseUrl?: string; attributionRequired: boolean; url?: string; thumbnail?: string; page?: string; width?: number; height?: number; polycount?: number };

const UA = { "user-agent": "YunusPi-video-assets/1", accept: "application/json" };
const SOURCES = ["openverse", "commons", "polyhaven"] as const;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const MODEL_EXT = new Set([".glb", ".gltf"]);
const MAX_IMAGE_SIDE = 2560;
const strip = (html: unknown) => String(html ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "asset";

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { headers: UA, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

/** Licenses whose terms forbid derivatives or commercial use cannot be animated
 * and published, so they are never offered. */
const usable = (license: string) => !/\b(nc|nd)\b|-nc|-nd|noncommercial|no derivatives/i.test(license);
const needsCredit = (license: string) => !/^(cc0|pdm|public domain|cc zero)/i.test(license.trim());

async function searchOpenverse(query: string, kind: string, limit: number, signal?: AbortSignal): Promise<AssetHit[]> {
  const data = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(20, limit * 2)}&license_type=commercial&mature=false`, signal);
  return (data.results ?? []).flatMap((r: any): AssetHit[] => {
    const license = `${String(r.license).toUpperCase() === "CC0" ? "CC0" : `CC ${String(r.license).toUpperCase()}`}${r.license_version && r.license !== "cc0" ? ` ${r.license_version}` : ""}`;
    return usable(license) && r.url ? [{ source: "openverse", id: r.id, kind: "image", title: r.title || "Untitled", creator: r.creator || "Unknown", license, licenseUrl: r.license_url, attributionRequired: needsCredit(license), url: r.url, thumbnail: r.thumbnail, page: r.foreign_landing_url, width: r.width, height: r.height }] : [];
  }).slice(0, limit);
}

async function searchCommons(query: string, kind: string, limit: number, signal?: AbortSignal): Promise<AssetHit[]> {
  const type = kind === "video" ? "video" : "bitmap";
  const data = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(`${query} filetype:${type}`)}&gsrnamespace=6&gsrlimit=${Math.min(30, limit * 3)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=2400`, signal);
  return Object.values<any>(data.query?.pages ?? {}).flatMap((p): AssetHit[] => {
    const info = p.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const license = strip(meta.LicenseShortName?.value) || "Unknown";
    if (!info || !usable(license) || license === "Unknown") return [];
    const file = kind === "video" ? info.url : info.thumburl && info.width > 2400 ? info.thumburl : info.url;
    return [{ source: "commons", id: String(p.title).replace(/^File:/, ""), kind: kind === "video" ? "video" : "image", title: strip(meta.ObjectName?.value) || String(p.title).replace(/^File:/, ""), creator: strip(meta.Artist?.value) || "Unknown", license, licenseUrl: meta.LicenseUrl?.value, attributionRequired: strip(meta.AttributionRequired?.value) === "true" || needsCredit(license), url: file, thumbnail: info.thumburl, page: info.descriptionurl, width: info.width, height: info.height }];
  }).slice(0, limit);
}

let polyIndex: Record<string, any> | undefined;
async function searchPolyHaven(query: string, kind: string, limit: number, signal?: AbortSignal): Promise<AssetHit[]> {
  const type = kind === "texture" ? "textures" : "models";
  polyIndex ??= {};
  polyIndex[type] ??= await getJson(`https://api.polyhaven.com/assets?t=${type}`, signal);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries<any>(polyIndex[type]).map(([id, a]) => {
    const hay = `${id} ${a.name} ${(a.tags ?? []).join(" ")} ${(a.categories ?? []).join(" ")}`.toLowerCase();
    return { id, a, score: terms.filter((t) => hay.includes(t)).length };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score || (y.a.download_count ?? 0) - (x.a.download_count ?? 0)).slice(0, limit).map(({ id, a }): AssetHit => ({
    source: "polyhaven", id, kind: kind === "texture" ? "texture" : "model", title: a.name, creator: Object.keys(a.authors ?? {}).join(", ") || "Poly Haven", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", attributionRequired: false,
    thumbnail: a.thumbnail_url, page: `https://polyhaven.com/a/${id}`, polycount: a.polycount }));
}

export async function searchAssets(params: any, signal?: AbortSignal): Promise<AssetHit[]> {
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const source = params.source ?? (params.kind === "model" || params.kind === "texture" ? "polyhaven" : "openverse");
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}`);
  const limit = Math.min(12, Math.max(1, params.limit ?? 6));
  const kind = params.kind ?? (source === "polyhaven" ? "model" : "image");
  if (source === "polyhaven") return searchPolyHaven(query, kind, limit, signal);
  if (source === "commons") return searchCommons(query, kind, limit, signal);
  if (kind === "video") throw new Error("Openverse has no footage; search source commons with kind video");
  return searchOpenverse(query, kind, limit, signal);
}

const extensionOf = (type: string, url: string) => {
  const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
  if ([...IMAGE_EXT, ...VIDEO_EXT, ...MODEL_EXT].includes(fromUrl)) return fromUrl;
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm", "model/gltf-binary": ".glb" } as Record<string, string>)[type] ?? "";
};

const modelSummary = (m: any) => ({ format: m.format, bytes: m.bytes, sha256: m.sha256, bundleSha256: m.bundleSha256, counts: m.counts, meshLocalBounds: m.meshLocalBounds, boundsComplete: m.boundsComplete, animationClips: m.animationClips, extensionsRequired: m.extensionsRequired, warnings: m.warnings, rendered: false });

async function sha256(file: string) { return createHash("sha256").update(await fs.readFile(file)).digest("hex"); }

/** Shrink oversized images (a 6000 px photograph costs decode time in every
 * frame) through the sandboxed decode/encode path. Animated GIFs are left alone. */
async function fitImage(file: string, signal?: AbortSignal): Promise<{ width?: number; height?: number }> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") return {};
  const bytes = await fs.readFile(file);
  const info = await probeImage(bytes, signal);
  if (Math.max(info.width, info.height) <= MAX_IMAGE_SIDE || ext === ".gif") return { width: info.width, height: info.height };
  const decoded = await decodeImage(bytes, { maxWidth: info.width >= info.height ? MAX_IMAGE_SIDE : Math.round(MAX_IMAGE_SIDE * info.width / info.height) }, signal);
  const format = ext === ".png" ? "png" : ext === ".webp" ? "webp" : "jpg";
  await fs.writeFile(file, await encodeImage(decoded, format, { quality: 90 }, signal));
  return { width: decoded.width, height: decoded.height };
}

async function record(dir: string, entry: Record<string, unknown>) {
  const manifest = projectWritePath(dir, "public", "assets", "assets.json");
  const list: any[] = existsSync(manifest) ? JSON.parse(await fs.readFile(manifest, "utf8")) : [];
  await fs.writeFile(manifest, JSON.stringify([...list.filter((e) => e.file !== entry.file), entry], null, 2) + "\n");
  if (entry.attributionRequired) {
    const spec = await readSpec(dir);
    const line = `"${entry.title}" by ${entry.creator} (${entry.license})${entry.page ? ` ${entry.page}` : ""}`;
    const credits: string[] = spec.publish?.credits ?? [];
    if (!credits.includes(line)) {
      spec.publish = { intent: "publish", ...spec.publish, credits: [...credits, line] };
      await fs.writeFile(path.join(dir, "video.json"), JSON.stringify(spec, null, 2) + "\n");
    }
  }
}

async function download(url: string, dest: string, signal: AbortSignal | undefined, maxBytes: number, accept?: RegExp) {
  const { fetchBinary } = await import("../http-tools.ts");
  const got = await fetchBinary({ url, maxBytes, timeoutMs: 120_000, accept }, signal);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, got.bytes, { flag: "wx" });
  return got;
}

async function fetchPolyHaven(dir: string, params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const id = String(params.id ?? "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("id must be a Poly Haven asset id (from search)");
  const files = await getJson(`https://api.polyhaven.com/files/${id}`, signal);
  const resolution = params.resolution ?? "1k";
  const meta = (polyIndex?.models?.[id] ?? polyIndex?.textures?.[id]) ?? (await getJson(`https://api.polyhaven.com/info/${id}`, signal));
  const base = { source: "polyhaven", title: meta.name ?? id, creator: Object.keys(meta.authors ?? {}).join(", ") || "Poly Haven", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", attributionRequired: false, page: `https://polyhaven.com/a/${id}`, fetchedAt: new Date().toISOString() };
  if (files.gltf) {
    const model = files.gltf[resolution]?.gltf;
    if (!model) throw new Error(`${id} has no gltf at ${resolution}; available: ${Object.keys(files.gltf).join(", ")}`);
    const root = `assets/models/${id}`;
    let total = 0;
    const parts: Array<[string, string]> = [[`${id}.gltf`, model.url], ...Object.entries<any>(model.include ?? {}).map(([rel, f]): [string, string] => [rel, f.url])];
    for (const [rel, url] of parts) {
      if (rel.includes("..") || path.isAbsolute(rel)) throw new Error(`Refusing unsafe model path ${rel}`);
      progress?.(`Downloading ${rel}…`);
      const got = await download(url, projectWritePath(dir, "public", root, rel), signal, 40 * 1024 * 1024);
      total += got.bytes.length;
      if (total > 90 * 1024 * 1024) throw new Error("Model exceeds 90 MB; try resolution 1k");
    }
    const file = `${root}/${id}.gltf`;
    const inspected = await inspectGltf(projectWritePath(dir, "public", file), signal);
    await record(dir, { file, kind: "model", bytes: total, resolution, ...base, model: modelSummary(inspected), sha256: inspected.sha256 });
    const registered = (await registerAsset({ path: projectWritePath(dir, "public", file), role: "product-shot", kind: "authored", description: base.title, license: base.license, creator: base.creator, licenseUrl: base.licenseUrl, sourceUrl: base.page, usage: [path.relative(cwd, path.join(dir, "video.json"))] }, cwd)).record;
    return { file, kind: "model", license: "CC0", bytes: total, assetId: registered.id, model: modelSummary(inspected), use: `Model3D src="${file}" (run video_project action:"feature" feature:"3d" once if the project has no 3D support)` };
  }
  const tex = files.Diffuse?.[resolution === "1k" ? "2k" : resolution]?.jpg ?? files.Diffuse?.["1k"]?.jpg;
  if (!tex) throw new Error(`${id} has neither a glTF model nor a diffuse texture`);
  const file = `assets/${slug(params.name ?? id)}.jpg`;
  await download(tex.url, projectWritePath(dir, "public", file), signal, 40 * 1024 * 1024, /^image\//);
  const dims = await fitImage(projectWritePath(dir, "public", file), signal);
  await record(dir, { file, kind: "texture", ...dims, ...base });
  return { file, kind: "texture", license: "CC0", ...dims, use: `MediaFrame src="${file}"` };
}

export async function videoAssets(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const action = params.action ?? "search";
  if (action === "search") {
    const hits = await searchAssets(params, signal);
    return { query: params.query, count: hits.length, hits, note: hits.length ? "Pass a hit to action fetch (url or source+id, plus title, creator, license, page) to add it to the project. Every hit is licensed for commercial use with derivatives; attribution-required ones are credited automatically." : "No usable results (licenses that forbid commercial use or derivatives are filtered out). Try broader words, another source (commons, openverse, polyhaven) or a kind of video/model/texture." };
  }
  const dir = await projectDir(params.dir, cwd);
  const manifestPath = projectWritePath(dir, "public", "assets", "assets.json");
  if (action === "list") return { assets: existsSync(manifestPath) ? JSON.parse(await fs.readFile(manifestPath, "utf8")) : [], credits: (await readSpec(dir)).publish?.credits ?? [] };
  if (action === "fetch" && params.source === "polyhaven") return fetchPolyHaven(dir, params, cwd, signal, progress);
  if (action !== "fetch" && action !== "import") throw new Error("action must be search, fetch, import or list");
  const isImport = action === "import";
  let title = String(params.title ?? "").trim(), url = String(params.url ?? ""), staged: string;
  const name = slug(params.name ?? title ?? "asset");
  let model: any;
  if (isImport) {
    const source = await inputFile(params.path, cwd);
    const ext = path.extname(source).toLowerCase();
    if (![...IMAGE_EXT, ...VIDEO_EXT, ...MODEL_EXT, ".mp3", ".wav"].includes(ext)) throw new Error(`Unsupported file type ${ext}`);
    if (MODEL_EXT.has(ext)) {
      const modelDir = projectWritePath(dir, "public", "assets", "models", name || slug(path.basename(source, ext)));
      await fs.mkdir(path.dirname(modelDir), { recursive: true });
      const imported = await stageGltfBundle(source, modelDir, signal);
      staged = imported.path; model = imported.report;
    } else {
      staged = projectWritePath(dir, "public", "assets", `${name || slug(path.basename(source, ext))}${ext}`);
      const stat = await fs.stat(source); if (stat.size > 64 * 1024 * 1024) throw new Error("Local media import exceeds 64 MiB");
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(source, staged, fs.constants.COPYFILE_EXCL);
    }
    title ||= path.basename(source);
  } else {
    if (!url) throw new Error("fetch needs a url from a search hit (or source polyhaven with id)");
    progress?.(`Downloading ${url}…`);
    const dest = projectWritePath(dir, "public", "assets", `.download-${name}`);
    const got = await download(url, dest, signal, 64 * 1024 * 1024, /^(image\/|video\/|model\/|application\/octet-stream|binary\/octet-stream)/);
    const ext = extensionOf(got.contentType, got.url);
    if (!ext) { await fs.rm(dest, { force: true }); throw new Error(`Unrecognized media type ${got.contentType}`); }
    staged = projectWritePath(dir, "public", "assets", `${name}${ext}`);
    try { await fs.link(dest, staged); } finally { await fs.rm(dest, { force: true }); }
    title ||= name;
  }
  const ext = path.extname(staged).toLowerCase();
  const kind = IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : MODEL_EXT.has(ext) ? "model" : "audio";
  if (kind === "model" && !model) model = await inspectGltf(staged, signal);
  const dims = kind === "image" ? await fitImage(staged, signal) : {};
  const license = String(params.license ?? (isImport ? "user-supplied" : "unknown"));
  const attributionRequired = params.attributionRequired ?? (!isImport && license !== "unknown" && needsCredit(license));
  const file = path.relative(path.join(dir, "public"), staged);
  await record(dir, { file, kind, title, creator: params.creator ?? (isImport ? "" : "unknown"), license, licenseUrl: params.licenseUrl, attributionRequired, source: isImport ? "local" : (params.source ?? new URL(url).host), page: params.page, ...dims, ...(model ? { model: modelSummary(model) } : {}), bytes: model?.bytes ?? (await fs.stat(staged)).size, sha256: await sha256(staged), fetchedAt: new Date().toISOString() });
  const registered = (await fs.stat(staged)).size <= 40 * 1024 * 1024 ? (await registerAsset({ path: staged, kind: "authored", role: kind === "model" ? "product-shot" : "editorial-support", description: title, license, sourceUrl: params.page ?? (!isImport ? url : undefined), creator: params.creator, licenseUrl: params.licenseUrl, usage: [path.relative(cwd, path.join(dir, "video.json"))] }, cwd)).record : undefined;
  return { file, kind, ...dims, license, attributionRequired, assetId: registered?.id ?? null, ...(model ? { model: modelSummary(model) } : {}), ...(license === "unknown" ? { warning: "License unknown: pass license, creator and page from the search hit. Do not publish media whose license you cannot state." } : {}),
    use: kind === "video" ? `Clip src="${file}"` : kind === "image" ? `MediaFrame src="${file}" motion="push"` : kind === "model" ? `Model3D src="${file}" (video_project feature 3d uses the existing Three.js renderer; inspect actual stills/playback)` : `video.json audio track path="${file}"` };
}
