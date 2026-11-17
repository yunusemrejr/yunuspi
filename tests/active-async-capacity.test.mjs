import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey, getActiveAsyncCapacitySnapshot, inspectActiveAsyncCapacityOwner, transferActiveAsyncCapacity,
} from '../agent/extensions/pi-subagents/src/runs/background/active-async-capacity.ts';

const capacityUrl = new URL('../agent/extensions/pi-subagents/src/runs/background/active-async-capacity.ts', import.meta.url).href;
const linuxOnly = { skip: process.platform !== 'linux', timeout: 15_000 };

function fixture(t, label, kind = 'runner') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-active-capacity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { sessionId: `session-${label}`, limit: 1, runId: `original-${label}`, kind, asyncDir: path.join(directory, 'run') };
  const options = { rootDir: path.join(directory, 'slots') };
  const inspect = (runId = input.runId) => inspectActiveAsyncCapacityOwner({ sessionId: input.sessionId, runId }, options);
  const snapshot = () => getActiveAsyncCapacitySnapshot(input.sessionId, input.limit, options);
  const replacement = () => acquireActiveAsyncCapacity({ ...input, runId: `next-${label}`, asyncDir: path.join(directory, 'next') }, options);
  const ownerFile = () => path.join(inspect().slotDir, 'owner.json');
  return { input, options, snapshot, inspect, replacement, ownerFile };
}

async function reserveInProcess(t, f, action = 'acquireActiveAsyncCapacity(input, options);') {
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    import { acquireActiveAsyncCapacity, transferActiveAsyncCapacity } from ${JSON.stringify(capacityUrl)};
    const input = ${JSON.stringify(f.input)};
    const options = ${JSON.stringify(f.options)};
    ${action}
    process.send('reserved');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  assert.equal(await Promise.race([
    once(child, 'message').then(([message]) => message),
    closed.then(([code, signal]) => `closed: ${code ?? signal}`),
  ]), 'reserved');
  return async () => {
    child.kill('SIGKILL');
    assert.deepEqual(await closed, [null, 'SIGKILL']);
  };
}

test('a fresh occupied async slot can be reused immediately after its unbound creator dies', linuxOnly, async t => {
  const f = fixture(t, 'crash');
  const kill = await reserveInProcess(t, f);
  assert.equal(f.snapshot().used, 1);
  assert.throws(f.replacement, { name: 'ActiveAsyncCapacityError' });
  await kill();
  assert.equal(fs.existsSync(f.input.asyncDir), false, 'no runner or status was started');
  assert.equal(f.inspect().release.unstartedReservation, true);
  assert.equal(f.snapshot().used, 0);
  const next = f.replacement();
  assert.equal(f.snapshot().used, 1);
  assert.equal(f.inspect().relation, 'none');
  assert.equal(next.rollback(), true);
});

test('a crash after publishing the slot directory but before writing the owner releases only a qualified new slot', linuxOnly, async t => {
  for (const label of ['new-publication', 'legacy-publication']) {
    const f = fixture(t, label);
    const kill = await reserveInProcess(t, f, `
      const mkdir = fs.mkdirSync;
      fs.mkdirSync = (dir, ...args) => {
        const result = mkdir(dir, ...args);
        if (path.basename(dir) === 'slot-0') {
          process.send('reserved');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
        }
        return result;
      };
      syncBuiltinESMExports();
      acquireActiveAsyncCapacity(input, options);
    `);
    const slotPath = path.join(f.options.rootDir, activeAsyncCapacitySessionKey(f.input.sessionId), 'slot-0');
    assert.deepEqual(fs.readdirSync(slotPath), []);
    assert.equal(f.snapshot().used, 1);
    assert.throws(f.replacement, { name: 'ActiveAsyncCapacityError' });
    await kill();
    if (label === 'legacy-publication') {
      // An older publisher can win canonical mkdir after a new intent exists.
      fs.chmodSync(slotPath, 0o700);
      assert.equal(f.snapshot().used, 1);
      assert.throws(f.replacement, { name: 'ActiveAsyncCapacityError' });
    } else {
      assert.equal(f.snapshot().used, 0);
      assert.equal(f.replacement().rollback(), true);
    }
  }
});

test('a second reaper cannot steal a live claim even when its timestamp is old', linuxOnly, async t => {
  const f = fixture(t, 'race');
  const kill = await reserveInProcess(t, f);
  const claimPath = path.join(path.dirname(f.ownerFile()), 'capacity.claim');
  await kill();
  let reads = 0;
  const snapshot = getActiveAsyncCapacitySnapshot(f.input.sessionId, 1, {
    ...f.options,
    pidLiveness: () => {
      if (++reads === 2) {
        const expired = new Date(Date.now() - 120_000);
        fs.utimesSync(claimPath, expired, expired);
        assert.equal(f.snapshot().used, 1);
        assert.throws(f.replacement, { name: 'ActiveAsyncCapacityError' });
      }
      return 'dead';
    },
  });
  assert.equal(snapshot.used, 0);
  const successor = f.replacement();
  assert.equal(f.inspect('next-race').relation, 'current');
  assert.equal(successor.rollback(), true);
});

