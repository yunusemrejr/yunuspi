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

test('paged snapshots notice same-size rewrites and appended history', async t => {
  const f = fixture(t, { entries: [entry('first', null, 'before'), entry('next', 'first', 'next')] });
  const mtime = new Date('2025-01-01T00:00:00.000Z');
  fs.utimesSync(f.file, mtime, mtime);
  const initial = await readHistory({ ...f, limit: 1 });
  assert.equal(initial.before, 1);

  const text = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.file, text.replace('"content":"before"', '"content":"edited"'));
  fs.utimesSync(f.file, mtime, mtime);
  assert.deepEqual((await readHistory({ ...f, before: initial.before })).messages.map(message => message.content), ['edited']);

  fs.appendFileSync(f.file, JSON.stringify(entry('end', 'next', 'appended')) + '\n');
  const appended = await readHistory({ ...f, limit: 1 });
  assert.equal(appended.total, 3);
  assert.equal(appended.messages[0].content, 'appended');
});

test('same-revision reopen omits the message payload and stale cursors reset after a change', async t => {
  const f = fixture(t, { entries: [entry('first', null, 'Original'), entry('next', 'first', 'Next')] });
  const initial = await readHistory({ ...f, limit: 1 });
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal(initial.before, 1);
  const other = fixture(t, { entries: [entry('other', null, 'Other conversation')] });
  await readHistory(other);
  const unchanged = await readHistory({ ...f, revision: initial.revision });
  assert.equal(unchanged.revision, initial.revision);
  assert.equal(unchanged.messages, undefined);
  assert.deepEqual(unchanged.stats, initial.stats);

  const mtime = fs.statSync(f.file).mtime;
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Original', 'Replaced'));
  fs.utimesSync(f.file, mtime, mtime);
  const reset = await readHistory({ ...f, before: initial.before, revision: initial.revision });
  assert.equal(reset.reset, true);
  assert.equal(reset.messages, undefined);
  const latest = await readHistory({ ...f, revision: initial.revision });
  assert.notEqual(latest.revision, initial.revision);
  assert.deepEqual(latest.messages.map(message => message.content), ['Replaced', 'Next']);
});

test('passive totals refresh without transferring messages after a late saved charge', async t => {
  const f = fixture(t, { entries: [entry('visible', null, 'Visible conversation')] });
  const initial = await readHistory(f);
  fs.appendFileSync(f.file, JSON.stringify({ type: 'custom', id: 'late-charge', parentId: 'visible', accountingOnly: true,
    customType: 'auxiliary-model-usage-v1', data: { id: 'late-request', owner: 'fixture', provider: 'openrouter', model: 'fixture',
      status: 'completed', usage: { cost: { total: 0.125, source: 'provider-reported' } } } }) + '\n');
  const result = await readHistory({ ...f, statsOnly: true });
  assert.equal(result.messages, undefined);
  assert.notEqual(result.revision, initial.revision);
  assert.equal(result.stats.cost, 0.125);
  assert.deepEqual((await readHistory(f)).messages, initial.messages);
});

