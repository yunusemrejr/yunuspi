import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/session-export-json.ts')));
assert.ok(agent, 'session export builder must be shipped');
const { buildSessionJsonExport } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-export-json.ts')));

const assistant = (provider, model, usage, stopReason = 'stop') => ({
  type: 'message', id: `${provider}-${model}-${stopReason}`, parentId: null, timestamp: '2026-09-15T10:00:30.000Z',
  message: { role: 'assistant', provider, model, usage, stopReason, content: [{ type: 'text', text: 'ok' }] },
});
const config = (data) => ({ type: 'custom', customType: 'model-config-v1', data, id: `cfg-${data.route}`, parentId: null, timestamp: '2026-09-15T10:00:00.000Z' });
const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5 };
const branch = [
  { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-09-15T10:00:00.000Z', provider: 'deepseek', modelId: 'deepseek-flash' },
  config({ route: 'deepseek/deepseek-flash', thinking: 'max', source: 'session_start' }),
  assistant('deepseek', 'deepseek-flash', usage),
  assistant('deepseek', 'deepseek-flash', { ...usage, input: 10 }, 'error'),
  config({ route: 'openrouter/x/y', thinking: 'high', openRouterRouting: { only: ['z-ai/fp8'] }, recoveryEndpointName: 'Z.AI', source: 'model_select:user' }),
  assistant('openrouter', 'x/y', usage),
];
const header = { type: 'session', id: '01models', timestamp: '2026-09-15T10:00:00.000Z', cwd: '/tmp' };

test('export routes carry thinking levels, backend routing and endpoints per used model', () => {
  const report = buildSessionJsonExport({
    header, scope: 'branch', branch, retained: branch,
    model: { provider: 'openrouter', id: 'x/y', routing: { only: ['z-ai/fp8'] }, endpoint: 'Z.AI' }, thinkingLevel: 'high',
  });
  assert.equal(report.summary.modelsUsed, 2);
  const deepseek = report.analytics.routes.find(row => row.route === 'deepseek/deepseek-flash');
  assert.equal(deepseek.turns, 2);
  assert.equal(deepseek.errors, 1);
  assert.deepEqual(deepseek.thinkingLevels, ['max']);
  assert.deepEqual(deepseek.routingPins, []);
  assert.equal(deepseek.firstSeq, 2);
  assert.equal(deepseek.lastSeq, 3);
  const nested = report.analytics.routes.find(row => row.route === 'openrouter/x/y');
  assert.deepEqual(nested.thinkingLevels, ['high']);
  assert.deepEqual(nested.routingPins, [{ only: ['z-ai/fp8'] }]);
  assert.deepEqual(nested.endpoints, ['Z.AI']);
  assert.deepEqual(report.session.currentModel, { provider: 'openrouter', id: 'x/y', routing: { only: ['z-ai/fp8'] }, endpoint: 'Z.AI' });
  assert.equal(report.session.currentThinkingLevel, 'high');
  // Config records without any response still appear as used routes.
  const bare = buildSessionJsonExport({ header, scope: 'branch', branch: branch.slice(0, 2), retained: branch.slice(0, 2) });
  assert.equal(bare.summary.modelsUsed, 1);
  assert.deepEqual(bare.analytics.routes[0].thinkingLevels, ['max']);
});
