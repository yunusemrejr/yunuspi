import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let agent = path.resolve(import.meta.dirname, '../agent');
try { await fs.access(agent); } catch { agent = path.resolve(import.meta.dirname, '../..'); }
const { createContextAnchor } = await import(pathToFileURL(path.join(agent, 'extensions/lib/context-anchor.ts')));
const evidence = (content = 'Current source relationships') => ({ role: 'custom', customType: 'project-intelligence-context', content, display: false, timestamp: 0 });
const user = { role: 'user', content: 'Inspect the dependencies' };
const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/main.ts' } }] };
const result = { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'source' }] };

test('identical ephemeral evidence preserves the complete previous request prefix across tool continuations', () => {
  const anchor = createContextAnchor();
  const first = anchor([user], evidence(), 'turn-1');
  const history = [user, call, result];
  const next = anchor(structuredClone(history), evidence(), 'turn-1');
  assert.deepEqual(next.slice(0, first.length), first);
  assert.deepEqual(next.slice(first.length), [call, result]);
  assert.deepEqual(history, [user, call, result], 'input history is not mutated');
  assert.equal(next.filter(message => message.customType).length, 1);
});

test('changed facts, new turns, branch rewrites and compaction relocate evidence to the current tail', () => {
  for (const change of ['facts', 'turn', 'rewrite', 'compact']) {
    const anchor = createContextAnchor();
    anchor([user, call, result], evidence(), 'turn-1');
    const history = change === 'compact' ? [user] : [user, call, result, { role: 'assistant', content: 'Reviewed' }];
    if (change === 'rewrite') history[0] = { role: 'user', content: 'Inspect a different project' };
    const injection = evidence(change === 'facts' ? 'Updated source relationships' : undefined);
    const next = anchor(history, injection, change === 'turn' ? 'turn-2' : 'turn-1');
    assert.deepEqual(next, [...history, injection], change);
  }
});
