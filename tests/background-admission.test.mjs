import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createJiti } from 'jiti';
import { EventEmitter, getEventListeners } from 'node:events';
const { BackgroundTaskRegistry, BackgroundAdmissionCapacityError, MAX_ADMISSION_RECORDS } = await createJiti(import.meta.dirname).import('../agent/extensions/pi-background-tasks/src/core/registry.ts');
const { default: registerBackground } = await createJiti(import.meta.dirname).import('../agent/extensions/pi-background-tasks/src/extension.ts');
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-admit-')); let spawns = 0, notifications = 0;
  const registry = new BackgroundTaskRegistry({
    env: { ...process.env, PI_BG_DISABLE_PI_TELEMETRY: '0' },
    spawn: (...args) => { spawns++; return spawn(...args); },
    sendCompletionNotification: () => notifications++,
    ...overrides,
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const ctx = { cwd, sessionId: 'session-a', modelRegistry: { getAll: () => [] } };
  return { registry, ctx, cwd, spawns: () => spawns, notifications: () => notifications };
}
async function terminal(task) {
  if (task.status === 'running') await new Promise(resolve => task.waiters.push(resolve));
  await tick(); await task.metadataWriteChain; await tick();
}

test('concurrent normalized bg admissions and later duplicates execute one actual process', async t => {
  const f = fixture(t), gate = deferred();
  const ensure = f.registry.ensureRuntimeDir.bind(f.registry);
  f.registry.ensureRuntimeDir = async ctx => { const dir = await ensure(ctx); await gate.promise; return dir; };
  const first = f.registry.startTask(f.ctx, "printf 'one\n' >> admitted.txt", { toolCallId: 'call-a', name: 'fixture', notifyOnCompletion: false });
  const duplicate = f.registry.startTask(f.ctx, "  printf 'one\n' >> admitted.txt  ", { toolCallId: 'call-a', name: ' fixture ', notifyOnCompletion: false, isAgent: false });
  await assert.rejects(f.registry.startTask(f.ctx, 'printf conflict', { toolCallId: 'call-a', name: 'fixture', notifyOnCompletion: false }), /conflicting arguments/);
  assert.equal(f.spawns(), 0); gate.resolve();
  const [a, b] = await Promise.all([first, duplicate]); assert.equal(a.id, b.id); assert.equal(f.spawns(), 1);
  await terminal(a);
  const replay = await f.registry.startTask(f.ctx, "printf 'one\n' >> admitted.txt", { toolCallId: 'call-a', name: 'fixture', notifyOnCompletion: false });
  assert.equal(replay.id, a.id); assert.equal(f.spawns(), 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'admitted.txt'), 'utf8'), 'one\n');
  const independent = await f.registry.startTask({ ...f.ctx, sessionId: 'session-b' }, "printf 'one\n' >> admitted.txt", { toolCallId: 'call-a', name: 'fixture', notifyOnCompletion: false });
  await terminal(independent); assert.equal(f.spawns(), 2);
  assert.notEqual(a.metadataAbsPath, independent.metadataAbsPath, 'session identities own their runtime directories');
});

test('abort before admission and during asynchronous directory startup spawns nothing', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred(), controller = new AbortController();
  const already = new AbortController(); already.abort();
  await assert.rejects(f.registry.startTask(f.ctx, 'printf unexpected', { toolCallId: 'already', signal: already.signal }), { name: 'AbortError' });
  const ensure = f.registry.ensureRuntimeDir.bind(f.registry);
  f.registry.ensureRuntimeDir = async ctx => { const dir = await ensure(ctx); entered.resolve(); await gate.promise; return dir; };
  const first = f.registry.startTask(f.ctx, 'printf unexpected', { toolCallId: 'startup', signal: controller.signal });
  const duplicate = f.registry.startTask(f.ctx, 'printf unexpected', { toolCallId: 'startup' });
  await entered.promise; controller.abort(); gate.resolve();
  const outcomes = await Promise.allSettled([first, duplicate]);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
  assert.equal(f.spawns(), 0); assert.equal(f.registry.allTasks().length, 0);
  await assert.rejects(f.registry.startTask(f.ctx, 'printf unexpected', { toolCallId: 'startup' }), /aborted before process start/);
  assert.equal(f.spawns(), 0, 'a repeated ambiguous identity cannot silently retry');
});

