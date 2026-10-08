import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  atomizeCode,
  atomizeProse,
  buildAtomInputs,
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
  formatMemoryRead,
  readMemoryChunk,
  retrieveFamily,
  retrieveFamilyViews,
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

test('a symlink from outside the repository into a subdirectory resolves the repository project', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const env = testEnv(dir);
  const repo = path.join(dir, 'repo');
  const src = path.join(repo, 'src', 'deep');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.writeFileSync(path.join(repo, '.pi-project-id'), 'linked-project\n');
  const link = path.join(dir, 'elsewhere', 'link');
  fs.symlinkSync(src, link);
  const direct = resolveProjectIdentity(src, {}, env);
  const viaLink = resolveProjectIdentity(link, {}, env);
  assert.equal(viaLink.id, 'linked-project');
  assert.equal(viaLink.id, direct.id);
  assert.equal(fs.existsSync(path.join(src, '.pi-project-id')), false, 'no nested identity is written through the link');
  assert.equal(resolveProjectChain(link, {}, env).at(-1).identity.id, 'linked-project');
});

test('a symlinked subdirectory of a marker-rooted project does not mint a nested identity', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const env = testEnv(dir);
  const repo = path.join(dir, 'repo');
  const src = path.join(repo, 'src');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  fs.mkdirSync(src);
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  const link = path.join(dir, 'elsewhere', 'link');
  fs.symlinkSync(src, link);
  const viaLink = resolveProjectIdentity(link, {}, env);
  const direct = resolveProjectIdentity(src, {}, env);
  assert.equal(viaLink.id, direct.id);
  assert.equal(fs.existsSync(path.join(src, '.pi-project-id')), false);
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

test('shared roots never receive a generated id file, and a planted temp-root id anchors nothing', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const shared = os.tmpdir(), marker = path.join(shared, '.pi-project-id');
  const existed = fs.existsSync(marker);
  const identity = resolveProjectIdentity(shared, {}, testEnv(dir));
  assert.equal(identity.basis, 'generated');
  assert.equal(fs.existsSync(marker), existed);
  // Whatever sits in the temp root, a project beneath it resolves on its own.
  const work = path.join(dir, 'w');
  fs.mkdirSync(work);
  assert.equal(findExplicitId(work), undefined);
  assert.deepEqual(findProjectAnchors(work, testEnv(dir)), []);
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

test('source identity is byte-exact: case and indentation changes are new content, not duplicates', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_exact');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const python = (indent) => `def handler(request):\n${indent}if request.ready:\n${indent}${indent}return Token("Admin")\n${indent}return None\n`;
  const first = await indexFile(store, 'prj_exact', { path: 'src/handler.py', content: python('  ') }, { embedder });
  assert.equal(first.inserted, 1);
  const livePaths = () => store.getChunksByPath('src/handler.py').filter((c) => c.valid_until === null);
  assert.match(livePaths()[0].text, /Token\("Admin"\)/);

  // String-literal case: same normalized hash, different program.
  const cased = python('  ').replace('"Admin"', '"admin"');
  const second = await indexFile(store, 'prj_exact', { path: 'src/handler.py', content: cased }, { embedder });
  assert.equal(second.inserted, 1, 'a case-only change is stored as new source');
  assert.equal(second.skippedDup, 0);
  assert.equal(livePaths().length, 1, 'only the current version is live');
  assert.match(livePaths()[0].text, /Token\("admin"\)/);

  // Indentation-only change in a whitespace-significant language.
  const reindented = await indexFile(store, 'prj_exact', { path: 'src/handler.py', content: python('    ') }, { embedder });
  assert.equal(reindented.inserted, 1);
  assert.equal(livePaths().length, 1);

  // Replaced versions stay as backlinked history, and a reverted text returns to live.
  const all = store.getChunksByPath('src/handler.py');
  assert.equal(all.length, 3);
  const history = all.filter((c) => c.valid_until !== null);
  assert.equal(history.length, 2);
  assert.ok(history.every((c) => all.some((other) => other.id === c.superseded_by)), 'history points at the fragment that replaced it');
  assert.ok(history.some((c) => c.superseded_by === livePaths()[0].id));
  const reverted = await indexFile(store, 'prj_exact', { path: 'src/handler.py', content: python('  ') }, { embedder });
  assert.equal(reverted.inserted, 0, 'reverting reuses the retained row instead of duplicating it');
  assert.equal(livePaths().length, 1);
  assert.match(livePaths()[0].text, /Token\("Admin"\)/);
  assert.equal(livePaths()[0].superseded_by, '');
});

test('reindexing refreshes where unchanged fragments now sit and never touches other memories', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_move');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const guide = ['# Guide', '', 'Alpha paragraph with enough words to form a chunk.', '', '## Part', '', 'Beta paragraph with enough words to form a chunk.'];
  await indexEvent(store, 'prj_move', { kind: 'observation', sessionId: 's', path: 'docs/guide.md', text: 'An unrelated observation that mentions docs/guide.md in passing.' }, { embedder });
  await indexFile(store, 'prj_move', { path: 'docs/guide.md', content: guide.join('\n'), commit: 'aaa111' }, { embedder });
  const part = () => store.getChunksByPath('docs/guide.md').find((c) => c.text.startsWith('Beta'));
  const before = part();
  // Insert lines above: the same text now sits further down and was seen at a newer commit.
  const shifted = ['# Preface', '', 'Intro paragraph with enough words to form a chunk.', '', ...guide].join('\n');
  const result = await indexFile(store, 'prj_move', { path: 'docs/guide.md', content: shifted, commit: 'bbb222' }, { embedder });
  assert.ok(result.skippedDup >= 2, 'moved text is recognised as unchanged');
  const after = part();
  assert.equal(after.id, before.id);
  assert.ok(after.source_start > before.source_start, 'location is refreshed');
  assert.equal(after.commit_sha, 'bbb222', 'the observing commit is refreshed');
  assert.equal(store.getChunksByPath('docs/guide.md').find((c) => c.source_type === 'observation')?.valid_until, null, 'an unrelated memory about the file is untouched');
  // A deliberate tombstone is not revived by identical content.
  store.tombstone(after.id);
  await indexFile(store, 'prj_move', { path: 'docs/guide.md', content: shifted, commit: 'bbb222' }, { embedder });
  assert.notEqual(part().valid_until, null);
});

