import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDesktopStreamingPreview, desktopEvent } from '../core/coding-agent/src/modes/rpc/desktop-projection.js';
import { AgentWorker } from '../desktop/agent-worker.mjs';
import { applyAgentEvent, createConversation, messageText } from '../desktop/renderer/conversation.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const previous = 'Previous fixture answer.';
const phrase = 'Next fixture phrase.';
const prefix = 'Earlier content slot.';
const toolName = 'reattach_fixture_tool';
const toolCallId = 'fixture-tool-call';
const secondToolCallId = 'fixture-second-tool-call';
const toolOutputPrefix = 'Raw fixture output ';
const toolOutputSize = 64_000;
const toolOutput = toolOutputPrefix + 'x'.repeat(toolOutputSize);
const finalToolOutput = 'Authoritative tool result from the message_end hook.';

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
const parallelTools = stage === 'parallel_tool_end';
const holdToolEnd = stage === 'tool_end' || parallelTools;
const held = Promise.withResolvers();
const heldSecond = Promise.withResolvers();
const secondPublished = Promise.withResolvers();
let send;
process.on('message', action => {
  if (action === 'release') held.resolve();
  else if (action === 'release-second') heldSecond.resolve();
  else send?.(action);
});
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    if (holdToolEnd) {
      pi.registerTool({ name: ${JSON.stringify(toolName)}, label: 'Fixture', description: 'Synthetic tool result',
        parameters: { type: 'object', properties: { slot: { type: 'string' } } },
        async execute(_id, args) {
          if (parallelTools && args.slot === 'first') await secondPublished.promise;
          return { content: [{ type: 'text', text: ${JSON.stringify(toolOutputPrefix)} + 'x'.repeat(${toolOutputSize}) }], details: {} };
        },
      });
      pi.on('message_end', async event => {
        if (event.message?.role !== 'toolResult') return;
        const second = event.message.toolCallId === ${JSON.stringify(secondToolCallId)};
        process.send(second ? 'held-second' : 'held');
        await (second ? heldSecond : held).promise;
        return { message: { ...event.message, isError: true, content: [{ type: 'text', text: ${JSON.stringify(finalToolOutput)} }] } };
      });
      return;
    }
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
    if (holdToolEnd && ++streamCount === 1) {
      partial.content.push({ type: 'toolCall', id: ${JSON.stringify(toolCallId)}, name: ${JSON.stringify(toolName)}, arguments: { slot: 'first' } });
      if (parallelTools) partial.content.push({ type: 'toolCall', id: ${JSON.stringify(secondToolCallId)}, name: ${JSON.stringify(toolName)}, arguments: { slot: 'second' } });
      partial.stopReason = 'toolUse';
      source.push({ type: 'done', reason: 'toolUse', message: partial });
      return source;
    }
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
    if (holdToolEnd || holdUserEnd || stage === 'message_end' || stage === 'queued-input' && ++streamCount > 1) send('finish');
    return source;
  },
};
const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
  resourceLoader, sessionManager: manager, tools: holdToolEnd ? [${JSON.stringify(toolName)}] : [], thinkingLevel: 'off' });
