import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgentWorker, jsonLines } from '../desktop/agent-worker.mjs';
import { applyAgentEvent, createConversation, messageText } from '../desktop/renderer/conversation.mjs';

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  const commands = [];
  child.stdin.on('data', jsonLines(command => commands.push(command), error => { throw error; }));
  const worker = new AgentWorker({ command: 'fixture', args: [], spawnProcess: () => child, ...options });
  const emit = event => child.stdout.write(JSON.stringify(event) + '\n');
  const close = (code = 0, signal = null) => child.emit('close', code, signal);
  return { child, worker, commands, emit, close };
}

test('desktop JSONL preserves fragmented UTF-8, embedded separators and multiple records', () => {
  const received = [], failures = [];
  const read = jsonLines(value => received.push(value), error => failures.push(error));
  const expected = [{ type: 'text', text: 'rat 🐀 Türkçe\u2028second\u2029third' }, { type: 'done' }];
  const bytes = Buffer.from('\n' + expected.map(value => JSON.stringify(value)).join('\r\n') + '\n');
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.deepEqual(received, expected);
  assert.deepEqual(failures, []);
});

test('desktop JSONL rejects malformed and oversized records once and never consumes later events', () => {
  for (const input of [Buffer.from('{bad json}\n'), Buffer.from(JSON.stringify({ text: '🐀'.repeat(20) }) + '\n')]) {
    const received = [], failures = [];
    const read = jsonLines(value => received.push(value), error => failures.push(error), 32);
    read(input); read(Buffer.from('{"type":"late"}\n'));
    assert.equal(failures.length, 1);
    assert.equal(received.length, 0);
  }
});

test('worker correlates out-of-order commands and streams lifecycle events independently', async () => {
  const f = fixture(), events = [];
  f.worker.on('event', event => events.push(event.type));
  try {
    const state = f.worker.request('get_state'), stats = f.worker.request('get_session_stats');
    assert.equal(new Set(f.commands.map(command => command.id)).size, 2);
    f.emit({ type: 'agent_start' }); assert.equal(f.worker.busy, true);
    f.emit({ type: 'response', id: f.commands[1].id, success: true, data: { totalTokens: 17 } });
    f.emit({ type: 'response', id: f.commands[0].id, success: true, data: { isStreaming: true } });
    assert.deepEqual(await stats, { totalTokens: 17 });
    assert.deepEqual(await state, { isStreaming: true });
    f.emit({ type: 'agent_end' }); assert.equal(f.worker.busy, false);
    assert.deepEqual(events, ['agent_start', 'agent_end']);
    assert.equal(f.worker.pending.size, 0);
  } finally { f.close(); }
});

test('worker captures a history boundary before later events in the same stdout chunk', async () => {
  const f = fixture(), sequences = [];
  f.worker.on('event', (_event, sequence) => sequences.push(sequence));
  try {
    const pending = f.worker.requestWithBoundary('get_messages', { projection: 'desktop' });
    const data = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'before' }] }] };
    const records = [
      { type: 'agent_start' },
      { type: 'response', id: f.commands[0].id, success: true, data },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' after' } },
      { type: 'agent_end' },
    ];
    f.child.stdout.write(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    assert.deepEqual(await pending, { data, sequence: 1, busy: true });
    assert.equal(f.worker.sequence, 3, 'reading the sequence in a promise continuation would lose this distinction');
    assert.equal(f.worker.busy, false, 'history streaming state must also be captured before a late agent_end');
    assert.deepEqual(sequences, [1, 2, 3]);
  } finally { f.close(); }
});

test('worker command errors and timeout uncertainty release pending request slots', async () => {
  const f = fixture({ timeout: 15 });
  try {
    const rejected = assert.rejects(f.worker.request('set_model'), /unavailable model/);
    f.emit({ type: 'response', id: f.commands[0].id, success: false, error: 'unavailable model' });
    await rejected;
    await assert.rejects(f.worker.request('prompt'), /timed out.*may still be running/);
    assert.equal(f.worker.pending.size, 0);
    f.emit({ type: 'response', id: f.commands[1].id, success: true });
    assert.equal(f.worker.pending.size, 0);
  } finally { f.close(); }
});

test('worker rejects pending requests on an unexpected exit and blocks commands afterward', async () => {
  const f = fixture(), stopped = [];
  f.worker.on('stopped', result => stopped.push(result));
  const pending = assert.rejects(f.worker.request('get_state'), /fixture startup failed/);
  f.child.stderr.write('fixture startup failed');
  f.close(1);
  await pending;
  await assert.rejects(f.worker.request('prompt'), /not connected/);
  assert.equal(f.worker.dead, true);
  assert.equal(f.worker.busy, false);
  assert.equal(f.worker.pending.size, 0);
  assert.equal(stopped[0].expected, false);
  assert.match(stopped[0].message, /fixture startup failed/);
});

test('worker bounds pending commands and releases every waiter on disconnect', async () => {
  const f = fixture();
  const pending = Array.from({ length: 64 }, () => f.worker.request('get_state').catch(error => error));
  try {
    await assert.rejects(f.worker.request('get_state'), /Too many pending/);
    assert.equal(f.commands.length, 64);
    f.close(1);
    assert.ok((await Promise.all(pending)).every(error => error instanceof Error));
    assert.equal(f.worker.pending.size, 0);
  } finally { f.close(); }
});

