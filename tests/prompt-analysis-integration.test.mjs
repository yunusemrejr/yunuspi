import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessageEventStream } from '@yunuspi/ai';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';
import { createExtensionRuntime, loadExtensionFromFactory } from '../core/coding-agent/src/core/extensions/loader.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-prompt-path-'));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_LLM_PREFERENCES_FILE = path.join(directory, 'llm_preferences.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(directory, 'exclusions.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'health.json');
delete process.env.PI_MICRO_INTELLIGENCE;
delete process.env.PI_SUBAGENT_CHILD;
const { default: microIntelligence } = await import('../agent/extensions/micro-intelligence.ts');
const { clearLlmPreferencesCache } = await import('../agent/extensions/pi-subagents/src/runs/shared/llm-preferences.ts');

const model = (id) => ({ id, provider: 'audit-fixture', name: id, api: 'openai-completions', baseUrl: 'http://localhost:1',
  contextWindow: 65_536, maxTokens: 4096, reasoning: false, input: ['text'],
  cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } });
const models = ['main', 'first', 'second', 'third'].map(model);
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function respond(selected, text) {
  const stream = new AssistantMessageEventStream();
  const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
    content: [{ type: 'text', text }], stopReason: 'stop', usage, timestamp: Date.now() };
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: 'stop', message });
  return stream;
}
function preferences(order) {
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ version: 1,
    models: Object.fromEntries(models.map((entry) => [entry.id, { provider: entry.provider, model: entry.id }])),
    preferences: { prompt_analysis: { models: order } },
  }));
  clearLlmPreferencesCache();
}
async function fixture(t, { afterInput, complete } = {}) {
  const calls = [], errors = [], notices = [], events = [];
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const stream = (selected, context, options) => {
    calls.push({ id: selected.id, context, options, baseUrl: selected.baseUrl });
    if (complete) { const result = complete(selected, context, options); if (result) return result; }
    if (selected.id === 'main') return respond(selected, 'Synthetic completed turn.');
    const request = JSON.parse(context.messages[0].content[0].text.split('\n').at(-1));
    return respond(selected, JSON.stringify({ intent: 'Advisory interpretation', taskLabel: 'Synthetic task',
      confidence: 0.9, explicitConstraints: request.currentPrompt.includes('Use architecture A') ? ['Use architecture A'] : [],
      subtasks: ['Inspect the implementation'], relation: 'continue', completionConditions: ['The requested test passes'] }));
  };
  runtime.registerNativeProvider({ id: 'audit-fixture', name: 'Local audit fixture', getModels: () => models,
    auth: { apiKey: { name: 'Synthetic', login: async () => { throw new Error('unused'); },
      resolve: async () => ({ source: 'fixture', auth: { apiKey: 'synthetic', baseUrl: 'http://localhost:43210/v1' } }) } },
    stream, streamSimple: stream });
  await runtime.refresh({ allowNetwork: false });
  const extensionRuntime = createExtensionRuntime();
  const eventBus = createEventBus();
  eventBus.on('guardian:prompt-analysis:v1', (event) => events.push(event));
  const extension = await loadExtensionFromFactory((pi) => {
    microIntelligence(pi, { classify: () => undefined, warmup() {} });
    if (afterInput) pi.on('input', afterInput);
  }, directory, eventBus, extensionRuntime, '<prompt-audit>');
  const loader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Complete the literal user request.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
    model: models[0], resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), settingsManager,
    noTools: 'all', sessionStartEvent: { type: 'session_start', reason: 'startup' } });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  // Use the real runner's UI context while retaining its default no-op methods.
  session.extensionRunner.setUIContext({ ...session.extensionRunner.createContext().ui, notify: (text) => notices.push(text) });
  t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); });
  return { session, calls, errors, notices, events, runtime };
}

