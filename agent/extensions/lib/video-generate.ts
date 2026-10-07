/** OpenRouter asynchronous clips. A durable, content-keyed job is published
 * before the sole paid submission. Uncertain outcomes are retained for recovery,
 * never resubmitted. Poll/download can resume independently of the LLM session. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { planVideoModel } from './media-model-routing.ts';
import { canonicalMutationPath, containsPath, selfMutationDenial } from './self-mutation-guard.ts';
import { acquireCatalogCacheLock } from './catalog-cache-lock.ts';
import { FFMPEG_FLAGS, inputArgs, inputFile, probe, produced, requireStream, run } from './media-process.ts';
import { decodeImage, sniffImage } from './design-studio.ts';

const API = 'https://openrouter.ai/api/v1';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const idValid = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id);
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired']);

async function responseBytes(response: Response, signal: AbortSignal, maxBytes: number) {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error('Video response exceeds its byte budget or has no body'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
      size += part.value.length; if (size > maxBytes) throw Error('Video response exceeds its byte budget'); chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function request(endpoint: string, key: string, signal?: AbortSignal, body?: any) {
  if (!key) throw Error('Video generation requires OpenRouter credentials; choose /models Video or configure OPENROUTER_API_KEY privately');
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  bounded.throwIfAborted();
  const response = await fetch(API + endpoint, { method: body ? 'POST' : 'GET', signal: bounded, redirect: 'error', headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { await response.body?.cancel(); throw Error(`Video API returned HTTP ${response.status}; no paid retry was attempted`); }
  const bytes = await responseBytes(response, bounded, endpoint.endsWith('/content?index=0') ? 128 * 1024 * 1024 : 64 * 1024);
  return endpoint.endsWith('/content?index=0') ? bytes : JSON.parse(bytes.toString('utf8'));
}

async function fileHash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function frameReference(value: unknown, cwd: string, signal?: AbortSignal) {
  const file = await inputFile(value, cwd), stat = await fs.stat(file);
  if (stat.size > 12 * 1024 * 1024) throw Error('A video frame reference must be at most 12 MiB');
  const bytes = await fs.readFile(file), format = sniffImage(bytes);
  if (!['png', 'jpeg', 'webp'].includes(format ?? '')) throw Error('Video frame references must be PNG, JPEG or WebP');
  await decodeImage(bytes, { maxWidth: 512, maxPixels: 512 * 512 }, signal);
  return { url: `data:image/${format};base64,${bytes.toString('base64')}`, sha256: hash(bytes), path: file };
}

async function ownedPath(value: unknown, cwd: string) {
  const root = await fs.realpath(cwd);
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw Error('Use a local job/output path');
  const file = canonicalMutationPath(value, root);
  if (!containsPath(root, file)) throw Error('Video job/output must stay inside the workspace');
  const denial = selfMutationDenial(file, root); if (denial) throw Error(denial);
  return file;
}
async function loadJob(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw Error('Invalid video job receipt');
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  if (job.format !== 'yunuspi-video-job-v1' || job.provider !== 'openrouter' || typeof job.plan?.model !== 'string' || !/^[a-f0-9]{64}$/.test(job.fingerprint ?? '') || !['submitting', 'unknown', 'pending', 'in_progress', ...terminal].includes(job.status) || job.id !== undefined && !idValid(job.id)) throw Error('Invalid video job receipt');
  return job;
}
async function saveJob(file: string, job: any) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
function summary(job: any, file: string, reused = false) {
  return { job: file, id: job.id, provider: job.provider, model: job.plan.model, status: job.status, plan: job.plan, usage: job.usage ?? null, artifact: job.artifact, decodeVerified: job.decodeVerified ?? false, reused, automaticRetries: 0,
    nextPollAfterMs: terminal.has(job.status) ? null : 10_000,
    next: job.status === 'completed' ? 'video_generate action:download with this job; then import its artifact through video_assets and review playback.' : terminal.has(job.status) ? 'Terminal job retained; do not resubmit automatically.' : job.id ? 'Wait at least 10 seconds, then video_generate action:status with this job. Status and download never create a paid generation.' : 'Submission outcome is uncertain. Retain this receipt and inspect provider activity before explicitly requesting a newTake.' };
}

export async function videoGenerate(params: any, cwd: string, signal?: AbortSignal, _progress?: any, runtime: { providerKey?: string; onUsage?: (usage: any, status: string, jobId?: string, model?: string) => void } = {}) {
  const action = params.action ?? 'plan';
  if (!['plan', 'submit', 'status', 'download'].includes(action)) throw Error('action must be plan, submit, status or download');
  if ((params.mediaProvider === 'local' || params.model === 'native') && ['plan', 'submit'].includes(action)) return { provider: 'local', model: 'native', generationCostUsd: 0, next: 'Use video_project compose, video_shot and video_browser for native motion graphics. Select a clip model in /models Video or pass model:openrouter/<id> for video_generate.' };
  const key = process.env.PI_VIDEO_API_KEY || process.env.OPENROUTER_API_KEY || runtime.providerKey || '';
  if (action === 'plan' || action === 'submit') {
    if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > 4000) throw Error('Video generation needs a prompt of 1..4000 characters');
    if (params.seed !== undefined && (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > 4294967295)) throw Error('seed must be an integer 0..4294967295');
    const plan = await planVideoModel(params, signal);
    if (action === 'plan') return { ...plan, configured: Boolean(key), paid: false, next: 'submit uses this model/capability preflight and a single paid request; short clips become assets on the native master timeline.' };
    if (!key) throw Error('OpenRouter video credentials are not configured');
    const first = params.firstFrame ? await frameReference(params.firstFrame, cwd, signal) : undefined;
    const last = params.lastFrame ? await frameReference(params.lastFrame, cwd, signal) : undefined;
    const signature = { model: plan.model, prompt: params.prompt.trim(), duration: plan.seconds, resolution: plan.resolution, aspect_ratio: plan.aspectRatio, generate_audio: plan.generateAudio, ...(params.seed === undefined ? {} : { seed: params.seed }), frames: [first?.sha256 ?? null, last?.sha256 ?? null] };
    const fingerprint = hash(JSON.stringify(signature));
    const parent = await ownedPath(params.outputDir ?? '.pi/media-generation', cwd);
    const dir = await ownedPath(path.join(parent, `video-${fingerprint.slice(0, 24)}${params.newTake === true ? '-' + randomUUID() : ''}`), cwd);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'job.json'), release = await acquireCatalogCacheLock(file, signal);
    try {
      const existing = await loadJob(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (existing) return summary(existing, file, true);
      const job: any = { format: 'yunuspi-video-job-v1', provider: 'openrouter', fingerprint, signature, plan, status: 'submitting', createdAt: new Date().toISOString() };
      await saveJob(file, job); // durable before the paid boundary
      const { frames, ...body } = signature;
      const frame_images = [...(first ? [{ type: 'image_url', image_url: { url: first.url }, frame_type: 'first_frame' }] : []), ...(last ? [{ type: 'image_url', image_url: { url: last.url }, frame_type: 'last_frame' }] : [])];
      try {
        runtime.onUsage?.(undefined, 'pending', fingerprint, plan.model);
        const result = await request('/videos', key, signal, { ...body, ...(frame_images.length ? { frame_images } : {}) });
        if (!idValid(result.id) || !['pending', 'in_progress', ...terminal].includes(result.status)) throw Error('Video submission returned an invalid job identity/status');
        Object.assign(job, { id: result.id, status: result.status, usage: result.usage ?? null });
        await saveJob(file, job);
        if (terminal.has(job.status)) runtime.onUsage?.(job.usage, job.status, fingerprint, plan.model);
        return summary(job, file);
      } catch (error: any) {
        job.status = 'unknown'; await saveJob(file, job);
        runtime.onUsage?.(undefined, signal?.aborted ? 'cancelled' : 'failed', fingerprint, plan.model);
        throw Error(`Video submission did not yield a confirmed job. Receipt retained at ${file}; inspect provider activity before a new paid take. ${String(error.message).slice(0, 200)}`);
      }
    } finally { release(); }
  }
  const file = await ownedPath(params.job, cwd), release = await acquireCatalogCacheLock(file, signal);
  try {
    const job = await loadJob(file);
    if (!job.id) return summary(job, file, true);
    if (!terminal.has(job.status) && (!job.checkedAt || Date.now() - job.checkedAt >= 10_000)) {
      const result = await request(`/videos/${job.id}`, key, signal);
      if (result.id !== job.id || !['pending', 'in_progress', ...terminal].includes(result.status)) throw Error('Video status returned an invalid identity/status');
      Object.assign(job, { status: result.status, checkedAt: Date.now(), usage: result.usage ?? null });
      await saveJob(file, job);
      if (terminal.has(job.status)) runtime.onUsage?.(job.usage, job.status, job.fingerprint, job.plan.model);
    }
    if (action !== 'download' || job.status !== 'completed') return summary(job, file);
    const output = path.join(path.dirname(file), 'generated.mp4');
    const cachedFile = await fs.lstat(output).catch(() => undefined);
    if (job.decodeVerified && cachedFile?.isFile() && !cachedFile.isSymbolicLink() && typeof job.sha256 === 'string' && await fileHash(output).then(value => value === job.sha256, () => false)) {
      job.artifact = await produced(output);
      return summary(job, file, true);
    }
    const temp = path.join(path.dirname(file), `download-${randomUUID()}.mp4`);
    try {
      const bytes = await request(`/videos/${job.id}/content?index=0`, key, signal);
      await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      const info = await probe(temp, signal), stream = requireStream(info, 'video');
      const seconds = Number(info.format?.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) throw Error('Generated clip has no measured positive duration');
      await run('ffmpeg', [...FFMPEG_FLAGS, '-v', 'error', '-xerror', ...inputArgs(temp, 0), '-f', 'null', '-'], signal);
      await fs.rename(temp, output);
      Object.assign(job, { sha256: hash(bytes), seconds, width: stream.width, height: stream.height, artifact: await produced(output), decodeVerified: true });
      await saveJob(file, job); return summary(job, file);
    } finally { await fs.rm(temp, { force: true }); }
  } finally { release(); }
}