test('abort during telemetry wrapper creation retains a failed record without starting a child or inference wake', async t => {
  const f = fixture(t), controller = new AbortController();
  f.ctx.modelRegistry.getAll = () => { controller.abort(); return []; };
  await assert.rejects(f.registry.startTask(f.ctx, 'pi --print fixture', {
    toolCallId: 'wrapped', signal: controller.signal, isAgent: true, notifyOnCompletion: true, triggerOnCompletion: true,
  }), /aborted before process start/);
  const [task] = f.registry.allTasks(); assert.ok(task); await terminal(task);
  assert.equal(f.spawns(), 0); assert.equal(f.notifications(), 0);
  assert.equal(task.status, 'failed'); assert.equal(task.pid, undefined);
  assert.equal(JSON.parse(fs.readFileSync(task.metadataAbsPath, 'utf8')).status, 'failed');
});

test('shutdown during async startup rejects before spawn', async t => {
  const f = fixture(t), ensure = f.registry.ensureRuntimeDir.bind(f.registry);
  f.registry.ensureRuntimeDir = async ctx => { const dir = await ensure(ctx); f.registry.setShuttingDown(true); return dir; };
  await assert.rejects(f.registry.startTask(f.ctx, 'printf unexpected', { toolCallId: 'shutdown' }), /shutting down/);
  assert.equal(f.spawns(), 0);
});

test('bounded admission capacity keeps duplicates usable and pruned tombstones cannot execute again', async t => {
  const f = fixture(t, { maxAdmissionRecords: 2, maxRecentTasks: 1 });
  const options = id => ({ toolCallId: id, notifyOnCompletion: false });
  const a = await f.registry.startTask(f.ctx, 'printf one', options('a')); await terminal(a);
  const b = await f.registry.startTask(f.ctx, 'printf one', options('b')); await terminal(b);
  const snapshot = f.registry.allTasks(); assert.deepEqual(snapshot.map(task => task.id), [b.id]);
  const retained = await f.registry.startTask(f.ctx, 'printf one', options('b')); assert.equal(retained.id, b.id);
  await assert.rejects(f.registry.startTask(f.ctx, 'printf one', options('c')), error => {
    assert.ok(error instanceof BackgroundAdmissionCapacityError);
    assert.equal(error.code, 'BACKGROUND_ADMISSION_CAPACITY'); assert.equal(error.capacity, 2); return true;
  });
  await assert.rejects(f.registry.startTask(f.ctx, 'printf one', options('a')), /already admitted/);
  assert.equal(f.spawns(), 2, 'capacity and UI pruning cannot evict the identity guard');
  assert.equal(fs.existsSync(a.metadataAbsPath), true, 'durable terminal evidence remains available');
  for (const value of [0, -1, 1.5, MAX_ADMISSION_RECORDS + 1]) {
    assert.throws(() => new BackgroundTaskRegistry({ maxAdmissionRecords: value, sendCompletionNotification() {} }), /maxAdmissionRecords/);
  }
});

