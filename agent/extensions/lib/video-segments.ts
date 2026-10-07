/** Resumable rendering on one global frame clock. Every segment includes
 * lossless PCM audio; AAC is encoded once after assembly, avoiding encoder
 * padding at each cut. Inputs and completed bytes are content-addressed. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FFMPEG_FLAGS, INPUT_FLAGS, inputArgs, integer, number, run } from './media-process.ts';
import { canonicalMutationPath, selfMutationDenial } from './self-mutation-guard.ts';
import { acquireCatalogCacheLock } from './catalog-cache-lock.ts';

export function planSegments(totalFrames: number, fps: number, segmentSeconds = 60, range?: [number, number]) {
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1 || !Number.isInteger(fps) || fps < 1 || fps > 60) throw Error('Invalid segment frame clock');
  number(segmentSeconds, 60, 1, 600, 'segmentSeconds');
  const from = range?.[0] ?? 0, to = range?.[1] ?? totalFrames - 1;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to >= totalFrames) throw Error('Segment range is outside the timeline');
  const chunk = Math.max(1, Math.round(segmentSeconds * fps));
  const parts: Array<{ index: number; from: number; to: number; frames: number }> = [];
  for (let at = from; at <= to; at += chunk) {
    const end = Math.min(to, at + chunk - 1); parts.push({ index: parts.length, from: at, to: end, frames: end - at + 1 });
    if (parts.length > 100_000) throw Error('Too many segments; increase segmentSeconds');
  }
  return parts;
}
export async function fileDigest(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw Error('Render cache/source must be a regular file');
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
export async function videoFingerprint(dir: string, settings: any, signal?: AbortSignal) {
  const hash = createHash('sha256').update('yunuspi-segments-v1\0').update(JSON.stringify(settings));
  async function visit(file: string) {
    signal?.throwIfAborted();
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) {
      // Shot locks and incomplete replacement sequences are coordination state,
      // not published inputs. They may disappear while a cached shot is read.
      if (path.relative(dir, file) === path.join('public', 'shots') &&
          (/^[a-z0-9][a-z0-9-]{0,47}\.lock$/.test(name) || /^\.[a-z0-9][a-z0-9-]{0,47}-render-[a-f0-9]{10}$/.test(name))) continue;
      await visit(path.join(file, name));
    }
    else if (stat.isFile()) hash.update(path.relative(dir, file)).update('\0').update(await fileDigest(file, signal)).update('\0');
    else throw Error('Video sources must be regular files/directories; symlinks cannot define a resumable render');
  }
  for (const name of ['video.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'public']) {
    const file = path.join(dir, name); if (await fs.lstat(file).catch(() => undefined)) await visit(file);
  }
  return hash.digest('hex');
}
function seconds(value: any) {
  if (typeof value === 'string' && /^\d+:\d+:\d+(\.\d+)?$/.test(value)) {
    const [h, m, s] = value.split(':').map(Number); return h * 3600 + m * 60 + s;
  }
  return Number(value);
}
function rate(value: string) {
  const [n, d = 1] = String(value).split('/').map(Number); return n / d;
}
/** Decode new bytes once; a matching digest and validation receipt permit
 * cheap subsequent resumes. A legacy checkpoint is inspected and adopted
 * without paying to render the segment again. */
