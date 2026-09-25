import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/failure-cause.ts')),
);
assert.ok(agent, 'agent tree with failure-cause.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { classifyFailure, hashRequestShape, mayRetryShape, healthImpactForCause } = await import(shared + 'failure-cause.ts');
const { failureOf, projectRunEvidence } = await import(shared + 'run-history.ts');
const { compactForegroundResult, lastAssistantStopReason } = await import(shared + '../../shared/utils.ts');

test('last assistant transport truncation survives compact receipts without treating token counts or text as evidence', () => {
  const terminal = stopReason => ({ role: 'assistant', stopReason, content: [{ type: 'text', text: 'private fixture output' }] });
  for (const stopReason of ['length', 'max_tokens']) {
    const original = { exitCode: 1, error: 'child-error', messages: [terminal(stopReason)], usage: { output: 1024, reasoning: 1021 } };
    const compact = compactForegroundResult(original);
    assert.equal(compact.stopReason, stopReason);
    assert.equal(compact.messages, undefined);
    assert.equal(compactForegroundResult(compact).stopReason, stopReason);
    for (const result of [original, compact]) {
      const { cause, reason } = failureOf(result);
      assert.equal(reason, 'truncated');
      assert.equal(cause.category, 'output-truncated');
      assert.equal(cause.truncation, 'length-stop');
      assert.deepEqual(healthImpactForCause(cause), { cool: false, scope: 'none' });
      assert.doesNotMatch(JSON.stringify(projectRunEvidence(result)), /private fixture output/);
    }
  }
  const recovered = { exitCode: 0, messages: [terminal('length'), terminal('stop')] };
  assert.equal(failureOf(compactForegroundResult(recovered)).reason, undefined);
  assert.equal(failureOf({ exitCode: 1, messages: [terminal('length'), terminal(undefined)] }).reason, 'unknown');
  assert.equal(failureOf({ exitCode: 1, maxTokens: 1024, usage: { output: 1024, reasoning: 1021 }, messages: [{ role: 'toolResult', stopReason: 'length', content: [{ type: 'text', text: 'stopReason: length' }] }] }).reason, 'unknown');
  assert.equal(lastAssistantStopReason([terminal('length'), ...Array.from({ length: 64 }, () => ({ role: 'toolResult' }))]), undefined, 'legacy lookup scans a bounded tail');
  assert.equal(lastAssistantStopReason([terminal('length'.repeat(100))]), undefined, 'transport metadata stays bounded');
});

test('structured evidence outranks incidental text', () => {
  const cause = classifyFailure({ providerCode: 503, exitCode: 1, message: 'select schema, budget from t; all good' });
  assert.equal(cause.category, 'overload');
  assert.equal(cause.retryable, true);
});

test('incidental words in data never flip the category', () => {
  for (const message of [
    'select schema, budget from quarterly_report',
    "echo 'schema validation passed; no timeout observed'",
    'column "error" contains: timeout values forGrep display',
  ]) {
    const cause = classifyFailure({ error: true, message });
    assert.equal(cause.category, 'unknown', message);
  }
});

test('bare exit codes stay unknown without specific evidence', () => {
  assert.equal(classifyFailure({ error: true, exitCode: 1 }).category, 'unknown');
  assert.equal(classifyFailure({ error: true, exitCode: 1, signal: 'SIGTERM' }).category, 'process-signal');
});

test('128+N exit codes of a signal-trapping child are process signals, not unknown', () => {
  for (const exitCode of [129, 130, 137, 143]) assert.equal(classifyFailure({ error: true, exitCode }).category, 'process-signal');
  assert.equal(failureOf({ exitCode: 143, error: 'child-error' }).reason, 'process-signal');
  // A specific report in the message still outranks the bare exit code.
  assert.equal(classifyFailure({ error: true, exitCode: 143, message: 'HTTP 503 service unavailable' }).category, 'transport');
  assert.equal(classifyFailure({ error: true, exitCode: 2 }).category, 'unknown');
});

test('explicit lifecycle flags win over everything', () => {
  assert.equal(classifyFailure({ stopped: true, providerCode: 503 }).category, 'stopped');
  assert.equal(classifyFailure({ interrupted: true, exitCode: 1 }).category, 'interrupted');
});

test('truncation is its own category and never cools health', () => {
  for (const stopReason of ['length', 'max_tokens']) {
    const cause = classifyFailure({ stopReason, outputPresent: true });
    assert.equal(cause.category, 'output-truncated', stopReason);
    assert.deepEqual(healthImpactForCause(cause), { cool: false, scope: 'none' });
  }
  const structural = classifyFailure({ structuredOutputFailed: true });
  assert.equal(structural.category, 'output-truncated');
  assert.equal(structural.truncation, 'structural-cutoff');
});

test('deterministic shapes suppress identical retries only', () => {
  const cause = classifyFailure({ validatorCode: 'schema-mismatch', toolName: 'write_file', requestShape: { a: 1, requestId: 'x' } });
  assert.equal(cause.category, 'schema-incompatible');
  assert.equal(cause.deterministicShape, true);
  assert.ok(cause.shapeHash);
  const same = hashRequestShape({ a: 1, requestId: 'different-volatile' });
  assert.equal(same, cause.shapeHash, 'volatile fields are excluded from the shape hash');
  assert.equal(mayRetryShape(cause, same, same).allowed, false);
  assert.equal(mayRetryShape(cause, same, hashRequestShape({ a: 2 })).allowed, true);
});

test('health impact is granular to the failure domain', () => {
  assert.deepEqual(healthImpactForCause(classifyFailure({ providerCode: 503, backend: 'orcarouter' })), { cool: true, scope: 'backend' });
  assert.deepEqual(healthImpactForCause(classifyFailure({ validatorCode: 'schema-mismatch', backend: 'deepseek' })), { cool: false, scope: 'none' });
  assert.deepEqual(healthImpactForCause(classifyFailure({ providerCode: 429 })), { cool: true, scope: 'provider' });
  assert.deepEqual(healthImpactForCause(classifyFailure({ budgetExhausted: true })), { cool: false, scope: 'none' });
});

test('last-resort text needs failure verbs or provider codes', () => {
  assert.equal(classifyFailure({ error: true, message: 'HTTP 503 upstream' }).category, 'transport');
  assert.equal(classifyFailure({ error: true, message: 'request hit 429, slow down' }).category, 'rate-limit');
  assert.equal(classifyFailure({ error: true, message: 'budget limit exceeded for this key' }).category, 'budget-exhausted');
  assert.equal(classifyFailure({ error: true, message: 'Cannot find module "x"' }).category, 'dependency');
  assert.equal(classifyFailure({ error: true, message: 'schema validation failed for arguments' }).category, 'schema-incompatible');
});
