import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-routing-test-runtime-"));
process.env.PI_PROVIDER_STATE_FILE = path.join(runtimeRoot, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(runtimeRoot, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(runtimeRoot, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

const { createModelRoutingEditorServer } = await import("../agent/extensions/model-routing-config.ts");
const { chromium } = await import("playwright");

function headers(url, token) {
  const origin = new URL(url).origin;
  return { origin, "content-type": "application/json", "x-model-routing-token": token };
}
async function post(url, token, endpoint, body, extraHeaders = {}) {
  return fetch(`${url.replace(/\/[a-f0-9]{64}$/, "")}/${token}/api/${endpoint}`, {
    method: "POST", headers: { ...headers(url, token), ...extraHeaders }, body: JSON.stringify(body),
  });
}
// Browser startup is shared; each test still owns its server, configuration,
// cookies, storage and page through a fresh context.
let browserPromise;
after(async () => { if (browserPromise) await (await browserPromise).close(); });
async function openPage(t, url, viewport = { width: 1280, height: 900 }) {
  const browser = await (browserPromise ??= chromium.launch({ executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }));
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function mediaFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-routing-ui-"));
  const { SettingsManager, createAgentSession, DefaultResourceLoader, SessionManager } = await import('@yunuspi/coding-agent');
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
  const settingsPath = path.join(agentDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'language', defaultThinkingLevel: 'high', enabledModels: ['fixture/language'], retry: { enabled: false } }));
  const settings = SettingsManager.create(root, agentDir, { projectTrusted: false });
  const model = { provider: 'fixture', id: 'language', name: 'Language', api: 'openai-completions', baseUrl: 'https://invalid.example', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 };
  const runtime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false, streamSimple() { throw Error('Media selector must not trigger inference'); } };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, model, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), thinkingLevel: 'high' });
  await session.bindExtensions({ onError() {} });
  t.after(() => { session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, ctx: session.extensionRunner.createContext(), session, settings, settingsPath };
}

test('/models browser selects image and audio using the real session API without changing LLM state', async t => {
  const f = await mediaFixture(t);
  const thinking = f.session.thinkingLevel, model = f.session.model, reads = [];
  const handle = await createModelRoutingEditorServer(f.ctx, { mediaCatalogLoader: async kind => {
    reads.push(kind);
    return [{ kind, id: 'openrouter/vendor/'+kind, name: 'Fixture '+kind, description: 'Reference and alpha asset generation.', source: 'live catalog', capabilities: { supported_parameters: { input_references: { max: 4 }, background: { values: ['transparent'] }, aspect_ratio: { values: ['16:9', '1:1'] } } } }];
  } });
  t.after(() => handle.close());
  const page = await openPage(t, handle.url), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.deepEqual(reads, [], 'opening /models reads no media catalog and generates nothing');
  assert.deepEqual(await page.locator('#kinds button').allInnerTexts(), ['Images', 'Audio'], 'only media sections are offered');
  await page.getByRole('button', { name: 'Images', exact: true }).press('Enter');
  const image = page.getByRole('combobox', { name: 'Image model', exact: true });
  await image.locator('option[value="openrouter/vendor/image"]').waitFor({ state: 'attached' });
  await page.getByRole('searchbox', { name: 'Search Image models' }).fill('alpha');
  await image.selectOption('openrouter/vendor/image');
  await page.getByText(/Transparent background/).waitFor();
  await page.getByRole('button', { name: 'Use for session', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Media choices applied to this session.' }).waitFor();
  assert.equal(f.ctx.mediaModels.image, 'openrouter/vendor/image');
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).mediaModels, undefined, 'session use does not persist');
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByRole('combobox', { name: 'Speech model', exact: true }).selectOption('elevenlabs/eleven_flash_v2_5');
  await page.getByRole('combobox', { name: 'Music model', exact: true }).selectOption('local/procedural');
  await page.getByRole('combobox', { name: 'Sound effects model', exact: true }).selectOption('elevenlabs/eleven_text_to_sound_v2');
  await page.getByRole('button', { name: 'Save media choices', exact: true }).press('Enter');
  await page.getByRole('status').filter({ hasText: 'Media choices saved for future sessions.' }).waitFor();
  const stored = JSON.parse(fs.readFileSync(f.settingsPath));
  assert.deepEqual(stored.mediaModels, { image: 'openrouter/vendor/image', speech: 'elevenlabs/eleven_flash_v2_5', music: 'local/procedural', sfx: 'elevenlabs/eleven_text_to_sound_v2' });
  assert.equal(stored.defaultModel, 'language'); assert.equal(stored.defaultThinkingLevel, 'high'); assert.deepEqual(stored.enabledModels, ['fixture/language']);
  assert.equal(f.session.model, model); assert.equal(f.session.thinkingLevel, thinking);
  assert.deepEqual(reads, ['image']);
  await page.screenshot({ path: '/var/tmp/yunuspi-media-models-wide.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: 'Audio', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Speech model', exact: true }).inputValue(), stored.mediaModels.speech);
  await page.setViewportSize({ width: 356, height: 820 });
  await page.getByRole('combobox', { name: 'Sound effects model', exact: true }).focus();
  assert.equal(await page.getByRole('combobox', { name: 'Sound effects model', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/var/tmp/yunuspi-media-models-narrow.png', fullPage: true });
  assert.deepEqual(errors, []);
  const clone = f.ctx.mediaModels; clone.image = 'openrouter/auto';
  assert.equal(f.ctx.mediaModels.image, stored.mediaModels.image);
  f.session.extensionRunner.invalidate('fixture stale session');
  await assert.rejects(f.ctx.setMediaModels({ image: 'openrouter/auto' }), /stale session/);
});

test('media writes reject foreign origins, malformed choices and stale session revisions', async t => {
  const f = await mediaFixture(t), handle = await createModelRoutingEditorServer(f.ctx);
  t.after(() => handle.close());
  const token = new URL(handle.url).pathname.slice(1);
  const snapshot = await (await post(handle.url, token, 'media-snapshot', {})).json();
  const valid = { revision: snapshot.revision, selections: { image: 'openrouter/auto' }, persist: false };
  assert.equal((await post(handle.url, token, 'media-save', valid, { origin: 'https://foreign.invalid' })).status, 403);
  for (const selections of [{ unknown: 'openrouter/auto' }, { speech: 'openrouter/auto' }, { image: 'https://invalid' }, []]) {
    assert.equal((await post(handle.url, token, 'media-save', { ...valid, selections })).status, 400);
    assert.deepEqual(f.ctx.mediaModels, {});
  }
  assert.equal((await post(handle.url, token, 'media-catalog', { kind: 'speech' })).status, 400);
  // The language-model endpoints were removed with the chat roles.
  for (const endpoint of ['save', 'search', 'snapshot', 'metrics']) assert.equal((await post(handle.url, token, endpoint, { revision: snapshot.revision })).status, 404, endpoint);
  assert.equal((await post(handle.url, token, 'media-save', valid)).status, 200);
  assert.equal((await post(handle.url, token, 'media-save', valid)).status, 409);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).mediaModels, undefined);
});

