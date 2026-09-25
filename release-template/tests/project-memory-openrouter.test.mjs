import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRouterMemoryEmbedder, configuredMemoryEmbedder, embedMemory, validMemoryVectors, DEFAULT_MEMORY_EMBEDDING_MODEL } from '../agent/extensions/lib/project-memory-embedder.ts';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';
import { indexEvent, indexFile, reindexEmbeddings, redactSecrets } from '../agent/extensions/lib/project-memory-index.ts';
import { retrieveProjectMemory, retrieveFamily, retrieveFamilyViews } from '../agent/extensions/lib/project-memory-retrieve.ts';
import { findClusters } from '../agent/extensions/lib/project-memory-consolidate.ts';
import { recallProjectContext, PROJECT_MEMORY_RECALL } from '../agent/extensions/lib/project-memory-context.ts';
import piVectorMemory from '../agent/extensions/pi-vector-memory.ts';

const response = (vectors, model = 'Qwen/Qwen3-Embedding-8B', usage = { prompt_tokens: 12, cost: 0.000001 }) => new Response(JSON.stringify({ model, data: vectors.map((embedding, index) => ({ index, embedding })).reverse(), usage }));
const remote = (fetchImpl, extra = {}) => openRouterMemoryEmbedder({ env: {}, key: () => 'synthetic-key', fetch: fetchImpl, ...extra });
const local = (id = 'needle3', fn = async texts => texts.map(() => [1, 0])) => ({ id, backend: 'needle', model: id, embed: fn });
function storeFor(t, name = 'project') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-spaces-'));
  const db = path.join(dir, 'memory.sqlite');
  const store = openProjectStore(db, { projectId: name });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, db, dir };
}
const remember = (store, text, embedder, extra = {}) => indexEvent(store, store.projectId, { kind: 'decision', text, ...extra }, { embedder });
const put = (store, id, embedder = 'needle3', embedding = [1, 0], text = `Historical architectural evidence for ${id}`) => store.upsertChunk({ id, project_id: store.projectId, source_type: 'decision', text, content_hash: id, embedder, embedding });

test('OpenRouter uses embeddings endpoint, default model, ordered batches, dedupe and actual usage', async () => {
  const bodies = [];
  const e = remote(async (url, opts) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
    assert.equal(opts.method, 'POST'); assert.equal(opts.redirect, 'error');
    const body = JSON.parse(opts.body); bodies.push(body);
    return response(body.input.map(text => [Number(text.split(' ').at(-1)) + 1, 1, 0]));
  });
  const input = Array.from({ length: 35 }, (_, i) => `durable note ${i}`);
  const result = await embedMemory(e, [...input, input[0]]);
  assert.equal(result.space.model, DEFAULT_MEMORY_EMBEDDING_MODEL);
  assert.equal(result.space.backend, 'openrouter'); assert.equal(result.space.dim, 3);
  assert.deepEqual(bodies.map(b => b.input.length), [16, 16, 3]);
  assert.ok(bodies.every(b => b.model === DEFAULT_MEMORY_EMBEDDING_MODEL && b.encoding_format === 'float'));
  assert.deepEqual(result.vectors[34], [35, 1, 0]); assert.deepEqual(result.vectors[35], result.vectors[0]);
  result.vectors[0][0] = 999;
  assert.deepEqual(await e.embed([input[0]]), [[1, 1, 0]], 'cached vectors cannot be mutated by callers');
  assert.equal(bodies.length, 3); assert.equal(e.status().tokens, 36); assert.equal(e.status().calls, 3);
  assert.ok(e.status().costUsd > 0); assert.equal(e.status().cacheHits, 1);
});

test('configurable embedding model has its own full vector-space identity', async () => {
  const e = remote(async (_url, opts) => { const b = JSON.parse(opts.body); assert.equal(b.model, 'example/embedding-v2'); return response([[0, 1]], b.model); }, { env: { PI_MEMORY_EMBEDDING_MODEL: 'example/embedding-v2' } });
  assert.equal((await embedMemory(e, ['architecture convention'])).space.id, 'openrouter:example/embedding-v2:v1');
});

