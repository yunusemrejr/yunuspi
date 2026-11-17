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

for (const [action, reported] of [['fork',.01], ['switch',.01], ['switch',undefined], ['stop',.01]]) {
  test(`${reported === undefined ? 'an unpriced' : 'a paid'} image request retains its source receipt after ${action}`, {timeout:15_000}, async t => {
    const { AgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } =
      await import('../core/coding-agent/src/index.js');
    const { collectSessionCost } = await import('../core/coding-agent/src/core/session-accounting.js');
    const { default: registerArtDirection } = await load('extensions/art-direction.ts');
    const cwd = workspace(t), bytes = await picture();
    const config = {PI_IMAGE_BACKEND:'openrouter', PI_IMAGE_API_URL:'https://openrouter.ai/api/v1', PI_IMAGE_API_KEY:'TEST_image_owner_fixture'};
    const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
    Object.assign(process.env, config);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const submitted = Promise.withResolvers(), response = Promise.withResolvers();
    const outbound = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer TEST_image_owner_fixture');
      submitted.resolve();
      return response.promise;
    });
    const model = {id:'fixture', name:'Fixture', api:'openai-completions', provider:'audit', baseUrl:'https://fixture.invalid',
      input:['text'], reasoning:false, contextWindow:8192, maxTokens:2048, cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const modelRuntime = {getModel:()=>model, getAvailable:()=>[model], hasConfiguredAuth:()=>true, isUsingSubscription:()=>false,
      streamSimple(){ assert.fail('the fixture makes no model request'); }};
    async function create(sessionManager) {
      let context;
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({cwd, agentDir:cwd, settingsManager, noExtensions:true, noSkills:true,
        noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[pi => {
          registerArtDirection(pi);
          pi.on('session_start', (_event, ctx) => { context = ctx; });
        }]});
      await resourceLoader.reload();
      const runtime = await createAgentSession({cwd, agentDir:cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager, tools:[]});
      await runtime.session.bindExtensions({mode:'print'});
      return {...runtime, context, services:{cwd, agentDir:cwd}};
    }
    function sessionFile() {
      const manager = SessionManager.create(cwd, cwd);
      manager.appendMessage({role:'user', content:'Generate a synthetic image.', timestamp:1});
      manager.flush();
      return manager;
    }
    const manager = sessionFile(), original = await create(manager);
    const sourceFile = manager.getSessionFile(), sourceLeaf = manager.getLeafId();
    const host = new AgentSessionRuntime(original.session, original.services, ({sessionManager}) => create(sessionManager));
    t.after(() => host.dispose());
    const stop = new AbortController();
    if (action === 'stop') original.session.subscribe(event => {
      if (event.type === 'entry_appended' && event.entry.data?.status === 'completed') {
        stop.abort(new DOMException('Fixture stop after image receipt', 'AbortError'));
      }
    });
    const tool = original.session.extensionRunner.getToolDefinition('image_generate');
    assert.ok(tool);
    const invoke = tool.execute('image-fixture', {action:'generate', model:'fixture/image', prompt:'Synthetic plate.'},
      stop.signal, undefined, original.context).then(result => ({result}), error => ({error}));
    const readSource = () => SessionManager.open(sourceFile, cwd).getEntries();
    const targetEvents = [];
    let pendingTarget;
    try {
      await Promise.race([submitted.promise, invoke.then(outcome => assert.fail(outcome.error ?? 'tool ended before dispatch'))]);
      assert.equal(collectSessionCost(readSource()).pending, 1);
      if (action === 'fork') assert.equal((await host.fork(manager.getLeafId(), {position:'at'})).cancelled, false);
      if (action === 'switch') assert.equal((await host.switchSession(sessionFile().getSessionFile())).cancelled, false);
      if (action !== 'stop') {
        host.session.subscribe(event => targetEvents.push(event.type));
        pendingTarget = collectSessionCost(host.session.sessionManager.getEntries()).pending;
      }
    } finally {
      response.resolve(Response.json({id:'fixture', choices:[{message:{content:'',
        images:[{image_url:{url:`data:image/png;base64,${bytes.toString('base64')}`}}]}}],
      ...(reported === undefined ? {} : {usage:{prompt_tokens:10, completion_tokens:2, cost:reported}})}));
      await invoke;
    }
    const entries = readSource(), source = collectSessionCost(entries);
    const receipts = entries.filter(entry => entry.customType === 'auxiliary-model-usage-v1');
    const target = collectSessionCost(host.session.sessionManager.getEntries());
    assert.equal(outbound.mock.callCount(), 1);
    assert.deepEqual({reported:source.reported, pending:source.pending, unknown:source.unknown, pendingTarget},
      {reported:reported ?? 0, pending:0, unknown:reported === undefined, pendingTarget:action === 'stop' ? undefined : 0});
    assert.deepEqual(receipts.map(entry => [entry.parentId, entry.accountingOnly, entry.data.status]),
      [[sourceLeaf,true,'pending'], [sourceLeaf,true,'completed']]);
    assert.equal(receipts[0].data.id, receipts[1].data.id);
    assert.equal(collectSessionCost([...entries,...entries]).reported, reported ?? 0);
    if (action === 'stop') assert.match((await invoke).error?.message ?? '', /Fixture stop after image receipt/);
    else {
      assert.equal(target.total, 0);
      assert.equal(target.pending, 0);
      assert.ok(!targetEvents.includes('entry_appended'));
    }
  });
}

