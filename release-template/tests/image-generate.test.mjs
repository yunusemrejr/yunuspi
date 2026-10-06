// Image generation boundary: backend resolution, brief building and
// request shaping. No live provider calls; backends stay configured.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSameBytes } from "./bytes.mjs";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/image-generate.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const images = await load("extensions/lib/image-generate.ts");

test("resolveImageBackend reports honest unconfigured states", () => {
  const none = images.resolveImageBackend({});
  assert.equal(none.configured, false);
  assert.equal(none.name, "none");
  assert.match(none.setup, /PI_IMAGE_MODEL/);
  assert.match(images.resolveImageBackend({ PI_IMAGE_BACKEND: "midjourney" }).reason, /Unknown PI_IMAGE_BACKEND/);
  assert.match(
    images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_API_URL: "http://example.com/v1" }).reason,
    /must be https/,
  );
  const noModel = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_API_KEY: "test-key-1" });
  assert.equal(noModel.configured, false);
  assert.match(noModel.reason, /PI_IMAGE_MODEL is required/);
  const noKey = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m" });
  assert.match(noKey.reason, /No API key/);
  const ok = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m", PI_IMAGE_API_KEY: "test-key-1" });
  assert.deepEqual(ok, { configured: true, name: "openai-compatible", apiUrl: "https://api.openai.com/v1", model: "m", keySource: "PI_IMAGE_API_KEY" });
  const fallback = images.resolveImageBackend({ PI_IMAGE_BACKEND: "openai-compatible", PI_IMAGE_MODEL: "m", OPENAI_API_KEY: "test-key-2" });
  assert.equal(fallback.keySource, "OPENAI_API_KEY");
  assert.ok(!JSON.stringify(ok).includes("test-key-1"), "status never echoes key material");
});

test("validateApiUrl allows https and loopback gateways only", () => {
  assert.equal(images.validateApiUrl("https://api.openai.com/v1"), undefined);
  assert.equal(images.validateApiUrl("http://localhost:8080/v1"), undefined);
  assert.equal(images.validateApiUrl("http://127.0.0.1:8080/v1"), undefined);
  assert.equal(images.validateApiUrl("http://[::1]:8080/v1"), undefined);
  assert.match(images.validateApiUrl("http://example.com/v1"), /must be https/);
  assert.match(images.validateApiUrl(["https://user", "pass@example.com/v1"].join(":")), /must not embed credentials/);
  assert.match(images.validateApiUrl("not a url"), /not a URL/);
});

test("buildGenerationBrief merges direction and role constraints", () => {
  const creative = { intent: ["editorial"], hierarchy: { primary: "content" }, avoid: ["neon glow", "glass cards"], motion: {}, audio: {}, visual: {}, references: [] };
  const brief = images.buildGenerationBrief(creative, { prompt: "  misty ridge at dawn ", role: "hero-focal", negative: ["text"], aspect: "landscape" });
  assert.equal(brief.role, "hero-focal");
  assert.equal(brief.prompt, "misty ridge at dawn");
  assert.deepEqual(brief.negative, ["text", "neon glow", "glass cards"]);
  assert.equal(brief.size, "1536x1024");
  assert.ok(brief.constraints.some((c) => /crop/.test(c)), "hero-focal crop survival");
  assert.match(brief.direction, /editorial/);
  assert.equal(images.buildGenerationBrief(undefined, { prompt: "x", role: "nope", size: "2048x2048" }).role, "generic");
  assert.equal(images.buildGenerationBrief(undefined, { prompt: "x", size: "2048x2048" }).size, "2048x2048");
  assert.throws(() => images.buildGenerationBrief(undefined, { prompt: "  " }), /needs a prompt/);
});

test("buildImageRequest shapes the OpenAI-compatible body", () => {
  const brief = { role: "background", prompt: "soft grain", negative: ["focal point"], constraints: [], size: "1024x1024", direction: null };
  const body = images.buildImageRequest(brief, { model: "m", seed: 7, transparent: true, quality: "high" });
  assert.equal(body.model, "m");
  assert.match(body.prompt, /soft grain/);
  assert.match(body.prompt, /Avoid: focal point/);
  assert.equal(body.response_format, "b64_json");
  assert.equal(body.seed, 7);
  assert.equal(body.background, "transparent");
  assert.equal(body.quality, "high");
});

