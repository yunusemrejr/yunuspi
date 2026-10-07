import { decodeImage, sniffImage } from "./design-studio.ts";
/** Blender shots for video projects. A shot is a camera move around one
 * subject (a .blend, an imported model or extruded 3D text), rendered headless
 * as an RGBA image sequence into public/shots/<name>/ with a manifest and the
 * per-frame screen positions of named anchors. The template's BlenderShot
 * primitive plays it frame-accurately and ShotAnchor pins 2D annotations to 3D
 * features. Palette, size and frame rate default to the project's look, so the
 * 3D layer is lit and graded to belong to the 2D film instead of being pasted in. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { FFMPEG_FLAGS, produced, run } from "./media-process.ts";
import { number } from './media-process.ts';
import { blenderWorker, readablePath } from "./blender-studio.ts";
import { contactSheet, freshOut, projectDir, projectWritePath, readSpec } from "./video-studio.ts";
import type { Progress } from "./guarded-process.ts";
import { validateShotScene, validateCameraPath } from './shot-scene.ts';

export const SHOT_RIGS = ["turntable", "orbit", "push-in", "pull-out", "crane", "drift", "static", "scene", "path"] as const;
export const SHOT_LIGHTS = ["softbox", "rim", "top", "overcast", "scene"] as const;
export const SHOT_MATERIALS = ["keep", "clay", "satin", "metal", "glass", "glow"] as const;
export const SHOT_SHADOWS = ["none", "soft", "catcher"] as const;
const SHOT_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_FRAMES = 600;
const DEADLINE_MS = 3_500_000;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const hexOr = (value: unknown) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined);

/** Sizes, frame rate and quality from the request and the project: previews are cheap and say so. */
export function planShot(params: any, spec: any) {
  if (params.surface) {
    if (!['brushed-metal', 'ceramic', 'organic'].includes(params.surface.texture)) throw Error('surface.texture must be brushed-metal, ceramic or organic');
    number(params.surface.scale, 80, 1, 1000, 'surface.scale');
    number(params.surface.bump, 0.03, 0, 0.2, 'surface.bump');
    number(params.surface.bevel, 0, 0, 0.03, 'surface.bevel');
    if (params.surface.roughness !== undefined) number(params.surface.roughness, 0.4, 0, 1, 'surface.roughness');
    if (params.surface.metallic !== undefined) number(params.surface.metallic, 0, 0, 1, 'surface.metallic');
  }
  if (params.mode !== undefined && !['preview', 'final'].includes(params.mode)) throw Error('mode must be preview or final');
  const mode = params.mode === "final" ? "final" : "preview";
  const projectWidth = Number(spec?.width) || 1920, projectHeight = Number(spec?.height) || 1080;
  const base = Math.min(1, 1920 / projectWidth);
  const scale = number(params.scale, mode === 'preview' ? .5 : 1, .05, 2, 'scale');
  const width = even(number(params.width, projectWidth * base * scale, 16, 8192, 'width')), height = even(number(params.height, projectHeight * base * scale, 16, 8192, 'height'));
  const fps = number(params.fps, mode === 'preview' ? 12 : Number(spec?.fps) || 30, 1, 120, 'fps');
  const seconds = number(params.seconds, 4, .1, 20, 'seconds');
  const samples = number(params.samples, mode === 'preview' ? 16 : 64, 1, 1024, 'samples');
  if (!Number.isInteger(samples)) throw Error('samples must be an integer');
  if (params.cameraPath) validateCameraPath(params.cameraPath, seconds);
  if (params.rig === 'path' && !params.cameraPath) throw Error('rig:path needs cameraPath');
  if (params.cameraPath && params.rig && params.rig !== 'path') throw Error('cameraPath uses rig:path');
  if (mode === 'final' && fps < (Number(spec?.fps) || 30) && params.stepped !== true) throw Error('Final shots need the film frame rate. Low fps is a draft, not smooth motion; use stepped:true only for intentional stop-motion.');
  const frames = Math.max(2, Math.round(seconds * fps));
  if (frames > MAX_FRAMES) throw new Error(`${frames} frames exceeds the ${MAX_FRAMES}-frame limit of one shot; split longer choreography into shots on the master timeline`);
  const passes = (params.shadow ?? (params.scene || params.model ? 'soft' : 'none')) === 'soft' ? 4 : 1;
  const pixelSamples = width * height * frames * samples * passes;
  const maxRenderWork = number(params.maxRenderWork, 80_000_000_000, 1_000_000, 1_000_000_000_000, 'maxRenderWork');
  if (pixelSamples > maxRenderWork) throw Error('Shot exceeds maxRenderWork; preview at reduced resolution/samples or split choreography into shots');
  return { mode, width, height, fps, seconds, frames, samples, pixelSamples, passes, maxRenderWork, estimate: 'Pixel/sample/pass work proxy, not elapsed time; Cycles, reflections and geometry have additional costs.' };
}

function sourceOf(params: any) {
  const given = ["blend", "model", "title", 'scene'].filter((key) => params[key] !== undefined && params[key] !== null);
  if (given.length !== 1) throw new Error("Give exactly one source: blend, model, title or scene (native object graph with device rigs and animation)");
  return given[0] as "blend" | "model" | "title" | 'scene';
}

