import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanContent, scanPath, scanTree, scanGit } from '../scripts/check-public.mjs';
const inspect = text => scanContent('fixture.txt', Buffer.from(text));
const canary = ['canary', 'credential', 'never', 'real'].join('-');

test('credential literals, provider tokens, and URL credentials are rejected without disclosure', () => {
  const cases = [JSON.stringify({ apiKey: canary }), `PASSWORD=${canary}`, 'sk-' + 'a'.repeat(40), 'https://' + 'user:' + canary + '@example.com', JSON.stringify({ namecheap_username: canary }), JSON.stringify({ godaddy_user: canary })];
  for (const value of cases) {
    const result = inspect(value);
    assert.ok(result.length > 0);
    assert.ok(!JSON.stringify(result).includes(canary));
  }
});
test('placeholders and runtime environment lookups remain publishable', () => {
  for (const text of ['const apiKey = process.env.PROVIDER_API_KEY;', JSON.stringify({ apiKey: 'YOUR_API_KEY' }), 'PROVIDER_API_KEY=${PROVIDER_API_KEY}']) assert.deepEqual(inspect(text), []);
});
test('sensitive files and runtime paths are rejected', () => {
  for (const filename of ['.env', '.env.production', 'agent/auth.json', 'agent/settings.json', 'agent/sessions/run.jsonl', 'agent/memory/user.md', 'agent/backups/archive.zip', 'agent/tasks/record.json', 'agent/work/notes.md', 'tasks/record.json', 'work/notes.md', 'release-template/agent/sessions/private.md', 'public-template/sessions/private.md', 'docs/yunuspi-session-fixture.html', 'docs/pi-session-fixture-2026-09-20-diagnostics.json', 'nested/.git/config', 'api-key']) assert.ok(scanPath(filename).length);
  assert.deepEqual(scanPath('agent/extensions/lib/project-intelligence/query.mjs'), []);
});
test('dependency metadata is permitted but installed or private npm files are rejected', () => {
  assert.deepEqual(scanPath('agent/npm/package.json'), []);
  assert.deepEqual(scanPath('agent/npm/package-lock.json'), []);
  for (const name of ['agent/npm/.npmrc', 'agent/npm/other.json', 'agent/npm/node_modules/pkg/index.js', 'nested/node_modules/pkg/index.js']) assert.ok(scanPath(name).length);
});
test('binary exceptions cannot authorize altered or renamed bytes', () => {
  for (const name of ['agent/extensions/pi-lens/grammars/tree-sitter-python.wasm', 'unreviewed.wasm']) assert.ok(scanContent(name, Buffer.from([0, 97, 115, 109])).some(f => f.rule === 'binary-unreviewed-file'));
});
test('public browser derivation exception never exempts other credentials', () => {
  const name = 'agent/extensions/pi-web-access/chrome-cookies.ts';
  assert.ok(scanContent(name, Buffer.from(JSON.stringify({ password: canary }))).some(f => f.rule === 'credential-literal'));
});
test('symlinks and nested Git trees are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-safety-'));
  try {
    fs.symlinkSync('/nonexistent', path.join(dir, 'link'));
    fs.mkdirSync(path.join(dir, 'nested', '.git'), { recursive: true });
    const result = scanTree(dir);
    assert.ok(result.some(f => f.rule === 'symlink'));
    assert.ok(result.some(f => f.rule === 'unsafe-path'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('tracked ignored files and deleted historical credentials cannot bypass the gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-git-'));
  const git = args => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git(['init', '-q']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'hidden.txt\n');
    fs.writeFileSync(path.join(dir, 'hidden.txt'), JSON.stringify({ apiKey: canary }));
    git(['add', '.gitignore']); git(['add', '-f', 'hidden.txt']);
    assert.ok(scanGit(dir, { history: false }).some(f => f.origin === 'index' && f.rule === 'credential-literal'));
    git(['commit', '-qm', 'fixture']); git(['rm', 'hidden.txt']); git(['commit', '-qm', 'remove fixture']);
    assert.ok(scanGit(dir).some(f => f.origin === 'history' && f.rule === 'credential-literal'));
    assert.deepEqual(scanTree(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('identical blobs cannot reuse a binary exemption at an unreviewed path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-binary-path-'));
  const git = args => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git(['init', '-q']);
    const allowed = 'docs/assets/graph-demo.png';
    fs.mkdirSync(path.join(dir, 'docs/assets'), { recursive: true });
    const bytes = fs.readFileSync(new URL('../' + allowed, import.meta.url));
    fs.writeFileSync(path.join(dir, allowed), bytes);
    fs.writeFileSync(path.join(dir, 'unreviewed.png'), bytes);
    git(['add', '.']);
    const findings = scanGit(dir, { history: false });
    assert.equal(findings.some(f => f.path === allowed), false);
    assert.ok(findings.some(f => f.path === 'unreviewed.png' && f.rule === 'binary-unreviewed-file'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('generated caches are skipped but shipped dist source is still scanned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-cache-'));
  try {
    for (const folder of ['node_modules/pkg', 'core/ai/dist', 'agent/scripts/__pycache__', 'agent/extensions/pi-lens/dist']) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, 'fixture.js'), JSON.stringify({ apiKey: canary }));
    }
    assert.deepEqual(scanTree(dir).map(f => f.path), ['agent/extensions/pi-lens/dist/fixture.js']);
    assert.ok(scanPath('agent/scripts/__pycache__/fixture.pyc').length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retired Guardian binary is accepted only as exact reviewed history, never reintroduced or renamed', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/guardian-similarity-v1.json', import.meta.url)));
  const bytes = Buffer.from(fixture.base64, 'base64');
  const name = 'core/coding-agent/src/core/guardian/similarity.wasm';
  assert.ok(scanContent(name, bytes).some(f => f.rule === 'binary-unreviewed-file'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-binary-history-'));
  const git = args => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git(['init', '-q']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes); git(['add', '.']); git(['commit', '-qm', 'old reviewed kernel']);
    assert.ok(scanGit(dir).some(f => f.origin === 'index' && f.rule === 'binary-unreviewed-file'));
    git(['rm', name]); git(['commit', '-qm', 'retire old kernel']);
    assert.deepEqual(scanGit(dir), [], 'the reviewed public kernel remains valid historical provenance');
    fs.writeFileSync(path.join(dir, 'renamed.wasm'), bytes); git(['add', '.']); git(['commit', '-qm', 'renamed bytes']);
    git(['rm', 'renamed.wasm']); git(['commit', '-qm', 'remove renamed bytes']);
    assert.ok(scanGit(dir).some(f => f.origin === 'history' && f.path === 'renamed.wasm' && f.rule === 'binary-unreviewed-file'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
