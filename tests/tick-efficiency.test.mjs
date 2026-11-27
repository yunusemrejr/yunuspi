import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
let agent = path.resolve(import.meta.dirname, '../agent');
try { fs.accessSync(agent); } catch { agent = path.resolve(import.meta.dirname, '../..'); }
const { relevant, clearRelevantTokenCache } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-observer.ts')));
const { buildSkillIndex, rankSkills, clearRankSkillsCache, skillCatalogFingerprint } = await import(pathToFileURL(path.join(agent, 'extensions/lib/skill-relevance.ts')));
const { coordinationRoot, clearCoordinationRootCache, fileVersion, clearFileVersionCache } = await import(pathToFileURL(path.join(agent, 'extensions/siblings.ts')));

test('capability ranking reuses token sets without ever serving a stale description', () => {
  clearRelevantTokenCache();
  const tools = [{ name: 'read', description: 'read files from disk' }, { name: 'edit', description: 'edit files on disk' }];
  const first = relevant(tools, 'read the file', 2);
  assert.deepEqual(relevant(tools, 'read the file', 2), first, 'repeated ranking is identical');
  assert.deepEqual(relevant(tools, 'edit the file', 2).map(item => item.name)[0], 'edit', 'a new query ranks against the same cached sets');
  const changed = [{ name: 'read', description: 'read files from disk' }, { name: 'edit', description: 'unrelated telemetry aggregation' }];
  assert.deepEqual(relevant(tools, 'telemetry', 2), [], 'original descriptions have no telemetry token');
  assert.deepEqual(relevant(changed, 'telemetry', 2).map(item => item.name), ['edit'], 'changed description text re-tokenizes instead of reusing');
  assert.deepEqual(relevant(changed, 'files from disk', 2).map(item => item.name), ['read'], 'removed description tokens stop matching');
  clearRelevantTokenCache();
  assert.deepEqual(relevant(tools, 'read the file', 2), first, 'clearing only drops the cache, never the ranking');
});

test('skill ranking memoizes identical searches and invalidates across catalog sequences', () => {
  clearRankSkillsCache();
  const skill = (name, description) => ({ name, description, file: `/skills/${name}/SKILL.md` });
  const unrelated = Array.from({ length: 40 }, (_, i) => skill(`unrelated-${i}`, `specialization${i}`));
  const base = [skill('spreadsheet', 'workbooks formulas'), ...unrelated];
  const index = buildSkillIndex(base);
  assert.equal(index.fingerprint, skillCatalogFingerprint(base), 'built index carries the catalog fingerprint');
  assert.equal(rankSkills(index, 'spreadsheet')[0]?.skill.name, 'spreadsheet');
  assert.deepEqual(rankSkills(index, 'spreadsheet'), rankSkills(index, 'spreadsheet'), 'repeated identical search reuses the ranking');
  // Add, remove, revert: every catalog shape ranks from its own content.
  const added = buildSkillIndex([skill('spreadsheet-pro', 'spreadsheet workbooks formulas macros'), ...base]);
  assert.notEqual(added.fingerprint, index.fingerprint);
  assert.deepEqual(rankSkills(added, 'spreadsheet').map(item => item.skill.name).sort(), ['spreadsheet', 'spreadsheet-pro'], 'added skill joins the ranking');
  assert.equal(rankSkills(index, 'spreadsheet')[0]?.skill.name, 'spreadsheet', 'earlier catalog still ranks from its own content');
  const removed = buildSkillIndex(unrelated);
  assert.deepEqual(rankSkills(removed, 'spreadsheet'), [], 'removed skill disappears from ranking');
  assert.equal(rankSkills(index, 'spreadsheet')[0]?.skill.name, 'spreadsheet', 'reverted catalog ranks correctly again');
  assert.deepEqual(rankSkills(index, 'spreadsheet', 1), rankSkills(index, 'spreadsheet', 4).slice(0, 1), 'narrower limit matches the wider ranking prefix');
  clearRankSkillsCache();
  assert.equal(rankSkills(index, 'spreadsheet')[0]?.skill.name, 'spreadsheet', 'clearing only drops the cache');
});

test('skill ranking honors the local-intelligence toggle per call', () => {
  clearRankSkillsCache();
  const previous = process.env.PI_LOCAL_INTELLIGENCE;
  try {
    const skill = (name, description) => ({ name, description, file: `/skills/${name}/SKILL.md` });
    const index = buildSkillIndex([skill('orbital-mechanics', 'orbital ephemeris propagation integrator'), ...Array.from({ length: 40 }, (_, i) => skill(`unrelated-${i}`, `specialization${i}`))]);
    process.env.PI_LOCAL_INTELLIGENCE = 'off';
    const off = rankSkills(index, 'orbitl ephemeri');
    delete process.env.PI_LOCAL_INTELLIGENCE;
    const on = rankSkills(index, 'orbitl ephemeri');
    assert.equal(off[0]?.skill.name, 'orbital-mechanics');
    assert.equal(on[0]?.skill.name, 'orbital-mechanics');
  } finally {
    if (previous === undefined) delete process.env.PI_LOCAL_INTELLIGENCE;
    else process.env.PI_LOCAL_INTELLIGENCE = previous;
    clearRankSkillsCache();
  }
});