async function verifyFrames(file: string, frames: number, fps: number, pcm: boolean, signal?: AbortSignal, saved?: any, size?: any) {
  const { stdout } = await run('ffprobe', ['-v', 'error', ...INPUT_FLAGS, '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,duration,sample_rate,channels,color_range,color_space,color_transfer,color_primaries:stream_tags=DURATION',
    '-of', 'json', file], signal, 20_000);
  const info = JSON.parse(stdout), video = info.streams?.find((s: any) => s.codec_type === 'video');
  const audio = info.streams?.find((s: any) => s.codec_type === 'audio');
  // Full-range 8-bit 4:2:0 from Remotion's JPEG input is reported as
  // yuvj420p by FFprobe even when the renderer requested yuv420p.
  if (video?.codec_name !== 'h264' || !['yuv420p', 'yuvj420p'].includes(video.pix_fmt) || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)) throw Error('Render requires H.264 8-bit 4:2:0 video');
  if (size && (video.width !== size.width || video.height !== size.height)) throw Error('Rendered dimensions do not match the requested scaled composition');
  if (Math.abs(rate(video.r_frame_rate) - fps) > 0.001 || !Number.isFinite(rate(video.r_frame_rate))) throw Error('Rendered frame rate does not match the global frame clock');
  const duration = frames / fps, videoDuration = seconds(video.duration ?? video.tags?.DURATION ?? info.format?.duration);
  if (!Number.isFinite(videoDuration) || Math.abs(videoDuration - duration) > 0.002) throw Error('Rendered video has the wrong frame duration');
  if (!audio || audio.codec_name !== (pcm ? 'pcm_s16le' : 'aac') || !Number.isFinite(Number(audio.sample_rate)) || Number(audio.sample_rate) <= 0 || !Number.isSafeInteger(audio.channels)) throw Error(pcm ? 'Every render segment requires lossless PCM audio' : 'Assembled render requires AAC audio');
  const audioDuration = seconds(audio.duration ?? audio.tags?.DURATION);
  if (!Number.isFinite(audioDuration) || Math.abs(audioDuration - duration) > (pcm ? 0.002 : 1024 / Number(audio.sample_rate) + 0.002)) throw Error('Rendered audio does not fill its frame allocation');
  // Matroska can omit a limited-range flag that MP4 exposes as "tv".
  // Normalize that equivalent interpretation, while retaining full range.
  const evidence = { version: 1, frames, fps, width: video.width, height: video.height, pixelFormat: video.pix_fmt, colorRange: video.color_range === 'pc' || video.pix_fmt === 'yuvj420p' ? 'pc' : 'tv',
    colorSpace: video.color_space ?? null, colorTransfer: video.color_transfer ?? null, colorPrimaries: video.color_primaries ?? null,
    audioCodec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels };
  if (JSON.stringify(saved) !== JSON.stringify(evidence)) {
    const decoded = await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(file, 0),
      '-map', '0:v:0', '-map', '0:a:0', '-fps_mode', 'passthrough', '-stats_period', '10', '-progress', 'pipe:1', '-f', 'null', '-'], signal, 600_000);
    const actual = Number([...decoded.stdout.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1]);
    if (actual !== frames) throw Error('Decoded frame count ' + actual + ' does not match the requested ' + frames + ' frames');
  }
  return evidence;
}
function sameStreams(a: any, b: any) {
  return ['fps', 'width', 'height', 'pixelFormat', 'colorRange', 'colorSpace', 'colorTransfer', 'colorPrimaries', 'sampleRate', 'channels'].every(key => a[key] === b[key]);
}
export async function reusableSegment(dir: string, part: any, saved: any, fps: number, signal?: AbortSignal, size?: any) {
  if (!saved || saved.from !== part.from || saved.to !== part.to || !/^[a-f0-9]{64}$/.test(saved.sha256 ?? '')) return false;
  const file = path.join(dir, `part-${String(part.index).padStart(6, '0')}.mkv`);
  try {
    if (await fileDigest(file, signal) !== saved.sha256) return false;
    saved.verification = await verifyFrames(file, part.frames, fps, true, signal, saved.verification, size);
    return true;
  } catch (error) { if (signal?.aborted) throw error; return false; }
}

