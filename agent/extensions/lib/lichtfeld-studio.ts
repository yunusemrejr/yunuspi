/** LichtFeld Studio (3D Gaussian Splatting, GPLv3, CUDA) driven headless:
 * hardware preflight, a from-source install into the harness tool dir,
 * `--headless` training from COLMAP or Blender/NeRF transforms.json datasets,
 * camera-path video renders and format conversion (ply/sog/spz/html,
 * mesh2splat). The binary needs an NVIDIA GPU (compute 7.5+, driver 570+ /
 * CUDA 12.8+); on other machines every tool reports that blocker plainly so
 * agents never loop on an impossible step. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalMutationPath, containsPath, selfMutationDenial } from "./self-mutation-guard.ts";
import { runGuarded, throttled, type Progress } from "./guarded-process.ts";
import { produced } from "./media-process.ts";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
export const lichtfeldHome = () => path.join(agentDir(), "local-tools", "lichtfeld");
export const LICHTFELD_REPO = "https://github.com/MrNeRF/LichtFeld-Studio.git";
export const VCPKG_REPO = "https://github.com/microsoft/vcpkg.git";
/** Debian/Ubuntu packages the upstream CI installs; reported, never installed (root). */
export const LICHTFELD_APT = ["git", "curl", "unzip", "cmake", "gcc-14", "g++-14", "ccache", "ninja-build", "zip", "tar", "pkg-config", "python3", "python3-dev", "libxinerama-dev", "libxcursor-dev", "xorg-dev", "libglu1-mesa-dev", "libwayland-dev", "libxkbcommon-dev", "libegl-dev", "libdecor-0-dev", "libibus-1.0-dev", "libdbus-1-dev", "libsystemd-dev", "libgtk-3-dev", "nasm", "autoconf", "autoconf-archive", "automake", "libtool"];
export const EXPORT_FORMATS = ["ply", "sog", "ssog", "spz", "usd", "usda", "usdc", "html", "rad"] as const;
export const STRATEGIES = ["default", "mcmc"] as const;
export const HARDWARE = { minComputeCapability: 7.5, minDriver: 570, cuda: "12.8+" };

export function lichtfeldBinary(): string | undefined {
  const home = lichtfeldHome();
  const candidates = [process.env.YUNUSPI_LICHTFELD, path.join(home, "dist", "bin", "run_lichtfeld.sh"), path.join(home, "src", "build", "LichtFeld-Studio")].filter(Boolean) as string[];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const name of ["LichtFeld-Studio", "lichtfeld-studio"]) {
    const onPath = (process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, name)).find((file) => existsSync(file));
    if (onPath) return onPath;
  }
  return undefined;
}

// ───────────────────────────── hardware ─────────────────────────────

export interface GpuReport { nvidia: boolean; gpus: Array<{ name: string; memoryMb?: number; computeCapability?: number }>; driver?: string; cudaToolkit?: string; blocker?: string; otherGpus: string[] }

/** nvidia-smi is the only reliable signal for a usable CUDA driver; lspci names the rest. */
export async function detectGpu(signal?: AbortSignal): Promise<GpuReport> {
  const report: GpuReport = { nvidia: false, gpus: [], otherGpus: [] };
  try {
    const { stdout } = await runGuarded("nvidia-smi", ["--query-gpu=name,memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"], { cwd: os.tmpdir(), signal, timeoutMs: 20_000, guard: false });
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [name, memory, driver, cc] = line.split(",").map((s) => s.trim());
      report.gpus.push({ name, memoryMb: Number(memory) || undefined, computeCapability: Number(cc) || undefined });
      report.driver = driver;
    }
    report.nvidia = report.gpus.length > 0;
  } catch { /* no NVIDIA driver */ }
  try {
    const { stdout } = await runGuarded("lspci", [], { cwd: os.tmpdir(), signal, timeoutMs: 20_000, guard: false });
    report.otherGpus = stdout.split("\n").filter((l) => /VGA|3D|Display/i.test(l)).map((l) => l.replace(/^\S+\s+/, "").trim()).filter((l) => !/NVIDIA/i.test(l));
  } catch { /* lspci optional */ }
  try {
    const { stdout } = await runGuarded("nvcc", ["--version"], { cwd: os.tmpdir(), signal, timeoutMs: 20_000, guard: false });
    report.cudaToolkit = stdout.match(/release\s+([\d.]+)/)?.[1];
  } catch { /* toolkit optional until build time */ }
  if (!report.nvidia) report.blocker = `LichtFeld Studio requires an NVIDIA GPU (compute capability ≥ ${HARDWARE.minComputeCapability}, driver ≥ ${HARDWARE.minDriver}, CUDA ${HARDWARE.cuda}); this machine has ${report.otherGpus.length ? report.otherGpus.join("; ") : "no NVIDIA driver"}. Gaussian-splat training cannot run here; Blender renders, datasets and mesh exports still work and the dataset can be trained on a CUDA machine.`;
  else {
    const weak = report.gpus.filter((g) => g.computeCapability !== undefined && g.computeCapability < HARDWARE.minComputeCapability);
    if (weak.length === report.gpus.length) report.blocker = `GPU compute capability ${weak.map((g) => g.computeCapability).join("/")} is below ${HARDWARE.minComputeCapability} (${weak.map((g) => g.name).join(", ")})`;
    else if (report.driver && Number(report.driver.split(".")[0]) < HARDWARE.minDriver) report.blocker = `NVIDIA driver ${report.driver} is older than ${HARDWARE.minDriver}; upgrade the driver (CUDA ${HARDWARE.cuda})`;
  }
  return report;
}

