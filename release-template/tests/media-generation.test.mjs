import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { videoGenerate } from '../agent/extensions/lib/video-generate.ts';
import { planImageModel, planVideoModel } from '../agent/extensions/lib/media-model-routing.ts';
import { imageGenerateRun } from '../agent/extensions/lib/image-generate.ts';

const imageModel = { id: 'test/image-flash', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1'] }, input_references: { type: 'range', min: 0, max: 2 } } };
const videoModel = { id: 'test/video', supported_durations: [4], supported_resolutions: ['720p'], supported_aspect_ratios: ['16:9'], supported_frame_images: ['first_frame'], pricing_skus: { cents_per_video_output_second_720p: '3', cents_per_image_input: '1' } };
const catalog = url => url.endsWith('/images/models') ? { data: [imageModel] } : url.includes('/images/models/') ? { endpoints: [{ provider_tag: 'test', supported_parameters: imageModel.supported_parameters, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .02 }] }] } : url.endsWith('/videos/models') ? { data: [videoModel] } : null;
async function workspace(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-generation-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function mock(t, handler) { const previous = globalThis.fetch; globalThis.fetch = handler; t.after(() => { globalThis.fetch = previous; }); }

test('automatic image preflight sends one correctly routed native request and retains cost/model', async t => {
  const dir = await workspace(t), png = path.join(dir, 'pixel.png');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=red:s=32x32','-frames:v','1','-threads','1',png]);
  const bytes = await fs.readFile(png), posts = [];
  mock(t, async (url, options) => {
    const listing = catalog(url); if (listing) return Response.json(listing);
    posts.push([url, JSON.parse(options.body)]);
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { cost: .02 } });
  });
  await assert.rejects(planImageModel({ model: 'auto', transparent: true }), /No compatible/);
  const result = await imageGenerateRun({ model: 'auto', prompt: 'A red tile', maxCostUsd: .03 }, dir, undefined, undefined, { PI_IMAGE_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'test-key' });
  assert.equal(posts.length, 1); assert.equal(posts[0][0], 'https://openrouter.ai/api/v1/images');
  assert.equal(posts[0][1].model, imageModel.id); assert.deepEqual(posts[0][1].provider, { only: ['test'], allow_fallbacks: false });
  assert.equal(result.model, imageModel.id); assert.equal(result.usage.cost.total, .02); assert.equal(result.decodeVerified, true);
});

test('video submit reuses a durable job, polling stays bounded, download verifies and reuses content', async t => {
  const dir = await workspace(t), clip = path.join(dir, 'fixture.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=64x36:r=6','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',clip]);
  const bytes = await fs.readFile(clip); let posts = 0, polls = 0, downloads = 0;
  mock(t, async (url, options) => {
    const listing = catalog(url); if (listing) return Response.json(listing);
    assert.equal(options.redirect, 'error'); assert.ok(url.startsWith('https://openrouter.ai/api/v1/videos'));
    if (options.method === 'POST') { posts++; const body = JSON.parse(options.body); assert.equal(body.generate_audio, false); return Response.json({ id: 'job-1', status: 'pending', polling_url: 'https://untrusted.invalid' }, { status: 202 }); }
    if (url.endsWith('/content?index=0')) { downloads++; return new Response(bytes); }
    polls++; return Response.json({ id: 'job-1', status: 'completed', usage: { cost: .12 }, unsigned_urls: ['https://untrusted.invalid'] });
  });
  const runtime = { providerKey: 'test-key' }, params = { action: 'submit', prompt: 'A slow product reveal', model: 'auto', maxCostUsd: .2 };
  await assert.rejects(planVideoModel({ ...params, maxCostUsd: .01 }), /No compatible/);
  const first = await videoGenerate(params, dir, undefined, undefined, runtime);
  assert.equal(first.status, 'pending'); assert.ok((await fs.stat(first.job)).isFile());
  const duplicate = await videoGenerate(params, dir, undefined, undefined, runtime);
  assert.equal(duplicate.job, first.job); assert.equal(duplicate.reused, true); assert.equal(posts, 1);
  const finished = await videoGenerate({ action: 'download', job: first.job }, dir, undefined, undefined, runtime);
  assert.equal(finished.status, 'completed'); assert.equal(finished.decodeVerified, true); assert.equal(finished.usage.cost, .12);
  const reused = await videoGenerate({ action: 'download', job: first.job }, dir, undefined, undefined, runtime);
  assert.equal(reused.reused, true); assert.equal(downloads, 1); assert.equal(polls, 1); assert.equal(posts, 1);
  assert.ok(!JSON.stringify(await fs.readFile(first.job, 'utf8')).includes('test-key'));
  await assert.rejects(videoGenerate({ action: 'status', job: path.join(os.tmpdir(), 'other.json') }, dir, undefined, undefined, runtime), /inside the workspace/);
});

test('uncertain submission is retained and identical retries never create another paid request', async t => {
  const dir = await workspace(t); let posts = 0;
  mock(t, async (url, options) => { const listing = catalog(url); if (listing) return Response.json(listing); posts++; return new Response('unavailable', { status: 500 }); });
  const params = { action: 'submit', prompt: 'A different reveal', model: 'test/video' }, runtime = { providerKey: 'test-key' };
  await assert.rejects(videoGenerate(params, dir, undefined, undefined, runtime), /Receipt retained/);
  const result = await videoGenerate(params, dir, undefined, undefined, runtime);
  assert.equal(result.status, 'unknown'); assert.equal(result.reused, true); assert.equal(posts, 1);
  const stop = new AbortController(); stop.abort();
  await assert.rejects(videoGenerate(params, dir, stop.signal, undefined, runtime), /abort/i);
  assert.equal(posts, 1);
});
