import fs from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './video-segments.ts';
import { ambientPlan } from './ambient-frames.ts';
import { inputFile, outputFolder, produced, probe, run, FFMPEG_FLAGS, inputArgs } from './media-process.ts';
import { runGuarded, type Progress } from './guarded-process.ts';
import { createRenderQueue } from './render-queue.ts';
import { probeImage } from './design-studio.ts';
import { referenceEvidence } from './video-art.ts';
import { contactSheet } from './video-studio.ts';
const acquire = createRenderQueue(1);
const worker = new URL('../../scripts/video-ambient.mjs', import.meta.url).pathname;

export async function videoAmbient(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  if (!['plan', 'preview', 'render'].includes(params.action ?? 'plan')) throw Error('action must be plan, preview or render');
  const plan = ambientPlan(params);
  if (params.brief !== undefined && (typeof params.brief !== 'string' || params.brief.length > 8000)) throw Error('brief must be within 8000 characters');
  if (params.references !== undefined && (!Array.isArray(params.references) || params.references.length > 8 || params.references.some(r => typeof r !== 'string' || !r || r.length > 4096))) throw Error('references needs up to 8 image paths or reference URLs');
  const plate = await inputFile(params.plate, cwd), skyMask = params.skyMask ? await inputFile(params.skyMask, cwd) : undefined, audio = params.audio ? await inputFile(params.audio, cwd) : undefined;
  const mattes: Record<string,string>={};
  for(const [role,key] of [['fog','fogMask'],['rain','rainMask'],['reflection','reflectionMask']])if(params[key])mattes[role]=await inputFile(params[key],cwd);
  const images=[plate,skyMask,...Object.values(mattes)].filter(Boolean) as string[];
  for(const file of images)if((await fs.stat(file)).size>40*1024*1024)throw Error('Plate and masks must each be within 40 MiB');
  const dimensions = await probeImage(await fs.readFile(plate), signal);
  if (Math.abs(dimensions.width/dimensions.height-plan.width/plan.height)>.015) throw Error('Plate aspect ratio differs from delivery. Crop deliberately with image_convert or match width/height; stretching loses the authored composition.');
  for (const file of images.slice(1)) {
    const maskDimensions = await probeImage(await fs.readFile(file), signal);
    if (maskDimensions.width !== dimensions.width || maskDimensions.height !== dimensions.height) throw Error('Every mask must use the plate pixel canvas so its boundary does not drift over buildings or terrain.');
  }
  if (params.action === 'render' && params.stage !== 'final') throw Error('Inspect the full-size plate/mask and preview first, then mark the approved source stage:final for delivery. Drafts remain available through preview.');
  const digest = (file: string) => fileDigest(file, signal);
  const sources = await Promise.all([...images,audio].filter(Boolean).map(async file => ({ path: file, sha256: await digest(file!) })));
  const direction = { camera: 'locked', colorSpace: 'RGB', sourceStage: params.stage ?? 'draft', plate: sources[0], brief: params.brief ?? null, references: await referenceEvidence(params.references ?? [], cwd, signal), note: 'Authored image/Blender detail with evolving image-space clouds, masked mist, depth-weighted rain and wet-ground distortion. This preserves authored details; it does not reconstruct editable 3D geometry or simulate volumetric clouds, fluid surfaces or unseen objects. Inspect the plate and every matte against the requested reference before rendering.' };
  if (params.action === undefined || params.action === 'plan') return { plan, direction, sources, next: 'Inspect plate and sky mask pixels, then preview. Final delivery needs video_qa visual/playback/listening verdicts.' };
  const release = await acquire(signal);
  try {
    const dir = await outputFolder(params.outputDir, cwd), preview = params.action === 'preview';
    const pw = Math.min(plan.width, 960);
    const rendering = preview ? { ...plan, width: pw, height: Math.max(2, Math.round(pw * plan.height / plan.width / 2) * 2), seconds: Math.min(plan.seconds, 6), frames: Math.round(Math.min(plan.seconds, 6) * plan.fps) } : plan;
    const framePixels=rendering.width*rendering.height*rendering.frames;
    if(framePixels>plan.work.maxFramePixels)throw Error(`Render work ${framePixels} frame pixels exceeds maxFramePixels:${plan.work.maxFramePixels}. Inspect a reduced preview, shorten/lower the delivery, or set an explicit larger budget.`);
    rendering.work={...plan.work,framePixels,withinBudget:true};
    const output = path.join(dir, preview ? 'preview.mp4' : 'ambient.mp4');
    const maskOutput = path.join(dir,'sky-mask.png');
    const request = path.join(dir, 'ambient.json');
    await fs.writeFile(request, JSON.stringify({ version:2, plan: rendering, plate, skyMask, mattes, audio, output, maskOutput, direction, sources }, null, 2));
    await runGuarded(process.execPath, [worker, request], { cwd, signal, timeoutMs: 900_000, nice: 10, onLine: line => { if (line.startsWith('AMBIENT_PROGRESS ')) progress?.(line.slice(17)); } });
    for (const source of sources) if (await digest(source.path!) !== source.sha256) throw Error('Source changed during ambient render; retain this output as a draft and render the stable inputs again.');
    const info = await probe(output, signal), video = info.streams.find((s: any) => s.codec_type === 'video');
    if (!video || video.width !== rendering.width || video.height !== rendering.height || Math.abs(Number(info.format.duration) - rendering.frames / rendering.fps) > 1 / rendering.fps + .02) throw Error('Ambient encoding differs from the planned canvas or timeline');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', ...inputArgs(output, 0), '-f', 'null', '-'], signal);
    const detailFrame = path.join(dir, 'detail.png');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', ...inputArgs(output, Math.min(1, rendering.seconds / 2)), '-frames:v', '1', detailFrame], signal);
    const reviewFrames=[];
    for(const fraction of [0,.25,.5,.75,1]){
      const seconds=Math.min(rendering.frames-1,Math.round((rendering.frames-1)*fraction))/rendering.fps, frame=path.join(dir,`review-${reviewFrames.length}.png`);
      if(reviewFrames.some(f=>f.seconds===seconds))continue;
      await run('ffmpeg',[...FFMPEG_FLAGS,'-v','error',...inputArgs(output,seconds),'-frames:v','1',frame],signal);
      reviewFrames.push({path:frame,seconds,label:`${seconds.toFixed(2)}s${fraction===0?' · start':fraction===1?' · last':''}`});
    }
    const sheet=await contactSheet(reviewFrames,path.join(dir,'contact-sheet.png'),signal);
    return { output, artifact: await produced(output), request, detailFrame, contactSheet:sheet, reviewFrames, ...(rendering.clouds ? {skyMask:maskOutput} : {}), preview, direction, sources, plan: rendering, loopClosed:rendering.loop && rendering.seconds===rendering.loopSeconds, decodeVerified: true, deliveryReady: false, review: 'Compare actual start/middle/end and full-size detail pixels with the plate and mattes. Play the output including its loop seam; evolving image-space atmosphere is not a volume simulation. Run video_qa for decoded motion evidence and record honest visual/playback/listening verdicts. A valid encoding is not artistic approval.' };
  } finally { release(); }
}
