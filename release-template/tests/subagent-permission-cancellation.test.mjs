import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/watchdog/permission-arbiter.ts')),
);
assert.ok(agent, 'subagent source is available');
const base = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/')).href;
const { registerPermissionGate } = await import(base + 'runs/shared/subagent-prompt-runtime.ts');
const { createWatchdogPermissionArbiter } = await import(base + 'watchdog/permission-arbiter.ts');
const { PERMISSION_POLICY_ENV } = await import(base + 'runs/shared/permissions.ts');
const { CHILD_WATCHDOG_CONFIG_ENV } = await import(base + 'watchdog/child-status.ts');

const rawConfig = (timeout = 1000) => JSON.stringify({
  enabled: true, watchdogTailTimeoutMs: timeout, agentEndTimeoutMs: timeout,
  maxWarnings: 1, thinking: false,
  lsp: { enabled: false, timeoutMs: 100, maxFiles: 1, maxDiagnostics: 1 },
  autoFollowBlockers: false, autoFollowMaxAttempts: 0, stalemateRepeats: 2,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(done => setImmediate(done));

function gate(t, permission, timeout = 1000) {
  for (const [name, value] of [[PERMISSION_POLICY_ENV, '{"read":"ask"}'], [CHILD_WATCHDOG_CONFIG_ENV, rawConfig(timeout)]]) {
    const prior = process.env[name];
    process.env[name] = value;
    t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  }
  let handler;
  registerPermissionGate({ on: (event, fn) => { if (event === 'tool_call') handler = fn; } }, permission);
  return handler;
}

test('a synchronous cancellation during permission dispatch cannot approve the tool', async t => {
  const controller = new AbortController();
  const handler = gate(t, async () => {
    controller.abort();
    return { approved: true, reason: 'Fixture approval', source: 'watchdog' };
  });
  const result = await handler({ toolName: 'read', input: {} }, { signal: controller.signal });
  assert.equal(result?.block, true);
  assert.match(result.reason, /cancel/i);
});

test('the hook deadline cancels its reviewer without aborting the parent signal', async t => {
  const controller = new AbortController();
  let reviewerSignal;
  const handler = gate(t, async request => {
    reviewerSignal = request.signal;
    return new Promise(() => {});
  }, 30);
  const result = await handler({ toolName: 'read', input: {} }, { signal: controller.signal });
  assert.equal(result.block, true);
  assert.match(result.reason, /timed out/i);
  assert.equal(reviewerSignal.aborted, true);
  assert.equal(controller.signal.aborted, false);
});

function delayedAuthArbiter() {
  const auth = deferred();
  let inferences = 0;
  const ctx = {
    model: { provider: 'fixture', id: 'model', reasoning: false },
    modelRegistry: { getApiKeyAndHeaders: () => auth.promise },
  };
  const arbiter = createWatchdogPermissionArbiter({ streamFn: () => { inferences++; throw new Error('Fixture stream must not be dispatched'); } });
  return { auth, ctx, arbiter, inferences: () => inferences };
}

test('cancellation during auth lookup does not launch a reviewer after the lookup resolves', async () => {
  const fixture = delayedAuthArbiter();
  const controller = new AbortController();
  const result = fixture.arbiter({ ctx: fixture.ctx, toolName: 'read', args: {}, signal: controller.signal, rawWatchdogConfig: rawConfig() });
  controller.abort();
  assert.equal((await result).approved, false);
  fixture.auth.resolve({ ok: true });
  await settle(); await settle();
  assert.equal(fixture.inferences(), 0);
});

test('an expired permission request does not launch a reviewer after delayed auth resolves', async () => {
  const fixture = delayedAuthArbiter();
  const result = await fixture.arbiter({ ctx: fixture.ctx, toolName: 'read', args: {}, rawWatchdogConfig: rawConfig(30) });
  assert.equal(result.approved, false);
  assert.match(result.reason, /timed out/i);
  fixture.auth.resolve({ ok: true });
  await settle(); await settle();
  assert.equal(fixture.inferences(), 0);
});

test('ordinary permission approval and pre-cancelled rejection retain their behavior', async t => {
  let calls = 0;
  const handler = gate(t, async () => { calls++; return { approved: true, reason: 'Fixture approval', source: 'watchdog' }; });
  assert.equal(await handler({ toolName: 'read', input: {} }, {}), undefined);
  const controller = new AbortController(); controller.abort();
  assert.equal((await handler({ toolName: 'read', input: {} }, { signal: controller.signal })).block, true);
  assert.equal(calls, 1);
});
