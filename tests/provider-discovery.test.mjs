import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeModelProvider } from '../core/coding-agent/src/core/provider-composer.js';
import { DIRECTORY_URL, distillDirectory } from '../agent/extensions/lib/model-directory.ts';

// One agent directory for the file: the extension reads its location once.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-discovery-'));
const saved = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SUBAGENT_CHILD', 'PI_MODEL_DISCOVERY', 'ACME_KEY'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = root;
process.env.ACME_KEY = 'synthetic-acme-key';
for (const key of ['PI_OFFLINE', 'PI_SUBAGENT_CHILD', 'PI_MODEL_DISCOVERY']) delete process.env[key];
const marker = path.join(root, 'command-ran');
const writeConfig = providers => fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers }));
writeConfig({
  acme: { baseUrl: 'https://api.acme.example/v1/', api: 'openai-completions', apiKey: '${ACME_KEY}', compat: { supportsStore: false },
    models: [{ id: 'acme-mine', name: 'Mine', contextWindow: 50_000, maxTokens: 5_000 }] },
  claudish: { baseUrl: 'https://claudish.example/anthropic', api: 'anthropic-messages', apiKey: 'synthetic-claudish-key', models: [{ id: 'c-1' }] },
  scripted: { baseUrl: 'https://scripted.example/v1', api: 'openai-completions', apiKey: `!touch ${marker}`, models: [{ id: 's-1' }] },
  overlay: { modelOverrides: { x: { maxTokens: 10 } } },
  odd: { baseUrl: 'https://odd.example/v1', api: 'google-generative-ai', apiKey: 'synthetic-odd-key', models: [{ id: 'o-1' }] },
  deepseek: { modelOverrides: {} },
});
const { default: register, registerCachedChildModelProvider } = await import('../agent/extensions/live-models.ts');
const providers = {}, hooks = {}, commands = {};
await register({ registerProvider: (id, config) => { providers[id] = config; }, registerCommand: (name, command) => { commands[name] = command; }, on: (event, handler) => { hooks[event] = handler; } });
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
});
const context = (extra = {}) => ({ allowNetwork: true, signal: new AbortController().signal, ...extra });
const saveDirectory = raw => fs.writeFileSync(path.join(root, 'model-directory.json'), JSON.stringify(distillDirectory(raw, Date.now())));

test('every configured provider with a base URL and a wire API is discovered; others are left alone', () => {
  for (const id of ['acme', 'claudish', 'scripted']) {
    assert.equal(providers[id].additive, true, `${id} adds to the configured list`);
    assert.equal(typeof providers[id].refreshModels, 'function');
    assert.equal(providers[id].apiKey, undefined, 'authentication stays with models.json');
  }
  assert.equal(providers.acme.baseUrl, 'https://api.acme.example/v1/');
  assert.equal(providers.overlay, undefined, 'an overlay with no endpoint has nothing to ask');
  assert.equal(providers.odd, undefined, 'a wire API with no model-list convention is not probed');
  assert.equal(providers.deepseek.additive, undefined, 'a provider with its own adapter keeps it');
});

test('the provider is asked once at its own address, and what it lists is added with honest gaps', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, redirect: options.redirect });
    return new Response(JSON.stringify({ data: [
      { id: 'acme-mine', context_length: 999_999 },
      { id: 'acme-large', context_length: 400_000, max_completion_tokens: 64_000, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'acme-plain' },
      { id: 'acme-embed', type: 'embedding' },
      { id: 'acme-draw' },
    ] }));
  };
  const first = await providers.acme.refreshModels(context());
  assert.deepEqual(calls, [{ url: 'https://api.acme.example/v1/models', headers: { Authorization: 'Bearer synthetic-acme-key' }, redirect: 'error' }]);
  assert.deepEqual(first.map(model => model.id), ['acme-mine', 'acme-large', 'acme-plain', 'acme-draw'], 'a row that says it is not a chat model is withheld');
  const large = first.find(model => model.id === 'acme-large');
  assert.equal(large.contextWindow, 400_000); assert.equal(large.maxTokens, 64_000); assert.deepEqual(large.input, ['text', 'image']);
  assert.equal(large.compat.supportsStore, false, 'provider-level compat from models.json reaches discovered models');
  const plain = first.find(model => model.id === 'acme-plain');
  assert.equal(plain.contextWindow, 128_000); assert.equal(plain.maxTokens, 16_384);
  assert.deepEqual(plain.cost.missing, ['input', 'output'], 'an unknown price is unknown, not free');

  // The directory arrives later: the saved list gains its facts with no provider request.
  saveDirectory({ 'acme-cloud': { api: 'https://api.acme.example/v1', models: {
    'acme-plain': { name: 'Acme Plain', reasoning: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 262_144, output: 32_768 }, cost: { input: 0.2, output: 0.8, cache_read: 0.02 } },
    'acme-large': { limit: { context: 1_000, output: 500 }, cost: { input: 1, output: 2 } },
    'acme-draw': { modalities: { input: ['text'], output: ['image'] }, limit: { context: 4_000, output: 0 } },
  } } });
  const second = await providers.acme.refreshModels(context());
  assert.equal(calls.length, 1, 'a saved list under six hours old is not fetched again');
  assert.deepEqual(second.map(model => model.id), ['acme-mine', 'acme-large', 'acme-plain'], 'the directory knows acme-draw makes images');
  const known = second.find(model => model.id === 'acme-plain');
  assert.deepEqual([known.name, known.reasoning, known.contextWindow, known.maxTokens], ['Acme Plain', true, 262_144, 32_768]);
  assert.deepEqual(known.cost, { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.2 });
  const stated = second.find(model => model.id === 'acme-large');
  assert.deepEqual([stated.contextWindow, stated.maxTokens], [400_000, 64_000], 'what the provider itself states outranks the directory');
  assert.deepEqual(stated.cost, { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 }, 'the directory fills only what the provider left out');

  // The composer keeps the user's own definition of a model the provider also lists.
  const config = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8')).providers.acme;
  const composed = composeModelProvider('acme', undefined, { getProvider: () => config }, { ...providers.acme, models: second });
  const models = composed.getModels();
  assert.deepEqual(models.map(model => model.id), ['acme-mine', 'acme-large', 'acme-plain']);
  assert.deepEqual([models[0].name, models[0].contextWindow, models[0].maxTokens], ['Mine', 50_000, 5_000]);
  assert.equal(models[1].baseUrl, 'https://api.acme.example/v1/'); assert.equal(models[1].api, 'openai-completions');
});

