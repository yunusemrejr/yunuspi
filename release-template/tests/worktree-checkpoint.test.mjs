import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = [path.join(root, 'agent'), path.resolve(root, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'extensions/lib/worktree-checkpoint.ts')),
);
assert.ok(agentRoot, 'worktree checkpoint ships with the distribution');
const { checkpointWorktree, exitFallbackSummary, parsePorcelainZ, FALLBACK_SUMMARY_MIN_CHARS } =
  await import(pathToFileURL(path.join(agentRoot, 'extensions/lib/worktree-checkpoint.ts')));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('a dirty worktree is snapshotted to a private ref without touching branch, index or files', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-checkpoint-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await checkpointWorktree(repo, 'clean-session', 'pre-run'), { status: 'clean' }, 'a clean tree needs no snapshot');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'export {}\n');
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored', 'big.bin'), 'x');
  git(repo, 'add', 'a.txt');
  const indexBefore = git(repo, 'diff', '--cached', '--name-only');

  const snap = await checkpointWorktree(repo, '01a0d9f8-47fc', 'shutdown');
  assert.equal(snap.status, 'snapshotted');
  assert.equal(snap.ref, 'refs/yunuspi/checkpoints/01a0d9f8-47fc');
  assert.equal(snap.changedCount, 2);
  assert.deepEqual(git(repo, 'show', `${snap.ref}:src/new.js`), 'export {}');
  assert.equal(git(repo, 'show', `${snap.ref}:a.txt`), 'two');
  assert.throws(() => git(repo, 'show', `${snap.ref}:ignored/big.bin`), 'ignored files stay out');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'branch unchanged');
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), indexBefore, 'user index unchanged');
  assert.equal(git(repo, 'status', '--porcelain', '--', 'src'), '?? src/', 'untracked files stay untracked');
  assert.equal(git(repo, 'stash', 'list'), '', 'no stash entries');
});

test('the fallback exit summary is deterministic, content-bearing and above the minimum length', () => {
  const branch = [
    { type: 'message', message: { role: 'user', content: 'Build the dashboard and do not stop until done' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Charts wired; tests next.' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Also make it more visual' }] } },
  ];
  const text = exitFallbackSummary({
    sessionId: 's', reason: 'model summary unavailable', branch,
    todos: { pending: 2, inProgress: 1 },
    checkpoint: { ref: 'refs/yunuspi/checkpoints/s', commit: 'abcdef1234567890', changedCount: 32, changed: ['a.js', 'b.css'], reused: false },
  });
  assert.ok(text.length > FALLBACK_SUMMARY_MIN_CHARS);
  assert.match(text, /Also make it more visual/);
  assert.match(text, /First demand: Build the dashboard/);
  assert.match(text, /NOT finished/);
  assert.match(text, /32 changed path\(s\)/);
  assert.match(text, /git diff HEAD refs\/yunuspi\/checkpoints\/s/);
  assert.ok(exitFallbackSummary({ sessionId: 's', reason: 'x', branch: [] }) === undefined, 'no demand, no record');
  const bare = exitFallbackSummary({ sessionId: 's', reason: 'x', branch: branch.slice(0, 1) });
  assert.ok(bare.length > FALLBACK_SUMMARY_MIN_CHARS, 'minimum holds without todos or a checkpoint');
});

test('non-repositories, oversized trees and git failures classify instead of vanishing', async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const outside = await checkpointWorktree(plain, 'plain-session', 'pre-run');
  assert.equal(outside.status, 'not-git');
  assert.match(outside.reason, /not a git worktree/);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-big-'));
  t.after(() => { try { fs.chmodSync(path.join(repo, '.git'), 0o755); } catch {} fs.rmSync(repo, { recursive: true, force: true }); });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(repo, `file-${i}.txt`), 'x\n');
  const big = await checkpointWorktree(repo, 'big-session', 'pre-run');
  assert.equal(big.status, 'skipped');
  assert.match(big.reason, /exceed.*5000-path snapshot bound/);

  fs.writeFileSync(path.join(repo, '.git', 'index'), 'corrupt-index-bytes');
  const broken = await checkpointWorktree(repo, 'broken-session', 'pre-run');
  assert.equal(broken.status, 'failed', 'an unreadable index is a failed inspection, not a clean tree');
  assert.ok(broken.reason.length > 0 && broken.reason.length <= 160);
});

test('the exit summary only claims a clean tree when git status established it', () => {
  const branch = [{ type: 'message', message: { role: 'user', content: 'Build the dashboard' } }];
  const input = (checkpoint) => ({ sessionId: 's', reason: 'model summary unavailable', branch, checkpoint });
  assert.match(exitFallbackSummary(input({ status: 'clean' })), /verified a clean tree/);
  assert.match(exitFallbackSummary(input({ status: 'not-git', reason: 'not a git worktree' })), /UNKNOWN/);
  assert.match(exitFallbackSummary(input({ status: 'failed', reason: 'git status failed' })), /UNKNOWN/);
  assert.match(exitFallbackSummary(input({ status: 'skipped', reason: 'huge' })), /UNKNOWN/);
  assert.doesNotMatch(exitFallbackSummary(input(undefined)), /none detected/);
  assert.match(exitFallbackSummary(input(undefined)), /UNKNOWN/);
  const legacy = exitFallbackSummary(input({ ref: 'refs/yunuspi/checkpoints/s', commit: 'abcdef1234567890', changedCount: 2, changed: ['a.js'], reused: false }));
  assert.match(legacy, /2 changed path\(s\)/);
});

test('porcelain -z parsing keeps rename targets and skips their sources', () => {
  assert.deepEqual(parsePorcelainZ(' M a.txt\0R  new.txt\0old.txt\0?? dir/x y.js\0'), ['a.txt', 'new.txt', 'dir/x y.js']);
});
