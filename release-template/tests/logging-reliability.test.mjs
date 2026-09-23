import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/lib/health-log.ts')));
const url = file => pathToFileURL(path.join(agent, file)).href;
const { createHealthLog, HEALTH_SINK } = await import(url('extensions/lib/health-log.ts'));
const { default: healthExtension } = await import(url('extensions/health-log.ts'));
const telemetry = await import(url('extensions/lib/session-telemetry.ts'));
const { normalizeCheckpointState, verifyResult, editMade } = await import(url('extensions/checkpoints.ts'));
const historyUrl = url('extensions/pi-subagents/src/runs/shared/run-history.ts');
const history = await import(historyUrl);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-log-check-'));
const readHealth = file => gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse);

test('health flush and close drain events recorded during an earlier flush exactly once', async () => {
  const dir = temp();
  try {
    const log = createHealthLog(dir, 'fixture/session');
    log.record('first');
    const first = log.flush();
    log.record('second');
    const second = log.flush();
    log.record('third');
    assert.deepEqual(await Promise.all([first, second, log.close()]), [true, true, true]);
    log.record('after.close');
    assert.equal(await log.flush(), true);
    assert.deepEqual(readHealth(log.file).map(e => e.kind), ['first', 'second', 'third']);
    assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('health logs retain bounded ML evidence without copying model content or arbitrary fields', async () => {
  const dir = temp();
  try {
    const log = createHealthLog(dir, 'fixture');
    log.record('ml.evidence.route', { shape: 'prose', smol: true, kompress: true, needle: false, jev: false,
      reasons: ['smol:eligible', 'kompress:prose-shaped', 'PRIVATE PAYLOAD'], raw: 'PRIVATE PAYLOAD' });
    log.record('ml.needle.call', { op: 'rank', cached: true, shadow: false, durationMs: 4, count: 1 });
    log.record('ml.evidence.delivered', { helper: 'smol', savedChars: 4096, count: 1 });
    log.record('ml.smol.offer', { decision: 'ineligible', reason: 'protected-content' });
    await log.close();
    const events = readHealth(log.file);
    assert.deepEqual(events[0].reasons, ['smol:eligible', 'kompress:prose-shaped']);
    assert.equal(events[0].shape, 'prose'); assert.equal(events[0].smol, true); assert.equal(events[0].needle, false);
    assert.equal(events[1].cached, true); assert.equal(events[1].op, 'rank');
    assert.equal(events[2].savedChars, 4096); assert.equal(events[3].reason, 'protected-content');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE PAYLOAD/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('health write failures retain the batch until storage recovers', async () => {
  const dir = temp(), blocked = path.join(dir, 'blocked');
  try {
    fs.writeFileSync(blocked, 'fixture blocker');
    const log = createHealthLog(blocked, 'fixture');
    log.record('first'); log.record('second');
    assert.equal(await log.flush(), false);
    assert.equal(log.pending, 2);
    assert.equal(log.failures, 1);
    fs.unlinkSync(blocked);
    assert.equal(await log.close(), true);
    assert.deepEqual(readHealth(log.file).map(e => e.kind), ['first', 'second']);
    assert.equal(log.pending, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a partial gzip append is rolled back before retry so older health events stay readable', async () => {
  const dir = temp();
  const log = createHealthLog(dir, 'fixture');
  let prototype, original;
  try {
    log.record('first'); await log.flush();
    const handle = await open(log.file, 'a');
    prototype = Object.getPrototypeOf(handle); original = prototype.writeFile; await handle.close();
    prototype.writeFile = async function (data) { await original.call(this, data.subarray(0, 7)); throw Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' }); };
    log.record('second');
    assert.equal(await log.flush(), false);
    assert.deepEqual(readHealth(log.file).map(e => e.kind), ['first']);
    prototype.writeFile = original;
    assert.equal(await log.close(), true);
    assert.deepEqual(readHealth(log.file).map(e => e.kind), ['first', 'second']);
  } finally {
    if (prototype && original) prototype.writeFile = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health queue overflow reports the exact loss even without another record', async () => {
  const dir = temp();
  try {
    const log = createHealthLog(dir, 'fixture');
    for (let i = 0; i < 5000; i++) log.record('tool.call', { tool: 't'.repeat(120), password: 'MUST_NOT_PERSIST' });
    const dropped = log.dropped;
    assert.ok(dropped > 0);
    await log.close();
    const entries = readHealth(log.file);
    assert.equal(entries.at(-1).kind, 'log.loss');
    assert.equal(entries.at(-1).dropped, dropped);
    assert.equal(entries.length - 1 + dropped, 5000);
    assert.ok(!JSON.stringify(entries).includes('MUST_NOT_PERSIST'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function telemetryFixture(append = () => {}) {
  const hooks = new Map();
  const state = telemetry.registerSessionTelemetry({ on: (name, fn) => hooks.set(name, fn), registerCommand() {}, appendEntry: append });
  return { ...state, hooks, start: id => hooks.get('session_start')({}, { sessionManager: { getSessionId: () => id } }) };
}

test('old telemetry sinks stop counting and shutdown only releases its own globals', () => {
  const one = telemetryFixture();
  one.start('one');
  const oldSink = globalThis[telemetry.METRICS_SINK];
  one.hooks.get('session_switch')({}, { sessionManager: { getSessionId: () => 'two' } });
  const ledger = globalThis[telemetry.HOOK_LEDGER_VIEW];
  const records = ledger().records;
  oldSink('hook', { owner: 'fixture', hook: 'input', eventId: 'old' });
  assert.equal(ledger().records, records);
  const two = telemetryFixture(); two.start('three');
  const next = globalThis[telemetry.METRICS_SINK];
  one.hooks.get('session_shutdown')();
  assert.equal(globalThis[telemetry.METRICS_SINK], next);
  two.hooks.get('session_shutdown')();
  for (const key of [telemetry.METRICS_SINK, telemetry.METRICS_VIEW, telemetry.HOOK_LEDGER_VIEW]) assert.equal(globalThis[key], undefined);
});

test('telemetry cleanup still runs when its final session append fails', () => {
  const fixture = telemetryFixture(() => { throw new Error('fixture write failed'); });
  fixture.start('failure'); globalThis[telemetry.METRICS_SINK]('recoveries');
  assert.throws(() => fixture.hooks.get('session_shutdown')(), /fixture write failed/);
  assert.equal(globalThis[telemetry.METRICS_SINK], undefined);
  assert.equal(fixture.snapshot(), undefined);
});

test('corrupt checkpoint state cannot override session identity or poison counters', () => {
  const state = normalizeCheckpointState({ sid: 'wrong', verifyStrikes: '1', verifyCheckpoints: -1, editsSinceCommand: 7,
    editCheckpointShown: 'false', pendingReadbackPaths: [null, 4, '', '/fixture/file'] }, 'correct');
  assert.equal(state.sid, 'correct');
  assert.equal(state.verifyCheckpoints, 0);
  assert.deepEqual(state.pendingReadbackPaths, ['/fixture/file']);
  assert.equal(verifyResult(state, true), null);
  assert.equal(verifyResult(state, true), 'verify');
  assert.equal(editMade(state), 'unverified');
});

async function withHistory(fn) {
  const dir = temp(), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return await fn(dir, path.join(dir, 'run-history.jsonl')); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const legacy = (agent, ts = 1) => ({ agent, task: 'fixture private task', ts, status: 'ok', duration: 1 });

test('health extension honors the configured agent directory and reports final write failure', async () => withHistory(async dir => {
  const hooks = new Map(), notices = [];
  healthExtension({ on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); }, registerCommand() {}, appendEntry() {}, sendMessage() {} });
  const context = { sessionManager: { getSessionId: () => 'fixture' }, ui: { notify: message => notices.push(message) } };
  const fire = async name => { for (const handler of hooks.get(name) ?? []) await handler({}, context); };
  await fire('session_start');
  globalThis[HEALTH_SINK]('hook.error', { owner: 'fixture.ts', hook: 'command', isError: true, error: 'MUST_NOT_PERSIST' });
  await fire('session_shutdown');
  const directory = path.join(dir, 'logs/health');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const error = readHealth(path.join(directory, files[0])).find(e => e.kind === 'hook.error');
  assert.equal(error.owner, 'fixture.ts');
  assert.equal(error.error, undefined);
  assert.equal(notices.length, 0);
  await fire('session_start');
  fs.rmSync(directory, { recursive: true }); fs.writeFileSync(directory, 'fixture blocker');
  await fire('session_shutdown');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /could not be saved/);
  assert.equal(globalThis[HEALTH_SINK], undefined);
}));

test('run history repairs missing newlines and malformed tails before appending', async () => withHistory((_dir, file) => {
  fs.writeFileSync(file, JSON.stringify(legacy('fixture')));
  history.recordRun('fixture', 'second synthetic task', 0, 12);
  assert.equal(history.loadRunsForAgent('fixture').length, 2);
  fs.appendFileSync(file, '{"broken":');
  history.recordRun('fixture', 'third synthetic task', 0, 12, { interrupted: true });
  const runs = history.loadRunsForAgent('fixture');
  assert.equal(runs.length, 3);
  assert.equal(runs[0].outcome, 'interrupted');
  assert.equal(runs[0].status, 'error');
  assert.ok(runs.every(run => run.task === '[redacted]'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private task'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}));

test('run history rotates on writes and concurrent readers cannot erase child results', async () => withHistory(async (dir, file) => {
  fs.writeFileSync(file, Array.from({ length: 1199 }, (_, i) => JSON.stringify(legacy('old', i))).join('\n') + '\n');
  const script = `import {recordRun,loadRunsForAgent} from ${JSON.stringify(historyUrl)};
    for(let i=0;i<25;i++){recordRun('worker-'+process.argv[1], 'fixture-'+i, 0, i);loadRunsForAgent('old');}`;
  await Promise.all([0, 1, 2].map(n => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(n)], { env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_CHILD: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  for (let i = 0; i < 3; i++) assert.equal(history.loadRunsForAgent('worker-' + i).length, 25);
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').length <= 1200);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
}));
