import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-observations.ts')));
const load = rel => import(pathToFileURL(path.join(agent, rel)));
const { retrieveObservation } = await load('extensions/lib/observation-retrieval.ts');
const { default: register } = await load('extensions/pi-observations.ts');
const unavailable = async () => ({ ok: false, reason: 'unavailable' });

test('query retrieval keeps exact, bounded source spans and fails open when local ranking fails', async () => {
  const raw = ('routine unrelated output\n'.repeat(120) + 'Authentication credentials expired; login rejected\n').repeat(4);
  for (const needle of [unavailable, async () => { throw Error('worker failed'); }]) {
    const result = await retrieveObservation(raw, 'authentication credentials', { needle, limit: 1800, maxMatches: 2 });
    assert.equal(result.ranking, 'lexical');
    assert.equal(result.spans.length, 2);
    assert.ok(result.returnedChars <= 1800);
    assert.ok(result.spans.every(span => raw.slice(span.start, span.end).includes('Authentication')));
    assert.ok(result.spans[0].end <= result.spans[1].start);
    assert.equal(result.returnedChars, result.spans.reduce((sum, span) => sum + span.end - span.start, 0));
  }
});

test('small excerpt budgets center literal, normalized and expanded matches', async () => {
  for (const [query, target] of [['needleword', 'needleword'], ['retry', 'backoff'], ['needleword', 'ｎｅｅｄｌｅｗｏｒｄ']]) {
    for (const prefix of ['', 'prefix '.repeat(120)]) {
    const raw = prefix + target + ' filler'.repeat(100);
    const result = await retrieveObservation(raw, query, { needle: unavailable, limit: 80 });
    assert.ok(result.spans.some(span => raw.slice(span.start, span.end).includes(target)), query);
    assert.ok(result.returnedChars <= 80);
    }
  }
});

test('bounded search states prefix coverage and no matches never runs local inference', async () => {
  let calls = 0;
  const needle = async () => { calls++; return unavailable(); };
  const raw = 'unrelated '.repeat(60000) + 'secretTarget';
  const result = await retrieveObservation(raw, 'secretTarget', { needle });
  assert.deepEqual(result.spans, []);
  assert.equal(result.scannedChars, 512 * 1024);
  assert.equal(result.totalChars, raw.length);
  assert.equal(calls, 0);
  await assert.rejects(retrieveObservation(raw, '  ', { needle }), /3–512/);
});

test('candidate count cap reports the actual scanned prefix rather than its desired byte cap', async () => {
  const chars = Array(512 * 1024).fill('x');
  let position = 513, gap = 0;
  while (position < chars.length) { chars[position] = '\n'; position += gap++ % 2 ? 386 : 511; }
  const raw = chars.join('');
  const result = await retrieveObservation(raw, 'targetMissing', { needle: unavailable });
  assert.ok(result.scannedChars < raw.length);
  assert.ok(result.scannedChars > 400000);
  assert.deepEqual(result.spans, []);
});

test('aborted query promptly releases its consumer and does not return late worker results', async () => {
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const signal = new AbortController();
  const pending = retrieveObservation('routing alpha\n'.repeat(400), 'routing', { signal: signal.signal, needle: () => {
    began(); return new Promise(resolve => { finish = resolve; });
  } });
  await started;
  signal.abort(new Error('cancel-query'));
  await assert.rejects(pending, /cancel-query/);
  finish({ ok: false, reason: 'unavailable' });
  await new Promise(resolve => setImmediate(resolve));
});

function fixture() {
  const hooks = new Map(), tools = new Map();
  const message = { role: 'toolResult', toolName: 'bash', toolCallId: 'source', isError: true,
    content: [{ type: 'text', text: 'irrelevant intro\n'.repeat(200) + 'Authentication failed with exit 7\n' + 'other output\n'.repeat(200) }],
    details: { exitCode: 7, piObservation: { version: 1, id: 1, signature: 'sig', operation: 'op' } } };
  const entry = { type: 'message', id: 'entry-1', message };
  let branch = [entry];
  const pi = { on: (name, handler) => hooks.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, appendEntry() {}, getActiveTools: () => ['obs_read', 'bash'] };
  register(pi, { reset() {}, endTurn() {}, select: async () => undefined }, { reset() {}, endTurn() {}, offer() {}, take() {}, takeAsync: async () => undefined });
  const ctx = { sessionManager: { getBranch: () => branch, getEntries: () => branch } };
  return { tool: tools.get('obs_read'), ctx, hooks, entry, raw: message.content[0].text, branch: value => { branch = value; } };
}

