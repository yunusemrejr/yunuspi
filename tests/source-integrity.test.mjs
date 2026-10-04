import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { assertSameBytes } from "./bytes.mjs";

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

test('release templates retain current tests, installer, and public safeguards', () => {
  for (const directory of ['tests', 'scripts', 'config', '.github', '.githooks']) {
    const source = path.join(root, directory), template = path.join(root, 'release-template', directory);
    const names = [...files(source)].map(file => path.relative(source, file)).sort();
    assert.deepEqual([...files(template)].map(file => path.relative(template, file)).sort(), names, directory);
    for (const name of names)
      assertSameBytes(fs.readFileSync(path.join(template, name)), fs.readFileSync(path.join(source, name)), `${directory}/${name}`);
  }
  for (const name of ['package.json', 'package-lock.json', '.gitignore', 'AGENTS.md'])
    assertSameBytes(fs.readFileSync(path.join(root, 'release-template', name)), fs.readFileSync(path.join(root, name)), name);
});


test('installed-verifier library inventory matches the shipped TypeScript libraries', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'agent/extensions/manifest.json'), 'utf8'));
  const declared = manifest.lib.filter(file => file.endsWith('.ts')).sort();
  const shipped = fs.readdirSync(path.join(root, 'agent/extensions/lib')).filter(file => file.endsWith('.ts')).sort();
  assert.deepEqual(declared, shipped, 'new libraries must be registered for installed integrity checks');
});

test('workspace and standalone extension locks preserve every declared runtime pin', () => {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const dependencies = read('agent/npm/package.json').dependencies;
  const workspace = read('package-lock.json').packages;
  const standalone = read('agent/npm/package-lock.json').packages;
  assert.deepEqual(workspace['agent/npm'].dependencies, dependencies);
  assert.deepEqual(standalone[''].dependencies, dependencies);
  for (const [name, version] of Object.entries(dependencies)) {
    const installed = workspace[`agent/npm/node_modules/${name}`] ?? workspace[`node_modules/${name}`];
    const archived = standalone[`node_modules/${name}`];
    assert.equal(installed?.version, version, `${name}: workspace version`);
    assert.equal(archived?.version, version, `${name}: standalone version`);
    assert.equal(archived?.integrity, installed?.integrity, `${name}: both installs resolve the same pinned bytes`);
    assert.ok(archived?.integrity, `${name}: registry integrity required`);
  }
});
