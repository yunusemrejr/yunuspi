import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../core/agent/src/agent-loop.js';
import { streamSimple as openAICompletions } from '../core/ai/src/api/openai-completions.js';
import { toJsonEvent } from '../core/coding-agent/src/modes/json-event.js';
import { desktopHistory, desktopMessage, desktopEvent, desktopBranchMessages, desktopSessionHistory } from '../core/coding-agent/src/modes/rpc/desktop-projection.js';
import { applyAgentEvent, createConversation, messageText, prependConversation } from '../desktop/renderer/conversation.mjs';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';

test('desktop history pages newest records without gaps or duplicates', () => {
  const messages = Array.from({ length: 211 }, (_, index) => ({ role: 'user', content: `request ${index}` }));
  const collected = [];
  let before, more = true;
  while (more) { const page = desktopHistory(messages, { limit: 80, before }); collected.unshift(...page.messages); before = page.before; more = page.hasMore; }
  assert.deepEqual(collected, messages);
  assert.throws(() => desktopHistory(messages, { limit: 0 }), /limit/);
  assert.throws(() => desktopHistory(messages, { before: -1 }), /before/);
});

test('live desktop history walks an unchanged branch once and projects each bounded page', () => {
  const manager = SessionManager.inMemory('/tmp');
  manager.appendCustomEntry('goal-state-v1', { id: 'fixture', status: 'active', criteria: [{ status: 'open' }] });
  for (let index = 0; index < 301; index++) manager.appendMessage({ role: 'user', content: `request ${index}`, timestamp: index });
  manager.appendCustomMessageEntry('harness-activity', 'Fixture activity', true, { label: 'Fixture', status: 'done' });
  const expected = desktopBranchMessages(manager.getBranch());
  let walks = 0;
  const getBranch = manager.getBranch.bind(manager);
  manager.getBranch = () => { walks++; return getBranch(); };

  const initial = desktopSessionHistory(manager);
  assert.deepEqual(initial.goal, { id: 'fixture', status: 'active', settled: 0, total: 1 });
  assert.deepEqual(initial.messages, desktopHistory(expected).messages);
  const messages = [...initial.messages];
  let page = initial;
  while (page.hasMore) {
    assert.match(page.anchor, /^[a-f0-9]{64}$/);
    page = desktopSessionHistory(manager, { before: page.before, anchor: page.anchor });
    messages.unshift(...page.messages);
  }
  assert.deepEqual(messages, expected);
  assert.equal(walks, 1);
});

test('live history anchors survive append and shared ancestry but detect divergence and forks', () => {
  const manager = SessionManager.inMemory('/tmp');
  const append = content => manager.appendMessage({ role: 'user', content, timestamp: 1 });
  append('original');
  const shared = append('shared prefix');
  const boundary = append('left branch');
  const lastLeft = append('left tail');
  const initial = desktopSessionHistory(manager, { limit: 2 });
  const cursor = { before: initial.before, anchor: initial.anchor };
  const readOlder = () => desktopSessionHistory(manager, cursor);
  const visible = page => page.messages.map(message => message.content);

  append('appended through the same worker');
  assert.deepEqual(visible(readOlder()), ['original', 'shared prefix']);
  manager.branch(boundary);
  assert.deepEqual(visible(readOlder()), ['original', 'shared prefix']);

  manager.branch(shared);
  append('right branch');
  append('right tail');
  assert.deepEqual(readOlder(), { reset: true });
  assert.deepEqual(visible(desktopSessionHistory(manager, { limit: 2 })), ['right branch', 'right tail']);

  manager.branch(lastLeft);
  assert.deepEqual(visible(readOlder()), ['original', 'shared prefix']);
  const revision = manager.getEntriesRevision();
  const oldLeaf = manager.getLeafEntry();
  manager.createBranchedSession(lastLeft);
  assert.equal(manager.getLeafEntry().id, oldLeaf.id);
  assert.notEqual(manager.getLeafEntry(), oldLeaf);
  assert.notEqual(manager.getEntriesRevision(), revision);
  assert.deepEqual(readOlder(), { reset: true });
  assert.deepEqual(visible(desktopSessionHistory(manager, { limit: 2 })), ['left branch', 'left tail']);
  assert.throws(() => desktopSessionHistory(manager, { anchor: initial.anchor }), /anchor/);
});

test('large and escaped text histories stay below the transport record limit and remain pageable', () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({ role: 'assistant', content: [{ type: 'text', text: `${index}:` + '\u0000'.repeat(500_000) }] }));
  const page = desktopHistory(messages);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 9 * 1024 * 1024);
  assert.ok(page.hasMore);
  assert.ok(page.before > 0);
  assert.equal(messages[79].content[0].text.length, 500_003, 'projection never modifies source history');
  const next = desktopHistory(messages, { before: page.before });
  assert.equal(next.before + next.messages.length, page.before);
});