test('a retired hosted-video choice in saved config is ignored: not shown, not rejected, not written back', async t => {
  const f = await mediaFixture(t), handle = await createModelRoutingEditorServer(f.ctx);
  t.after(() => handle.close());
  const token = new URL(handle.url).pathname.slice(1);
  await f.ctx.setMediaModels({ image: 'openrouter/vendor/saved', video: 'openrouter/vendor/legacy' });
  const snapshot = await (await post(handle.url, token, 'media-snapshot', {})).json();
  assert.deepEqual(snapshot.selections, { image: 'openrouter/vendor/saved' });
  assert.equal(snapshot.models.some(row => row.kind === 'video'), false);
  const saved = await post(handle.url, token, 'media-save', { revision: snapshot.revision, selections: { image: 'openrouter/vendor/saved', video: 'openrouter/vendor/legacy' }, persist: true });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).selections, { image: 'openrouter/vendor/saved' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath)).mediaModels, { image: 'openrouter/vendor/saved' });
});

test('media catalog timeout and offline mode retain saved choices in the browser', async t => {
  const f = await mediaFixture(t), originalOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  t.after(() => { if (originalOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = originalOffline; });
  await f.ctx.setMediaModels({ image: 'openrouter/vendor/saved' });
  let reads = 0, signal;
  const handle = await createModelRoutingEditorServer(f.ctx, { mediaTimeoutMs: 50, mediaCatalogLoader: async (_kind, options) => { reads++; signal = options.signal; return new Promise(() => {}); } });
  t.after(() => handle.close());
  const page = await openPage(t, handle.url);
  await page.getByRole('button', { name: 'Images', exact: true }).click();
  await page.getByText(/Media catalog lookup timed out/).waitFor();
  assert.equal(signal.aborted, true);
  assert.equal(await page.getByRole('combobox', { name: 'Image model', exact: true }).inputValue(), 'openrouter/vendor/saved');
  process.env.PI_OFFLINE = '1';
  await page.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
  await page.getByText(/Offline mode/).waitFor();
  assert.equal(reads, 1);
  assert.equal(await page.getByRole('combobox', { name: 'Image model', exact: true }).inputValue(), 'openrouter/vendor/saved');
});
