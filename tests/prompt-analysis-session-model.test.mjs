import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeSimple } from '@yunuspi/ai/compat';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-analysis-session-wire-'));
process.env.PI_LEAN_GATES ??= 'on'; // these tests exercise the lean-gated layer explicitly
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(directory, 'exclusions.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'health.json');
delete process.env.PI_MICRO_INTELLIGENCE;
delete process.env.PI_SUBAGENT_CHILD;
const { default: microIntelligence, lastMicroRequest, settleMicroAnalyses } = await import('../agent/extensions/micro-intelligence.ts');

const session = { id: 'session-advisor', provider: 'openrouter', name: 'Session advisor', api: 'openai-completions',
  baseUrl: 'https://synthetic.invalid/v1', contextWindow: 65536, maxTokens: 4096, reasoning: false, input: ['text'],
  cost: { input: .1, output: .2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: 'max_completion_tokens' } };
// Offered by the registry, but never chosen: analysis is bound to the session model.
const other = { ...session, id: 'other-advisor', baseUrl: 'https://other.invalid/v1' };
let sequence = 0;

async function run({ model = session, mode = 'registry' } = {}) {
  const priorAdaptive = process.env.PI_ADAPTIVE_EXECUTION;
  process.env.PI_ADAPTIVE_EXECUTION = 'off';
  const requests = [], responses = [], hooks = new Map();
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const content = JSON.stringify({ intent: 'Inspect the synthetic source', taskLabel: 'Synthetic task', confidence: .9 });
    const base = { id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: request.model };
    const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }];
    return new Response(chunks.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const complete = async (wireModel, context, options) => {
    const result = await completeSimple(wireModel, context, { ...options, apiKey: 'synthetic-key', fetch });
    responses.push(result);
    return result;
  };
  const id = `session-${++sequence}`;
  const ctx = { cwd: directory, sessionManager: { getSessionId: () => id, getEntries: () => [] }, model: model ?? undefined,
    modelRegistry: { getAvailable: () => [other, session], find: () => session,
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
  } finally {
    await hooks.get('session_shutdown')();
    if (priorAdaptive === undefined) delete process.env.PI_ADAPTIVE_EXECUTION;
    else process.env.PI_ADAPTIVE_EXECUTION = priorAdaptive;
  }
}

test('direct prompt analysis dispatches only to the session model with no provider routing', async () => {
  for (const mode of ['registry', 'legacy']) {
    const result = await run({ mode });
    assert.equal(result.requests.length, 1, 'one analysis request, to the session model');
    assert.equal(result.requests[0].model, session.id, 'the offered alternate model is never chosen');
    assert.equal(result.requests[0].max_completion_tokens, 768);
    assert.equal(result.requests[0].provider, undefined, 'no preference or fallback provider routing reaches the wire');
    assert.equal(result.analysis.source, 'model');
  }
});

test('without a usable session model or its output capacity, analysis is skipped and no other model is substituted', async () => {
  for (const model of [null, { ...session, maxTokens: 512 }]) {
    for (const mode of ['registry', 'legacy']) {
      const denied = await run({ mode, model });
      assert.equal(denied.requests.length, 0, 'no transport call is made without a usable session model');
      assert.equal(denied.analysis.source, 'fallback');
    }
  }
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
