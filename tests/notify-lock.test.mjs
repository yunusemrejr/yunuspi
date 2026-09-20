import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireDirectoryLock} from '../agent/scripts/lib/directory-lock.mjs';

function error(code) {
  return Object.assign(new Error(code), {code});
}

test('directory lock bounds persistent inspection errors by deadline and backoff', () => {
  let now = 0;
  let waits = 0;
  const fs = {
    mkdirSync: () => { throw error('EEXIST'); },
    statSync: () => { throw error('EACCES'); },
    rmSync: () => assert.fail('an uninspected lock must not be removed'),
    writeFileSync: () => assert.fail('a contended lock must not create a token'),
    unlinkSync: () => assert.fail('a contended lock must not remove a token'),
    rmdirSync: () => assert.fail('a contended lock must not be released'),
  };
  assert.throws(
    () => acquireDirectoryLock('/fixture/state.lock', {
      fs,
      now: () => now,
      wait: delay => { waits++; now += delay; },
      waitMs: 30,
      pollMs: 10,
      label: 'state lock',
    }),
    /state lock timeout/,
  );
  assert.equal(now, 30);
  assert.equal(waits, 3);
});

test('directory lock retries a lock that vanished during inspection', () => {
  let mkdirCalls = 0;
  let tokenWritten = false;
  let tokenRemoved = false;
  let released = false;
  const fs = {
    mkdirSync: () => {
      mkdirCalls++;
      if (mkdirCalls === 1) throw error('EEXIST');
    },
    statSync: () => { throw error('ENOENT'); },
    writeFileSync: () => { tokenWritten = true; },
    unlinkSync: () => { tokenRemoved = true; },
    rmdirSync: () => { released = true; },
  };
  const release = acquireDirectoryLock('/fixture/state.lock', {fs, now: () => 0});
  assert.equal(mkdirCalls, 2);
  assert.equal(tokenWritten, true);
  release();
  assert.equal(tokenRemoved, true);
  assert.equal(released, true);
});

test('an old owner cannot remove a replacement lock after stale takeover', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-lock-owner-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const lockDir = path.join(dir, 'state.lock');
  const releaseOld = acquireDirectoryLock(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);
  const releaseReplacement = acquireDirectoryLock(lockDir, {staleAfterMs: 1, waitMs: 100});
  const replacementTokens = fs.readdirSync(lockDir);
  assert.equal(replacementTokens.length, 1);
  releaseOld();
  assert.equal(fs.existsSync(lockDir), true);
  assert.deepEqual(fs.readdirSync(lockDir), replacementTokens);
  releaseReplacement();
  assert.equal(fs.existsSync(lockDir), false);
});
