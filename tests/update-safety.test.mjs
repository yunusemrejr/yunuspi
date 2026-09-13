import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'scripts/core-update.mjs')));
const {promoteCandidate, recoverInterruptedUpdate, customizationDigest, launcherSpec} =
  await import(pathToFileURL(path.join(agent, 'scripts/core-update.mjs')));
const {CORE_COMPATIBILITY_TESTS} = await import(pathToFileURL(path.join(agent, 'scripts/lib/core-compatibility.mjs')));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-public-update-'));
  const core = path.join(dir, 'core'), candidate = path.join(dir, 'candidate'), journal = path.join(dir, 'journal');
  for (const [file, text] of [[core, 'customized previous'], [candidate, 'upstream candidate']]) {
    fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'value'), text);
  }
  return {dir, core, candidate, journal};
}
const value = file => fs.readFileSync(path.join(file, 'value'), 'utf8');

test('public releases include every required offline compatibility check', () => {
  assert.equal(new Set(CORE_COMPATIBILITY_TESTS).size, CORE_COMPATIBILITY_TESTS.length);
  assert.ok(CORE_COMPATIBILITY_TESTS.includes('harness-load-test.mjs'));
  for (const name of CORE_COMPATIBILITY_TESTS) {
    const file = path.join(agent, 'scripts/compatibility', name);
    assert.ok(fs.statSync(file).isFile(), name);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /import\s+["'][^"']*bench\//);
  }
});

test('a public installation can validate without private systemd units', () => {
  const source = fs.readFileSync(path.join(agent, 'scripts/verify-harness.mjs'), 'utf8');
  const section = source.slice(source.indexOf('  // ── 3a.'), source.indexOf('  // The normal CLI'));
  let optional = false;
  vm.runInNewContext(section, {manifest: {supportFiles: []}, console: {log() {}},
    info: () => {optional = true;}, bad: assert.fail});
  assert.equal(optional, true);
});

test('a failed candidate restores the exact customized core', async () => {
  const f = fixture();
  try {
    const original = fs.statSync(f.core).ino;
    await assert.rejects(promoteCandidate({...f, validate: async () => {
      assert.equal(value(f.core), 'upstream candidate');
      throw Error('synthetic compatibility failure');
    }}), /previous core restored/);
    assert.equal(value(f.core), 'customized previous');
    assert.equal(fs.statSync(f.core).ino, original);
    assert.equal(fs.existsSync(f.journal), false);
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('missing rollback data keeps recovery pending instead of trusting the candidate', async () => {
  const f = fixture();
  try {
    const previous = fs.statSync(f.core), next = fs.statSync(f.candidate);
    fs.renameSync(f.core, path.join(f.dir, 'lost'));
    fs.renameSync(f.candidate, f.core);
    fs.writeFileSync(f.journal, JSON.stringify({core: f.core, backup: path.join(f.dir, '.pi-core-last-good'),
      rejected: path.join(f.dir, '.pi-core-rejected'), phase: 'validating',
      originalIdentity: `${previous.dev}:${previous.ino}`, candidateIdentity: `${next.dev}:${next.ino}`}));
    assert.throws(() => recoverInterruptedUpdate(f.core, f.journal), /cannot be attested/);
    assert.ok(fs.existsSync(f.journal));
    assert.equal(value(f.core), 'upstream candidate');
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('busy maintenance leaves both core directories untouched', async () => {
  const f = fixture();
  try {
    await assert.rejects(promoteCandidate({...f, idle: () => [1], validate: () => assert.fail('must not validate')}), /deferred/);
    assert.equal(value(f.core), 'customized previous');
    assert.equal(value(f.candidate), 'upstream candidate');
    assert.equal(fs.existsSync(f.journal), false);
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('linked skills and permission changes invalidate the customization digest', () => {
  const f = fixture();
  try {
    const skills = path.join(f.dir, 'skills'), external = path.join(f.dir, 'external.md');
    fs.mkdirSync(skills); fs.writeFileSync(external, 'original'); fs.symlinkSync(external, path.join(skills, 'linked.md'));
    const before = customizationDigest(f.dir);
    fs.writeFileSync(external, 'changed'); assert.notEqual(customizationDigest(f.dir), before);
    const changed = customizationDigest(f.dir);
    fs.chmodSync(external, 0o700); assert.notEqual(customizationDigest(f.dir), changed);
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});

test('launcher rejects upstream entrypoints that escape the package', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.core, 'package.json'), JSON.stringify({bin: {pi: '../other.js'}}));
    assert.throws(() => launcherSpec(f.core), /Unsupported/);
  } finally { fs.rmSync(f.dir, {recursive: true, force: true}); }
});
