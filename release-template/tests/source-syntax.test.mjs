import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

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

test('every shipped extension file parses with the runtime loader, which is stricter than esbuild', () => {
  const run = files => spawnSync(process.execPath, [path.join(root, 'scripts/check-syntax.mjs'), ...files], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const extensions = [...files(path.join(root, 'agent/extensions'))].filter(file => /\.m?ts$/.test(file) && !file.endsWith('.d.ts')).map(file => path.relative(root, file));
  const all = run(extensions);
  assert.equal(all.status, 0, all.stderr || all.stdout);
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-syntax-')), 'probe.ts');
  try {
    fs.writeFileSync(probe, 'const description = "sum:"Amount"";\n');
    const broken = run([probe]);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /cannot be parsed by the extension loader/);
  } finally { fs.rmSync(path.dirname(probe), { recursive: true, force: true }); }
});

