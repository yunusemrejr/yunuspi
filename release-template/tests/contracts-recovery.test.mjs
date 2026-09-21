import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/recovery-advisor.ts')),
);
assert.ok(agent, 'agent tree with recovery-advisor.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { adviseRecovery, recoveryScope } = await import(shared + 'recovery-advisor.ts');
const { classifyFailure } = await import(shared + 'failure-cause.ts');

test('recovery is cause-specific, never generic', () => {
  const schema = adviseRecovery(classifyFailure({ validatorCode: 'schema-mismatch', backend: 'deepseek' }), { backend: 'deepseek', authorizedBackends: ['deepseek', 'openrouter'] });
  assert.ok(schema.actions.includes('fix-wire-schema'));
  assert.equal(schema.mustChangeShape, true);

  const overload = adviseRecovery(classifyFailure({ providerCode: 503, backend: 'orcarouter' }), { backend: 'orcarouter', authorizedBackends: ['orcarouter'] });
  assert.ok(overload.actions.includes('wait-retry') || overload.actions.includes('retry-fallback'));
  assert.equal(overload.mustChangeShape, false);

  const budget = adviseRecovery(classifyFailure({ budgetExhausted: true }));
  assert.deepEqual(budget.actions, ['choose-eligible-route']);

  const truncated = adviseRecovery(classifyFailure({ stopReason: 'length' }), { hasArtifacts: true, hasSessionState: true });
  assert.ok(truncated.actions.includes('resume'));

  const acceptance = adviseRecovery(classifyFailure({ acceptanceStatus: 'failed', outputPresent: true }), { hasPartialResults: true });
  assert.ok(acceptance.actions.includes('inspect-result'));

  const overflow = adviseRecovery(classifyFailure({ contextOverflow: true }));
  assert.ok(overflow.actions.includes('reduce-context'));

  const stopped = adviseRecovery(classifyFailure({ stopped: true }));
  assert.deepEqual(stopped.actions, []);
});

test('deterministic failures require shape change before retry', () => {
  const shape = 'abc123';
  const advice = adviseRecovery(
    classifyFailure({ validatorCode: 'invalid-params', requestShape: { a: 1 } }),
    { previousShapeHash: shape, currentShapeHash: shape },
  );
  assert.equal(advice.mustChangeShape, true);
  assert.ok(advice.reason.includes('identical payload') || advice.reason.includes('deterministic'));
});

test('parallel recovery preserves successful and running siblings', () => {
  const tasks = [
    { taskId: 'a', label: 'a', state: 'completed', attempts: [], execution: { status: 'succeeded' }, acceptance: { status: 'passed' } },
    { taskId: 'b', label: 'b', state: 'running', attempts: [], execution: { status: 'running' }, acceptance: { status: 'none' } },
    { taskId: 'c', label: 'c', state: 'failed', attempts: [], execution: { status: 'failed' }, acceptance: { status: 'none' } },
    { taskId: 'd', label: 'd', state: 'paused', attempts: [], execution: { status: 'failed' }, acceptance: { status: 'none' } },
  ];
  const { recover, preserved } = recoveryScope(tasks);
  assert.deepEqual(recover.map((t) => t.taskId).sort(), ['c', 'd']);
  assert.deepEqual(preserved.map((t) => t.taskId).sort(), ['a', 'b']);
});

test('recovery stays bound to the logical task id', () => {
  const advice = adviseRecovery(classifyFailure({ providerCode: 503 }), { taskId: 'task-4', attempt: 1 });
  assert.equal(advice.taskId, 'task-4');
  assert.equal(advice.replacementAttempt, 2);
});
