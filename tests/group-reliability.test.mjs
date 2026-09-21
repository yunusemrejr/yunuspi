import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/group-reliability.ts')),
);
assert.ok(agent, 'agent tree with group-reliability.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { classifyChildTerminal, childTerminalCause, groupCounters } = await import(shared + 'group-reliability.ts');

test('paused classifies as cancelled, matching interrupted/stopped', () => {
  assert.equal(classifyChildTerminal({ status: 'paused' }), 'cancelled');
  assert.equal(classifyChildTerminal({ state: 'paused' }), 'cancelled');
  assert.equal(classifyChildTerminal({ interrupted: true }), 'cancelled');
  assert.equal(classifyChildTerminal({ status: 'stopped' }), 'cancelled');
  assert.equal(childTerminalCause({ status: 'paused' }), 'cancelled');
});

test('terminal/non-terminal classification is unchanged', () => {
  assert.equal(classifyChildTerminal({ status: 'completed' }), 'succeeded');
  assert.equal(classifyChildTerminal({ status: 'failed' }), 'failed');
  assert.equal(classifyChildTerminal({ status: 'timed_out' }), 'timed_out');
  assert.equal(classifyChildTerminal({}), undefined);
  assert.equal(classifyChildTerminal(undefined), undefined);
  const counters = groupCounters([{ status: 'completed' }, { status: 'paused' }, {}]);
  assert.deepEqual(
    [counters.requested, counters.terminal, counters.succeeded, counters.cancelled, counters.running, counters.degraded],
    [3, 2, 1, 1, 1, true],
  );
});