if (parallelTools) session.agent.subscribe(event => {
  if (event.type === 'tool_execution_end' && event.toolCallId === ${JSON.stringify(secondToolCallId)}) secondPublished.resolve();
});
await runRpcMode({ session, setRebindSession() {}, dispose() { session.dispose(); }, fork(entryId) {
  manager.createBranchedSession(entryId);
  return { cancelled: false };
} });
`;

function startWorker(t, cwd, stage = '', desktop = true) {
  const worker = new AgentWorker({ command: process.execPath, cwd: repo, timeout: 12_000,
    args: ['--input-type=module', '--eval', child],
    env: { ...process.env, PI_DESKTOP_SESSION: desktop ? '1' : '0', PI_REATTACH_FIXTURE_DIR: cwd, PI_REATTACH_FIXTURE_STAGE: stage },
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, stdio: [...options.stdio, 'ipc'] }),
  });
  const held = Promise.withResolvers();
  const heldSecond = Promise.withResolvers();
  const events = [];
  worker.child.on('message', message => {
    if (message === 'held') held.resolve();
    if (message === 'held-second') heldSecond.resolve();
  });
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
      worker.child.send('release-second');
      worker.child.send('finish');
    }
    await worker.stop();
  }
  t.after(stop);
  const holdsPublication = stage === 'user_end' || stage.endsWith('tool_end') || stage.startsWith('message_');
  return { worker, events, held: holdsPublication ? watch(held.promise) : undefined,
    heldSecond: stage === 'parallel_tool_end' ? watch(heldSecond.promise) : undefined, waitFor, stop };
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

const fixtureToolEvents = events => events.map(({ event }) => event).filter(event =>
  event.type === 'tool_execution_end' && event.toolName === toolName ||
  ['message_start', 'message_end'].includes(event.type) && event.message?.role === 'toolResult' && event.message.toolName === toolName);

test('desktop reattach drops the duplicate tool result start and applies the authoritative end', { timeout: 20_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-tool-'));
  const { worker, events, held, waitFor } = startWorker(t, cwd, 'tool_end');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await worker.request('prompt', { message: 'Run the fixture tool.' });
  await held;
  const boundary = await history(worker);
  const toolEvents = fixtureToolEvents(events.filter(({ sequence }) => sequence <= boundary.sequence));
  const provisional = messageText(toolEvents[0].result);
  assert.ok(provisional.startsWith(toolOutputPrefix));
  assert.match(provisional, /Desktop preview truncated/);
  assert.ok(provisional.length < toolOutput.length);
  assert.ok(boundary.data.messages.some(message => message.role === 'toolResult' && messageText(message) === provisional),
    'initial history includes the tool completion published before the boundary');
  assert.deepEqual(toolEvents.map(event => event.type), ['tool_execution_end']);
  const view = reattach(boundary);
  worker.child.send('release');
  await waitFor(settled);
  assert.deepEqual(fixtureToolEvents(events).map(event => event.type), ['tool_execution_end', 'message_end']);
  view.replay(events);
  const tools = view.state.messages.filter(item => item.kind === 'tool' && item.callId === toolCallId);
  assert.deepEqual(tools.map(({ status, output }) => [status, output]), [['error', finalToolOutput]]);
  const complete = (await history(worker)).data;
  assert.deepEqual(complete.messages.filter(message => message.role === 'toolResult').map(messageText), [finalToolOutput]);
});

test('generic RPC retains both tool result lifecycle events in owned loop order', { timeout: 20_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-generic-tool-'));
  const { worker, events, held, waitFor } = startWorker(t, cwd, 'tool_end', false);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await worker.request('prompt', { message: 'Run the fixture tool.' });
  await held;
  const pending = fixtureToolEvents(events);
  assert.deepEqual(pending.map(event => event.type), ['tool_execution_end', 'message_start']);
  assert.ok(messageText(pending[0].result) === toolOutput);
  assert.ok(messageText(pending[1].message) === toolOutput);
  worker.child.send('release');
  await waitFor(settled);
  const complete = fixtureToolEvents(events);
  assert.deepEqual(complete.map(event => event.type), ['tool_execution_end', 'message_start', 'message_end']);
  assert.equal(messageText(complete[2].message), finalToolOutput);
});

test('desktop reattach reconciles out-of-order parallel tool previews at each history boundary', { timeout: 20_000 }, async t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-reattach-parallel-tools-'));
  const { worker, events, held, heldSecond, waitFor } = startWorker(t, cwd, 'parallel_tool_end');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await worker.request('prompt', { message: 'Run both fixture tools.' });
  await held;
  const firstBoundary = await history(worker);
  const completionEvents = fixtureToolEvents(events.filter(({ sequence }) => sequence <= firstBoundary.sequence));
  assert.deepEqual(completionEvents.map(({ type, toolCallId }) => [type, toolCallId]), [
    ['tool_execution_end', secondToolCallId], ['tool_execution_end', toolCallId],
  ]);
  const provisional = messageText(completionEvents[0].result);
  const toolResults = data => data.messages.filter(message => message.role === 'toolResult');
  assert.deepEqual(new Set(toolResults(firstBoundary.data).map(message => message.toolCallId)), new Set([toolCallId, secondToolCallId]));
  assert.ok(toolResults(firstBoundary.data).every(message => messageText(message) === provisional));
  const firstView = reattach(firstBoundary);
  const toolRows = view => view.state.messages.filter(item => item.kind === 'tool');
  assert.deepEqual(toolRows(firstView).map(row => [row.callId, row.status]), [[toolCallId, 'done'], [secondToolCallId, 'done']]);
  assert.ok(toolRows(firstView).every(row => row.output === provisional.slice(0, 16_000)));
  const older = await history(worker, { before: firstBoundary.data.total });
  assert.equal(toolResults(older.data).length, 0);

  worker.child.send('release');
  await heldSecond;
  const secondBoundary = await history(worker);
  assert.deepEqual(toolResults(secondBoundary.data).map(message => [message.toolCallId, message.isError]), [[toolCallId, true], [secondToolCallId, false]]);
  assert.equal(messageText(toolResults(secondBoundary.data)[0]), finalToolOutput);
  assert.ok(messageText(toolResults(secondBoundary.data)[1]) === provisional);
  const secondView = reattach(secondBoundary);

  worker.child.send('release-second');
  await waitFor(settled);
  for (const view of [firstView, secondView]) {
    view.replay(events);
    assert.deepEqual(toolRows(view).map(row => [row.callId, row.status, row.output]), [
      [toolCallId, 'error', finalToolOutput], [secondToolCallId, 'error', finalToolOutput],
    ]);
  }
  const complete = (await history(worker)).data;
  assert.deepEqual(toolResults(complete).map(message => [message.toolCallId, messageText(message)]), [
    [toolCallId, finalToolOutput], [secondToolCallId, finalToolOutput],
  ]);
});

test('pending Desktop tool previews bound bytes and count, and drop finalized or reset results', () => {
  const preview = createDesktopStreamingPreview();
  const complete = (toolCallId, content = []) => preview.observe(desktopEvent({
    type: 'tool_execution_end', toolCallId, toolName, isError: false, result: { content },
  }));
  const image = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(1_500_000) };
  complete('oldest', [image]);
  complete('middle', [image]);
  complete('latest', [image]);
  assert.deepEqual(preview.toolMessages.map(message => message.toolCallId), ['middle', 'latest']);
  assert.ok(Buffer.byteLength(JSON.stringify(preview.toolMessages)) < 4 * 1024 * 1024);
  preview.observe(desktopEvent({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'middle', toolName, content: [] } }));
  assert.deepEqual(preview.toolMessages.map(message => message.toolCallId), ['latest']);
  for (let index = 0; index < 128; index++) complete(String(index));
  assert.equal(preview.toolMessages.length, 128);
  assert.equal(preview.toolMessages[0].toolCallId, '0');
  preview.observe({ type: 'agent_end' });
  assert.deepEqual(preview.toolMessages, []);
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
