import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  findDescendantProjects,
  findExplicitId,
  findMarkerRoot,
  findProjectAnchors,
  findRepoRoot,
  gitOriginUrl,
  normalizeRemoteUrl,
  projectDbPath,
  projectsDir,
  resolveProjectChain,
  resolveProjectIdentity,
} from '../agent/extensions/lib/project-identity.ts';
import {
  openProjectStore,
  isChunkType,
} from '../agent/extensions/lib/project-vector-store.ts';
import {
  chunkCode,
  chunkMarkdown,
  chunkText,
  chunkerForPath,
  contentHash,
  extractConcepts,
  indexEvent,
  indexFile,
  redactSecrets,
  reindexEmbeddings,
  testEmbedder,
  TYPE_WEIGHTS,
} from '../agent/extensions/lib/project-memory-index.ts';
import {
  consolidate,
  findClusters,
  formatConsolidateReport,
} from '../agent/extensions/lib/project-memory-consolidate.ts';
import {
  FAMILY_WEIGHTS,
  formatFamilyHits,
  formatMemoryHits,
  retrieveFamily,
  retrieveProjectMemory,
  ROLE_POLICIES,
} from '../agent/extensions/lib/project-memory-retrieve.ts';
import piVectorMemory from '../agent/extensions/pi-vector-memory.ts';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-'));
const cleanup = (t, dir) => t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const testEnv = (dir) => ({ PI_PROJECTS_DIR: path.join(dir, 'projects') });
const waitFor = async (ready, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for async flush');
};

// ---------------------------------------------------------------------------
// project identity
// ---------------------------------------------------------------------------

test('explicit .pi-project-id wins and is stable', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, '.pi-project-id'), 'my-project\n');
  const env = testEnv(dir);
  const first = resolveProjectIdentity(work, {}, env);
  assert.equal(first.id, 'my-project');
  assert.equal(first.basis, 'explicit');
  const second = resolveProjectIdentity(work, {}, env);
  assert.equal(second.id, 'my-project');
  assert.ok(fs.existsSync(path.join(env.PI_PROJECTS_DIR, 'registry.json')));
});

test('explicit id is found walking up; invalid ids are ignored', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const nested = path.join(dir, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(dir, '.pi-project-id'), 'not a valid id!!\n');
  assert.equal(findExplicitId(nested), undefined);
  fs.writeFileSync(path.join(dir, 'a', '.pi-project-id'), 'nested-proj\n');
  assert.deepEqual(findExplicitId(nested), { id: 'nested-proj', dir: path.join(dir, 'a') });
  // Symlinked id files are refused.
  fs.renameSync(path.join(dir, 'a', '.pi-project-id'), path.join(dir, 'target'));
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'a', '.pi-project-id'));
  assert.equal(findExplicitId(nested), undefined);
});

test('git remote identity is stable across URL spellings', (t) => {
  assert.equal(
    normalizeRemoteUrl('git@github.com:YunusEmreJr/yunuspi.git'),
    normalizeRemoteUrl('https://github.com/yunusemrejr/yunuspi'),
  );
  assert.equal(
    normalizeRemoteUrl('https://github.com/yunusemrejr/yunuspi.git'),
    'github.com/yunusemrejr/yunuspi',
  );
  assert.equal(
    normalizeRemoteUrl('ssh://git@github.com:22/yunusemrejr/yunuspi.git'),
    'github.com/yunusemrejr/yunuspi',
  );
  const dir = tmpRoot();
  cleanup(t, dir);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/demo.git'], { cwd: repo });
  const env = testEnv(dir);
  // Walk-up works even for not-yet-created paths (deleted cwd, planned dirs).
  assert.equal(findRepoRoot(path.join(repo, 'sub')), repo);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  assert.equal(findRepoRoot(path.join(repo, 'sub')), repo);
  assert.equal(gitOriginUrl(repo, env), 'git@github.com:example/demo.git');
  const first = resolveProjectIdentity(path.join(repo, 'sub'), {}, env);
  assert.equal(first.basis, 'git-remote');
  assert.match(first.id, /^prj_[0-9a-f]{12}$/);
  const second = resolveProjectIdentity(repo, {}, env);
  assert.equal(second.id, first.id);
  assert.equal(projectsDir(env), env.PI_PROJECTS_DIR);
  assert.equal(projectDbPath(first, env), path.join(env.PI_PROJECTS_DIR, first.id, 'memory.sqlite'));
});

test('generated identity auto-writes and travels with the directory', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const work = path.join(dir, 'nomad');
  fs.mkdirSync(work, { recursive: true });
  const env = testEnv(dir);
  const first = resolveProjectIdentity(work, {}, env);
  // Auto-write persists the generated id, so the creating call already
  // reports the explicit identity every later call will see.
  assert.equal(first.basis, 'explicit');
  assert.match(first.id, /^prj_[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(path.join(work, '.pi-project-id')));
  assert.equal(fs.readFileSync(path.join(work, '.pi-project-id'), 'utf-8').trim(), first.id);
  // A "move" (copy) keeps the identity via the written file.
  const moved = path.join(dir, 'moved');
  fs.cpSync(work, moved, { recursive: true });
  const second = resolveProjectIdentity(moved, {}, env);
  assert.equal(second.id, first.id);
  assert.equal(second.basis, 'explicit');
});

