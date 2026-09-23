import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createJiti } from 'jiti';
const repo = path.resolve(import.meta.dirname, '..');
const agent = [path.join(repo, 'agent'), path.resolve(repo, '..')].find(dir => fs.existsSync(path.join(dir, 'scripts/sandbox-runner.py')));
const jiti = createJiti(import.meta.dirname);
const { default: registerSandbox } = await jiti.import(path.join(agent, 'extensions/sandbox.ts'));
const { default: registerBackground } = await jiti.import(path.join(agent, 'extensions/pi-background-tasks/src/extension.ts'));
const api = await jiti.import(path.join(agent, 'extensions/pi-background-tasks/src/core/extension-api.ts'));
const helper = path.join(agent, 'scripts/sandbox-runner.py');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, background = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-bg-'quoted-"));
  const bus = new EventEmitter(), hooks = new Map(), tools = new Map(), notifications = [];
  const ctx = { cwd, hasUI: false, modelRegistry: { getAll: () => [] }, sessionManager: { getSessionId: () => 'sandbox-fixture', getBranch: () => [] }, isIdle: () => true };
  const pi = { events: { on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name, value) => bus.emit(name, value) },
    on: (name, fn) => { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); },
    registerTool: spec => tools.set(spec.name, spec), registerMessageRenderer() {}, registerCommand() {}, registerShortcut() {},
    sendMessage(message, options) { notifications.push(message); options?.onAccepted?.(); },
  };
  if (background) registerBackground(pi);
  registerSandbox(pi);
  const lifecycle = async name => { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); };
  t.after(async () => { await lifecycle('session_shutdown'); await tick(); process.once('beforeExit', () => fs.rmSync(cwd, { recursive: true, force: true })); });
  return { cwd, ctx, pi, bus, tools, hooks, notifications, lifecycle,
    run: (id, params, signal) => tools.get('sandbox_run').execute(id, params, signal, undefined, ctx) };
}
async function status(f, id) { return (await f.tools.get('bg_status').execute('fixture-status', { taskId: id })).details.tasks[0]; }
async function done(f, id) {
  for (let count = 0; count < 500; count++) {
    const result = await status(f, id);
    if (result.status !== 'running') { await tick(); return result; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Fixture background task failed to settle');
}
async function logs(f, id) { return (await f.tools.get('bg_logs').execute('fixture-logs', { taskId: id, maxBytes: 65536, tail: false })).content.map(item => item.text ?? '').join('\n'); }
let capable;
async function requireIsolation(t, f) {
  if (capable === undefined) {
    const response = await f.run('isolation-probe', { command: 'true' });
    capable = !response.isError && response.details.started;
    if (!capable) assert.match(response.content[0].text, /sandbox|requires/i);
  }
  if (!capable) {
    if (process.env.PI_SANDBOX_REQUIRE === '1') assert.fail('OS sandbox must be available on this host');
    t.skip('Kernel/systemd isolation unavailable; fail-closed foreground verified');
  }
  return capable;
}

test('background sandbox uses actual bg registry, launch-time snapshot, finite completion and bounded logs', async t => {
  const f = fixture(t); await f.lifecycle('session_start'); if (!await requireIsolation(t, f)) return;
  fs.writeFileSync(path.join(f.cwd, 'source'), 'copied snapshot');
  const params = { background: true, name: 'Snapshot experiment', command: "cat input; printf ' done'; test -d /home/sandbox; printf changed > input", files: [{ path: 'input', source: 'source' }] };
  const [result, same] = await Promise.all([f.run('success', params), f.run('success', params)]);
  assert.deepEqual(result, same, 'concurrent same-ID calls share one admission receipt');
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.background, true);
  const id = result.details.taskId, terminal = await done(f, id);
  assert.equal(terminal.status, 'completed'); assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.isAgent, false); assert.equal(terminal.notifyOnCompletion, true); assert.equal(terminal.triggerOnCompletion, true);
  assert.match(await logs(f, id), /copied snapshot done/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'source'), 'utf8'), 'copied snapshot');
  const replay = await f.run('success', { background: true, command: 'touch should-not-run' });
  assert.equal(replay.isError, true); assert.equal(replay.details.started, null); assert.match(replay.details.error, /conflicting arguments/);
  const tasks = (await f.tools.get('bg_status').execute('all', {})).details.tasks;
  assert.equal(tasks.length, 1, 'same tool identity never starts another experiment');
});

