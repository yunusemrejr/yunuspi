import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/group-reliability.ts')),
);
assert.ok(agent, 'subagent source is available');
const runs = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/')).href;
const { classifyChildTerminal, childTerminalCause, groupCounters, groupLifecycleState } = await import(runs + 'shared/group-reliability.ts');
const { toWaitCompletion } = await import(runs + 'background/wait-completions.ts');

test('process exit evidence classifies slim child results without a status field', () => {
  assert.equal(classifyChildTerminal({ exitCode: 0 }), 'succeeded');
  assert.equal(childTerminalCause({ exitCode: 0 }), 'completed');
  assert.equal(classifyChildTerminal({ exitCode: 1 }), 'failed');
  for (const exitCode of [null, undefined, NaN, Infinity, 0.5])
    assert.equal(classifyChildTerminal({ exitCode }), undefined, 'missing or invalid exit evidence is unknown');
});

test('failure evidence wins over coarse completed status and successful process exit', () => {
  for (const facts of [
    { status: 'completed', success: false },
    { status: 'complete', ok: false },
    { status: 'completed', exitCode: 1 },
    { ok: true, exitCode: 1 },
    { status: 'succeeded', success: false },
    { status: 'completed', terminalOutcome: { state: 'failed' } },
    { ok: true, terminalOutcome: { state: 'partial' } },
    { exitCode: 0, success: false },
  ]) assert.equal(classifyChildTerminal(facts), 'failed', JSON.stringify(facts));
  assert.equal(classifyChildTerminal({ exitCode: 0, timedOut: true }), 'timed_out');
  assert.equal(classifyChildTerminal({ exitCode: 0, interrupted: true }), 'cancelled');
  assert.equal(classifyChildTerminal({ detached: true, ok: true }), 'succeeded');
  assert.equal(classifyChildTerminal({ status: 'running', exitCode: null }), undefined);
});

test('breaker causes survive when no separate cause was persisted', () => {
  for (const [breakerReason, expected] of [
    ['provider_failure_streak', 'provider_failure'],
    ['tool_failure_streak', 'tool_failure'],
    ['no_useful_progress', 'tool_failure'],
    ['excessive_tool_calls', 'budget_exhausted'],
    ['excessive_turns', 'budget_exhausted'],
    ['stale_activity', 'timeout'],
    ['runaway_cost', 'budget_exhausted'],
  ]) assert.equal(childTerminalCause({ status: 'failed', breakerReason }), expected, breakerReason);
  assert.equal(childTerminalCause({ status: 'failed', breakerReason: 'new_unknown_breaker' }), 'unknown');
});

test('wait completion preserves success, failed contracts, and breaker causes for sibling decisions', () => {
  const results = [
    { agent: 'successful', exitCode: 0 },
    { agent: 'failed-contract', status: 'completed', success: false, exitCode: 0 },
    { agent: 'looping', status: 'failed', breakerReason: 'excessive_tool_calls' },
    { agent: 'active', status: 'running' },
  ];
  const completion = toWaitCompletion({ mode: 'parallel', results, requestedChildren: 5 }, 'fixture-run');
  assert.deepEqual(completion.results.map(row => row.terminalState), ['succeeded', 'failed', 'failed', undefined]);
  assert.equal(completion.results[2].terminalCause, 'budget_exhausted');
  assert.deepEqual(completion.groupCounters, {
    requested: 5, running: 2, succeeded: 1, failed: 2, cancelled: 0,
    timed_out: 0, terminal: 3, degraded: true,
  });
  assert.equal(completion.groupState, 'RUNNING_DEGRADED');
  const done = groupCounters(results.slice(0, 3));
  assert.equal(groupLifecycleState(done), 'FINISHED_DEGRADED');
  assert.equal(done.succeeded, 1, 'successful siblings remain reusable');
});
