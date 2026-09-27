import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-resolution-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, 'preferences.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const routing = await import('../agent/extensions/pi-subagents/src/runs/shared/model-fallback.ts');
const prefs = await import('../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
const model = (provider, id) => ({ provider, id, fullId: `${provider}/${id}`, api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ['text'] });
const friendli = model('friendli', 'zai-org/GLM-5.3-Flash');
const orca = model('orcarouter', 'qwen/qwen3.8-flash');
const live = [friendli, orca, model('openrouter', 'z-ai/glm-5.3-flash')];
const write = entries => { fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ preferences: { subagents: { models: entries } } })); prefs.clearLlmPreferencesCache(); };

test('registered providers bind slash, colon and dot prefixes before vendor namespaces', () => {
  for (const query of ['friendli/zai-org/GLM-5.3-Flash', 'FRIENDLI:ZAI_ORG/glm_5_3_flash', 'friendli.z-ai/GLM-5.3-Flash', 'friendli/GLM 5.3 Flash', 'Friendli / zai-org / GLM 5.3 Flash']) {
    assert.equal(routing.fuzzyResolveModel(query, live), friendli.fullId, query);
  }
  for (const query of ['orca-router:qwen/Qwen-3_8-Flash', 'ORCA_ROUTER.qwen/QWEN3.8_FLASH']) {
    assert.equal(routing.fuzzyResolveModel(query, live), orca.fullId, query);
  }
  assert.equal(routing.fuzzyResolveModel('friendli:qwen/qwen3.8-flash', live), undefined, 'provider binding cannot switch to OrcaRouter');
  for (const missing of ['friendli/zai-org/GLM-5.3-Flash', 'friendli:zai-org/GLM-5.3-Flash', 'friendli.zai-org/GLM-5.3-Flash']) {
    assert.equal(routing.fuzzyResolveModel(missing, [live[2]]), undefined, 'missing scoped provider cannot disappear through leaf matching');
    assert.equal(routing.fuzzyResolveModel(missing, [live[2]], 'openrouter'), undefined, 'ambient preferred provider cannot override an unresolved explicit scope');
  }
  const nested = model('fixture', 'owner/team/Model-3.8');
  assert.equal(routing.fuzzyResolveModel('OWNER/TEAM/model-3_8', [nested]), nested.fullId, 'real nested vendor namespaces remain valid');
  const dotted = [model('fixture', 'vendor/model'), model('fixture.host', 'vendor/model')];
  assert.equal(routing.fuzzyResolveModel('fixture.host/vendor/MODEL', dotted), dotted[1].fullId, 'longest registered provider name wins over its dotted prefix');
});

test('precise namespaces outrank owner aliases and exact formats outrank loose matches', () => {
  const rows = [model('friendli', 'zai-org/GLM-5.3-Flash'), model('friendli', 'other/GLM-5.3-Flash')];
  assert.equal(routing.fuzzyResolveModel('FRIENDLI/ZAI_ORG/glm-5_3-flash', rows), rows[0].fullId);
  assert.equal(routing.fuzzyResolveModel('friendli/glm-5.3-flash', rows), undefined, 'bare owner ambiguity is genuine');
  assert.equal(routing.fuzzyResolveModel('friendli/z-ai/glm-5.3-flash', rows), undefined, 'owner rename cannot choose between collisions');
  const versions = [orca, model('orcarouter', 'qwen/qwen3.8-flash:free'), model('orcarouter', 'qwen/qwen3.5-flash'), model('orcarouter', 'qwen/qwen38-flash')];
  assert.equal(routing.fuzzyResolveModel('orcarouter/qwen/Qwen-3_8-flash', versions), orca.fullId);
  assert.equal(routing.fuzzyResolveModel('orcarouter/qwen/Qwen-3_8-flash:free', versions), versions[1].fullId);
  assert.equal(routing.fuzzyResolveModel('Qwen-3_8-flash:free', [versions[1]]), versions[1].fullId, 'a bare model variant is not mistaken for a provider prefix');
  assert.equal(routing.fuzzyResolveModel('orcarouter/qwen/Qwen-3_7-flash', versions), undefined);
});