test('disabled auto-write still aliases the real path in the registry', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const work = path.join(dir, 'w');
  fs.mkdirSync(work, { recursive: true });
  const env = { ...testEnv(dir), PI_PROJECT_ID_AUTO: 'off' };
  const first = resolveProjectIdentity(work, {}, env);
  assert.equal(first.basis, 'generated');
  assert.ok(!fs.existsSync(path.join(work, '.pi-project-id')));
  const second = resolveProjectIdentity(work, {}, env);
  assert.equal(second.id, first.id);
});

// ---------------------------------------------------------------------------
// vector store
// ---------------------------------------------------------------------------

const openTestStore = (dir, projectId = 'prj_test') =>
  openProjectStore(path.join(dir, 'projects', projectId, 'memory.sqlite'), { projectId });

test('store round-trips chunks with full metadata', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.counts(), { chunks: 0, embedded: 0, tombstoned: 0, types: {} });
  const outcome = store.upsertChunk({
    id: 'mem_1',
    project_id: 'prj_test',
    session_id: 'sess_a',
    source_type: 'decision',
    source_path: 'src/router.ts',
    source_start: 10,
    source_end: 20,
    title: 'Use JEV reranking',
    text: 'We decided to rerank observer suggestions with JEV margins.',
    timestamp: '2026-09-25T13:42:00.000Z',
    valid_from: '2026-09-25T13:42:00.000Z',
    commit_sha: 'abc123',
    concepts: ['observer', 'routing'],
    importance: 0.88,
    confidence: 0.95,
    authority: 0.9,
    supersedes: ['mem_old'],
    content_hash: 'hash1',
    embedder: 'test-hash',
    embedding: [1, 0, 0],
  });
  assert.equal(outcome, 'inserted');
  const chunk = store.getChunk('mem_1');
  assert.equal(chunk.source_type, 'decision');
  assert.equal(chunk.source_path, 'src/router.ts');
  assert.deepEqual(chunk.concepts, ['observer', 'routing']);
  assert.equal(chunk.authority, 0.9);
  assert.equal(chunk.has_embedding, true);
  assert.equal(store.getMeta('project_id'), 'prj_test');
  // Duplicate content hash under another id is refused.
  assert.equal(store.upsertChunk({
    id: 'mem_2', project_id: 'prj_test', source_type: 'decision',
    text: 'other text', content_hash: 'hash1',
  }), 'duplicate');
  assert.equal(isChunkType('decision'), true);
  assert.equal(isChunkType('nope'), false);
});

test('lexical search finds exact identifiers; unknown words find nothing', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir);
  t.after(() => store.close());
  store.upsertChunk({
    id: 'mem_code', project_id: 'prj_test', source_type: 'code',
    source_path: 'src/observer/router.ts', title: 'router',
    text: 'ObserverBook routeConfidence scoring with JEVMargin thresholds',
    content_hash: 'h-code',
  });
  store.upsertChunk({
    id: 'mem_other', project_id: 'prj_test', source_type: 'decision',
    text: 'Unrelated note about quarterly planning cadence',
    content_hash: 'h-other',
  });
  const hits = store.lexicalSearch('ObserverBook routeConfidence');
  assert.equal(hits[0].id, 'mem_code');
  assert.deepEqual(store.lexicalSearch('zxqvqwplm'), []);
  assert.deepEqual(store.lexicalSearch('a'), []);
});

test('vector search ranks cosine neighbors; dim mismatches are skipped', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir);
  t.after(() => store.close());
  store.upsertChunk({ id: 'a', project_id: 'p', source_type: 'concept', text: 't', content_hash: 'ha', embedder: 't', embedding: [1, 0] });
  store.upsertChunk({ id: 'b', project_id: 'p', source_type: 'concept', text: 't', content_hash: 'hb', embedder: 't', embedding: [0, 1] });
  store.upsertChunk({ id: 'c', project_id: 'p', source_type: 'concept', text: 't', content_hash: 'hc', embedder: 't', embedding: [1, 1, 1] });
  const hits = store.vectorSearch([1, 0], { embedder: 't', limit: 5 });
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b']);
  assert.ok(hits[0].score > 0.99);
  assert.deepEqual(store.vectorSearch([0, 0]), []);
});

test('tombstone, restore, supersede and authority are provenance-preserving', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir);
  t.after(() => store.close());
  store.upsertChunk({ id: 'old', project_id: 'p', source_type: 'concept', text: 'Observer uses X', content_hash: 'h1' });
  store.upsertChunk({ id: 'new', project_id: 'p', source_type: 'concept', text: 'Observer uses Y', content_hash: 'h2' });
  assert.equal(store.tombstone('old', '2026-09-26T00:00:00.000Z'), true);
  assert.equal(store.getChunk('old').valid_until, '2026-09-26T00:00:00.000Z');
  assert.equal(store.restore('old'), true);
  assert.equal(store.getChunk('old').valid_until, null);
  assert.equal(store.markSuperseded('old', 'new'), true);
  assert.equal(store.getChunk('old').superseded_by, 'new');
  assert.equal(store.setAuthority('new', 1.0), true);
  assert.equal(store.addSupersedes('new', ['old']), true);
  assert.deepEqual(store.getChunk('new').supersedes, ['old']);
  assert.equal(store.counts().tombstoned, 1);
  assert.equal(store.tombstone('missing'), false);
});