test('a dead creator with a foreign namespace or missing creator proof retains capacity', linuxOnly, async t => {
  for (const [label, alter] of [
    ['foreign', owner => { owner.creator = { ...owner.creator, pidNamespace: 'pid:[0]' }; }],
    ['legacy', owner => { delete owner.creator; }],
  ]) {
    const f = fixture(t, label);
    const kill = await reserveInProcess(t, f);
    const ownerFile = f.ownerFile();
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    alter(owner);
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    await kill();
    assert.equal(f.snapshot().used, 1);
    assert.throws(f.replacement, { name: 'ActiveAsyncCapacityError' });
  }
});

test('a durable runner binding keeps capacity after the creator dies', linuxOnly, async t => {
  const bound = fixture(t, 'bound');
  const killBound = await reserveInProcess(t, bound, `acquireActiveAsyncCapacity(input, options).markStarted('runner-instance');`);
  await killBound();
  assert.equal(bound.inspect().owner.runnerProcessInstanceId, 'runner-instance');
  assert.equal(bound.snapshot().used, 1);
});

test('a provisionally transferred revival restores its paused predecessor after the transferrer dies', linuxOnly, async t => {
  const transferred = fixture(t, 'transfer');
  const first = acquireActiveAsyncCapacity(transferred.input, transferred.options);
  first.markStarted('source-instance');
  fs.mkdirSync(transferred.input.asyncDir);
  fs.writeFileSync(path.join(transferred.input.asyncDir, 'status.json'), JSON.stringify({
    mode: 'single', runId: transferred.input.runId, sessionId: transferred.input.sessionId, state: 'paused', steps: [],
  }));
  const killTransfer = await reserveInProcess(t, transferred, `
    transferActiveAsyncCapacity({ ...input, sourceRunId: input.runId, runId: 'revival', asyncDir: input.asyncDir + '-revival' }, options);
  `);
  assert.equal(transferred.inspect().relation, 'source');
  assert.equal(transferred.snapshot().used, 1);
  const provisional = transferred.inspect('revival').owner;
  assert.equal(provisional.runnerProcessInstanceId, undefined);
  await killTransfer();
  const retry = transferActiveAsyncCapacity({ ...transferred.input, sourceRunId: transferred.input.runId,
    runId: 'second-revival', asyncDir: transferred.input.asyncDir + '-second' }, transferred.options);
  assert.ok(retry.owner.generation > provisional.generation + 1);
  assert.equal(retry.owner.transferPredecessor.runnerProcessInstanceId, 'source-instance');
  assert.equal(retry.rollback(), true);
  assert.equal(transferred.inspect().relation, 'current');
  assert.throws(() => first.markStarted('stale'), /ownership changed/);
  assert.throws(transferred.replacement, { name: 'ActiveAsyncCapacityError' });
});

test('a dead claimant and its unstarted reservation can be reclaimed from the same slot', linuxOnly, async t => {
  const f = fixture(t, 'dead-lock');
  const kill = await reserveInProcess(t, f, `
    options.writeOwner = () => {
      process.send('reserved');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    };
    acquireActiveAsyncCapacity(input, options).markStarted('never-committed');
  `);
  const claim = path.join(path.dirname(f.ownerFile()), 'capacity.claim');
  assert.equal(fs.existsSync(claim), true);
  await kill();
  assert.equal(f.snapshot().used, 0);
  assert.equal(f.replacement().rollback(), true);
});

test('workflow startup failure rolls back, and only an unmarked dead workflow frees capacity', linuxOnly, async t => {
  const failed = fixture(t, 'workflow-failed', 'workflow');
  const slot = acquireActiveAsyncCapacity(failed.input, { ...failed.options, writeOwner() { throw new Error('synthetic write failure'); } });
  assert.throws(() => slot.markWorkflowStarted(), /write failure/);
  assert.equal(slot.rollback(), true);
  assert.equal(failed.snapshot().used, 0);

  for (const phase of ['unmarked', 'prepared', 'started']) {
    const f = fixture(t, `workflow-${phase}`, 'workflow');
    const kill = await reserveInProcess(t, f, `
      const slot = acquireActiveAsyncCapacity(input, options);
      fs.mkdirSync(input.asyncDir);
      fs.writeFileSync(path.join(input.asyncDir, 'status.json'), JSON.stringify({
        mode: 'workflow', runId: input.runId, sessionId: input.sessionId, state: 'running', steps: [],
      }));
      ${phase === 'unmarked' ? '' : 'slot.markWorkflowPrepared();'}
      ${phase === 'started' ? 'slot.markWorkflowStarted();' : ''}
    `);
    await kill();
    assert.equal(f.snapshot().used, Number(phase === 'started'));
    if (phase !== 'started') assert.equal(f.replacement().rollback(), true);
  }
});