test('remote boundary redacts credentials, environment secrets, headers and private keys before truncation', async () => {
  const env = { APP_TOKEN: 'short-secret-value', MY_API_KEY: 'synthetic-env-key-value' };
  const input = 'Authorization: Bearer supersecret\npassword="synthetic small secret" token=abc123 credentials: xyz987\nhttps://u:' + 'pw@example.test/\neyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJtZSJ9.signature\nshort-secret-value synthetic-env-key-value synthetic-key\n-----BEGIN ' + 'PRIVATE KEY-----\nPRIVATE MATERIAL\n-----END PRIVATE KEY-----';
  let sent;
  const e = remote(async (_url, opts) => { sent = JSON.parse(opts.body).input[0]; return response([[1, 1]]); }, { env });
  assert.ok(await e.embed([input]));
  for (const secret of ['supersecret', 'small secret', 'abc123', 'xyz987', 'u:pw', 'signature', 'short-secret-value', 'synthetic-env-key-value', 'synthetic-key', 'PRIVATE MATERIAL']) assert.ok(!sent.includes(secret), secret);
  assert.match(sent, /redacted/);
  assert.match(redactSecrets('API_KEY: "synthetic-small"'), /redacted/);
});

for (const [name, fetchImpl, reason] of [
  ['authentication', async () => new Response('', { status: 401 }), 'http-401'],
  ['rate limit', async () => new Response('', { status: 429, headers: { 'retry-after': '12' } }), 'http-429'],
  ['provider outage', async () => new Response('', { status: 503 }), 'http-503'],
  ['model unavailable', async () => new Response('', { status: 404 }), 'http-404'],
  ['network', async () => { throw Error('private provider echo'); }, 'network-or-json'],
  ['malformed JSON', async () => new Response('{'), 'network-or-json'],
  ['empty response', async () => response([]), 'partial-batch'],
  ['partial batch', async () => response([[1, 0]]), 'partial-batch'],
  ['NaN', async () => response([[NaN, 1], [1, 0]]), 'malformed-vectors'],
  ['infinite', async () => response([[Infinity, 1], [1, 0]]), 'malformed-vectors'],
  ['zero vector', async () => response([[0, 0], [1, 0]]), 'malformed-vectors'],
  ['unequal dimension', async () => response([[1, 0], [1, 0, 0]]), 'malformed-vectors'],
  ['wrong model', async () => response([[1, 0], [1, 0]], 'other/model'), 'model-mismatch'],
  ['duplicate index', async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] })), 'invalid-index'],
]) test(`OpenRouter ${name} degrades and cools without leaking response text`, async () => {
  let calls = 0, now = 0;
  const e = remote((...args) => { calls++; return fetchImpl(...args); }, { now: () => now });
  assert.equal(await e.embed(['historical issue', 'architectural convention']), null);
  assert.equal(e.status().lastError, reason);
  assert.equal(await e.embed(['another request']), null); assert.equal(calls, 1);
  assert.equal(e.status().state, 'cooling');
  now = 300_001; await e.embed(['a later request']); assert.equal(calls, 2);
});

test('no key, offline, invalid config, cancelled input and sparse vectors never request', async () => {
  let calls = 0; const fetch = async () => { calls++; return response([[1]]); };
  for (const opts of [{ key: () => undefined }, { env: { PI_OFFLINE: 'true' } }, { model: 'bad model' }]) {
    const e = remote(fetch, opts); assert.equal(await e.embed(['some durable fact']), null); assert.ok(e.status().lastError);
  }
  const c = new AbortController(); c.abort();
  assert.equal(await remote(fetch).embed(['some durable fact'], { signal: c.signal }), null);
  assert.equal(calls, 0);
  assert.equal(validMemoryVectors(new Array(2), 2), false);
  assert.equal(validMemoryVectors([[1, , 2]], 1), false);
});

