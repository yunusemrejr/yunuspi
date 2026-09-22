import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
function* files(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

test('every shipped harness script parses without executing it', async () => {
  for (const directory of ['agent/extensions', 'agent/scripts', 'scripts']) {
    for (const file of files(path.join(root, directory))) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) continue;
      const loader = file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : file.endsWith('.jsx') ? 'jsx' : 'js';
      await transform(fs.readFileSync(file, 'utf8'), { loader, sourcefile: file, logLevel: 'silent' });
    }
  }
});

test('release templates retain current tests, installer, and public safeguards', () => {
  for (const directory of ['tests', 'scripts', 'config', '.github', '.githooks']) {
    const source = path.join(root, directory), template = path.join(root, 'release-template', directory);
    const names = [...files(source)].map(file => path.relative(source, file)).sort();
    assert.deepEqual([...files(template)].map(file => path.relative(template, file)).sort(), names, directory);
    for (const name of names)
      assert.deepEqual(fs.readFileSync(path.join(template, name)), fs.readFileSync(path.join(source, name)), `${directory}/${name}`);
  }
  for (const name of ['package.json', 'package-lock.json', '.gitignore', 'AGENTS.md'])
    assert.deepEqual(fs.readFileSync(path.join(root, 'release-template', name)), fs.readFileSync(path.join(root, name)), name);
});
