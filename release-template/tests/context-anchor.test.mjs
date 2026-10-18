import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let agent = path.resolve(import.meta.dirname, '../agent');
try { await fs.access(agent); } catch { agent = path.resolve(import.meta.dirname, '../..'); }
const { createContextAnchor, STICKY_MIN_CHARS } = await import(pathToFileURL(path.join(agent, 'extensions/lib/context-anchor.ts')));
const evidence = (content = 'Current source relationships') => ({ role: 'custom', customType: 'project-intelligence-context', content, display: false, timestamp: 0 });
const user = { role: 'user', content: 'Inspect the dependencies' };
const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/main.ts' } }] };
const result = { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'source' }] };

test('identical large ephemeral evidence preserves the complete previous request prefix across tool continuations', () => {
  const anchor = createContextAnchor({ stickyMinChars: 0 });
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
    const anchor = createContextAnchor({ stickyMinChars: 0 });
    anchor([user, call, result], evidence(), 'turn-1');
    const history = change === 'compact' ? [user] : [user, call, result, { role: 'assistant', content: 'Reviewed' }];
    if (change === 'rewrite') history[0] = { role: 'user', content: 'Inspect a different project' };
    const injection = evidence(change === 'facts' ? 'Updated source relationships' : undefined);
    const next = anchor(history, injection, change === 'turn' ? 'turn-2' : 'turn-1');
    assert.deepEqual(next, [...history, injection], change);
  }
});

test('a small block rides the tail on every call, so retiring or changing it never rewrites cached history', () => {
  const anchor = createContextAnchor();
  const note = evidence('UI verification: run ui_explore at 320px');
  const first = anchor([user], note, 'turn-1');
  assert.deepEqual(first, [user, note]);
  const history = [user, call, result];
  const second = anchor(structuredClone(history), note, 'turn-1');
  assert.deepEqual(second, [...history, note], 'the note follows the newest message instead of staying behind');
  assert.deepEqual(second.slice(0, history.length), history, 'every message before the tail is untouched, so the previous request prefix still matches');
  const retired = history; // the block goes away on a later call: nothing was left behind mid-history
  assert.deepEqual(retired.filter(message => message.customType), []);
});

test('only a block of at least STICKY_MIN_CHARS keeps its first boundary', () => {
  const big = evidence('x'.repeat(STICKY_MIN_CHARS));
  const anchor = createContextAnchor();
  const first = anchor([user], big, 'turn-1');
  const next = anchor([user, call, result], big, 'turn-1');
  assert.deepEqual(next.slice(0, first.length), first, 'a large unchanged block stays put');
  const small = evidence('y'.repeat(STICKY_MIN_CHARS - 200));
  const tail = createContextAnchor();
  tail([user], small, 'turn-1');
  assert.equal(tail([user, call, result], small, 'turn-1').at(-1), small);
});
