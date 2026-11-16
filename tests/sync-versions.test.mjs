import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
test('release metadata check detects lock drift and repairs only owned versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-version-'));
  try {
    for (const file of ['package.json', 'package-lock.json', 'core/identity.json', 'scripts/sync-versions.mjs', ...['agent', 'ai', 'chord', 'coding-agent', 'telemetry', 'tui'].map(name => `core/${name}/package.json`)]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const run = (...args) => spawnSync(process.execPath, ['scripts/sync-versions.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version;
    assert.equal(run(current).status, 0);
    const before = fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8');
    for (const args of [['00.2.0'], ['0.2.0-01'], ['0.2.0', '0.3.0'], ['0.2.0', '--write', '--write']]) {
      const invalid = run(...args, '--write');
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Usage:/);
      assert.equal(fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8'), before);
    }
    assert.equal(run('0.0.99').status, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'core/identity.json'), 'utf8'), before);
    const lockBefore = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
    assert.equal(run('0.0.99', '--write').status, 0);
    assert.equal(run('0.0.99').status, 0);
    const lockAfter = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
    for (const [name, data] of Object.entries(lockBefore.packages)) if (name.startsWith('node_modules/') && !name.startsWith('node_modules/@yunuspi/')) assert.deepEqual(lockAfter.packages[name], data);
    const oldIdentity = JSON.parse(before), newIdentity = JSON.parse(fs.readFileSync(path.join(dir, 'core/identity.json')));
    delete oldIdentity.version; delete newIdentity.version; assert.deepEqual(newIdentity, oldIdentity);
    lockAfter.packages['core/agent'].version = '0.0.1';
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lockAfter));
    assert.equal(run('0.0.99').status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
