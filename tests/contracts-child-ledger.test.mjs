import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/child-ledger.ts')),
);
assert.ok(agent, 'agent tree with child-ledger.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { reduceChildEvents, deriveAttemptOutcome, deriveLogicalState, summarizeLedger, projectTranscriptChildren } = await import(shared + 'child-ledger.ts');
const { buildChildTaskIdentity, nextAttemptIdentity, labelChildTask } = await import(shared + 'child-identity.ts');

test('terminal states are never overwritten by secondary flags', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 't1', label: 'task', attempt: 1, runId: 'r1' },
    { type: 'stop', taskId: 't1', runId: 'r1' },
    { type: 'completion', taskId: 't1', runId: 'r1', row: { status: 'failed', exitCode: 1, error: 'boom' } },
  ]);
  const task = ledger.tasks[0];
  assert.equal(task.state, 'stopped');
  assert.equal(task.attempts[0].exitCode, 1, 'exit code kept as secondary evidence');
});

test('interrupted work pauses; it is not failed', () => {
  const outcome = deriveAttemptOutcome({ interrupted: true, exitCode: 1 });
  assert.equal(outcome.state, 'paused');
});

test('execution and acceptance outcomes stay independent', () => {
  const executedButRejected = deriveAttemptOutcome({ status: 'completed', exitCode: 0, acceptance: { status: 'rejected', reason: 'missing tests' } });
  assert.equal(executedButRejected.state, 'failed');
  assert.equal(executedButRejected.execution.status, 'succeeded');
  assert.equal(executedButRejected.acceptance.status, 'failed');

  const transport = deriveAttemptOutcome({ status: 'failed', providerCode: 503 });
  assert.equal(transport.state, 'failed');
  assert.equal(transport.execution.cause.category, 'overload');
  assert.equal(transport.acceptance.status, 'none', 'provider failure is not rewritten as verification');
});

test('retries bind to the logical task as attempt trees', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 'task-4', label: 'task #4 automatic search', attempt: 1, runId: 'a' },
    { type: 'completion', taskId: 'task-4', runId: 'a', row: { status: 'failed', stopReason: 'length' } },
    { type: 'recovery', taskId: 'task-4', reason: 'resume synthesis', replacementAttempt: 2 },
    { type: 'launch', taskId: 'task-4', attempt: 2, runId: 'b' },
    { type: 'completion', taskId: 'task-4', runId: 'b', row: { status: 'completed', exitCode: 0 } },
  ]);
  assert.equal(ledger.tasks.length, 1);
  const task = ledger.tasks[0];
  assert.equal(task.state, 'completed');
  assert.equal(task.attempts.length, 2);
  assert.equal(task.attempts[0].execution.cause.category, 'output-truncated');
  assert.equal(task.attempts[1].state, 'completed');
  assert.deepEqual(ledger.unresolved, []);
});

test('accounting never moves lifecycle state', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 't', attempt: 1, runId: 'r' },
    { type: 'completion', taskId: 't', runId: 'r', row: { status: 'completed', exitCode: 0 } },
    { type: 'accounting', taskId: 't', runId: 'r', usage: { input: 10, output: 5 } },
  ]);
  assert.equal(ledger.tasks[0].state, 'completed');
  assert.equal(ledger.tasks[0].attempts[0].usage.input, 10);
});

test('identity: labels come from the child task, retries keep the task id', () => {
  assert.equal(labelChildTask('Task #4: run the Luka live search. Then report.'), 'Task #4: run the Luka live search.');
  const first = buildChildTaskIdentity({ runId: 'run-1', index: 3, childTask: 'Task #4 automatic Luka live search', todoId: 'todo-9' });
  assert.equal(first.attempt, 1);
  assert.ok(first.label.includes('Luka'));
  const second = nextAttemptIdentity(first);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.attempt, 2);
});

test('logical state reflects the latest terminal attempt', () => {
  const { state } = deriveLogicalState([
    { attempt: 1, state: 'failed', execution: { status: 'failed' }, acceptance: { status: 'none' } },
    { attempt: 2, state: 'completed', execution: { status: 'succeeded' }, acceptance: { status: 'passed' } },
  ]);
  assert.equal(state, 'completed');
});

test('transcript projection feeds the reducer deterministically', () => {
  const entries = [
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', details: { runId: 'p1', results: [{ index: 0, status: 'completed', exitCode: 0, model: 'q/m', label: 'audit login' }] } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'p1', results: [{ index: 0, status: 'completed', model: 'q/m', usage: { input: 20, output: 5 } }] } },
  ];
  const first = reduceChildEvents(projectTranscriptChildren(entries));
  const second = reduceChildEvents(projectTranscriptChildren(entries));
  assert.deepEqual(first, second, 'same events reduce to the same ledger');
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].state, 'completed');
  assert.equal(first.tasks[0].attempts[0].usage.input, 20);
  assert.equal(summarizeLedger(first).completed, 1);
});
