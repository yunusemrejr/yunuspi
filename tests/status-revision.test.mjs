import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(path.join(root, 'agent/extensions/pi-subagents/src/runs/shared/status-revision.ts')).href;
const {updateGuardedStatus, writeGuardedStatus} = await import(moduleUrl);

function runWriter(statusPath, state, startAt) {
  const terminal = state === 'complete';
  const source = `
    import {writeGuardedStatus} from ${JSON.stringify(moduleUrl)};
    while (Date.now() < ${startAt}) {}
    writeGuardedStatus(${JSON.stringify(statusPath)}, {
      state: ${JSON.stringify(state)},
      lastUpdate: ${terminal ? 200 : 100},
      endedAt: ${terminal ? 200 : 0},
      payload: 'x'.repeat(${terminal ? 0 : 2_000_000})
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {stdio: 'ignore'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`status writer exited ${code ?? signal}`)));
  });
}

test('guarded status writes serialize the read-decision-rename transaction across processes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-revision-race-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const statusPath = path.join(dir, 'status.json');
  const startAt = Date.now() + 300;
  await Promise.all([
    runWriter(statusPath, 'complete', startAt),
    ...Array.from({length: 10}, () => runWriter(statusPath, 'running', startAt)),
  ]);
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(status.state, 'complete', 'a late non-terminal writer must not replace a terminal status');
  assert.equal(fs.existsSync(`${statusPath}.write-lock`), false, 'the transaction lock is released');
});

test('status overlays derive from the latest guarded revision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-revision-overlay-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const statusPath = path.join(dir, 'status.json');
  const first = writeGuardedStatus(statusPath, {state: 'complete', lastUpdate: 10, result: 'kept'});
  const overlay = updateGuardedStatus(statusPath, current => ({...current, processTerminal: {state: 'observed'}}));
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(first.written, true);
  assert.equal(overlay.written, true);
  assert.equal(status.state, 'complete');
  assert.equal(status.result, 'kept');
  assert.deepEqual(status.processTerminal, {state: 'observed'});
  assert.equal(status.revision, first.revision + 1);
  const runningPath = path.join(dir, 'running.json');
  writeGuardedStatus(runningPath, {state: 'running', lastUpdate: 1});
  updateGuardedStatus(runningPath, current => ({...current, marker: 'newer'}));
  const unversioned = writeGuardedStatus(runningPath, {state: 'running', lastUpdate: 99});
  assert.equal(unversioned.written, false, 'an unversioned stale payload cannot bypass revision ordering');
  assert.equal(unversioned.reason, 'stale-revision');
});

test('an old status writer cannot remove a replacement lock after stale takeover', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-revision-owner-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const statusPath = path.join(dir, 'status.json');
  writeGuardedStatus(statusPath, {state: 'running', lastUpdate: 1});
  const lockDir = `${statusPath}.write-lock`;
  const replacementToken = 'replacement-owner';
  updateGuardedStatus(statusPath, () => {
    fs.rmSync(lockDir, {recursive: true, force: true});
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, replacementToken), '');
    return undefined;
  });
  assert.equal(fs.existsSync(lockDir), true);
  assert.deepEqual(fs.readdirSync(lockDir), [replacementToken]);
});