async function has(binary: string): Promise<boolean> {
  return (process.env.PATH || "").split(path.delimiter).some((dir) => existsSync(path.join(dir, binary)));
}

export async function lichtfeldStatus(signal?: AbortSignal) {
  const binary = lichtfeldBinary();
  const gpu = await detectGpu(signal);
  let version: string | undefined;
  if (binary && !gpu.blocker) {
    try { version = (await runGuarded(binary, ["--version"], { cwd: os.tmpdir(), signal, timeoutMs: 30_000, guard: false })).stdout.trim().split("\n")[0]; }
    catch (error: any) { version = `unusable: ${error.message.slice(0, 200)}`; }
  }
  const toolchain = { cmake: await has("cmake"), ninja: await has("ninja"), gcc14: await has("gcc-14"), git: await has("git"), vcpkgRoot: process.env.VCPKG_ROOT || (existsSync(path.join(lichtfeldHome(), "vcpkg", "vcpkg")) ? path.join(lichtfeldHome(), "vcpkg") : undefined) };
  return {
    installed: Boolean(binary), binary, version, home: lichtfeldHome(), gpu, toolchain, hardware: HARDWARE,
    datasets: "COLMAP (sparse/0 + images/) or Blender/NeRF transforms.json (blender_export format:\"dataset\")",
    exports: EXPORT_FORMATS,
    note: gpu.blocker ?? (binary ? "Ready: lichtfeld_train runs --headless with --export; lichtfeld_render renders camera paths to MP4." : 'Hardware is capable; run lichtfeld_setup action:"install" (source build, 30–90 minutes, needs CUDA toolkit and the listed apt packages).'),
  };
}

