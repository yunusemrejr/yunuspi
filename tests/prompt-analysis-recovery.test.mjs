import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { completeSimple } from '@yunuspi/ai/compat';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/micro-intelligence.ts')));
assert.ok(agent, 'agent extension tree must exist');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-recovery-'));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_LLM_PREFERENCES_FILE = path.join(directory, 'preferences.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(directory, 'exclusions.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'health.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(directory, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
delete process.env.PI_MICRO_INTELLIGENCE;
delete process.env.PI_SUBAGENT_CHILD;
const { default: register, lastMicroRequest, settleMicroAnalyses } = await import(pathToFileURL(path.join(agent, 'extensions/micro-intelligence.ts')));
const { clearLlmPreferencesCache } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/llm-preferences.ts')));
const { runPromptAnalysis } = await import(pathToFileURL(path.join(agent, 'extensions/lib/prompt-analysis-runtime.ts')));
const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = JSON.stringify({ intent: 'Inspect the synthetic parser', taskLabel: 'Parser review', confidence: .9, explicitConstraints: ['Preserve the API.'] });
const prompt = 'Inspect the synthetic parser. Preserve the API.';
let sequence = 0;

function response({ truncated = false, text = answer } = {}) {
  const base = { id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: 'advisor' };
  const rows = [
    { ...base, choices: [{ index: 0, delta: truncated ? { role: 'assistant', reasoning_content: 'Synthetic reasoning only.' } : { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: truncated ? 768 : 35, total_tokens: truncated ? 778 : 45, completion_tokens_details: { reasoning_tokens: truncated ? 768 : 0 } } },
  ];
  return new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function anthropicResponse() {
  const rows = [
    { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'advisor', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 35 } },
    { type: 'message_stop' },
  ];
  return new Response(rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, { mode = 'registry', thinking, mandatoryReasoning = true, maxTokens = 16384, api = 'openai-completions', adaptive = false, fetchPlan, auth, throwingUI = false, autonomous = false, cost, thinkingLevelMap = {} } = {}) {
  const model = { provider: 'recovery-fixture', id: 'advisor', name: 'Synthetic advisor', api,
    baseUrl: 'https://synthetic.invalid/v1', contextWindow: 65536, maxTokens, reasoning: true, input: ['text'],
    thinkingLevelMap: { ...(mandatoryReasoning ? { off: null } : {}), ...thinkingLevelMap },
    compat: { supportsReasoningEffort: true, maxTokensField: 'max_completion_tokens', ...(adaptive ? { forceAdaptiveThinking: true } : {}) },
    cost: cost ?? { input: .1, output: .2, cacheRead: .1, cacheWrite: .1 } };
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ version: 1,
    models: autonomous ? {} : { advisor: { provider: model.provider, model: model.id, ...(thinking ? { thinking } : {}) } },
    preferences: autonomous ? {} : { prompt_analysis: { models: ['advisor'] } } }));
  clearLlmPreferencesCache();
  let sessionId = `session-${++sequence}`;
  const hooks = new Map(), requests = [], sdkResponses = [], statuses = [], rows = [], events = [];
  let status;
  const complete = async (selected, context, options) => {
    const result = await completeSimple(selected, context, { ...options, apiKey: 'synthetic-key', fetch: async (_url, init) => {
      const wire = JSON.parse(init.body);
      requests.push({ wire, signal: init.signal, options });
      return fetchPlan ? fetchPlan(requests.length, init) : response();
    } });
    sdkResponses.push(result);
    return result;
  };
  const ctx = { cwd: directory, sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] },
    modelRegistry: { getAvailable: () => [model], find: () => model,
      getApiKeyAndHeaders: auth ?? (async () => ({ ok: true, apiKey: 'synthetic-key' })),
      ...(mode === 'registry' ? { completeSimple: complete } : {}) },
    ui: { setStatus: (key, value) => { assert.equal(key, 'prompt-analysis'); statuses.push(value); status = value; if (throwingUI) throw new Error('Synthetic unavailable UI'); } } };
  register({ on: (name, handler) => hooks.set(name, handler), registerTool() {}, registerMessageRenderer() {},
    events: { emit: (name, event) => events.push({ name, event }) }, sendMessage: async message => rows.push(message) },
    { classify: () => undefined, warmup() {}, ...(mode === 'legacy' ? { completePromptAnalysis: complete } : {}) });
  const emit = (name, event = {}) => hooks.get(name)?.(event, ctx);
  const input = (requestId, signal = new AbortController().signal) => {
    const event = { source: 'interactive', text: prompt, originalText: prompt, requestId, turnId: `turn-${requestId}`, processId: 'synthetic-process', sessionId, guardianOwnerId: `owner-${sessionId}`, signal };
    return { event, run: async () => { const result = await emit('input', event); await settleMicroAnalyses(); return result; } };
  };
  const context = event => emit('context', { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], requestMessages: [{ requestId: event.requestId, turnId: event.turnId, messageIndex: 0 }] });
  await emit('session_start', { reason: 'new' });
  t.after(() => emit('session_shutdown'));
  return { requests, sdkResponses, statuses, rows, events, emit, input, context, status: () => status,
    analysis: () => lastMicroRequest(`owner-${sessionId}`)?.promptAnalysis,
    changeSession: () => { sessionId = `session-${++sequence}`; } };
}