test('semantic scans are capped to the newest vectors and say so', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_cap');
  t.after(() => store.close());
  const embedder = testEmbedder(32);
  for (let i = 0; i < 100; i++) await indexEvent(store, 'prj_cap', { kind: 'observation', sessionId: 's', text: `Filler observation number ${i} about unrelated gardening topics and soil.` }, { embedder });
  await indexEvent(store, 'prj_cap', { kind: 'observation', sessionId: 's', text: 'The newest note covers quasar telemetry calibration for the observer pipeline.' }, { embedder });
  const [query] = await embedder.embed(['quasar telemetry calibration observer pipeline']);
  const space = store.embeddingSpaces()[0].id;
  // scanCap floors at 100 rows; 101 atoms exist, so the OLDEST must be the one left out.
  const hits = store.atomVectorSearch(query, { embedder: space, scanCap: 100, limit: 3 });
  assert.equal(store.lastVectorScan.truncated, true);
  assert.equal(store.lastVectorScan.scanned, 100);
  const top = store.getChunk(hits[0].chunkId);
  assert.match(top.text, /quasar telemetry/, 'a newer row beyond the cap is still reachable semantically');
  const wide = store.atomVectorSearch(query, { embedder: space, scanCap: 5000, limit: 3 });
  assert.equal(store.lastVectorScan.truncated, false);
  assert.equal(wide[0].chunkId, hits[0].chunkId);
});

