// Session-owned process lifetime: the crash reaper stops only the process
// groups a dead owner recorded, and the local-model guard stops the shared
// server only once no live YunusPi process holds an owner record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/process-owner.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const owner = await load('extensions/lib/process-owner.ts');
const L = await load('extensions/lib/local-lm.ts');
const linux = process.platform === 'linux';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 50)); } return true; };
const group = () => { const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); child.unref(); return child.pid; };
const exited = child => new Promise(resolve => child.once('exit', code => resolve(code)));

test('the reaper stops recorded groups after the owner dies and spares unlisted or recycled ones', { skip: !linux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-reap-'));
  const ownerProc = spawn('sleep', ['60'], { stdio: 'ignore' });
  const listed = group(), stale = group(), unlisted = group();
  try {
    const record = path.join(dir, String(ownerProc.pid));
    fs.writeFileSync(record, `${owner.processIdentity(ownerProc.pid)}\n${listed} ${owner.processIdentity(listed)}\n${stale} 1\nnot-a-pid 3\n`);
    const reaper = spawn('/bin/bash', [owner.OWNER_SCRIPT, 'reap', record, String(ownerProc.pid), owner.processIdentity(ownerProc.pid)], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 300));
    assert.ok(alive(listed), 'nothing is stopped while the owner lives');
    ownerProc.kill('SIGKILL');
    assert.equal(await exited(reaper), 0);
    assert.equal(alive(listed), false, 'the recorded group dies with its owner');
    assert.ok(alive(stale), 'an identity mismatch (recycled pid) is never signalled');
    assert.ok(alive(unlisted), 'an unrecorded group is untouched');
    assert.equal(fs.existsSync(record), false);
  } finally {
    ownerProc.kill('SIGKILL');
    for (const pid of [listed, stale, unlisted]) try { process.kill(-pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard keeps the service while any live owner holds a record and stops it after the grace', { skip: !linux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-guard-'));
  const env = { ...process.env, PI_OWNER_GUARD_TICK: '1' };
  const holder = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dir, String(holder.pid)), `${owner.processIdentity(holder.pid)}\n`);
    fs.writeFileSync(path.join(dir, '999999999'), '1\n');
    const guard = spawn('/bin/bash', [owner.OWNER_SCRIPT, 'guard', dir, '2', 'sleep', '60'], { env, stdio: 'ignore' });
    const code = exited(guard);
    await new Promise(r => setTimeout(r, 3500));
    assert.equal(guard.exitCode, null, 'another session\'s live lease keeps the shared service');
    holder.kill('SIGKILL');
    assert.equal(await code, 0, 'a clean idle stop exits 0 so systemd leaves it down');
    const crash = spawn('/bin/bash', [owner.OWNER_SCRIPT, 'guard', dir, '60', 'sh', '-c', 'exit 3'], { env, stdio: 'ignore' });
    assert.equal(await exited(crash), 3, 'a crash still reaches Restart=on-failure');
  } finally {
    holder.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only a direct child leading its own group is recorded for killing', { skip: !linux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-own-'));
  const prior = process.env.PI_OWNER_DIR;
  process.env.PI_OWNER_DIR = dir;
  owner.resetOwnerRecordForTests();
  const child = group(), sameGroup = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    owner.ownProcessGroup(1);
    owner.ownProcessGroup(sameGroup.pid);
    owner.ownProcessGroup(999999999);
    owner.ownProcessGroup(child);
    const lines = fs.readFileSync(path.join(dir, String(process.pid)), 'utf8').trim().split('\n');
    assert.deepEqual(lines.slice(1).map(l => Number(l.split(' ')[0])), [child]);
  } finally {
    try { process.kill(-child, 'SIGKILL'); } catch {}
    sameGroup.kill('SIGKILL');
    // Removing the record lets this test's own reaper exit without touching anything.
    fs.rmSync(dir, { recursive: true, force: true });
    owner.resetOwnerRecordForTests();
    if (prior === undefined) delete process.env.PI_OWNER_DIR; else process.env.PI_OWNER_DIR = prior;
  }
});

test('a refused connection while the local model warms up is unavailable, not a breaker failure', async () => {
  const runtime = { version: 2, enabled: true, model: 'Qwen3.5-0.8B', endpoint: 'http://127.0.0.1:18735/completion', apiKey: 'TEST_LOCAL_KEY_1234567890', execution: 'background', timeoutMs: 2000 };
  let ensured = 0, warming = true;
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const lm = L.createLocalLm({ runtime, fetch: refused, services: { ensure: () => ensured++, warming: () => warming } });
  for (let i = 0; i < 5; i++) assert.equal((await lm.judge('q', 'x')).reason, 'unavailable');
  assert.ok(ensured >= 5, 'each refusal asks for the service (throttled by the owner module)');
  warming = false;
  for (let i = 0; i < 3; i++) assert.equal((await lm.judge('q', 'x')).reason, 'failed');
  assert.equal((await lm.judge('q', 'x')).reason, 'paused', 'a server that stays down still opens the breaker');
});