/** Build from source into local-tools/lichtfeld (portable layout). Refuses on incapable hardware. */
export async function lichtfeldInstall(params: any, signal?: AbortSignal, progress?: Progress) {
  const gpu = await detectGpu(signal);
  if (gpu.blocker && !params.force) return { installed: false, skipped: true, gpu, blocker: gpu.blocker, aptPackages: LICHTFELD_APT, note: "No download or build was started. On a CUDA-capable Linux machine the same call clones the repository, bootstraps vcpkg and builds the portable distribution." };
  const missing: string[] = [];
  for (const binary of ["git", "cmake", "ninja", "gcc-14", "g++-14", "nvcc", "pkg-config"]) if (!(await has(binary))) missing.push(binary);
  if (missing.length) throw new Error(`Build toolchain missing: ${missing.join(", ")}. Install the CUDA 12.8+ toolkit and: sudo apt install ${LICHTFELD_APT.join(" ")}`);
  const home = lichtfeldHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const src = path.join(home, "src");
  const vcpkg = process.env.VCPKG_ROOT || path.join(home, "vcpkg");
  const jobs = String(Math.max(2, Math.min(os.availableParallelism(), Math.floor(os.totalmem() / 3e9))));
  const report = throttled(progress, 5000);
  const step = (text: string) => progress?.(text);
  if (!existsSync(path.join(vcpkg, "vcpkg"))) {
    step("Bootstrapping vcpkg…");
    if (!existsSync(vcpkg)) await runGuarded("git", ["clone", "--depth", "1", VCPKG_REPO, vcpkg], { cwd: home, signal, timeoutMs: 1_200_000, guard: false });
    await runGuarded(path.join(vcpkg, "bootstrap-vcpkg.sh"), ["-disableMetrics"], { cwd: vcpkg, signal, timeoutMs: 1_200_000, guard: false });
  }
  if (!existsSync(path.join(src, "CMakeLists.txt"))) {
    step("Cloning LichtFeld Studio (with submodules)…");
    await runGuarded("git", ["clone", "--recursive", "--depth", "1", ...(params.ref ? ["--branch", String(params.ref)] : []), LICHTFELD_REPO, src], { cwd: home, signal, timeoutMs: 3_600_000, guard: false, onLine: report });
  } else if (params.update) {
    await runGuarded("git", ["pull", "--ff-only", "--recurse-submodules"], { cwd: src, signal, timeoutMs: 1_200_000, guard: false });
  }
  const env = { VCPKG_ROOT: vcpkg, CC: "gcc-14", CXX: "g++-14", CMAKE_BUILD_PARALLEL_LEVEL: jobs };
  step("Configuring (first vcpkg dependency build takes a long time)…");
  // Headless-capable build: upstream's GUI-backend check is relaxed so the binary links on servers without X/Wayland dev stacks.
  await runGuarded("cmake", ["-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_PORTABLE=ON", "-DLFS_ENFORCE_LINUX_GUI_BACKENDS=OFF"], { cwd: src, signal, timeoutMs: 7_200_000, guard: false, env, onLine: report });
  step(`Compiling with ${jobs} jobs…`);
  await runGuarded("cmake", ["--build", "build", "-j", jobs], { cwd: src, signal, timeoutMs: 7_200_000, guard: false, env, onLine: report });
  await runGuarded("cmake", ["--install", "build", "--prefix", path.join(home, "dist")], { cwd: src, signal, timeoutMs: 600_000, guard: false, env });
  return { ...(await lichtfeldStatus(signal)), built: true, source: src };
}

export async function lichtfeldSetup(params: any, _cwd: string, signal?: AbortSignal, progress?: Progress) {
  return params.action === "install" ? lichtfeldInstall(params, signal, progress) : lichtfeldStatus(signal);
}

// ───────────────────────────── datasets ─────────────────────────────

const IMAGE_RE = /\.(png|jpe?g|webp|tiff?)$/i;

/** Validate a training dataset without the GPU: layout, image count, pose count, resolution hints. */
export async function inspectDataset(dir: string) {
  const transforms = ["transforms.json", "transforms_train.json"].map((f) => path.join(dir, f)).find((f) => existsSync(f));
  const issues: string[] = [];
  if (transforms) {
    const spec = JSON.parse(await fs.readFile(transforms, "utf8"));
    const frames: any[] = Array.isArray(spec.frames) ? spec.frames : [];
    if (!frames.length) issues.push("transforms.json has no frames");
    const missing = frames.filter((f) => typeof f.file_path !== "string" || !existsSync(path.join(dir, f.file_path)) && !existsSync(path.join(dir, `${f.file_path}.png`)));
    if (missing.length) issues.push(`${missing.length} frame image(s) missing on disk`);
    if (!(spec.camera_angle_x || spec.fl_x || frames[0]?.fl_x)) issues.push("no intrinsics (camera_angle_x or fl_x)");
    if (frames.length && frames.length < 20) issues.push(`only ${frames.length} views; splat training wants ≥ 40 well-spread views`);
    return { format: "blender", transforms, views: frames.length, resolution: spec.w && spec.h ? [spec.w, spec.h] : undefined, pointCloud: spec.ply_file_path ? path.join(dir, spec.ply_file_path) : existsSync(path.join(dir, "pointcloud.ply")) ? path.join(dir, "pointcloud.ply") : undefined, issues };
  }
  const sparse = [path.join(dir, "sparse", "0"), path.join(dir, "sparse")].find((d) => ["cameras.bin", "cameras.txt"].some((f) => existsSync(path.join(d, f))));
  if (sparse) {
    const imagesDir = [path.join(dir, "images"), path.join(dir, "input")].find((d) => existsSync(d));
    const images = imagesDir ? (await fs.readdir(imagesDir)).filter((f) => IMAGE_RE.test(f)) : [];
    if (!imagesDir) issues.push("no images/ folder next to sparse/");
    if (images.length && images.length < 20) issues.push(`only ${images.length} images`);
    return { format: "colmap", sparse, imagesDir, views: images.length, issues };
  }
  throw new Error(`${dir} is not a dataset: expected transforms.json (Blender/NeRF) or sparse/0 + images/ (COLMAP). Capture one with blender_export format:"dataset" or run COLMAP on photos.`);
}