test('deadline and cancellation abort HTTP, release active slot, and never cache partial batches', async () => {
  const waiting = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const e = remote(waiting, { timeoutMs: 15 });
  assert.equal(await e.embed(['durable fact']), null); assert.equal(e.status().lastError, 'timeout');
  const c = new AbortController(), cancelled = remote(waiting);
  const pending = cancelled.embed(['durable fact'], { signal: c.signal }); c.abort();
  assert.equal(await pending, null); assert.equal(cancelled.status().lastError, 'cancelled'); assert.equal(cancelled.status().retryInMs, 0);
  let calls = 0;
  const partial = remote(async (_url, { body }) => { calls++; return calls === 1 ? response(JSON.parse(body).input.map(() => [1, 0])) : response([]); });
  assert.equal(await partial.embed(Array.from({ length: 17 }, (_, i) => `fact ${i}`)), null);
  assert.equal(await partial.embed(['fact 0']), null, 'the first successful batch is not falsely cached after an incomplete operation');
});

test('dimensions are observed then pinned, including across later requests', async () => {
  let dim = 3;
  const e = remote(async () => response([new Array(dim).fill(1)]));
  assert.equal((await e.embed(['first document']))[0].length, 3);
  dim = 4; assert.equal(await e.embed(['second document']), null);
  assert.equal(e.status().lastError, 'dimension-mismatch'); assert.equal(e.status().dimension, 3);
});

test('auto is local-first, pins a space, uses remote only when local is unavailable', async () => {
  let healthy = true, remoteCalls = 0;
  const n = local('needle3', async texts => healthy ? texts.map(() => [1, 0]) : null);
  const r = remote(async (_url, { body }) => { remoteCalls++; return response(JSON.parse(body).input.map(() => [0, 1])); });
  const auto = configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'auto' }, { needle: n, openrouter: r });
  assert.equal((await embedMemory(auto, ['first useful fact'])).space.id, 'needle3'); assert.equal(remoteCalls, 0);
  healthy = false; assert.equal(await embedMemory(auto, ['later fact']), null); assert.equal(remoteCalls, 0, 'no per-query model switching');
  const fallback = configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'auto' }, { needle: n, openrouter: r });
  assert.equal((await embedMemory(fallback, ['first useful fact'])).space.model, DEFAULT_MEMORY_EMBEDDING_MODEL);
  healthy = true; assert.equal((await embedMemory(fallback, ['second useful fact'])).space.backend, 'openrouter');
  assert.equal(configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'needle' }, { needle: n, openrouter: r }), n);
  assert.equal((await embedMemory(configuredMemoryEmbedder({}, { needle: n, openrouter: r }), ['default remote recall'])).space.model, DEFAULT_MEMORY_EMBEDDING_MODEL);
  assert.equal((await embedMemory(configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'invalid' }), ['text'])), null);
});

test('Needle and Qwen vectors coexist without cross-model or cross-dimension comparison', async t => {
  const { store } = storeFor(t);
  put(store, 'needle', 'needle3', [1, 0], 'Old local vector about cache reuse');
  const e = remote(async (_url, { body }) => response(JSON.parse(body).input.map(() => [1, 0])));
  await remember(store, 'Stable remote architectural decisions', e);
  assert.equal(store.embeddingSpaces().length, 2);
  assert.deepEqual(store.vectorSearch([1, 0]), [], 'dimension alone is not a space');
  assert.deepEqual(store.vectorSearch([1, 0], { embedder: 'needle3' }).map(h => h.id), ['needle']);
  const result = await retrieveProjectMemory(store, 'paraphrased design guidance', { embedder: e, rerank: false });
  assert.equal(result.stats.vector, 1); assert.ok(!result.hits.some(h => h.chunk.id === 'needle' && h.signals.vectorRank !== null));
  assert.equal(store.setEmbedding('needle', 'needle3', [1, 0, 0]), false);
  assert.equal(store.setEmbedding('needle', 'needle3', [0, 1], undefined, 'wrong-hash'), false);
  assert.ok(store.getChunk('needle').embedded_at);
});