test('registered obs_read preserves original pagination, branch authority, status and exact provenance', async () => {
  const f = fixture();
  const query = await f.tool.execute('query', { id: 1, query: 'Authentication', limit: 500 }, undefined, undefined, f.ctx);
  assert.equal(query.details.originalIsError, true);
  assert.equal(query.details.originalExitCode, 7);
  assert.equal(query.details.incomplete, true);
  assert.equal(query.details.sourceHash, createHash('sha256').update(f.raw).digest('hex'));
  for (const span of query.details.spans) assert.ok(query.content[0].text.includes(f.raw.slice(span.start, span.end)));
  assert.match(query.content[0].text, /omitted context is not verified/);
  assert.match(query.content[0].text, /Authentication failed/);
  const raw = await f.tool.execute('raw', { id: 1, offset: 10, limit: 100 }, undefined, undefined, f.ctx);
  assert.equal(raw.content[0].text.split('\n[More:')[0], f.raw.slice(10, 110));
  assert.equal(raw.details.nextOffset, 110);
  await assert.rejects(f.tool.execute('bad', { id: 1, query: 'Authentication', offset: 0 }, undefined, undefined, f.ctx), /cannot be combined/);
  f.branch([]);
  await assert.rejects(f.tool.execute('foreign', { id: 1, query: 'Authentication' }, undefined, undefined, f.ctx), /unavailable on this branch/);
});

test('query does not return evidence after its active branch changes during retrieval', async () => {
  const f = fixture();
  const pending = f.tool.execute('query', { id: 1, query: 'Authentication', limit: 500 }, undefined, undefined, f.ctx);
  f.branch([]);
  await assert.rejects(pending, /branch changed/);
});

test('first-seal context telemetry reports finite savings once, without changing cached history', async () => {
  const events = [], key = Symbol.for('yunus-pi.health.v1'), before = globalThis[key];
  globalThis[key] = (kind, data) => events.push({ kind, data });
  try {
    const f = fixture();
    const message = { ...f.entry.message, isError: false, content: [{ type: 'text', text: 'plain prose line\n'.repeat(100) }], details: { ...f.entry.message.details, exitCode: 0 } };
    // A real registered extension consumes a validated selection, then seals it.
    const handlers = new Map();
    register({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerCommand() {}, getActiveTools: () => ['obs_read'], appendEntry() {} },
      { reset() {}, endTurn() {}, select: async () => undefined },
      { reset() {}, endTurn() {}, offer() {}, take: () => 'selected exact prose', takeAsync: async () => 'selected exact prose' });
    const first = await handlers.get('context')({ messages: [message] });
    const second = await handlers.get('context')({ messages: [message] });
    assert.deepEqual(first, second);
    const delivered = events.filter(event => event.kind === 'ml.evidence.delivered');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].data.helper, 'smol');
    assert.equal(delivered[0].data.savedChars, message.content[0].text.length - first.messages[0].content[0].text.length);
    assert.ok(Number.isFinite(delivered[0].data.savedChars));
  } finally { if (before === undefined) delete globalThis[key]; else globalThis[key] = before; }
});

const runtime = await load('extensions/lib/needle-runtime.ts');
const assets = await load('extensions/lib/needle-assets.mjs');
const available = (await assets.verifyAssets(assets.needleAssetDir(), false).catch(() => ({ ok: false }))).ok;
test('real Needle WASM ranks bounded observation candidates and reuses embeddings', { skip: !available && 'needle assets not installed' }, async () => {
  const handle = runtime.createNeedleRuntime({});
  const raw = 'routing authentication login\n'.repeat(40) + 'routing retry exponential backoff\n'.repeat(40) + 'routing browser screenshot\n'.repeat(40);
  let successful = 0;
  const needle = async (query, candidates, topK) => {
    const result = await handle.rank({ query, candidates, topK });
    assert.equal(result.ok, true, JSON.stringify(result));
    successful++;
    return result;
  };
  try {
    const start = performance.now();
    const first = await retrieveObservation(raw, 'routing authentication login', { needle });
    const second = await retrieveObservation(raw, 'routing authentication login', { needle });
    assert.equal(successful, 2);
    assert.deepEqual(first, second);
    assert.ok(handle.stats().cacheHits > 0);
    assert.ok(first.spans.some(span => raw.slice(span.start, span.end).includes('authentication')));
    console.log(`observation retrieval: ${raw.length} source chars, ${first.returnedChars} excerpt chars, ${first.ranking} order, two queries ${Math.round(performance.now() - start)}ms`);
  } finally { await handle.shutdown(); }
});