function requireLichtfeld(gpu: GpuReport): string {
  if (gpu.blocker) throw new Error(gpu.blocker);
  const binary = lichtfeldBinary();
  if (!binary) throw new Error('LichtFeld Studio is not installed; run lichtfeld_setup action:"install" (source build) or set YUNUSPI_LICHTFELD to a built binary');
  return binary;
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

/** Translate tool params into LichtFeld's CLI; exported for tests and for agents that want the exact command. */
export function trainArgs(params: any, dataset: string, output: string): string[] {
  const args = ["--headless", "-d", dataset, "-o", output];
  if (params.iterations) args.push("--iter", String(Math.round(params.iterations)));
  if (params.strategy && params.strategy !== "default") args.push("--strategy", String(params.strategy));
  if (params.maxGaussians) args.push("--max-cap", String(Math.round(params.maxGaussians)));
  if (params.shDegree !== undefined) args.push("--sh-degree", String(params.shDegree));
  if (params.maxWidth) args.push("--max-width", String(Math.round(params.maxWidth)));
  if (params.imagesFolder) args.push("--images", String(params.imagesFolder));
  if (params.testEvery) args.push("--test-every", String(Math.round(params.testEvery)));
  if (params.eval) args.push("--eval");
  if (params.evalSteps?.length) args.push("--eval-steps", params.evalSteps.map((s: number) => Math.round(s)).join(","));
  if (params.bilateralGrid) args.push("--bilateral-grid");
  if (params.mip) args.push("--enable-mip");
  if (params.gut) args.push("--gut");
  if (params.undistort) args.push("--undistort");
  if (params.random) args.push("--random");
  if (params.init) args.push("--init", String(params.init));
  if (params.resume) args.push("--resume", String(params.resume));
  if (params.outputName) args.push("--output-name", String(params.outputName));
  if (params.saveProjectAtIter) args.push("--save-project-at-iter", String(Math.round(params.saveProjectAtIter)));
  if (params.timelapseImages?.length) { args.push("--timelapse-images", params.timelapseImages.join(",")); if (params.timelapseEvery) args.push("--timelapse-every", String(Math.round(params.timelapseEvery))); }
  if (params.noProvenance) args.push("--no-provenance");
  const formats: string[] = Array.isArray(params.export) && params.export.length ? params.export : ["ply"];
  for (const format of formats) if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`export formats: ${EXPORT_FORMATS.join(", ")}`);
  args.push("--export", formats.join(","));
  if (Array.isArray(params.extraArgs)) for (const extra of params.extraArgs) { if (!/^--?[a-z][a-z0-9-]*(=[^\s;&|<>`$]*)?$|^[^\s;&|<>`$-][^\s;&|<>`$]*$/i.test(String(extra))) throw new Error(`unsafe extra argument ${JSON.stringify(extra)}`); args.push(String(extra)); }
  return args;
}

async function listOutputs(output: string) {
  const files: Array<{ path: string; bytes: number }> = [];
  async function walk(dir: string, depth: number) {
    if (depth > 3) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/\.(ply|sog|ssog|spz|usd[ac]?|html|rad|licht|resume|json|txt|csv|mp4|png)$/i.test(entry.name)) { const stat = await fs.stat(full).catch(() => undefined); if (stat) files.push({ path: full, bytes: stat.size }); }
    }
  }
  await walk(output, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200);
}

export async function lichtfeldTrain(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const dataset = await workspacePath(params.dataset, cwd, false);
  if (!existsSync(dataset)) throw new Error(`${dataset} does not exist`);
  const info = await inspectDataset(dataset);
  if (params.action === "check") return { ...info, gpu: await detectGpu(signal), command: ["LichtFeld-Studio", ...trainArgs(params, dataset, params.output ?? ".pi/lichtfeld/<run>")] };
  const blocking = info.issues.filter((i) => /missing|no frames|no images|no intrinsics/.test(i));
  if (blocking.length) throw new Error(`Dataset problems: ${blocking.join("; ")}`);
  const gpu = await detectGpu(signal);
  const binary = requireLichtfeld(gpu);
  const output = await workspacePath(params.output ?? path.join(".pi", "lichtfeld", `${path.basename(dataset)}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`), cwd, true);
  await fs.mkdir(output, { recursive: true });
  const args = trainArgs(params, dataset, output);
  const report = throttled(progress, 3000);
  const lines: string[] = [];
  const timeoutMs = Math.min(7_200_000, Math.max(60_000, (params.timeoutSec ?? 5400) * 1000));
  const started = Date.now();
  await runGuarded(binary, args, { cwd: output, signal, timeoutMs, nice: 5, env: { LFS_LOG_LEVEL: params.logLevel ?? "info", CUDA_VISIBLE_DEVICES: params.gpuIndex !== undefined ? String(params.gpuIndex) : process.env.CUDA_VISIBLE_DEVICES }, onLine: (line) => {
    lines.push(line);
    if (/\b(?:iter|step|loss|psnr|ssim|lpips|export|saved|error|warn)/i.test(line)) report(line.slice(0, 160));
  } });
  const files = await listOutputs(output);
  const metrics: Record<string, number> = {};
  for (const line of lines) { const m = line.match(/\b(PSNR|SSIM|LPIPS)\b\s*[:=]\s*([\d.]+)/i); if (m) metrics[m[1].toUpperCase()] = Number(m[2]); }
  const splats = files.filter((f) => /\.(ply|sog|ssog|spz|usd[ac]?|html|rad)$/i.test(f.path));
  if (!splats.length) throw new Error(`Training finished but no splat export was written to ${output}. Log tail:\n${lines.slice(-40).join("\n")}`);
  return { dataset: info, output, args, seconds: Math.round((Date.now() - started) / 1000), splats, project: files.find((f) => f.path.endsWith(".licht"))?.path, metrics: Object.keys(metrics).length ? metrics : undefined, logTail: lines.slice(-30).join("\n"), review: 'Render a turntable with lichtfeld_render (or open the html export) and look at floaters, holes, background bleed and sharpness before delivering; evaluate with eval:true for PSNR/SSIM when the dataset has test views.' };
}

// ───────────────────────────── camera paths ─────────────────────────────

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Quaternion [w,x,y,z] for a camera at `eye` looking at `target` in LichtFeld's
 * viewer basis (+X right, +Y up, -Z forward). Columns: right, up, back. */
export function lookAtQuaternion(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): [number, number, number, number] {
  const back = norm(sub(eye, target));
  let right = norm(cross(up, back));
  if (!Math.hypot(...right)) right = [1, 0, 0];
  const trueUp = cross(back, right);
  const m = [right, trueUp, back]; // column-major basis
  const [r00, r10, r20] = m[0], [r01, r11, r21] = m[1], [r02, r12, r22] = m[2];
  const trace = r00 + r11 + r22;
  let w: number, x: number, y: number, z: number;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s; }
  else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s; }
  else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s; }
  else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s; }
  return [w, x, y, z].map((v) => Number(v.toFixed(7))) as [number, number, number, number];
}

/** Turntable keyframes in LichtFeld's timeline JSON (version 4): orbit around `center` at `radius`
 * with a fixed elevation, `seconds` long, closing the loop. */
export function orbitPath(options: { center?: Vec3; radius?: number; elevationDeg?: number; seconds?: number; keyframes?: number; up?: Vec3; focalMm?: number; startDeg?: number }) {
  const center = options.center ?? [0, 0, 0], radius = options.radius ?? 3, elevation = (options.elevationDeg ?? 20) * Math.PI / 180;
  const seconds = options.seconds ?? 8, count = Math.max(4, Math.min(240, Math.round(options.keyframes ?? 24)));
  const up = norm(options.up ?? [0, 1, 0]);
  // Orthonormal frame around `up` for the orbit plane.
  const helper: Vec3 = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm(cross(up, helper)), e2 = norm(cross(up, e1));
  const keyframes = [];
  for (let i = 0; i <= count; i++) {
    const angle = (options.startDeg ?? 0) * Math.PI / 180 + (i / count) * 2 * Math.PI;
    const horizontal = radius * Math.cos(elevation), vertical = radius * Math.sin(elevation);
    const eye: Vec3 = [
      center[0] + horizontal * (Math.cos(angle) * e1[0] + Math.sin(angle) * e2[0]) + vertical * up[0],
      center[1] + horizontal * (Math.cos(angle) * e1[1] + Math.sin(angle) * e2[1]) + vertical * up[1],
      center[2] + horizontal * (Math.cos(angle) * e1[2] + Math.sin(angle) * e2[2]) + vertical * up[2],
    ];
    keyframes.push({ time: Number(((i / count) * seconds).toFixed(4)), position: eye.map((v) => Number(v.toFixed(5))), rotation: lookAtQuaternion(eye, center, up), focal_length_mm: options.focalMm ?? 35, easing: 0 });
  }
  return { version: 4, clip_duration: seconds, keyframes };
}

export async function lichtfeldRender(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const model = await workspacePath(params.model, cwd, false);
  if (!existsSync(model)) throw new Error(`${model} does not exist`);
  const output = await workspacePath(params.output ?? path.join(".pi", "lichtfeld", `${path.basename(model).replace(/\.[^.]+$/, "")}-turntable.mp4`), cwd, true);
  await fs.mkdir(path.dirname(output), { recursive: true });
  let cameraPath: string;
  let generated: any;
  if (params.cameraPath) cameraPath = await workspacePath(params.cameraPath, cwd, false);
  else {
    generated = Array.isArray(params.keyframes) && params.keyframes.length ? { version: 4, clip_duration: params.keyframes.at(-1).time, keyframes: params.keyframes.map((k: any) => ({ time: k.time, position: k.position, rotation: k.rotation ?? lookAtQuaternion(k.position, k.lookAt ?? params.center ?? [0, 0, 0], params.up), focal_length_mm: k.focalMm ?? params.focalMm ?? 35, easing: k.easing ?? 0 })) }
      : orbitPath({ center: params.center, radius: params.radius, elevationDeg: params.elevationDeg, seconds: params.seconds, keyframes: params.orbitKeyframes, up: params.up, focalMm: params.focalMm, startDeg: params.startDeg });
    cameraPath = output.replace(/\.mp4$/i, "") + ".camera-path.json";
    await fs.writeFile(cameraPath, JSON.stringify(generated, null, 1));
  }
  if (params.action === "path") return { cameraPath, keyframes: generated?.keyframes?.length, seconds: generated?.clip_duration, note: "Camera path written; positions are in the viewer world (Blender-captured datasets: Blender world axes, Z up → pass up:[0,0,1])." };
  const gpu = await detectGpu(signal);
  const binary = requireLichtfeld(gpu);
  const args = ["--render-camera-path", cameraPath, "--render-load", model, "--render-output", output, "--render-width", String(params.width ?? 1280), "--render-height", String(params.height ?? 720), "--render-fps", String(params.fps ?? 30), "--render-crf", String(params.crf ?? 18)];
  const report = throttled(progress, 3000);
  const lines: string[] = [];
  await runGuarded(binary, args, { cwd: path.dirname(output), signal, timeoutMs: Math.min(3_600_000, Math.max(60_000, (params.timeoutSec ?? 1800) * 1000)), nice: 5, env: { LFS_LOG_LEVEL: "info" }, onLine: (line) => { lines.push(line); if (/frame|render|error/i.test(line)) report(line.slice(0, 140)); } });
  const video = await produced(output);
  return { video: video.path, bytes: video.bytes, cameraPath, args, review: "Sample frames with video_frames and judge floaters, popping and background against the dataset photos/renders." };
}

// ───────────────────────────── conversion ─────────────────────────────

export async function lichtfeldConvert(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const gpu = await detectGpu(signal);
  const binary = requireLichtfeld(gpu);
  const input = await workspacePath(params.input, cwd, false);
  if (!existsSync(input)) throw new Error(`${input} does not exist`);
  const action = params.action ?? "convert";
  const output = await workspacePath(params.output ?? path.join(".pi", "lichtfeld", `${path.basename(input).replace(/\.[^.]+$/, "")}${action === "mesh2splat" ? "-splat.ply" : `.${params.format ?? "spz"}`}`), cwd, true);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = action === "mesh2splat" ? ["mesh2splat", input, "-o", output] : ["convert", input, output];
  if (Array.isArray(params.extraArgs)) for (const extra of params.extraArgs) { if (!/^--?[a-z][a-z0-9-]*(=[^\s;&|<>`$]*)?$|^[^\s;&|<>`$-][^\s;&|<>`$]*$/i.test(String(extra))) throw new Error(`unsafe extra argument ${JSON.stringify(extra)}`); args.push(String(extra)); }
  const report = throttled(progress, 3000);
  await runGuarded(binary, args, { cwd: path.dirname(output), signal, timeoutMs: 1_800_000, nice: 5, onLine: (line) => report(line.slice(0, 140)) });
  const file = await produced(output);
  return { action, input, output: file.path, bytes: file.bytes, args };
}