test('store persists across reopen; unembedded ids backfill', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const dbPath = path.join(dir, 'projects', 'prj_x', 'memory.sqlite');
  const first = openProjectStore(dbPath, { projectId: 'prj_x' });
  first.upsertChunk({ id: 'k', project_id: 'prj_x', source_type: 'todo', text: 'persist me', content_hash: 'hk' });
  first.close();
  const second = openProjectStore(dbPath, { projectId: 'prj_x' });
  t.after(() => second.close());
  assert.equal(second.getChunk('k').text, 'persist me');
  assert.deepEqual(second.unembeddedIds(), ['k']);
  assert.equal(second.setEmbedding('k', 'test-hash', [0.5, 0.5]), true);
  assert.deepEqual(second.unembeddedIds(), []);
  assert.deepEqual(second.embeddingDims(), [{ dim: 2, n: 1 }]);
});

// ---------------------------------------------------------------------------
// indexer
// ---------------------------------------------------------------------------

test('chunkers split markdown, code and text within budgets', () => {
  const md = '# Title\n\nFirst paragraph here.\n\n## Second\n\n- item one two three\n- item four five six\n';
  const mdChunks = chunkMarkdown(md);
  assert.ok(mdChunks.length >= 2);
  assert.equal(mdChunks[0].title, 'Title');
  assert.ok(mdChunks.every((c) => c.text.length <= 2000));
  const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}; // padding padding`).join('\n');
  const codeChunks = chunkCode(code, { windowLines: 80, overlapLines: 12 });
  assert.ok(codeChunks.length >= 2);
  assert.ok(codeChunks[0].end - codeChunks[1].start >= 10);
  assert.ok(codeChunks.every((c) => c.text.length <= 4000));
  const long = `${'lorem ipsum dolor sit amet. '}\n\n${'x'.repeat(5000)}`;
  assert.ok(chunkText(long, 1000).every((c) => c.text.length <= 1000));
  assert.equal(chunkerForPath('README.md'), 'markdown');
  assert.equal(chunkerForPath('src/a.ts'), 'code');
  assert.equal(chunkerForPath('notes.txt'), 'text');
});

test('concept extraction and secret redaction', () => {
  const concepts = extractConcepts('Fix #routing for [[Observer Book]] in `src/router.ts`; see RouteConfidence and route_confidence.', 'src/router.ts');
  assert.ok(concepts.includes('#routing') || concepts.includes('routing'));
  assert.ok(concepts.includes('Observer Book'));
  assert.ok(concepts.includes('RouteConfidence'));
  assert.ok(concepts.includes('route_confidence'));
  assert.ok(concepts.includes('router.ts'));
  // Token fixtures stay concatenated so the public-source scanner never sees a literal.
  const ghp = 'ghp_' + 'abcdefghijklmnopqrst0123456789';
  const akia = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const redacted = redactSecrets(`key=${ghp} and ${akia} ok`);
  assert.ok(!redacted.includes(ghp.slice(0, 12)));
  assert.ok(!redacted.includes(akia.slice(0, 8)));
  assert.ok(redacted.includes('[redacted]'));
  assert.equal(contentHash('decision', 'Hello  World'), contentHash('decision', 'hello world'));
  assert.notEqual(contentHash('decision', 'hello world'), contentHash('code', 'hello world'));
});

test('indexEvent dedups by content hash; embedder failure stores lexical-only', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_ev');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const event = { kind: 'decision', sessionId: 's1', title: 'Pick SQLite', text: 'We will store project memory in per-project SQLite files.' };
  const first = await indexEvent(store, 'prj_ev', event, { embedder });
  assert.equal(first.inserted, 1);
  assert.equal(first.embedded, 1);
  const second = await indexEvent(store, 'prj_ev', event, { embedder });
  assert.equal(second.inserted, 0);
  assert.equal(second.skippedDup, 1);
  const failing = { id: 'broken', embed: async () => { throw new Error('down'); } };
  const third = await indexEvent(store, 'prj_ev', { kind: 'observation', sessionId: 's1', text: 'The embedder went down but the note survived intact.' }, { embedder: failing });
  assert.equal(third.inserted, 1);
  assert.equal(third.embedded, 0);
  assert.equal((await indexEvent(store, 'prj_ev', { kind: 'user_prompt', text: 'short' }, { embedder })).inserted, 0);
  assert.ok(TYPE_WEIGHTS.decision > TYPE_WEIGHTS.tool_result);
});

test('indexFile embeds only hash-changed chunks', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_file');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const content = ['# Guide', '', 'Alpha paragraph with enough words to form a chunk.', '', '## Part', '', 'Beta paragraph with enough words to form a chunk.'].join('\n');
  const first = await indexFile(store, 'prj_file', { path: 'docs/guide.md', content }, { embedder });
  assert.ok(first.inserted >= 2);
  const second = await indexFile(store, 'prj_file', { path: 'docs/guide.md', content }, { embedder });
  assert.equal(second.inserted, 0);
  assert.ok(second.skippedDup >= 2);
  const changed = content.replace('Beta paragraph', 'Gamma paragraph replacement text');
  const third = await indexFile(store, 'prj_file', { path: 'docs/guide.md', content: changed }, { embedder });
  assert.equal(third.inserted, 1);
  assert.ok(third.skippedDup >= 1);
  const backfill = await reindexEmbeddings(store, embedder);
  assert.equal(backfill.embedded + backfill.failed, store.unembeddedIds(5000).length + backfill.embedded);
});

// ---------------------------------------------------------------------------
// retrieval
// ---------------------------------------------------------------------------