test('explicit remote selection falls back only to compatible stored Needle vectors, then lexical', async t => {
  const { store } = storeFor(t); put(store, 'needle', 'needle3', [1, 0], 'Exact memory of regression and cache reuse');
  const failed = remote(async () => { throw Error('outage'); });
  const e = configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'openrouter' }, { needle: local(), openrouter: failed });
  const result = await retrieveProjectMemory(store, 'memory regression', { embedder: e, rerank: false });
  assert.equal(failed.status().calls, 0, 'never embed a query when this remote space has no documents');
  assert.equal(result.stats.space, 'needle3'); assert.ok(result.stats.degraded.includes('compatible-local-fallback'));
  const lexical = await retrieveProjectMemory(store, 'regression', { embedder: configuredMemoryEmbedder({ PI_MEMORY_EMBEDDER: 'openrouter' }, { needle: local('needle3', async () => null), openrouter: failed }), rerank: false });
  assert.equal(lexical.hits[0].chunk.id, 'needle'); assert.equal(lexical.stats.vector, 0);
});

test('model switching backfills unchanged hashes in bounded resumable batches', async t => {
  const { store } = storeFor(t);
  for (let i = 0; i < 20; i++) put(store, `old${i}`);
  let calls = 0; const e = remote(async (_url, { body }) => { calls++; return response(JSON.parse(body).input.map(() => [0, 1, 1])); });
  const first = await reindexEmbeddings(store, e, { limit: 7 });
  assert.equal(first.embedded, 7); assert.equal(first.remaining, 13); assert.equal(calls, 1);
  const c = new AbortController(); c.abort();
  assert.equal((await reindexEmbeddings(store, e, { limit: 7, signal: c.signal })).cancelled, true);
  assert.equal(calls, 1);
  const next = await reindexEmbeddings(store, e, { limit: 20 });
  assert.equal(next.embedded, 13); assert.equal(next.remaining, 0); assert.equal(calls, 2);
  assert.equal((await reindexEmbeddings(store, e)).embedded, 0); assert.equal(calls, 2);
  assert.equal(store.counts().chunks, 20); assert.equal(store.embeddingSpaces().find(s => s.id === 'needle3').count, 0);
  const changed = remote(async (_url, { body }) => response(JSON.parse(body).input.map(() => [1, 0])), { model: 'other/model' });
  // A model echo must match the override, otherwise migration leaves old vectors intact.
  assert.equal((await reindexEmbeddings(store, changed)).embedded, 0);
  assert.equal(store.embeddingSpaces().find(s => s.id === e.id).count, 20);
});

test('persisted remote dimension mismatch falls back to compatible local vectors', async t => {
  const { store } = storeFor(t);
  const r = remote(async () => response([[1, 0, 0]]));
  put(store, 'remote', r.id, [1, 0]);
  put(store, 'local', 'needle3', [0, 1]);
  const result = await retrieveProjectMemory(store, 'earlier architectural constraints', {
    embedder: configuredMemoryEmbedder({}, { openrouter: r, needle: local() }), rerank: false,
  });
  assert.equal(result.stats.space, 'needle3');
  assert.ok(result.stats.degraded.includes('dimension-mismatch'));
  assert.ok(result.stats.degraded.includes('compatible-local-fallback'));
  assert.ok(result.hits.every(hit => hit.chunk.id !== 'remote' || hit.signals.vectorRank === null));
});

test('legacy secret paths cannot consume the bounded backfill allowance', async t => {
  const { store } = storeFor(t);
  store.upsertChunk({ id: 'secret', project_id: store.projectId, source_type: 'decision', source_path: '.env', importance: 1,
    text: 'A legacy configuration entry must stay local', content_hash: 'legacy-secret' });
  const durable = await remember(store, 'Durable public architectural constraints');
  const inputs = [];
  const r = remote(async (_url, { body }) => { inputs.push(...JSON.parse(body).input); return response([[1, 0]]); });
  const result = await reindexEmbeddings(store, r, { limit: 1 });
  assert.equal(result.embedded, 1); assert.equal(result.remaining, 0);
  assert.ok(inputs.every(text => !text.includes('legacy configuration')));
  assert.equal(store.getChunk('secret').has_embedding, false);
  await remember(store, 'A new configuration entry must also stay local', r, { path: 'credentials.json' });
  assert.equal(r.status().calls, 1);
  assert.equal(store.lexicalSearch('the a and of to with in is are for we our durable constraints')[0].id, durable.ids[0]);
});

