import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/model-config.ts')));
assert.ok(agent, 'model config recorder must be shipped');
const { default: modelConfig } = await import(pathToFileURL(path.join(agent, 'extensions/model-config.ts')));

const setup = (thinking = 'high') => {
  const handlers = new Map();
  const appended = [];
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    appendEntry: (type, data) => appended.push({ type, data }),
    getThinkingLevel: () => thinking,
  };
  modelConfig(pi);
  const emit = (name, event, ctx) => Promise.all((handlers.get(name) ?? []).map(fn => fn(event, ctx)));
  return { appended, emit };
};
const orModel = { provider: 'openrouter', id: 'x/y', compat: { openRouterRouting: { only: ['z-ai/fp8'], allow_fallbacks: false }, recoveryEndpointName: 'Z.AI' } };

test('selection boundaries record route, thinking and nested provider routing', async () => {
  const { appended, emit } = setup();
  const ctx = { model: orModel, sessionManager: { getBranch: () => [] } };
  await emit('session_start', {}, ctx);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].data, {
    route: 'openrouter/x/y', thinking: 'high',
    openRouterRouting: { only: ['z-ai/fp8'], allow_fallbacks: false },
    recoveryEndpointName: 'Z.AI', source: 'session_start',
  });
  await emit('thinking_level_select', { level: 'max' }, ctx);
  assert.equal(appended.length, 2);
  assert.equal(appended[1].data.thinking, 'max');
  const plain = { provider: 'deepseek', id: 'deepseek-flash' };
  await emit('model_select', { model: plain, source: 'user' }, { ...ctx, model: plain });
  assert.equal(appended.length, 3);
  assert.deepEqual(appended[2].data, { route: 'deepseek/deepseek-flash', thinking: 'high', source: 'model_select:user' });
});

test('consecutive duplicates collapse across repeats and reloads', async () => {
  const { appended, emit } = setup('max');
  const plain = { provider: 'deepseek', id: 'deepseek-flash' };
  const ctx = { model: plain, sessionManager: { getBranch: () => [] } };
  await emit('model_select', { model: plain, source: 'set' }, ctx);
  await emit('model_select', { model: plain, source: 'set' }, ctx);
  assert.equal(appended.length, 1);
  await emit('session_start', {}, { model: plain, sessionManager: { getBranch: () => appended.map(a => ({ type: 'custom', customType: a.type, data: a.data })) } });
  assert.equal(appended.length, 1, 'reload with the same selection appends nothing');
  await emit('model_select', { model: orModel, source: 'user' }, { ...ctx, model: orModel });
  assert.equal(appended.length, 2, 'a changed selection records again');
});

test('missing models and oversized routing never produce entries', async () => {
  const { appended, emit } = setup();
  await emit('session_start', {}, { sessionManager: { getBranch: () => [] } });
  await emit('model_select', { source: 'user' }, { model: { provider: 'x' } });
  assert.equal(appended.length, 0);
  const huge = { provider: 'openrouter', id: 'x/y', compat: { openRouterRouting: { blob: 'z'.repeat(4096) } } };
  await emit('model_select', { model: huge, source: 'user' }, { model: huge, sessionManager: { getBranch: () => [] } });
  assert.equal(appended.length, 1);
  assert.ok(!('openRouterRouting' in appended[0].data));
});