test('a host with no model list contributes nothing, raises no warning and is not asked again this session', async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://claudish.example/anthropic/v1/models');
    assert.equal(options.headers['x-api-key'], 'synthetic-claudish-key'); assert.equal(options.headers['anthropic-version'], '2023-06-01');
    return new Response('not found', { status: 404 });
  };
  assert.deepEqual(await providers.claudish.refreshModels(context()), []);
  assert.deepEqual(await providers.claudish.refreshModels(context()), []);
  assert.equal(calls, 1);
  const { catalogDiagnostics } = await import('../agent/extensions/live-models.ts');
  assert.equal(catalogDiagnostics().find(row => row.provider === 'claudish'), undefined, 'the configured list is the baseline, so nothing is degraded');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8')).providers.claudish;
  assert.deepEqual(composeModelProvider('claudish', undefined, { getProvider: () => config }, { ...providers.claudish, models: [] }).getModels().map(model => model.id), ['c-1']);
});

test('a key is never produced by running a command, and offline or delegated sessions ask nobody', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 's-2' }] })); };
  assert.deepEqual(await providers.scripted.refreshModels(context()), []);
  assert.equal(calls, 0); assert.equal(fs.existsSync(marker), false, 'the configured command did not run');
  const resolved = await providers.scripted.refreshModels(context({ force: true, credential: { type: 'api_key', key: 'resolved-by-runtime' } }));
  assert.deepEqual(resolved.map(model => model.id), ['s-2'], 'the runtime\'s resolved credential is used when there is one');
  assert.equal(calls, 1);
  assert.deepEqual((await providers.scripted.refreshModels(context({ allowNetwork: false }))).map(model => model.id), ['s-2'], 'offline serves the saved list');
  assert.equal(calls, 1);
});

test('a delegated child can resolve a discovered model from the saved list alone', async () => {
  const child = {};
  assert.equal(registerCachedChildModelProvider({ registerProvider: (id, config) => { child[id] = config; } }, 'acme/acme-plain'), true);
  assert.equal(child.acme.additive, true);
  globalThis.fetch = async () => { throw new Error('a child never refreshes a catalog'); };
  assert.deepEqual((await child.acme.refreshModels(context())).map(model => model.id), ['acme-plain']);
  assert.equal(registerCachedChildModelProvider({ registerProvider() { throw new Error('unexpected'); } }, 'overlay/x'), false);
  assert.equal(registerCachedChildModelProvider({ registerProvider() { throw new Error('unexpected'); } }, 'acme/acme-mine'), false, 'a model the user defined stays with the native composer');
});

test('dated facts keep applying after their window, and the directory supplies the current limits and price', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2027-03-01T00:00:00Z'));
  globalThis.fetch = async () => { throw new Error('offline'); };
  const aged = (await providers.deepseek.refreshModels(context({ allowNetwork: false }))).find(model => model.id === 'deepseek-flash');
  assert.ok(aged, 'the documented model is still published');
  assert.equal(aged.contextWindow, 1_000_000); assert.equal(aged.reasoning, true);
  assert.equal(aged.compat.thinkingFormat, 'deepseek', 'the wire format does not expire');
  assert.deepEqual(aged.input, ['text', 'image']);
  saveDirectory({ deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-flash': { reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_048_576, output: 393_216 }, cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } } });
  const current = (await providers.deepseek.refreshModels(context({ allowNetwork: false }))).find(model => model.id === 'deepseek-flash');
  assert.deepEqual([current.contextWindow, current.maxTokens], [1_048_576, 393_216]);
  assert.deepEqual(current.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 });
  assert.equal(current.compat.thinkingFormat, 'deepseek'); assert.equal(current.name, 'DeepSeek V4.1 Flash');
});

