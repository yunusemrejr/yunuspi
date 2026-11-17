import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createJiti } from 'jiti';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'yunuspi-auto-drain-'));
const previousRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
after(() => {
  if (previousRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  else process.env.PI_SUBAGENTS_TEMP_ROOT = previousRoot;
  rmSync(tempRoot, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.dirname);
const { default: registerRuntime } = await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts');
const { registerBackgroundWorkProvider } = await jiti.import('../agent/extensions/pi-subagents/src/api/background-work.ts');

async function fixture(t) {
  const sessionId = 'fixture-headless';
  const wakeChannel = 'fixture:headless-work';
  const controller = new AbortController();
  const hooks = new Map();
  const bus = new EventEmitter();
  const waiting = Promise.withResolvers();
  const ctx = { hasUI: false, signal: controller.signal, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => null } };
  await registerRuntime({
    on(event, handler) { const entries = hooks.get(event) ?? []; entries.push(handler); hooks.set(event, entries); },
    registerTool() {},
    events: { on(channel, handler) {
      bus.on(channel, handler);
      if (channel === wakeChannel) waiting.resolve();
      return () => bus.off(channel, handler);
    } },
  });
  for (const handler of hooks.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);

  const work = { active: true, snapshots: 0 };
  const unregister = registerBackgroundWorkProvider({
    name: 'fixture-headless-provider', wakeChannels: [wakeChannel],
    listActiveWork({ sessionId: owner }) {
      work.snapshots += 1;
      return work.active && owner === sessionId ? [{ id: 'fixture-child', sessionId }] : [];
    },
  });
  const finishWork = () => { work.active = false; bus.emit(wakeChannel, {}); };
  let terminalHook;
  t.after(async () => {
    finishWork();
    try { await terminalHook; } finally { unregister(); }
  });
  return {
    work, waiting: waiting.promise, abort: () => controller.abort(), finishWork,
    listeners: () => bus.eventNames().length + getEventListeners(controller.signal, 'abort').length,
    end(aborted) {
      terminalHook = Promise.all((hooks.get('agent_end') ?? []).map(handler => handler({ type: 'agent_end', messages: [], aborted }, ctx)));
      return terminalHook;
    },
  };
}

test('an already aborted headless turn does not scan or wait for detached work', { timeout: 5000 }, async t => {
  for (const eventAborted of [true, false]) {
    await t.test(`abort reported by ${eventAborted ? 'event' : 'signal'}`, async t => {
      const run = await fixture(t);
      if (!eventAborted) run.abort();
      const terminal = run.end(eventAborted);
      assert.equal(await Promise.race([terminal.then(() => 'ended'), run.waiting.then(() => 'waiting')]), 'ended');
      assert.equal(run.work.snapshots, 0);
      assert.equal(run.work.active, true);
      assert.equal(run.listeners(), 0);
    });
  }
});

test('abort releases a waiting headless hook without completing or stopping detached work', { timeout: 5000 }, async t => {
  const run = await fixture(t);
  let ended = false;
  const terminal = run.end(false).then(() => { ended = true; });
  await run.waiting;
  assert.ok(run.listeners() > 0);
  run.abort();
  await setImmediate();
  assert.equal(ended, true, 'the hook settles without waiting for the next poll or completion event');
  assert.equal(run.work.active, true);
  assert.equal(run.listeners(), 0);
  await terminal;
});

test('a healthy headless turn still drains outstanding work before settling', { timeout: 5000 }, async t => {
  const run = await fixture(t);
  let ended = false;
  const terminal = run.end(false).then(() => { ended = true; });
  await run.waiting;
  assert.equal(ended, false);
  run.finishWork();
  await terminal;
  assert.equal(ended, true);
  assert.equal(run.listeners(), 0);
});
