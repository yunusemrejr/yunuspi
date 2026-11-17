import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompletionNotifier } from '../agent/extensions/pi-background-tasks/src/core/completion-wake.ts';
import { AssistantMessageEventStream } from '../core/ai/src/utils/event-stream.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';

const model = {
  id: 'fixture', name: 'Synthetic', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://example.invalid',
  input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'yunuspi-background-terminal-wake-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const providerStarted = Promise.withResolvers();
  const providerFinish = Promise.withResolvers();
  const terminalHook = Promise.withResolvers();
  const terminalRelease = Promise.withResolvers();
  let notify;
  let dispatches = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noContextFiles: true, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
      let context;
      notify = createCompletionNotifier(pi, () => context, { graceMs: 0 });
      pi.on('session_start', (_event, ctx) => { context = ctx; });
      pi.on('agent_end', async (event, ctx) => {
        if (dispatches !== 1) return;
        terminalHook.resolve({ event, signal: ctx.signal });
        await terminalRelease.promise;
      });
    }],
  });
  await resourceLoader.reload();
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: 'synthetic' } }),
    streamSimple() {
      const stream = new AssistantMessageEventStream();
      const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        usage, content: [{ type: 'text', text: 'Synthetic provider response.' }], stopReason: 'stop' };
      const finish = () => stream.push({ type: 'done', reason: 'stop', message });
      if (++dispatches === 1) {
        providerStarted.resolve();
        void providerFinish.promise.then(finish);
      } else finish();
      return stream;
    },
  };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: SessionManager.create(cwd, cwd), tools: [], thinkingLevel: 'off' });
  t.after(() => {
    providerFinish.resolve();
    terminalRelease.resolve();
    session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'rpc' });
  return {
    session, providerStarted: providerStarted.promise, finishProvider: providerFinish.resolve,
    terminalHook: terminalHook.promise, releaseHook: terminalRelease.resolve, dispatches: () => dispatches,
    notify: content => notify({ customType: 'background-task-notification', content, display: false }, { triggerTurn: true }),
    read: type => SessionManager.open(session.sessionFile, cwd, cwd).getEntries().filter(entry => entry.customType === type),
  };
}

for (const stop of [true, false]) {
  test(`a background completion received during a turn ${stop ? 'stays recorded after late Stop without waking' : 'wakes once after normal settlement'}`, { timeout: 15000 }, async t => {
    const run = await fixture(t);
    const prompt = run.session.prompt('Run a synthetic user turn.');
    await run.providerStarted;
    run.notify('Synthetic completed task receipt.');
    run.finishProvider();
    const { event, signal } = await run.terminalHook;
    assert.equal(event.aborted, undefined, 'the notifier has already received this ordinary end event');
    assert.equal(run.read('background-task-notification').length, 1);
    const stopped = stop ? run.session.abort() : undefined;
    if (stop) assert.equal(signal.aborted, true);
    run.releaseHook();
    await Promise.all([prompt, stopped]);
    await run.session.waitForIdle();

    assert.equal(run.dispatches(), stop ? 1 : 2);
    assert.equal(run.read('background-task-notification').length, 1);
    assert.equal(run.read('background-completion-wake').length, stop ? 0 : 1);
    assert.equal(getEventListeners(signal, 'abort').length, 0, 'the settled turn releases its signal listeners');

    if (stop) {
      await run.session.prompt('A real new user request.');
      run.notify('A completion for the new request.');
      await run.session.waitForIdle();
      assert.equal(run.dispatches(), 3, 'the new user turn reopens the normal completion wake');
      const wakes = run.read('background-completion-wake');
      assert.equal(wakes.length, 1);
      assert.match(wakes[0].content, /^1 background task completion/);
    }
  });
}