test('reasoning-only length responses receive one compact retry through registry and legacy SDK wires', async t => {
  for (const mode of ['registry', 'legacy']) {
    const f = await fixture(t, { mode, fetchPlan: count => response({ truncated: count === 1 }) });
    const task = f.input(`${mode}-retry`);
    await task.run();
    assert.equal(f.analysis()?.source, 'model');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests.map(row => row.wire.max_completion_tokens), [2816, 3584]);
    assert.deepEqual(f.requests.map(row => row.wire.reasoning_effort), ['minimal', 'minimal']);
    assert.ok(f.requests.every(row => row.options.maxRetries === 0), 'SDK retries cannot multiply the bounded helper route attempts');
    assert.equal(f.sdkResponses[0].stopReason, 'length');
    assert.equal(f.sdkResponses[0].usage.reasoning, 768);
    const recoveryContent = f.requests[1].wire.messages.at(-1).content;
    assert.match(typeof recoveryContent === 'string' ? recoveryContent : recoveryContent.map(part => part.text ?? '').join('\n'), /Recovery: return only intent, taskLabel, confidence/);
    assert.ok(f.statuses.some(value => value?.includes('compact retry')));
    assert.equal(f.status(), undefined);
    const rewritten = await f.context(task.event);
    assert.equal(f.rows.length, 1);
    assert.match(f.rows[0].content, /output limit reached \(768 reasoning tokens\)/);
    assert.doesNotMatch(f.rows[0].content, /malformed|returned no answer/);
    assert.deepEqual(f.rows[0].details.attempts.map(row => row.outcome), ['truncated', 'complete']);
    assert.ok(rewritten.messages.some(row => row.customType === 'prompt-analysis-context'));
  }
});

test('explicit thinking and provider output ceilings survive compact recovery', async t => {
  for (const options of [
    { thinking: 'high', mandatoryReasoning: true, maxTokens: 4000, expected: [4000, 4000], effort: 'high' },
    { thinking: 'off', mandatoryReasoning: false, maxTokens: 4000, expected: [768, 1536], effort: undefined },
  ]) {
    const f = await fixture(t, { ...options, fetchPlan: count => response({ truncated: count === 1 }) });
    await f.input(`thinking-${options.thinking}`).run();
    assert.deepEqual(f.requests.map(row => row.wire.max_completion_tokens), options.expected);
    assert.ok(f.requests.every(row => row.wire.reasoning_effort === options.effort));
    assert.equal(f.analysis()?.source, 'model');
  }
});

test('Anthropic default and explicit off never enable adaptive thinking or inflate the output allowance', async t => {
  for (const adaptive of [false, true]) for (const thinking of [undefined, 'off']) {
    const f = await fixture(t, { api: 'anthropic-messages', mandatoryReasoning: false, adaptive, thinking, fetchPlan: () => anthropicResponse() });
    await f.input(`anthropic-${adaptive}-${thinking ?? 'default'}`).run();
    assert.equal(f.analysis()?.source, 'model');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].wire.max_tokens, 768, 'a disabled thinking budget must not expand into the provider ceiling');
    assert.ok(!f.requests[0].wire.thinking || f.requests[0].wire.thinking.type === 'disabled', JSON.stringify(f.requests[0].wire.thinking));
  }
});

