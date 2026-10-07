/** Blender shots for video projects. A shot is a camera move around one
 * subject (a .blend, an imported model or extruded 3D text), rendered headless
 * as an RGBA image sequence into public/shots/<name>/ with a manifest and the
 * per-frame screen positions of named anchors. The template's BlenderShot
 * primitive plays it frame-accurately and ShotAnchor pins 2D annotations to 3D
 * features. Palette, size and frame rate default to the project's look, so the
 * 3D layer is lit and graded to belong to the 2D film instead of being pasted in. */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from 'node:crypto';
import path from "node:path";
import { FFMPEG_FLAGS, produced, run } from "./media-process.ts";
import { integer, number } from './media-process.ts';
import { BLENDER_WORKER, blenderBinary, blenderWorker, readablePath } from "./blender-studio.ts";
import { fileDigest } from './video-segments.ts';
import { acquireCatalogCacheLock } from './catalog-cache-lock.ts';
import { contactSheet, freshOut, projectDir, projectWritePath, readSpec } from "./video-studio.ts";
import type { Progress } from "./guarded-process.ts";
import { validateShotScene } from './shot-scene.ts';

export const SHOT_RIGS = ["turntable", "orbit", "push-in", "pull-out", "crane", "drift", "static", "scene"] as const;
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
  if(params.mode!==undefined && !['preview','final'].includes(params.mode))throw Error('mode must be preview or final');
  if(params.projection!==undefined && !['perspective','orthographic'].includes(params.projection))throw Error('projection must be perspective or orthographic');
  if(params.projection==='orthographic' && ['push-in','pull-out'].includes(params.rig))throw Error('Orthographic shots need orbit, crane, drift or static rigs; use a compositor zoom or perspective camera for a push-in');
  const mode = params.mode === "final" ? "final" : "preview";
  const projectWidth = Number(spec?.width) || 1920, projectHeight = Number(spec?.height) || 1080;
  const base = mode==='preview'?Math.min(1,1920/projectWidth):1;
  const scale = number(params.scale,mode==='preview'?.5:1,.1,1,'scale');
  const width = even(number(params.width,projectWidth*base*scale,64,3840,'width')), height = even(number(params.height,projectHeight*base*scale,64,3840,'height'));
  const fps = integer(params.fps,mode==='preview'?12:Number(spec?.fps)||30,1,60,'fps');
  const seconds = number(params.seconds,4,.5,20,'seconds');
  if (mode === 'final' && fps < (Number(spec?.fps) || 30) && params.stepped !== true) throw Error('Final shots need the film frame rate. Low fps is a draft, not smooth motion; use stepped:true only for intentional stop-motion.');
  const frames = Math.max(2, Math.round(seconds * fps));
  if (frames > MAX_FRAMES) throw new Error(`${frames} frames exceeds the ${MAX_FRAMES}-frame limit of one shot; split longer choreography into shots on the master timeline`);
  return { mode, width, height, fps, seconds, frames, samples: integer(params.samples,mode==='preview'?16:64,1,1024,'samples') };
}

/** Only native, self-contained inputs can be reused automatically. Imported
 * blends/models may depend on external links, simulations or textures. */
async function shotFingerprint(request: any, source: string, signal?: AbortSignal) {
  if(!['scene','title'].includes(source) || request.scene?.objects?.some((o: any)=>o.shape==='model'))return undefined;
  const {outputDir,save,...settings}=request;
  const files=[request.environment,request.title?.font,...(request.scene?.objects ?? []).flatMap((o: any)=>[o.font,o.image,...Object.values(o.maps ?? {})])].filter(Boolean).sort();
  const hash=createHash('sha256').update('yunuspi-shot-v2').update(JSON.stringify(settings)).update(await fileDigest(BLENDER_WORKER,signal));
  const binary=blenderBinary();if(binary){const stat=await fs.stat(binary);hash.update(JSON.stringify([binary,stat.size,stat.mtimeMs]));}
  for(const file of files)hash.update(file).update(await fileDigest(file,signal));
  return hash.digest('hex');
}

export async function shotDigests(folder: string, frames: number, signal?: AbortSignal) {
  const entries=[];
  for(let i=1;i<=frames;i++) {
    const name=`frame-${String(i).padStart(4,'0')}.png`,file=path.join(folder,name);
    entries.push({name,sha256:await fileDigest(file,signal)});
  }
  if(existsSync(path.join(folder,'anchors.json')))entries.push({name:'anchors.json',sha256:await fileDigest(path.join(folder,'anchors.json'),signal)});
  return entries;
}