const fixtureEnv = { PI_IMAGE_BACKEND: 'openai-compatible', PI_IMAGE_API_URL: 'https://fixture.invalid/v1', PI_IMAGE_API_KEY: 'TEST_image_fixture_only', PI_IMAGE_MODEL: 'fixture/image' };
const workspace = t => { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generation-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); return cwd; };
async function picture(format = 'png') {
  const { encodeImage } = await load('extensions/lib/design-studio.ts');
  return encodeImage({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) }, format);
}

test('generated artifacts require decoded pixels and failed publication removes the fresh output folder', async t => {
  const cwd = workspace(t), oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, cwd, undefined, undefined, fixtureEnv), /picture|ffprobe|ffmpeg/);
  assert.equal(fs.existsSync(path.join(cwd, '.pi/assets/registry.json')), false);
  bytes = await picture();
  const result = await images.imageGenerateRun({ prompt: 'Synthetic plate' }, cwd, undefined, undefined, fixtureEnv);
  assert.equal(result.decodeVerified, true); assert.equal(result.asset.width, 8); assert.equal(result.asset.height, 8);
  assertSameBytes(fs.readFileSync(path.join(cwd, result.file)), bytes);
  assert.doesNotMatch(fs.readFileSync(path.join(cwd, result.dir, 'receipt.json'), 'utf8'), /TEST_image_fixture_only/);
  const broken = workspace(t);
  fs.mkdirSync(path.join(broken, '.pi/assets/registry.json'), { recursive: true });
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, broken, undefined, undefined, fixtureEnv));
  assert.deepEqual(fs.readdirSync(path.join(broken, '.pi/assets')).filter(name => name.startsWith('gen-')), []);
});

test('image response bounds and cancellation apply while reading the body before artifacts exist', async t => {
  const cwd = workspace(t), oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(57 * 1024 * 1024) } });
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, cwd, undefined, undefined, fixtureEnv), /56 MiB bound/);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({ start() { setImmediate(() => controller.abort()); } }));
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, cwd, controller.signal, undefined, fixtureEnv), /abort/i);
  assert.equal(fs.existsSync(path.join(cwd, '.pi')), false);
});

test('OpenRouter uses the native image route, preserves usage and sends edits as image references', async t => {
  const cwd = workspace(t), bytes = await picture(), oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const env = { PI_IMAGE_BACKEND: 'openrouter', PI_IMAGE_MODEL: 'fixture/image' };
  assert.equal(images.resolveImageBackend(env).configured, false);
  assert.equal(images.resolveImageBackend(env, true).keySource, 'session provider');
  assert.equal(images.resolveImageBackend({ ...env, OPENROUTER_API_KEY: 'TEST_image_fixture_only' }).keySource, 'OPENROUTER_API_KEY');
  assert.equal(images.imageBackendEnvironment({ OPENROUTER_API_KEY: 'TEST_image_fixture_only' }, false, 'fixture/selected').PI_IMAGE_BACKEND, 'openrouter');
  assert.equal(images.imageBackendEnvironment({ ...fixtureEnv, OPENROUTER_API_KEY: 'TEST_image_fixture_only' }, true, 'fixture/selected').PI_IMAGE_MODEL, 'fixture/selected');
  assert.equal(images.resolveImageBackend({ PI_IMAGE_BACKEND: 'off', OPENROUTER_API_KEY: 'TEST_image_fixture_only' }).configured, false);
  const requests = [], usage = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ id: 'fixture', choices: [{ message: { content: '', images: [{ image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: .01 } });
  };
  const runtime = { providerKey: 'TEST_image_fixture_only', onUsage: value => { if (value) usage.push(value); } };
  const generated = await images.imageGenerateRun({ prompt: 'Synthetic plate', seed: 4, quality: 'high' }, cwd, undefined, undefined, env, runtime);
  assert.equal(generated.decodeVerified, true);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].body.model, 'fixture/image');
  assert.deepEqual(requests[0].body.modalities, ['image']);
  assert.deepEqual(requests[0].body.image_config, { size: '1024x1024', quality: 'high' });
  assert.equal(requests[0].body.seed, 4); assert.equal(usage[0].cost.total, .01);
  await images.imageEditRun({ prompt: 'Synthetic edit', path: generated.file }, cwd, undefined, undefined, env, runtime);
  assert.equal(requests[1].body.messages[0].content[1].type, 'image_url');
  await assert.rejects(images.imageEditRun({ prompt: 'Synthetic edit', path: generated.file, mask: generated.file }, cwd, undefined, undefined, env, runtime), /Masked edits require/);
  assert.equal(requests.length, 2, 'unsupported masks never trigger a billable request');
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'No image available' } }] });
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, cwd, undefined, undefined, env, runtime), /returned no image/);
});

