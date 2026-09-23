#!/usr/bin/env node
// Remotion render runner for video_render. Runs inside the video project
// (guarded by the harness), resolves Remotion from the project's own
// node_modules, reuses a content-addressed bundle, and prints one JSON result
// line prefixed with VIDEO_RENDER_RESULT. Progress lines use VIDEO_RENDER_PROGRESS.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const project = path.resolve(request.project);
const requireFromProject = createRequire(path.join(project, "package.json"));
const load = async (name) => import(pathToFileURL(requireFromProject.resolve(name)).href);
const emit = (prefix, value) => process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);

function hashTree(hash, dir, root) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { hashTree(hash, file, root); continue; }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(file);
    // Source is hashed by content; large public media by size and mtime.
    hash.update(path.relative(root, file)).update("\0");
    if (dir.startsWith(path.join(root, "public"))) hash.update(`${stat.size}:${stat.mtimeMs}`);
    else hash.update(fs.readFileSync(file));
  }
}

async function bundled() {
  const hash = createHash("sha256");
  for (const file of ["package.json", "video.json", "tsconfig.json"]) if (fs.existsSync(path.join(project, file))) hash.update(fs.readFileSync(path.join(project, file)));
  hashTree(hash, path.join(project, "src"), project);
  hashTree(hash, path.join(project, "public"), project);
  const key = hash.digest("hex").slice(0, 16);
  const cache = path.join(project, ".video-cache");
  const outDir = path.join(cache, `bundle-v2-${key}`);
  const complete = () => fs.existsSync(path.join(outDir, "index.html")) && fs.existsSync(path.join(outDir, ".complete"));
  if (complete()) return { serveUrl: outDir, cached: true };
  fs.mkdirSync(cache, { recursive: true });
  const { bundle } = await load("@remotion/bundler");
  const started = Date.now();
  // index.html can exist before bundling succeeds. Publish only complete,
  // immutable bundles; another session may still be rendering an older one.
  const staging = fs.mkdtempSync(path.join(cache, "build-"));
  try {
    await bundle({
      entryPoint: path.join(project, "src/index.ts"),
      outDir: staging,
      publicDir: path.join(project, "public"),
      onProgress: (p) => emit("VIDEO_RENDER_PROGRESS", { stage: "bundle", percent: Math.round(p) }),
    });
    if (!fs.existsSync(path.join(staging, "index.html"))) throw new Error("Bundler completed without index.html");
    fs.writeFileSync(path.join(staging, ".complete"), key);
    if (!complete()) {
      // Atomic directory publication: a concurrent complete publisher wins.
      try { fs.renameSync(staging, outDir); }
      catch (error) { if (!complete()) throw error; }
    }
    return { serveUrl: outDir, cached: false, bundleMs: Date.now() - started };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

async function main() {
  const renderer = await load("@remotion/renderer");
  const { serveUrl, cached, bundleMs } = await bundled();
  const browserExecutable = request.browserExecutable ?? null;
  const chromiumOptions = { gl: "swangle", ...(request.chromiumOptions ?? {}) };
  const composition = await renderer.selectComposition({ serveUrl, id: request.composition, browserExecutable, chromiumOptions, logLevel: "error" });
  const out = path.resolve(request.outDir);
  fs.mkdirSync(out, { recursive: true });
  const common = { serveUrl, composition, browserExecutable, chromiumOptions, logLevel: "error", scale: request.scale ?? 1 };
  const result = { composition: composition.id, fps: composition.fps, width: composition.width, height: composition.height, durationInFrames: composition.durationInFrames, bundleCached: cached, ...(bundleMs ? { bundleMs } : {}) };
  if (request.mode === "stills") {
    const stills = [];
    for (const frame of request.frames) {
      if (frame < 0 || frame >= composition.durationInFrames) throw new Error(`Frame ${frame} is outside ${composition.id} (0..${composition.durationInFrames - 1})`);
      const output = path.join(out, `frame-${String(frame).padStart(6, "0")}.png`);
      await renderer.renderStill({ ...common, frame, output, imageFormat: "png" });
      stills.push({ frame, seconds: frame / composition.fps, path: output });
      emit("VIDEO_RENDER_PROGRESS", { stage: "stills", done: stills.length, total: request.frames.length });
    }
    emit("VIDEO_RENDER_RESULT", { ...result, stills });
    return;
  }
  const output = path.join(out, request.mode === "final" ? "final.mp4" : "preview.mp4");
  const frameRange = request.range ?? null;
  const started = Date.now();
  await renderer.renderMedia({
    ...common,
    codec: "h264",
    outputLocation: output,
    frameRange,
    crf: request.crf ?? (request.mode === "final" ? 18 : 28),
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "192k",
    concurrency: request.concurrency ?? null,
    muted: request.muted === true,
    onProgress: ({ progress, renderedFrames, encodedFrames }) => emit("VIDEO_RENDER_PROGRESS", { stage: "render", percent: Math.round(progress * 100), renderedFrames, encodedFrames }),
  });
  emit("VIDEO_RENDER_RESULT", { ...result, output, frameRange, renderMs: Date.now() - started });
}

main().catch((error) => {
  emit("VIDEO_RENDER_RESULT", { error: String(error?.stack ?? error).slice(0, 4000) });
  process.exitCode = 1;
});
