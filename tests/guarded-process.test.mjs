import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { runGuarded } from '../agent/extensions/lib/guarded-process.ts';
import { processIdentity } from '../agent/extensions/lib/process-owner.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-process-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const run = (code, options = {}) => runGuarded(process.execPath, ['-e', code], { cwd: scratch, guard: false, timeoutMs: 10_000, memoryMb: 12_000, ...options });
async function assertOrphanStopped(pid) {
  const deadline = Date.now() + 500;
  let state;
  do {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      // Exit can expose X (dead) before Z (zombie), or disappear once reaped.
      if (state === 'X' || state === 'Z') return;
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`Owned orphan ${pid} remained live in state ${state} after output closed`);
}

async function waitForFixture(read) {
  const deadline = Date.now() + 3_000;
  do {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail('Owned process fixture did not reach its ready boundary');
}

async function deadlineAfterLeaderExit(t, { descriptor = 1, miss = 'none' } = {}) {
  const id = `${descriptor}-${miss}`;
  const readyPath = path.join(scratch, `${id}.pid`);
  const releasePath = path.join(scratch, `${id}.release`);
  const stdout = descriptor === 1 ? "process.stdout,process.stderr" : "'ignore','ignore',process.stdout";
  const code = `
    const fs=require('node:fs'), {spawn}=require('node:child_process');
    const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',${stdout}]});
    grand.unref();
    const ready=${JSON.stringify(readyPath)}, release=${JSON.stringify(releasePath)};
    fs.writeFileSync(ready+'.tmp',JSON.stringify({leader:process.pid,writer:grand.pid}));
    fs.renameSync(ready+'.tmp',ready);
    const timer=setInterval(()=>{if(fs.existsSync(release))clearInterval(timer)},10);
  `;
  let fireDeadline;
  const realSetTimeout = globalThis.setTimeout;
  const timers = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 137 || fireDeadline) return realSetTimeout(callback, ms, ...args);
    const handle = realSetTimeout(() => {}, 10_000);
    fireDeadline = () => { clearTimeout(handle); callback(...args); };
    return handle;
  });
  const pending = run(code, { timeoutMs: 137 });
  void pending.catch(() => {});
  timers.mock.restore();
  let writer, writerIdentity, watchdog, fired = false, missed = 0;
  let fdReads;
  try {
    assert.ok(fireDeadline);
    const ready = await waitForFixture(() => fs.existsSync(readyPath) && JSON.parse(fs.readFileSync(readyPath, 'utf8')));
    writer = ready.writer;
    writerIdentity = processIdentity(writer);
    assert.ok(writerIdentity);
    fs.writeFileSync(releasePath, '');
    await waitForFixture(() => {
      try { process.kill(ready.leader, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
    if (miss !== 'none') {
      const readdir = fs.readdirSync;
      fdReads = t.mock.method(fs, 'readdirSync', (target, ...args) => {
        if (target === `/proc/${writer}/fd` && (miss === 'all' || missed === 0)) { missed++; return []; }
        return readdir(target, ...args);
      });
      syncBuiltinESMExports();
    }
    fireDeadline();
    fired = true;
    const bound = new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('guarded deadline did not settle')), 2_500); });
    if (miss === 'all') {
      await assert.rejects(Promise.race([pending, bound]), { message: 'node exceeded 0s. Could not confirm that inherited output writers exited.' });
      assert.equal(processIdentity(writer), writerIdentity, 'no unverified PID was signaled');
      assert.ok(missed >= 2);
    } else {
      await assert.rejects(Promise.race([pending, bound]), { message: 'node exceeded 0s' });
      await assertOrphanStopped(writer);
      if (miss === 'first') assert.equal(missed, 1);
    }
  } finally {
    clearTimeout(watchdog);
    if (fdReads) { fdReads.mock.restore(); syncBuiltinESMExports(); }
    if (!fired) { fs.writeFileSync(releasePath, ''); fireDeadline?.(); }
    if (writerIdentity && processIdentity(writer) === writerIdentity) {
      try { process.kill(writer, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

test('guarded children decode UTF-8 independently across stdout and stderr chunks', async () => {
  const lines = [];
  const result = await run("const b=Buffer.from('🙂ç');process.stdout.write(b.subarray(0,2));process.stderr.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write(b.subarray(1));},40)", { onLine: line => lines.push(line) });
  assert.deepEqual(result, { stdout: '🙂ç', stderr: '🙂ç' });
  assert.deepEqual(lines, ['🙂ç']);
});

test('guarded stdout bounds an unterminated line and resumes normal lines after it', async () => {
  const lines = [];
  const result = await run("process.stdout.write('a'.repeat(4*1024*1024)+'\\nlast\\n')", { onLine: line => lines.push(line) });
  assert.ok(result.stdout.length <= 200_000);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length <= 200_100);
  assert.match(lines[0], /^\[\.\.\. line prefix omitted \.\.\.\] a+$/);
  assert.equal(lines[1], 'last');
});

test('a failing progress callback rejects its command instead of crashing the host', async () => {
  const failure = Error('synthetic progress failure');
  const controller = new AbortController();
  let callbacks = 0;
  await assert.rejects(run("process.stdout.write('first\\nsecond\\n');setInterval(()=>{},1000)", { signal: controller.signal, onLine() { callbacks++; throw failure; } }), error => error === failure);
  assert.equal(callbacks, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a failing final partial-line callback rejects after exit without an uncaught exception', async () => {
  await assert.rejects(run("process.stdout.write('unfinished')", { onLine() { throw Error('final progress failure'); } }), /final progress failure/);
});

test('invalid deadlines and pre-cancelled commands never create output', async () => {
  const marker = path.join(scratch, 'must-not-exist');
  const code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`;
  for (const timeoutMs of [NaN, Infinity, -1, 2_147_483_648]) await assert.rejects(run(code, { timeoutMs }), /Invalid timeoutMs/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(code, { signal: controller.signal }), /abort/i);
  assert.equal(fs.existsSync(marker), false);
  assert.equal((await run("process.stdout.write('ok')", { timeoutMs: 0 })).stdout, 'ok');
});

test('cancellation prevents later buffered progress and removes its listener', async () => {
  const controller = new AbortController(), lines = [];
  await assert.rejects(run("process.stdout.write('first\\nsecond\\n');setInterval(()=>{},1000)", { signal: controller.signal, onLine(line) { lines.push(line); controller.abort(); } }), /cancelled/);
  assert.deepEqual(lines, ['first']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('guarded cancellation reaps the child before the caller can clean output', async () => {
  const controller = new AbortController(); let pid;
  await assert.rejects(run("process.stdout.write(process.pid+'\\n');setInterval(()=>{},1000)", {
    signal: controller.signal,
    onLine(line) { pid = Number(line); controller.abort(); },
  }), /cancelled/);
  assert.ok(Number.isSafeInteger(pid));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'worker is reaped when the operation settles');
});

test('cancellation from the final partial progress line remains a failure after child exit', async () => {
  const controller = new AbortController();
  await assert.rejects(run("process.stdout.write('final')", { signal: controller.signal, onLine() { controller.abort(); } }), /cancelled/);
});

test('cancellation stops detached descendants holding job pipes and spares unrelated workers', {timeout:5_000}, async t => {
  if (process.platform !== 'linux') { t.skip('Linux descendant identities'); return; }
  const {spawn}=await import('node:child_process');
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  const controller=new AbortController();let escaped;
  const code="const {spawn}=require('child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});process.stdout.write(grand.pid+'\\n');setInterval(()=>{},1000)";
  try {
    const pending=run(code,{signal:controller.signal,timeoutMs:250,onLine(line){escaped=Number(line);controller.abort();}});
    let timer;
    try { await assert.rejects(Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('escaped worker held stdio beyond cancellation bound')),1_500);})]),/node cancelled/); }
    finally {clearTimeout(timer);}
    assert.ok(Number.isSafeInteger(escaped));
    await assertOrphanStopped(escaped);
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  } finally {
    if(escaped)try{process.kill(-escaped,'SIGKILL');}catch{}
    unrelated.kill('SIGKILL');await new Promise(resolve=>unrelated.once('close',resolve));
  }
});

const linuxOutputOwnership = { skip: process.platform !== 'linux', timeout: 6_000 };
test('the deadline stops an inherited-output worker even after its direct parent exits', linuxOutputOwnership, t => deadlineAfterLeaderExit(t));
test('the deadline finds inherited output retained at a non-standard descriptor', linuxOutputOwnership, t => deadlineAfterLeaderExit(t, { descriptor: 3 }));
test('a second cleanup scan finds the inherited writer missed when the deadline fired', linuxOutputOwnership, t => deadlineAfterLeaderExit(t, { miss: 'first' }));
test('unverified inherited writers cannot keep a stopped command pending indefinitely', linuxOutputOwnership, t => deadlineAfterLeaderExit(t, { miss: 'all' }));
