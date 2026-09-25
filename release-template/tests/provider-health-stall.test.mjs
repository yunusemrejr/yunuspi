import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = [path.join(root, 'agent'), path.resolve(root, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'extensions/pi-subagents/src/runs/shared/provider-health.ts')),
);
assert.ok(agentRoot, 'provider health ships with the distribution');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-health-stall-'));
process.env.PI_PROVIDER_STATE_FILE = path.join(dir, 'health.json');
const health = await import(pathToFileURL(path.join(agentRoot, 'extensions/pi-subagents/src/runs/shared/provider-health.ts')));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a child deadline stall cools only its route and escalates per consecutive stall', () => {
  const stall = health.classifyFailure('Subagent timed out after 300000ms.');
  assert.deepEqual({ kind: stall.kind, scope: stall.scope, stall: stall.stall }, { kind: 'route-failure', scope: 'route', stall: true });
  // Tool-level timeouts and provider transport text keep their existing classes.
  assert.equal(health.classifyFailure('Tool bash timed out after 120s')?.stall, undefined);
  assert.equal(health.classifyFailure('request timed out')?.stall, undefined);

  const t0 = 1_800_000_000_000;
  const first = health.recordFailure({ provider: 'orcarouter', model: 'z-ai/glm-5.3-flash', errorMessage: 'Subagent timed out after 300000ms.', source: 'free-group-child', now: t0 });
  assert.equal(first.scope, 'route');
  assert.equal(first.cooldownUntil - t0, health.STALL_COOLDOWN_MS);
  // The retry happens after cooldown plus another full deadline; it still counts as consecutive.
  const t1 = t0 + health.STALL_COOLDOWN_MS + 300_000;
  const second = health.recordFailure({ provider: 'orcarouter', model: 'z-ai/glm-5.3-flash', errorMessage: 'Subagent timed out after 300000ms.', source: 'free-group-child', now: t1 });
  assert.equal(second.consecutive, 2);
  assert.equal(second.cooldownUntil - t1, 2 * health.STALL_COOLDOWN_MS);
  assert.equal(health.cooldownFor(stall, undefined, 50), health.STALL_COOLDOWN_CAP_MS);
  assert.equal(health.evaluateRoute({ provider: 'orcarouter', model: 'z-ai/glm-5.3-flash', now: t1 + 1000 }).allowed, false);
  assert.equal(health.evaluateRoute({ provider: 'orcarouter', model: 'other-route', now: t1 + 1000 }).allowed, true, 'sibling routes stay selectable');
});

test('dead credentials and exhausted credit hold the provider for an hour, and days-old failures expire', () => {
  const billing = health.classifyFailure('402: {"message":"Credit limit exceeded, please add credits"}');
  assert.equal(billing.kind, 'quota-rate');
  assert.equal(billing.billing, true);
  assert.equal(health.cooldownFor(billing, undefined, 1), health.ACCOUNT_HOLD_MS);
  assert.equal(health.cooldownFor(health.classifyFailure('401: Incorrect API key provided'), undefined, 1), health.ACCOUNT_HOLD_MS);
  const rate = health.classifyFailure('429 too many requests');
  assert.equal(rate.billing, undefined, 'transient rate pressure keeps its short paced cooldown');
  assert.ok(health.cooldownFor(rate, undefined, 1) < health.ACCOUNT_HOLD_MS);

  const old = Date.now() - health.STALE_FAILURE_MS - 60_000;
  health.recordFailure({ provider: 'stepfun', errorMessage: '401: Incorrect API key provided', source: 'message_end', now: old });
  health.recordFailure({ provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', errorMessage: 'upstream stream_read_error', source: 'message_end', now: old });
  // Any later mutation reconciles the store.
  health.recordRequest({ provider: 'deepseek', estTokens: 10 });
  const state = health.readHealth();
  assert.equal(state.providers.stepfun.failure, undefined, 'expired day-old auth failure no longer pins the provider');
  assert.equal(state.providers.openrouter.models['qwen/qwen3.8-27b:free'].failure, undefined);
});