test('role views of one query scan each store once', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_views');
  t.after(() => store.close());
  const embedder = testEmbedder(32);
  await indexEvent(store, 'prj_views', { kind: 'decision', sessionId: 's', text: 'Decision: observer advice is delivered once per task epoch with a receipt.' }, { embedder });
  await indexEvent(store, 'prj_views', { kind: 'observation', sessionId: 's', text: 'Observation: the observer advice receipt is ledgered before display.' }, { embedder });
  const counts = { lexical: 0, vector: 0, atom: 0 };
  for (const [name, key] of [['lexicalSearch', 'lexical'], ['vectorSearch', 'vector'], ['atomVectorSearch', 'atom']]) {
    const original = store[name].bind(store);
    store[name] = (...args) => { counts[key]++; return original(...args); };
  }
  const views = await retrieveFamilyViews([{ store, relation: 'self' }], 'observer advice receipt', { embedder, rerank: false });
  assert.deepEqual(Object.keys(views).sort(), ['main', 'observer', 'subagent', 'watchmaker']);
  assert.ok(views.main.length > 0);
  assert.deepEqual(counts, { lexical: 1, vector: 1, atom: 1 }, 'four role views share one scan per store');
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
  for (const name of ['project_memory_search', 'project_memory_read', 'project_memory_remember', 'project_memory_status', 'project_memory_index_path', 'project_memory_forget', 'project_memory_restore', 'project_memory_consolidate']) {
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

test('file provenance is anchored to the project root, not the session workdir', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const root = path.join(dir, 'proj');
  const client = path.join(root, 'client');
  const server = path.join(root, 'server');
  fs.mkdirSync(client, { recursive: true });
  fs.mkdirSync(server, { recursive: true });
  fs.writeFileSync(path.join(root, '.pi-project-id'), 'rooted-project\n');
  const same = 'export const listenPort = 8080;\n'.repeat(6);
  fs.writeFileSync(path.join(client, 'config.ts'), same);
  fs.writeFileSync(path.join(server, 'config.ts'), same);
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  const index = (cwd, file) => pi.tools.get('project_memory_index_path').execute('1', { path: file }, undefined, undefined, fakeCtx(cwd));
  pi.handlers.get('session_start')({}, fakeCtx(client));
  const fromClient = await index(client, 'config.ts');
  const fromServer = await index(server, 'config.ts');
  const fromRoot = await index(root, 'client/config.ts');
  assert.equal(fromClient.details.result.inserted, 1);
  assert.equal(fromServer.details.result.inserted, 1, 'same-named files in different subdirectories are distinct sources');
  assert.equal(fromRoot.details.result.inserted, 0, 'the same file indexed from another workdir is the same source');
  const store = openProjectStore(path.join(dir, 'projects', 'rooted-project', 'memory.sqlite'), { projectId: 'rooted-project', create: false });
  t.after(() => store.close());
  const paths = store.listRecent(20).map((chunk) => chunk.source_path).sort();
  assert.deepEqual(paths, ['client/config.ts', 'server/config.ts']);
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
  assert.deepEqual([...child.tools.keys()].sort(), ['project_memory_read', 'project_memory_search', 'project_memory_status']);
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

test('descendant projects of equal depth are listed in path order', async (t) => {
  // Both registration orders: a comparator that ignores the second path only
  // ever reverses its input, so one order alone cannot expose it.
  for (const order of [['cc', 'bb', 'aa'], ['aa', 'bb', 'cc']]) {
    const dir = tmpRoot();
    cleanup(t, dir);
    const big = path.join(dir, 'big');
    fs.mkdirSync(big, { recursive: true });
    fs.writeFileSync(path.join(big, '.pi-project-id'), 'ord-parent\n');
    const env = testEnv(dir);
    for (const name of order) {
      const sub = path.join(big, name);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, '.pi-project-id'), `ord-${name}\n`);
      const pi = fakePi();
      piVectorMemory(pi, { env, embedder: testEmbedder(16) });
      await pi.tools.get('project_memory_remember').execute(name, { text: `Ordering fixture memory for ${name}.`, type: 'decision' }, undefined, undefined, fakeCtx(sub));
    }
    assert.deepEqual(findDescendantProjects(big, env).map((d) => d.id), ['ord-aa', 'ord-bb', 'ord-cc'], order.join());
  }
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

// ---------------------------------------------------------------------------
// atoms: retrieval units inside parent reading units
// ---------------------------------------------------------------------------

test('atomizers split prose and code into bounded retrieval units', () => {
  const short = 'A short decision recorded here.';
  const single = atomizeProse(short);
  assert.equal(single.length, 1);
  assert.equal(single[0].text, short);
  const prose = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} carries enough distinct wording to fill space comfortably within the packed budget limits.`).join('\n\n');
  const atoms = atomizeProse(prose);
  assert.ok(atoms.length >= 2);
  assert.ok(atoms.every((a) => a.text.length <= 800));
  for (const atom of atoms) assert.equal(prose.slice(atom.charStart, atom.charEnd), atom.text);
  const alpha = `export function alpha() {\n${Array.from({ length: 20 }, (_, i) => `  const fillerWorkItemNumber${i} = computeSomethingImportant(${i});`).join('\n')}\n}`;
  const code = `${alpha}\n\nexport function beta() {\n  return "beta result";\n}\n\nexport class Gamma {\n  run() { return true; }\n}`;
  const codeAtoms = atomizeCode(code);
  assert.ok(codeAtoms.length >= 2);
  assert.ok(codeAtoms[0].text.startsWith('export function alpha'));
  assert.ok(codeAtoms[0].text.includes('fillerWorkItemNumber19'), 'mid-function statements never force a boundary');
  assert.ok(codeAtoms.some((a) => a.text.startsWith('export function beta')), 'a definition starts its own atom');
  for (const atom of codeAtoms) assert.equal(code.slice(atom.charStart, atom.charEnd), atom.text);
});

test('indexing stores vectors on atoms; parents stay vector-free', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_atoms');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const result = await indexEvent(store, 'prj_atoms', { kind: 'decision', sessionId: 's', title: 'Atom vectors', text: 'The retrieval unit is now the atom; the parent chunk is the reading unit.' }, { embedder });
  assert.equal(result.inserted, 1);
  assert.equal(result.embedded, 1);
  const chunk = store.getChunk(result.ids[0]);
  assert.equal(chunk.has_embedding, false);
  const atoms = store.getAtoms(result.ids[0]);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].has_embedding, true);
  assert.equal(atoms[0].id, `${result.ids[0]}:a0`);
  assert.equal(atoms[0].text, chunk.text);
  assert.deepEqual(store.atomCounts(), { atoms: 1, embedded: 1 });
  assert.equal(store.counts().embedded, 1);
});

test('semantic retrieval sees text beyond the old 2000-char embedding bound', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_tail');
  t.after(() => store.close());
  const embedder = testEmbedder(32);
  const head = 'Session summary preamble filler wording for padding purposes. '.repeat(45);
  const tail = 'quasarflux capacitor banks require cryogenic recalibration every cycle';
  await indexEvent(store, 'prj_tail', { kind: 'session_summary', sessionId: 's', text: `${head} ${tail}` }, { embedder });
  const result = await retrieveProjectMemory(store, 'quasarflux cryogenic recalibration', { embedder, rerank: false });
  assert.ok(result.hits.length >= 1);
  assert.ok(result.stats.atoms >= 1);
  const hit = result.hits[0];
  assert.equal(hit.signals.vectorSource, 'atom');
  assert.ok(hit.signals.atomId);
  assert.ok(hit.fragment.includes('quasarflux'));
});

for (const filter of ['types', 'since', 'minAuthority']) test(`lexical ${filter} eligibility applies before the forty-candidate limit`, async t => {
  const dir = tmpRoot(); cleanup(t, dir);
  const store = openTestStore(dir); t.after(() => store.close());
  const common = { project_id: store.projectId, source_type: 'decision', timestamp: '2026-10-02T00:00:00.000Z', authority: 1 };
  const excluded = filter === 'types' ? { source_type: 'code' } : filter === 'since' ? { timestamp: '2026-09-01T00:00:00.000Z' } : { authority: 0 };
  for (let i = 0; i < 50; i++) store.upsertChunk({ ...common, ...excluded, id: `excluded-${i}`, text: 'quasarflux', content_hash: `excluded-${i}` });
  store.upsertChunk({ ...common, id: 'eligible', text: 'quasarflux ' + 'background details '.repeat(100), content_hash: 'eligible' });
  assert.ok(!store.lexicalSearch('quasarflux', 40).some(hit => hit.id === 'eligible'), 'the eligible row is below the unfiltered limit');
  const opts = filter === 'types' ? { types: ['decision'] } : filter === 'since' ? { since: '2026-10-01T00:00:00.000Z' } : { minAuthority: 0.9 };
  const result = await retrieveProjectMemory(store, 'quasarflux', { ...opts, rerank: false });
  assert.deepEqual(result.hits.map(hit => hit.chunk.id), ['eligible']);
});

for (const family of [false, true]) test(`an excluded exact match cannot suppress ${family ? 'family' : 'project'} semantic recall`, async t => {
  const dir = tmpRoot(); cleanup(t, dir);
  const store = openTestStore(dir); t.after(() => store.close());
  const space = { id: 'eligible:space', backend: 'test', model: 'eligible', version: 1, dim: 2 };
  store.upsertChunk({ id: 'excluded', project_id: store.projectId, source_type: 'code', text: 'getWidget', content_hash: 'excluded' });
  store.upsertChunk({ id: 'semantic', project_id: store.projectId, source_type: 'decision', text: 'Recover the requested object through its registered accessor.', content_hash: 'semantic', embeddingSpace: space, embedding: [1, 0] });
  let calls = 0;
  const embedder = { id: space.id, space, embed: async () => { calls++; return [[1, 0]]; } };
  const opts = { types: ['decision'], embedder, rerank: false };
  const result = family ? await retrieveFamily([{ store, relation: 'self' }], 'getWidget', opts) : await retrieveProjectMemory(store, 'getWidget', opts);
  assert.equal(calls, 1, 'only eligible literal matches can skip query embedding');
  assert.deepEqual(result.hits.map(hit => hit.chunk.id), ['semantic']);
});

for (const family of [false, true]) test(`${family ? 'family' : 'project'} reranking receives the source-linked matched tail atom`, async t => {
  const dir = tmpRoot(); cleanup(t, dir);
  const store = openTestStore(dir); t.after(() => store.close());
  const space = { id: 'tail:space', backend: 'test', model: 'tail', version: 1, dim: 2 };
  const parent = 'Routine session preamble. '.repeat(200);
  const tail = 'quasarflux cryogenic recalibration resolves the capacitor failure';
  store.upsertChunk({ id: 'tail', project_id: store.projectId, source_type: 'decision', title: 'Long evidence', text: parent + tail, source_path: 'notes/long.md', source_start: 1, source_end: 124, content_hash: 'tail' });
  store.setAtoms('tail', [{ id: 'tail:a0', chunk_id: 'tail', text: tail, source_start: 120, source_end: 124, char_start: parent.length, char_end: parent.length + tail.length, content_hash: 'tail-atom' }]);
  store.setAtomEmbedding('tail:a0', space, [1, 0]);
  store.upsertChunk({ id: 'decoy', project_id: store.projectId, source_type: 'decision', text: 'quasarflux cryogenic history without the repair', content_hash: 'decoy', embeddingSpace: space, embedding: [0.8, 0.6] });
  let seen;
  const embedder = { id: space.id, space, embed: async () => [[1, 0]] };
  const rerank = { rank: async (_query, candidates) => {
    seen = candidates;
    return candidates.slice().sort((a, b) => Number(b.text.includes('resolves the capacitor failure')) - Number(a.text.includes('resolves the capacitor failure'))).map(c => c.id);
  } };
  const opts = { embedder, rerank, limit: 1 };
  const result = family ? await retrieveFamily([{ store, relation: 'self' }], 'quasarflux cryogenic recalibration', opts) : await retrieveProjectMemory(store, 'quasarflux cryogenic recalibration', opts);
  assert.equal(result.stats.reranked, true);
  const evidence = seen.find(c => c.id === (family ? `${store.projectId}:tail` : 'tail')).text;
  assert.ok(evidence.length <= 4000, 'the ranker view bounds remote context while preserving the local prefix');
  assert.match(evidence.slice(0, 800), /resolves the capacitor failure/);
  assert.match(evidence, /notes\/long\.md:120-124/);
  assert.match(evidence, /tail:a0/);
  assert.equal(result.hits[0].chunk.id, 'tail');
});

test('legacy chunk vectors stay retrievable alongside atoms', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_legacy');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const [vec] = await embedder.embed(['Legacy zebrastripe vector memory about routing']);
  store.upsertChunk({
    id: 'legacy', project_id: 'prj_legacy', source_type: 'decision',
    text: 'Legacy zebrastripe vector memory about routing', content_hash: 'h-legacy',
    embedder: 'test-hash', embedding: vec,
  });
  const result = await retrieveProjectMemory(store, 'zebrastripe routing', { embedder, rerank: false });
  assert.equal(result.hits[0].chunk.id, 'legacy');
  assert.equal(result.hits[0].signals.vectorSource, 'chunk');
  assert.equal(result.hits[0].signals.atomId, undefined);
  assert.ok(result.hits[0].fragment.length > 0);
});

test('reindex atomizes legacy chunks and retires their chunk vectors', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_conv');
  t.after(() => store.close());
  store.upsertChunk({
    id: 'leg', project_id: 'prj_conv', source_type: 'decision',
    text: 'Legacy needle memory about cache reuse patterns.', content_hash: 'h-leg',
    embedder: 'needle3', embedding: [1, 0],
  });
  assert.deepEqual(store.getAtoms('leg'), []);
  const embedder = testEmbedder(16);
  const report = await reindexEmbeddings(store, embedder, { limit: 4 });
  assert.equal(report.embedded, 1);
  const atoms = store.getAtoms('leg');
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].has_embedding, true);
  assert.equal(store.getChunk('leg').has_embedding, false);
  assert.equal(store.embeddingSpaces().find((s) => s.id === 'needle3').count, 0);
  const result = await retrieveProjectMemory(store, 'cache reuse patterns', { embedder, rerank: false });
  assert.equal(result.hits[0].chunk.id, 'leg');
  assert.equal(result.hits[0].signals.vectorSource, 'atom');
});

test('schema v2 upgrades keep legacy vectors searchable without a rewrite', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const dbPath = path.join(dir, 'projects', 'prj_mig', 'memory.sqlite');
  const first = openProjectStore(dbPath, { projectId: 'prj_mig' });
  first.upsertChunk({
    id: 'old', project_id: 'prj_mig', source_type: 'decision',
    text: 'Historical architectural evidence for migration', content_hash: 'h-old',
    embedder: 'needle3', embedding: [1, 0],
  });
  first.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP TABLE atoms; UPDATE meta SET value='2' WHERE key='schema_version'");
  raw.close();
  const migrated = openProjectStore(dbPath, { projectId: 'prj_mig' });
  t.after(() => migrated.close());
  assert.equal(migrated.getMeta('schema_version'), '3');
  assert.equal(migrated.getChunk('old').text, 'Historical architectural evidence for migration');
  assert.equal(migrated.getChunk('old').has_embedding, true);
  assert.deepEqual(migrated.getAtoms('old'), []);
  assert.equal(migrated.lexicalSearch('architectural')[0].id, 'old');
  assert.deepEqual(migrated.atomCounts(), { atoms: 0, embedded: 0 });
});

test('storedVectors pools atom vectors for atom-only chunks', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_pool');
  t.after(() => store.close());
  const embedder = testEmbedder(8);
  const res = await indexEvent(store, 'prj_pool', { kind: 'decision', sessionId: 's', text: 'Pooled vector memory for consolidation checks.' }, { embedder });
  const pooled = store.storedVectors([res.ids[0]], 'test-hash');
  assert.equal(pooled.size, 1);
  assert.equal(pooled.get(res.ids[0]).length, 8);
  assert.deepEqual(store.storedVectors([res.ids[0]], 'other-space'), new Map());
});

test('consolidation clusters atom-embedded near-duplicates without endpoint calls', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_ccon');
  t.after(() => store.close());
  const embedder = testEmbedder(32);
  await indexEvent(store, 'prj_ccon', { kind: 'observation', sessionId: 's', concepts: ['widget'], text: 'The widget cache lives in memory and expires after one hour of idle time.' }, { embedder });
  await indexEvent(store, 'prj_ccon', { kind: 'observation', sessionId: 's', concepts: ['widget'], text: 'The widget cache lives in memory, expiring after one hour of idle time.' }, { embedder });
  let calls = 0;
  const counting = { ...embedder, embed: async (...args) => { calls++; return embedder.embed(...args); } };
  const found = await findClusters(store, { embedder: counting });
  assert.equal(calls, 0);
  assert.equal(found.clusters.length, 1);
  assert.equal(found.clusters[0].ids.length, 2);
});

test('indexed code gains definition-aware atoms with file positions', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_code');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const alpha = `export function alpha() {\n${Array.from({ length: 20 }, (_, i) => `  const fillerWorkItemNumber${i} = computeSomethingImportant(${i});`).join('\n')}\n}`;
  const content = `${alpha}\n\nexport function beta() {\n  return "beta result";\n}\n`;
  const result = await indexFile(store, 'prj_code', { path: 'src/shapes.ts', content }, { embedder });
  assert.ok(result.inserted >= 1);
  const atoms = store.getAtoms(result.ids[0]);
  assert.ok(atoms.length >= 2);
  assert.ok(atoms.some((a) => a.text.startsWith('export function beta')));
  assert.equal(atoms[0].source_start, 1);
  assert.ok(atoms.every((a) => a.has_embedding));
});

// ---------------------------------------------------------------------------
// project_memory_read: expanded evidence for one memory
// ---------------------------------------------------------------------------

test('readMemoryChunk expands one memory with atoms, siblings and history', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_read');
  t.after(() => store.close());
  const embedder = testEmbedder(16);
  const old = await indexEvent(store, 'prj_read', { kind: 'decision', sessionId: 's', text: 'Old routing approach used static tables everywhere.' }, { embedder });
  const fresh = await indexEvent(store, 'prj_read', { kind: 'decision', sessionId: 's', text: 'New routing approach uses dynamic confidence scoring.' }, { embedder });
  store.addSupersedes(fresh.ids[0], [old.ids[0]]);
  store.markSuperseded(old.ids[0], fresh.ids[0]);
  const detail = readMemoryChunk(store, fresh.ids[0]);
  assert.ok(detail);
  assert.equal(detail.status, 'current');
  assert.equal(detail.atoms.length, 1);
  assert.equal(detail.chain.supersedes[0].id, old.ids[0]);
  const oldDetail = readMemoryChunk(store, old.ids[0]);
  assert.equal(oldDetail.status, 'superseded');
  assert.equal(oldDetail.chain.supersededBy[0].id, fresh.ids[0]);
  const viaAtom = readMemoryChunk(store, `${fresh.ids[0]}:a0`);
  assert.equal(viaAtom.chunk.id, fresh.ids[0]);
  assert.equal(viaAtom.matchedAtom.id, `${fresh.ids[0]}:a0`);
  assert.equal(readMemoryChunk(store, 'mem_missing'), undefined);
  const rendered = formatMemoryRead(detail, 'prj_read');
  assert.ok(rendered.includes('dynamic confidence scoring'));
  assert.ok(rendered.includes('Atoms (1 retrieval units)'));
  assert.ok(rendered.includes(`supersedes [${old.ids[0]}]`));
  // Atom character spans come from the stored char_start/char_end columns.
  assert.equal(typeof detail.atoms[0].charStart, 'number');
  assert.equal(typeof detail.atoms[0].charEnd, 'number');
  assert.ok(detail.atoms[0].charEnd > detail.atoms[0].charStart);
  assert.doesNotMatch(rendered, /undefined/);
  assert.doesNotMatch(formatMemoryRead(viaAtom, 'prj_read'), /undefined/);
});

test('read expansion shows adjacent source blocks', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_sib');
  t.after(() => store.close());
  const content = ['# Alpha', '', 'Alpha section with enough words to form a chunk.', '', '# Beta', '', 'Beta section with enough words to form a chunk.', '', '# Gamma', '', 'Gamma section with enough words to form a chunk.'].join('\n');
  await indexFile(store, 'prj_sib', { path: 'docs/guide.md', content }, { embedder: testEmbedder(16) });
  const along = store.getChunksByPath('docs/guide.md');
  assert.equal(along.length, 3);
  const detail = readMemoryChunk(store, along[1].id, { context: 1 });
  assert.equal(detail.siblings.length, 2);
  assert.equal(detail.siblings[0].id, along[0].id);
  assert.equal(detail.siblings[1].id, along[2].id);
  assert.equal(readMemoryChunk(store, along[1].id, { context: 0 }).siblings.length, 0);
});

test('extension reads memories in full after compact search', async (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const pi = fakePi();
  piVectorMemory(pi, { env: testEnv(dir), embedder: testEmbedder(24), isoNow: () => '2026-09-25T12:00:00.000Z' });
  const ctx = fakeCtx(cwd);
  const longText = `Quasar lattice calibration decision. ${'Supporting analysis paragraph with filler wording. '.repeat(30)} Final verdict: recalibrate nightly.`;
  const remember = await pi.tools.get('project_memory_remember').execute('1', { text: longText, type: 'decision' }, undefined, undefined, ctx);
  const id = remember.details.id;
  const search = await pi.tools.get('project_memory_search').execute('2', { query: 'Quasar lattice calibration verdict' }, undefined, undefined, ctx);
  const body = search.content[0].text;
  assert.ok(body.includes('project_memory_read'));
  assert.ok(body.includes(id));
  assert.ok(search.details.hits[0].fragment.length > 0);
  assert.ok(body.length < longText.length, 'search returns a bounded excerpt, not the body');
  const read = await pi.tools.get('project_memory_read').execute('3', { id }, undefined, undefined, ctx);
  assert.ok(read.content[0].text.includes('Final verdict: recalibrate nightly.'));
  assert.ok(read.content[0].text.includes('Quasar lattice calibration decision.'));
  assert.equal(read.details.status, 'current');
  assert.ok(read.details.atoms.length >= 2);
  await assert.rejects(() => pi.tools.get('project_memory_read').execute('4', { id: 'mem_missing' }, undefined, undefined, ctx), /Unknown project memory id/);
});

test('streamed top-k scans equal a naive full sort for atoms and legacy chunk vectors', (t) => {
  const dir = tmpRoot();
  cleanup(t, dir);
  const store = openTestStore(dir, 'prj_exact');
  t.after(() => store.close());
  const dim = 24, space = { id: 'exact:space', backend: 'test', model: 'exact', version: 1, dim };
  let seed = 4242;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5;
  const unit = () => { const v = Float32Array.from({ length: dim }, random); const n = Math.hypot(...v); return v.map((x) => x / n); };
  const vectors = new Map();
  for (let i = 0; i < 160; i++) {
    const id = `c${i}`, vec = unit();
    store.upsertChunk({ id, project_id: 'prj_exact', source_type: 'observation', text: `chunk ${i}`, content_hash: `h${i}`, embeddingSpace: space, embedding: vec });
    store.setAtoms(id, [{ id: `a${i}`, chunk_id: id, text: `atom ${i}`, content_hash: `ah${i}` }]);
    store.setAtomEmbedding(`a${i}`, space, vec);
    vectors.set(`a${i}`, vec); vectors.set(id, vec);
  }
  const query = unit();
  const naive = (ids) => ids.map((id) => ({ id, score: vectors.get(id).reduce((sum, x, k) => sum + x * query[k], 0) })).sort((a, b) => b.score - a.score);
  const atomIds = [...vectors.keys()].filter((id) => id.startsWith('a')), chunkIds = [...vectors.keys()].filter((id) => id.startsWith('c'));
  for (const limit of [1, 7, 60, 200]) {
    const atoms = store.atomVectorSearch(query, { embedder: space.id, limit, scanCap: 5000 });
    assert.deepEqual(atoms.map((hit) => hit.atomId), naive(atomIds).slice(0, limit).map((hit) => hit.id), `atom top-${limit} matches a full sort`);
    for (let k = 1; k < atoms.length; k++) assert.ok(atoms[k - 1].score >= atoms[k].score, 'descending');
    const chunks = store.vectorSearch(query, { embedder: space.id, limit, scanCap: 5000 });
    assert.deepEqual(chunks.map((hit) => hit.id), naive(chunkIds).slice(0, limit).map((hit) => hit.id), `legacy chunk top-${limit} matches a full sort`);
  }
  const capped = store.atomVectorSearch(query, { embedder: space.id, limit: 5, scanCap: 100 });
  assert.equal(store.lastVectorScan.scanned, 100);
  assert.equal(store.lastVectorScan.truncated, true);
  assert.equal(capped.length, 5);
  const newest = new Set(atomIds.slice(60));
  assert.ok(capped.every((hit) => newest.has(hit.atomId)), 'a capped scan reads the newest rows only');
});
