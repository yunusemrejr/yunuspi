import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
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
