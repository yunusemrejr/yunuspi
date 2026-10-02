/** Gaussian splatting on ordinary hardware with Brush (Apache-2.0, Rust +
 * wgpu): a pinned portable binary that trains headless on any Vulkan GPU —
 * AMD/Intel integrated graphics included — from COLMAP or Blender/nerfstudio
 * transforms.json datasets, exports PLY and writes held-out eval renders. The
 * turntable preview renders the PLY as a coloured point cloud through the
 * Blender worker, since Brush renders only in its viewer. */
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { runGuarded, throttled, type Progress } from "./guarded-process.ts";
import { FFMPEG_FLAGS, produced, run } from "./media-process.ts";
import { assembleSequence, blenderWorker, writablePath } from "./blender-studio.ts";
import { contactSheetFilter } from "./video-studio.ts";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const brushHome = () => path.join(agentDir(), "local-tools", "brush");
/** Pinned release; sha256 from the release's .sha256 asset. */
export const BRUSH_RELEASE = {
  version: "0.3.0",
  url: "https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-unknown-linux-gnu.tar.xz",
  sha256: "4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20",
  dir: "brush-app-x86_64-unknown-linux-gnu",
  license: "Apache-2.0",
};
/** Brush probes image headers with a fixed read; files below this size fail to load. */
export const MIN_IMAGE_BYTES = 16_387;

export function brushBinary(): string | undefined {
  const candidates = [process.env.YUNUSPI_BRUSH, path.join(brushHome(), "current", "brush_app")].filter(Boolean) as string[];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ["brush_app", "brush"]) {
    const onPath = (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, name)).find((file) => existsSync(file));
    if (onPath) return onPath;
  }
  return undefined;
}

function requireBrush(): string {
  const binary = brushBinary();
  if (!binary) throw new Error('Brush is not installed; run splat_setup action:"install" (downloads the pinned 44 MB release once) or set YUNUSPI_BRUSH');
  return binary;
}

/** Vulkan is the only requirement: a Mesa (RADV/ANV/lavapipe) or vendor ICD on Linux. */
export async function detectVulkan() {
  const icds: string[] = [];
  for (const dir of ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d", path.join(os.homedir(), ".local/share/vulkan/icd.d")]) {
    try { for (const f of await fs.readdir(dir)) if (f.endsWith(".json")) icds.push(f.replace(/_icd\.json$|\.json$/, "")); } catch { /* absent */ }
  }
  let gpu: string | undefined;
  try {
    const { stdout } = await runGuarded("lspci", [], { cwd: os.tmpdir(), timeoutMs: 20_000, guard: false });
    gpu = stdout.split("\n").find((l) => /VGA|3D|Display/i.test(l))?.replace(/^\S+\s+/, "").trim();
  } catch { /* lspci optional */ }
  const hardware = icds.filter((i) => !/lvp|gfxstream|virtio/.test(i));
  return { ok: icds.length > 0, icds, hardwareDrivers: hardware, gpu, note: !icds.length ? "No Vulkan ICD found; install mesa-vulkan-drivers (or the vendor driver)" : !hardware.length ? "Only software Vulkan (lavapipe) is present; training will be slow" : undefined };
}

export async function brushStatus(signal?: AbortSignal) {
  const binary = brushBinary();
  const vulkan = await detectVulkan();
  let version: string | undefined;
  if (binary) {
    try { version = (await runGuarded(binary, ["--version"], { cwd: os.tmpdir(), signal, timeoutMs: 30_000, guard: false })).stdout.trim(); }
    catch (error: any) { version = `unusable: ${error.message.slice(0, 200)}`; }
  }
  return {
    installed: Boolean(binary), binary, version, pinned: BRUSH_RELEASE.version, license: BRUSH_RELEASE.license, home: brushHome(), vulkan,
    datasets: 'COLMAP (sparse/0 + images/) or nerfstudio/Blender transforms.json (blender_export format:"dataset" writes one with seed points)',
    exports: ["ply"],
    note: vulkan.note ?? (binary ? "Ready: splat_train trains headless on the Vulkan GPU; splat_preview renders a turntable of the result." : 'Run splat_setup action:"install"'),
  };
}