/** Flatten the transparent frames over the film's background so a human (or vision model) judges what the viewer will see. */
async function reviewArtifacts(dir: string, out: string, shotDir: string, name: string, manifest: any, background: string, signal?: AbortSignal) {
  const tiles: Array<{ path: string; label: string }> = [];
  const picks = Array.from(new Set(Array.from({ length: Math.min(6, manifest.frames) }, (_, i) => Math.round((i / Math.max(1, Math.min(6, manifest.frames) - 1)) * (manifest.frames - 1)) + 1)));
  const size = `${manifest.width}x${manifest.height}`;
  for (const frame of picks) {
    const tile = path.join(out, `tile-${String(frame).padStart(4, "0")}.png`);
    await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${background}:s=${size}`, "-i", path.join(shotDir, `frame-${String(frame).padStart(4, "0")}.png`), "-filter_complex", "[0][1]overlay=shortest=1:format=auto", "-frames:v", "1", tile], signal, 60_000);
    tiles.push({ path: tile, label: `f${frame}` });
  }
  const sheet = await contactSheet(tiles, path.join(out, "contact-sheet.png"), signal);
  const video = path.join(out, "preview.mp4");
  await run("ffmpeg", [...FFMPEG_FLAGS, "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${background}:s=${size}:r=${manifest.fps}`, "-framerate", String(manifest.fps), "-i", path.join(shotDir, "frame-%04d.png"), "-filter_complex", "[0][1]overlay=shortest=1:format=auto,format=yuv420p", "-frames:v", String(manifest.frames), "-c:v", "libx264", "-crf", "22", video], signal, 120_000).catch(() => undefined);
  await Promise.all(tiles.map((tile) => fs.rm(tile.path, { force: true })));
  return { contactSheet: sheet, preview: existsSync(video) ? (await produced(video)).path : undefined };
}

/** A file argument is usually written relative to the project (`blender/x.blend` beside `dir`), sometimes to the workspace: try the project first. */
async function sourcePath(value: unknown, dir: string, cwd: string) {
  if (typeof value === "string" && value.trim() && !path.isAbsolute(value) && existsSync(path.resolve(dir, value))) return readablePath(path.resolve(dir, value), cwd);
  return readablePath(value, cwd);
}

