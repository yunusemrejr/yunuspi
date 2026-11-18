import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planImageModel } from '../agent/extensions/lib/media-model-routing.ts';
import { imageEditRun, imageGenerateRun } from '../agent/extensions/lib/image-generate.ts';

const imageModel = { id: 'test/image-flash', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1'] }, input_references: { type: 'range', min: 0, max: 2 } } };
const catalog = url => url.endsWith('/images/models') ? { data: [imageModel] } : url.includes('/images/models/') ? { endpoints: [{ provider_tag: 'test', supported_parameters: imageModel.supported_parameters, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .02 }] }] } : null;
async function workspace(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-generation-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function mock(t, handler) { const previous = globalThis.fetch; globalThis.fetch = handler; t.after(() => { globalThis.fetch = previous; }); }

test('automatic image preflight sends one correctly routed native request and retains cost/model', async t => {
  const dir = await workspace(t), png = path.join(dir, 'pixel.png');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=red:s=32x32','-frames:v','1','-threads','1',png]);
  const bytes = await fs.readFile(png), posts = [];
  mock(t, async (url, options) => {
    const listing = catalog(url); if (listing) return Response.json(listing);
    posts.push([url, JSON.parse(options.body), options.redirect]);
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { cost: .02, is_byok: true, cost_details: { upstream_inference_cost: .04 } } });
  });
  await assert.rejects(planImageModel({ model: 'auto', transparent: true }), /No compatible/);
  const result = await imageGenerateRun({ model: 'auto', prompt: 'A red tile', maxCostUsd: .03 }, dir, undefined, undefined, { PI_IMAGE_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'test-key' });
  assert.equal(posts.length, 1); assert.equal(posts[0][0], 'https://openrouter.ai/api/v1/images');
  assert.equal(posts[0][1].model, imageModel.id); assert.deepEqual(posts[0][1].provider, { only: ['test'], allow_fallbacks: false });
  assert.equal(posts[0][2], 'error');
  assert.equal(result.model, imageModel.id); assert.equal(result.usage.cost.total, .02); assert.equal(result.decodeVerified, true);
  assert.deepEqual(result.usage.cost, { total: .02, source: 'provider-reported', complete: false, byok: true });
});

test('a cap preserves the configured model and only authorizes the quoted native route', async t => {
  const dir = await workspace(t);
  const env = { PI_IMAGE_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'test-key', PI_IMAGE_MODEL: 'test/selected' };
  const requests = [];
  mock(t, async (url, options) => {
    requests.push(options.method ?? 'GET');
    const listing = catalog(url);
    if (listing) return Response.json(listing);
    throw Error('Unexpected generation request');
  });
  const capped = { prompt: 'A red tile', maxCostUsd: .03 };
  for (const run of [imageGenerateRun, imageEditRun]) {
    await assert.rejects(run(capped, dir, undefined, undefined, env), /No compatible/);
    assert.ok(!requests.includes('POST'));
    requests.length = 0;
    for (const config of [{ PI_IMAGE_BACKEND: 'off' }, { PI_IMAGE_API_URL: 'https://gateway.invalid/v1' }]) {
      await assert.rejects(run({ ...capped, model: 'auto' }, dir, undefined, undefined, { ...env, ...config }), /backend|OpenRouter/);
      assert.deepEqual(requests, []);
    }
    await assert.rejects(run({ ...capped, model: 'auto', transport: 'chat' }, dir, undefined, undefined, env), /transport/);
    assert.deepEqual(requests, []);
  }
});