const seedRecallCorpus = async (store, projectId, embedder) => {
  await indexEvent(store, projectId, { kind: 'decision', sessionId: 'a', title: 'JEV rerank', text: 'JEV reranking was introduced for observer suggestions before display.' }, { embedder });
  await indexEvent(store, projectId, { kind: 'observation', sessionId: 'a', title: 'Recursion bug', text: 'Previous bug: the observer recursively triggered itself via its own advice.' }, { embedder });
  await indexEvent(store, projectId, { kind: 'tool_result', sessionId: 'a', title: 'ls output', text: 'total 4096 drwxr-xr-x bin boot dev etc home lib media mnt opt proc root run srv sys tmp usr var' }, { embedder });
};

test('hybrid retrieval recalls decisions and bugs over raw exhaust', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_ret');
  t.after(() => store.close());
  const embedder = testEmbedder(32);
  await seedRecallCorpus(store, 'prj_ret', embedder);
  const result = await retrieveProjectMemory(store, 'observer suggestions reranking architecture', { embedder, rerank: false });
  assert.ok(result.hits.length >= 2);
  assert.equal(result.hits[0].chunk.source_type, 'decision');
  assert.ok(result.stats.vector > 0);
  const formatted = formatMemoryHits(result.hits);
  assert.ok(formatted.includes('untrusted'));
  assert.ok(formatted.includes('[mem_'));
  assert.equal(formatMemoryHits([]).includes('No project memories matched'), true);
});

test('role policies re-rank identical evidence; observer prefers mistakes', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_role');
  t.after(() => store.close());
  const at = '2026-09-25T10:00:00.000Z';
  await indexEvent(store, 'prj_role', {
    kind: 'tool_result', sourceType: 'code', sessionId: 's', timestamp: at, importance: 0.5,
    text: 'zebracache quuxsync zebracache quuxsync implementation detail here',
  });
  await indexEvent(store, 'prj_role', {
    kind: 'tool_result', sourceType: 'todo', sessionId: 's', timestamp: at, importance: 0.5,
    text: 'zebracache quuxsync follow-up task noted',
  });
  const query = 'zebracache quuxsync';
  const main = await retrieveProjectMemory(store, query, { role: 'main', rerank: false });
  const observer = await retrieveProjectMemory(store, query, { role: 'observer', rerank: false });
  assert.equal(main.hits[0].chunk.source_type, 'code');
  // Same evidence, different policy: observer boosts todos over code.
  const subagent = await retrieveProjectMemory(store, query, { role: 'subagent', rerank: false });
  assert.equal(subagent.hits[0].chunk.source_type, 'code');
  assert.equal(observer.hits[0].chunk.source_type, 'todo');
  assert.ok(ROLE_POLICIES.observer.typeBoost.error > 1);
  assert.ok(ROLE_POLICIES.watchmaker.recencyHalfLifeDays < ROLE_POLICIES.observer.recencyHalfLifeDays);
});

test('observer role surfaces errors above session chatter', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_obs');
  t.after(() => store.close());
  const at = '2026-09-25T10:00:00.000Z';
  await indexEvent(store, 'prj_obs', { kind: 'error', sessionId: 's', timestamp: at, importance: 0.5, text: 'wobblefix crash: null route confidence in rerank path' });
  await indexEvent(store, 'prj_obs', { kind: 'user_prompt', sessionId: 's', timestamp: at, importance: 0.5, text: 'wobblefix rerank path question from the user here' });
  const observer = await retrieveProjectMemory(store, 'wobblefix rerank path', { role: 'observer', rerank: false });
  assert.equal(observer.hits[0].chunk.source_type, 'error');
});

test('temporal filters, superseded demotion and validation', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_tmp');
  t.after(() => store.close());
  const live = await indexEvent(store, 'prj_tmp', { kind: 'observation', sessionId: 's', timestamp: '2026-09-25T10:00:00.000Z', text: 'bramblethorn current fact about the build' });
  const stale = await indexEvent(store, 'prj_tmp', { kind: 'observation', sessionId: 's', timestamp: '2026-09-20T10:00:00.000Z', text: 'bramblethorn older fact about the build' });
  store.markSuperseded(stale.ids[0], live.ids[0], '2026-09-25T11:00:00.000Z');
  const ranked = await retrieveProjectMemory(store, 'bramblethorn build', { rerank: false });
  assert.equal(ranked.hits[0].chunk.id, live.ids[0]);
  const since = await retrieveProjectMemory(store, 'bramblethorn build', { since: '2026-09-24T00:00:00.000Z', rerank: false, includeSuperseded: true });
  assert.ok(since.hits.every((h) => h.chunk.timestamp >= '2026-09-24T00:00:00.000Z'));
  const typed = await retrieveProjectMemory(store, 'bramblethorn build', { types: ['decision'], rerank: false });
  assert.deepEqual(typed.hits, []);
  await assert.rejects(() => retrieveProjectMemory(store, 'ab', { rerank: false }), /3–512/);
  const degraded = await retrieveProjectMemory(store, 'bramblethorn build', { rerank: false });
  assert.equal(degraded.stats.semanticSkipped, 'no-indexed-vectors');
});

// ---------------------------------------------------------------------------
// consolidation
// ---------------------------------------------------------------------------

