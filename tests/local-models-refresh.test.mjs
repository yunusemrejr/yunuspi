import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..', 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/local-models.ts')),
);
const { registerLocalModels } = await import(pathToFileURL(path.join(agent, 'extensions/lib/local-models.ts')));

test('a cancelled local catalog caller does not abort a concurrent live refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-model-refresh-'));
  const previousFetch = globalThis.fetch;
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { 'ollama-local': {} } }));
    let resolveFetch;
    globalThis.fetch = async (_url, init) => new Promise((resolve, reject) => {
      resolveFetch = () => resolve(new Response(JSON.stringify({ models: [{ name: 'tiny', context_length: 4096 }] })));
      init.signal.addEventListener('abort', () => reject(new Error('unexpected shared abort')), { once: true });
    });
    const providers = {};
    registerLocalModels({ registerProvider: (id, provider) => { providers[id] = provider; } }, dir);
    const refresh = providers['ollama-local'].refreshModels;
    const cancelled = new AbortController();
    const first = refresh({ signal: cancelled.signal, allowNetwork: true, force: true });
    const second = refresh({ signal: new AbortController().signal, allowNetwork: true, force: true });
    cancelled.abort();
    resolveFetch();
    assert.deepEqual(await first, [], 'the cancelled caller keeps its empty local view');
    assert.equal((await second).map((model) => model.id).join(','), 'tiny');
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancelled refresh cannot overwrite a newer catalog after delayed parsing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-model-refresh-stale-'));
  const previousFetch = globalThis.fetch;
  try {
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { 'ollama-local': {} } }));
    const requests = [];
    globalThis.fetch = async (_url, init) => new Promise((resolve) => {
      requests.push({ init, resolve });
    });
    const providers = {};
    registerLocalModels({ registerProvider: (id, provider) => { providers[id] = provider; } }, dir);
    const refresh = providers['ollama-local'].refreshModels;
    const cancelled = new AbortController();
    const first = refresh({ signal: cancelled.signal, allowNetwork: true, force: true });
    cancelled.abort();
    const second = refresh({ signal: new AbortController().signal, allowNetwork: true, force: true });
    assert.equal(requests.length, 2);
    requests[1].resolve(new Response(JSON.stringify({ models: [{ name: 'new', context_length: 4096 }] })));
    assert.equal((await second).map((model) => model.id).join(','), 'new');
    requests[0].resolve(new Response(JSON.stringify({ models: [{ name: 'stale', context_length: 4096 }] })));
    assert.deepEqual(await first, [], 'the cancelled caller keeps its empty local view');
    assert.equal((await refresh({ signal: new AbortController().signal, allowNetwork: true })).map((model) => model.id).join(','), 'new');
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