test('real SDK dispatches configured native analysis providers, preserves raw authority and excludes synthetic events', async (t) => {
  preferences(['first', 'second', 'third']);
  const f = await fixture(t, { complete: (selected) => {
    if (selected.id === 'first') throw new Error('synthetic provider unavailable');
    if (selected.id === 'second') return respond(selected, '{malformed');
  } });
  const raw = 'Use architecture A. The advisory may mistakenly say B. Preserve this exact sentence.';
  await f.session.prompt(raw);
  assert.deepEqual(f.calls.map((call) => call.id), ['first', 'second', 'third', 'main']);
  assert.ok(f.calls.every((call) => call.baseUrl === 'http://localhost:43210/v1'), 'canonical auth URL reaches both analysis and main providers');
  const main = f.calls.at(-1).context.messages;
  assert.ok(main.some((message) => message.role === 'user' && message.content.some((part) => part.text === raw)));
  assert.ok(main.some((message) => message.content.some((part) => part.text?.includes('Auxiliary interpretation (advisory only'))));
  assert.equal(f.notices.length, 0, 'one persistent analysis row replaces duplicate transient notifications');
  assert.equal(f.events.length, 1);
  assert.equal(f.session.sessionManager.getEntries().filter((entry) => entry.type === 'custom_message' && entry.customType === 'prompt-analysis').length, 1);
  const shown = f.session.sessionManager.getEntries().find(entry => entry.customType === 'prompt-analysis');
  assert.deepEqual(shown.details.attempts.map(attempt => attempt.outcome), ['failed', 'malformed', 'complete']);
  assert.ok(main.some(message => message.content.some(part => part.text?.includes(shown.details.advisory))), 'visible expanded advisory exactly matches text in the main agent request, including when adjacent user messages are merged');
  await f.session.prompt('Automatic background result.', { source: 'extension' });
  assert.equal(f.calls.filter((call) => call.id !== 'main').length, 3, 'automatic messages do not invoke analysis recursively');
  preferences(['third']);
  await f.session.prompt('Also add the validation test.', { source: 'rpc' });
  assert.equal(f.calls.at(-2).id, 'third');
  assert.equal(f.calls.at(-2).options.maxTokens, 320);
  assert.equal(f.events.length, 2);
  const followup = f.session.sessionManager.getEntries().filter(entry => entry.customType === 'prompt-analysis').at(-1);
  assert.match(followup.content, /followup.*model/);
  assert.match(followup.content, /Relation: continue/);
  assert.ok(f.calls.at(-1).context.messages.some(message => message.content.some(part => part.text?.includes(followup.details.advisory))));
  assert.deepEqual(f.errors, []);
});

test('fallback visibly explains route failure and long input while preserving the literal request', async t => {
  preferences(['first']);
  const f = await fixture(t, { complete: selected => { if (selected.id !== 'main') throw new Error('HTTP 400 invalid_request_error private diagnostic'); } });
  const raw = '<mindset>' + 'Reusable work guidance. '.repeat(1400) + '</mindset>\nImplement menu navigation.';
  await f.session.prompt(raw);
  const shown = f.session.sessionManager.getEntries().find(entry => entry.customType === 'prompt-analysis');
  assert.match(shown.content, /Primary: Implement menu navigation/);
  assert.match(shown.content, /Fallback reason: audit-fixture\/first: failed \(invalid-request\)/);
  assert.match(shown.content, /Long request: analysis used/);
  assert.doesNotMatch(shown.content, /private diagnostic/);
  const main = f.calls.at(-1).context.messages;
  assert.ok(main.some(message => message.role === 'user' && message.content.some(part => part.text === raw)));
  assert.ok(main.some(message => message.content.some(part => part.text?.includes(shown.details.advisory))));
  const renderer = f.session.extensionRunner.getMessageRenderer('prompt-analysis');
  assert.ok(renderer(shown, { expanded: true }).render(100).join('\n').includes('Exact advisory sent to the main agent'));
});