test('a duplicate waiter can cancel without cancelling the shared startup or retaining its abort listener', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred(), controller = new AbortController();
  const ensure = f.registry.ensureRuntimeDir.bind(f.registry);
  f.registry.ensureRuntimeDir = async ctx => { const dir = await ensure(ctx); entered.resolve(); await gate.promise; return dir; };
  const options = { toolCallId: 'shared', notifyOnCompletion: false };
  const owner = f.registry.startTask(f.ctx, 'printf one', options);
  await entered.promise;
  const cancelledWait = f.registry.startTask(f.ctx, 'printf one', { ...options, signal: controller.signal });
  const survivor = f.registry.startTask(f.ctx, 'printf one', options);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(cancelledWait, error => error.name === 'AbortError' && /original request still owns/.test(error.message));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(f.spawns(), 0);
  gate.resolve();
  const [a, b] = await Promise.all([owner, survivor]); assert.equal(a.id, b.id); await terminal(a);
  assert.equal(f.spawns(), 1);
  await assert.rejects(f.registry.startTask(f.ctx, 'printf one', { ...options, signal: controller.signal }), /original request still owns/);
  assert.equal((await f.registry.startTask(f.ctx, 'printf one', options)).id, a.id);
});

test('all launch-affecting options and publication-gate identity participate in duplicate conflicts', async t => {
  const f = fixture(t), publication = deferred();
  const options = { toolCallId: 'options', name: 'fixture', description: 'description', isAgent: false, timeoutSeconds: 10,
    notifyOnCompletion: false, triggerOnCompletion: false, triggerOnCompletionExplicit: false, terminalPublicationGate: publication.promise };
  const task = await f.registry.startTask(f.ctx, 'printf one', options);
  for (const change of [{ name: 'other' }, { description: 'other' }, { isAgent: true }, { timeoutSeconds: 11 },
    { notifyOnCompletion: true }, { triggerOnCompletion: true }, { triggerOnCompletionExplicit: true },
    { terminalPublicationGate: undefined }, { terminalPublicationGate: Promise.resolve() }]) {
    await assert.rejects(f.registry.startTask(f.ctx, 'printf one', { ...options, ...change }), /conflicting arguments/);
  }
  assert.equal((await f.registry.startTask(f.ctx, 'printf one', { ...options, name: ' fixture ', description: ' description ' })).id, task.id);
  publication.resolve(); await terminal(task); assert.equal(f.spawns(), 1);
  for (const toolCallId of ['', 'x'.repeat(513)]) await assert.rejects(f.registry.startTask(f.ctx, 'printf one', { toolCallId }), /1\.\.512/);
});

test('registered bg_run passes actual tool identity, abort signal and session owner to admission', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-bg-tool-'));
  const bus = new EventEmitter(), hooks = new Map(), tools = new Map();
  const ctx = { cwd, hasUI: false, modelRegistry: { getAll: () => [] }, sessionManager: { getSessionId: () => 'actual-context-session', getBranch: () => [] }, isIdle: () => true };
  registerBackground({
    events: { on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name, value) => bus.emit(name, value) },
    on: (name, fn) => { const handlers = hooks.get(name) ?? []; handlers.push(fn); hooks.set(name, handlers); },
    registerTool: tool => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {},
  });
  t.after(async () => {
    for (const shutdown of hooks.get('session_shutdown') ?? []) await shutdown({}, ctx);
    // The public terminal event precedes notification-metadata cleanup. Let
    // finite filesystem work drain rather than deleting under its writer.
    process.once('beforeExit', () => fs.rmSync(cwd, { recursive: true, force: true }));
  });
  const run = tools.get('bg_run');
  const params = { command: "printf 'one\n' >> from-tool.txt", name: 'fixture', isAgent: false, notifyOnCompletion: false };
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(run.execute('cancelled', params, cancelled.signal, undefined, ctx), { name: 'AbortError' });
  const [first, second] = await Promise.all([run.execute('same', params, undefined, undefined, ctx), run.execute('same', params, undefined, undefined, ctx)]);
  assert.equal(first.details.task.id, second.details.task.id);
  await assert.rejects(run.execute('same', { ...params, command: 'printf conflict' }, undefined, undefined, ctx), /conflicting arguments/);
  const taskId = first.details.task.id;
  for (let i = 0; i < 300; i++) {
    const status = await tools.get('bg_status').execute('status', { taskId });
    if (status.details.tasks[0].status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'from-tool.txt'), 'utf8'), 'one\n');
  assert.match(first.details.task.outputPath, /actual-context-session/);
});
