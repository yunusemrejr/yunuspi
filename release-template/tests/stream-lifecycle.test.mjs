import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { EventStream } from '../core/ai/src/utils/event-stream.js';
import { attachJsonlLineReader } from '../core/coding-agent/src/modes/rpc/jsonl.js';

async function within(promise, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('reader stayed parked')), ms); })]); }
  finally { clearTimeout(timer); }
}

test('a terminal push wakes every waiting reader without a separate end call', async () => {
  const stream = new EventStream(event => event.done, event => event.result);
  const readers = Array.from({ length: 4 }, () => stream[Symbol.asyncIterator]());
  const pending = readers.map(reader => reader.next());
  const terminal = { done: true, result: 'finished' };
  try {
    stream.push(terminal);
    const values = await within(Promise.all(pending));
    assert.deepEqual(values, [{ value: terminal, done: false }, ...Array.from({ length: 3 }, () => ({ value: undefined, done: true }))]);
    assert.equal(await stream.result(), 'finished');
    assert.ok((await readers[0].next()).done);
  } finally { stream.end(); }
});

test('a large queued stream retains exact FIFO order and terminal identity', async () => {
  const stream = new EventStream(event => event === 100_000, event => event);
  for (let i = 0; i <= 100_000; i++) stream.push(i);
  stream.push('too late');
  let count = 0;
  for await (const value of stream) assert.equal(value, count++);
  assert.equal(count, 100_001);
  assert.equal(await stream.result(), 100_000);
});

test('explicit end preserves queued events and closes all parked readers', async () => {
  const stream = new EventStream(() => false, () => undefined);
  stream.push('queued');
  stream.end('result');
  const values = [];
  for await (const value of stream) values.push(value);
  assert.deepEqual(values, ['queued']);
  assert.equal(await stream.result(), 'result');
});

test('JSONL preserves strict LF framing, split UTF-8, CRLF and an unfinished last record', () => {
  const stream = new EventEmitter(), lines = [];
  attachJsonlLineReader(stream, line => lines.push(line));
  const text = '{"text":"🙂ç\u2028inside\u2029"}\r\n\n{"last":true}';
  for (const byte of Buffer.from(text)) stream.emit('data', Buffer.from([byte]));
  stream.emit('end');
  assert.deepEqual(lines, ['{"text":"🙂ç\u2028inside\u2029"}', '', '{"last":true}']);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('end'), 0);
});

test('a fragmented megabyte JSONL record is reconstructed exactly', () => {
  const stream = new EventEmitter(), lines = [];
  attachJsonlLineReader(stream, line => lines.push(line));
  const text = JSON.stringify({ image: 'x'.repeat(1024 * 1024) });
  for (let i = 0; i < text.length; i += 17) stream.emit('data', text.slice(i, i + 17));
  stream.emit('data', '\n');
  stream.emit('end');
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(lines.length, 1);
  assert.equal(hash(lines[0]), hash(text));
});

test('detaching within a JSONL callback stops the remaining records in that same chunk', () => {
  const stream = new EventEmitter(), lines = [];
  const detach = attachJsonlLineReader(stream, line => { lines.push(line); detach(); });
  stream.emit('data', 'first\nsecond\nunfinished');
  stream.emit('end');
  assert.deepEqual(lines, ['first']);
});

test('reentrant JSONL data cannot repeat the line being delivered', () => {
  const stream = new EventEmitter(), lines = [];
  attachJsonlLineReader(stream, line => { lines.push(line); if (line === 'first') stream.emit('data', 'reentrant\n'); });
  stream.emit('data', 'first\nlast\n');
  stream.emit('end');
  assert.deepEqual(lines, ['first', 'reentrant', 'last']);
});
