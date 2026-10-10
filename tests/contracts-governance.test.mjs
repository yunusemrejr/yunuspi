import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/execution-evidence.ts')),
);
assert.ok(agent, 'agent tree with execution-evidence.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { buildExecutionEvidence, mergeEvidenceLists } = await import(lib + 'execution-evidence.ts');
const { planFieldError } = await import(pathToFileURL(path.join(agent, 'extensions/rpiv-todo/state/plan.ts')));

test('owner/execution coherence is enforced by the reducer guard', () => {
  assert.ok(planFieldError({ owner: 'parent', execution: 'subagent' }), 'partial recovery state rejected');
  assert.equal(planFieldError({ owner: 'parent', execution: 'self' }), undefined);
  assert.equal(planFieldError({ owner: 'child', execution: 'subagent' }), undefined);
});

test('execution evidence envelope is minimal and mergeable', () => {
  const child = buildExecutionEvidence({ identity: { id: 'task-4', attempt: 2, todoId: 'todo-9', label: 'audit' }, owner: 'subagent', state: 'completed', cause: 'ok/accepted', artifacts: ['/tmp/a.json'], producer: 'child-ledger' });
  assert.equal(child.version, 1);
  assert.equal(child.provenance.schema, 'execution-evidence/v1');
  const review = buildExecutionEvidence({ identity: { id: 'qr-1', todoId: 'todo-9' }, owner: 'review', state: 'completed', producer: 'review-coordinator' });
  const merged = mergeEvidenceLists([child], [review, child]);
  assert.equal(merged.length, 2, 'same evidence merges, distinct owners coexist');
});