async function download(url: string, target: string, expected: string, signal: AbortSignal | undefined, progress?: Progress) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${url}`);
  const hash = createHash("sha256");
  let received = 0;
  const report = throttled(progress, 3000);
  const counting = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); received += chunk.length; report(`Downloading Brush ${BRUSH_RELEASE.version}: ${(received / 1e6).toFixed(0)} MB`); cb(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as any), counting, createWriteStream(target, { mode: 0o600 }));
  const digest = hash.digest("hex");
  if (digest !== expected) { await fs.rm(target, { force: true }); throw new Error(`Brush archive checksum mismatch (${digest}); nothing was installed`); }
}

export async function brushInstall(signal?: AbortSignal, progress?: Progress) {
  const home = brushHome();
  const dest = path.join(home, BRUSH_RELEASE.dir, "brush_app");
  if (!existsSync(dest)) {
    if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The pinned Brush build is linux-x64 only; build it with cargo (rust 1.88+) and set YUNUSPI_BRUSH");
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const archive = path.join(home, "brush.tar.xz");
    await download(BRUSH_RELEASE.url, archive, BRUSH_RELEASE.sha256, signal, progress);
    try { await runGuarded("tar", ["-xJf", archive, "-C", home], { cwd: home, signal, timeoutMs: 300_000, guard: false }); }
    finally { await fs.rm(archive, { force: true }); }
  }
  const link = path.join(home, "current");
  await fs.rm(link, { force: true });
  await fs.symlink(BRUSH_RELEASE.dir, link);
  return brushStatus(signal);
}

export async function splatSetup(params: any, _cwd: string, signal?: AbortSignal, progress?: Progress) {
  return params.action === "install" ? brushInstall(signal, progress) : brushStatus(signal);
}

// ───────────────────────────── datasets ─────────────────────────────

const IMAGE_RE = /\.(png|jpe?g|webp|tiff?)$/i;

async function smallImages(dir: string, files: string[]) {
  let small = 0;
  for (const file of files.slice(0, 2000)) { try { if ((await fs.stat(path.join(dir, file))).size < MIN_IMAGE_BYTES) small++; } catch { /* reported as missing elsewhere */ } }
  return small;
}

/** Validate a dataset without a GPU: layout, image count, poses, seed points, image sizes. */
export async function inspectDataset(dir: string) {
  const transforms = ["transforms.json", "transforms_train.json"].map((f) => path.join(dir, f)).find((f) => existsSync(f));
  const issues: string[] = [];
  if (transforms) {
    const spec = JSON.parse(await fs.readFile(transforms, "utf8"));
    const frames: any[] = Array.isArray(spec.frames) ? spec.frames : [];
    if (!frames.length) issues.push("transforms.json has no frames");
    const resolve = (f: any) => [path.join(dir, String(f.file_path)), path.join(dir, `${f.file_path}.png`)].find((p) => existsSync(p));
    const missing = frames.filter((f) => typeof f.file_path !== "string" || !resolve(f));
    if (missing.length) issues.push(`${missing.length} frame image(s) missing on disk`);
    if (!(spec.camera_angle_x || spec.fl_x || frames[0]?.fl_x || frames[0]?.camera_angle_x)) issues.push("no intrinsics (camera_angle_x or fl_x)");
    if (frames.length && frames.length < 20) issues.push(`only ${frames.length} views; splat training wants ≥ 40 well-spread views`);
    const small = await smallImages(dir, frames.map((f) => resolve(f)).filter(Boolean).map((p) => path.relative(dir, p as string)));
    if (small) issues.push(`${small} image file(s) are under ${MIN_IMAGE_BYTES} bytes and Brush cannot load them; re-capture at a larger size`);
    const pointCloud = spec.ply_file_path ? path.join(dir, spec.ply_file_path) : [path.join(dir, "init.ply"), path.join(dir, "pointcloud.ply")].find((p) => existsSync(p));
    if (!pointCloud || !existsSync(pointCloud)) issues.push("no seed point cloud (init.ply / ply_file_path): training starts from random points and small subjects may be pruned away");
    return { format: "nerfstudio", transforms, views: frames.length, resolution: spec.w && spec.h ? [spec.w, spec.h] : undefined, pointCloud: pointCloud && existsSync(pointCloud) ? pointCloud : undefined, issues };
  }
  const sparse = [path.join(dir, "sparse", "0"), path.join(dir, "sparse")].find((d) => ["cameras.bin", "cameras.txt"].some((f) => existsSync(path.join(d, f))));
  if (sparse) {
    const imagesDir = [path.join(dir, "images"), path.join(dir, "input")].find((d) => existsSync(d));
    const images = imagesDir ? (await fs.readdir(imagesDir)).filter((f) => IMAGE_RE.test(f)) : [];
    if (!imagesDir) issues.push("no images/ folder next to sparse/");
    if (images.length && images.length < 20) issues.push(`only ${images.length} images`);
    const small = imagesDir ? await smallImages(imagesDir, images) : 0;
    if (small) issues.push(`${small} image file(s) are under ${MIN_IMAGE_BYTES} bytes and Brush cannot load them`);
    return { format: "colmap", sparse, imagesDir, views: images.length, issues };
  }
  throw new Error(`${dir} is not a dataset: expected transforms.json (nerfstudio/Blender) or sparse/0 + images/ (COLMAP). Capture one with blender_export format:"dataset" or run COLMAP on photos.`);
}

async function workspacePath(value: unknown, cwd: string, write: boolean): Promise<string> {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("Use a local filesystem path");
  const root = await fs.realpath(cwd);
  const target = canonicalMutationPath(value, root);
  if (write) {
    if (!containsPath(root, target)) throw new Error("Outputs must be inside the current workspace");
    const denial = selfMutationDenial(target, root);
    if (denial) throw new Error(denial);
  }
  return target;
}

const SAFE_ARG = /^--?[a-z][a-z0-9-]*(=[^\s;&|<>`$]*)?$|^[^\s;&|<>`$-][^\s;&|<>`$]*$/i;

