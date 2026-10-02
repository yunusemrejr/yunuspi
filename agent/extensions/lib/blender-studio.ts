/** Headless Blender for agents: a pinned local install, free-form bpy
 * scripts, scene inspection, bounded renders with contact sheets, asset
 * export and multi-view dataset capture for Gaussian-splat training. Every
 * Blender process runs guarded (harness read-only), niced, memory-watched and
 * under a deadline through the shared studio process runner. */
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { runGuarded, throttled, type Progress } from "./guarded-process.ts";
import { memoryBudgetMb } from "./memory-guard.ts";
import { FFMPEG_FLAGS, produced, run } from "./media-process.ts";
import { contactSheetFilter } from "./video-studio.ts";

const AGENT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const BLENDER_WORKER = path.join(AGENT_ROOT, "scripts/blender-studio.py");
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const blenderHome = () => path.join(agentDir(), "local-tools", "blender");

/** Pinned portable Linux build (LTS). Verified by sha256 from blender.org's release checksum file. */
export const BLENDER_RELEASE = {
  version: "5.2.2",
  url: "https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz",
  sha256: "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168",
  bytes: 1_200_000_000,
  dir: "blender-5.2.2-linux-x64",
};
export const RENDER_ENGINES = ["EEVEE", "CYCLES", "WORKBENCH"] as const;
export const EXPORT_FORMATS = ["glb", "gltf", "obj", "ply", "stl", "usd", "usda", "usdc", "usdz", "fbx", "abc", "blend", "dataset"] as const;
export const IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "OPEN_EXR", "TIFF"] as const;

/** Binary resolution order: explicit env, the harness-local pinned install, then PATH. */
export function blenderBinary(): string | undefined {
  const candidates = [process.env.YUNUSPI_BLENDER, path.join(blenderHome(), "current", "blender")].filter(Boolean) as string[];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const onPath = (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, "blender")).find((file) => existsSync(file));
  return onPath;
}

function requireBlender(): string {
  const binary = blenderBinary();
  if (!binary) throw new Error('Blender is not installed; run blender_setup action:"install" (downloads the pinned 5.2.2 LTS portable build once, ≈350 MB) or set YUNUSPI_BLENDER to an existing binary');
  return binary;
}

// ───────────────────────────── paths ─────────────────────────────

async function workspaceRoot(cwd: string) { return fs.realpath(cwd); }

/** Any readable local file (a .blend may live outside the workspace, e.g. a shared asset library). */
async function readablePath(value: unknown, cwd: string): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("Use a local filesystem path, not a URL");
  const file = canonicalMutationPath(value, await workspaceRoot(cwd));
  const stat = await fs.stat(file).catch(() => { throw new Error(`${file} does not exist`); });
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  return file;
}

/** Writes stay inside the workspace and outside the harness. */
export async function writablePath(value: unknown, cwd: string, mustBeDir = false): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("output path must be a local path inside the workspace, not a URL");
  const root = await workspaceRoot(cwd);
  const target = canonicalMutationPath(value, root);
  if (!containsPath(root, target)) throw new Error("Output must be inside the current workspace");
  const denial = selfMutationDenial(target, root);
  if (denial) throw new Error(denial);
  if (mustBeDir) await fs.mkdir(target, { recursive: true });
  else await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

