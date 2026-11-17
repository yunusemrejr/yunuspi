import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AgentWorker } from '../desktop/agent-worker.mjs';
import { applyAgentEvent, createConversation, messageText } from '../desktop/renderer/conversation.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const previous = 'Previous fixture answer.';
const phrase = 'Next fixture phrase.';
const prefix = 'Earlier content slot.';

// Exercise the owned session and JSONL loop. Only the transport and an
// extension that provides a deterministic publication barrier are fixtures.
const child = `
import { AssistantMessageEventStream } from './core/ai/src/utils/event-stream.js';
import { createAgentSession } from './core/coding-agent/src/core/sdk.js';
import { DefaultResourceLoader } from './core/coding-agent/src/core/resource-loader.js';
import { SessionManager } from './core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from './core/coding-agent/src/core/settings-manager.js';
import { runRpcMode } from './core/coding-agent/src/modes/rpc/rpc-mode.js';
import path from 'node:path';

const cwd = process.env.PI_REATTACH_FIXTURE_DIR;
const stage = process.env.PI_REATTACH_FIXTURE_STAGE;
const held = Promise.withResolvers();
let send;
process.on('message', action => {
  if (action === 'release') held.resolve();
  else send?.(action);
});
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    if (!stage.startsWith('message_')) return;
    pi.on(stage, async event => {
      if (event.message?.role !== 'assistant') return;
      if (stage === 'message_update' && event.assistantMessageEvent?.type !== 'text_delta') return;
      process.send('held');
      await held.promise;
    });
  }],
});
await resourceLoader.reload();
const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
const assistant = (content, stopReason, timestamp) => ({ role: 'assistant', api: model.api, provider: model.provider,
  model: model.id, content, stopReason, timestamp, usage: { input: 1, output: 1, totalTokens: 2,
    cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const manager = SessionManager.open(path.join(cwd, 'fixture.jsonl'), cwd, cwd);
if (!manager.getLeafEntry()) {
  manager.appendMessage({ role: 'user', content: 'Previous fixture prompt.', timestamp: 1 });
  manager.appendMessage(assistant([{ type: 'text', text: ${JSON.stringify(previous)} }], 'stop', 2));
}
const modelRuntime = {
  getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true,
  isUsingSubscription: () => false, getAuth: async () => ({ auth: { apiKey: 'synthetic' } }),
  streamSimple() {
    const partial = assistant([], 'pending', Date.now());
    const source = new AssistantMessageEventStream();
    source.push({ type: 'start', partial });
    const earlier = { type: 'text', text: '' };
    if (stage === 'sparse') {
      partial.content.push(earlier);
      source.push({ type: 'text_start', contentIndex: 0, partial });
    }
    const block = { type: 'text', text: '' };
    const contentIndex = partial.content.length;
    partial.content.push(block);
    source.push({ type: 'text_start', contentIndex, partial });
    function append() {
      block.text += ${JSON.stringify(phrase)};
      source.push({ type: 'text_delta', contentIndex, delta: ${JSON.stringify(phrase)}, partial });
    }
    append();
    send = action => {
      if (action === 'append') { append(); return; }
      if (action === 'fill' && contentIndex > 0) {
        earlier.text = ${JSON.stringify(prefix)};
        source.push({ type: 'text_delta', contentIndex: 0, delta: earlier.text, partial });
        return;
      }
      if (action === 'finish') {
        if (contentIndex > 0) source.push({ type: 'text_end', contentIndex: 0, content: earlier.text, partial });
        source.push({ type: 'text_end', contentIndex, content: block.text, partial });
        partial.stopReason = 'stop';
        source.push({ type: 'done', reason: 'stop', message: partial });
        send = undefined;
      }
    };
    if (stage === 'message_end') send('finish');
    return source;
  },
};
const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
  resourceLoader, sessionManager: manager, tools: [], thinkingLevel: 'off' });
await runRpcMode({ session, setRebindSession() {}, dispose() { session.dispose(); }, fork(entryId) {
  manager.createBranchedSession(entryId);
  return { cancelled: false };
} });
`;

