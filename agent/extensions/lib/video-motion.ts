/** Actual decoded-frame motion/timing evidence over one bounded video window.
 * No resampling: VFR timestamps remain visible. Proxy differences measure pixel
 * change, not aesthetic quality, object motion or whether a hold is intentional. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG_FLAGS, inputArgs, inputFile, number, probe, requireStream, run } from './media-process.ts';

export const VIDEO_MOTION_LIMITS = { seconds: 30, frames: 1800, width: 64, height: 64 } as const;
const round = (n: number) => Math.round(n * 10000) / 10000;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
export function analyzeDecodedMotion(times: number[], pixels: Buffer, options: { loop?: boolean; expectedFps?: number } = {}) {
  const area = VIDEO_MOTION_LIMITS.width * VIDEO_MOTION_LIMITS.height;
  if (times.length < 2 || times.length > VIDEO_MOTION_LIMITS.frames || pixels.length !== times.length * area || times.some(t => !Number.isFinite(t))) throw Error('Motion QA needs 2..1800 decoded frames with matching finite timestamps');
  const deltas: Array<{ from: number; to: number; meanPixelDelta: number; gapSeconds: number }> = [];
  const difference = (a: number, b: number) => { let sum = 0; for (let i = 0; i < area; i++) sum += Math.abs(pixels[a * area + i] - pixels[b * area + i]); return sum / area; };
  for (let i = 1; i < times.length; i++) deltas.push({ from: times[i - 1], to: times[i], meanPixelDelta: difference(i - 1, i), gapSeconds: times[i] - times[i - 1] });
  const positive = deltas.map(d => d.gapSeconds).filter(x => x > 0), typical = median(positive);
  const findings: Array<{ id: string; severity: 'FAIL' | 'WARN'; detail: string }> = [];
  const nonIncreasing = deltas.filter(d => d.gapSeconds <= 0).length;
  if (nonIncreasing) findings.push({ id: 'frame-order', severity: 'FAIL', detail: `${nonIncreasing} non-increasing decoded presentation timestamps; inspect source timestamp generation.` });
  const expected = options.expectedFps === undefined ? null : 1 / number(options.expectedFps, 30, 1, 120, 'expectedFps');
  const baseline = expected ?? typical;
  const irregular = baseline ? deltas.filter(d => d.gapSeconds > baseline * 1.5 + .0001 || d.gapSeconds < baseline * .5 - .0001) : [];
  if (expected && typical && Math.abs(typical - expected) > expected * .05 + .0001) findings.push({ id: 'frame-rate', severity: 'FAIL', detail: `Measured typical interval ${round(typical)}s differs from expected ${options.expectedFps}fps. Set the export clock to frameIndex/fps.` });
  if (irregular.length) findings.push({ id: 'frame-cadence', severity: expected ? 'FAIL' : 'WARN', detail: `${irregular.length} intervals differ by over 50% from ${expected ? 'the requested clock' : 'the median'}; variable cadence may be intentional. Inspect the reported gaps.` });
  const holds: Array<{ start: number; end: number; seconds: number }> = [];
  let holdStart: number | undefined, holdEnd = 0;
  for (const d of deltas) {
    if (d.meanPixelDelta <= .2) { holdStart ??= d.from; holdEnd = d.to; }
    else if (holdStart !== undefined) { if (holdEnd - holdStart >= .5) holds.push({ start: round(holdStart), end: round(holdEnd), seconds: round(holdEnd - holdStart) }); holdStart = undefined; }
  }
  if (holdStart !== undefined && holdEnd - holdStart >= .5) holds.push({ start: round(holdStart), end: round(holdEnd), seconds: round(holdEnd - holdStart) });
  if (holds.length) findings.push({ id: 'static-hold', severity: 'WARN', detail: `${holds.length} decoded low-change stretches last at least 0.5s. Match them to storyboard holds; proxy stillness alone is not a defect.` });
  const normalDelta = median(deltas.map(d => d.meanPixelDelta)) ?? 0;
  const loop = options.loop ? { lastToFirstMeanPixelDelta: round(difference(times.length - 1, 0)), medianAdjacentMeanPixelDelta: round(normalDelta), ratio: normalDelta > .01 ? round(difference(times.length - 1, 0) / normalDelta) : null } : null;
  if (loop && loop.lastToFirstMeanPixelDelta > 2 && (loop.ratio === null || loop.ratio > 4)) findings.push({ id: 'loop-boundary', severity: 'WARN', detail: 'Last→first decoded proxy change exceeds normal adjacent changes. Inspect the loop boundary in playback; a cut or camera reset may be intended.' });
  return {
    frames: times.length, firstSeconds: round(times[0]), lastSeconds: round(times.at(-1)!),
    timing: { medianIntervalSeconds: typical === null ? null : round(typical), estimatedFps: typical ? round(1 / typical) : null, expectedFps: options.expectedFps ?? null, nonIncreasing, irregularIntervals: irregular.length, largestGaps: [...deltas].sort((a, b) => b.gapSeconds - a.gapSeconds).slice(0, 6).map(d => ({ from: round(d.from), to: round(d.to), seconds: round(d.gapSeconds) })) },
    pixelChange: { medianMeanDelta: round(normalDelta), duplicateFrames: deltas.filter(d => d.meanPixelDelta === 0).length, holds: holds.slice(0, 8), holdsTruncated: holds.length > 8, largestChanges: [...deltas].sort((a, b) => b.meanPixelDelta - a.meanPixelDelta).slice(0, 6).map(d => ({ from: round(d.from), to: round(d.to), meanPixelDelta: round(d.meanPixelDelta) })) },
    loop, findings, blocking: findings.filter(f => f.severity === 'FAIL').length,
    evidence: 'Every decoded frame in the inspected window, with original presentation timestamps and a 64x64 grayscale proxy. No frame-rate filter, interpolation or sparse screenshot inference.',
    unverified: 'Motion appearance, easing, colors, off-window behavior, reduced-motion alternatives, audio sync and artistic approval. Play the source and inspect transition frames before delivery.',
  };
}

export async function videoMotion(params: any, cwd: string, signal?: AbortSignal) {
  const start = number(params.start, 0, 0, 86400, 'start'), duration = number(params.duration, 10, .05, VIDEO_MOTION_LIMITS.seconds, 'duration');
  if (params.loop !== undefined && typeof params.loop !== 'boolean') throw Error('loop must be boolean');
  if (params.expectedFps !== undefined) number(params.expectedFps, 30, 1, 120, 'expectedFps');
  const file = await inputFile(params.path, cwd), info = await probe(file, signal), stream = requireStream(info, 'video');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunuspi-motion-'));
  try {
    const dest = path.join(dir, 'proxy.gray');
    // Trim before showinfo: an output-only -t can log a decoded boundary
    // frame that is subsequently discarded, leaving PTS/pixel counts unequal.
    const result = await run('ffmpeg', [...FFMPEG_FLAGS, '-loglevel', 'info', ...inputArgs(file, start), '-t', String(duration), '-map', `0:${stream.index}`, '-an', '-vf', `trim=duration=${duration},scale=64:64,format=gray,showinfo`, '-fps_mode', 'passthrough', '-frames:v', String(VIDEO_MOTION_LIMITS.frames + 1), '-c:v', 'rawvideo', '-f', 'rawvideo', dest], signal, 120000);
    const pixels = await fs.readFile(dest), area = VIDEO_MOTION_LIMITS.width * VIDEO_MOTION_LIMITS.height;
    if (pixels.length > VIDEO_MOTION_LIMITS.frames * area) throw Error('Motion QA exceeds 1800 frames; shorten the window. No silent subsampling is performed.');
    const times = [...result.stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/g)].map(m => start + Number(m[1]));
    const report = analyzeDecodedMotion(times, pixels, { loop: params.loop, expectedFps: params.expectedFps });
    return { source: file, window: { start, requestedDuration: duration }, ...report, timestampOrigin: 'Seconds from source presentation start (post-seek PTS + requested start).', proxyBytes: pixels.length };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Inspect the delivery boundary, including for films longer than the motion
 * window. A small proxy is temporal evidence, never an artistic pass. */