export async function videoShot(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const dir = await projectDir(params.dir, cwd);
  const name = String(params.name ?? "");
  if (!SHOT_NAME.test(name)) throw new Error("name must be lowercase kebab-case (a-z, 0-9, -), at most 48 characters");
  const source = sourceOf(params);
  const spec = await readSpec(dir);
  const plan = planShot(params, spec);
  const theme = spec.theme ?? {};
  const palette = params.look === false ? {} : { background: hexOr(params.background) ?? hexOr(theme.background), accent: hexOr(params.color) ?? hexOr(theme.accent), accent2: hexOr(theme.accent2) };
  // Resolve every input before touching the disk, so a bad path leaves nothing behind.
  const blend = source === "blend" ? await sourcePath(params.blend, dir, cwd) : undefined;
  const model = source === "model" ? await sourcePath(params.model, dir, cwd) : undefined;
  const title = source === "title" ? { text: params.title?.text, font: params.title?.font ? await sourcePath(params.title.font, dir, cwd) : undefined, depth: params.title?.depth, bevel: params.title?.bevel } : undefined;
  const scene = source === 'scene' ? structuredClone(validateShotScene(params.scene, plan.seconds)) : undefined;
  let imageBytes = 0;
  if (scene) for (const object of scene.objects) {
    if (object.path) object.path = await sourcePath(object.path, dir, cwd);
    if (object.shape === 'image') {
      const stat = await fs.stat(object.path); imageBytes += stat.size;
      if (stat.size > 20 * 1024 * 1024 || imageBytes > 80 * 1024 * 1024) throw Error('Image cards exceed the 20 MiB per-image or 80 MiB scene texture budget');
      const bytes = await fs.readFile(object.path);
      if (!['png', 'jpeg', 'webp'].includes(sniffImage(bytes) ?? '')) throw Error('Image cards require PNG, JPEG or WebP');
      await decodeImage(bytes, { maxWidth: 512, maxPixels: 512 * 512 }, signal);
    }
    if (object.font) object.font = await sourcePath(object.font, dir, cwd);
    if (object.maps) for (const key of ['diffuse', 'roughness', 'metallic', 'normal']) if (object.maps[key]) object.maps[key] = await sourcePath(object.maps[key], dir, cwd);
  }
  const environment = params.environment ? await sourcePath(params.environment, dir, cwd) : undefined;
  if (title && (typeof title.text !== "string" || !title.text.trim())) throw new Error("title.text is required for a 3D title shot");
  if (params.action === 'plan') return { source, plan, generationCostUsd: 0, next: 'Review the work estimate; render a small preview before final. plan creates no scene or render output.' };
  if (params.action !== undefined && params.action !== 'render') throw Error('action must be plan or render');
  const shotDir = projectWritePath(dir, "public", "shots", name);
  // The rigged scene is saved beside the source; never over the source itself.
  const saved = projectWritePath(dir, "blender", blend && path.resolve(blend) === path.resolve(dir, "blender", `${name}.blend`) ? `${name}-shot.blend` : `${name}.blend`);
  // shot.json is written last, so a folder without one is the remains of a failed render and is simply replaced.
  if (existsSync(shotDir)) {
    if (existsSync(path.join(shotDir, "shot.json")) && params.replace !== true) throw new Error(`public/shots/${name} already exists; pass replace:true to re-render it or choose another name`);
    await fs.rm(shotDir, { recursive: true, force: true });
  }
  await fs.mkdir(shotDir, { recursive: true });
  await fs.mkdir(path.dirname(saved), { recursive: true });
  const request = {
    op: "shot", name, source: source === "blend" ? "blend" : source, model, title, outputDir: shotDir, save: saved,
    rig: params.cameraPath ? 'path' : params.rig, cameraPath: params.cameraPath, fps: plan.fps, seconds: plan.seconds, width: plan.width, height: plan.height, samples: plan.samples, engine: params.engine ?? (params.shadow === "catcher" ? "CYCLES" : source === 'blend' ? undefined : "EEVEE"), denoise: params.engine === "CYCLES" || params.shadow === "catcher" ? true : undefined,
    transparent: params.transparent !== false, palette, material: params.material ?? (source === "title" ? "satin" : "keep"), color: hexOr(params.color), lights: params.lights, lightStrength: params.lightStrength, surface: params.surface,
    scene, environment, environmentStrength: params.environmentStrength,
    shadow: params.shadow, lensMm: params.lensMm, azimuth: params.azimuth, elevation: params.elevation, elevationEnd: params.elevationEnd, degrees: params.degrees, travel: params.travel, ease: params.ease, margin: params.margin, offset: params.offset, fStop: params.fStop, motionBlur: params.motionBlur, anchors: params.anchors,
  };
  let result: any;
  try {
    result = await blenderWorker(request, { cwd: blend ? path.dirname(blend) : dir, blend, signal, timeoutMs: DEADLINE_MS, progress });
  } catch (error) {
    // shot.json is written last, so a failed render leaves no half-valid shot behind.
    await fs.rm(shotDir, { recursive: true, force: true });
    throw error;
  }
  const manifest = { ...result.manifest, quality: plan.mode, stepped: params.stepped === true, source: { kind: source, path: blend ?? model ?? title?.font ?? null, title: title?.text ?? null }, palette, editable: path.relative(dir, saved) };
  await fs.writeFile(path.join(shotDir, "shot.json"), JSON.stringify(manifest, null, 1));
  const out = await freshOut(dir, `shot-${name}`);
  const review = await reviewArtifacts(dir, out, shotDir, name, manifest, hexOr(theme.background) ?? "#181A1B", signal).catch((error) => ({ error: `review artifacts failed: ${error.message}` }));
  let full: ReturnType<typeof planShot> | undefined, finalPlanError: string | undefined;
  try { full = planShot({ ...params, mode: "final", fps: undefined, samples: undefined, scale: undefined, width: undefined, height: undefined }, spec); }
  catch (error: any) { finalPlanError = error.message; }
  const finalMinutes = full ? Math.max(1, Math.round((manifest.secondsPerFrame * (full.width * full.height) / (manifest.width * manifest.height) * (plan.mode === "preview" ? 2 : 1) * full.frames) / 60)) : undefined;
  return {
    shot: name, dir: `public/shots/${name}`, frames: manifest.frames, fps: manifest.fps, size: `${manifest.width}x${manifest.height}`, alpha: manifest.alpha, loop: manifest.loop, rig: manifest.rig, quality: plan.mode,
    anchors: manifest.anchorNames, secondsPerFrame: manifest.secondsPerFrame, editable: manifest.editable, ...review,
    use: `<BlenderShot shot="${name}" fit="contain" /> in a scene, or {"component":"ShotScene","props":{"shot":"${name}"${manifest.anchorNames.length ? `,"notes":[{"anchor":"${manifest.anchorNames[0]}","text":"…","cue":"note"}]` : ""}}} in video.json`,
    next: plan.mode === "preview"
      ? ["Open the contact sheet and judge framing, lighting, materials and the move; change the rig, lights, offset or palette with replace:true until it reads.", full ? `Then render the delivery version (mode:"final", replace:true): about ${finalMinutes} min at ${full.width}x${full.height}, ${full.frames} frames; run it in the background if that is long.` : `Draft retained. Preflight the delivery settings before rendering: ${finalPlanError}`]
      : ["Open the contact sheet, then review the shot in the film with video_render mode:\"stills\"."],
    framing: manifest.framing?.filter((_: any, i: number) => i % Math.max(1, Math.floor(manifest.frames/8)) === 0), screenAnchors: manifest.screenAnchors,
    note: `Straight-alpha PNG frames at ${manifest.fps} fps. Previews are drafts; delivery motion needs the film fps. Use StudioScene's shot layer to reserve a hero region and screen.src to track real footage onto a device. The editable scene is ${manifest.editable}.`,
  };
}
