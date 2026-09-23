import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelConfig } from '../core/coding-agent/src/core/model-config.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';
import { composeModelProvider } from '../core/coding-agent/src/core/provider-composer.js';
import { withRemoteCatalog } from '../core/coding-agent/src/core/remote-catalog-provider.js';

const providerId = 'fixture-sgp';
const generatedAt = 1_800_000_000_000;
const baseline = ['stable', 'stable-pro'].map(id => ({
  id, name: id, provider: providerId, api: 'openai-completions',
  baseUrl: 'https://provider.invalid/v1', reasoning: true, input: ['text'],
  contextWindow: 100000, maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
}));
const cachedModels = [...baseline, ...['next-flash', 'next-pro'].map(id => ({ ...baseline[0], id, name: id }))];
const catalogUrl = 'https://catalog.invalid';
const wrap = () => withRemoteCatalog({ id: providerId, auth: {}, getModels: () => baseline }, catalogUrl, generatedAt);
async function refresh(provider, store, allowNetwork = false, force = false) {
  await provider.refreshModels({
    stored: await store.read(providerId), allowNetwork, force,
    signal: new AbortController().signal,
    publish: async ({ persist, update }) => {
      if (persist) await store.write(providerId, persist);
      update?.();
      return true;
    },
  });
}

test('empty custom model list and endpoint overrides preserve restored native catalog additions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-composition-'));
  try {
    const configPath = path.join(directory, 'models.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: { [providerId]: {
      api: 'openai-completions', apiKey: 'synthetic-fixture-key',
      baseUrl: 'https://regional.provider.invalid/v1', models: [],
    } } }));
    const config = await ModelConfig.load(configPath);
    assert.equal(config.getError(), undefined);
    const store = new InMemoryCodingAgentModelsStore();
    await store.write(providerId, { models: cachedModels, lastModified: generatedAt + 1000 });
    const composed = composeModelProvider(providerId, wrap(), config);
    await refresh(composed, store);
    assert.deepEqual(composed.getModels().map(model => model.id), cachedModels.map(model => model.id));
    assert.ok(composed.getModels().every(model => model.baseUrl === 'https://regional.provider.invalid/v1'));
    assert.equal(composed.getModels().find(model => model.id === 'next-flash').maxTokens, 8192);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unavailable catalog endpoints preserve good cached provenance across restart and revalidation', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 501]) {
      for (const provenance of [{ lastModified: generatedAt + 1000 }, { validatedAt: generatedAt + 1000 }]) {
        const store = new InMemoryCodingAgentModelsStore();
        const cached = { models: cachedModels, ...provenance, etag: '"fixture-version"', checkedAt: 1 };
        await store.write(providerId, cached);
        globalThis.fetch = async (url, options) => {
          assert.equal(new URL(url).origin, catalogUrl);
          assert.equal(new Headers(options.headers).get('if-none-match'), cached.etag);
          return new Response(null, { status });
        };
        const first = wrap();
        await refresh(first, store, true, true);
        const persisted = await store.read(providerId);
        assert.deepEqual(persisted.models, cached.models);
        assert.equal(persisted.lastModified, cached.lastModified, `${status} cannot erase last-modified`);
        assert.equal(persisted.validatedAt, cached.validatedAt, `${status} cannot erase body validation time`);
        assert.equal(persisted.etag, cached.etag);
        assert.ok(persisted.checkedAt > cached.checkedAt);
        const restarted = wrap();
        await refresh(restarted, store);
        assert.equal(restarted.getModels().length, 4, `${status} cannot make cached models disappear on restart`);
        globalThis.fetch = async (_url, options) => {
          assert.equal(new Headers(options.headers).get('if-none-match'), cached.etag);
          return new Response(null, { status: 304 });
        };
        await refresh(restarted, store, true, true);
        assert.equal(restarted.getModels().length, 4);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a recent failed catalog check never promotes stale or unproven model bodies over newer built-ins', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    for (const provenance of [{ lastModified: 0 }, { lastModified: generatedAt - 1 }, {}]) {
      const store = new InMemoryCodingAgentModelsStore();
      await store.write(providerId, { models: cachedModels, ...provenance, checkedAt: Date.now() });
      await refresh(wrap(), store, true, true);
      const restarted = wrap();
      await refresh(restarted, store);
      assert.deepEqual(restarted.getModels(), baseline);
      assert.equal((await store.read(providerId)).validatedAt, undefined);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('offline catalogs require numeric positive provenance even without a built-in generation date', async () => {
  for (const localGeneratedAt of [generatedAt, undefined]) {
    for (const field of ['lastModified', 'validatedAt']) {
      for (const timestamp of [undefined, null, 'unknown', String(generatedAt + 1000), NaN, Infinity, -1, 0, 1.5, {}, []]) {
        const store = new InMemoryCodingAgentModelsStore();
        await store.write(providerId, { models: cachedModels, [field]: timestamp, checkedAt: Date.now() });
        const provider = withRemoteCatalog({ id: providerId, getModels: () => baseline }, catalogUrl, localGeneratedAt);
        await refresh(provider, store);
        assert.deepEqual(provider.getModels(), baseline, `reject ${field}=${String(timestamp)}, generatedAt=${localGeneratedAt}`);
      }
      const store = new InMemoryCodingAgentModelsStore();
      await store.write(providerId, { models: cachedModels, [field]: generatedAt + 1000 });
      const provider = withRemoteCatalog({ id: providerId, getModels: () => baseline }, catalogUrl, localGeneratedAt);
      await refresh(provider, store);
      assert.equal(provider.getModels().length, 4, `valid ${field} remains usable`);
    }
  }
});
