import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/todo-linkage.ts')),
);
assert.ok(agent, 'agent tree with todo-linkage.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { applyRecoveryOwnership, linkAttemptToTodo, linkReviewToTodo, linkCheckpointToTodo, childTasksOfTodo } = await import(lib + 'todo-linkage.ts');
const { buildExecutionEvidence, mergeEvidenceLists } = await import(lib + 'execution-evidence.ts');
const { failModeFor, guardSubsystem } = await import(lib + 'fail-policy.ts');
const { planChildToolSubset, escalateChildTools, estimateToolSchemaTokens } = await import(shared + 'child-tool-subsets.ts');
const { extractTaskIntent } = await import(shared + 'task-intent-model.ts');
const { decideCoordination } = await import(shared + 'coordination-decision.ts');
const { planFieldError } = await import(pathToFileURL(path.join(agent, 'extensions/rpiv-todo/state/plan.ts')));

test('recovery ownership updates atomically', () => {
  const task = { id: 3, status: 'in-progress', owner: 'child', execution: 'subagent', refs: ['child:task-4#1'], runId: 'run-a' };
  const recovered = applyRecoveryOwnership(task, { reason: 'truncation; resume in parent', evidence: 'partial results kept', replacementRunId: 'run-b', replacementTaskId: 'task-4', completed: false });
  assert.equal(recovered.owner, 'parent');
  assert.equal(recovered.execution, 'self');
  assert.equal(recovered.runId, 'run-b');
  assert.ok(recovered.refs.some((r) => r.startsWith('recovery:')));
  assert.equal(recovered.metadata.recoveredInParent, true);
});

test('owner/execution coherence is enforced by the reducer guard', () => {
  assert.ok(planFieldError({ owner: 'parent', execution: 'subagent' }), 'partial recovery state rejected');
  assert.equal(planFieldError({ owner: 'parent', execution: 'self' }), undefined);
  assert.equal(planFieldError({ owner: 'child', execution: 'subagent' }), undefined);
});

test('todos own attempts, reviews, and checkpoints by id', () => {
  let task = { id: 1, refs: [] };
  task = linkAttemptToTodo(task, { runId: 'r1', attempt: 1, childTaskId: 'task-4', route: 'q/m' });
  task = linkAttemptToTodo(task, { runId: 'r2', attempt: 2, childTaskId: 'task-4' });
  task = linkReviewToTodo(task, { reviewId: 'qr-1', kind: 'quality_review', coverage: 'partial' });
  task = linkCheckpointToTodo(task, { kind: 'test', id: 'receipt-7' });
  assert.deepEqual(childTasksOfTodo(task), ['task-4']);
  assert.ok(task.refs.includes('review:qr-1') && task.refs.includes('test:receipt-7'));
  assert.equal(task.runId, 'r2');
});

test('execution evidence envelope is minimal and mergeable', () => {
  const child = buildExecutionEvidence({ identity: { id: 'task-4', attempt: 2, todoId: 'todo-9', label: 'audit' }, owner: 'subagent', state: 'completed', cause: 'ok/accepted', artifacts: ['/tmp/a.json'], producer: 'child-ledger' });
  assert.equal(child.version, 1);
  assert.equal(child.provenance.schema, 'execution-evidence/v1');
  const review = buildExecutionEvidence({ identity: { id: 'qr-1', todoId: 'todo-9' }, owner: 'review', state: 'completed', producer: 'review-coordinator' });
  const merged = mergeEvidenceLists([child], [review, child]);
  assert.equal(merged.length, 2, 'same evidence merges, distinct owners coexist');
});

test('fail policy: safety closed, guidance open, routing blocked-state', () => {
  assert.equal(failModeFor('safety'), 'fail-closed');
  assert.equal(failModeFor('authorization'), 'fail-closed');
  assert.equal(failModeFor('skill-ranking'), 'fail-open');
  assert.equal(failModeFor('telemetry'), 'fail-open');
  assert.equal(failModeFor('routing'), 'blocked-state');
  assert.equal(failModeFor('cost-gate'), 'blocked-state');
  assert.equal(failModeFor('no-such-subsystem'), 'fail-closed');

  const denied = guardSubsystem('safety', () => { throw new Error('boom'); }, 'fallback');
  assert.equal(denied.ok, false);
  assert.equal(denied.fallback, 'denied');
  assert.ok(denied.error.includes('boom'), 'errors retained, never swallowed');

  const skipped = guardSubsystem('telemetry', () => { throw new Error('boom'); }, 'fallback');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.value, 'fallback');
  assert.equal(skipped.fallback, 'skipped');
});

test('child tool subsets wire the minimum and escalate lazily', () => {
  const permitted = ['read_file', 'search', 'bash', 'write_file', 'edit_file', 'web_fetch', 'browser', 'query_data', 'contact_supervisor', 'utility'];
  const review = planChildToolSubset(extractTaskIntent('Review the login code for bugs.'), 'Review the login code for bugs.', permitted);
  assert.equal(review.template, 'source-review');
  assert.ok(!review.wire.includes('write_file'));
  assert.ok(review.deferred.includes('write_file'));
  assert.ok(review.wire.includes('contact_supervisor'), 'escalation channel always wired');

  const impl = planChildToolSubset(extractTaskIntent('Implement the login fix with tests.'), 'Implement the login fix with tests.', permitted);
  assert.equal(impl.template, 'implementation');
  assert.ok(impl.wire.includes('write_file'));

  const grant = escalateChildTools(review, permitted, { tools: ['write_file', 'forbidden_tool'], reason: 'fix found' });
  assert.ok(grant.granted.includes('write_file'));
  assert.ok(grant.denied.includes('forbidden_tool'), 'escalation never widens authority');
  assert.ok(estimateToolSchemaTokens(review.wire.length) < estimateToolSchemaTokens(permitted.length));
});

test('coordination decisions persist their reasons', () => {
  const single = decideCoordination({ separability: 0.1, uncertainty: 0.1, competingHypotheses: 0, implementationRisk: 0.2, expectedBenefit: 0.1, costEnvelope: 1 });
  assert.equal(single.mode, 'single');

  const swarm = decideCoordination({ separability: 0.8, uncertainty: 0.3, competingHypotheses: 0.1, implementationRisk: 0.2, expectedBenefit: 0.7, costEnvelope: 4, scopes: ['a', 'b', 'c'] });
  assert.equal(swarm.mode, 'swarm');
  assert.equal(swarm.members, 3);

  const council = decideCoordination({ separability: 0.2, uncertainty: 0.8, competingHypotheses: 0.6, implementationRisk: 0.9, expectedBenefit: 0.5, costEnvelope: 4 });
  assert.equal(council.mode, 'council');
  assert.ok(council.reasons.length >= 2);
});