export async function videoLoopBoundary(file:string,seconds:number,fps:number,normalDelta:number,signal?:AbortSignal) {
  number(seconds,1,.01,86400,'seconds');number(fps,24,1,120,'fps');
  const area=VIDEO_MOTION_LIMITS.width*VIDEO_MOTION_LIMITS.height, pixels:Buffer[]=[];
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yunuspi-loop-'));
  try {
    const times=[0,Math.max(0,seconds-2/fps),Math.max(0,seconds-1/fps)];
    for(let i=0;i<times.length;i++){
      const out=path.join(dir,`${i}.gray`);
      await run('ffmpeg',[...FFMPEG_FLAGS,'-v','error',...inputArgs(file,times[i]),'-an','-vf','scale=64:64,format=gray','-frames:v','1','-c:v','rawvideo','-f','rawvideo',out],signal,30000);
      const frame=await fs.readFile(out);if(frame.length!==area)throw Error('Loop evidence did not decode the requested boundary frame');pixels.push(frame);
    }
    const delta=(a:Buffer,b:Buffer)=>{let sum=0;for(let i=0;i<area;i++)sum+=Math.abs(a[i]-b[i]);return sum/area;};
    const lastToFirstMeanPixelDelta=delta(pixels[2],pixels[0]),lastAdjacentMeanPixelDelta=delta(pixels[2],pixels[1]);
    const baseline=Math.max(normalDelta,lastAdjacentMeanPixelDelta),ratio=baseline>.01?lastToFirstMeanPixelDelta/baseline:null;
    const findings=lastToFirstMeanPixelDelta>2 && (ratio===null || ratio>4)?[{id:'delivery-loop-boundary',severity:'WARN' as const,detail:'The actual final→first decoded frame change exceeds normal motion. Inspect the delivery seam; a cut, reset or non-periodic effect may be present.'}]:[];
    return {times,lastToFirstMeanPixelDelta:round(lastToFirstMeanPixelDelta),lastAdjacentMeanPixelDelta:round(lastAdjacentMeanPixelDelta),ratio:ratio===null?null:round(ratio),findings,evidence:'First and final two decoded delivery frames, 64x64 grayscale. Audio seam and perceptual loop smoothness remain unverified.'};
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
