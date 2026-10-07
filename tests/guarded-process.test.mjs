import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { runGuarded } from '../agent/extensions/lib/guarded-process.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-process-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const run = (code, options = {}) => runGuarded(process.execPath, ['-e', code], { cwd: scratch, guard: false, timeoutMs: 10_000, memoryMb: 12_000, ...options });

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
    // An adopted grandchild can briefly remain a zombie under PID1; it must
    // be gone or dead, with no running writer holding this operation's pipes.
    try {const stat=fs.readFileSync(`/proc/${escaped}/stat`,'utf8');assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  } finally {
    if(escaped)try{process.kill(-escaped,'SIGKILL');}catch{}
    unrelated.kill('SIGKILL');await new Promise(resolve=>unrelated.once('close',resolve));
  }
});

test('the deadline stops an inherited-output worker even after its direct parent exits', {timeout:5_000}, async t => {
  if(process.platform!=='linux'){t.skip('Linux inherited output identities');return;}
  let escaped;
  const code="const {spawn}=require('child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});grand.unref();process.stdout.write(grand.pid+'\\n')";
  let timer;
  try {
    const pending=run(code,{timeoutMs:150,onLine(line){escaped=Number(line);}});
    await assert.rejects(Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('orphan output writer exceeded the deadline bound')),1_500);})]),/exceeded/);
    assert.ok(Number.isSafeInteger(escaped));
    try{const stat=fs.readFileSync(`/proc/${escaped}/stat`,'utf8');assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');}catch(error){if(error.code!=='ENOENT')throw error;}
  }finally{clearTimeout(timer);if(escaped)try{process.kill(-escaped,'SIGKILL');}catch{}}
});

test('the deadline finds inherited output retained at a non-standard descriptor', {timeout:5_000}, async t => {
  if(process.platform!=='linux'){t.skip('Linux inherited output identities');return;}
  let escaped, timer;
  const code="const {spawn}=require('child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore','ignore',process.stdout]});grand.unref();process.stdout.write(grand.pid+'\\n')";
  try {
    const pending=run(code,{timeoutMs:150,onLine(line){escaped=Number(line);}});
    await assert.rejects(Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('inherited fd3 writer exceeded the deadline bound')),1_500);})]),/exceeded/);
    assert.ok(Number.isSafeInteger(escaped));
    try{const stat=fs.readFileSync(`/proc/${escaped}/stat`,'utf8');assert.equal(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');}catch(error){if(error.code!=='ENOENT')throw error;}
  }finally{clearTimeout(timer);if(escaped)try{process.kill(-escaped,'SIGKILL');}catch{}}
});