test('creative image tool serves the decoded file MIME and records native provider usage', async t => {
  const cwd = workspace(t), bytes = await picture('jpg'), oldFetch = globalThis.fetch;
  const keys = ['PI_IMAGE_BACKEND', 'PI_IMAGE_API_URL', 'PI_IMAGE_API_KEY', 'PI_IMAGE_MODEL', 'OPENROUTER_API_KEY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { globalThis.fetch = oldFetch; for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]; });
  for (const key of keys) delete process.env[key];
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '', images: [{ image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: .01 } });
  const tools = [], receipts = [];
  (await load('extensions/art-direction.ts')).default({ registerTool(tool) { tools.push(tool); }, appendEntry(type, data) { receipts.push({ type, data }); } });
  const ctx = { cwd, model: { input: ['text', 'image'] }, sessionManager: { getSessionId: () => 'image-fixture' }, modelRegistry: { getApiKeyForProvider: async () => 'TEST_image_fixture_only' } };
  const { loadExtensions } = await import('../core/coding-agent/dist/core/extensions/loader.js');
  const loaded = await loadExtensions([path.join(agent, 'extensions/art-direction.ts')], cwd);
  assert.deepEqual(loaded.errors, []);
  const status = await loaded.extensions[0].tools.get('image_generate').definition.execute('status', { action: 'status' }, undefined, undefined, ctx);
  assert.equal(status.details.name, 'openrouter');
  assert.ok(status.details.availableModels.length > 0, 'existing catalog is available without backend/model environment configuration');
  const result = await tools.find(tool => tool.name === 'image_generate').execute('fixture', { action: 'generate', model: 'fixture/image', prompt: 'Synthetic plate' }, undefined, undefined, ctx);
  assert.equal(result.content.find(part => part.type === 'image').mimeType, 'image/jpeg');
  assert.equal(receipts[0].type, 'auxiliary-model-usage-v1');
  assert.equal(receipts[0].data.owner, 'image-generate');
  assert.equal(receipts[0].data.status, 'pending');
  assert.equal(receipts[1].data.id, receipts[0].data.id);
  assert.equal(receipts[1].data.usage.cost.total, .01);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(receipts), /TEST_image_fixture_only/);
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({ start() { setImmediate(() => controller.abort()); } }), { headers: { 'content-type': 'application/json' } });
  const tool = tools.find(tool => tool.name === 'image_generate');
  await assert.rejects(tool.execute('cancelled', { action: 'generate', model: 'fixture/image', prompt: 'Synthetic plate' }, controller.signal, undefined, ctx), /abort/i);
  assert.deepEqual(receipts.slice(-2).map(row => row.data.status), ['pending', 'cancelled']);
  assert.equal(receipts.at(-1).data.id, receipts.at(-2).data.id);
  assert.equal(Object.hasOwn(receipts.at(-1).data, 'usage'), false, 'cancelled provider request retains unknown usage rather than a fabricated zero');
});
