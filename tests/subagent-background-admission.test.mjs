import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireChildAdmission } from '../agent/extensions/pi-subagents/src/runs/shared/child-admission.ts';
import { requestAsyncInterrupt, requestAsyncStop } from '../agent/extensions/pi-subagents/src/runs/background/control-channel.ts';
import { createRunFanoutBudget } from '../agent/extensions/pi-subagents/src/runs/shared/run-fanout-budget.ts';

const require = createRequire(import.meta.url);
const jiti = path.join(path.dirname(require.resolve('jiti/package.json')), 'lib', 'jiti-cli.mjs');
const runner = path.resolve(import.meta.dirname, '../agent/extensions/pi-subagents/src/runs/background/subagent-runner.ts');
const previousOutput = 'Prior output belongs to the previous writer.\n';
const resultText = 'Synthetic admitted child output.';
const previousReport = 'The existing requested report belongs to an earlier attempt.';
const childReport = 'This admitted writer changed the requested report.';

async function fixture(t, { occupied = true, timeoutMs, unavailable = false, report } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'pi-background-admission-'));
  const directory = path.join(root, 'slots');
  const asyncDir = path.join(root, 'async');
  const outputPath = path.join(asyncDir, 'output-0.log');
  const reportPath = path.join(root, 'report.md');
  const resultPath = path.join(root, 'result.json');
  const markerPath = path.join(root, 'invocations');
  const childPath = path.join(root, 'fixture-pi');
  const agentDir = path.join(root, 'agent');
  const artifactsDir = path.join(root, 'artifacts');
  fs.mkdirSync(asyncDir);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(outputPath, previousOutput);
  if (report) fs.writeFileSync(reportPath, previousReport);
  if (unavailable) fs.writeFileSync(directory, 'This path cannot be a slot directory.');
  const holder = occupied ? await acquireChildAdmission({ directory, capacity: 1 }) : undefined;
  assert.equal(holder?.kind, occupied ? 'admitted' : undefined);
  const fanout = createRunFanoutBudget('background-admission', 8);
  const events = [
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: resultText }],
      stopReason: 'stop', provider: 'openrouter', model: 'fixture:free', usage: { input: 2, output: 3 } } },
  ];
  const writeReport = `fs.writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(childReport)});`;
  const markStarted = `fs.appendFileSync(${JSON.stringify(markerPath)}, 'started\\n');`;
  const timedReport = Boolean(report && timeoutMs !== undefined && report !== 'complete');
  fs.writeFileSync(childPath, [
    `#!${process.execPath}`,
    `const fs = require('node:fs');`,
    report === 'shutdown' ? `process.on('SIGTERM', () => { ${writeReport} process.exit(0); });` : '',
    report === 'retry' ? `if (!fs.existsSync(${JSON.stringify(markerPath)})) { ${markStarted} ${writeReport} process.exit(1); }` : '',
    report === 'write' || report === 'complete' ? writeReport : '',
    markStarted,
    `for (const event of ${JSON.stringify(timedReport ? events.slice(0, 1) : events)}) console.log(JSON.stringify(event));`,
    timedReport ? 'setInterval(() => {}, 1000);' : '',
    '',
  ].join('\n'), { mode: 0o700 });
  const worker = spawn(process.execPath, [jiti, runner], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_PI_BINARY: childPath,
      PI_SUBAGENT_ADMISSION_DIR: directory, PI_SUBAGENT_MAX_CONCURRENT: '1' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const closed = once(worker, 'close');
  let stderr = '';
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', text => { stderr += text; });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed;
    holder?.lease.release();
    fs.rmSync(fanout.directory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  worker.stdin.end(JSON.stringify({
    id: 'background-admission', steps: [{ agent: 'fixture', task: 'Return a synthetic report.', tools: ['read'],
      model: 'openrouter/fixture:free', modelCandidates: ['openrouter/fixture:free', 'openrouter/second:free'],
      inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
      runFanoutPath: 'tasks[0]', ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(report ? { outputPath: reportPath, outputMode: 'file-only' } : {}) }],
    runFanoutBudget: fanout, resultPath, cwd: root, placeholder: '{{previous}}', asyncDir, artifactsDir, sessionId: 'background-admission-session',
  }));

  async function poll(read, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = read();
        if (value) return value;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (worker.exitCode !== null || worker.signalCode !== null) break;
      await delay(20);
    }
    assert.fail(`Background runner did not reach the expected state. ${stderr}`);
  }
  return {
    asyncDir,
    started: () => poll(() => fs.readFileSync(path.join(asyncDir, 'events.jsonl'), 'utf8').includes('"type":"subagent.step.started"'), 25_000),
    result: () => poll(() => JSON.parse(fs.readFileSync(resultPath, 'utf8'))),
    unblock: () => holder?.lease.release(),
    invocations: () => fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '',
    output: () => fs.readFileSync(outputPath, 'utf8'),
    report: () => fs.readFileSync(reportPath, 'utf8'),
    artifacts: () => fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir) : [],
    exited: async () => { assert.deepEqual(await closed, [0, null], stderr); },
  };
}

