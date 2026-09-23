import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-config-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, 'preferences.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
const prefs = await import('../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
const { resolveSessionObserverPreferenceChain: resolve } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts');
const file = process.env.PI_LLM_PREFERENCES_FILE;
const model = { provider: 'deepseek', id: 'deepseek-flash', fullId: 'deepseek/deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1',
  reasoning: true, thinkingLevelMap: { off: 'none', high: 'high' }, input: ['text'], contextWindow: 65536, maxTokens: 8192, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
const write = doc => { fs.writeFileSync(file, JSON.stringify(doc)); prefs.clearLlmPreferencesCache(); };
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('absent role selects only exact official DeepSeek Flash with high thinking', () => {
  fs.rmSync(file, { force: true });
  const result = resolve([model]);
  assert.equal(result.source, 'default'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.routes.map(route => [route.route, route.thinking]), [[model.fullId, 'high']]);
  for (const models of [[], [{ ...model, provider: 'openrouter', fullId: `openrouter/${model.id}` }], [{ ...model, id: 'deepseek-flash-v2', fullId: 'deepseek/deepseek-flash-v2' }], [{ ...model, baseUrl: 'https://proxy.invalid/v1' }], [{ ...model, reasoning: false }]]) {
    assert.equal(resolve(models).status, 'unavailable'); assert.deepEqual(resolve(models).routes, []);
  }
  write({ preferences: { subagents: { models: [{ provider: 'openrouter', model: model.id }] } } });
  assert.equal(resolve([]).status, 'unavailable', 'observer never inherits another role');
});

test('explicit observer opt-out and malformed documents never enable a default', () => {
  for (const spec of [[], { models: [] }]) {
    write({ preferences: { 'Session Observer': spec } });
    assert.equal(resolve([model]).status, 'disabled');
  }
  for (const doc of [{ preferences: { session_observer: { models: ['missing-alias'] } } }, { preferences: { session_observer: 'broken' } }, { preferences: { session_observer: [], 'Session-Observer': [] } }]) {
    write(doc); assert.equal(resolve([model]).status, 'unavailable');
  }
  fs.writeFileSync(file, '{broken'); assert.equal(resolve([model]).status, 'unavailable');
  for (const thinking of ['unknown', 42]) {
    write({ preferences: { session_observer: { models: [{ provider: model.provider, model: model.id, thinking }] } } });
    assert.equal(resolve([model]).status, 'unavailable', 'invalid thinking never becomes an enabled dynamic request');
  }
  write({ preferences: { session_observer: { models: ['missing-alias', { provider: model.provider, model: model.id }] } } });
  assert.equal(resolve([model]).status, 'unavailable', 'mixed malformed explicit lists fail closed');
});

test('configured observer routes preserve aliases, order, thinking and backend constraints', () => {
  const other = { ...model, provider: 'openrouter', id: 'vendor/observer', fullId: 'openrouter/vendor/observer', baseUrl: 'https://openrouter.ai/api/v1' };
  write({ models: { observer: { provider: 'openrouter', model: other.id, thinking: 'high', provider_options: { routing: 'pinned', order: ['fixture-backend'] } } },
    preferences: { session_observer: { models: ['observer', { provider: model.provider, model: model.id, thinking: 'high' }] } } });
  const result = resolve([model, other]);
  assert.equal(result.source, 'session_observer'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.routes.map(route => route.route), [other.fullId, model.fullId]);
  assert.equal(result.routes[0].thinking, 'high');
  assert.deepEqual(result.routes[0].providerRouting, { order: ['fixture-backend'], only: ['fixture-backend'], allow_fallbacks: false });
  assert.equal(resolve([{ ...other, reasoning: false }]).status, 'unavailable', 'configured thinking is not silently downgraded');
  assert.doesNotThrow(() => resolve([{ ...other, reasoning: false }], { onSkip: () => { throw Error('diagnostic failed'); } }));
});

test('observer aliases require exact model IDs and an unambiguous provider', () => {
  const other = { ...model, provider: 'fixture', id: 'vendor/observer-v2', fullId: 'fixture/vendor/observer-v2', baseUrl: 'https://fixture.invalid/v1' };
  write({ models: { observer: { provider: other.provider, model: 'vendor/observer', thinking: 'high' } }, preferences: { session_observer: { models: ['observer'] } } });
  assert.equal(resolve([other]).status, 'unavailable', 'near-match never replaces configured ID');
  write({ preferences: { session_observer: { models: [{ model: other.id, thinking: 'high' }] } } });
  assert.equal(resolve([other]).routes[0]?.route, other.fullId, 'unique exact bare ID remains compatible');
  assert.equal(resolve([other, { ...other, provider: 'alternate', fullId: `alternate/${other.id}` }]).status, 'unavailable', 'ambiguous provider must be explicit');
  write({ preferences: { session_observer: { models: [{ provider: other.provider, model: other.fullId + ':high' }] } } });
  assert.equal(resolve([other]).routes[0]?.thinking, 'high', 'qualified IDs and supported suffixes remain compatible');
  const namespaced = { ...other, id: 'fixture/observer', fullId: 'fixture/fixture/observer' };
  write({ preferences: { session_observer: { models: [{ provider: namespaced.provider, model: namespaced.id, thinking: 'high' }] } } });
  assert.equal(resolve([namespaced]).routes[0]?.route, namespaced.fullId, 'vendor namespace matching its provider remains part of the exact model ID');
  write({ preferences: { session_observer: { models: [{ provider: model.provider, model: model.fullId + ':high' }] } } });
  assert.equal(resolve([{ ...model, baseUrl: 'https://proxy.invalid/v1' }]).status, 'unavailable', 'qualified official IDs cannot bypass the official endpoint restriction');
});

test('observer admission requires bounded output and the shared packet capacity without changing legacy roles', async () => {
  const codex = { ...model, provider: 'openai-codex', id: 'fixture-codex', fullId: 'openai-codex/fixture-codex', baseUrl: 'https://fixture.invalid/v1', api: 'openai-codex-responses' };
  const entry = { provider: codex.provider, model: codex.id, thinking: 'high' };
  write({ preferences: { session_observer: { models: [entry] }, subagents: { models: [entry] } } });
  const skipped = [];
  assert.equal(resolve([codex], { onSkip: item => skipped.push(item) }).status, 'unavailable');
  assert.ok(skipped.some(item => item.reason === 'API cannot enforce the observer output limit'));
  const { resolveLlmPreferenceChain } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts');
  assert.equal(resolveLlmPreferenceChain('subagents', [codex])[0]?.route, codex.fullId, 'ordinary model roles keep Codex support');
  write({ preferences: { session_observer: { models: [{ provider: model.provider, model: model.id, thinking: 'high' }] } } });
  for (const bounds of [{ contextWindow: 12287, maxTokens: 4096 }, { contextWindow: 12288, maxTokens: 4095 }]) {
    assert.equal(resolve([{ ...model, ...bounds }], { requirements: { minContextWindow: 1, minOutputTokens: 1 } }).status, 'unavailable', 'callers cannot weaken observer admission');
  }
  assert.equal(resolve([{ ...model, contextWindow: 12288, maxTokens: 4096 }]).status, 'ready');
});

test('deployment default insertion preserves user JSON, backup and explicit disabled role', async () => {
  const doc = { version: 1, models: { keep: { provider: 'example', model: 'model', privateFutureField: { retained: true } } },
    preferences: { subagents: { models: ['keep'], futureRoleField: 'retained' } }, futureTopField: { retained: true } };
  write(doc); const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(await prefs.ensureSessionObserverPreference(file), { ok: true, revision: prefs.readLlmPreferencesDocument(file).revision, changed: true });
  const inserted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(inserted.preferences.session_observer.models, [{ provider: 'deepseek', model: 'deepseek-flash', thinking: 'high' }]);
  delete inserted.preferences.session_observer; assert.deepEqual(inserted, doc);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before);
  assert.equal((await prefs.ensureSessionObserverPreference(file)).changed, false);
  write({ ...doc, preferences: { ...doc.preferences, 'Session-Observer': { models: [] } } });
  const disabled = fs.readFileSync(file, 'utf8');
  assert.equal((await prefs.ensureSessionObserverPreference(file)).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), disabled);
  fs.writeFileSync(file, '{broken'); assert.equal((await prefs.ensureSessionObserverPreference(file)).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