test('interrupted migration resumes from the next incompatible chunk without redoing successful batches', async t => {
  const { store } = storeFor(t); for (let i = 0; i < 35; i++) put(store, `old${i}`);
  let calls = 0; const c = new AbortController();
  const e = remote(async (_url, { body }) => { calls++; if (calls === 2) c.abort(); return response(JSON.parse(body).input.map(() => [1, 1])); });
  const first = await reindexEmbeddings(store, e, { limit: 35, signal: c.signal });
  assert.equal(first.embedded, 16); assert.equal(first.remaining, 19); assert.equal(first.cancelled, true);
  assert.equal((await reindexEmbeddings(store, e, { limit: 35 })).embedded, 19);
  assert.equal(store.counts().chunks, 35);
});

test('unchanged file indexing backfills incompatible vectors but never repeats compatible embeddings', async t => {
  const { store } = storeFor(t); let calls = 0;
  const input = { path: 'src/route.ts', content: 'export const routeCache = new Map(); // preserve locality and bounded retries' };
  await indexFile(store, store.projectId, input, { embedder: local() });
  const e = remote(async (_url, { body }) => { calls++; return response(JSON.parse(body).input.map(() => [1, 1])); });
  const migrated = await indexFile(store, store.projectId, input, { embedder: e });
  assert.equal(migrated.skippedDup, 1); assert.equal(migrated.embedded, 1); assert.equal(calls, 1);
  await indexFile(store, store.projectId, input, { embedder: e }); assert.equal(calls, 1);
  assert.equal((await indexFile(store, store.projectId, { path: '.env', content: 'PASSWORD=very-secret-data' }, { embedder: e })).inserted, 0);
  await indexEvent(store, store.projectId, { kind: 'tool_result', text: 'Transient terminal output should remain lexical only' }, { embedder: e });
  assert.equal(calls, 1); assert.equal((await reindexEmbeddings(store, e)).embedded, 0);
});

test('family and role views share one query vector; exact identifiers skip embedding and reranking', async t => {
  const a = storeFor(t, 'a').store, b = storeFor(t, 'b').store;
  let calls = 0; const e = { id: 'test', embed: async texts => { calls++; return texts.map(() => [1, 0]); } };
  await remember(a, 'project_memory_reembed maintains migration progress', e, { sourceType: 'bug' });
  await remember(b, 'Reuse abstractions for coordinated architecture changes', e, { sourceType: 'architecture' });
  calls = 0; const family = [{ store: a, relation: 'self' }, { store: b, relation: 'ancestor' }];
  assert.equal((await retrieveFamily(family, 'coherent design coordination', { embedder: e, rerank: false })).hits.length, 2); assert.equal(calls, 1);
  calls = 0; const views = await retrieveFamilyViews(family, 'older lessons remembered indirectly', { embedder: e });
  assert.equal(calls, 1); assert.equal(views.observer[0].chunk.source_type, 'bug'); assert.equal(views.subagent[0].chunk.source_type, 'architecture');
  calls = 0; const exact = await retrieveFamily(family, 'project_memory_reembed', { embedder: e, rerank: { rank: async () => { throw Error('unnecessary rerank'); } } });
  assert.equal(calls, 0); assert.equal(exact.hits[0].chunk.source_type, 'bug');
});

test('consolidation uses compatible persisted vectors and never calls an embedding endpoint', async t => {
  const { store } = storeFor(t);
  put(store, 'a', 'needle3', [1, 0], 'Do not add another helper when this capability already exists');
  put(store, 'b', 'other/model', [1, 0], 'Always invent a parallel architecture regardless of current abstractions');
  let calls = 0;
  const found = await findClusters(store, { embedder: local('needle3', async () => { calls++; throw Error(); }) });
  assert.equal(calls, 0); assert.equal(found.clusters.length, 0);
});

