import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { ModelConfig } from '../core/coding-agent/src/core/model-config.js';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';
import { composeModelProvider } from '../core/coding-agent/src/core/provider-composer.js';
import { resolveCliModel } from '../core/coding-agent/src/core/model-resolver.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-list-stability-'));
const saved = Object.fromEntries(['PI_CODING_AGENT_DIR', 'DEEPSEEK_API_KEY'].map(key => [key, process.env[key]]));
const oldFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.DEEPSEEK_API_KEY;
fs.writeFileSync(path.join(root, 'models.json'), '{"providers":{}}');
const repo = path.resolve(import.meta.dirname, '..');
const { default: register } = await import(pathToFileURL(path.join(repo, 'agent/extensions/live-models.ts')));
const liveProviders = {};
await register({ registerProvider: (id, provider) => { liveProviders[id] = provider; }, registerCommand() {}, on() {} });
const team = await createJiti(import.meta.dirname).import('../agent/extensions/lib/team.ts');
test.after(() => {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(root, { recursive: true, force: true });
});

const row = (provider, id) => ({
  id, name: id, api: 'openai-completions', provider, baseUrl: `https://${provider}.invalid/v1`, reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000,
});
const runtimeFor = () => ModelRuntime.create({
  credentials: AuthStorage.inMemory({ shown: { type: 'api_key', key: 'synthetic-test-key' } }),
  modelsPath: null, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false,
});
const ids = (runtime, provider) => runtime.getModels(provider).map(model => model.id);

test('A: the last list an extension published survives a recomposition and ends with its registration', async () => {
  const runtime = await runtimeFor();
  const registration = id => ({ baseUrl: 'https://shown.invalid/v1', api: 'openai-completions', apiKey: 'SHOWN_KEY', models: [row('shown', id)], refreshModels: async () => [row('shown', 'live-one'), row('shown', 'live-two')] });
  runtime.registerProvider('shown', registration('static-old'));
  assert.deepEqual(ids(runtime, 'shown'), ['static-old']);
  await runtime.refresh({ allowNetwork: false, providers: ['shown'] });
  assert.deepEqual(ids(runtime, 'shown'), ['live-one', 'live-two']);

  // A refresh that is stopped before it publishes (closed picker, 15 s timeout) still recomposes the provider.
  const stopped = new AbortController();
  stopped.abort();
  await runtime.refresh({ allowNetwork: false, signal: stopped.signal });
  assert.deepEqual(ids(runtime, 'shown'), ['live-one', 'live-two'], 'a snapshot never shows less than the last published list');
  assert.deepEqual(runtime.getAvailableSnapshot().filter(model => model.provider === 'shown').map(model => model.id), ['live-one', 'live-two']);

  runtime.registerProvider('shown', registration('static-new'));
  assert.deepEqual(ids(runtime, 'shown'), ['static-new'], 'a replaced registration does not keep the old list');
});

test('B: a failing upstream catalog does not skip the extension refresh, and its error is reported afterwards', async () => {
  const live = [row('shown', 'live-one')];
  const base = { id: 'shown', auth: { apiKey: { name: 'k', login: async () => ({}), check: async () => undefined, resolve: async () => undefined } }, getModels: () => [row('shown', 'built-in')], refreshModels: async () => { throw new Error('pi.dev is down'); } };
  const extension = { baseUrl: 'https://shown.invalid/v1', api: 'openai-completions', refreshModels: async () => live };
  const provider = composeModelProvider('shown', base, await ModelConfig.load(undefined), extension);
  let published = false;
  const context = { signal: new AbortController().signal, publish: async ({ update }) => { update?.(); published = true; return true; } };
  await assert.rejects(provider.refreshModels(context), /pi\.dev is down/);
  assert.ok(published, 'the extension list was still published');
  assert.deepEqual(provider.getModels().map(model => model.id), ['live-one']);
});

test('D: DeepSeek publishes only what the vendor lists; facts for retired ids stay for pricing', async () => {
  globalThis.fetch = async url => {
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }));
  };
  const models = await liveProviders.deepseek.refreshModels({ allowNetwork: true, force: true, signal: new AbortController().signal, credential: { type: 'api_key', key: 'synthetic-key' } });
  assert.deepEqual(models.map(model => model.id).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  const { MODEL_FACTS } = await createJiti(import.meta.dirname).import('../agent/extensions/lib/model-facts.ts');
  assert.ok(Object.hasOwn(MODEL_FACTS.deepseek.models, 'deepseek-v4-flash'), 'historical usage is still priced by id');
});