test('provider normalization never chooses between distinct registered provider collisions', () => {
  const rows = [model('orca-router', 'fixture'), model('orcarouter', 'fixture')];
  assert.equal(routing.fuzzyResolveModel('orca-router/fixture', rows), rows[0].fullId);
  assert.equal(routing.fuzzyResolveModel('ORCAROUTER/fixture', rows), rows[1].fullId);
  assert.equal(routing.fuzzyResolveModel('orca_router/fixture', rows), undefined);
});

test('date formatting is tolerated but explicit revisions and model variants stay distinct', () => {
  const rows = [model('fixture', 'vendor/model-20260101'), model('fixture', 'vendor/model-20260201')];
  assert.equal(routing.fuzzyResolveModel('fixture/vendor/model-2026-01-01', rows), rows[0].fullId);
  assert.equal(routing.fuzzyResolveModel('fixture/vendor/model-20260301', rows), undefined);
  assert.equal(routing.fuzzyResolveModel('fixture/vendor/model', rows), undefined);
  assert.equal(routing.fuzzyResolveModel('fixture/vendor/model', [rows[0]]), rows[0].fullId);
});

test('preference chain returns canonical dispatch identities while retaining thinking and backend pins', () => {
  assert.deepEqual(routing.splitThinkingSuffix('vendor/model:FREE'), { baseModel: 'vendor/model:FREE', thinkingSuffix: '' });
  write([{ provider: 'FRIENDLI', model: 'z-ai/GLM_5_3_FLASH', thinking: 'high' },
    { provider: 'orca-router', model: 'qwen/Qwen-3_8-flash:HIGH' },
    { provider: 'openrouter', model: 'Z_AI/GLM_5_3_flash', provider_options: { routing: 'pinned', order: ['fixture-backend'] } }]);
  const routes = routing.resolveLlmPreferenceChain('subagents', live);
  assert.deepEqual(routes.map(row => row.route), [friendli.fullId, orca.fullId, live[2].fullId]);
  assert.deepEqual(routes.slice(0, 2).map(row => row.thinking), ['high', 'high']);
  assert.deepEqual(routes[2].providerRouting, { order: ['fixture-backend'], only: ['fixture-backend'], allow_fallbacks: false });
  for (const row of routes) assert.ok(live.some(model => model.fullId === row.route), 'dispatch uses an actual catalog identifier');
  write([{ provider: 'missing-provider', model: orca.id }]);
  assert.deepEqual(routing.resolveLlmPreferenceChain('subagents', live), []);
});

test('observer accepts only unambiguous full model formatting, retaining its strict route boundary', () => {
  const observer = entry => { fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ models: { observer: entry }, preferences: { session_observer: { models: ['observer'] } } })); prefs.clearLlmPreferencesCache(); };
  observer({ provider: 'orca-router', model: 'QWEN / Qwen-3_8-Flash', thinking: 'high' });
  let selected = routing.resolveSessionObserverPreferenceChain(live);
  assert.equal(selected.routes[0]?.route, orca.fullId);
  assert.equal(selected.routes[0]?.thinking, 'high');
  for (const entry of [{ provider: 'orcarouter', model: 'qwen/qwen3.7-flash' }, { provider: 'friendli', model: 'z-ai/GLM-5.3-Flash' }, { provider: 'missing-provider', model: orca.id }]) {
    observer(entry);
    assert.equal(routing.resolveSessionObserverPreferenceChain(live).status, 'unavailable');
  }
  observer({ provider: 'fixture', model: 'vendor/model' });
  assert.equal(routing.resolveSessionObserverPreferenceChain([model('fixture', 'vendor/model-20260101')]).status, 'unavailable', 'observer never uses undated revision aliases');
  observer({ provider: 'fixture', model: 'vendor/MODEL.3.8' });
  assert.equal(routing.resolveSessionObserverPreferenceChain([model('fixture', 'vendor/Model-3.8'), model('fixture', 'vendor/Model_3_8')]).status, 'unavailable', 'format collisions remain ambiguous');
});