test('consolidation clusters near-duplicates and ratifies a canonical fact', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_con');
  t.after(() => store.close());
  await indexEvent(store, 'prj_con', { kind: 'observation', sessionId: 's', concepts: ['gizmo'], text: 'The gizmo cache lives in memory and expires after one hour of idle time.' });
  await indexEvent(store, 'prj_con', { kind: 'observation', sessionId: 's', concepts: ['gizmo'], text: 'The gizmo cache lives in memory, expiring after one hour of idle time.' });
  await indexEvent(store, 'prj_con', { kind: 'observation', sessionId: 's', concepts: ['gizmo'], text: 'Gizmo cache lives in memory and expires after one idle hour.' });
  await indexEvent(store, 'prj_con', { kind: 'decision', sessionId: 's', concepts: ['deploy'], text: 'Deployments go out on Thursdays after the integration suite passes.' });
  const found = await findClusters(store, {});
  assert.equal(found.clusters.length, 1);
  assert.equal(found.clusters[0].ids.length, 3);
  const dry = consolidate(store, found.clusters, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(store.getChunk(found.clusters[0].ids[1]).valid_until, null);
  assert.ok(formatConsolidateReport({ ...dry, scanned: found.scanned }).includes('DRY RUN'));
  const applied = consolidate(store, found.clusters, { dryRun: false });
  assert.equal(applied.superseded.length, 2);
  const canonical = store.getChunk(applied.canonicalized[0]);
  assert.equal(canonical.authority, 1.0);
  assert.deepEqual([...canonical.supersedes].sort(), [...applied.superseded].sort());
  for (const id of applied.superseded) {
    assert.equal(store.getChunk(id).superseded_by, canonical.id);
  }
  assert.ok(formatConsolidateReport({ ...applied, scanned: found.scanned }).includes('APPLIED'));
});

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

const fakePi = () => {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  return {
    tools,
    commands,
    handlers,
    registerTool: (def) => void tools.set(def.name, def),
    registerCommand: (name, def) => void commands.set(name, def),
    on: (name, fn) => void handlers.set(name, fn),
  };
};

const fakeCtx = (cwd) => ({ cwd, hasUI: false, sessionManager: { getSessionId: () => 'sess_test' } });

test('extension registers tools, remembers, searches, forgets and restores', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  for (const name of ['project_memory_search', 'project_memory_remember', 'project_memory_status', 'project_memory_index_path', 'project_memory_forget', 'project_memory_restore', 'project_memory_consolidate']) {
    assert.ok(pi.tools.has(name), `registers ${name}`);
  }
  assert.ok(pi.commands.has('project-memory'));
  const ctx = fakeCtx(cwd);
  const status = await pi.tools.get('project_memory_status').execute('1', {}, undefined, undefined, ctx);
  assert.ok(status.content[0].text.includes('prj_'));
  const remember = await pi.tools.get('project_memory_remember').execute('2', {
    text: 'Quasar routing decisions are recorded in the observer book margins.',
    type: 'decision',
  }, undefined, undefined, ctx);
  const rememberedId = remember.details.id;
  assert.match(rememberedId, /^mem_/);
  const search = await pi.tools.get('project_memory_search').execute('3', { query: 'Quasar routing observer book' }, undefined, undefined, ctx);
  assert.ok(search.content[0].text.includes('Quasar routing'));
  const forget = await pi.tools.get('project_memory_forget').execute('4', { id: rememberedId }, undefined, undefined, ctx);
  assert.equal(forget.details.forgotten, true);
  const restore = await pi.tools.get('project_memory_restore').execute('5', { id: rememberedId }, undefined, undefined, ctx);
  assert.equal(restore.details.restored, true);
  const consolidateDry = await pi.tools.get('project_memory_consolidate').execute('6', { dry_run: true }, undefined, undefined, ctx);
  assert.ok(consolidateDry.content[0].text.includes('DRY RUN'));
  await assert.rejects(() => pi.tools.get('project_memory_search').execute('7', { query: 'Quasar', role: 'nope' }, undefined, undefined, ctx), /Unknown role/);
  await assert.rejects(() => pi.tools.get('project_memory_search').execute('8', { query: 'ab' }, undefined, undefined, ctx), /3–512/);
});

test('extension indexes files and session events incrementally', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'app.ts'), 'export const nebulaFactor = 42;\n'.repeat(10));
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  const ctx = fakeCtx(cwd);
  pi.handlers.get('session_start')({}, ctx);
  const indexed = await pi.tools.get('project_memory_index_path').execute('1', { path: 'app.ts' }, undefined, undefined, ctx);
  assert.ok(indexed.details.result.inserted >= 1);
  await assert.rejects(() => pi.tools.get('project_memory_index_path').execute('2', { path: 'missing.ts' }, undefined, undefined, ctx), /not found/);
  // User prompt + error + edit + commit flow through the queue on settle.
  pi.handlers.get('input')({ source: 'user', text: 'Please fix the nebula calibration drift today' }, ctx);
  pi.handlers.get('input')({ source: 'user', text: '/project-memory' }, ctx); // slash commands are skipped
  pi.handlers.get('tool_call')({ toolCallId: 'c1', toolName: 'bash', input: { command: 'npm test' } });
  pi.handlers.get('tool_result')({ toolCallId: 'c1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'nebula calibration failed: 3 tests red' }] }, ctx);
  pi.handlers.get('tool_call')({ toolCallId: 'c2', toolName: 'edit', input: { path: 'app.ts' } });
  pi.handlers.get('tool_result')({ toolCallId: 'c2', toolName: 'edit', content: [{ type: 'text', text: 'ok' }] }, ctx);
  pi.handlers.get('tool_call')({ toolCallId: 'c3', toolName: 'bash', input: { command: 'git commit -m nebula' } });
  pi.handlers.get('tool_result')({ toolCallId: 'c3', toolName: 'bash', content: [{ type: 'text', text: '[main abc1234] nebula' }] }, ctx);
  pi.handlers.get('session_compact')({ summary: 'Session summary: nebula calibration work finished with all tests green and docs updated.' }, ctx);
  await pi.handlers.get('agent_settled')({}, ctx);
  const search = async (query) => pi.tools.get('project_memory_search').execute('x', { query, limit: 10 }, undefined, undefined, ctx);
  await waitFor(async () => (await search('nebula calibration drift')).content[0].text.includes('drift'));
  const kinds = (await search('nebula')).details.hits;
  assert.ok(kinds.length >= 4, `expected queued events to flush, got ${kinds.length}`);
  const command = await pi.commands.get('project-memory').handler([], ctx);
  assert.match(command, /chunks/i);
});

