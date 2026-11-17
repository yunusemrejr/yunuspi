import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { convertMessages } from './core/ai/src/api/openai-completions.js';
import { createAgentSession } from './core/coding-agent/src/core/sdk.js';
import { DefaultResourceLoader } from './core/coding-agent/src/core/resource-loader.js';
import { SessionManager } from './core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from './core/coding-agent/src/core/settings-manager.js';
import { runRpcMode } from './core/coding-agent/src/modes/rpc/rpc-mode.js';
import path from 'node:path';

const cwd = process.env.PI_REATTACH_FIXTURE_DIR;
const stage = process.env.PI_REATTACH_FIXTURE_STAGE;
const holdUserEnd = stage === 'user_end';
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
    if (!holdUserEnd && !stage.startsWith('message_')) return;
    pi.on(holdUserEnd ? 'message_end' : stage, async event => {
      if (event.message?.role !== (holdUserEnd ? 'user' : 'assistant')) return;
      if (stage === 'message_update' && event.assistantMessageEvent?.type !== 'text_delta') return;
      process.send('held');
      await held.promise;
    });
  }],
});
await resourceLoader.reload();
const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
const assistant = (content, stopReason, timestamp) => ({ role: 'assistant', api: model.api, provider: model.provider,
  model: model.id, content, stopReason, timestamp, usage: { input: 1, output: 1, totalTokens: 2,
    cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const manager = SessionManager.open(path.join(cwd, 'fixture.jsonl'), cwd, cwd);
if (!manager.getLeafEntry()) {
  manager.appendMessage({ role: 'user', content: 'Previous fixture prompt.', timestamp: 1 });
  manager.appendMessage(assistant([{ type: 'text', text: ${JSON.stringify(previous)} }], 'stop', 2));
}
let streamCount = 0;
const modelRuntime = {
  getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true,
  isUsingSubscription: () => false, getAuth: async () => ({ auth: { apiKey: 'synthetic' } }),
  streamSimple(_model, context) {
    if (stage === 'queued-input') {
      const messages = convertMessages(model, context, {});
      const user = messages.findLast(message => message.role === 'user');
      const image = Array.isArray(user?.content) && user.content.find(part => part.type === 'image_url');
      process.send({ type: 'provider-input', imageChars: image ? image.image_url.url.split(',')[1].length : 0,
        imageSuffix: image ? image.image_url.url.slice(-4) : null,
        hasDesktopInputId: Object.hasOwn(user, 'desktopInputId') || Object.hasOwn(context.messages.at(-1), 'desktopInputId') });
    }
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
    if (holdUserEnd || stage === 'message_end' || stage === 'queued-input' && ++streamCount > 1) send('finish');
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
  return { worker, events, held: stage === 'user_end' || stage.startsWith('message_') ? watch(held.promise) : undefined, waitFor, stop };
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

test('desktop reattach includes a published user start while its transcript append waits for an extension', { timeout: 20_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-user-'));
  const { worker, events, held, waitFor } = startWorker(t, cwd, 'user_end');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const message = 'Current fixture prompt.';
  const desktopInputId = randomUUID();
  await worker.request('prompt', { message, desktopInputId });
  await held;
  const boundary = await history(worker, { limit: 1 });
  const start = events.find(({ event }) => event.type === 'message_start' && event.desktopInputId === desktopInputId);
  assert.ok(start && start.sequence <= boundary.sequence, 'start already belongs to the history boundary');
  assert.deepEqual(boundary.data.messages.map(messageText), [previous, message]);
  const earlier = await history(worker, { before: boundary.data.before, anchor: boundary.data.anchor });
  assert.deepEqual(earlier.data.messages.map(messageText), ['Previous fixture prompt.']);
  const view = reattach(boundary);
  worker.child.send('release');
  await waitFor(settled);
  view.replay(events);
  assert.equal(view.state.messages.filter(item => item.kind === 'user' && messageText(item) === message).length, 1);
  const complete = (await history(worker)).data;
  assert.equal(complete.messages.filter(item => item.role === 'user' && messageText(item) === message).length, 1);
});

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

test('desktop RPC acknowledges the exact queued input when steering overtakes matching slash text and image previews differ', { timeout: 30_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-queued-input-'));
  const { worker, events, waitFor } = startWorker(t, cwd, 'queued-input');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const [initialId, followUpId, steerId, guardianId] = Array.from({ length: 4 }, () => randomUUID());
  const observations = [], providerDone = Promise.withResolvers();
  worker.child.on('message', evidence => {
    if (evidence?.type !== 'provider-input') return;
    observations.push(evidence);
    if (observations.length === 3) providerDone.resolve();
  });
  const initialAck = await worker.request('prompt', { message: 'Current fixture prompt.', desktopInputId: initialId });
  await waitFor(textDelta);

  const message = '/literal-fixture details';
  const image = data => ({ type: 'image', mimeType: 'image/png', data });
  const largeData = 'A'.repeat(4 * 1024 * 1024 + 4);
  const followUpAck = await worker.request('prompt', { message, images: [image('Yg==')], streamingBehavior: 'followUp', desktopInputId: followUpId });
  const steerAck = await worker.request('prompt', { message, images: [image(largeData)], streamingBehavior: 'steer', desktopInputId: steerId });
  worker.child.send('finish');
  await waitFor(settled);
  await providerDone.promise;

  const userStarts = events.map(item => item.event).filter(event => event.type === 'message_start' && event.message.role === 'user');
  assert.deepEqual(userStarts.map(event => event.desktopInputId), [initialId, steerId, followUpId]);
  assert.ok(userStarts.every(event => !Object.hasOwn(event.message, 'desktopInputId')));
  assert.equal(userStarts[1].message.content.some(part => part.type === 'image'), false);
  assert.match(messageText(userStarts[1].message), /omitted from this desktop preview/i);
  assert.equal(userStarts[2].message.content.find(part => part.type === 'image')?.data, 'Yg==');
  assert.deepEqual(observations.map(({ imageChars, imageSuffix, hasDesktopInputId }) => [imageChars, imageSuffix, hasDesktopInputId]), [
    [0, null, false], [largeData.length, 'AAAA', false], [4, 'Yg==', false],
  ]);
  assert.deepEqual(initialAck, { disposition: 'started' });
  assert.deepEqual(followUpAck, { disposition: 'queued' });
  assert.deepEqual(steerAck, { disposition: 'queued' });
  await assert.rejects(worker.request('prompt', { message: 'Invalid correlation ID', desktopInputId: 'invalid' }), /desktop input ID/i);
  assert.deepEqual(await worker.request('prompt', { message: '/guardian status', desktopInputId: guardianId }), { disposition: 'handled' });
  assert.equal(await worker.request('prompt', { message: '/guardian status' }), undefined);
  const recoveryMessageId = randomUUID();
  const recovered = () => worker.request('prompt', { message: '/guardian status', recoveryMessageId });
  assert.deepEqual(await recovered(), { recoveryMessageId, status: 'delivered' });
  assert.deepEqual(await recovered(), { recoveryMessageId, status: 'delivered' });
  assert.deepEqual(await worker.request('desktop_input_status', { recoveryMessageId: steerId }), { status: 'missing' });
  const transcript = readFileSync(path.join(cwd, 'fixture.jsonl'), 'utf8');
  for (const id of [initialId, followUpId, steerId, guardianId]) assert.equal(transcript.includes(id), false);
});