test('native Anthropic simple transport treats explicit off as disabled and keeps minimal thinking enabled', async () => {
  const core = [path.join(root, 'core/ai/src/api/anthropic-messages.js'), path.join(agent, 'runtime/core/ai/dist/api/anthropic-messages.js')].find(p => fs.existsSync(p));
  assert.ok(core, 'owned Anthropic transport must exist');
  const { streamSimple } = await import(pathToFileURL(core));
  for (const adaptive of [false, true]) for (const reasoning of [undefined, 'off', 'minimal']) {
    let wire;
    const model = { provider: 'synthetic-anthropic', id: 'advisor', api: 'anthropic-messages', baseUrl: 'https://synthetic.invalid',
      reasoning: true, input: ['text'], maxTokens: 16384, contextWindow: 65536, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      compat: { ...(adaptive ? { forceAdaptiveThinking: true } : {}) } };
    const result = await streamSimple(model, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 1 }] }, {
      apiKey: 'synthetic-key', reasoning, maxTokens: 2048, maxRetries: 0,
      fetch: async (_url, init) => { wire = JSON.parse(init.body); return anthropicResponse(); },
    }).result();
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    if (reasoning === 'minimal') {
      assert.equal(wire.thinking.type, adaptive ? 'adaptive' : 'enabled');
      assert.equal(wire.max_tokens, adaptive ? 2048 : 3072);
      if (adaptive) assert.equal(wire.output_config.effort, 'low');
      else assert.equal(wire.thinking.budget_tokens, 1024);
    } else {
      assert.equal(wire.max_tokens, 2048, `${adaptive ? 'adaptive' : 'classic'} ${reasoning ?? 'default'} keeps the caller's output allowance`);
      assert.equal(wire.thinking.type, 'disabled');
    }
  }
});

test('autonomous admission includes reasoning and recovery room while preserving explicit paid preferences', async t => {
  const expensiveReasoning = { cost: { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 }, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high' } };
  const automatic = await fixture(t, { ...expensiveReasoning, autonomous: true });
  await automatic.input('automatic-budget').run();
  assert.equal(automatic.requests.length, 0, 'the permitted high reasoning allowance alone would exceed the initial $0.01 estimate');
  assert.equal(automatic.analysis()?.source, 'fallback');
  const configured = await fixture(t, expensiveReasoning);
  await configured.input('configured-budget').run();
  assert.equal(configured.requests.length, 1, 'explicit provider preferences retain user authority over route cost');
  assert.equal(configured.requests[0].wire.reasoning_effort, 'high');
  assert.equal(configured.analysis()?.source, 'model');
});

test('the preferred route keeps its own allowance when more fallbacks are configured', async () => {
  const starts = [], calls = [];
  const result = await runPromptAnalysis({ prompt, kind: 'initial', budget: { totalMs: 240, perAttemptMs: 130 },
    candidates: ['preferred', 'second', 'third', 'fourth'].map(route => ({ route, complete: async () => {
      calls.push(route);
      await new Promise(resolve => setTimeout(resolve, 80));
      return { text: answer, stopReason: 'stop' };
    } })), onStart: value => starts.push(value) });
  assert.deepEqual(calls, ['preferred']);
  assert.equal(starts[0].timeoutMs, 130);
  assert.equal(result.route, 'preferred');
});

test('complete validated JSON at the output boundary avoids a redundant paid retry', async () => {
  const calls = [], outcomes = [];
  const result = await runPromptAnalysis({ prompt, kind: 'initial',
    candidates: ['preferred', 'fallback'].map(route => ({ route, complete: async () => {
      calls.push(route);
      return { text: answer, stopReason: 'length', inputTokens: 10, outputTokens: 768 };
    } })), onAttempt: value => outcomes.push(value) });
  assert.equal(result.status, 'model');
  assert.equal(result.route, 'preferred');
  assert.deepEqual(calls, ['preferred']);
  assert.deepEqual(outcomes.map(row => row.outcome), ['complete']);
  assert.equal(result.outputTokens, 768);
});

test('repeated truncation retries only once and respects the total attempt ceiling', async () => {
  const calls = [], outcomes = [];
  const result = await runPromptAnalysis({ prompt, kind: 'initial', budget: { totalMs: 500, perAttemptMs: 100, maxAttempts: 4 },
    candidates: ['first', 'second', 'third', 'fourth'].map(route => ({ route, complete: async request => {
      calls.push({ route, request });
      return { text: answer.slice(0, -1), stopReason: 'length', reasoningTokens: 768, inputTokens: 10, outputTokens: 768 };
    } })), onAttempt: value => outcomes.push(value) });
  assert.equal(result.status, 'fallback', 'an incomplete JSON object must never be accepted');
  assert.deepEqual(calls.map(row => row.route), ['first', 'first', 'second', 'third']);
  assert.equal(calls.filter(row => row.request.prompt.includes('\nRecovery:')).length, 1);
  assert.equal(outcomes.filter(row => row.recovery === 'compact-retry').length, 1);
  assert.ok(outcomes.every(row => row.outcome === 'truncated'));
  assert.equal(result.outputTokens, 3072);
});

test('cancelled registry and legacy streams clear progress without publishing fallback or stale advice', async t => {
  for (const mode of ['registry', 'legacy']) {
    let started, transportAborted = false;
    const began = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, { mode, fetchPlan: async (_count, init) => {
      started();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
        transportAborted = true;
        reject(Object.assign(new Error('Synthetic stream cancelled'), { name: 'AbortError' }));
      }, { once: true }));
    } });
    const controller = new AbortController();
    const task = f.input(`${mode}-cancel`, controller.signal);
    const pending = task.run();
    await began;
    assert.match(f.status(), /Intent analysis/);
    assert.match(f.status(), /0s \/ 240s allowed/);
    controller.abort();
    await pending;
    await tick();
    assert.equal(transportAborted, true);
    assert.equal(f.status(), undefined);
    assert.equal(f.analysis(), undefined);
    assert.equal(await f.context(task.event), undefined);
    assert.deepEqual(f.rows, []);
    assert.deepEqual(f.events, []);
    assert.equal(f.requests.length, 1, 'cancel must not trigger compact recovery');
    assert.equal(f.sdkResponses[0]?.stopReason, 'aborted');
  }
});