/** Tool params → Brush CLI. Exported for tests and for agents that want the exact command. */
export function trainArgs(params: any, dataset: string, output: string): string[] {
  const steps = Math.round(params.steps ?? 5000);
  const args = [dataset, "--total-steps", String(steps), "--export-path", output, "--export-every", String(Math.round(params.exportEvery ?? steps)), "--export-name", String(params.exportName ?? "splat_{iter}.ply")];
  const evalEvery = params.evalSplitEvery ? Math.round(params.evalEvery ?? Math.max(250, Math.round(steps / 4))) : undefined;
  if (params.evalSplitEvery) { args.push("--eval-split-every", String(Math.round(params.evalSplitEvery)), "--eval-every", String(evalEvery)); if (params.evalImages !== false) args.push("--eval-save-to-disk"); }
  if (params.maxSplats) args.push("--max-splats", String(Math.round(params.maxSplats)));
  if (params.shDegree !== undefined) args.push("--sh-degree", String(params.shDegree));
  if (params.maxResolution) args.push("--max-resolution", String(Math.round(params.maxResolution)));
  if (params.maxFrames) args.push("--max-frames", String(Math.round(params.maxFrames)));
  if (params.subsampleFrames) args.push("--subsample-frames", String(Math.round(params.subsampleFrames)));
  if (params.subsamplePoints) args.push("--subsample-points", String(Math.round(params.subsamplePoints)));
  if (params.seed !== undefined) args.push("--seed", String(Math.round(params.seed)));
  if (params.startIter) args.push("--start-iter", String(Math.round(params.startIter)));
  if (params.invertMasks) args.push("--invert-masks");
  if (Array.isArray(params.extraArgs)) for (const extra of params.extraArgs) { if (!SAFE_ARG.test(String(extra))) throw new Error(`unsafe extra argument ${JSON.stringify(extra)}`); args.push(String(extra)); }
  return args;
}

