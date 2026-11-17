import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { waitForImportedAsyncRoot } from '../agent/extensions/pi-subagents/src/runs/background/chain-root-attachment.ts';
import { reconcileAsyncRun } from '../agent/extensions/pi-subagents/src/runs/background/stale-run-reconciler.ts';
import { resultCandidateFilesForSession, resultFilePath, workflowAwaitedAsyncResultPath, writeAsyncResultFile, writePendingAsyncResultFile } from '../agent/extensions/pi-subagents/src/runs/background/result-files.ts';
import { writeGuardedStatus } from '../agent/extensions/pi-subagents/src/runs/shared/status-revision.ts';

const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 };

function dead() {
  throw Object.assign(new Error('Synthetic runner exited'), { code: 'ESRCH' });
}

function fixture(t, { privateDelivery = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-result-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionId = 'parent-session';
  const runId = 'workflow-child';
  const asyncDir = path.join(dir, 'async', runId);
  const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
  const resultsDir = path.join(dir, 'results');
  const publicPath = resultFilePath(resultsDir, runId);
  const statusPath = path.join(asyncDir, 'status.json');
  const status = {
    runId, sessionId, mode: 'single', state: 'running', pid: 12345,
    parentWorkflowRunId: 'workflow-parent', workflowKey: 'child', startedAt: 1, lastUpdate: 2,
    ...(privateDelivery ? { resultDelivery: 'workflow' } : {}),
    steps: [{ agent: 'fixture', status: 'running' }],
  };
  const authentic = {
    id: runId, sessionId, asyncDir, state: 'complete', success: true, timestamp: 19,
    results: [{ agent: 'fixture', output: 'Synthetic child report', success: true, usage }],
  };
  assert.equal(writeGuardedStatus(statusPath, status).written, true);
  return {
    runId, sessionId, asyncDir, resultPath, resultsDir, publicPath, statusPath, authentic, status, index: 0,
    reconcile: (kill = dead) => reconcileAsyncRun(asyncDir, { resultsDir, now: () => 30, kill }),
    assertNoWake: () => {
      assert.equal(fs.existsSync(publicPath), false);
      assert.deepEqual(resultCandidateFilesForSession(resultsDir, sessionId), []);
    },
  };
}

test('legacy workflow receipt committed during the liveness probe wins without a global wake', async t => {
  const f = fixture(t, { privateDelivery: false });
  const repair = f.reconcile(() => { writeAsyncResultFile(f.resultPath, f.authentic); dead(); });
  assert.equal(repair.status.state, 'complete');
  assert.equal(repair.status.resultDelivery, 'workflow');
  assert.equal(repair.resultPath, f.resultPath);
  f.assertNoWake();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.resultPath, 'utf8')), f.authentic);
  const settled = await waitForImportedAsyncRoot(f);
  assert.equal(settled.success, true);
  assert.deepEqual(settled.usage, usage);
  assert.equal(f.reconcile().repaired, false);
});

test('a private pending receipt retains its outcome and fees before filesystem promotion', async t => {
  const f = fixture(t);
  const repair = f.reconcile(() => { writePendingAsyncResultFile(f.resultPath, f.authentic); dead(); });
  assert.equal(repair.status.state, 'complete');
  assert.equal(fs.existsSync(f.resultPath), false);
  f.assertNoWake();
  assert.deepEqual((await waitForImportedAsyncRoot(f)).usage, usage);
});

test('an awaited runner that dies without a receipt has only a private failure', async t => {
  const f = fixture(t);
  const repair = f.reconcile();
  assert.equal(repair.status.state, 'failed');
  assert.equal(repair.resultPath, f.resultPath);
  assert.equal(JSON.parse(fs.readFileSync(f.resultPath, 'utf8')).state, 'failed');
  f.assertNoWake();
  assert.equal((await waitForImportedAsyncRoot(f)).success, false);
});