test('sandbox background exit codes preserve command failure, timeout and prelaunch refusal', async t => {
  const f = fixture(t); await f.lifecycle('session_start'); if (!await requireIsolation(t, f)) return;
  for (const [id, args, expected] of [
    ['failure', { command: 'printf failure; exit 7' }, 7],
    ['timeout', { command: 'sleep 20', timeoutMs: 1000 }, 124],
    ['refusal', { command: 'true', files: [{ path: '../escape', content: 'never' }] }, 1],
  ]) {
    const result = await f.run(id, { background: true, ...args }); assert.equal(result.isError, false, JSON.stringify(result));
    const terminal = await done(f, result.details.taskId);
    assert.equal(terminal.status, 'failed'); assert.equal(terminal.exitCode, expected);
    const text = await logs(f, result.details.taskId); assert.match(text, id === 'timeout' ? /"timedOut": true/ : id === 'refusal' ? /"started": false/ : /"exitCode": 7/);
  }
});

test('bg_kill stops a real isolated experiment and its detached descendants', async t => {
  const f = fixture(t); await f.lifecycle('session_start'); if (!await requireIsolation(t, f)) return;
  const result = await f.run('kill', { background: true, command: "setsid /bin/bash -c 'sleep 30' & wait" });
  assert.equal(result.isError, false); const id = result.details.taskId;
  // Locate only this job's systemd unit through its owned process tree, then
  // observe removal of that specific cgroup after the public bg kill.
  let unit;
  const ownedPid = (await status(f, id)).pid;
  const deadline = Date.now() + 3000;
  function findUnit(pid, seen = new Set()) {
    if (seen.has(pid)) return;
    seen.add(pid);
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      const unit = args.find(arg => arg.startsWith('--unit=pi-sandbox-'))?.slice(7);
      if (unit) return unit;
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      for (const child of children) { const found = findUnit(child, seen); if (found) return found; }
    } catch { /* Process exited while inspecting its owned children. */ }
  }
  while (!unit && Date.now() < deadline) { unit = findUnit(ownedPid); if (!unit) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(unit, 'this job launched a real isolated systemd service');
  const killed = await f.tools.get('bg_kill').execute('fixture-kill', { taskId: id });
  assert.equal(killed.isError, undefined); assert.equal((await done(f, id)).status, 'killed');
  let units = '';
  const cleanupDeadline = Date.now() + 5000;
  do {
    units = execFileSync('/usr/bin/systemctl', ['--user', 'list-units', unit, '--all', '--no-legend', '--plain'], { encoding: 'utf8' });
    if (!units.trim()) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < cleanupDeadline);
  assert.equal(units.trim(), '', 'the exact cgroup and all detached descendants were removed');
  assert.equal((await f.run('next', { command: 'true' })).isError, false, 'OS sandbox slot released');
});

test('background request bounds and pre-abort fail before dispatch; session switches cannot rebind admission', async t => {
  const f = fixture(t, false); let runs = 0;
  f.bus.on(api.BG_REQUEST_CHANNEL, request => {
    if (request.operation === 'run') runs++;
    if (request.operation === 'capabilities') {
      for (const handler of f.hooks.get('session_switch') ?? []) handler({}, f.ctx);
      f.bus.emit(api.BG_RESPONSE_CHANNEL, { schema_version: api.BG_RESPONSE_SCHEMA, request_id: request.request_id, operation: 'capabilities', ok: true, result: api.BG_EXTENSION_CAPABILITIES });
    }
  });
  const large = await f.run('large', { background: true, command: 'true', files: [{ path: 'large', content: 'x'.repeat(49152) }] });
  assert.equal(large.details.started, false); assert.match(large.details.error, /48 KiB/);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.run('cancelled', { background: true, command: 'true' }, controller.signal)).details.started, false);
  const switched = await f.run('switch', { background: true, command: 'true' });
  assert.equal(switched.details.started, false); assert.match(switched.details.error, /Session changed/); assert.equal(runs, 0);
  assert.equal(f.bus.listenerCount(api.BG_RESPONSE_CHANNEL), 0);
});

test('aborted late admissions are acknowledged once then killed through the same bg API', async t => {
  const f = fixture(t, false), controller = new AbortController(); let request, kill;
  f.bus.on(api.BG_REQUEST_CHANNEL, value => {
    const response = { schema_version: api.BG_RESPONSE_SCHEMA, request_id: value.request_id, operation: value.operation, ok: true };
    if (value.operation === 'capabilities') f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...response, result: api.BG_EXTENSION_CAPABILITIES });
    if (value.operation === 'run') { request = value; controller.abort(); }
    if (value.operation === 'kill') { kill = value.payload.taskId; f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...response, result: {} }); }
  });
  const response = await f.run('abort-late', { background: true, command: 'true' }, controller.signal);
  assert.equal(response.isError, true); assert.equal(response.details.started, null);
  assert.equal(f.bus.listenerCount(api.BG_RESPONSE_CHANNEL), 1);
  f.bus.emit(api.BG_RESPONSE_CHANNEL, { schema_version: api.BG_RESPONSE_SCHEMA, request_id: request.request_id, operation: 'run', ok: true, result: { id: 'late-owned-task' } });
  await tick(); assert.equal(kill, 'late-owned-task'); assert.equal(f.bus.listenerCount(api.BG_RESPONSE_CHANNEL), 0);
});

