/** Resumable rendering on one global frame clock. Every segment includes
 * lossless PCM audio; AAC is encoded once after assembly, avoiding encoder
 * padding at each cut. Inputs and completed bytes are content-addressed. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FFMPEG_FLAGS, inputArgs, integer, number, probe, run } from './media-process.ts';
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
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    else if (stat.isFile()) hash.update(path.relative(dir, file)).update('\0').update(await fileDigest(file, signal)).update('\0');
    else throw Error('Video sources must be regular files/directories; symlinks cannot define a resumable render');
  }
  for (const name of ['video.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'public']) {
    const file = path.join(dir, name); if (await fs.lstat(file).catch(() => undefined)) await visit(file);
  }
  return hash.digest('hex');
}
export async function reusableSegment(dir: string, part: any, saved: any, fps: number, signal?: AbortSignal) {
  if (!saved || saved.from !== part.from || saved.to !== part.to || !/^[a-f0-9]{64}$/.test(saved.sha256 ?? '')) return false;
  const file = path.join(dir, `part-${String(part.index).padStart(6, '0')}.mkv`);
  try {
    if (await fileDigest(file, signal) !== saved.sha256) return false;
    const info = await probe(file, signal), video = info.streams?.find((s: any) => s.codec_type === 'video');
    return video?.codec_name === 'h264' && Math.abs(Number(info.format?.duration) - part.frames / fps) < 1 / fps + 0.01;
  } catch (error) { if (signal?.aborted) throw error; return false; }
}

type Renderer = (dir: string, request: any, signal: AbortSignal | undefined, progress: (text: string) => void, timeout: number) => Promise<any>;
export async function renderSegments(params: any, dir: string, spec: any, totalFrames: number, request: any, renderer: Renderer, signal?: AbortSignal, progress: (text: string) => void = () => {}) {
  const parts = planSegments(totalFrames, spec.fps, params.segmentSeconds ?? 60, request.range);
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
    let rendered = 0, reused = 0;
    for (const part of parts) {
      signal?.throwIfAborted();
      if (await reusableSegment(cache, part, manifest.parts[part.index], spec.fps, signal)) { reused++; continue; }
      manifest.parts[part.index] = null;
      if (rendered >= maxSegments) continue;
      progress(`Rendering segment ${part.index + 1}/${parts.length} (${part.from}..${part.to})`);
      const staging = path.join(cache, `work-${randomBytes(5).toString('hex')}`); await fs.mkdir(staging);
      try {
        const result = await renderer(dir, { ...request, outDir: staging, mode: 'segment', range: [part.from, part.to], losslessAudio: true }, signal, progress, Math.min(3_600_000, 120_000 + part.frames * 600));
        await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(result.output, 0), '-f', 'null', '-'], signal, 300_000);
        const info = await probe(result.output, signal);
        if (Math.abs(Number(info.format?.duration) - part.frames / spec.fps) > 1 / spec.fps + 0.01) throw Error('Rendered segment has the wrong frame duration');
        const output = path.join(cache, `part-${String(part.index).padStart(6, '0')}.mkv`);
        const sha256 = await fileDigest(result.output, signal);
        await fs.rename(result.output, output);
        manifest.parts[part.index] = { ...part, sha256, seconds: part.frames / spec.fps };
        await checkpoint(manifest); rendered++;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    const completed = parts.filter(p => manifest.parts[p.index]).length;
    await checkpoint(manifest);
    if (completed < parts.length) return { complete: false, mode: 'segments', cache: manifestPath, completedSegments: completed, totalSegments: parts.length, renderedSegments: rendered, reusedSegments: reused,
      next: { ...params, mode: 'segments' }, note: 'Repeat video_render with these parameters. Finished segments persist; source/settings changes choose a new cache. No final video has been delivered yet.' };
    if (await videoFingerprint(dir, settings, signal) !== key) throw Error('Project changed during rendering; retry to create a cache for the new sources');
    const final = path.join(request.outDir, 'final.mp4');
    const list = path.join(cache, `concat-${randomBytes(4).toString('hex')}.txt`);
    await fs.writeFile(list, parts.map(p => `file 'part-${String(p.index).padStart(6, '0')}.mkv'\nduration ${p.frames / spec.fps}`).join('\n') + '\n');
    try {
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-t', String(parts.reduce((sum, p) => sum + p.frames, 0) / spec.fps), '-movflags', '+faststart', '-map_metadata', '-1', final], signal, 600_000);
    } finally { await fs.rm(list, { force: true }); }
    return { complete: true, output: final, cache: manifestPath, completedSegments: completed, totalSegments: parts.length, renderedSegments: rendered, reusedSegments: reused,
      audioSeams: 'PCM across render segments; one final AAC encode', renderMs: null };
  } finally { release(); }
}