test('a session switch drains the old queue into the old project, not the void', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwdA = path.join(dir, 'projA');
  const cwdB = path.join(dir, 'projB');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  const ctxA = fakeCtx(cwdA);
  const ctxB = fakeCtx(cwdB);
  pi.handlers.get('session_start')({}, ctxA);
  pi.handlers.get('input')({ source: 'user', text: 'Please fix the nebula calibration drift today' }, ctxA);
  pi.handlers.get('tool_call')({ toolCallId: 'e1', toolName: 'bash', input: { command: 'npm test' } });
  pi.handlers.get('tool_result')({ toolCallId: 'e1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'nebula calibration failed: 3 tests red' }] }, ctxA);
  // Switch before any flush: the old code void-flushed and then cleared the
  // queue, destroying both events.
  pi.handlers.get('session_switch')({}, ctxB);
  const search = (ctx, query) => pi.tools.get('project_memory_search').execute('x', { query, limit: 10 }, undefined, undefined, ctx);
  await waitFor(async () => (await search(ctxA, 'nebula calibration drift')).content[0].text.includes('drift'));
  const hitsA = (await search(ctxA, 'nebula')).details.hits;
  assert.ok(hitsA.length >= 2, `expected both old-project events to survive the switch, got ${hitsA.length}`);
  const hitsB = (await search(ctxB, 'nebula')).details.hits;
  assert.equal(hitsB.length, 0, 'old-project events must not be misfiled into the new project');
});

test('a full queue sheds file-edit markers before continuity evidence and reports drops', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  const ctx = fakeCtx(cwd);
  pi.handlers.get('session_start')({}, ctx);
  for (let i = 0; i < 201; i++) {
    pi.handlers.get('tool_call')({ toolCallId: `f${i}`, toolName: 'edit', input: { path: `file-${i}.ts` } });
    pi.handlers.get('tool_result')({ toolCallId: `f${i}`, toolName: 'edit', content: [{ type: 'text', text: 'ok' }] }, ctx);
  }
  pi.handlers.get('session_compact')({ summary: 'Session summary: quasar routing work finished with the nebula ledger verified end to end.' }, ctx);
  const status = () => pi.tools.get('project_memory_status').execute('s', {}, undefined, undefined, ctx);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 60; i++) {
    if ((await status()).details.queue === 0) break;
    await pi.handlers.get('agent_settled')({}, ctx);
    await sleep(25);
  }
  const final = await status();
  assert.equal(final.details.queue, 0);
  assert.equal(final.details.dropped, 2, 'one edit at fill plus one edit displaced by the summary');
  assert.deepEqual(final.details.droppedByKind, { file_edit: 2 });
  assert.match(final.content[0].text, /dropped: 2/);
  const search = await pi.tools.get('project_memory_search').execute('x', { query: 'quasar routing nebula ledger', limit: 10 }, undefined, undefined, ctx);
  assert.ok(search.content[0].text.includes('quasar routing'), 'the high-priority summary survives the burst');
});

test('children search and read only; PI_PROJECT_MEMORY=off disables all', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const child = fakePi();
  piVectorMemory(child, { env: { ...testEnv(dir), PI_SUBAGENT_CHILD: '1' }, embedder: testEmbedder(8) });
  assert.deepEqual([...child.tools.keys()].sort(), ['project_memory_search', 'project_memory_status']);
  assert.deepEqual([...child.handlers.keys()].sort(), ['session_shutdown', 'session_start']);
  const off = fakePi();
  piVectorMemory(off, { env: { ...testEnv(dir), PI_PROJECT_MEMORY: 'off' }, embedder: testEmbedder(8) });
  assert.equal(off.tools.size, 0);
  assert.equal(off.commands.size, 0);
  assert.equal(off.handlers.size, 0);
});

test('extension survives a missing git binary and odd event shapes', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const pi = fakePi();
  piVectorMemory(pi, { env: { ...testEnv(dir), PI_PROJECT_ID_GIT: 'off' }, embedder: null });
  const ctx = fakeCtx(cwd);
  pi.handlers.get('session_start')({}, ctx);
  for (const event of [undefined, {}, { source: 'extension' }, { source: 'user' }, { source: 'user', text: 42 }]) {
    pi.handlers.get('input')(event, ctx);
  }
  pi.handlers.get('tool_result')({ bogus: true }, ctx);
  pi.handlers.get('session_compact')({}, ctx);
  await pi.handlers.get('agent_settled')({}, ctx);
  const status = await pi.tools.get('project_memory_status').execute('1', {}, undefined, undefined, ctx);
  assert.ok(status.content[0].text.includes('prj_'));
});