test('schema v1 upgrades add metadata without rebuilding lexical state', t => {
  const { store, db } = storeFor(t); put(store, 'legacy'); store.close();
  const raw = new DatabaseSync(db); raw.exec("DROP TABLE embedding_spaces; ALTER TABLE chunks DROP COLUMN embedded_at; UPDATE meta SET value='1' WHERE key='schema_version'"); raw.close();
  const migrated = openProjectStore(db, { projectId: 'project' });
  assert.equal(migrated.lexicalSearch('historical')[0].id, 'legacy');
  assert.equal(migrated.embeddingSpaces()[0].backend, 'needle'); assert.ok(migrated.getChunk('legacy').embedded_at);
  migrated.close();
});

test('extension exposes status, controlled backfill, and session-scoped recall without service failure', async t => {
  const { dir } = storeFor(t); const hooks = new Map(), tools = new Map();
  const pi = { on: (name, fn) => hooks.set(name, fn), registerTool: def => tools.set(def.name, def), registerCommand() {} };
  const e = remote(async () => new Response('', { status: 503 }));
  piVectorMemory(pi, { env: { PI_PROJECTS_DIR: path.join(dir, 'projects') }, embedder: e });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => 'fixture' } };
  hooks.get('session_start')({}, ctx);
  const call = (name, params = {}) => tools.get(name).execute('t', params, undefined, undefined, ctx);
  const r = await call('project_memory_remember', { text: 'An architecture decision survived a remote provider outage', type: 'decision' });
  assert.equal(r.details.result.inserted, 1); assert.equal(r.details.result.embedded, 0);
  const status = await call('project_memory_status');
  assert.equal(status.details.health.lastError, 'http-503'); assert.equal(status.details.counts.chunks, 1);
  assert.match(status.content[0].text, /qwen\/qwen3-embedding-8b/); assert.match(status.content[0].text, /lexical retrieval: healthy/);
  assert.ok((await call('project_memory_search', { query: 'architecture decision' })).details.hits.length);
  assert.ok((await recallProjectContext(dir, 'architecture decision survived outage', 'observer')).includes('architecture decision'));
  const migrated = await call('project_memory_reembed', { limit: 2 }); assert.equal(migrated.details.embedded, 0);
  assert.ok(globalThis[PROJECT_MEMORY_RECALL]);
  hooks.get('session_shutdown')({}, ctx); await new Promise(r => setImmediate(r)); assert.equal(globalThis[PROJECT_MEMORY_RECALL], undefined);
});

test('embedding charges use the existing auxiliary ledger, including paid malformed responses', async () => {
  const receipts = [];
  let valid = true;
  const e = remote(async () => response(valid ? [[1, 0]] : [], undefined, { prompt_tokens: 10, cost: 0.000001 }), { accounting: () => row => receipts.push(row) });
  await e.embed(['first historical fact']); valid = false; await e.embed(['second historical fact']);
  assert.deepEqual(receipts.map(r => r.status), ['pending','completed','pending','failed']);
  const { collectAuxiliaryModelUsage } = await import('../agent/extensions/lib/cost-evidence.ts');
  const usage = collectAuxiliaryModelUsage(receipts.map(data => ({ type: 'custom', customType: 'auxiliary-model-usage-v1', data })));
  assert.equal(usage.rows.length, 2); assert.equal(usage.truncated, false);
  assert.equal(usage.rows.reduce((sum,r) => sum+r.tokens, 0), 20);
  assert.equal(usage.rows.reduce((sum,r) => sum+r.evidence.reported, 0), 0.000002);
});

