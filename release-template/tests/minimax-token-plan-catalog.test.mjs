import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';

// Catalog facts: models.dev minimax provider entries cross-checked against the
// live MiniMax /models endpoint (a Token Plan subscription key lists these 8)
// and OpenRouter pricing. M2 cache + M2.1-highspeed rows have no published
// price; they mirror the M2.1 / highspeed convention (see commit).
const EXPECTED = [
  { id: 'MiniMax-M3', contextWindow: 1048576, maxTokens: 512000, input: ['text', 'image'], cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 } },
  { id: 'MiniMax-M2.7', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2.7-highspeed', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2.5', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2.5-highspeed', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2.1', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2.1-highspeed', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 } },
  { id: 'MiniMax-M2', contextWindow: 204800, maxTokens: 131072, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 } },
];
const REGIONS = [
  { provider: 'minimax', baseUrl: 'https://api.minimax.io/anthropic' },
  { provider: 'minimax-cn', baseUrl: 'https://api.minimaxi.com/anthropic' },
];

test('MiniMax Token Plan models resolve offline with exact identities and isolated credentials', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline catalog test must never fetch'); };
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({
        'minimax': { type: 'api_key', key: 'synthetic-test-key' },
        'minimax-cn': { type: 'api_key', key: 'synthetic-test-key-cn' },
      }),
      modelsPath: null, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false,
    });
    for (const { provider, baseUrl } of REGIONS) {
      for (const expected of EXPECTED) {
        const model = runtime.getModel(provider, expected.id);
        assert.ok(model, `${provider}/${expected.id} must not require a session-only custom model`);
        assert.equal(model.provider, provider);
        assert.equal(model.id, expected.id);
        assert.equal(model.baseUrl, baseUrl);
        assert.equal(model.contextWindow, expected.contextWindow);
        assert.equal(model.maxTokens, expected.maxTokens);
        assert.deepEqual(model.input, expected.input);
        assert.equal(model.reasoning, true);
        assert.equal(model.cost.input, expected.cost.input);
        assert.equal(model.cost.output, expected.cost.output);
        assert.equal(model.cost.cacheRead, expected.cost.cacheRead);
        assert.equal(model.cost.cacheWrite, expected.cost.cacheWrite);
      }
    }
    const available = runtime.getAvailableSnapshot().filter(model => model.provider.startsWith('minimax'));
    for (const { provider } of REGIONS) {
      for (const expected of EXPECTED) {
        assert.ok(available.some(model => model.provider === provider && model.id === expected.id),
          `${provider}/${expected.id} must be listed as available`);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});
