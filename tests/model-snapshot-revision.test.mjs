import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';

// A dynamic catalog that publishes outside a refresh the runtime awaited
// (superseded or overlapping passes) must still reach the available list:
// subagents resolve the session's own route against it.
test('models published outside an awaited refresh reach the available snapshot', async () => {
  let catalog = [];
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({ 'late-catalog': { type: 'api_key', key: 'synthetic-test-key' } }),
    modelsPath: null, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false,
  });
  runtime.registerProvider('late-catalog', {
    baseUrl: 'https://late-catalog.invalid/v1', api: 'openai-completions', apiKey: 'LATE_CATALOG_KEY',
    refreshModels: async () => catalog,
  });
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getAvailableSnapshot().filter(model => model.provider === 'late-catalog').length, 0);

  catalog = [{ id: 'late-flash', name: 'late-flash', api: 'openai-completions', provider: 'late-catalog', baseUrl: 'https://late-catalog.invalid/v1', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 }];
  // Publication through the provider store directly, not ModelRuntime.refresh.
  await runtime.models.refresh({ allowNetwork: false, providers: ['late-catalog'] });
  assert.ok(runtime.getModel('late-catalog', 'late-flash'), 'catalog read sees the publication');
  assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === 'late-catalog' && model.id === 'late-flash'),
    'available snapshot reconciles with the published catalog on read');
});

// A change to one provider (a registration, a stored credential) is newer than what a full pass still
// reading will find for it, so the pass leaves that provider alone. It still owes everyone else's state.
test('a provider registered while a full availability pass runs does not cost that pass its result', async () => {
  const credentials = AuthStorage.inMemory({ second: { type: 'api_key', key: 'synthetic-test-key' } });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false });
  const provider = name => ({
    baseUrl: `https://${name}.invalid/v1`, api: 'openai-completions', apiKey: `${name.toUpperCase()}_SYNTHETIC_KEY`,
    models: [{ id: `${name}-flash`, name: `${name}-flash`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000 }],
  });
  runtime.registerProvider('first', provider('first'));
  await runtime.refresh({ allowNetwork: false });
  const stored = () => runtime.getProviderAuthStatus('first').source === 'stored';
  assert.equal(stored(), false, 'no stored credential yet');

  // The credential arrives in the store without going through the runtime: only a full pass can find it.
  await credentials.modify('first', () => ({ type: 'api_key', key: 'synthetic-test-key' }));
  // Hold the full pass in its reading step long enough for a registration to land inside it.
  const list = credentials.list.bind(credentials), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  credentials.list = async (...args) => { await pause(60); return list(...args); };
  const full = runtime.refresh({ allowNetwork: false });
  await pause(15);
  runtime.registerProvider('second', provider('second'));
  await full;
  assert.equal(runtime.getProviderAuthStatus('second').configured, true, 'the pass that began before the registration leaves the new provider as the registration set it');
  await pause(150);
  assert.equal(stored(), true, 'the full pass still reported the stored credential');
  assert.ok(runtime.getModel('second', 'second-flash'), 'and the registration is in place');
});

// A registration refreshes its own provider only, which is sound while the models file is unchanged.
test('a registration made after the models file changed recomposes every provider from it', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunuspi-models-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json');
  const write = id => fs.writeFile(file, JSON.stringify({ providers: { alpha: { baseUrl: 'https://alpha.invalid/v1', api: 'openai-completions', apiKey: 'ALPHA_SYNTHETIC_KEY',
    models: [{ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000 }] } } }));
  await write('alpha-one');
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory({}), modelsPath: file, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false });
  await runtime.refresh({ allowNetwork: false });
  assert.ok(runtime.getModel('alpha', 'alpha-one'));
  await write('alpha-two');
  runtime.registerProvider('beta', { baseUrl: 'https://beta.invalid/v1', api: 'openai-completions', apiKey: 'BETA_SYNTHETIC_KEY',
    models: [{ id: 'beta-flash', name: 'beta-flash', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000 }] });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(runtime.getModel('alpha', 'alpha-two'), 'the other provider is composed from the file as it now reads');
  assert.equal(runtime.getModel('alpha', 'alpha-one'), undefined);
  assert.ok(runtime.getModel('beta', 'beta-flash'));
});
