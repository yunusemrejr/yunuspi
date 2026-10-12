import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readHistory, closeHistoryReaders, cancelPendingHistoryReads } from '../desktop/history-reader.mjs';

const coreRoot = process.env.YUNUSPI_HISTORY_TEST_CORE_ROOT || path.resolve(import.meta.dirname, '../core/coding-agent');
after(closeHistoryReaders);

function fixture(t, { version = 3, entries = [], newline = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-history-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), directory = path.join(root, 'transcripts');
  fs.mkdirSync(cwd); fs.mkdirSync(directory);
  const sessionId = randomUUID(), timestamp = new Date().toISOString();
  const header = { type: 'session', version, id: sessionId, timestamp, cwd };
  const file = path.join(directory, `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
  fs.writeFileSync(file, [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + (newline ? '\n' : ''));
  return { cwd, directory, sessionId, coreRoot, file };
}
const entry = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: 'user', content, timestamp: Date.now() } });
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('passive history pages preserve the current branch, custom messages and compaction markers', async t => {
  const f = fixture(t, { entries: [
    entry('root', null, 'root'), entry('old', 'root', 'discarded branch'),
    entry('current', 'root', 'current branch'),
    { type: 'custom_message', id: 'custom', parentId: 'current', customType: 'example', content: 'A visible custom result.', display: true, timestamp: new Date().toISOString() },
    { type: 'compaction', id: 'compacted', parentId: 'custom', timestamp: new Date().toISOString(), summary: 'summary' },
  ] });
  const last = await readHistory({ ...f, limit: 2 });
  assert.equal(last.total, 4); assert.equal(last.before, 2); assert.equal(last.hasMore, true);
  assert.equal(last.messages[0].content, 'A visible custom result.');
  assert.equal(last.messages[1].customType, 'desktop-compaction');
  const first = await readHistory({ ...f, limit: 2, before: last.before });
  assert.deepEqual(first.messages.map(message => message.content), ['root', 'current branch']);
  assert.equal(first.hasMore, false); assert.equal(first.isStreaming, false); assert.equal(first.streamingMessage, null);
});

test('reading a complete final line does not repair or rewrite the source file', async t => {
  const f = fixture(t, { entries: [entry('last', null, 'A final complete line.')], newline: false });
  const hash = digest(f.file), stat = fs.statSync(f.file);
  assert.equal((await readHistory(f)).messages[0].content, 'A final complete line.');
  assert.equal(digest(f.file), hash); assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
});

test('legacy migration occurs in memory and leaves the legacy transcript bytes intact', async t => {
  const f = fixture(t, { version: 1, newline: false, entries: [
    { type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Legacy request.' } },
    { type: 'message', timestamp: new Date().toISOString(), message: { role: 'hookMessage', content: 'Legacy visible result.', display: true } },
  ] });
  const hash = digest(f.file), result = await readHistory(f);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[1].role, 'custom');
  assert.equal(digest(f.file), hash);
});

test('cyclic branches fail clearly without hanging later reads or changing either transcript', async t => {
  const cyclic = fixture(t, { entries: [entry('one', 'two', 'One'), entry('two', 'one', 'Two')] });
  const normal = fixture(t, { entries: [entry('ok', null, 'Still responsive.')] });
  const hash = digest(cyclic.file);
  await assert.rejects(readHistory(cyclic), /branch cycle/);
  assert.equal((await readHistory(normal)).messages[0].content, 'Still responsive.');
  assert.equal(digest(cyclic.file), hash);
});

test('concurrent session reads retain request ownership and bounded previews', async t => {
  const a = fixture(t, { entries: [entry('a', null, 'a'.repeat(100_000))] });
  const b = fixture(t, { entries: [entry('b', null, 'Session B.')] });
  const [ra, rb] = await Promise.all([readHistory(a), readHistory(b)]);
  assert.match(ra.messages[0].content, /^aaa/); assert.ok(ra.messages[0].content.length < 33_000);
  assert.equal(rb.messages[0].content, 'Session B.');
});

test('duplicate identifiers fail safely and oversized histories retain their source', async t => {
  const duplicate = fixture(t, { entries: [entry('same', null, 'first'), entry('same', null, 'second')] });
  await assert.rejects(readHistory(duplicate), /invalid entry identifiers/);
  const oversized = fixture(t, { entries: [entry('first', null, 'large fixture')] });
  fs.truncateSync(oversized.file, 128 * 1024 * 1024 + 1);
  await assert.rejects(readHistory(oversized), /128 MiB/);
  assert.equal(fs.statSync(oversized.file).size, 128 * 1024 * 1024 + 1);
});

test('oversized imported metadata cannot bypass the history transfer budget', async t => {
  const message = entry('metadata', null, 'The visible message is short.');
  message.message.usage = { unexpectedMetadata: 'x'.repeat(9 * 1024 * 1024) };
  const f = fixture(t, { entries: [message] }), hash = digest(f.file);
  await assert.rejects(readHistory(f), /8 MiB transfer limit/);
  assert.equal(digest(f.file), hash);
});

test('empty histories and invalid page requests do not create transcript files', async t => {
  const f = fixture(t); fs.rmSync(f.file);
  assert.deepEqual((await readHistory(f)).messages, []);
  await assert.rejects(readHistory({ ...f, before: -1 }), /Invalid history request/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('reader cancellation rejects outstanding requests and permits a clean restart', async t => {
  await closeHistoryReaders();
  const f = fixture(t, { entries: [entry('ok', null, 'After restart.')] });
  const pending = readHistory(f);
  const rejection = assert.rejects(pending, /reader closed/);
  await closeHistoryReaders(); await rejection;
  assert.equal((await readHistory(f)).messages[0].content, 'After restart.');
});

test('selection changes cancel obsolete reads while preserving an idle reader', async t => {
  await closeHistoryReaders();
  const f = fixture(t, { entries: [entry('ok', null, 'The new selection.')] });
  const obsolete = readHistory(f), rejected = assert.rejects(obsolete, /selection changed/);
  assert.equal(await cancelPendingHistoryReads(), 1); await rejected;
  assert.equal((await readHistory(f)).messages[0].content, 'The new selection.');
  assert.equal(await cancelPendingHistoryReads(), 0);
  assert.equal((await readHistory(f)).messages[0].content, 'The new selection.');
});

test('project aliases, moved folders and missing folders retain viewable owned history', async t => {
  const f = fixture(t, { entries: [entry('ok', null, 'History remains available.')] });
  const alias = path.join(path.dirname(f.cwd), 'alias'); fs.symlinkSync(f.cwd, alias, 'dir');
  assert.equal((await readHistory({ ...f, cwd: alias })).messages[0].content, 'History remains available.');
  const moved = path.join(path.dirname(f.cwd), 'moved-project'); fs.renameSync(f.cwd, moved);
  assert.equal((await readHistory({ ...f, cwd: moved })).messages[0].content, 'History remains available.');
  fs.rmSync(moved, { recursive: true });
  assert.equal((await readHistory({ ...f, cwd: moved })).messages[0].content, 'History remains available.');
});

test('a reader deadline clears outstanding work and the next read starts healthy', async t => {
  await closeHistoryReaders();
  const f = fixture(t, { entries: [entry('ok', null, 'After timeout.')] });
  await assert.rejects(readHistory({ ...f, timeoutMs: 1 }), /timed out/);
  assert.equal((await readHistory(f)).messages[0].content, 'After timeout.');
});
