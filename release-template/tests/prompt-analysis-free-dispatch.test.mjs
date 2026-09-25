import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeSimple } from '@yunuspi/ai/compat';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-analysis-free-wire-'));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_LLM_PREFERENCES_FILE = path.join(directory, 'llm_preferences.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(directory, 'exclusions.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'health.json');
delete process.env.PI_MICRO_INTELLIGENCE;
delete process.env.PI_SUBAGENT_CHILD;
const { default: microIntelligence, lastMicroRequest, settleMicroAnalyses } = await import('../agent/extensions/micro-intelligence.ts');
const { clearLlmPreferencesCache } = await import('../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
const evidence = await import('../agent/extensions/pi-subagents/src/runs/shared/free-route-evidence.ts');
let sequence = 0;
const model = { id: 'fixture/advisor', provider: 'openrouter', name: 'Fixture advisor', api: 'openai-completions',
  baseUrl: evidence.FREE_BASE_URL, contextWindow: 65536, maxTokens: 4096, reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: 'max_completion_tokens' } };
const publish = (price = '0') => evidence.publishFreeEvidence([{ id: model.id,
  pricing: { prompt: price, completion: price }, capabilities: { contextWindow: 65536, maxTokens: 4096, toolCalling: false } }], evidence.FREE_CATALOG_URL);

async function run({ mode = 'registry', paid = false, beforeDispatch, rewritePayload, overrideModel } = {}) {
  const selected = paid ? { ...model, cost: { input: .1, output: .2, cacheRead: 0, cacheWrite: 0 } } : model;
  publish(paid ? '0.000001' : '0');
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ version: 1,
    models: { selected: { provider: selected.provider, model: selected.id, provider_options: { routing: 'pinned', order: ['fixture-backend'] } } },
    preferences: { prompt_analysis: { models: ['selected'] } } }));
  clearLlmPreferencesCache();
  const hooks = new Map(), requests = [], responses = [];
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const content = JSON.stringify({ intent: 'Inspect the synthetic source', taskLabel: 'Synthetic task', confidence: .9 });
    const base = { id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: selected.id };
    const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
    return new Response(chunks.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const complete = async (wireModel, context, options) => {
    await beforeDispatch?.();
    const original = options.onPayload;
    const result = await completeSimple(overrideModel ? overrideModel(wireModel) : wireModel, context, { ...options, apiKey: 'synthetic-key', fetch,
      ...(rewritePayload ? { onPayload: (payload, actualModel) => original(rewritePayload(payload), actualModel) } : {}) });
    responses.push(result);
    return result;
  };
  const id = `fixture-${++sequence}`;
  const ctx = { cwd: directory, sessionManager: { getSessionId: () => id, getEntries: () => [] },
    modelRegistry: { getAvailable: () => [selected], find: () => selected,
      ...(mode === 'registry' ? { completeSimple: complete } : {}),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic-key' }) } };
  microIntelligence({ on(name, handler) { hooks.set(name, handler); }, registerTool() {}, registerMessageRenderer() {} },
    { classify: () => undefined, warmup() {}, ...(mode === 'legacy' ? { completePromptAnalysis: complete } : {}) });
  try {
    await hooks.get('session_start')({ reason: 'new' }, ctx);
    await hooks.get('input')({ source: 'interactive', originalText: 'Inspect the synthetic source.', requestId: id,
      turnId: id, sessionId: id, processId: 'fixture-process', guardianOwnerId: id, signal: new AbortController().signal }, ctx);
    await settleMicroAnalyses();
    return { requests, responses, analysis: lastMicroRequest(id)?.promptAnalysis };
  } finally { await hooks.get('session_shutdown')(); }
}

test('direct prompt analysis caps free SDK payloads after routing while preserving paid choices', async () => {
  for (const mode of ['registry', 'legacy']) {
    const free = await run({ mode });
    assert.equal(free.requests.length, 1);
    assert.equal(free.analysis.source, 'model');
    assert.equal(free.requests[0].max_completion_tokens, 768);
    assert.deepEqual(free.requests[0].provider, { only: ['fixture-backend'], order: ['fixture-backend'], allow_fallbacks: false,
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    const paid = await run({ mode, paid: true });
    assert.equal(paid.requests.length, 1, 'configured paid routes still run');
    assert.equal(paid.analysis.source, 'model');
    assert.deepEqual(paid.requests[0].provider, { only: ['fixture-backend'], order: ['fixture-backend'], allow_fallbacks: false });
  }
});

test('free admission cannot fail open after auth, evidence changes, alternate routing or route substitution', async () => {
  for (const mode of ['registry', 'legacy']) for (const options of [
    { beforeDispatch: () => publish('0.000001') },
    { overrideModel: value => ({ ...value, baseUrl: 'https://synthetic-other.invalid/v1' }) },
    { overrideModel: value => ({ ...value, id: 'fixture/substituted' }) },
    { rewritePayload: value => ({ ...value, models: ['fixture/alternate'] }) },
  ]) {
    const denied = await run({ mode, ...options });
    assert.equal(denied.requests.length, 0, 'validation rejection must precede every transport call');
    assert.equal(denied.analysis.source, 'fallback');
    assert.equal(denied.responses[0].stopReason, 'error');
    assert.match(denied.responses[0].errorMessage, /Free dispatch refused|free route changed/);
  }
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