async function listOutputs(output: string) {
  const plys: Array<{ path: string; bytes: number; iteration?: number; splats?: number }> = [];
  const evals: Array<{ step: number; dir: string; images: string[] }> = [];
  for (const entry of await fs.readdir(output, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
    const full = path.join(output, entry.name);
    if (entry.isFile() && entry.name.endsWith(".ply")) {
      const stat = await fs.stat(full);
      const header = (await fs.readFile(full)).subarray(0, 2000).toString("latin1");
      plys.push({ path: full, bytes: stat.size, iteration: Number(entry.name.match(/(\d+)\.ply$/)?.[1]) || undefined, splats: Number(header.match(/element vertex (\d+)/)?.[1]) || undefined });
    } else if (entry.isDirectory() && /^eval_\d+$/.test(entry.name)) {
      evals.push({ step: Number(entry.name.slice(5)), dir: full, images: (await fs.readdir(full)).filter((f) => IMAGE_RE.test(f)).sort() });
    }
  }
  plys.sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
  evals.sort((a, b) => a.step - b.step);
  return { plys, evals };
}

/** Held-out views rendered by the trainer next to their ground truth: the fidelity review sheet. */
async function fidelitySheet(info: Awaited<ReturnType<typeof inspectDataset>>, evalDir: string, images: string[], output: string, signal?: AbortSignal) {
  const pairs: Array<{ path: string; label: string }> = [];
  for (const image of images.slice(0, 6)) {
    const rendered = path.join(evalDir, image);
    const truth = info.format === "colmap" ? path.join(info.imagesDir ?? "", image) : [path.join(path.dirname(info.transforms ?? ""), "images", image), path.join(path.dirname(info.transforms ?? ""), image)].find((p) => existsSync(p));
    if (truth && existsSync(truth)) pairs.push({ path: truth, label: `${image} truth` });
    pairs.push({ path: rendered, label: `${image} splat` });
  }
  if (!pairs.length) return undefined;
  const args = [...FFMPEG_FLAGS, "-loglevel", "error"];
  for (const image of pairs) args.push("-i", image.path);
  args.push("-filter_complex", contactSheetFilter(pairs.map((i) => i.label)), "-map", "[sheet]", "-frames:v", "1", "-update", "1", output);
  await run("ffmpeg", args, signal, 120_000);
  return (await produced(output)).path;
}

export async function splatTrain(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const dataset = await workspacePath(params.dataset, cwd, false);
  if (!existsSync(dataset)) throw new Error(`${dataset} does not exist`);
  const info = await inspectDataset(dataset);
  const vulkan = await detectVulkan();
  if (params.action === "check") return { ...info, vulkan, command: ["brush_app", ...trainArgs(params, dataset, params.output ?? ".pi/splats/<run>")] };
  const blocking = info.issues.filter((i) => /missing|no frames|no images|no intrinsics|cannot load/.test(i));
  if (blocking.length) throw new Error(`Dataset problems: ${blocking.join("; ")}`);
  if (!vulkan.ok) throw new Error(vulkan.note!);
  const binary = requireBrush();
  const output = await workspacePath(params.output ?? path.join(".pi", "splats", `${path.basename(dataset)}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`), cwd, true);
  await fs.mkdir(output, { recursive: true });
  const args = trainArgs(params, dataset, output);
  const report = throttled(progress, 3000);
  const lines: string[] = [];
  const timeoutMs = Math.min(7_200_000, Math.max(60_000, (params.timeoutSec ?? 3600) * 1000));
  const started = Date.now();
  // No display: Brush trains without a window unless --with-viewer is passed (never from here).
  await runGuarded(binary, args, { cwd: output, signal, timeoutMs, nice: 5, env: { RUST_LOG: params.logLevel ?? "info", DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, onLine: (line) => {
    lines.push(line);
    if (/step|eval|export|error|warn/i.test(line)) report(line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 160));
  } });
  const { plys, evals } = await listOutputs(output);
  if (!plys.length) throw new Error(`Training finished but no PLY was exported to ${output}. Log tail:\n${lines.slice(-30).join("\n")}`);
  const final = plys.at(-1)!;
  const last = evals.at(-1);
  const sheet = last ? await fidelitySheet(info, last.dir, last.images, path.join(output, "fidelity-sheet.png"), signal).catch(() => undefined) : undefined;
  const warnings: string[] = [];
  if ((final.splats ?? 0) < 1000) warnings.push(`only ${final.splats} splats survived: the subject is small or far in the views, the seed points miss it, or steps are too few`);
  return { dataset: { format: info.format, views: info.views, pointCloud: (info as any).pointCloud }, output, args, seconds: Math.round((Date.now() - started) / 1000), steps: Math.round(params.steps ?? 5000), splat: final.path, splats: final.splats, exports: plys, evals: evals.map((e) => ({ step: e.step, dir: e.dir, images: e.images.length })), fidelitySheet: sheet, warnings, logTail: lines.slice(-20).join("\n").slice(-4000),
    review: sheet ? "Open fidelity-sheet.png: each held-out view's truth next to the splat render. Judge sharpness, missing parts, floaters and colour; then splat_preview for a turntable." : "Train with evalSplitEvery (e.g. 8) to get held-out renders next to ground truth; then splat_preview for a turntable." };
}

/** Turntable of a splat PLY as a coloured point cloud (Blender worker). */
export async function splatPreview(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const ply = await workspacePath(params.path, cwd, false);
  if (!existsSync(ply)) throw new Error(`${ply} does not exist`);
  const base = await writablePath(params.outputDir ?? path.join(".pi", "splats"), cwd, true);
  const outputDir = path.join(base, `preview-${path.basename(ply, ".ply")}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await fs.mkdir(outputDir, { recursive: true });
  const frames = Math.round(params.frames ?? 48);
  const req = { op: "splat_preview", path: ply, outputDir, frames, up: params.up ?? [0, 0, 1], radius: params.radius, elevationDeg: params.elevationDeg, lensMm: params.lensMm, maxPoints: params.maxPoints, minOpacity: params.minOpacity, pointScale: params.pointScale, background: params.background, width: params.width ?? 640, height: params.height ?? 480, engine: params.engine ?? "EEVEE", samples: params.samples ?? 16 };
  const result = await blenderWorker(req, { cwd: path.dirname(ply), signal, timeoutMs: 1_800_000, progress });
  const out: any = { outputDir, splats: result.splats, shown: result.shown, center: result.center, extent: result.extent, radius: result.radius, frames, seconds: result.seconds };
  Object.assign(out, await assembleSequence(outputDir, result.files, { fps: params.fps ?? 24, crf: params.crf ?? 20, stem: "frame" }, signal));
  out.review = "Point-cloud turntable (opaque points sized by splat scale, no view-dependent shading): judge shape, coverage, floaters and colour. For COLMAP captures pass up:[0,-1,0].";
  return out;
}