function startWorker(t, cwd, stage = '') {
  const worker = new AgentWorker({ command: process.execPath, cwd: repo, timeout: 12_000,
    args: ['--input-type=module', '--eval', child],
    env: { ...process.env, PI_DESKTOP_SESSION: '1', PI_REATTACH_FIXTURE_DIR: cwd, PI_REATTACH_FIXTURE_STAGE: stage },
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, stdio: [...options.stdio, 'ipc'] }),
  });
  const held = Promise.withResolvers();
  const events = [];
  worker.child.on('message', message => { if (message === 'held') held.resolve(); });
  worker.on('event', (event, sequence) => events.push({ event, sequence }));
  const watch = promise => Promise.race([promise, worker.exited.then(() => { throw Error(worker.stderr || 'Fixture stopped'); })]);
  function waitFor(predicate) {
    const previous = events.find(predicate);
    if (previous) return Promise.resolve(previous);
    return watch(new Promise(resolve => {
      const onEvent = (event, sequence) => {
        if (!predicate({ event, sequence })) return;
        worker.off('event', onEvent);
        resolve({ event, sequence });
      };
      worker.on('event', onEvent);
    }));
  }
  async function stop() {
    if (worker.child.connected) {
      worker.child.send('release');
      worker.child.send('finish');
    }
    await worker.stop();
  }
  t.after(stop);
  return { worker, events, held: stage.startsWith('message_') ? watch(held.promise) : undefined, waitFor, stop };
}

const history = (worker, options) => worker.requestWithBoundary('get_messages', { projection: 'desktop', ...options });
const assistantMessages = state => state.messages.filter(row => row.kind === 'assistant').map(messageText);
const savedAssistants = data => data.messages.filter(message => message.role === 'assistant').map(messageText);
const textDelta = ({ event }) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta';
const settled = ({ event }) => event.type === 'agent_settled';

function reattach({ data, sequence }) {
  const state = createConversation(data.messages, data.streamingMessage);
  return {
    state,
    replay(events) {
      for (const item of events) {
        if (item.sequence <= sequence) continue;
        applyAgentEvent(state, item.event);
        sequence = item.sequence;
      }
    },
  };
}

for (const [stage, expectedPreview] of [['message_start', null], ['message_update', ''], ['message_end', phrase]]) {
  test(`desktop reattach follows the RPC boundary while ${stage} waits for an extension`, { timeout: 20_000 }, async t => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-'));
    const fixture = startWorker(t, cwd, stage);
    const { worker, events, held, waitFor } = fixture;
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    await worker.request('prompt', { message: 'Current fixture prompt.' });
    await held;
    const boundary = await history(worker);
    assert.equal(boundary.data.isStreaming, true);
    assert.equal(boundary.data.streamingMessage === null ? null : messageText(boundary.data.streamingMessage), expectedPreview);
    assert.deepEqual(savedAssistants(boundary.data), [previous]);
    const view = reattach(boundary);
    worker.child.send('release');
    if (stage !== 'message_end') {
      await waitFor(textDelta);
      view.replay(events);
      assert.deepEqual(assistantMessages(view.state), [previous, phrase]);
      worker.child.send('finish');
    }
    await waitFor(settled);
    view.replay(events);
    assert.deepEqual(assistantMessages(view.state), [previous, phrase]);
    const complete = (await history(worker)).data;
    assert.equal(complete.streamingMessage, null);
    assert.deepEqual(savedAssistants(complete), [previous, phrase]);
  });
}

test('desktop reattach appends identical deltas, expires old fork cursors and restores settled history in a fresh worker', { timeout: 30_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-'));
  const fixture = startWorker(t, cwd, 'sparse');
  const { worker, events, waitFor } = fixture;
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await worker.request('prompt', { message: 'Current fixture prompt.' });
  await waitFor(textDelta);
  const boundary = await history(worker);
  assert.equal(messageText(boundary.data.streamingMessage), phrase);
  assert.equal(boundary.data.streamingMessage.content[1].text, phrase);
  const view = reattach(boundary);
  worker.child.send('append');
  const second = await waitFor(item => item.sequence > boundary.sequence && textDelta(item));
  view.replay(events);
  assert.deepEqual(assistantMessages(view.state), [previous, phrase + phrase]);
  worker.child.send('fill');
  await waitFor(item => item.sequence > second.sequence && textDelta(item));
  view.replay(events);
  const completeText = `${prefix}\n${phrase}${phrase}`;
  assert.deepEqual(assistantMessages(view.state), [previous, completeText]);
  worker.child.send('finish');
  await waitFor(settled);
  const { data: page } = await history(worker, { limit: 1 });
  assert.ok(page.anchor);
  await worker.request('clone');
  assert.deepEqual((await history(worker, { before: page.before, anchor: page.anchor })).data, { reset: true, messages: [] });
  await fixture.stop();

  const { worker: restarted } = startWorker(t, cwd);
  const restored = (await history(restarted)).data;
  assert.equal(restored.streamingMessage, null);
  assert.deepEqual(savedAssistants(restored), [previous, completeText]);
});
