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