function assertNoDispatch(run, receipt, kind) {
  assert.equal(run.invocations(), '');
  assert.equal(run.output(), previousOutput);
  assert.deepEqual(run.artifacts(), []);
  assert.equal(receipt.results[0].admissionFailure, kind);
  assert.deepEqual(receipt.results[0].modelAttempts ?? [], []);
  assert.equal(receipt.results[0].usage, undefined);
}

test('a targeted child stop settles an occupied background slot without a dispatch or output truncation', { timeout: 40_000 }, async t => {
  const run = await fixture(t);
  await run.started();
  assert.equal(run.output(), previousOutput);
  requestAsyncStop(run.asyncDir, { targetIndex: 0, source: 'fixture' });
  const receipt = await run.result();
  assert.equal(receipt.results[0].stopped, true);
  assertNoDispatch(run, receipt, 'cancelled');
  await run.exited();
});

test('a step deadline includes background slot wait time and records no route attempt', { timeout: 40_000 }, async t => {
  const run = await fixture(t, { timeoutMs: 300, report: 'untouched' });
  await run.started();
  const receipt = await run.result();
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.results[0].timedOut, true);
  assert.equal(receipt.results[0].timeoutRecovery, undefined);
  assert.equal(run.report(), previousReport);
  assertNoDispatch(run, receipt, 'timed_out');
  await run.exited();
});

test('pausing a background run wakes admission and retains its normal paused outcome', { timeout: 40_000 }, async t => {
  const run = await fixture(t);
  await run.started();
  requestAsyncInterrupt(run.asyncDir, { source: 'fixture' });
  const receipt = await run.result();
  assert.equal(receipt.state, 'paused');
  assert.equal(receipt.results[0].interrupted, true);
  assertNoDispatch(run, receipt, 'cancelled');
  await run.exited();
});

test('one native background child launches on release and accounts only its actual usage', { timeout: 40_000 }, async t => {
  const run = await fixture(t);
  await run.started();
  assert.equal(run.invocations(), '');
  assert.equal(run.output(), previousOutput);
  run.unblock();
  const receipt = await run.result();
  await run.exited();
  assert.equal(receipt.state, 'complete');
  assert.equal(run.invocations(), 'started\n');
  assert.ok(run.output().includes(resultText));
  assert.equal(receipt.results[0].admissionFailure, undefined);
  assert.equal(receipt.results[0].modelAttempts.length, 1);
  assert.equal(receipt.results[0].usage.input, 2);
  assert.equal(receipt.results[0].usage.output, 3);
});

test('an unavailable child admission store is a terminal local error without a route retry', { timeout: 40_000 }, async t => {
  const run = await fixture(t, { occupied: false, unavailable: true });
  const receipt = await run.result();
  assert.equal(receipt.state, 'failed');
  assert.match(receipt.results[0].error, /child admission is unavailable/i);
  assertNoDispatch(run, receipt, 'unavailable');
  await run.exited();
});

for (const [report, reportStatus] of [['untouched', 'missing'], ['write', 'written'], ['shutdown', 'written']]) {
  test(`timeout recovery records an admitted ${report} report as ${reportStatus}`, { timeout: 40_000 }, async t => {
    const run = await fixture(t, { occupied: false, timeoutMs: 1500, report });
    const receipt = await run.result();
    await run.exited();
    assert.equal(run.invocations(), 'started\n');
    assert.equal(receipt.state, 'failed');
    const row = receipt.results[0];
    assert.equal(row.timedOut, true);
    assert.equal(row.timeoutRecovery.reportStatus, reportStatus);
    assert.equal(row.effects.settlementDiagnostic.requiredOutput.kind, 'file-only');
    assert.equal(row.effects.settlementDiagnostic.requiredOutput.missing, reportStatus === 'missing');
    assert.equal(run.report(), report === 'untouched' ? previousReport : childReport);
  });
}

test('a child-written report that finishes before deadline remains the successful output', { timeout: 40_000 }, async t => {
  const run = await fixture(t, { occupied: false, timeoutMs: 5000, report: 'complete' });
  const receipt = await run.result();
  await run.exited();
  assert.equal(run.invocations(), 'started\n');
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.results[0].timeoutRecovery, undefined);
  assert.equal(run.report(), childReport);
});

test('a report left by a prior attempt is not credited to the timed-out retry', { timeout: 40_000 }, async t => {
  const run = await fixture(t, { occupied: false, timeoutMs: 2500, report: 'retry' });
  const receipt = await run.result();
  await run.exited();
  assert.equal(run.invocations(), 'started\nstarted\n');
  assert.equal(receipt.results[0].modelAttempts.length, 2);
  assert.equal(receipt.results[0].timedOut, true);
  assert.equal(receipt.results[0].timeoutRecovery.reportStatus, 'missing');
  assert.equal(receipt.results[0].effects.settlementDiagnostic.requiredOutput.missing, true);
  assert.equal(run.report(), childReport);
});