test('single multi-part message previews have a global byte bound including images and escaped text', () => {
  const content = Array.from({ length: 128 }, () => ({ type: 'text', text: '🙂\u0000'.repeat(100_000) }));
  content.unshift({ type: 'image', mimeType: 'image/png', data: 'x'.repeat(5 * 1024 * 1024) });
  const projected = desktopMessage({ role: 'assistant', content });
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 5 * 1024 * 1024);
  assert.ok(projected.content.some(p => /retained in session history/.test(p.text ?? '')));
  assert.equal(content.length, 129);
});

test('desktop live events drop redundant full-history/tool-update payloads but retain final results', () => {
  assert.deepEqual(desktopEvent({ type: 'agent_end', messages: ['huge'] }), { type: 'agent_end' });
  assert.equal(desktopEvent({ type: 'tool_execution_update', partialResult: 'huge' }), undefined);
  const event = desktopEvent({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'successful file read' }], details: { privateLargeResult: 'not needed for preview' } } });
  assert.equal(event.result.content[0].text, 'successful file read');
  assert.equal(event.result.details, undefined);
  assert.equal(event.toolCallId, 'call');
});

test('desktop shows the first provider delta once before EOF and preserves repeated text after a resume snapshot', { timeout: 3000 }, async () => {
  const live = createConversation(), visibleUpdates = [];
  let resumed, sourceStartText, body;
  const firstDelta = Promise.withResolvers();
  const text = 'Synthetic first text.';
  const encoder = new TextEncoder();
  const frame = (delta, finish_reason = null) => encoder.encode(`data: ${JSON.stringify({
    id: 'fixture-response', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const fetch = async () => new Response(new ReadableStream({ start(controller) {
    body = controller;
    body.enqueue(frame({ role: 'assistant', content: text }));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const model = {
    id: 'fixture', provider: 'openai', api: 'openai-completions', name: 'Fixture', baseUrl: 'https://example.invalid/v1',
    input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 256, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  await runAgentLoop([{ role: 'user', content: 'Synthetic prompt', timestamp: 1 }], { messages: [], tools: [] }, {
    model, apiKey: 'synthetic-token', convertToLlm: messages => messages, retryOwner: 'session',
  }, async event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      // A slow start subscriber (such as an extension hook) can let the adapter
      // mutate its shared content before RPC serializes the start event.
      await firstDelta.promise;
      sourceStartText = messageText(event.message);
    }
    const projected = desktopEvent(toJsonEvent(event));
    applyAgentEvent(live, projected);
    if (resumed) applyAgentEvent(resumed, projected);
    if (event.type !== 'message_update' || event.assistantMessageEvent.type !== 'text_delta') return;
    visibleUpdates.push(messageText(live.messages.at(-1)));
    if (resumed) {
      assert.equal(messageText(resumed.messages.at(-1)), text + text);
      return;
    }
    // Capture the same current partial that get_messages uses on reattach.
    resumed = createConversation([desktopMessage(event.message)]);
    resumed.streaming = resumed.messages[0].key;
    body.enqueue(frame({ content: text }));
    body.enqueue(frame({}, 'stop'));
    body.close();
  }, undefined, (selected, context, options) => {
    const source = openAICompletions(selected, context, { ...options, fetch });
    const push = source.push.bind(source);
    source.push = event => {
      push(event);
      if (event.type === 'text_delta') firstDelta.resolve();
    };
    return source;
  });

  assert.equal(sourceStartText, text, 'the shared start partial already contains the first delta');
  assert.deepEqual(visibleUpdates, [text, text + text]);
  assert.equal(messageText(live.messages.at(-1)), text + text);
  assert.equal(messageText(resumed.messages.at(-1)), text + text);
});

test('desktop history retains the persisted conversation through model-context compaction', () => {
  const manager = SessionManager.inMemory('/tmp');
  manager.appendMessage({ role: 'user', content: 'Original request before compaction', timestamp: 1 });
  const kept = manager.appendMessage({ role: 'user', content: 'Recent request', timestamp: 2 });
  manager.appendCompaction('A shorter model summary', kept, 50_000);
  const branch = desktopBranchMessages(manager.getBranch());
  assert.equal(branch[0].content, 'Original request before compaction');
  assert.ok(branch.some(message => message.customType === 'desktop-compaction'));
  assert.ok(!manager.buildSessionContext().messages.some(message => message.content === 'Original request before compaction'), 'fixture really compacted the model context');
  assert.equal(desktopHistory(branch).messages[0].content, 'Original request before compaction');
});

test('one tool call split across history pages merges into one completed card', () => {
  const state = createConversation([{ role: 'toolResult', toolCallId: 'same-call', toolName: 'read', content: [{ type: 'text', text: 'Final file output' }], isError: false }]);
  prependConversation(state, [{ role: 'assistant', content: [{ type: 'toolCall', id: 'same-call', name: 'read', arguments: { path: 'fixture.txt' } }] }]);
  const tools = state.messages.filter(m => m.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, 'done');
  assert.equal(tools[0].output, 'Final file output');
  assert.equal(tools[0].args.path, 'fixture.txt');
});
