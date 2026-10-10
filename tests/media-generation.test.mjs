import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planImageModel } from '../agent/extensions/lib/media-model-routing.ts';
import { imageGenerateRun } from '../agent/extensions/lib/image-generate.ts';

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
    posts.push([url, JSON.parse(options.body)]);
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { cost: .02 } });
  });
  await assert.rejects(planImageModel({ model: 'auto', transparent: true }), /No compatible/);
  const result = await imageGenerateRun({ model: 'auto', prompt: 'A red tile', maxCostUsd: .03 }, dir, undefined, undefined, { PI_IMAGE_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'test-key' });
  assert.equal(posts.length, 1); assert.equal(posts[0][0], 'https://openrouter.ai/api/v1/images');
  assert.equal(posts[0][1].model, imageModel.id); assert.deepEqual(posts[0][1].provider, { only: ['test'], allow_fallbacks: false });
  assert.equal(result.model, imageModel.id); assert.equal(result.usage.cost.total, .02); assert.equal(result.decodeVerified, true);
});
