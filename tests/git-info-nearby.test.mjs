import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { repositoriesBelow, default: gitTools } = await import(pathToFileURL(path.join(root, 'agent/extensions/git-tools.ts')));
const makeRepo = (dir) => { fs.mkdirSync(dir, { recursive: true }); execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' }); };

test('repositoriesBelow finds repositories one and two levels down, skips dependency folders and stays bounded', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-below-'));
  try {
    makeRepo(path.join(home, 'alpha'));
    makeRepo(path.join(home, 'work', 'beta'));
    makeRepo(path.join(home, 'node_modules', 'ignored'));
    makeRepo(path.join(home, 'a', 'b', 'too-deep'));
    fs.mkdirSync(path.join(home, 'plain'));
    assert.deepEqual(repositoriesBelow(home).sort(), ['alpha', path.join('work', 'beta')]);
    for (let i = 0; i < 12; i++) makeRepo(path.join(home, `many-${i}`));
    assert.equal(repositoriesBelow(home, 5).length, 5, 'the list honors its limit');
    assert.deepEqual(repositoriesBelow(path.join(home, 'does-not-exist')), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('git_info outside a repository names the repositories below the working directory', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'git-info-parent-'));
  try {
    makeRepo(path.join(home, 'project'));
    const tools = new Map();
    gitTools({ registerTool: (tool) => tools.set(tool.name, tool), on() {} });
    const result = await tools.get('git_info').execute('t', { action: 'status' }, undefined, undefined, { cwd: home });
    assert.equal(result.details.repository, false);
    assert.deepEqual(result.details.repositoriesBelow, ['project']);
    assert.match(result.content[0].text, /No Git repository at .*or its parents.*Repositories found below it: project/s);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'git-info-bare-'));
    try {
      const plain = await tools.get('git_info').execute('t', { action: 'log' }, undefined, undefined, { cwd: bare });
      assert.equal(plain.details.repositoriesBelow, undefined);
      assert.doesNotMatch(plain.content[0].text, /Repositories found below/);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
