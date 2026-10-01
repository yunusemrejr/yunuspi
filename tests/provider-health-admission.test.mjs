import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = [path.join(root, 'agent'), path.resolve(root, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'extensions/provider-gate.ts')),
);
assert.ok(agentRoot, 'provider gate ships with the distribution');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-health-admission-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_PROVIDER_STATE_FILE = path.join(dir, 'health.json');
process.env.PI_PROVIDER_GATE_MAX_WAIT_MS = '0';
delete process.env.PI_PROVIDER_GATE;

const health = await import(pathToFileURL(path.join(agentRoot, 'extensions/pi-subagents/src/runs/shared/provider-health.ts')));
const reset = () => fs.rmSync(process.env.PI_PROVIDER_STATE_FILE, { force: true });
const lockDir = `${process.env.PI_PROVIDER_STATE_FILE}.lock`;

test('an in-flight success that started before a failure cannot clear it', () => {
  reset();
  const startedAt = Date.now() - 50;
  health.recordFailure({ provider: 'p', model: 'm', errorMessage: '429 too many requests', now: Date.now() });
  health.recordSuccess({ provider: 'p', model: 'm', startedAt });
  const decision = health.evaluateRoute({ provider: 'p', model: 'm' });
  assert.equal(decision.allowed, false, 'older success must not erase the newer fleet cooldown');
  // A success from a request admitted AFTER the failure is genuine recovery evidence.
  health.recordSuccess({ provider: 'p', model: 'm', startedAt: Date.now() + 5 });
  assert.equal(health.evaluateRoute({ provider: 'p', model: 'm' }).allowed, true);
});

test('a success on another model cannot clear a provider hold recorded after it started', () => {
  reset();
  const startedAt = Date.now() - 50;
  health.recordFailure({ provider: 'p', model: 'a', errorMessage: '429 too many requests', now: Date.now() });
  health.recordSuccess({ provider: 'p', model: 'b', startedAt });
  assert.equal(health.evaluateRoute({ provider: 'p', model: 'a' }).allowed, false);
  assert.equal(health.evaluateRoute({ provider: 'p', model: 'b' }).allowed, false, 'provider-scoped hold still binds siblings');
});

test('an unattributed success keeps the legacy unconditional clear', () => {
  reset();
  health.recordFailure({ provider: 'p', model: 'm', errorMessage: '429 too many requests' });
  health.recordSuccess({ provider: 'p', model: 'm' });
  assert.equal(health.evaluateRoute({ provider: 'p', model: 'm' }).allowed, true);
});

test('a held state lock cannot let a request bypass an existing cooldown', async () => {
  reset();
  health.recordFailure({ provider: 'p', model: 'm', errorMessage: '429 too many requests' });
  fs.mkdirSync(lockDir); // fresh, so it is never taken over as stale
  try {
    const started = Date.now();
    await assert.rejects(
      () => health.gateRequest({ provider: 'p', model: 'm', estTokens: 10 }),
      (error) => error?.code === 'PI_AUTONOMOUS_REQUEST_DENIED',
      'cooldown evaluation is lock-free, so the denial survives a held lock',
    );
    assert.ok(Date.now() - started < 8000);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('waiting for a held lock yields to the event loop and stops on abort', async () => {
  reset();
  fs.mkdirSync(lockDir);
  try {
    const controller = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const started = Date.now();
    const pending = health.mutateHealthAsync(() => undefined, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(() => pending);
    clearInterval(timer);
    assert.ok(Date.now() - started < 1500, 'abort ends the lock wait promptly');
    assert.ok(ticks >= 5, `event loop kept running while waiting (ticks=${ticks})`);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('an allowed request still goes out when the state lock cannot be taken', async () => {
  reset();
  fs.mkdirSync(lockDir);
  try {
    const outcome = await health.gateRequest({ provider: 'healthy', model: 'm', estTokens: 10 });
    assert.equal(outcome.allowed, true, 'pressure bookkeeping is best-effort for a healthy route');
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('denied attempts are not recorded as outgoing pressure, admitted ones are', async () => {
  reset();
  health.recordFailure({ provider: 'p', model: 'm', errorMessage: '429 too many requests' });
  await assert.rejects(() => health.gateRequest({ provider: 'p', model: 'm', estTokens: 90_000 }));
  assert.equal(health.readHealth().providers.p.requests.length, 0);
  await health.gateRequest({ provider: 'q', model: 'm', estTokens: 40 });
  assert.equal(health.readHealth().providers.q.requests.length, 1);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
