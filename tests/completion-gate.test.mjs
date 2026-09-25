import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/completion-gate.ts')));
const { completesPlan, completionGate } = await import(pathToFileURL(path.join(agent, 'extensions/lib/completion-gate.ts')));

const tasks = [{ id: 1, status: 'completed' }, { id: 2, status: 'in_progress' }, { id: 3, status: 'pending' }];

test('only the call that closes the last open task is a plan-completion moment', () => {
  assert.equal(completesPlan(tasks, { action: 'update', id: 2, status: 'completed' }), false, 'task 3 stays open');
  assert.equal(completesPlan(tasks, { action: 'batch', operations: [{ action: 'update', id: 2, status: 'completed' }, { action: 'update', id: 3, status: 'completed' }] }), true);
  assert.equal(completesPlan(tasks, { action: 'batch', operations: [{ action: 'update', id: 2, status: 'completed' }, { action: 'delete', id: 3 }] }), true);
  assert.equal(completesPlan(tasks, { action: 'batch', operations: [{ action: 'delete', id: 2 }, { action: 'delete', id: 3 }] }), false, 'deleting is not completing');
  assert.equal(completesPlan([{ id: 2, status: 'in_progress' }], { action: 'update', id: 2, status: 'completed' }), true);
  assert.equal(completesPlan(tasks, { action: 'list' }), false);
});

test('unresolved receipts refuse once; the identical retry is a recorded waiver', () => {
  const refused = new Set();
  assert.deepEqual(completionGate('deploy', [], refused), { block: false, waived: false, key: 'deploy\0' });
  const lines = ['quality review: Independent review pending: current changes have not been accepted', 'project tests: Current checks unresolved (no checks)'];
  const first = completionGate('deploy', lines, refused);
  assert.equal(first.block, true);
  assert.match(first.reason, /Deploy refused[\s\S]*quality review[\s\S]*repeat the same call/);
  refused.add(first.key);
  const retry = completionGate('deploy', lines, refused);
  assert.deepEqual([retry.block, retry.waived], [false, true]);
  assert.equal(completionGate('plan-complete', lines, refused).block, true, 'a different moment is its own refusal');
  assert.equal(completionGate('deploy', [lines[0]], refused).block, true, 'a changed receipt set is refused afresh');
});