export async function verifyShotCache(folder: string, saved: string, manifest: any, fingerprint: string | undefined, signal?: AbortSignal) {
  if(!fingerprint || manifest?.cache?.fingerprint!==fingerprint || !Number.isInteger(manifest.frames) || manifest.frames<2 || manifest.frames>MAX_FRAMES)return false;
  try {
    const actual=await shotDigests(folder,manifest.frames,signal);
    return JSON.stringify(actual)===JSON.stringify(manifest.cache.files) && await fileDigest(saved,signal)===manifest.cache.editable;
  }catch(error){signal?.throwIfAborted();return false;}
}

/** Publish both the PNG sequence and editable blend, rolling back either
 * rename failure. A cancelled replacement never removes the good old shot. */
export async function publishShot(staging: string, destination: string, savedStaging: string, saved: string) {
  const old=`${destination}-previous-${randomBytes(4).toString('hex')}`,oldBlend=`${saved}-previous-${randomBytes(4).toString('hex')}`;
  let movedOld=false,movedBlend=false,published=false,publishedBlend=false;
  try {
    if(existsSync(destination)){await fs.rename(destination,old);movedOld=true;}
    if(existsSync(saved)){await fs.rename(saved,oldBlend);movedBlend=true;}
    await fs.rename(staging,destination);published=true;
    await fs.rename(savedStaging,saved);publishedBlend=true;
  }catch(error){
    if(published)await fs.rm(destination,{recursive:true,force:true});
    if(publishedBlend)await fs.rm(saved,{force:true});
    if(movedOld)await fs.rename(old,destination);
    if(movedBlend)await fs.rename(oldBlend,saved);
    throw error;
  }
  await fs.rm(old,{recursive:true,force:true});await fs.rm(oldBlend,{force:true});
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
  const detailFrame=tiles[Math.floor(tiles.length/2)]?.path;
  await Promise.all(tiles.filter(tile=>tile.path!==detailFrame).map((tile) => fs.rm(tile.path, { force: true })));
  return { contactSheet: sheet, detailFrame, preview: existsSync(video) ? (await produced(video)).path : undefined };
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
  if (scene) for (const object of scene.objects) {
    if (object.path) object.path = await sourcePath(object.path, dir, cwd);
    if (object.font) object.font = await sourcePath(object.font, dir, cwd);
    if (object.image) object.image = await sourcePath(object.image, dir, cwd);
    if (object.maps) for (const key of ['diffuse', 'roughness', 'metallic', 'normal']) if (object.maps[key]) object.maps[key] = await sourcePath(object.maps[key], dir, cwd);
  }
  const environment = params.environment ? await sourcePath(params.environment, dir, cwd) : undefined;
  if (title && (typeof title.text !== "string" || !title.text.trim())) throw new Error("title.text is required for a 3D title shot");
  const shotDir = projectWritePath(dir, "public", "shots", name);
  // The rigged scene is saved beside the source; never over the source itself.
  const saved = projectWritePath(dir, "blender", blend && path.resolve(blend) === path.resolve(dir, "blender", `${name}.blend`) ? `${name}-shot.blend` : `${name}.blend`);
  await fs.mkdir(path.dirname(shotDir), { recursive: true });
  await fs.mkdir(path.dirname(saved), { recursive: true });
  const staging=path.join(path.dirname(shotDir),`.${name}-render-${randomBytes(5).toString('hex')}`),savedStaging=path.join(path.dirname(saved),`.${name}-${randomBytes(5).toString('hex')}.blend`);
  const request = {
    op: "shot", name, source: source === "blend" ? "blend" : source, model, title, outputDir: staging, save: savedStaging, projection:params.projection,
    rig: params.rig, fps: plan.fps, seconds: plan.seconds, width: plan.width, height: plan.height, samples: plan.samples, engine: params.engine ?? (params.shadow === "catcher" ? "CYCLES" : source === 'blend' ? undefined : "EEVEE"), denoise: params.engine === "CYCLES" || params.shadow === "catcher" ? true : undefined,
    transparent: params.transparent !== false, palette, material: params.material ?? (source === "title" ? "satin" : "keep"), color: hexOr(params.color), lights: params.lights, lightStrength: params.lightStrength, surface: params.surface,
    scene, environment, environmentStrength: params.environmentStrength,
    shadow: params.shadow, lensMm: params.lensMm, azimuth: params.azimuth, elevation: params.elevation, elevationEnd: params.elevationEnd, degrees: params.degrees, travel: params.travel, ease: params.ease, margin: params.margin, offset: params.offset, fStop: params.fStop, motionBlur: params.motionBlur, anchors: params.anchors,
  };
  const unlock=await acquireCatalogCacheLock(shotDir,signal);
  let result: any;
  let manifest: any;
  try {
    const fingerprint=params.reuse===false?undefined:await shotFingerprint(request,source,signal);
    const previous=await fs.readFile(path.join(shotDir,'shot.json'),'utf8').then(JSON.parse,()=>null);
    if(await verifyShotCache(shotDir,saved,previous,fingerprint,signal)){const out=await freshOut(dir,`shot-${name}-reused`),review=await reviewArtifacts(dir,out,shotDir,name,previous,hexOr(theme.background)??'#181A1B',signal);return {shot:name,dir:`public/shots/${name}`,frames:previous.frames,fps:previous.fps,size:`${previous.width}x${previous.height}`,alpha:previous.alpha,quality:previous.quality,rig:previous.rig,anchors:previous.anchorNames,editable:previous.editable,reused:true,cacheVerified:true,...review,note:'Unchanged native shot reused after verifying every frame, anchor track and editable blend by content. Its visual quality still needs review.'};}
    if(previous && params.replace!==true)throw Error(`public/shots/${name} already exists; pass replace:true to re-render it or choose another name`);
    await fs.mkdir(staging);
    result = await blenderWorker(request, { cwd: blend ? path.dirname(blend) : dir, blend, signal, timeoutMs: DEADLINE_MS, progress });
    manifest = { ...result.manifest, quality: plan.mode, stepped: params.stepped === true, source: { kind: source, path: blend ?? model ?? title?.font ?? null, title: title?.text ?? null }, palette, editable: path.relative(dir, saved) };
    if(manifest.frames!==plan.frames || manifest.width!==plan.width || manifest.height!==plan.height || manifest.fps!==plan.fps)throw Error('Blender shot metadata does not match its planned delivery');
    const files=await shotDigests(staging,manifest.frames,signal);
    manifest.cache=fingerprint?{fingerprint,files,editable:await fileDigest(savedStaging,signal)}:undefined;
    await fs.writeFile(path.join(staging,'shot.json'),JSON.stringify(manifest,null,1));
    signal?.throwIfAborted();
    if(fingerprint && await shotFingerprint(request,source,signal)!==fingerprint)throw Error('Shot inputs changed during render; retry with stable assets');
    await publishShot(staging,shotDir,savedStaging,saved);
    const out = await freshOut(dir, `shot-${name}`);
    const review = await reviewArtifacts(dir, out, shotDir, name, manifest, hexOr(theme.background) ?? "#181A1B", signal).catch((error) => ({ error: `review artifacts failed: ${error.message}` }));
    manifest.review=review;await fs.writeFile(path.join(shotDir,'shot.json'),JSON.stringify(manifest,null,1));
    const full = {width:Number(spec.width)||1920,height:Number(spec.height)||1080,frames:Math.round(plan.seconds*(Number(spec.fps)||30))};
    const finalMinutes = Math.max(1, Math.round((manifest.secondsPerFrame * (full.width * full.height) / (manifest.width * manifest.height) * (plan.mode === "preview" ? 2 : 1) * full.frames) / 60));
    return {
      shot: name, dir: `public/shots/${name}`, frames: manifest.frames, fps: manifest.fps, size: `${manifest.width}x${manifest.height}`, alpha: manifest.alpha, loop: manifest.loop, rig: manifest.rig, quality: plan.mode,reused:false,
      anchors: manifest.anchorNames, secondsPerFrame: manifest.secondsPerFrame, editable: manifest.editable, ...review,
      use: `<BlenderShot shot="${name}" fit="contain" /> in a scene, or {"component":"ShotScene","props":{"shot":"${name}"${manifest.anchorNames.length ? `,"notes":[{"anchor":"${manifest.anchorNames[0]}","text":"…","cue":"note"}]` : ""}}} in video.json`,
      next: plan.mode === "preview"
        ? ["Open the contact sheet and judge framing, lighting, materials and the move; change the rig, lights, offset or palette with replace:true until it reads.", `Then render the delivery version (mode:"final", replace:true): about ${finalMinutes} min at ${full.width}x${full.height}, ${full.frames} frames${full.frames>MAX_FRAMES?`; split this motion into shots of at most ${MAX_FRAMES} frames`:''}; run it in the background if that is long.`]
        : ["Open the contact sheet, then review the shot in the film with video_render mode:\"stills\"."],
      framing: manifest.framing?.filter((_: any, i: number) => i % Math.max(1, Math.floor(manifest.frames/8)) === 0), screenAnchors: manifest.screenAnchors,
      note: `Straight-alpha PNG frames at ${manifest.fps} fps. Previews are drafts; delivery motion needs the film fps. Use StudioScene's shot layer to reserve a hero region and screen.src to track real footage onto a device. The editable scene is ${manifest.editable}.`,
    };
  } finally {
    try { await fs.rm(staging,{recursive:true,force:true});await fs.rm(savedStaging,{force:true}); } finally { unlock(); }
  }
}
