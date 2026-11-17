import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '../core/ai/src/utils/event-stream.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { collectSessionCost } from '../core/coding-agent/src/core/session-accounting.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';

const model = {
  id: 'fixture', name: 'Synthetic', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://example.invalid',
  input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const costPerAttempt = 0.003;

async function fixture(t, { holdAttempt = 1, failures = [1] } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'yunuspi-terminal-cancel-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noContextFiles: true, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
      pi.on('agent_end', async (event, ctx) => {
        if (dispatched !== holdAttempt) return;
        held.resolve({ event, signal: ctx.signal });
        await release.promise;
      });
    }],
  });
  await resourceLoader.reload();
  let dispatched = 0;
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: 'synthetic' } }),
    streamSimple() {
      const stream = new AssistantMessageEventStream();
      const failing = failures.includes(++dispatched);
      const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
          cost: { input: costPerAttempt, output: 0, cacheRead: 0, cacheWrite: 0, total: costPerAttempt, source: 'provider-reported' } },
        content: failing ? [] : [{ type: 'text', text: 'Synthetic retry completed.' }],
        stopReason: failing ? 'error' : 'stop', ...(failing ? { errorMessage: '502 Bad Gateway' } : {}),
      };
      stream.push(failing ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message });
      return stream;
    },
  };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: SessionManager.create(cwd, cwd), tools: [], thinkingLevel: 'off' });
  const events = [];
  session.subscribe(event => events.push(event));
  t.after(() => { release.resolve(); session.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  await session.bindExtensions({ mode: 'print' });
  return {
    session, events, held: held.promise, release: release.resolve, dispatched: () => dispatched,
    retained: () => SessionManager.open(session.sessionFile, cwd, cwd).getEntries(),
  };
}

test('stop within an awaited terminal hook prevents provider retry and keeps the billed response and queued input', { timeout: 15000 }, async t => {
  const run = await fixture(t);
  const prompt = run.session.prompt('Open a synthetic failing request.');
  const { event, signal } = await run.held;
  assert.equal(event.aborted, undefined);
  assert.equal(signal.aborted, false);
  await run.session.prompt('Retain this queued input.', { streamingBehavior: 'followUp' });
  const stopped = run.session.abort();
  assert.equal(signal.aborted, true);
  run.release();
  await Promise.all([prompt, stopped]);

  assert.equal(run.dispatched(), 1);
  assert.equal(run.events.filter(event => event.type === 'auto_retry_start').length, 0);
  assert.deepEqual(run.events.filter(event => event.type === 'agent_end').map(event => [event.aborted, event.willRetry]), [[true, false]]);
  assert.equal(run.events.filter(event => event.type === 'agent_settled').length, 1);
  assert.deepEqual(run.session.getFollowUpMessages(), ['Retain this queued input.']);
  const retained = run.retained();
  assert.deepEqual(retained.filter(entry => entry.message?.role === 'assistant').map(entry => entry.message.stopReason), ['error']);
  assert.equal(collectSessionCost(retained).reported, costPerAttempt);
});

test('an uncancelled terminal hook still admits the session retry and keeps both billed responses', { timeout: 15000 }, async t => {
  const run = await fixture(t);
  const prompt = run.session.prompt('Open a synthetic retryable request.');
  await run.held;
  run.release();
  await prompt;

  assert.equal(run.dispatched(), 2);
  assert.equal(run.events.filter(event => event.type === 'auto_retry_start').length, 1);
  assert.deepEqual(run.events.filter(event => event.type === 'agent_end').map(event => event.willRetry), [true, false]);
  assert.equal(run.events.filter(event => event.type === 'agent_settled').length, 1);
  const retained = run.retained();
  assert.deepEqual(retained.filter(entry => entry.message?.role === 'assistant').map(entry => entry.message.stopReason), ['error', 'stop']);
  assert.equal(collectSessionCost(retained).reported, costPerAttempt * 2);
});

test('stopping a failed retry at its terminal hook ends that retry series before the next user turn', { timeout: 15000 }, async t => {
  const run = await fixture(t, { holdAttempt: 2, failures: [1, 2, 3] });
  const prompt = run.session.prompt('This request and its retry both fail.');
  await run.held;
  const stopped = run.session.abort();
  run.release();
  await Promise.all([prompt, stopped]);
  assert.equal(run.dispatched(), 2);
  assert.deepEqual(run.events.filter(event => event.type === 'auto_retry_end').map(event => [event.attempt, event.success]), [[1, false]]);

  await run.session.prompt('Start another explicit user request.');
  assert.equal(run.dispatched(), 4, 'the new user request has its full retry allowance');
  assert.deepEqual(run.events.filter(event => event.type === 'auto_retry_end').map(event => [event.attempt, event.success]), [[1, false], [1, true]]);
});
