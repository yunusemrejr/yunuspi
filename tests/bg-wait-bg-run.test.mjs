import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.dirname);
const { registerBackgroundWorkProvider, snapshotBackgroundWork } = await jiti.import('../agent/extensions/pi-subagents/src/api/background-work.ts');
const { waitForSubagents } = await jiti.import('../agent/extensions/pi-subagents/src/runs/background/subagent-wait.ts');
const { default: registerBackground } = await jiti.import('../agent/extensions/pi-background-tasks/src/extension.ts');

const SESSION = 'session-a';
const text = out => out.content.map(item => item.text ?? '').join('\n');

/** A fake provider whose items are the array the test mutates; the fake clock advances one second per poll. */
function fixture(t, items, onPoll = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-bg-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unregister = registerBackgroundWorkProvider({ name: 'fixture-bg', listActiveWork: ({ sessionId }) => items.filter(item => item.sessionId === sessionId) });
  t.after(unregister);
  let clock = 0, polls = 0;
  const deps = {
    state: { currentSessionId: SESSION },
    asyncDirRoot: dir,
    resultsDir: path.join(dir, 'results'),
    now: () => clock,
    pollIntervalMs: 1000,
    sleep: async () => { polls++; clock += 1000; onPoll(polls); },
  };
  return { deps, polls: () => polls };
}

test('bare bg_wait waits on a registered bg work item of this session until it finishes', async t => {
  const items = [{ id: 'be228f4da', sessionId: SESSION }];
  const f = fixture(t, items, count => { if (count === 2) items.length = 0; });
  const out = await waitForSubagents({ timeoutMs: 10_000 }, undefined, f.deps);
  assert.notEqual(out.isError, true, text(out));
  assert.match(text(out), /1 of 1 item\(s\) finished/);
  assert.equal(f.polls(), 2);
});

for (const id of ['be228f4da', 'be22']) {
  test(`bg_wait({ id: "${id}" }) waits only for that item, not the other one in this session`, async t => {
    const items = [{ id: 'be228f4da', sessionId: SESSION }, { id: 'c0ffee123', sessionId: SESSION }];
    const f = fixture(t, items, count => { if (count === 2) items.splice(0, 1); });
    const out = await waitForSubagents({ id, timeoutMs: 10_000 }, undefined, f.deps);
    assert.notEqual(out.isError, true, text(out));
    assert.match(text(out), /^Waited /, 'the named item finishing ends the wait instead of the window');
    assert.doesNotMatch(text(out), /window elapsed/i);
    assert.equal(f.polls(), 2);
  });
}

test('bg_wait with an unknown id still reports that nothing matched', async t => {
  const f = fixture(t, [{ id: 'be228f4da', sessionId: SESSION }]);
  const out = await waitForSubagents({ id: 'zzz' }, undefined, f.deps);
  assert.match(text(out), /^No active run matched "zzz"\. Nothing to wait for\./);
  assert.equal(f.polls(), 0);
});

test('bg work owned by another session is never waited on', async t => {
  const f = fixture(t, [{ id: 'be228f4da', sessionId: 'session-b' }]);
  assert.match(text(await waitForSubagents({}, undefined, f.deps)), /No active async runs or registered provider work in this session/);
  assert.match(text(await waitForSubagents({ id: 'be228f4da' }, undefined, f.deps)), /No active run matched "be228f4da"/);
  assert.equal(f.polls(), 0);
});

test('an ambiguous bg work prefix and a non-blocking request on bg work both fail without waiting', async t => {
  const f = fixture(t, [{ id: 'be22aa', sessionId: SESSION }, { id: 'be22bb', sessionId: SESSION }]);
  const ambiguous = await waitForSubagents({ id: 'be22' }, undefined, f.deps);
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /Ambiguous background work id prefix "be22" matched 2 provider items/);
  const nonBlocking = await waitForSubagents({ id: 'be22aa', nonBlocking: true }, undefined, f.deps);
  assert.equal(nonBlocking.isError, true);
  assert.match(text(nonBlocking), /support subagent runs only/);
  assert.equal(f.polls(), 0);
});

test('a running bg_run task is listed as bg work in a UI session and bg_wait by its id returns once it finishes; headless runs keep auto-drain unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-bg-wait-run-'));
  const sessionFile = path.join(dir, 'session.jsonl');
  const hooks = new Map(), tools = new Map(), bus = new EventEmitter();
  const ctx = {
    cwd: dir,
    hasUI: true,
    modelRegistry: { getAll: () => [] },
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => 'bg-wait-fixture', getBranch: () => [] },
    isIdle: () => true,
  };
  registerBackground({
    events: { on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name, value) => bus.emit(name, value) },
    on: (name, fn) => { const handlers = hooks.get(name) ?? []; handlers.push(fn); hooks.set(name, handlers); },
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {},
  });
  const lifecycle = async name => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); };
  t.after(async () => {
    await lifecycle('session_shutdown');
    // The public terminal event precedes notification-metadata cleanup; let that finite work drain first.
    process.once('beforeExit', () => fs.rmSync(dir, { recursive: true, force: true }));
  });
  ctx.hasUI = false;
  await lifecycle('session_start');
  const headless = await tools.get('bg_run').execute('bg-wait-headless', { command: 'sleep 1', name: 'build', isAgent: false, notifyOnCompletion: false }, undefined, undefined, ctx);
  assert.deepEqual(snapshotBackgroundWork(sessionFile).items, [], 'a headless session registers no provider, so its auto-drain never waits on bg_run tasks');
  await tools.get('bg_kill').execute('kill-headless', { taskId: headless.details.task.id }, undefined, undefined, ctx).catch(() => {});
  ctx.hasUI = true;
  await lifecycle('session_start');

  const started = await tools.get('bg_run').execute('bg-wait-run', { command: 'sleep 1', name: 'render', isAgent: false, notifyOnCompletion: false }, undefined, undefined, ctx);
  const taskId = started.details.task.id;
  assert.deepEqual(snapshotBackgroundWork(sessionFile).items.map(item => [item.provider, item.id]), [['bg_run', taskId]]);

  const out = await waitForSubagents({ id: taskId, timeoutMs: 30_000 }, undefined, { state: { currentSessionId: sessionFile }, asyncDirRoot: dir, resultsDir: path.join(dir, 'results') });
  assert.notEqual(out.isError, true, text(out));
  assert.match(text(out), /done/);
  assert.deepEqual(snapshotBackgroundWork(sessionFile).items, []);
});