test('local child catalog failures permit unused admitted routes without excluding providers or replaying work', () => {
  const errors = [
    `Model "${orca.fullId}" not found. Use --list-models to see available models.`,
    `Error: Model "${friendli.fullId}" not found. Use --list-models to see available models.`,
  ];
  for (const error of errors) {
    assert.equal(routing.isRetryableModelFailure(error), true);
    assert.equal(routing.isRetryableModelFailureAttempt({ error, messages: [], toolCount: 0 }), true);
    assert.equal(routing.isRetryableModelFailureAttempt({ error, messages: [], toolCount: 1 }), false);
    assert.equal(routing.isRetryableModelFailureAttempt({ error, messages: [{ role: 'assistant', errorMessage: error }], toolCount: 0 }), false);
    routing.recordRetryableModelFailure(orca.fullId, error);
  }
  assert.equal(fs.existsSync(process.env.PI_MODEL_EXCLUSIONS_PATH), false);
  assert.equal(routing.isRetryableModelFailure('HTTP 404: model not found by upstream provider'), true, 'real provider rejection still permits bounded recovery');
});

test('transient provider failures exclude a route for their stated wait, never a day', () => {
  const gate = '429 rate limit: provider-gate cannot safely attribute model z-ai/glm-5.3-flash; candidate orcarouter/z-ai/glm-5.3-flash is cooling (595s; state: provider-health.json)';
  assert.equal(routing.transientExclusionTtlMs(gate), 595_000);
  assert.equal(routing.transientExclusionTtlMs('HTTP 429 Too Many Requests; retry-after: 5'), 30_000, 'stated waits have a floor');
  assert.equal(routing.transientExclusionTtlMs('503 service unavailable'), 15 * 60_000);
  for (const durable of ['401 unauthorized: invalid api key', '429 quota exceeded for this billing period', 'HTTP 404: model not found by upstream provider', 'usage limit reached']) {
    assert.equal(routing.transientExclusionTtlMs(durable), undefined, durable);
  }
  const before = Date.now();
  routing.recordRetryableModelFailure('orcarouter/z-ai/glm-5.3-flash', gate);
  const stored = JSON.parse(fs.readFileSync(process.env.PI_MODEL_EXCLUSIONS_PATH, 'utf8')).exclusions.find(entry => entry.modelId === 'z-ai/glm-5.3-flash');
  assert.ok(stored.expiresAt - before <= 600_000 && stored.expiresAt - before >= 590_000, 'the exclusion ends with the provider cooldown');
});

test('stores written before transient TTLs heal on load', async () => {
  const exclusions = await import('../agent/extensions/pi-subagents/src/runs/shared/model-exclusions.ts');
  const recordedAt = Date.now() - 20 * 60_000;
  fs.writeFileSync(process.env.PI_MODEL_EXCLUSIONS_PATH, JSON.stringify({ version: 1, exclusions: [
    { modelId: 'z-ai/glm-5.3-flash', provider: 'orcarouter', reason: '429 rate limit: candidate orcarouter/z-ai/glm-5.3-flash is cooling (595s; state: provider-health.json)', recordedAt, expiresAt: recordedAt + 864e5 },
    { modelId: 'vendor/gone', provider: 'orcarouter', reason: 'HTTP 404: model not found', recordedAt, expiresAt: recordedAt + 864e5 },
  ] }));
  assert.equal(exclusions.isExcluded('z-ai/glm-5.3-flash', 'orcarouter'), false, 'an elapsed cooldown no longer blocks the route');
  assert.equal(exclusions.isExcluded('vendor/gone', 'orcarouter'), true, 'catalog failures keep their day-long exclusion');
});
