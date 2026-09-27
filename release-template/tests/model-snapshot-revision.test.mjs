import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';

// A dynamic catalog that publishes outside a refresh the runtime awaited
// (superseded or overlapping passes) must still reach the available list:
// subagents and /double resolve the session's own route against it.
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