test('generated artifacts require decoded pixels and a failed registry preserves generated pixels for recovery', async t => {
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
  let generatedCalls = 0;
  globalThis.fetch = async () => { generatedCalls++; return Response.json({ data: [{ b64_json: bytes.toString('base64') }] }); };
  await assert.rejects(images.imageGenerateRun({ prompt: 'Synthetic plate' }, broken, undefined, undefined, fixtureEnv), /Decoded image retained/);
  const retained = fs.readdirSync(path.join(broken, '.pi/assets')).filter(name => name.startsWith('gen-'));
  assert.equal(retained.length, 1); assert.equal(generatedCalls, 1);
  const recovery = JSON.parse(fs.readFileSync(path.join(broken, '.pi/assets', retained[0], 'recovery.json')));
  assert.equal(recovery.registration, 'unverified'); assert.equal(recovery.decodeVerified, true);
  assertSameBytes(fs.readFileSync(path.join(broken, recovery.file)), bytes);
  assert.match(recovery.next, /do not repeat generation/);
  assert.doesNotMatch(JSON.stringify(recovery), /TEST_image_fixture_only/);
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

test('registered Images tool prices attested OpenAI raster buckets and preserves partial evidence', async t => {
  const cwd = workspace(t), pixels = await picture();
  fs.writeFileSync(path.join(cwd, 'reference.png'), pixels);
  const prepare = await imageBillingFixture(t, cwd, pixels);
  const usage = {input_tokens:100, output_tokens:1000, total_tokens:1100,
    input_tokens_details:{text_tokens:100, image_tokens:0}, output_tokens_details:{image_tokens:1000, text_tokens:0}};
  const priced = await prepare({usage});
  assert.equal(priced.formatted, '$~0.030500');
  assert.equal(priced.receipt.usage.cost.priceBasis, 'openai-images-standard-token-rates');
  assert.deepEqual(priced.receipt.usage.cost.imageTokenCounts, {inputText:100, inputImage:0, outputText:0, outputImage:1000});
  const older = await prepare({model:'gpt-image-2.5-flare', usage});
  assert.equal(older.formatted, '$~0.030500');
  const edit = await prepare({edit:true, usage:{...usage, input_tokens:300, total_tokens:1300, input_tokens_details:{text_tokens:100, image_tokens:200}}});
  assert.equal(edit.formatted, '$~0.032100');

  const cached = await prepare({usage:{...usage, input_tokens_details:{...usage.input_tokens_details, cached_tokens:20}}});
  assert.equal(cached.formatted, '$~0.030000+?');
  assert.equal(cached.receipt.usage.cacheRead, 20);
  const mixed = await prepare({usage:{...usage, input_tokens_details:undefined, output_tokens_details:{image_tokens:900, text_tokens:100}}});
  assert.equal(mixed.formatted, '$~0.027000+?');
  const unsupported = await prepare({model:'unknown-image-model', usage});
  assert.equal(unsupported.formatted, '$?');
});

test('registered Images tool accepts reported OpenRouter USD only with direct native route evidence', async t => {
  const cwd = workspace(t), pixels = await picture();
  const prepare = await imageBillingFixture(t, cwd, pixels);
  const core = {input_tokens:100, output_tokens:1000};
  const foreignCurrency = await prepare({origin:'https://gateway.example.invalid', usage:{...core,
    cost:{total:.125, currency:'EUR', source:'provider-reported', complete:true}}});
  assert.equal(foreignCurrency.formatted, '$?');
  assert.equal(foreignCurrency.receipt.usage.input, 100);
  const gatewayNumber = await prepare({origin:'https://openrouter.example.invalid', backend:'openrouter', usage:{...core, cost:.5}});
  assert.equal(gatewayNumber.formatted, '$?');
  const directOpenRouter = {origin:'https://openrouter.ai', backend:'openrouter'};
  const zero = await prepare({...directOpenRouter, usage:{...core, cost:0}});
  assert.equal(zero.formatted, '$0.000');
  const byok = await prepare({...directOpenRouter, usage:{...core, cost:.125, is_byok:true, cost_details:{upstream_inference_cost:.25}}});
  assert.equal(byok.formatted, '$0.125000+?');
  const regional = await prepare({...directOpenRouter, origin:'https://us.openrouter.ai', usage:{...core, cost:.125},
    responseUrl:'https://us.openrouter.ai/api/v1/images'});
  assert.equal(regional.formatted, '$0.125000');
  const redirect = await prepare({...directOpenRouter, usage:{...core, cost:.5}, responseUrl:'https://gateway.example.invalid/api/v1/images'});
  assert.equal(redirect.formatted, '$?');
  const conflicting = await prepare({...directOpenRouter, usage:{...core, cost:.5, currency:'EUR'}});
  assert.equal(conflicting.formatted, '$?');
});

test('registered chat Images tool retains HTTP authority through bounded response reading', async t => {
  const cwd = workspace(t), pixels = await picture();
  const prepare = await imageBillingFixture(t, cwd, pixels);
  const usage = {prompt_tokens:100, completion_tokens:1000, is_byok:true, cost_details:{upstream_inference_cost:.02}};
  const origin = 'https://eu.openrouter.ai', responseUrl = origin+'/api/v1/chat/completions';
  const route = {origin, responseUrl, backend:'openrouter', transport:'chat', model:'fixture/image', usage};
  assert.equal((await prepare(route)).formatted, '$0.020000+?');
  assert.equal((await prepare({...route, usage:{...usage, cost:0}})).formatted, '$0.020000');
  const direct = { ...route, origin:'https://openrouter.ai', responseUrl:'https://openrouter.ai/api/v1/chat/completions',
    usage:{...usage, cost:.4} };
  assert.equal((await prepare({...direct, redirected:true})).formatted, '$?');
  assert.equal((await prepare({...direct, responseUrl:'https://gateway.invalid/api/v1/chat/completions'})).formatted, '$?');
});

async function imageBillingFixture(t, cwd, pixels) {
  const { collectSessionCost } = await import('../core/coding-agent/src/core/session-accounting.js');
  const artDirection = (await load('extensions/art-direction.ts')).default;
  const keys = ['PI_IMAGE_BACKEND', 'PI_IMAGE_API_URL', 'PI_IMAGE_API_KEY', 'PI_IMAGE_MODEL'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) before[key] === undefined ? delete process.env[key] : process.env[key] = before[key]; });
  return async ({usage, origin = 'https://api.openai.com', backend = 'openai-compatible', model = 'gpt-image-2.6-sunburst',
    edit = false, responseUrl, redirected = false, transport = 'images'}) => {
    const isRouter = backend === 'openrouter';
    process.env.PI_IMAGE_BACKEND = backend;
    process.env.PI_IMAGE_API_URL = `${origin}${isRouter ? '/api/v1' : '/v1'}`;
    process.env.PI_IMAGE_API_KEY = 'synthetic-image-billing-only';
    process.env.PI_IMAGE_MODEL = model;
    const tools = [], entries = [];
    artDirection({ registerTool: tool => tools.push(tool), appendEntry: (customType, data) => entries.push({type:'custom', customType, data}) });
    const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
      const endpoint = new URL(String(url));
      assert.equal(endpoint.origin, origin);
      assert.equal(endpoint.pathname, isRouter ? transport === 'chat' ? '/api/v1/chat/completions' : '/api/v1/images'
        : edit ? '/v1/images/edits' : '/v1/images/generations');
      assert.equal(edit ? options.body.get('model') : JSON.parse(options.body).model, model);
      const base64 = Buffer.from(pixels).toString('base64');
      const response = Response.json(isRouter && transport === 'chat'
        ? {choices:[{message:{content:'', images:[{image_url:{url:`data:image/png;base64,${base64}`}}]}}], usage}
        : {data:[{b64_json:base64}], usage});
      if (responseUrl) Object.defineProperty(response, 'url', {value:responseUrl});
      if (redirected) Object.defineProperty(response, 'redirected', {value:true});
      return response;
    });
    const ctx = {cwd, model:{input:['text','image']}, sessionManager:{getSessionId:()=>'synthetic-billing-session'}};
    try {
      const result = await tools.find(tool => tool.name === 'image_generate').execute('synthetic',
        {action:edit ? 'edit' : 'generate', prompt:'Synthetic square for billing', format:'png', ...(edit && {path:'reference.png'}), ...(isRouter && {transport})},
        undefined, undefined, ctx);
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(result.details.decodeVerified, true);
      assert.deepEqual(entries.map(entry => entry.data.status), ['pending', 'completed']);
      assert.equal(entries[0].data.id, entries[1].data.id);
      const replay = JSON.parse(JSON.stringify(entries));
      const cost = collectSessionCost([...replay, ...replay]);
      return {...cost, receipt:entries[1].data};
    } finally {
      fetch.mock.restore();
    }
  };
}