test('inside its window the provider\'s own price list outranks the directory, which lists the off-peak rate', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-20T12:00:00Z'));
  globalThis.fetch = async () => { throw new Error('offline'); };
  saveDirectory({ deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-flash': { limit: { context: 1_048_576, output: 393_216 }, cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } } });
  const current = (await providers.deepseek.refreshModels(context({ allowNetwork: false }))).find(model => model.id === 'deepseek-flash');
  // Exactly the peak rates: the core halves them outside peak hours when it recognises them.
  assert.deepEqual(current.cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  assert.deepEqual([current.contextWindow, current.maxTokens], [1_048_576, 393_216], 'limits still come from the directory');
});

test('a model id listed twice is published once, with its first listing', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'acme-twice', context_length: 111_000 }, { id: 'acme-twice', context_length: 222_000 }, { id: 'acme-other' },
  ] }));
  const models = await providers.acme.refreshModels(context({ force: true }));
  assert.deepEqual(models.map(model => model.id), ['acme-twice', 'acme-other']);
  assert.equal(models[0].contextWindow, 111_000);
});

test('an Anthropic-style list is read page by page until has_more is false', async () => {
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith('after_id=c-a')
      ? { data: [{ id: 'c-b' }], has_more: false, last_id: 'c-b' }
      : { data: [{ id: 'c-a' }], has_more: true, last_id: 'c-a' }));
  };
  const models = await providers.claudish.refreshModels(context({ force: true }));
  assert.deepEqual(requested, ['https://claudish.example/anthropic/v1/models', 'https://claudish.example/anthropic/v1/models?after_id=c-a']);
  assert.deepEqual(models.map(model => model.id), ['c-a', 'c-b']);
});

test('a page that repeats the last id ends the walk', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'c-x' }], has_more: true, last_id: 'c-x' })); };
  const models = await providers.claudish.refreshModels(context({ force: true }));
  assert.equal(calls, 2);
  assert.deepEqual(models.map(model => model.id), ['c-x']);
});

const directoryFile = path.join(root, 'model-directory.json');
const sessionContext = () => ({ hasUI: false, model: { provider: 'acme', id: 'acme-mine' }, modelRegistry: { refresh: async () => {}, getAvailable: () => [] } });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const directoryRequests = (urls) => urls.filter(url => url === DIRECTORY_URL);

test('PI_MODEL_DISCOVERY=off: the models.dev directory is not requested at session start or on an explicit refresh', async () => {
  fs.rmSync(directoryFile, { force: true });
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify({ data: [] })); };
  process.env.PI_MODEL_DISCOVERY = 'off';
  try {
    const ctx = sessionContext();
    await hooks.session_start({}, ctx);
    await commands['catalog-status'].handler('refresh', ctx);
    await settle();
    assert.deepEqual(directoryRequests(urls), []);
    assert.equal(fs.existsSync(directoryFile), false, 'nothing was saved');
  } finally {
    delete process.env.PI_MODEL_DISCOVERY;
  }
});

// Runs before the explicit-refresh test: a successful attempt starts the hour too.
test('a directory request cut short by its session is not counted as an attempt; a failed one is', async () => {
  fs.rmSync(directoryFile, { force: true });
  let mode = 'hang', requests = 0;
  globalThis.fetch = (url, options) => {
    if (String(url) !== DIRECTORY_URL) return Promise.resolve(new Response('{}'));
    requests++;
    if (mode === 'fail') return Promise.reject(new Error('network down'));
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const ctx = sessionContext();
  await hooks.session_start({}, ctx);
  await hooks.session_shutdown({}, ctx);
  await settle();
  assert.equal(requests, 1);
  mode = 'fail';
  await hooks.session_start({}, ctx);
  await settle();
  assert.equal(requests, 2, 'the cut-short attempt did not block the next session');
  await hooks.session_start({}, ctx);
  await settle();
  assert.equal(requests, 2, 'a failed attempt still waits an hour');
  await hooks.session_shutdown({}, ctx);
});

test('an explicit refresh fetches the directory again, even when the saved copy is fresh', async () => {
  saveDirectory({ deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-flash': { limit: { context: 500_000, output: 50_000 } } } } });
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-flash': { limit: { context: 600_000, output: 60_000 } } } } }));
  };
  const ctx = sessionContext();
  await hooks.session_start({}, ctx);
  await settle();
  assert.deepEqual(directoryRequests(urls), [], 'a fresh saved copy is not requested at session start');
  await commands['catalog-status'].handler('refresh', ctx);
  await settle();
  assert.deepEqual(directoryRequests(urls), [DIRECTORY_URL]);
  assert.equal(JSON.parse(fs.readFileSync(directoryFile, 'utf8')).providers.deepseek.models['deepseek-flash'].contextWindow, 600_000);
});

