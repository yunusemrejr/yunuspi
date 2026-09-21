import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/cost-states.ts')),
);
assert.ok(agent, 'agent tree with cost-states.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { classifyCostState, formatCost, formatCostRow } = await import(lib + 'cost-states.ts');
const { normalizeModelIdentity, formatModelIdentity } = await import(
  pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/shared/model-identity.ts'))
);
const { checkHarnessInvariants, formatInvariantWarnings } = await import(lib + 'harness-invariants.ts');

test('unknown cost is never rendered as $0', () => {
  assert.equal(classifyCostState({}), 'unknown');
  assert.equal(formatCost(0, 'unknown'), '$?');
  assert.equal(formatCost(0, 'pending'), '$+?');
  assert.equal(formatCost(0.002, 'pending'), '$~0.002000+?');
  assert.ok(!/0\.0/.test(formatCost(0, 'unknown')), 'unknown never renders zero digits');
});

test('verified zero and free evidence render explicitly', () => {
  assert.equal(classifyCostState({ seen: true, reported: 0, estimated: 0 }), 'verified-zero');
  assert.equal(formatCost(0, 'verified-zero'), '$0.000 (verified)');
  assert.equal(formatCost(0, 'free-evidence'), '$0.000 (free)');
  assert.equal(formatCost(0.001234, 'estimated'), '$~0.001234');
  assert.equal(formatCost(0.001234, 'provider-reported'), '$0.001234');
  assert.ok(formatCostRow('openrouter/x', 0, 'unknown').includes('[unknown]'));
});

test('model identity splits provider, model, variant, free, thinking, backend', () => {
  const full = normalizeModelIdentity('openrouter/deepseek/deepseek-chat:free:high', 'orcarouter');
  assert.equal(full.provider, 'openrouter');
  assert.equal(full.model, 'deepseek/deepseek-chat');
  assert.equal(full.free, true);
  assert.equal(full.thinking, 'high');
  assert.equal(full.backend, 'orcarouter');
  assert.ok(!full.canonicalId.includes(':high') && !full.canonicalId.includes(':free'));

  const plain = normalizeModelIdentity('deepseek/reasoner');
  assert.equal(plain.thinking, 'unknown');
  assert.equal(plain.free, false);
  assert.equal(plain.canonicalId, 'deepseek/reasoner');

  const nitro = normalizeModelIdentity('openrouter/x:nitro');
  assert.equal(nitro.backend, 'nitro');
  assert.ok(formatModelIdentity(full).includes('[free, high, orcarouter]'));
});

test('invariant checker catches cross-surface contradictions', () => {
  const violations = checkHarnessInvariants({
    ledger: { tasks: [{ taskId: 't1', state: 'stopped', attempts: [], execution: { status: 'failed' }, acceptance: { status: 'none' } }] },
    aggregate: { stopped: 0, failed: 1 },
    renderedRows: [{ taskId: 't1', state: 'failed' }],
    cost: { unknown: true, formatted: '$0.000' },
    models: [{ route: 'p/m:high', thinking: ['low'] }],
  });
  const ids = violations.map((v) => v.id);
  assert.ok(ids.includes('aggregate-detail-mismatch'));
  assert.ok(ids.includes('row-state-mismatch'));
  assert.ok(ids.includes('unknown-cost-as-zero'));
  assert.ok(ids.includes('thinking-suffix-mismatch'));
  assert.ok(formatInvariantWarnings(violations).every((line) => line.startsWith('harness-integrity')));

  const clean = checkHarnessInvariants({
    ledger: { tasks: [{ taskId: 't1', state: 'completed', attempts: [], execution: { status: 'succeeded' }, acceptance: { status: 'passed' } }] },
    aggregate: { completed: 1, active: 0 },
    renderedRows: [{ taskId: 't1', state: 'completed' }],
    cost: { unknown: false, formatted: '$0.001234' },
  });
  assert.deepEqual(clean, []);
});

test('retry-to-task mislinking and acceptance-without-execution are flagged', () => {
  const violations = checkHarnessInvariants({
    ledger: {
      tasks: [
        { taskId: 't1', state: 'failed', attempts: [{ attempt: 1, state: 'failed', runId: 'r1' }], execution: { status: 'failed' }, acceptance: { status: 'none' } },
        { taskId: 't2', state: 'failed', attempts: [{ attempt: 1, state: 'failed', runId: 'r1' }], execution: { status: 'none' }, acceptance: { status: 'failed' } },
      ],
    },
  });
  const ids = violations.map((v) => v.id);
  assert.ok(ids.includes('retry-wrong-task'));
  assert.ok(ids.includes('acceptance-without-execution'));
});
