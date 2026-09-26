import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { execCommand } from '../core/coding-agent/src/core/exec.js';
import { executeToolCall, finalizeToolCall, createToolResultMessage } from '../core/agent/src/harness/execution/tools.js';
import { BACKGROUND_CONTEXT } from '../core/agent/src/harness/context.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'command-execution-lifecycle-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function running(pid) {
  try {
    // Orphaned zombies are awaiting reaping, not executing any more work.
    return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch { return false; }
}

test('pre-cancelled extension commands never execute side effects', async () => {
  const marker = path.join(scratch, 'must-not-exist');
  const controller = new AbortController();
  controller.abort();
  const original = childProcess.spawn;
  let spawns = 0;
  childProcess.spawn = (...args) => { spawns++; return original(...args); };
  syncBuiltinESMExports();
  try {
    const result = await execCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], scratch, { signal: controller.signal });
    assert.equal(spawns, 0, 'an already cancelled invocation must not spawn');
    assert.equal(result.killed, true);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('extension command timeout terminates its owned descendant after the leader exits', { skip: process.platform !== 'linux' }, async () => {
  const pidFile = path.join(scratch, 'descendant.pid');
  let pid;
  try {
    const child = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
    const result = await execCommand('bash', ['-c', '"$@" & wait', 'parent', process.execPath, '-e', child], scratch, { timeout: 300 });
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await delay(50);
    assert.equal(result.killed, true);
    assert.notEqual(result.code, 0);
    assert.equal(running(pid), false, 'a timed-out child must not keep executing after the command returns');
  } finally {
    if (pid && running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already exited */ } }
  }
});

test('extension command signal termination and spawn failure cannot masquerade as success', async () => {
  const killed = await execCommand(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], scratch);
  assert.notEqual(killed.code, 0);
  const missing = await execCommand(path.join(scratch, 'missing-executable'), [], scratch);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /ENOENT|not found/i);
});

test('extension command decodes UTF-8 across separate stdout and stderr chunks', async () => {
  const code = "const bytes=Buffer.from('🙂ç'); process.stdout.write(bytes.subarray(0,2)); process.stderr.write(bytes.subarray(0,1)); setTimeout(()=>{process.stdout.write(bytes.subarray(2)); process.stderr.write(bytes.subarray(1));},40)";
  const result = await execCommand(process.execPath, ['-e', code], scratch);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '🙂ç');
  assert.equal(result.stderr, '🙂ç');
});

test('harness tools retain explicit failure evidence and permit after-hook recovery', async () => {
  const controller = new AbortController();
  const gate = { signal: controller.signal, admit: work => work() };
  for (const flag of [true, false, undefined, 'true']) {
    let update;
    const result = { content: [{ type: 'text', text: 'evidence' }], details: { stage: 'execute' }, isError: flag };
    const call = { toolCall: { id: 'fixture', name: 'fixture', arguments: {} }, args: {}, tool: { execute: (_id, _args, onUpdate) => { update = onUpdate; return result; } } };
    const seen = [];
    const executed = await executeToolCall(call, gate, partial => seen.push(partial), undefined, {}, BACKGROUND_CONTEXT);
    assert.equal(executed.isError, flag === true);
    assert.equal(executed.result, result);
    update(result);
    assert.deepEqual(seen, [], 'settled tools must ignore late updates');
    const message = createToolResultMessage(finalizeToolCall(call, executed));
    assert.equal(message.isError, flag === true);
    assert.deepEqual(message.details, result.details);
    assert.equal(createToolResultMessage(finalizeToolCall(call, executed, { isError: false })).isError, false);
  }
});

test('invalid extension timeouts fail before execution and zero preserves unlimited commands', async () => {
  for (const timeout of [NaN, Infinity, -1, 2_147_483_648]) {
    await assert.rejects(execCommand(process.execPath, ['-e', 'process.exit(0)'], scratch, { timeout }), /Invalid timeout/);
  }
  assert.equal((await execCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], scratch, { timeout: 0 })).stdout, 'ok');
});

test('core and managed shell deadlines remain bounded when an escaped descendant owns the pipes', { skip: process.platform !== 'linux' }, async () => {
  const { runManagedCommand } = await import('../agent/extensions/managed-bash.ts');
  const { createLocalBashOperations } = await import('../core/coding-agent/src/core/tools/bash.js');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const kind of ['core', 'managed']) for (const noisy of [false, true]) {
    const pidFile = path.join(scratch, `${kind}-${noisy}.pid`);
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{${noisy ? "process.stdout.write('tick\\n')" : ''}},20)`;
    const command = `setsid ${quote(process.execPath)} -e ${quote(script)} & while [ ! -f ${quote(pidFile)} ]; do sleep 0.01; done; echo leader-done`;
    let timer;
    const execution = (kind === 'managed'
      ? runManagedCommand(command, scratch, 0.3, undefined, Infinity)
      : createLocalBashOperations().exec(command, scratch, { timeout: 0.3, onData() {} }))
      .then(value => ({ value }), error => ({ error }));
    try {
      const outcome = await Promise.race([execution, new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), 2000); })]);
      assert.equal(outcome.hung, undefined, `${kind}: inherited ${noisy ? 'active' : 'idle'} pipe exceeded deadline`);
      if (noisy) assert.match(outcome.error?.message ?? '', /timeout/);
      else assert.equal(outcome.value.exitCode, 0);
    } finally {
      clearTimeout(timer);
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        try { process.kill(-pid, 'SIGKILL'); } catch { /* fixture already exited */ }
      }
      await execution;
    }
  }
});

test('managed shell cancellation preserves descendant cleanup grace', { skip: process.platform !== 'linux' }, async () => {
  const { runManagedCommand } = await import('../agent/extensions/managed-bash.ts');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const ready = path.join(scratch, 'cleanup-ready');
  const cleaned = path.join(scratch, 'cleanup-done');
  const script = `const fs=require('fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(cleaned)},'done');process.exit(0)},200));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const command = `${quote(process.execPath)} -e ${quote(script)} & wait`;
  const controller = new AbortController();
  const execution = runManagedCommand(command, scratch, 5, controller.signal, Infinity, 700);
  const rejection = assert.rejects(execution, /aborted/);
  try {
    for (let n = 0; n < 200 && !fs.existsSync(ready); n++) await delay(10);
    assert.equal(fs.existsSync(ready), true);
    controller.abort();
    await rejection;
    assert.equal(fs.readFileSync(cleaned, 'utf8'), 'done');
  } finally { controller.abort(); await rejection; }
});

test('an unavailable optional managed watchdog cannot crash an otherwise successful command', async () => {
  const { EventEmitter } = await import('node:events');
  const { runManagedCommand } = await import('../agent/extensions/managed-bash.ts');
  const original = childProcess.spawn;
  let watchdogs = 0;
  childProcess.spawn = (binary, args, options) => {
    if (binary === '/bin/bash' && args?.[1]?.startsWith('n=0; while kill')) {
      watchdogs++;
      const child = new EventEmitter();
      child.unref = () => child;
      queueMicrotask(() => child.emit('error', new Error('watchdog fixture unavailable')));
      return child;
    }
    return original(binary, args, options);
  };
  syncBuiltinESMExports();
  try {
    const result = await runManagedCommand('printf watchdog-safe', scratch, 1, undefined, Infinity);
    assert.equal(watchdogs, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'watchdog-safe');
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});
