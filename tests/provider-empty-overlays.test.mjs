import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelConfig } from '../core/coding-agent/src/core/model-config.js';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { composeModelProvider } from '../core/coding-agent/src/core/provider-composer.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';
import { InMemoryCredentialStore } from '../core/ai/src/auth/credential-store.js';
import { metaProvider } from '../core/ai/src/providers/meta.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-overlays-'));
const configPath = path.join(temporary, 'models.json');
test.after(() => fs.rm(temporary, { recursive: true, force: true }));
async function writeConfig(providers) {
  await fs.writeFile(configPath, JSON.stringify({ providers }));
  const config = await ModelConfig.load(configPath);
  assert.equal(config.getError(), undefined);
  return config;
}

test('empty native provider overlays retain native catalog and stored authentication without errors', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('meta', () => ({ type: 'api_key', key: 'synthetic-fixture-key' }));
  const native = metaProvider();
  for (const overlay of [{}, { models: [] }, { modelOverrides: {} }, { models: [], modelOverrides: {} }]) {
    const config = await writeConfig({ meta: overlay });
    const before = await fs.readFile(configPath, 'utf8');
    const composed = composeModelProvider('meta', native, config);
    assert.deepEqual(composed.getModels(), native.getModels());
    assert.equal(composed.auth.oauth.name, native.auth.oauth.name);
    const runtime = await ModelRuntime.create({ credentials, modelsPath: configPath, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false });
    assert.equal(runtime.getError(), undefined);
    assert.deepEqual(runtime.getModels().filter(model => model.provider === 'meta').map(model => model.id), native.getModels().map(model => model.id));
    assert.equal(runtime.getProviderAuthStatus('meta').configured, true);
    const model = runtime.getModels().find(model => model.provider === 'meta');
    assert.ok(model);
    assert.equal((await runtime.getAuth(model)).auth.apiKey, 'synthetic-fixture-key');
    assert.equal(await fs.readFile(configPath, 'utf8'), before, 'reading no-op overlays does not rewrite user configuration');
    assert.equal((await credentials.read('meta')).key, 'synthetic-fixture-key');
  }
});

test('nonempty overrides still apply and incomplete custom definitions still report errors', async () => {
  const native = metaProvider(), first = native.getModels()[0];
  assert.ok(first);
  const configured = await writeConfig({ meta: { modelOverrides: { [first.id]: { name: 'Synthetic display name', maxTokens: 1234 } } } });
  const composed = composeModelProvider('meta', native, configured);
  assert.equal(composed.getModels()[0].name, 'Synthetic display name');
  assert.equal(composed.getModels()[0].maxTokens, 1234);
  for (const overlay of [{}, { models: [] }, { modelOverrides: {} }]) {
    const config = await writeConfig({ 'unknown-custom-provider': overlay });
    assert.throws(() => composeModelProvider('unknown-custom-provider', undefined, config), /must specify/);
  }
  const malformed = await writeConfig({ meta: { oauth: 'radius' } });
  assert.throws(() => composeModelProvider('meta', native, malformed), /baseUrl.*required/);
});

test('clearing the final provider pin prunes only empty containers and preserves other settings', async () => {
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporary;
  try {
    const { default: register } = await import('../agent/extensions/provider-cmd.ts');
    const commands = new Map();
    await register({ registerCommand: (name, options) => commands.set(name, options) });
    const model = { provider: 'openrouter', id: 'fixture/model' };
    const ctx = { model, ui: { notify() {} }, modelRegistry: { refresh: async () => {}, getAll: () => [model], getAvailable: () => [model] } };
    const pin = { compat: { openRouterRouting: { only: ['fixture-upstream'], allow_fallbacks: false } } };
    for (const extra of [{}, { baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-fixture-key' }, { modelOverrides: { other: { maxTokens: 1234 } } }]) {
      await writeConfig({ openrouter: { ...extra, modelOverrides: { ...extra.modelOverrides, [model.id]: structuredClone(pin) } }, meta: {} });
      await commands.get('provider').handler('clear', ctx);
      const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.deepEqual(written.providers.meta, {}, 'clearing a pin cannot rewrite unrelated providers');
      if (!Object.keys(extra).length) assert.equal(written.providers.openrouter, undefined);
      else assert.deepEqual(written.providers.openrouter, extra);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
  }
});
