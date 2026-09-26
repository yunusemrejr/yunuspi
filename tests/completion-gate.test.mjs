import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/completion-gate.ts')));
const { completesPlan, completionGate, completionGateReceipts, gateReceiptKey } = await import(pathToFileURL(path.join(agent, 'extensions/lib/completion-gate.ts')));
const { registerContinuationSource, collectVerificationReceipts } = await import(pathToFileURL(path.join(agent, 'extensions/lib/continuation-notice.ts')));

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

test('rewording the same verdict does not reset the waiver; new heads refuse afresh', () => {
  const refused = new Set();
  const first = completionGate('plan-complete', ['quality review: Independent review blocked: Precise verification gap: no pixel-reading capability'], refused);
  assert.equal(first.block, true);
  assert.match(first.reason, /Precise verification gap/, 'display keeps the full line');
  refused.add(first.key);
  const reworded = completionGate('plan-complete', ['quality review: Independent review blocked: Recorded waiver per harness path: no pixel-reading capability'], refused);
  assert.deepEqual([reworded.block, reworded.waived], [false, true], 'same verdict, new wording still waives');
  assert.equal(completionGate('plan-complete', ['quality review: Independent review unavailable: reviewers down'], refused).block, true, 'a new disposition refuses afresh');
  const tests = new Set();
  const blocked = completionGate('plan-complete', ['project tests: Blocked: harness cannot run the suite'], tests);
  tests.add(blocked.key);
  assert.deepEqual(completionGate('plan-complete', ['project tests: Blocked: suite needs a device farm'], tests), { block: false, waived: true, key: blocked.key });
  const runs = new Set();
  const two = completionGate('plan-complete', ['subagents: 2 delegated runs have not finished. Pending results cannot support a completed or verified claim.'], runs);
  runs.add(two.key);
  assert.equal(completionGate('plan-complete', ['subagents: 1 delegated run has not finished. Pending results cannot support a completed or verified claim.'], runs).block, true, 'changed single-segment lines still refuse afresh');
});

test('structured receipts key on source/id/revision/state/count, never on prose', () => {
  const refused = new Set();
  const base = { source: 'quality-review', id: 'status:pending', revision: '3', state: 'unresolved', count: 2, line: 'quality review: Independent review pending: original wording' };
  const first = completionGateReceipts('plan-complete', [base], refused);
  assert.equal(first.block, true);
  refused.add(first.key);
  const reworded = { ...base, line: 'quality review: Independent review pending: totally: reworded, with: extra colons: and reordered detail' };
  assert.equal(gateReceiptKey(reworded), gateReceiptKey(base), 'prose is not identity');
  assert.deepEqual([completionGateReceipts('plan-complete', [reworded], refused).waived], [true]);
  for (const patch of [{ revision: '4' }, { state: 'blocked' }, { count: 3 }, { id: 'status:unavailable' }]) {
    assert.equal(completionGateReceipts('plan-complete', [{ ...base, ...patch }], refused).block, true, `new ${Object.keys(patch)[0]} refuses afresh`);
  }
  const other = { ...base, source: 'project-tests' };
  assert.equal(completionGateReceipts('plan-complete', [other], refused).block, true, 'same id under another source is a different receipt');
  assert.deepEqual(completionGateReceipts('deploy', [], refused), { block: false, waived: false, key: 'deploy\0' });
});

test('receipt collection prefers structured sources and fails legacy lines closed', () => {
  const session = {};
  const disposers = [
    registerContinuationSource({ name: 'quality review', session, pending: () => [], verification: () => ['Independent review pending: old'], verificationReceipts: () => [{ source: 'quality-review', id: 'status:pending', revision: '3', state: 'unresolved', count: 1, line: 'quality review: Independent review pending: structured' }] }),
    registerContinuationSource({ name: 'legacy', session, pending: () => [], verification: () => ['something: unresolved: detail here'] }),
    registerContinuationSource({ name: 'broken', session, pending: () => [], verificationReceipts: () => [{ source: '', id: '', state: '', line: '' }] }),
    registerContinuationSource({ name: 'other-session', session: {}, pending: () => [], verification: () => ['must not leak across sessions'] }),
  ];
  try {
    const receipts = collectVerificationReceipts(8, session);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[0], { source: 'quality-review', id: 'status:pending', revision: '3', state: 'unresolved', count: 1, line: 'quality review: Independent review pending: structured' });
    assert.deepEqual(receipts[1], { source: 'legacy', id: 'legacy: something: unresolved: detail here', state: 'unresolved', line: 'legacy: something: unresolved: detail here' });
  } finally { disposers.forEach(dispose => dispose()); }
});