type Renderer = (dir: string, request: any, signal: AbortSignal | undefined, progress: (text: string) => void, timeout: number) => Promise<any>;
export async function renderSegments(params: any, dir: string, spec: any, totalFrames: number, request: any, renderer: Renderer, signal?: AbortSignal, progress: (text: string) => void = () => {}) {
  const parts = planSegments(totalFrames, spec.fps, params.segmentSeconds ?? 60, request.range);
  const scale = number(request.scale, 1, 0.01, 4, 'scale');
  // Match Remotion's pinned validateEvenDimensionsWithCodec behavior: reduce
  // the design dimension until its rounded scaled output is even.
  const scaled = (dimension: number) => { while (Math.round(dimension * scale) % 2) dimension--; return Math.round(dimension * scale); };
  const size = Number.isSafeInteger(spec.width) && Number.isSafeInteger(spec.height) ? { width: scaled(spec.width), height: scaled(spec.height) } : undefined;
  const maxSegments = integer(params.maxSegments, 3, 1, 16, 'maxSegments');
  const settings = { range: request.range ?? [0, totalFrames - 1], scale: request.scale, crf: request.crf ?? 18, fps: spec.fps, segmentSeconds: params.segmentSeconds ?? 60, master: params.master !== false,
    composition: request.composition ?? 'Main', muted: request.muted === true, renderer: await fileDigest(new URL('../../scripts/video-render.mjs', import.meta.url).pathname, signal) };
  const key = await videoFingerprint(dir, settings, signal);
  const cache = canonicalMutationPath(path.join(dir, '.video-cache', `segments-${key}`), dir);
  const denial = selfMutationDenial(cache, dir); if (denial) throw Error(denial);
  await fs.mkdir(cache, { recursive: true });
  const manifestPath = path.join(cache, 'segments.json');
  const release = await acquireCatalogCacheLock(manifestPath, signal);
  const checkpoint = async (manifest: any) => {
    const temporary = path.join(cache, `manifest-${randomBytes(4).toString('hex')}.json`);
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n'); await fs.rename(temporary, manifestPath);
  };
  try {
    let manifest: any = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => undefined);
    if (!manifest || manifest.key !== key || !Array.isArray(manifest.parts)) manifest = { version: 1, key, settings, totalSegments: parts.length, parts: [] };
    let rendered = 0, reused = 0, streams: any;
    for (const part of parts) {
      signal?.throwIfAborted();
      if (await reusableSegment(cache, part, manifest.parts[part.index], spec.fps, signal, size)) {
        const evidence = manifest.parts[part.index].verification;
        if (!streams || sameStreams(streams, evidence)) { streams ??= evidence; reused++; continue; }
        // Repair an incompatible legacy part using the same bounded render
        // budget instead of returning a retry which can never succeed.
      }
      manifest.parts[part.index] = null;
      if (rendered >= maxSegments) continue;
      progress(`Rendering segment ${part.index + 1}/${parts.length} (${part.from}..${part.to})`);
      const staging = path.join(cache, `work-${randomBytes(5).toString('hex')}`); await fs.mkdir(staging);
      try {
        const result = await renderer(dir, { ...request, outDir: staging, mode: 'segment', range: [part.from, part.to], losslessAudio: true }, signal, progress, Math.min(3_600_000, 120_000 + part.frames * 600));
        const verification = await verifyFrames(result.output, part.frames, spec.fps, true, signal, undefined, size);
        if (streams && !sameStreams(streams, verification)) throw Error('Rendered segments have incompatible video/audio streams');
        streams ??= verification;
        // Never checkpoint changed inputs under the original content key,
        // including calls which stop before the complete-film check below.
        if (await videoFingerprint(dir, settings, signal) !== key) throw Error('Project changed while rendering a segment; retry using the current sources');
        const output = path.join(cache, `part-${String(part.index).padStart(6, '0')}.mkv`);
        const sha256 = await fileDigest(result.output, signal);
        await fs.rename(result.output, output);
        manifest.parts[part.index] = { ...part, sha256, seconds: part.frames / spec.fps, verification };
        await checkpoint(manifest); rendered++;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    const completed = parts.filter(p => manifest.parts[p.index]).length;
    await checkpoint(manifest);
    if (completed < parts.length) return { complete: false, mode: 'segments', cache: manifestPath, completedSegments: completed, totalSegments: parts.length, renderedSegments: rendered, reusedSegments: reused,
      next: { ...params, mode: 'segments' }, note: 'Repeat video_render with these parameters. Finished segments persist; source/settings changes choose a new cache. No final video has been delivered yet.' };
    if (await videoFingerprint(dir, settings, signal) !== key) throw Error('Project changed during rendering; retry to create a cache for the new sources');
    const final = path.join(request.outDir, 'final.mp4');
    const staging = path.join(request.outDir, 'final-work-' + randomBytes(5).toString('hex') + '.mp4');
    const list = path.join(cache, `concat-${randomBytes(4).toString('hex')}.txt`);
    await fs.writeFile(list, parts.map(p => `file 'part-${String(p.index).padStart(6, '0')}.mkv'\nduration ${p.frames / spec.fps}`).join('\n') + '\n');
    let verification;
    try {
      // Matroska timestamps round 24/30/60fps frames to milliseconds.
      // Restore their exact frame ticks while retaining encoded video bytes
      // and B-frame decode order; a plain copy otherwise drifts in MP4's
      // average-frame-rate/duration metadata and fails project matching.
      const clock = 'setts=pts=round(PTS*TB*' + spec.fps + '):dts=round(DTS*TB*' + spec.fps + '):duration=1:time_base=1/' + spec.fps;
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-bsf:v', clock, '-c:a', 'aac', '-ar', String(streams.sampleRate), '-b:a', '192k', '-t', String(parts.reduce((sum, p) => sum + p.frames, 0) / spec.fps), '-movflags', '+faststart', '-map_metadata', '-1', staging], signal, 600_000);
      verification = await verifyFrames(staging, parts.reduce((sum, p) => sum + p.frames, 0), spec.fps, false, signal, undefined, size);
      if (!sameStreams(streams, verification)) throw Error('Assembled render changed the segment stream layout');
      signal?.throwIfAborted();
      await fs.link(staging, final); // Atomic publication without replacing an existing delivery.
    } finally { await fs.rm(list, { force: true }); await fs.rm(staging, { force: true }); }
    return { complete: true, output: final, cache: manifestPath, completedSegments: completed, totalSegments: parts.length, renderedSegments: rendered, reusedSegments: reused,
      audioSeams: 'PCM across render segments; one final AAC encode', decodeVerified: true, verification, renderMs: null };
  } finally { release(); }
}