test('session switches fence remote indexing and discard queued records from the previous project', async t => {
  const { dir } = storeFor(t); const projects = path.join(dir, 'projects');
  const a = path.join(dir,'a'), b = path.join(dir,'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a,'.pi-project-id'),'a'); fs.writeFileSync(path.join(b,'.pi-project-id'),'b');
  const hooks = new Map(), tools = new Map(); let release;
  const embedder = local('fixture', async () => new Promise(resolve => { release = () => resolve([[1,0]]); }));
  piVectorMemory({ on: (n,f) => hooks.set(n,f), registerTool: d => tools.set(d.name,d), registerCommand() {} }, { env: { PI_PROJECTS_DIR: projects }, embedder });
  const ctx = cwd => ({ cwd, sessionManager: { getSessionId: () => cwd } });
  hooks.get('session_start')({},ctx(a));
  hooks.get('input')({ source:'user', text:'Private project A historical decision' },ctx(a));
  hooks.get('input')({ source:'user', text:'Another queued project A request' },ctx(a));
  hooks.get('agent_settled')({},ctx(a));
  for(let i=0;i<30&&!release;i++) await new Promise(r=>setImmediate(r));
  hooks.get('session_switch')({},ctx(b)); release(); await new Promise(r=>setTimeout(r,5));
  const status = await tools.get('project_memory_status').execute('t',{},undefined,undefined,ctx(b));
  assert.equal(status.details.counts.chunks,0); assert.equal(status.details.queue,0);
  hooks.get('session_shutdown')({},ctx(b)); await new Promise(r=>setImmediate(r));
});

test('settled events persist lexical evidence before one shared embedding batch', async t => {
  const { dir } = storeFor(t), hooks = new Map(), tools = new Map(), calls = [];
  const cwd = path.join(dir, 'events'); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, '.pi-project-id'), 'events');
  let release;
  const e = local('fixture', async texts => { calls.push(texts); return new Promise(resolve => { release = () => resolve(texts.map(() => [1, 0])); }); });
  piVectorMemory({ on: (n,f) => hooks.set(n,f), registerTool: d => tools.set(d.name,d), registerCommand() {} }, { env: { PI_PROJECTS_DIR: path.join(dir,'projects') }, embedder:e });
  const ctx = { cwd, sessionManager: { getSessionId: () => 'events' } };
  hooks.get('session_start')({},ctx);
  for (const text of ['Remember the architectural boundary', 'Keep the regression fix in shared routing', 'Preserve earlier user corrections']) hooks.get('input')({source:'user',text},ctx);
  hooks.get('agent_settled')({},ctx);
  for (let i=0;i<30&&!release;i++) await new Promise(r=>setImmediate(r));
  const status = await tools.get('project_memory_status').execute('status',{},undefined,undefined,ctx);
  assert.equal(status.details.counts.chunks,3); assert.equal(status.details.counts.embedded,0);
  assert.equal(calls.length,1); assert.equal(calls[0].length,3);
  release(); await new Promise(r=>setImmediate(r));
  const after = await tools.get('project_memory_status').execute('status',{},undefined,undefined,ctx);
  assert.equal(after.details.counts.embedded,3);
  hooks.get('session_shutdown')({},ctx); await new Promise(r=>setImmediate(r));
});

test('Qwen query instructions are separate from document vectors and empty indexes make no requests', async t => {
  const { store } = storeFor(t); const inputs = [];
  const e = remote(async (_url,{body}) => { const b=JSON.parse(body); inputs.push(...b.input); return response(b.input.map(()=>[1,0])); });
  await retrieveProjectMemory(store,'Earlier architecture choices',{embedder:e,rerank:false}); assert.equal(inputs.length,0);
  await remember(store,'Reuse the existing project capability instead of making another subsystem',e);
  await retrieveProjectMemory(store,'Why are we duplicating another architecture layer?',{embedder:e,rerank:false});
  assert.ok(!inputs[0].startsWith('Instruct:')); assert.match(inputs[1],/^Instruct:.*\nQuery: /);
  const count=inputs.length; await retrieveProjectMemory(store,'Why are we duplicating another architecture layer?',{embedder:e,rerank:false}); assert.equal(inputs.length,count);
});