async function freshOutputDir(value: unknown, cwd: string, kind: string): Promise<string> {
  const base = await writablePath(value ?? path.join(".pi", "blender"), cwd, true);
  const dir = path.join(base, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomBytes(2).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ───────────────────────────── process ─────────────────────────────

const RESULT_MARK = "YUNUSPI_RESULT ";
const PROGRESS_MARK = "YUNUSPI_PROGRESS ";

/** Run Blender headless with the worker script and a JSON request; returns the worker's result object. */
async function worker(req: Record<string, unknown>, options: { cwd: string; blend?: string; signal?: AbortSignal; timeoutMs: number; progress?: Progress; factoryStartup?: boolean }) {
  const binary = requireBlender();
  const requestPath = path.join(os.tmpdir(), `yunuspi-blender-${randomBytes(6).toString("hex")}.json`);
  await fs.writeFile(requestPath, JSON.stringify(req), { mode: 0o600 });
  const args = ["-b", ...(options.blend ? [options.blend] : []), ...(options.factoryStartup === false ? [] : ["--factory-startup"]), "-noaudio", "--python-exit-code", "1", "-P", BLENDER_WORKER, "--", requestPath];
  let result: any;
  const report = throttled(options.progress, 2000);
  try {
    await runGuarded(binary, args, { cwd: options.cwd, signal: options.signal, timeoutMs: options.timeoutMs, nice: 10, env: blenderEnv(), onLine: (line) => {
      if (line.startsWith(RESULT_MARK)) { try { result = JSON.parse(line.slice(RESULT_MARK.length)); } catch { /* keep stdout tail for the error */ } }
      else if (line.startsWith(PROGRESS_MARK)) report(line.slice(PROGRESS_MARK.length));
      else if (/^Fra:\d+ /.test(line)) report(line.replace(/\s+\|\s+/g, " · ").slice(0, 120));
    } });
  } catch (error: any) {
    if (result && result.ok === false) throw new Error(`Blender ${req.op}: ${result.error}`);
    throw error;
  } finally {
    await fs.rm(requestPath, { force: true });
  }
  if (!result) throw new Error(`Blender exited without a result for ${req.op}; the worker script did not run (check the stderr tail or Blender version)`);
  if (result.ok === false) throw new Error(`Blender ${req.op}: ${result.error}`);
  return result;
}

/** Keep Blender deterministic and quiet in headless use; GPU is never assumed. */
function blenderEnv(): Record<string, string> {
  return { PYTHONDONTWRITEBYTECODE: "1", CYCLES_DEVICE: "CPU", OMP_NUM_THREADS: String(Math.max(1, Math.floor(os.availableParallelism() / 2))) };
}

// ───────────────────────────── setup ─────────────────────────────

export async function blenderStatus(signal?: AbortSignal) {
  const binary = blenderBinary();
  let version: string | undefined;
  if (binary) {
    try {
      const { stdout } = await runGuarded(binary, ["-b", "--version"], { cwd: os.tmpdir(), signal, timeoutMs: 60_000, guard: false, env: blenderEnv() });
      version = stdout.match(/Blender\s+([\d.]+(?:\s+LTS)?)/)?.[1];
    } catch (error: any) { version = `unusable: ${error.message}`; }
  }
  return {
    installed: Boolean(binary), binary, version, pinned: BLENDER_RELEASE.version, home: blenderHome(),
    engines: binary ? ["EEVEE (headless, software GL)", "CYCLES (CPU)", "WORKBENCH"] : [],
    memoryBudgetMb: memoryBudgetMb(), cpuThreads: os.availableParallelism(),
    note: binary ? "Renders run guarded, niced and memory-watched; GPU rendering is never assumed." : 'Not installed: blender_setup action:"install"',
  };
}

async function download(url: string, target: string, expected: string, signal: AbortSignal | undefined, progress?: Progress) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${url}`);
  const hash = createHash("sha256");
  let received = 0;
  const report = throttled(progress, 5000);
  const counting = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); received += chunk.length; report(`Downloading Blender ${BLENDER_RELEASE.version}: ${(received / 1e6).toFixed(0)} MB`); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as any), counting, createWriteStream(target, { mode: 0o600 }));
  const digest = hash.digest("hex");
  if (digest !== expected) { await fs.rm(target, { force: true }); throw new Error(`Blender archive checksum mismatch (${digest}); nothing was installed`); }
}

export async function blenderInstall(signal?: AbortSignal, progress?: Progress) {
  const home = blenderHome();
  const dest = path.join(home, BLENDER_RELEASE.dir);
  if (existsSync(path.join(dest, "blender"))) {
    await fs.symlink(BLENDER_RELEASE.dir, path.join(home, "current")).catch(() => undefined);
    return { ...(await blenderStatus(signal)), alreadyInstalled: true };
  }
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The pinned portable build is linux-x64 only; install Blender yourself and set YUNUSPI_BLENDER");
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const archive = path.join(home, `${BLENDER_RELEASE.dir}.tar.xz`);
  await download(BLENDER_RELEASE.url, archive, BLENDER_RELEASE.sha256, signal, progress);
  progress?.("Extracting Blender…");
  try {
    await runGuarded("tar", ["-xJf", archive, "-C", home], { cwd: home, signal, timeoutMs: 600_000, guard: false });
  } finally { await fs.rm(archive, { force: true }); }
  const link = path.join(home, "current");
  await fs.rm(link, { force: true });
  await fs.symlink(BLENDER_RELEASE.dir, link);
  return { ...(await blenderStatus(signal)), alreadyInstalled: false };
}

export async function blenderSetup(params: any, _cwd: string, signal?: AbortSignal, progress?: Progress) {
  return params.action === "install" ? blenderInstall(signal, progress) : blenderStatus(signal);
}

// ───────────────────────────── tools ─────────────────────────────

const DEADLINE = { inspect: 300_000, render: 3_500_000, export: 900_000, dataset: 3_500_000, run: 3_500_000 };

export async function blenderInspect(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const blend = await readablePath(params.blend, cwd);
  const result = await worker({ op: "inspect" }, { cwd: path.dirname(blend), blend, signal, timeoutMs: DEADLINE.inspect, progress });
  const { ok: _ok, op: _op, ...scene } = result;
  const warnings: string[] = [];
  if (!scene.render?.camera) warnings.push("No active camera: set scene.camera before rendering");
  if (scene.missingFiles?.length) warnings.push(`${scene.missingFiles.length} linked file(s) are missing; textures or libraries will render pink or empty`);
  if (!scene.lights?.length && scene.render?.engine !== "BLENDER_WORKBENCH") warnings.push("No lights (and no world lighting check): EEVEE/Cycles renders may be black");
  return { ...scene, warnings };
}

function frameList(params: any, fallback: number): number[] {
  if (Array.isArray(params.frames) && params.frames.length) return params.frames.map((f: number) => Math.round(f));
  if (params.from !== undefined || params.to !== undefined) {
    const from = Math.round(params.from ?? params.to), to = Math.round(params.to ?? params.from);
    if (to < from) throw new Error("to must be >= from");
    const step = Math.max(1, Math.round(params.step ?? 1));
    const frames: number[] = [];
    for (let f = from; f <= to; f += step) frames.push(f);
    if (frames.length > 2000) throw new Error("Render at most 2000 frames per call; split long animations");
    return frames;
  }
  return [Math.round(params.frame ?? fallback)];
}

/** Render still frames or an animation (image sequence plus an H.264 preview via ffmpeg). */
export async function blenderRender(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const blend = await readablePath(params.blend, cwd);
  const outputDir = await freshOutputDir(params.outputDir, cwd, "render");
  const mode = params.mode ?? "still";
  const frames = frameList(params, 1);
  if (mode === "still" && frames.length > 24) throw new Error('mode "still" renders up to 24 frames; use mode "animation" for sequences');
  const scale = params.scale ?? (mode === "preview" ? 0.25 : 1);
  const samples = params.samples ?? (mode === "preview" ? 16 : undefined);
  const req = { op: "render", outputDir, frames, scene: params.scene, camera: params.camera, engine: params.engine, width: params.width, height: params.height, scale, samples, denoise: params.denoise, transparent: params.transparent, format: params.format, threads: params.threads, stem: mode === "animation" ? "frame" : "still" };
  const result = await worker(req, { cwd: path.dirname(blend), blend, signal, timeoutMs: DEADLINE.render, progress });
  const files: Array<{ frame: number; path: string; bytes: number; seconds: number }> = result.files;
  const out: any = { mode, outputDir, render: result.render, frames: files.length, seconds: result.seconds, files: files.slice(0, 48) };
  const labelled = files.filter((_, i) => files.length <= 12 || i % Math.ceil(files.length / 12) === 0).slice(0, 12).map((f) => ({ path: f.path, label: `f${f.frame}` }));
  if (labelled.length > 1 && /\.(png|jpe?g|webp)$/i.test(labelled[0].path)) {
    const sheet = path.join(outputDir, "contact-sheet.png");
    const args = [...FFMPEG_FLAGS, "-loglevel", "error"];
    for (const image of labelled) args.push("-i", image.path);
    args.push("-filter_complex", contactSheetFilter(labelled.map((i) => i.label)), "-map", "[sheet]", "-frames:v", "1", "-update", "1", sheet);
    await run("ffmpeg", args, signal, 60_000).then(() => { out.contactSheet = sheet; }, (error) => { out.contactSheetError = error.message; });
  }
  if (mode === "animation" && files.length > 1 && /\.(png|jpe?g)$/i.test(files[0].path)) {
    const fps = params.fps ?? result.render.fps ?? 24;
    const video = path.join(outputDir, "animation.mp4");
    const first = files[0].frame, ext = path.extname(files[0].path);
    const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", "-framerate", String(fps), "-start_number", String(first), "-i", path.join(outputDir, `frame-%04d${ext}`), "-vf", even, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(params.crf ?? 18), "-movflags", "+faststart", video], signal, 600_000)
      .then(async () => { out.video = (await produced(video)).path; out.fps = fps; }, (error) => { out.videoError = `image sequence rendered but mp4 assembly failed: ${error.message}`; });
  }
  out.review = mode === "still" ? "Open the frame(s) with read and judge composition, lighting, clipping and materials before any longer render." : mode === "preview" ? "Low-resolution, low-sample check: judge motion and framing, not shading noise." : "Inspect the contact sheet and play animation.mp4 (video_frames samples transitions); a finished render is not visual approval.";
  return out;
}

/** Export scene geometry or capture a multi-view training dataset (transforms.json + images). */
export async function blenderExport(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const blend = await readablePath(params.blend, cwd);
  const format = String(params.format || "glb").toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`format must be one of ${EXPORT_FORMATS.join(", ")}`);
  if (format === "dataset") {
    const outputDir = await freshOutputDir(params.outputDir, cwd, "dataset");
    const req = { op: "dataset", outputDir, views: params.views ?? 60, radius: params.radius, center: params.center, elevations: params.elevations, lensMm: params.lensMm, width: params.width ?? 800, height: params.height ?? 800, scale: params.scale, engine: params.engine ?? "EEVEE", samples: params.samples ?? 32, transparent: params.transparent ?? true, seed: params.seed };
    const result = await worker(req, { cwd: path.dirname(blend), blend, signal, timeoutMs: DEADLINE.dataset, progress });
    const { ok: _ok, op: _op, ...dataset } = result;
    return { format, ...dataset, next: `lichtfeld_train dataset:${JSON.stringify(outputDir)} trains Gaussian splats from this dataset (NeRF/Blender transforms.json layout; camera matrices are Blender world-space, so lichtfeld_render orbits use up:[0,0,1])` };
  }
  const target = await writablePath(params.path ?? path.join(".pi", "blender", `${path.basename(blend, ".blend")}.${format}`), cwd);
  const result = await worker({ op: "export", path: target, format, objects: params.objects, applyModifiers: params.applyModifiers, animation: params.animation }, { cwd: path.dirname(blend), blend, signal, timeoutMs: DEADLINE.export, progress });
  return { format, files: result.files, objects: result.objects, next: format === "obj" || format === "ply" ? `lichtfeld_convert action:"mesh2splat" turns this mesh into Gaussian splats; video_project feature:"3d" animates a .glb in a code-first video` : format === "glb" ? 'Use with video_project feature:"3d" (Model3D primitive) or asset_register' : undefined };
}

/** Run an agent-authored bpy script headless; the script may print `YUNUSPI_RESULT {json}` to return structured data. */
export async function blenderRun(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const root = await workspaceRoot(cwd);
  const blend = params.blend ? await readablePath(params.blend, cwd) : undefined;
  let script: string;
  let temporary = false;
  if (params.script) script = await readablePath(params.script, cwd);
  else if (typeof params.code === "string" && params.code.trim()) {
    script = path.join(os.tmpdir(), `yunuspi-bpy-${randomBytes(6).toString("hex")}.py`);
    await fs.writeFile(script, params.code, { mode: 0o600 });
    temporary = true;
  } else throw new Error("Provide script (a .py path) or code (inline Python using bpy)");
  const timeoutMs = Math.min(DEADLINE.run, Math.max(10_000, (params.timeoutSec ?? 900) * 1000));
  const args = ["-b", ...(blend ? [blend] : []), ...(params.factoryStartup === false ? [] : ["--factory-startup"]), "-noaudio", "--python-exit-code", "1", "-P", script, ...(Array.isArray(params.args) && params.args.length ? ["--", ...params.args.map(String)] : [])];
  const binary = requireBlender();
  const lines: string[] = [];
  let result: unknown;
  const report = throttled(progress, 2500);
  const before = await snapshot(root);
  try {
    const { stderr } = await runGuarded(binary, args, { cwd: root, signal, timeoutMs, nice: 10, env: blenderEnv(), onLine: (line) => {
      if (line.startsWith(RESULT_MARK)) { try { result = JSON.parse(line.slice(RESULT_MARK.length)); } catch { lines.push(line); } }
      else if (line.startsWith(PROGRESS_MARK)) report(line.slice(PROGRESS_MARK.length));
      else { lines.push(line); if (/^Fra:\d+ /.test(line)) report(line.slice(0, 100)); }
    } });
    const written = await changedFiles(root, before);
    return { ok: true, result, output: lines.slice(-200).join("\n").slice(-20_000), stderr: stderr.slice(-4000) || undefined, written, timeoutSec: timeoutMs / 1000 };
  } catch (error: any) {
    const written = await changedFiles(root, before).catch(() => []);
    throw new Error(`${error.message}\n${lines.slice(-60).join("\n").slice(-6000)}${written.length ? `\nFiles written before failure: ${written.join(", ")}` : ""}`);
  } finally { if (temporary) await fs.rm(script, { force: true }); }
}

/** Cheap mtime snapshot of the workspace's top two levels so blender_run can report what a script produced. */
async function snapshot(root: string): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  async function walk(dir: string, depth: number) {
    if (depth > 2) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.length > 400) return;
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) { try { seen.set(full, (await fs.stat(full)).mtimeMs); } catch { /* raced */ } }
    }
  }
  await walk(root, 0);
  return seen;
}

async function changedFiles(root: string, before: Map<string, number>): Promise<string[]> {
  const after = await snapshot(root);
  const changed: string[] = [];
  for (const [file, mtime] of after) if (before.get(file) !== mtime) changed.push(path.relative(root, file));
  return changed.sort().slice(0, 100);
}