test('passive totals refresh an owned child receipt even when the parent revision stays the same', async t => {
  await closeHistoryReaders();
  const previousRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
  const f = fixture(t);
  const tempRoot = path.dirname(f.cwd);
  const statusRoot = path.join(tempRoot, 'async-subagent-runs');
  process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
  t.after(async () => {
    await closeHistoryReaders();
    if (previousRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previousRoot;
  });

  const runId = 'auto-assist-fixture', timestamp = new Date().toISOString();
  const childFile = path.join(f.file.slice(0, -'.jsonl'.length), randomUUID(), 'run-0', 'session.jsonl');
  const statusFile = path.join(statusRoot, runId, 'status.json');
  const usage = total => ({ input: 10, output: 2, cost: { total, source: 'provider-reported' } });
  const append = (file, ...records) => fs.appendFileSync(file, records.map(record => JSON.stringify(record) + '\n').join(''));
  const hosted = (status, total) => ({
    type: 'custom', id: `hosted-${status}`, parentId: 'answer', timestamp, customType: 'auxiliary-model-usage-v1',
    data: { id: 'hosted-request', owner: 'fixture', provider: 'openrouter', model: 'fixture',
      status, ...(total === undefined ? {} : { usage: usage(total) }) },
  });
  append(f.file, entry('visible', null, 'Visible parent conversation'), {
    type: 'custom', id: 'child', parentId: 'visible', timestamp, customType: 'subagent-cost-v1',
    data: { runId, mode: 'single', state: 'complete',
      results: [{ index: 0, agent: 'automatic-free-assistant', status: 'completed', sessionFile: childFile, usage: usage(0.25) }] },
  });
  const hash = digest(f.file), initial = await readHistory(f);
  assert.equal(initial.stats.cost, 0.25);

  fs.mkdirSync(path.dirname(childFile), { recursive: true });
  append(childFile, { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: f.cwd }, {
    type: 'message', id: 'answer', parentId: null, timestamp,
    message: { role: 'assistant', provider: 'openrouter', model: 'fixture', content: [], usage: usage(0.25) },
  }, hosted('pending'));
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({ runId, mode: 'single', state: 'complete', sessionId: f.file,
    steps: [{ status: 'complete', sessionFile: childFile }] }));

  const pending = await readHistory({ ...f, revision: initial.revision });
  assert.equal(pending.revision, initial.revision);
  assert.equal(pending.messages, undefined);
  assert.equal(pending.stats.cost, 0.25);
  assert.equal(pending.stats.costLabel, '$0.250000+?');
  append(childFile, hosted('completed', 0));
  assert.equal((await readHistory({ ...f, statsOnly: true })).stats.costLabel, '$0.250000');

  append(childFile, {
    type: 'custom', id: 'later-hosted', parentId: 'answer', timestamp, customType: 'auxiliary-model-usage-v1',
    data: { id: 'later-hosted-request', owner: 'fixture', provider: 'openrouter', model: 'fixture',
      status: 'completed', usage: usage(0.125) },
  });
  const refreshed = await readHistory({ ...f, revision: initial.revision });
  assert.equal(refreshed.revision, initial.revision);
  assert.equal(refreshed.messages, undefined);
  assert.equal(refreshed.stats.cost, 0.375);
  assert.equal((await readHistory({ ...f, statsOnly: true })).stats.cost, 0.375);
  assert.equal(digest(f.file), hash);
});

test('passive open includes whole-session charges, including discarded branches outside the page', async t => {
  const priced = (id, parentId, total) => ({
    ...entry(id, parentId, ''),
    message: { role: 'assistant', provider: 'openrouter', model: 'fixture', content: [],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total, source: 'provider-reported' } } },
  });
  const f = fixture(t, { entries: [
    entry('root', null, 'root'), priced('old-branch', 'root', 0.125), priced('main', 'root', 0.25),
    { type: 'custom', id: 'audio', parentId: 'main', customType: 'auxiliary-model-usage-v1',
      data: { id: 'request', owner: 'audio_generate', provider: 'elevenlabs', model: 'music_v2', status: 'completed' } },
    entry('current', 'audio', 'current branch'),
  ] });
  const latest = await readHistory({ ...f, limit: 1 });
  assert.deepEqual(latest.messages.map(message => message.content), ['current branch']);
  assert.equal(latest.stats.cost, 0.375);
  assert.equal(latest.stats.costLabel, '$0.375000+?');
  assert.equal(latest.stats.tokens.total, 24);
  assert.equal((await readHistory({ ...f, before: latest.before })).stats, undefined);
});

test('passive open preserves the forked branch and counts its linked summary once', async t => {
  const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: .08, source: 'provider-reported' } };
  const f = fixture(t, { entries: [
    entry('root', null, 'keep this message'),
    { type: 'branch_summary', id: 'summary', parentId: 'root', summary: 'Earlier findings', usage: { ...usage, summaryReceiptIds: ['attempt'] } },
    { type: 'custom', id: 'summary-receipt', parentId: null, accountingOnly: true, customType: 'auxiliary-model-usage-v1',
      data: { id: 'attempt', owner: 'branch-summary', provider: 'openrouter', model: 'fixture', status: 'completed', usage } },
  ] });
  const result = await readHistory(f);
  assert.equal(result.messages[0].content, 'keep this message');
  assert.equal(result.stats.costLabel, '$0.080000');
  assert.equal(result.stats.tokens.total, 12);
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
