import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reconcileAsyncRun } from '../agent/extensions/pi-subagents/src/runs/background/stale-run-reconciler.ts';
import { readCompletionReplay, writeCompletionReplay } from '../agent/extensions/pi-subagents/src/runs/background/completion-replay.ts';
import { removeResultIndex, resultFilePath, writeAsyncResultFile, writeAsyncResultFileIfAbsent, writePendingAsyncResultFile } from '../agent/extensions/pi-subagents/src/runs/background/result-files.ts';
import { writeGuardedStatus } from '../agent/extensions/pi-subagents/src/runs/shared/status-revision.ts';

const pid = 4321;
const now = 2500;
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 };

function dead() {
  throw Object.assign(new Error('Synthetic process exited'), { code: 'ESRCH' });
}

function fixture(t, { writeStatus = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stale-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runId = 'fixture-run';
  const sessionId = 'fixture-session';
  const asyncDir = path.join(dir, 'async', runId);
  const resultsDir = path.join(dir, 'results');
  const statusPath = path.join(asyncDir, 'status.json');
  const resultPath = resultFilePath(resultsDir, runId);
  const running = {
    runId, sessionId, mode: 'single', state: 'running', pid, runnerProcessStartIdentity: 'linux:111',
    startedAt: 1, lastUpdate: 5, steps: [{ agent: 'fixture', status: 'running' }],
  };
  const complete = { ...running, state: 'complete', lastUpdate: now + 1, endedAt: now + 1, steps: [{ agent: 'fixture', status: 'complete' }] };
  const authentic = { id: runId, sessionId, asyncDir, state: 'complete', success: true, results: [{ agent: 'fixture', success: true, usage }] };
  if (writeStatus) assert.equal(writeGuardedStatus(statusPath, running).written, true);
  return {
    runId, sessionId, asyncDir, resultsDir, statusPath, resultPath, running, complete, authentic,
    reconcile: (options = {}) => reconcileAsyncRun(asyncDir, { resultsDir, now: () => now, ...options }),
    readStatus: () => JSON.parse(fs.readFileSync(statusPath, 'utf8')),
    readResult: () => JSON.parse(fs.readFileSync(resultPath, 'utf8')),
  };
}

test('a receipt and terminal status committed during the liveness probe retain their measured usage', t => {
  const f = fixture(t);
  const repair = f.reconcile({ kill: () => {
    assert.equal(writeAsyncResultFile(f.resultPath, f.authentic).state, 'public');
    assert.equal(writeGuardedStatus(f.statusPath, f.complete).written, true);
    dead();
  } });
  assert.equal(repair.repaired, false);
  assert.equal(repair.status.state, 'complete');
  assert.equal(f.readStatus().state, 'complete');
  assert.deepEqual(f.readResult(), f.authentic);
});

test('a runner receipt left pending before status finalization repairs status with the real outcome', t => {
  const f = fixture(t);
  const repair = f.reconcile({ kill: () => {
    writePendingAsyncResultFile(f.resultPath, f.authentic);
    dead();
  } });
  assert.equal(repair.repaired, true);
  assert.equal(f.readStatus().state, 'complete');
  assert.equal(f.readStatus().steps[0].status, 'complete');
  assert.deepEqual(f.readResult(), f.authentic);
});

test('a consumed result repairs running status from its delivered replay without another notification', t => {
  const f = fixture(t);
  const repair = f.reconcile({ kill: () => {
    writeAsyncResultFile(f.resultPath, f.authentic);
    writeCompletionReplay({
      resultsDir: f.resultsDir, runId: f.runId, sessionId: f.sessionId,
      data: f.authentic, completion: { ...f.authentic, runId: f.runId }, now, ttlMs: 1000,
    });
    fs.rmSync(f.resultPath);
    removeResultIndex(f.resultsDir, f.sessionId, f.runId);
    dead();
  } });
  assert.equal(repair.repaired, true);
  assert.equal(f.readStatus().state, 'complete');
  assert.equal(fs.existsSync(f.resultPath), false);
  assert.deepEqual(readCompletionReplay(f.resultsDir, f.runId, { now }).completion.results[0].usage, usage);
  assert.equal(f.reconcile({ kill: dead }).repaired, false);
  assert.equal(fs.existsSync(f.resultPath), false);
});

test('a terminal status committed during the liveness probe survives even when its receipt was already consumed', t => {
  const f = fixture(t);
  const repair = f.reconcile({ kill: () => {
    writeGuardedStatus(f.statusPath, f.complete);
    dead();
  } });
  assert.equal(repair.repaired, false);
  assert.equal(repair.status.state, 'complete');
  assert.equal(fs.existsSync(f.resultPath), false);
});

test('old heartbeats and unverifiable liveness cannot create a failure receipt', t => {
  const f = fixture(t);
  for (const kill of [() => true, () => false, () => { throw Object.assign(new Error('Denied'), { code: 'EPERM' }); }]) {
    const outcome = f.reconcile({ kill, staleAlivePidMs: 1, readStartIdentity: () => 'linux:111' });
    assert.equal(outcome.repaired, false);
    assert.match(outcome.message, /no confirmed exit/);
    assert.equal(f.readStatus().state, 'running');
    assert.equal(fs.existsSync(f.resultPath), false);
  }
});

test('death proof applies only to the writer identity observed before the probe', t => {
  const f = fixture(t);
  const result = f.reconcile({ kill: () => {
    const current = f.readStatus();
    assert.equal(writeGuardedStatus(f.statusPath, { ...current, runnerProcessStartIdentity: 'linux:222' }).written, true);
    dead();
  } });
  assert.equal(result.repaired, false);
  assert.equal(result.status.runnerProcessStartIdentity, 'linux:222');
  assert.equal(fs.existsSync(f.resultPath), false);
});

test('verified PID reuse publishes one synthetic receipt and a normal replay does not replace it', t => {
  const f = fixture(t);
  const first = f.reconcile({ kill: () => true, readStartIdentity: () => 'linux:222' });
  assert.equal(first.repaired, true);
  assert.equal(first.status.state, 'failed');
  const published = f.readResult();
  assert.equal(published.state, 'failed');
  assert.equal(f.reconcile({ kill: dead }).repaired, false);
  assert.equal(writeAsyncResultFileIfAbsent(f.resultPath, { ...published, summary: 'Stale replacement' }), false);
  assert.deepEqual(f.readResult(), published);
});

test('a published synthetic receipt is replayable when the observer died before writing status', t => {
  const f = fixture(t);
  const synthetic = { ...f.authentic, state: 'failed', success: false, results: [{ agent: 'fixture', success: false }] };
  assert.equal(writeAsyncResultFileIfAbsent(f.resultPath, synthetic), true);
  assert.equal(f.readStatus().state, 'running');
  assert.equal(f.reconcile({ kill: dead }).status.state, 'failed');
  assert.deepEqual(f.readResult(), synthetic);
});

test('a dead child with a missing initial status can be repaired from its launch metadata', t => {
  const f = fixture(t, { writeStatus: false });
  const repair = f.reconcile({ kill: dead, startedRun: f.running });
  assert.equal(repair.repaired, true);
  assert.equal(f.readStatus().state, 'failed');
  assert.equal(f.readResult().state, 'failed');
});
