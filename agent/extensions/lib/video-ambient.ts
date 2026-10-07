import fs from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './video-segments.ts';
import { ambientPlan } from './ambient-frames.ts';
import { inputFile, outputFolder, produced, probe, run, FFMPEG_FLAGS, inputArgs } from './media-process.ts';
import { runGuarded, type Progress } from './guarded-process.ts';
import { createRenderQueue } from './render-queue.ts';
import { probeImage } from './design-studio.ts';
import { referenceEvidence } from './video-art.ts';
const acquire = createRenderQueue(1);
const worker = new URL('../../scripts/video-ambient.mjs', import.meta.url).pathname;

export async function videoAmbient(params: any, cwd: string, signal?: AbortSignal, progress?: Progress) {
  if (!['plan', 'preview', 'render'].includes(params.action ?? 'plan')) throw Error('action must be plan, preview or render');
  const plan = ambientPlan(params);
  if (params.brief !== undefined && (typeof params.brief !== 'string' || params.brief.length > 8000)) throw Error('brief must be within 8000 characters');
  if (params.references !== undefined && (!Array.isArray(params.references) || params.references.length > 8 || params.references.some(r => typeof r !== 'string' || !r || r.length > 4096))) throw Error('references needs up to 8 image paths or reference URLs');
  const plate = await inputFile(params.plate, cwd), skyMask = params.skyMask ? await inputFile(params.skyMask, cwd) : undefined, audio = params.audio ? await inputFile(params.audio, cwd) : undefined;
  if ((await fs.stat(plate)).size > 40*1024*1024 || (skyMask && (await fs.stat(skyMask)).size > 40*1024*1024)) throw Error('Plate and sky mask must each be within 40 MiB');
  const dimensions = await probeImage(await fs.readFile(plate), signal);
  if (Math.abs(dimensions.width/dimensions.height-plan.width/plan.height)>.015) throw Error('Plate aspect ratio differs from delivery. Crop deliberately with image_convert or match width/height; stretching loses the authored composition.');
  if (skyMask) {
    const maskDimensions = await probeImage(await fs.readFile(skyMask), signal);
    if (maskDimensions.width !== dimensions.width || maskDimensions.height !== dimensions.height) throw Error('The sky mask must use the plate pixel canvas so its boundary does not drift over buildings or terrain.');
  }
  if (params.action === 'render' && params.stage !== 'final') throw Error('Inspect the full-size plate/mask and preview first, then mark the approved source stage:final for delivery. Drafts remain available through preview.');
  const digest = (file: string) => fileDigest(file, signal);
  const sources = await Promise.all([plate, skyMask, audio].filter(Boolean).map(async file => ({ path: file, sha256: await digest(file!) })));
  const direction = { camera: 'locked', colorSpace: 'RGB', sourceStage: params.stage ?? 'draft', plate: sources[0], brief: params.brief ?? null, references: await referenceEvidence(params.references ?? [], cwd, signal), note: 'A hybrid image/Blender plate with procedural weather. This preserves authored details; it does not reconstruct editable 3D geometry or animate unseen objects. Inspect the plate against the requested reference quality before a full render.' };
  if (params.action === undefined || params.action === 'plan') return { plan, direction, sources, next: 'Inspect plate and sky mask pixels, then preview. Final delivery needs video_qa visual/playback/listening verdicts.' };
  const release = await acquire(signal);
  try {
    const dir = await outputFolder(params.outputDir, cwd, true), preview = params.action === 'preview';
    const pw = Math.min(plan.width, 960);
    const rendering = preview ? { ...plan, width: pw, height: Math.max(2, Math.round(pw * plan.height / plan.width / 2) * 2), seconds: Math.min(plan.seconds, 6), frames: Math.round(Math.min(plan.seconds, 6) * plan.fps) } : plan;
    const output = path.join(dir, preview ? 'preview.mp4' : 'ambient.mp4');
    const maskOutput = path.join(dir,'sky-mask.png');
    const request = path.join(dir, 'ambient.json');
    await fs.writeFile(request, JSON.stringify({ plan: rendering, plate, skyMask, audio, output, maskOutput, direction, sources }, null, 2));
    await runGuarded(process.execPath, [worker, request], { cwd, signal, timeoutMs: 900_000, nice: 10, onLine: line => { if (line.startsWith('AMBIENT_PROGRESS ')) progress?.(line.slice(17)); } });
    for (const source of sources) if (await digest(source.path!) !== source.sha256) throw Error('Source changed during ambient render; retain this output as a draft and render the stable inputs again.');
    const info = await probe(output, signal), video = info.streams.find((s: any) => s.codec_type === 'video');
    if (!video || video.width !== rendering.width || video.height !== rendering.height || Math.abs(Number(info.format.duration) - rendering.frames / rendering.fps) > 1 / rendering.fps + .02) throw Error('Ambient encoding differs from the planned canvas or timeline');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', ...inputArgs(output, 0), '-f', 'null', '-'], signal);
    const detailFrame = path.join(dir, 'detail.png');
    await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', ...inputArgs(output, Math.min(1, rendering.seconds / 2)), '-frames:v', '1', detailFrame], signal);
    return { output, artifact: await produced(output), request, detailFrame, ...(rendering.clouds ? {skyMask:maskOutput} : {}), preview, direction, sources, plan: rendering, decodeVerified: true, deliveryReady: false, review: 'Review actual pixels against the approved plate, inspect cloud/rain/lighting playback and listen to the delivery audio. Run video_qa and record honest verdicts. A valid encoding is not visual approval.' };
  } finally { release(); }
}