test('real preflight handled after analysis cancels lineage before the next genuine request', async (t) => {
  preferences(['third']);
  let intercept = true;
  const f = await fixture(t, { afterInput: () => { if (intercept) return { action: 'handled' }; } });
  await f.session.prompt('Discard this handled request.');
  assert.deepEqual(f.calls.map((call) => call.id), ['third']);
  assert.equal(f.events.length, 0);
  intercept = false;
  await f.session.prompt('Use architecture A.');
  assert.equal(f.calls.at(-2).options.maxTokens, 768);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.errors, []);
});

test('queued follow-ups keep explicit lineage and new routes without switching the active main turn', async (t) => {
  preferences(['third']);
  let finishMain, began;
  const started = new Promise((resolve) => { began = resolve; });
  let mainCalls = 0;
  const f = await fixture(t, { complete: (selected) => {
    if (selected.id !== 'main' || ++mainCalls !== 1) return;
    const held = new AssistantMessageEventStream();
    finishMain = () => {
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
        content: [{ type: 'text', text: 'Initial work complete.' }], stopReason: 'stop', usage, timestamp: Date.now() };
      held.push({ type: 'done', reason: 'stop', message });
    };
    began();
    return held;
  } });
  const running = f.session.prompt('Use architecture A. Implement the API.');
  await started;
  preferences(['second']);
  await f.session.prompt('Also add the API validation tests.', { streamingBehavior: 'followUp' });
  await f.session.prompt('Preserve the return code in those tests.', { streamingBehavior: 'followUp' });
  const tasks = [...f.session._guardian._tasks.values()];
  assert.equal(tasks.length, 3);
  assert.equal(tasks[1].parentTaskId, tasks[0].requestId);
  assert.equal(tasks[2].parentTaskId, tasks[1].requestId, 'accepted queued request remains the latest lineage parent');
  assert.deepEqual(f.calls.filter((call) => call.id !== 'main').map((call) => call.id), ['third', 'second', 'second']);
  const thirdInterpretation = JSON.parse(f.calls.at(-1).context.messages[0].content[0].text.split('\n').at(-1));
  assert.ok(thirdInterpretation.priorHistory.some((entry) => entry.constraints.includes('Use architecture A')),
    'an intervening small follow-up must not erase the original task constraint from advisory context');
  finishMain();
  await running;
  assert.ok(f.calls.filter((call) => call.id === 'main').length >= 2);
  assert.equal(f.events.length, 3);
  assert.deepEqual(f.errors, []);
});

test('abort of real asynchronous preflight prevents downstream input hooks and any late advisory publication', async (t) => {
  preferences(['third']);
  let finishAnalysis, began, downstreamCalls = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const f = await fixture(t, {
    afterInput: () => { downstreamCalls++; },
    complete: (selected) => {
      if (selected.id === 'main' || finishAnalysis) return;
      const held = new AssistantMessageEventStream();
      finishAnalysis = () => {
        const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
          content: [{ type: 'text', text: JSON.stringify({ intent: 'Stale task', confidence: 0.9 }) }], stopReason: 'stop', usage, timestamp: Date.now() };
        held.push({ type: 'done', reason: 'stop', message });
      };
      began();
      return held;
    },
  });
  const running = f.session.prompt('Use architecture A.');
  // Attach rejection handling before aborting to prevent a false test-runner
  // unhandled rejection while abort() waits for the agent idle barrier.
  const rejected = assert.rejects(running);
  await started;
  await f.session.abort();
  await rejected;
  finishAnalysis();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downstreamCalls, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.notices.length, 0);
  assert.deepEqual(f.calls.map((call) => call.id), ['third']);
  await f.session.prompt('Use architecture A. Start a fresh request.');
  assert.equal(f.calls.at(-2).options.maxTokens, 768);
  assert.equal(downstreamCalls, 1);
  assert.deepEqual(f.errors, []);
});

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