test('E: the built-in lists carry the vendors current models', async () => {
  const runtime = await runtimeFor();
  assert.deepEqual(ids(runtime, 'deepseek').sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(runtime.getModel('deepseek', 'deepseek-flash').name, 'DeepSeek V4.1 Flash');
  assert.deepEqual(ids(runtime, 'ant-ling').sort(), ['Ling-3.0-flash', 'Ling-3.0-flash-VL', 'Ling-3.0-tiny', 'Ling-3.1-flash', 'Ling-3.2-flash']);
});

test('F: a route saved under a retired DeepSeek id resolves to deepseek-flash in every lookup', async () => {
  const runtime = await runtimeFor();
  for (const retired of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(runtime.getModel('deepseek', retired)?.id, 'deepseek-flash', `${retired} through the model lookup`);
    const cli = resolveCliModel({ cliModel: `deepseek/${retired}:high`, modelRuntime: runtime });
    assert.equal(cli.model?.id, 'deepseek-flash', `${retired} through --model`);
    assert.equal(cli.thinkingLevel, 'high');
    assert.equal(team.resolveRoleRoute('helper', { helper: `deepseek/${retired}`, legwork: 'inherit' }, { provider: 'deepseek', id: 'deepseek-v4-pro' }, [{ provider: 'deepseek', id: 'deepseek-flash' }]), 'deepseek/deepseek-flash', `${retired} as a team role`);
  }
  assert.equal(runtime.getModel('deepseek', 'deepseek-v4-pro')?.id, 'deepseek-v4-pro', 'a listed id is not rewritten');
  assert.equal(runtime.getModel('deepseek', 'no-such-model'), undefined);
  assert.throws(() => team.resolveRoleRoute('helper', { helper: 'deepseek/deepseek-v4-flash', legwork: 'inherit' }, undefined, [{ provider: 'deepseek', id: 'deepseek-v4-pro' }]), /not among the available models/);
});

test('H: the runtime reports when registered providers have restored their cached lists', async () => {
  const runtime = await runtimeFor();
  runtime.registerProvider('shown', {
    baseUrl: 'https://shown.invalid/v1', api: 'openai-completions', apiKey: 'SHOWN_KEY', models: [row('shown', 'static-old')],
    refreshModels: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return [row('shown', 'cached-live')]; },
  });
  assert.deepEqual(runtime.getAvailableSnapshot().filter(model => model.provider === 'shown').map(model => model.id), ['static-old']);
  await runtime.whenRegistrationsRestored();
  assert.deepEqual(runtime.getAvailableSnapshot().filter(model => model.provider === 'shown').map(model => model.id), ['cached-live']);
});

// The RPC loop run against a stand-in host: get_available_models answers from the runtime it is given.
const rpcAnswer = (restored) => new Promise((resolve, reject) => {
  const script = `
    import { runRpcMode } from ${JSON.stringify(pathToFileURL(path.join(repo, 'core/coding-agent/src/modes/rpc/rpc-mode.js')).href)};
    let restored = false;
    const modelRuntime = {
      getAvailableSnapshot: () => [{ id: restored ? 'cached-live' : 'static-old' }],
      whenRegistrationsRestored: ${restored ? 'async () => { await new Promise(r => setTimeout(r, 300)); restored = true; }' : '() => new Promise(() => {})'},
    };
    const session = { modelRuntime, bindExtensions: async () => {}, subscribe: () => () => {}, agent: { subscribe: () => () => {} } };
    runRpcMode({ session, setRebindSession() {}, dispose: async () => {} });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const started = Date.now();
  let out = '';
  child.stdout.on('data', chunk => {
    out += chunk;
    const line = out.split('\n').find(text => text.includes('get_available_models'));
    if (!line) return;
    child.kill('SIGKILL');
    resolve({ ids: JSON.parse(line).data.models.map(model => model.id), ms: Date.now() - started });
  });
  child.on('error', reject);
  child.stdin.write(JSON.stringify({ id: '1', type: 'get_available_models' }) + '\n');
});

test('H: get_available_models waits for the restored lists, but never longer than three seconds', { timeout: 20_000 }, async () => {
  assert.deepEqual((await rpcAnswer(true)).ids, ['cached-live']);
  const stuck = await rpcAnswer(false);
  assert.deepEqual(stuck.ids, ['static-old']);
  assert.ok(stuck.ms >= 2900 && stuck.ms < 8000, `answered after ${stuck.ms} ms`);
});
