import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmaker-config-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, 'preferences.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
const prefs = await import('../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
const { resolveWatchmakerPreferenceChain: resolve } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts');
const file = process.env.PI_LLM_PREFERENCES_FILE;
const model = { provider: 'deepseek', id: 'deepseek-flash', fullId: 'deepseek/deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1',
  reasoning: true, thinkingLevelMap: { off: 'none', low: 'low' }, input: ['text'], contextWindow: 65536, maxTokens: 8192, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
const write = doc => { fs.writeFileSync(file, JSON.stringify(doc)); prefs.clearLlmPreferencesCache(); };
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('absent watchmaker role selects only exact official DeepSeek Flash with low thinking', () => {
  fs.rmSync(file, { force: true });
  const result = resolve([model]);
  assert.equal(result.source, 'default'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.routes.map(route => [route.route, route.thinking]), [[model.fullId, 'low']]);
  for (const models of [[], [{ ...model, provider: 'openrouter', fullId: `openrouter/${model.id}` }], [{ ...model, baseUrl: 'https://proxy.invalid/v1' }]]) {
    assert.equal(resolve(models).status, 'unavailable'); assert.deepEqual(resolve(models).routes, []);
  }
  write({ preferences: { subagents: { models: [{ provider: 'openrouter', model: model.id }] } } });
  assert.equal(resolve([]).status, 'unavailable', 'watchmaker never inherits another role');
});

test('explicit watchmaker opt-out and malformed documents never enable a default', () => {
  for (const spec of [[], { models: [] }]) {
    write({ preferences: { watchmaker: spec } });
    assert.equal(resolve([model]).status, 'disabled');
  }
  write({ preferences: { 'Mr Watchmaker': [] } });
  assert.equal(resolve([model]).status, 'disabled', 'display-name alias normalizes to the role');
  for (const doc of [{ preferences: { watchmaker: { models: ['missing-alias'] } } }, { preferences: { watchmaker: 'broken' } }]) {
    write(doc); assert.equal(resolve([model]).status, 'unavailable');
  }
  fs.writeFileSync(file, '{broken'); assert.equal(resolve([model]).status, 'unavailable');
});

test('configured watchmaker routes preserve order and thinking', () => {
  const other = { ...model, provider: 'openrouter', id: 'vendor/watch', fullId: 'openrouter/vendor/watch', baseUrl: 'https://openrouter.ai/api/v1' };
  write({ preferences: { watchmaker: { models: [{ provider: other.provider, model: other.id, thinking: 'low' }, { provider: model.provider, model: model.id, thinking: 'low' }] } } });
  const result = resolve([model, other]);
  assert.equal(result.source, 'watchmaker'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.routes.map(route => route.route), [other.fullId, model.fullId]);
  assert.equal(result.routes[0].thinking, 'low');
  const skipped = [];
  assert.equal(resolve([{ ...other, reasoning: false }], { onSkip: event => skipped.push(event) }).status, 'unavailable');
  assert.ok(skipped.some(item => item.role === 'watchmaker'), 'skip diagnostics carry the watchmaker role');
});
