import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/session-errors.ts')));
assert.ok(agent, 'agent tree with session-errors.ts is present');
const { childFailureExcerpt, collectSessionDiagnostics, failureCategory } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-diagnostics.ts')));
const { collectSessionErrors } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-errors.ts')));

test('timeout excerpt names reason, stage and retryability', () => {
  assert.equal(
    childFailureExcerpt('child-error', { reason: 'timeout', cause: { stage: 'execute', category: 'timeout', retryable: true } }),
    'child-error (timed out at execute; retryable)');
});

test('reason without cause still names the reason', () => {
  assert.equal(childFailureExcerpt('Child failed', { reason: 'budget' }), 'Child failed (budget limit)');
});

test('base that already names the lead only gains the missing stage', () => {
  assert.equal(
    childFailureExcerpt('Child timed out', { reason: 'timeout', cause: { stage: 'execute', retryable: true }, timedOut: true }),
    'Child timed out (at execute; retryable)');
});

test('specific upstream text is returned unchanged', () => {
  assert.equal(childFailureExcerpt('Child timed out after 20000ms', { reason: 'timeout' }), 'Child timed out after 20000ms');
  assert.equal(childFailureExcerpt('boom: ECONNREFUSED', { reason: 'transport' }), 'boom: ECONNREFUSED');
});

test('cause without reason projects cause categories the way LEGACY_REASON does', () => {
  assert.equal(
    childFailureExcerpt('child-error', { cause: { stage: 'provider', category: 'rate-limit', retryable: true } }),
    'child-error (429 capacity at provider; retryable)');
  assert.equal(
    childFailureExcerpt('Child failed', { cause: { stage: 'budget', category: 'budget-exhausted', retryable: false } }),
    'Child failed (budget limit at budget; not retryable)');
});

test('unknown and none categories never become the lead', () => {
  assert.equal(childFailureExcerpt('Child failed', { cause: { category: 'unknown' } }), 'Child failed (no failure cause recorded)');
  assert.equal(childFailureExcerpt('Child failed', { cause: { category: 'none' } }), 'Child failed (no failure cause recorded)');
});

test('bare failure without any cause says so, with the exit code when present', () => {
  assert.equal(childFailureExcerpt('Child failed', {}), 'Child failed (no failure cause recorded)');
  assert.equal(childFailureExcerpt('Child failed', { exitCode: 1 }), 'Child failed (exit 1; no failure cause recorded)');
});

test('malformed cause info never throws and never invents a cause', () => {
  assert.equal(childFailureExcerpt('Child failed', { cause: 'oops' }), 'Child failed (no failure cause recorded)');
  assert.equal(childFailureExcerpt('Child failed', { cause: null, reason: 42 }), 'Child failed (no failure cause recorded)');
  assert.equal(childFailureExcerpt('Child failed'), 'Child failed (no failure cause recorded)');
});

test('enriched excerpts classify honestly: timeout cause classifies, no-cause stays unclassified', () => {
  assert.equal(failureCategory('child-error (timed out at execute; retryable)').category, 'timeout');
  assert.equal(failureCategory('Child failed (no failure cause recorded)').category, 'unclassified');
  assert.equal(failureCategory('Child failed (exit 1; no failure cause recorded)').category, 'unclassified');
});

const costRow = (row) => ({ type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'run-7', mode: 'single', results: [row] } });

test('diagnostics child failure carries the cause excerpt', () => {
  const report = collectSessionDiagnostics([costRow({
    index: 0, runId: 'run-7', status: 'failed', timedOut: true,
    evidence: { version: 1, outcomeReason: 'timeout', attemptCount: 1, output: 'absent', cause: { stage: 'execute', category: 'timeout', retryable: true } },
  })]);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].kind, 'child');
  assert.equal(report.failures[0].error, 'Child timed out (at execute; retryable)');
  assert.equal(report.failures[0].category, 'timeout');
});

test('errors export child failure carries the cause excerpt and keeps sibling fields', () => {
  const report = collectSessionErrors([costRow({
    index: 0, runId: 'run-7', status: 'failed', exitCode: 1, error: 'child-error',
    evidence: { version: 1, outcomeReason: 'timeout', attemptCount: 2, output: 'absent', cause: { stage: 'execute', category: 'timeout', retryable: true } },
  })]);
  assert.equal(report.total, 1);
  const item = report.errors[0];
  assert.equal(item.error, 'child-error (timed out at execute; retryable; exit 1)');
  assert.equal(item.category, 'timeout');
  assert.equal(item.attempts, 2);
  assert.equal(item.outputPresence, 'absent');
});

test('errors export child failure without evidence names the missing cause', () => {
  const report = collectSessionErrors([costRow({ index: 0, runId: 'run-7', status: 'failed', exitCode: 1 })]);
  assert.equal(report.total, 1);
  assert.equal(report.errors[0].error, 'Child failed (exit 1; no failure cause recorded)');
  assert.equal(report.errors[0].category, 'unclassified');
});