test('legacy cancellation while resolving authentication never dispatches a model request', async t => {
  let started, finishAuth;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { mode: 'legacy', auth: () => { started(); return new Promise(resolve => { finishAuth = resolve; }); } });
  const controller = new AbortController(), task = f.input('auth-cancel', controller.signal);
  const pending = task.run();
  await began;
  controller.abort();
  await pending;
  finishAuth({ ok: true, apiKey: 'synthetic-late-key' });
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.status(), undefined);
  assert.equal(f.analysis(), undefined);
});

test('session changes and shutdown retire progress immediately and late old streams cannot clear a new row', async t => {
  const pendingWires = [];
  const f = await fixture(t, { fetchPlan: () => new Promise(resolve => pendingWires.push(resolve)) });
  const oldTask = f.input('old-session'), oldRun = oldTask.run();
  while (!pendingWires.length) await tick();
  assert.match(f.status(), /Intent analysis/);
  f.changeSession();
  await f.emit('session_start', { reason: 'new' });
  assert.equal(f.status(), undefined, 'session switch immediately clears the previous session row');
  await oldRun;
  const newTask = f.input('new-session'), newRun = newTask.run();
  while (pendingWires.length < 2) await tick();
  const newStatus = f.status();
  pendingWires[0](response());
  await tick();
  assert.equal(f.status(), newStatus, 'late old completion cannot clear the current row');
  assert.equal(await f.context(oldTask.event), undefined);
  await f.emit('session_shutdown');
  assert.equal(f.status(), undefined, 'shutdown clears without relying on a context argument');
  await newRun;
  pendingWires[1](response());
  await tick();
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.events, []);
});

test('committed tree navigation retires a pending progress row without publishing its old result', async t => {
  let finish;
  const f = await fixture(t, { fetchPlan: () => new Promise(resolve => { finish = resolve; }) });
  const task = f.input('tree-old'), running = task.run();
  while (!finish) await tick();
  assert.match(f.status(), /Intent analysis/);
  await f.emit('session_tree');
  assert.equal(f.status(), undefined);
  await running;
  finish(response());
  await tick();
  assert.equal(await f.context(task.event), undefined);
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.events, []);
});

test('throwing progress UI cannot discard a successful advisory', async t => {
  const f = await fixture(t, { throwingUI: true, fetchPlan: async () => { await new Promise(resolve => setTimeout(resolve, 1100)); return response(); } });
  await f.input('ui-unavailable').run();
  assert.equal(f.analysis()?.source, 'model');
  assert.equal(f.requests.length, 1);
  assert.ok(f.statuses.filter(value => typeof value === 'string').length >= 2, 'both immediate and periodic status writes tolerate unavailable UI');
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