// ---------------------------------------------------------------------------
// nesting: chains, families, robustness
// ---------------------------------------------------------------------------

test('nested explicit ids chain; every location in a project shares its DB', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const big = path.join(dir, 'big');
  const sub = path.join(big, 'sub');
  const deep = path.join(sub, 'deep', 'deeper');
  const other = path.join(big, 'other');
  for (const d of [deep, other]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(big, '.pi-project-id'), 'nest-parent\n');
  fs.writeFileSync(path.join(sub, '.pi-project-id'), 'nest-child\n');
  const env = testEnv(dir);
  const fromDeep = resolveProjectChain(deep, {}, env);
  assert.deepEqual(fromDeep.map((l) => l.identity.id), ['nest-child', 'nest-parent']);
  assert.equal(fromDeep[0].root, sub);
  assert.equal(fromDeep[1].root, big);
  assert.deepEqual(resolveProjectChain(other, {}, env).map((l) => l.identity.id), ['nest-parent']);
  assert.deepEqual(resolveProjectChain(big, {}, env).map((l) => l.identity.id), ['nest-parent']);
  // Same DB file from the sub root and from deep inside it.
  assert.equal(projectDbPath(resolveProjectIdentity(deep, {}, env), env), projectDbPath(resolveProjectIdentity(sub, {}, env), env));
  assert.equal(resolveProjectIdentity(deep, {}, env).basis, 'explicit');
});

test('repeated explicit ids collapse; anchors list nearest-first', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const big = path.join(dir, 'big');
  const sub = path.join(big, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(big, '.pi-project-id'), 'dup-proj\n');
  fs.writeFileSync(path.join(sub, '.pi-project-id'), 'dup-proj\n');
  const env = testEnv(dir);
  const anchors = findProjectAnchors(sub, env);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].dir, sub);
  assert.equal(anchors[1].dir, big);
  const chain = resolveProjectChain(sub, {}, env);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].identity.id, 'dup-proj');
});

test('nested git repos chain with distinct remotes', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const outer = path.join(dir, 'outer');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: outer });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/outer.git'], { cwd: outer });
  execFileSync('git', ['init', '-q'], { cwd: inner });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/inner.git'], { cwd: inner });
  const env = testEnv(dir);
  const chain = resolveProjectChain(inner, {}, env);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].root, inner);
  assert.equal(chain[1].root, outer);
  assert.equal(chain[0].identity.basis, 'git-remote');
  assert.notEqual(chain[0].identity.id, chain[1].identity.id);
  assert.equal(resolveProjectChain(outer, {}, env).length, 1);
});

test('explicit id cross-links its git remote so clones share the project', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const repo1 = path.join(dir, 'repo1');
  const repo2 = path.join(dir, 'repo2');
  for (const d of [repo1, repo2]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/shared.git'], { cwd: d });
  }
  fs.writeFileSync(path.join(repo1, '.pi-project-id'), 'crosslink-proj\n');
  const env = testEnv(dir);
  assert.equal(resolveProjectIdentity(repo1, {}, env).id, 'crosslink-proj');
  const clone = resolveProjectIdentity(repo2, {}, env);
  assert.equal(clone.id, 'crosslink-proj');
  assert.equal(clone.basis, 'explicit');
});

test('marker-anchored generated identity converges across subdirs', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const big = path.join(dir, 'big');
  const sub1 = path.join(big, 'sub1');
  const sub2 = path.join(big, 'sub2');
  for (const d of [sub1, sub2]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(big, 'package.json'), '{"name":"big"}\n');
  assert.equal(findMarkerRoot(sub1), big);
  const off = { ...testEnv(dir), PI_PROJECT_ID_AUTO: 'off' };
  const first = resolveProjectIdentity(sub1, {}, off);
  const second = resolveProjectIdentity(sub2, {}, off);
  assert.equal(first.id, second.id);
  assert.ok(!fs.existsSync(path.join(big, '.pi-project-id')));
  // With auto-write the id file lands at the marker root, not the subdir.
  const dir2 = tmpRoot();
  cleanup(t, dir2);
  const big2 = path.join(dir2, 'big');
  const subA = path.join(big2, 'pkg', 'deep');
  fs.mkdirSync(subA, { recursive: true });
  fs.writeFileSync(path.join(big2, 'pyproject.toml'), '[project]\nname="big"\n');
  const env2 = testEnv(dir2);
  const gen = resolveProjectIdentity(subA, {}, env2);
  assert.equal(gen.basis, 'explicit'); // written, then re-resolved
  assert.ok(fs.existsSync(path.join(big2, '.pi-project-id')));
  assert.ok(!fs.existsSync(path.join(subA, '.pi-project-id')));
  assert.equal(resolveProjectIdentity(path.join(big2, 'other'), {}, env2).id, gen.id);
});

test('marker search never anchors at HOME itself', (t) => {
  assert.equal(findMarkerRoot(os.homedir()), undefined);
});

test('stale registry locks expire instead of blocking resolution', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const work = path.join(dir, 'w');
  fs.mkdirSync(work, { recursive: true });
  const env = testEnv(dir);
  fs.mkdirSync(path.join(env.PI_PROJECTS_DIR), { recursive: true });
  const lock = path.join(env.PI_PROJECTS_DIR, 'registry.json.lock');
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, old, old);
  const identity = resolveProjectIdentity(work, {}, env);
  assert.match(identity.id, /^(prj_)/);
  assert.ok(!fs.existsSync(lock));
});