test('worker pipe and spawn errors disconnect without leaking late lifecycle events', async () => {
  for (const source of ['stdin', 'stdout', 'stderr', 'process']) {
    const f = fixture(), events = [], stopped = [];
    f.worker.on('event', event => events.push(event));
    f.worker.on('stopped', result => stopped.push(result));
    const pending = assert.rejects(f.worker.request('get_state'), /fixture pipe failure/);
    try {
      (source === 'process' ? f.child : f.child[source]).emit('error', Error('fixture pipe failure'));
      await pending;
      await assert.rejects(f.worker.request('prompt'), /fixture pipe failure/);
      f.emit({ type: 'agent_start' });
      assert.equal(f.worker.busy, false);
      assert.deepEqual(events, []);
      f.close(1); await f.worker.exited;
      assert.equal(stopped[0].expected, false);
      assert.equal(stopped[0].message, 'fixture pipe failure');
    } finally { f.close(); }
  }
});

test('worker speaks JSONL to a real owned child and shuts it down by EOF', { timeout: 10_000 }, async () => {
  const worker = new AgentWorker({
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { createInterface } from 'node:readline';
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const command = JSON.parse(line);
        process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { text: '🐀 ready', isStreaming: false } }) + '\\n');
      }
    `],
    timeout: 5_000,
  });
  const stopped = [];
  worker.on('stopped', result => stopped.push(result));
  try {
    assert.deepEqual(await worker.request('get_state'), { text: '🐀 ready', isStreaming: false });
    await worker.stop();
    assert.equal(worker.dead, true);
    assert.equal(stopped[0].code, 0);
    assert.equal(stopped[0].expected, true);
  } finally { if (!worker.dead) { worker.child.kill('SIGKILL'); await worker.exited; } }
});

test('worker close completes after agent exit even when a descendant retains stdout', { timeout: 10_000 }, async () => {
  const worker = new AgentWorker({
    command: process.execPath,
    args: ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const command = JSON.parse(line);
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
        process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data: { pid: child.pid } }) + '\\n');
        await new Promise(resolve => setTimeout(resolve, 200));
        process.exit(0);
      }
    `],
    timeout: 5_000,
  });
  let descendant;
  try {
    descendant = (await worker.request('get_state')).pid;
    const started = performance.now();
    await worker.stop();
    assert.equal(worker.child.exitCode, 0);
    assert.equal(worker.dead, true);
    assert.ok(performance.now() - started < 2000, 'inherited pipes must not hold the desktop close until the descendant exits');
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    if (!worker.dead) { worker.child.kill('SIGKILL'); await worker.exited; }
  }
});

test('worker close sends EOF once and escalates a stuck child within a bounded shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let endings = 0;
  f.child.stdin.on('finish', () => endings++);
  try {
    const first = f.worker.stop(), second = f.worker.stop();
    await assert.rejects(f.worker.request('prompt'), /not connected/);
    await Promise.resolve();
    assert.equal(f.child.stdin.writableEnded, true);
    t.mock.timers.tick(7000); assert.deepEqual(f.child.signals, ['SIGTERM']);
    t.mock.timers.tick(5000); assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
    f.close(null, 'SIGKILL');
    await Promise.all([first, second]);
    assert.ok(endings <= 1);
    assert.equal(f.worker.pending.size, 0);
  } finally { f.close(); }
});

test('fatal worker output disconnects immediately, escalates shutdown and preserves its failure reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), stopped = [];
  f.worker.on('stopped', result => stopped.push(result));
  const pending = assert.rejects(f.worker.request('get_state'), /JSON|Unexpected|property/i);
  try {
    f.child.stdout.write('{broken}\n');
    await pending;
    assert.equal(f.worker.stopping, true, 'a corrupted protocol must not leave a live but unreadable worker');
    await assert.rejects(f.worker.request('get_messages'), /JSON|Unexpected|property|not connected/i);
    t.mock.timers.tick(12_000);
    assert.ok(f.child.signals.includes('SIGKILL'), 'SIGTERM alone cannot bound a stuck agent');
    f.close(null, 'SIGKILL');
    await f.worker.exited;
    assert.equal(stopped[0].expected, false, 'protocol failure must remain visible to the desktop');
    assert.match(stopped[0].message, /JSON|Unexpected|property/i);
  } finally { f.close(); }
});

test('conversation reducers isolate simultaneous sessions and reconcile streamed tool history', () => {
  const first = createConversation(), second = createConversation();
  applyAgentEvent(first, { type: 'agent_start' });
  applyAgentEvent(first, { type: 'message_start', message: { role: 'assistant', content: [] } });
  applyAgentEvent(first, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' } });
  applyAgentEvent(second, { type: 'message_start', message: { role: 'user', content: 'Different project' } });
  applyAgentEvent(first, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'rat' } });
  applyAgentEvent(first, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello rat' }] } });
  applyAgentEvent(first, { type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'read', args: { path: 'fixture.txt' } });
  applyAgentEvent(first, { type: 'tool_execution_end', toolCallId: 'call-a', toolName: 'read', result: { content: [{ type: 'text', text: 'contents' }] }, isError: false });
  applyAgentEvent(first, { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-a', toolName: 'read', content: [{ type: 'text', text: 'contents' }] } });
  applyAgentEvent(first, { type: 'agent_end' });
  assert.equal(messageText(first.messages[0]), 'Hello rat');
  assert.equal(messageText(second.messages[0]), 'Different project');
  assert.equal(first.messages.filter(message => message.kind === 'tool').length, 1);
  assert.equal(first.messages[1].output, 'contents');
  assert.equal(first.messages[1].status, 'done');
  assert.equal(first.activities[0].status, 'done');
  assert.equal(first.streaming, null);
  assert.equal(first.busy, false);
});