test('missing background service fails closed without host shell fallback', { timeout: 10000 }, async t => {
  const f = fixture(t, false);
  const response = await f.run('missing', { background: true, command: `touch '${path.join(f.cwd, 'must-not-exist')}'` });
  assert.equal(response.isError, true); assert.equal(response.details.started, false); assert.match(response.details.error, /unavailable/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'must-not-exist')), false);
});

test('encoded helper mode rejects expired admission and maps terminal statuses independently of transport', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-background-mode-'));
  try {
    const encoded = Buffer.from(JSON.stringify({ command: 'touch never' })).toString('base64');
    const child = spawn('/usr/bin/python3', ['-I', helper, '--background', cwd, process.execPath, encoded, String(Date.now() - 1000)]);
    return new Promise((resolve, reject) => {
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.on('error', reject);
      child.on('close', code => {
        try { assert.equal(code, 1); assert.match(output, /expired/); assert.equal(fs.existsSync(path.join(cwd, 'never')), false); resolve(); }
        catch (error) { reject(error); }
        finally { fs.rmSync(cwd, { recursive: true, force: true }); }
      });
    });
  } catch (error) { fs.rmSync(cwd, { recursive: true, force: true }); throw error; }
});


test('duplicate observer cancellation leaves original admission owned, and session transitions reset bounded receipts', async t => {
  const f = fixture(t, false), observer = new AbortController(); let pending, announce, kills = 0;
  const arrived = new Promise(resolve => { announce = resolve; });
  const seen = new Set();
  f.bus.on(api.BG_REQUEST_CHANNEL, request => {
    const response = { schema_version: api.BG_RESPONSE_SCHEMA, request_id: request.request_id, operation: request.operation, ok: true };
    if (request.operation === 'capabilities') f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...response, result: api.BG_EXTENSION_CAPABILITIES });
    if (request.operation === 'kill') kills++;
    if (request.operation === 'run') {
      if (seen.has(request.request_id)) f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...response, ok: false, error: 'duplicate request_id' });
      else { seen.add(request.request_id); pending = response; announce(); }
    }
  });
  const params = { background: true, command: 'true' };
  const original = f.run('same-observer', params);
  await arrived;
  const duplicate = f.run('same-observer', params, observer.signal);
  observer.abort();
  const cancelled = await duplicate; assert.equal(cancelled.isError, true); assert.match(cancelled.details.error, /original request still owns/);
  f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...pending, result: { id: 'owned-original', status: 'running', outputPath: 'owned.output' } });
  assert.equal((await original).isError, false); assert.equal(kills, 0);
  const firstId = pending.request_id;
  await f.lifecycle('session_switch');
  const replay = await f.run('same-observer', params);
  assert.equal(replay.isError, true); assert.equal(replay.details.started, null); assert.match(replay.details.error, /already dispatched/);
  assert.equal(seen.size, 1, 'same persisted session/tool identity cannot relaunch after a switch');
  f.ctx.sessionManager.getSessionId = () => 'new-session';
  await f.lifecycle('session_start');
  const second = f.run('same-observer', params);
  await tick(); assert.notEqual(pending.request_id, firstId, 'a new session owns a different admission identity');
  f.bus.emit(api.BG_RESPONSE_CHANNEL, { ...pending, result: { id: 'new-owner', status: 'running', outputPath: 'new.output' } });
  assert.equal((await second).details.taskId, 'new-owner');
});

test('128 retained admission receipts bound memory and a new session genuinely frees capacity', async t => {
  const f = fixture(t, false); let count = 0;
  f.bus.on(api.BG_REQUEST_CHANNEL, request => {
    const result = request.operation === 'capabilities' ? api.BG_EXTENSION_CAPABILITIES : { id: `fixture-${++count}`, status: 'running', outputPath: 'fixture.output' };
    f.bus.emit(api.BG_RESPONSE_CHANNEL, { schema_version: api.BG_RESPONSE_SCHEMA, request_id: request.request_id, operation: request.operation, ok: true, result });
  });
  for (let i = 0; i < 128; i++) assert.equal((await f.run(`call-${i}`, { background: true, command: 'true' })).isError, false);
  assert.match((await f.run('full', { background: true, command: 'true' })).details.error, /capacity/);
  await f.lifecycle('session_start');
  assert.equal((await f.run('new-session', { background: true, command: 'true' })).isError, false);
});