test('two handles coexist on one DB file', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const dbPath = path.join(dir, 'projects', 'prj_duo', 'memory.sqlite');
  const a = openProjectStore(dbPath, { projectId: 'prj_duo' });
  const b = openProjectStore(dbPath, { projectId: 'prj_duo' });
  t.after(() => { a.close(); b.close(); });
  a.upsertChunk({ id: 'from-a', project_id: 'prj_duo', source_type: 'todo', text: 'written via handle A', content_hash: 'ha' });
  b.upsertChunk({ id: 'from-b', project_id: 'prj_duo', source_type: 'todo', text: 'written via handle B', content_hash: 'hb' });
  assert.equal(a.counts().chunks, 2);
  assert.equal(b.getChunk('from-a').text, 'written via handle A');
});

test('retrieveFamily merges relatives with weights and provenance', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const selfStore = openTestStore(dir, 'prj_self');
  const parentStore = openTestStore(dir, 'prj_parent');
  t.after(() => { selfStore.close(); parentStore.close(); });
  await indexEvent(selfStore, 'prj_self', { kind: 'decision', sessionId: 's', text: 'lorem ipsum family ordering probe with enough words' });
  await indexEvent(parentStore, 'prj_parent', { kind: 'decision', sessionId: 's', text: 'lorem ipsum family ordering probe with enough words' });
  const result = await retrieveFamily(
    [{ store: selfStore, relation: 'self' }, { store: parentStore, relation: 'ancestor' }],
    'lorem ipsum family ordering',
    { rerank: false },
  );
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].relation, 'self');
  assert.equal(result.hits[1].relation, 'ancestor');
  assert.equal(result.stats.stores.length, 2);
  assert.ok(FAMILY_WEIGHTS.self > FAMILY_WEIGHTS.ancestor);
  assert.ok(FAMILY_WEIGHTS.ancestor > FAMILY_WEIGHTS.descendant);
  const formatted = formatFamilyHits(result.hits, 'prj_self');
  assert.ok(formatted.includes('from prj_parent (ancestor)'));
  await assert.rejects(() => retrieveFamily([], 'lorem ipsum family', { rerank: false }), /at least one store/);
});

test('parent sees child memories and vice versa; project scope isolates', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const big = path.join(dir, 'big');
  const sub = path.join(big, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(big, '.pi-project-id'), 'fam-parent\n');
  fs.writeFileSync(path.join(sub, '.pi-project-id'), 'fam-child\n');
  const env = testEnv(dir);
  const parentPi = fakePi();
  const childPi = fakePi();
  piVectorMemory(parentPi, { env, embedder: testEmbedder(16) });
  piVectorMemory(childPi, { env, embedder: testEmbedder(16) });
  const parentCtx = fakeCtx(big);
  const childCtx = fakeCtx(sub);
  await childPi.tools.get('project_memory_remember').execute('1', {
    text: 'Child implementation detail for teapot regulation compliance hooks.',
    type: 'decision',
  }, undefined, undefined, childCtx);
  await parentPi.tools.get('project_memory_remember').execute('2', {
    text: 'Parent-level decree about teapot regulation policy.',
    type: 'decision',
  }, undefined, undefined, parentCtx);
  // Descendant discovery: the parent registry knows the child root.
  const descendants = findDescendantProjects(big, env);
  assert.equal(descendants.length, 1);
  assert.equal(descendants[0].id, 'fam-child');
  // Child sees parent (ancestor); parent sees child (descendant).
  const fromChild = await childPi.tools.get('project_memory_search').execute('3', { query: 'teapot regulation', limit: 10 }, undefined, undefined, childCtx);
  const childRelations = fromChild.details.hits.map((h) => h.relation).sort();
  assert.ok(childRelations.includes('self'), 'child sees own memory');
  assert.ok(childRelations.includes('ancestor'), 'child sees parent memory');
  assert.ok(fromChild.content[0].text.includes('from fam-parent (ancestor)'));
  const fromParent = await parentPi.tools.get('project_memory_search').execute('4', { query: 'teapot regulation', limit: 10 }, undefined, undefined, parentCtx);
  const parentRelations = fromParent.details.hits.map((h) => h.relation).sort();
  assert.deepEqual(parentRelations, ['descendant', 'self']);
  assert.ok(fromParent.content[0].text.includes('from fam-child (descendant)'));
  // Project scope isolates to the querying project only.
  const narrow = await childPi.tools.get('project_memory_search').execute('5', { query: 'teapot regulation', limit: 10, scope: 'project' }, undefined, undefined, childCtx);
  assert.ok(narrow.details.hits.every((h) => !('relation' in h) || h.relation === undefined || h.project === 'fam-child'));
  assert.ok(!narrow.content[0].text.includes('from fam-parent'));
  await assert.rejects(() => childPi.tools.get('project_memory_search').execute('6', { query: 'teapot regulation', scope: 'nope' }, undefined, undefined, childCtx), /Unknown scope/);
  const status = await childPi.tools.get('project_memory_status').execute('7', {}, undefined, undefined, childCtx);
  assert.ok(status.content[0].text.includes('fam-child < fam-parent') || status.content[0].text.includes('Family:'));
});
