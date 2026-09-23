import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';

// Official regional endpoints and capabilities:
// https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access
// https://mimo.mi.com/docs/en-US/tokenplan/integration/opencode
test('MiMo 2.6 Token Plan models resolve offline with exact regional identities and isolated credentials', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline catalog test must never fetch'); };
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({ 'xiaomi-token-plan-sgp': { type: 'api_key', key: 'synthetic-test-key' } }),
      modelsPath: null, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false,
    });
    for (const region of ['sgp', 'ams', 'cn']) {
      const provider = `xiaomi-token-plan-${region}`;
      for (const suffix of ['flash', 'pro']) {
        const id = `mimo-v2.6-${suffix}`;
        const model = runtime.getModel(provider, id);
        assert.ok(model, `${provider}/${id} must not require a session-only custom model`);
        assert.equal(model.provider, provider);
        assert.equal(model.id, id);
        assert.equal(model.baseUrl, `https://token-plan-${region}.xiaomimimo.com/v1`);
        assert.equal(model.contextWindow, 1048576);
        assert.equal(model.maxTokens, 131072);
        assert.deepEqual(model.input, ['text', 'image']);
        assert.equal(model.reasoning, true);
        assert.equal(model.compat.thinkingFormat, 'deepseek');
      }
    }
    const available = runtime.getAvailableSnapshot().filter(model => model.provider.startsWith('xiaomi'));
    assert.ok(available.some(model => model.id === 'mimo-v2.6-flash'));
    assert.ok(available.every(model => model.provider === 'xiaomi-token-plan-sgp'), 'regional and pay-as-you-go credentials are never substituted');
  } finally { globalThis.fetch = originalFetch; }
});
