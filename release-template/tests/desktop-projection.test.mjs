import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopHistory, desktopMessage, desktopEvent, desktopBranchMessages } from '../core/coding-agent/src/modes/rpc/desktop-projection.js';
import { createConversation, prependConversation } from '../desktop/renderer/conversation.mjs';
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
