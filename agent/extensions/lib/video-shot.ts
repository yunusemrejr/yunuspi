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
import { blenderWorker, readablePath } from "./blender-studio.ts";
import { contactSheet, freshOut, projectDir, projectWritePath, readSpec } from "./video-studio.ts";
import type { Progress } from "./guarded-process.ts";

export const SHOT_RIGS = ["turntable", "orbit", "push-in", "pull-out", "crane", "drift", "static"] as const;
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
  const mode = params.mode === "final" ? "final" : "preview";
  const projectWidth = Number(spec?.width) || 1920, projectHeight = Number(spec?.height) || 1080;
  const base = Math.min(1, 1920 / projectWidth);
  const scale = params.scale ?? (mode === "preview" ? 0.5 : 1);
  const width = even(params.width ?? projectWidth * base * scale), height = even(params.height ?? projectHeight * base * scale);
  const fps = params.fps ?? (mode === "preview" ? 12 : Math.min(30, Number(spec?.fps) || 30));
  const seconds = params.seconds ?? 4;
  const frames = Math.max(2, Math.round(seconds * fps));
  if (frames > MAX_FRAMES) throw new Error(`${frames} frames exceeds the ${MAX_FRAMES}-frame limit of one shot; shorten seconds or lower fps (BlenderShot blends between frames, so a 12-15 fps render plays smoothly in a 30 fps film)`);
  return { mode, width, height, fps, seconds, frames, samples: params.samples ?? (mode === "preview" ? 16 : 64) };
}

function sourceOf(params: any) {
  const given = ["blend", "model", "title"].filter((key) => params[key] !== undefined && params[key] !== null);
  if (given.length !== 1) throw new Error("Give exactly one source: blend (a .blend with the subject), model (glb, gltf, obj, ply, stl or fbx) or title ({text, font?, depth?, bevel?} for extruded 3D text)");
  return given[0] as "blend" | "model" | "title";
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

export async function videoShot(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  const dir = await projectDir(params.dir, cwd);
  const name = String(params.name ?? "");
  if (!SHOT_NAME.test(name)) throw new Error("name must be lowercase kebab-case (a-z, 0-9, -), at most 48 characters");
  const source = sourceOf(params);
  const spec = await readSpec(dir);
  const plan = planShot(params, spec);
  const theme = spec.theme ?? {};
  const palette = params.look === false ? {} : { background: hexOr(params.background) ?? hexOr(theme.background), accent: hexOr(params.color) ?? hexOr(theme.accent), accent2: hexOr(theme.accent2) };
  const shotDir = projectWritePath(dir, "public", "shots", name);
  if (existsSync(shotDir)) {
    if (params.replace !== true) throw new Error(`public/shots/${name} already exists; pass replace:true to re-render it or choose another name`);
    await fs.rm(shotDir, { recursive: true, force: true });
  }
  await fs.mkdir(shotDir, { recursive: true });
  const saved = projectWritePath(dir, "blender", `${name}.blend`);
  await fs.mkdir(path.dirname(saved), { recursive: true });
  const blend = source === "blend" ? await readablePath(params.blend, cwd) : undefined;
  const model = source === "model" ? await readablePath(params.model, cwd) : undefined;
  const title = source === "title" ? { text: params.title?.text, font: params.title?.font ? await readablePath(params.title.font, cwd) : undefined, depth: params.title?.depth, bevel: params.title?.bevel } : undefined;
  if (title && (typeof title.text !== "string" || !title.text.trim())) throw new Error("title.text is required for a 3D title shot");
  const request = {
    op: "shot", name, source: source === "blend" ? "blend" : source, model, title, outputDir: shotDir, save: saved,
    rig: params.rig ?? (source === "title" ? "orbit" : "turntable"), fps: plan.fps, seconds: plan.seconds, width: plan.width, height: plan.height, samples: plan.samples, engine: params.engine ?? (params.shadow === "catcher" ? "CYCLES" : "EEVEE"), denoise: params.engine === "CYCLES" || params.shadow === "catcher" ? true : undefined,
    transparent: params.transparent !== false, palette, material: params.material ?? (source === "title" ? "satin" : "keep"), color: hexOr(params.color), lights: params.lights ?? "softbox", lightStrength: params.lightStrength,
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
  const manifest = { ...result.manifest, quality: plan.mode, source: { kind: source, path: blend ?? model ?? title?.font ?? null, title: title?.text ?? null }, palette, editable: path.relative(dir, saved) };
  await fs.writeFile(path.join(shotDir, "shot.json"), JSON.stringify(manifest, null, 1));
  const out = await freshOut(dir, `shot-${name}`);
  const review = await reviewArtifacts(dir, out, shotDir, name, manifest, hexOr(theme.background) ?? "#181A1B", signal).catch((error) => ({ error: `review artifacts failed: ${error.message}` }));
  const full = planShot({ ...params, mode: "final", fps: undefined, samples: undefined, scale: undefined, width: undefined, height: undefined }, spec);
  const finalMinutes = Math.max(1, Math.round((manifest.secondsPerFrame * (full.width * full.height) / (manifest.width * manifest.height) * (plan.mode === "preview" ? 2 : 1) * full.frames) / 60));
  return {
    shot: name, dir: `public/shots/${name}`, frames: manifest.frames, fps: manifest.fps, size: `${manifest.width}x${manifest.height}`, alpha: manifest.alpha, loop: manifest.loop, rig: manifest.rig, quality: plan.mode,
    anchors: manifest.anchorNames, secondsPerFrame: manifest.secondsPerFrame, editable: manifest.editable, ...review,
    use: `<BlenderShot shot="${name}" fit="contain" /> in a scene, or {"component":"ShotScene","props":{"shot":"${name}"${manifest.anchorNames.length ? `,"notes":[{"anchor":"${manifest.anchorNames[0]}","text":"…","cue":"note"}]` : ""}}} in video.json`,
    next: plan.mode === "preview"
      ? ["Open the contact sheet and judge framing, lighting, materials and the move; change the rig, lights, offset or palette with replace:true until it reads.", `Then render the delivery version (mode:"final", replace:true): about ${finalMinutes} min at ${full.width}x${full.height}, ${full.frames} frames; run it in the background if that is long.`]
      : ["Open the contact sheet, then review the shot in the film with video_render mode:\"stills\"."],
    note: `Straight-alpha PNG frames at ${manifest.fps} fps; BlenderShot blends between frames when the film runs faster, so 12-15 fps is enough for slow moves. The editable scene with the rig is ${manifest.editable}.`,
  };
}