test('a foreign file cannot be adopted or replaced as the private result', async t => {
  const f = fixture(t);
  const foreign = { ...f.authentic, sessionId: 'other-session' };
  writeAsyncResultFile(f.resultPath, foreign);
  const repair = f.reconcile();
  assert.equal(repair.status.state, 'failed');
  f.assertNoWake();
  assert.equal(f.reconcile().resultPath, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.resultPath, 'utf8')), foreign);
  const settled = await waitForImportedAsyncRoot(f, { terminalResultGraceMs: 0 });
  assert.equal(settled.success, false);
  assert.equal(settled.usage, undefined);
});

test('a detached workflow child keeps its normal public receipt when a local file belongs to another run', t => {
  const f = fixture(t, { privateDelivery: false });
  const foreign = { ...f.authentic, id: 'other-run' };
  writeAsyncResultFile(f.resultPath, foreign);
  const repair = f.reconcile(() => { writeAsyncResultFile(f.publicPath, f.authentic); dead(); });
  assert.equal(repair.status.state, 'complete');
  assert.equal(repair.status.resultDelivery, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.publicPath, 'utf8')), f.authentic);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.resultPath, 'utf8')), foreign);
});

for (const resultBeforeStop of [true, false]) {
  test(resultBeforeStop ? 'a committed workflow result and its fees survive Stop before the next poll' : 'a workflow result that finishes after Stop supplies fees without reversing cancellation', async t => {
    const f = fixture(t);
    let aborted = false;
    const pending = waitForImportedAsyncRoot(f, {
      shouldAbort: () => aborted, abortedAt: () => 20, pollIntervalMs: 1, timeoutMessage: 'Workflow stopped.',
    });
    if (!resultBeforeStop) aborted = true;
    writeAsyncResultFile(f.resultPath, { ...f.authentic, timestamp: resultBeforeStop ? 19 : 21 });
    aborted = true;
    // This projection can lag or be updated by Stop while the real outcome is retained.
    writeGuardedStatus(f.statusPath, { ...f.status, state: 'stopped', stopped: true, lastUpdate: 20, endedAt: 20 });
    const settled = await pending;
    assert.equal(settled.success, resultBeforeStop);
    assert.equal(settled.output, resultBeforeStop ? f.authentic.results[0].output : 'Workflow stopped.');
    assert.deepEqual(settled.usage, usage);
    assert.ok(fs.existsSync(f.resultPath));
  });
}

test('Stop without an available workflow result returns promptly and leaves newly arriving evidence readable', async t => {
  const f = fixture(t);
  const stopped = await waitForImportedAsyncRoot(f, { shouldAbort: () => true, abortedAt: () => 20 });
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.usage, undefined);
  writeAsyncResultFile(f.resultPath, { ...f.authentic, timestamp: 21 });
  assert.deepEqual((await waitForImportedAsyncRoot(f)).usage, usage);
  f.assertNoWake();
});

test('an already-aborted workflow with unknown ordering retains available fees without claiming success', async t => {
  const f = fixture(t);
  writeAsyncResultFile(f.resultPath, f.authentic);
  const stopped = await waitForImportedAsyncRoot(f, { shouldAbort: () => true, abortedAt: () => undefined });
  assert.equal(stopped.success, false);
  assert.equal(stopped.timedOut, true);
  assert.deepEqual(stopped.usage, usage);
  assert.ok(fs.existsSync(f.resultPath));
});

test('the native attached-chain owner can still receive accounting from a settled public result at cancellation', async t => {
  const f = fixture(t, { privateDelivery: false });
  writeAsyncResultFile(f.publicPath, f.authentic);
  const settled = await waitForImportedAsyncRoot({ ...f, resultPath: f.publicPath }, { shouldAbort: () => true });
  assert.equal(settled.success, false);
  assert.equal(settled.timedOut, true);
  assert.deepEqual(settled.usage, usage);
  assert.ok(fs.existsSync(f.publicPath));
});