test('checkout-root memoization survives reuse and clears for invalidation', () => {
  clearCoordinationRootCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-root-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(coordinationRoot(nested), fs.realpathSync(root));
    assert.equal(coordinationRoot(nested), fs.realpathSync(root), 'repeated lookup reuses the memoized root');
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    clearCoordinationRootCache();
    assert.equal(coordinationRoot(nested), fs.realpathSync(nested), 'after clear, a removed marker falls back to the cwd');
  } finally {
    clearCoordinationRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a linked git worktree shares the main checkout coordination root', () => {
  clearCoordinationRootCache();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-worktree-')));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, stdio: 'pipe' });
  try {
    const main = path.join(base, 'main'), linked = path.join(base, 'linked'), other = path.join(base, 'other');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'side', linked);
    fs.mkdirSync(path.join(linked, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(main, 'a'), { recursive: true });
    assert.equal(coordinationRoot(main), main, 'the main checkout keeps its own root');
    assert.equal(coordinationRoot(path.join(main, 'a')), main);
    assert.equal(coordinationRoot(linked), main, 'a worktree session is a sibling of the main checkout');
    assert.equal(coordinationRoot(path.join(linked, 'a', 'b')), main);
    // A link that the worktree git dir does not point back at cannot adopt the main root.
    fs.mkdirSync(other);
    const gitDir = fs.readFileSync(path.join(linked, '.git'), 'utf8');
    fs.writeFileSync(path.join(other, '.git'), gitDir);
    clearCoordinationRootCache();
    assert.equal(coordinationRoot(other), other, 'a forged gitdir link keeps its own directory');
    // A git dir outside <common>/worktrees cannot vouch for a checkout, even with matching back-pointers.
    const forged = path.join(base, 'forged-gitdir'), victim = path.join(base, 'victim');
    fs.mkdirSync(forged); fs.mkdirSync(victim);
    fs.writeFileSync(path.join(forged, 'commondir'), path.join(main, '.git'));
    fs.writeFileSync(path.join(forged, 'gitdir'), path.join(victim, '.git'));
    fs.writeFileSync(path.join(victim, '.git'), `gitdir: ${forged}\n`);
    clearCoordinationRootCache();
    assert.equal(coordinationRoot(victim), victim, 'a git dir outside common/worktrees keeps its own root');
    // A symlinked registration is not the registered directory.
    const alias = path.join(base, 'alias'), aliased = path.join(base, 'aliased');
    fs.symlinkSync(gitDir.replace(/^gitdir: /, '').trim(), alias, 'dir'); fs.mkdirSync(aliased);
    fs.writeFileSync(path.join(aliased, '.git'), `gitdir: ${alias}\n`);
    clearCoordinationRootCache();
    assert.equal(coordinationRoot(aliased), aliased, 'a symlinked git dir keeps its own root');
    // A FIFO where a link file belongs is rejected without blocking.
    const registration = gitDir.replace(/^gitdir: /, '').trim();
    fs.rmSync(path.join(registration, 'commondir'));
    execFileSync('mkfifo', [path.join(registration, 'commondir')]);
    clearCoordinationRootCache();
    assert.equal(coordinationRoot(linked), linked, 'a FIFO link file is refused, not read');
    // A submodule-style link has no commondir and stays its own repository.
    const sub = path.join(base, 'sub');
    fs.mkdirSync(path.join(base, 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../modules/sub\n');
    assert.equal(coordinationRoot(sub), sub);
  } finally {
    clearCoordinationRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('file versions cache by stat identity and change with content', () => {
  clearFileVersionCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-version-'));
  try {
    const file = path.join(dir, 'source.ts');
    fs.writeFileSync(file, 'export const a = 1;\n');
    const first = fileVersion(file);
    assert.ok(first, 'readable file produces a version');
    assert.equal(fileVersion(file), first, 'unchanged file reuses the cached hash');
    fs.writeFileSync(file, 'export const a = 2;\n');
    const stat = fs.statSync(file);
    fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
    const second = fileVersion(file);
    assert.ok(second && second !== first, 'changed content produces a new version');
    assert.equal(fileVersion(file), second, 'new version caches as well');
    assert.equal(fileVersion(path.join(dir, 'missing.ts')), undefined, 'missing file stays undefined');
  } finally {
    clearFileVersionCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

