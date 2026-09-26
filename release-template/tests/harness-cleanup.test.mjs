import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanupHarness } from '../agent/scripts/cleanup-harness.mjs';

const sid = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const epoch = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yunuspi-cleanup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.pi'), now = Date.now();
  const active = path.join(root, 'sibling-bridge/active');
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(path.join(root, 'reminders'));
  const state = path.join(root, `reminders/state-${sid}.json`);
  await fs.writeFile(state, JSON.stringify({ startedAt: now - 10 * 86400000, manual: [] }));
  await fs.utimes(state, new Date(now - 10 * 86400000), new Date(now - 10 * 86400000));
  const hash = createHash('sha1').update(home).digest('hex').slice(0, 16);
  const marker = path.join(active, `${hash}--${sid}--${epoch}.closed.json`);
  const retired = { kind: 'root', sid, root: home, bridgeEpoch: epoch, bridgeStartedAt: now - 10000, closedAt: now - 5000 };
  return { home, now, active, state, marker, retired };
}

test('closed peer identity receipts do not block housekeeping or override a live heartbeat', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.marker, JSON.stringify(f.retired));
  const preview = await cleanupHarness(f);
  assert.equal(preview.planned['idle-reminders'].files, 1);
  await fs.access(f.state);
  const heartbeat = path.join(f.active, 'live.json');
  await fs.writeFile(heartbeat, JSON.stringify({ sid, pid: process.pid }));
  assert.equal((await cleanupHarness({ ...f, apply: true })).protectedSessions, 1);
  await fs.access(f.state);
  await fs.unlink(heartbeat);
  assert.equal((await cleanupHarness({ ...f, apply: true })).completed['idle-reminders'], 1);
  await assert.rejects(fs.access(f.state), { code: 'ENOENT' });
  await fs.access(f.marker);
});

test('malformed or mismatched closed receipts still fail closed before deleting state', async t => {
  const f = await fixture(t);
  for (const record of [null, {}, { ...f.retired, bridgeEpoch: sid }, { ...f.retired, root: f.home + '-other' }, { ...f.retired, closedAt: 0 }, { ...f.retired, pid: process.pid }]) {
    await fs.writeFile(f.marker, JSON.stringify(record));
    await assert.rejects(cleanupHarness({ ...f, apply: true }), /Unverifiable/);
    await fs.access(f.state);
  }
});

test('scheduled cleanup shares the installation lease and serializes competing cleaners', async t => {
  const f = await fixture(t);
  const logs = path.join(f.home, '.pi/agent/logs');
  await fs.mkdir(logs, { recursive: true });
  const bin = path.join(f.home, 'bin'), invoked = path.join(f.home, 'invoked');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'node'), '#!/bin/sh\nprintf ran > "$HOME/invoked"\n', { mode: 0o700 });
  const wrapper = path.resolve(import.meta.dirname, '../agent/scripts/cleanup-harness.sh');
  const run = (mode, lock) => spawnSync('flock', [mode, path.join(logs, lock), '/bin/bash', wrapper], {
    env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5000,
  });
  for (const [mode, lock] of [['--exclusive', 'harness-session.lock'], ['--exclusive', 'harness-update.lock']]) {
    const result = run(mode, lock);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(fs.access(invoked), { code: 'ENOENT' });
  }
  const allowed = run('--shared', 'harness-session.lock');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(await fs.readFile(invoked, 'utf8'), 'ran');
});
