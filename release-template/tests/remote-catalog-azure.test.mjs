import test from 'node:test';
import assert from 'node:assert/strict';
import { withRemoteCatalog } from '../core/coding-agent/src/core/remote-catalog-provider.js';

const azureRow = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'azure-openai-responses',
  baseUrl: '',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1050000,
  maxTokens: 128000,
};
const otherRow = {
  ...azureRow,
  id: 'some-model',
  name: 'Some Model',
  api: 'openai-completions',
};

async function refresh(providerId, payload, stored) {
  const provider = { id: providerId, getModels: () => [] };
  const wrapped = withRemoteCatalog(provider, 'https://pi.dev', Date.parse('2026-09-05T11:58:56.761Z'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'last-modified': 'Mon, 21 Sep 2026 10:29:23 GMT', etag: '"test-etag"' },
  });
  try {
    await wrapped.refreshModels({
      stored,
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish: async (p) => { if (p.update) p.update(); return true; },
    });
    return wrapped.getModels();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

test('azure-openai-responses refresh accepts empty baseUrl rows (endpoint comes from user config)', async () => {
  const models = await refresh('azure-openai-responses', { 'gpt-5.4': azureRow });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'gpt-5.4');
  assert.equal(models[0].provider, 'azure-openai-responses');
});

test('other providers still reject empty baseUrl rows', async () => {
  await assert.rejects(
    refresh('openai', { 'some-model': otherRow }),
    /Invalid or empty model catalog for provider "openai"/,
  );
});

test('cached azure overlay with empty baseUrl restores without network', async () => {
  const provider = { id: 'azure-openai-responses', getModels: () => [] };
  const wrapped = withRemoteCatalog(provider, 'https://pi.dev', Date.parse('2026-09-05T11:58:56.761Z'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network must not be used'); };
  try {
    await wrapped.refreshModels({
      stored: { models: [azureRow], checkedAt: Date.now(), lastModified: Date.parse('2026-09-08T00:00:00.000Z') },
      allowNetwork: false,
      force: false,
      signal: new AbortController().signal,
      publish: async (p) => { if (p.update) p.update(); return true; },
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
  const models = wrapped.getModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'gpt-5.4');
});
