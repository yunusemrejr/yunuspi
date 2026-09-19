import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
const agent = [path.join(release, 'agent'), path.resolve(release, '..'), path.resolve(release, '../..')]
 .find(dir => fs.existsSync(path.join(dir, 'extensions/pi-subagents/src/runs/background/scheduled-runs.ts')));
const {ScheduledRunManager, scheduledRunStorePath} = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/background/scheduled-runs.ts')));

async function fixture(t, launch, trigger = {at: '+1m'}) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-schedule-lifecycle-'));
 const timers = new Set();
 const timersApi = {setTimeout(fn) { const timer = {fn, unref() {}}; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); }};
 const clock = {now: Date.parse('2026-09-19T00:00:00Z')};
 const storeRoot = path.join(root, 'store');
 const ctx = {cwd: root, sessionManager: {getSessionId: () => 'fixture', getSessionFile: () => path.join(root, 'session.jsonl')}};
 let sequence = 0;
 const manager = new ScheduledRunManager({
  config: {}, storeRoot, now: () => clock.now, randomId: () => `run-${++sequence}`,
  launch: (...args) => launch({manager, root}, ...args),
  timers: timersApi,
 });
 t.after(() => { manager.stop(); fs.rmSync(root, {recursive: true, force: true}); });
 const call = params => manager.handleToolCall(params, ctx);
 const created = await call({action: 'schedule.create', id: 'job', workflowScript: 'return 1', ...trigger});
 assert.equal(created.isError, undefined);
 const scheduleDir = path.join(scheduledRunStorePath(root, undefined, path.join(root, 'store')), 'job');
 return {manager, root, timers, timersApi, clock, storeRoot, ctx, call, scheduleDir};
}

for (const state of ['complete', 'failed']) {
 test(`schedule reconciles ${state} completion delivered before launch attaches its async id`, async t => {
  const f = await fixture(t, ({manager, root}) => {
   const asyncDir = path.join(root, 'child');
   fs.mkdirSync(asyncDir);
   fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({runId: 'child', state, error: state === 'failed' ? 'Child failed' : undefined}));
   manager.handleAsyncCompletion({runId: 'child', success: state === 'complete'});
   return Promise.resolve({content: [], details: {asyncId: 'child', asyncDir}});
  });
  const result = await f.call({action: 'schedule.run', id: 'job'});
  assert.equal(result.details.schedules.runs[0].state, state === 'complete' ? 'completed' : 'failed_run');
  assert.equal(result.details.schedules.records[0].activeRunId, undefined);
  assert.equal(fs.existsSync(path.join(f.scheduleDir, 'active.lock')), false);
  assert.deepEqual([...f.manager.observedCompletionRunIds()], []);
 });
}

test('pausing during an in-flight launch is preserved when that launch fails', async t => {
 let rejectLaunch;
 const f = await fixture(t, () => new Promise((_, reject) => { rejectLaunch = reject; }), {every: '1m'});
 const running = f.call({action: 'schedule.run', id: 'job'});
 assert.equal((await f.call({action: 'schedule.pause', id: 'job'})).isError, undefined);
 rejectLaunch(new Error('Launch refused'));
 const result = await running;
 assert.equal(result.details.schedules.runs[0].state, 'failed_launch');
 assert.equal(result.details.schedules.records[0].paused, true);
 assert.equal(f.timers.size, 0);
});

test('a running child retains the schedule lock until its later completion event', async t => {
 const f = await fixture(t, ({root}) => {
  const asyncDir = path.join(root, 'child');
  fs.mkdirSync(asyncDir);
  fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({runId: 'child', state: 'running'}));
  return Promise.resolve({content: [], details: {asyncId: 'child', asyncDir}});
 });
 const result = await f.call({action: 'schedule.run', id: 'job'});
 assert.equal(result.details.schedules.runs[0].state, 'running');
 assert.equal(fs.existsSync(path.join(f.scheduleDir, 'active.lock')), true);
 assert.deepEqual([...f.manager.observedCompletionRunIds()], ['child']);
 f.manager.handleAsyncCompletion({runId: 'child', success: true});
 assert.equal(fs.existsSync(path.join(f.scheduleDir, 'active.lock')), false);
 assert.equal((await f.call({action: 'schedule.history', id: 'job'})).details.schedules.runs[0].state, 'completed');
});

for (const status of ['invalid json', JSON.stringify({runId: 'different-child', state: 'complete'})]) {
test(`untrusted status (${status}) after launch does not release its active lock`, async t => {
 const f = await fixture(t, ({root}) => {
  const asyncDir = path.join(root, 'child');
  fs.mkdirSync(asyncDir);
  fs.writeFileSync(path.join(asyncDir, 'status.json'), status);
  return Promise.resolve({content: [], details: {asyncId: 'child', asyncDir}});
 });
 const warnings = [];
 t.mock.method(console, 'warn', message => warnings.push(message));
 const result = await f.call({action: 'schedule.run', id: 'job'});
 assert.equal(result.details.schedules.runs[0].state, 'running');
 assert.equal(fs.existsSync(path.join(f.scheduleDir, 'active.lock')), true);
 assert.deepEqual([...f.manager.observedCompletionRunIds()], ['child']);
 assert.equal(warnings.length, 1);
});
}

test('a launch settling after manager shutdown cannot rearm schedule timers', async t => {
 let resolveLaunch;
 const f = await fixture(t, () => new Promise(resolve => { resolveLaunch = resolve; }), {every: '1m'});
 const running = f.call({action: 'schedule.run', id: 'job'});
 f.manager.stop();
 resolveLaunch({content: [], details: {asyncId: 'child'}});
 await running;
 assert.equal(f.timers.size, 0);
 assert.deepEqual([...f.manager.observedCompletionRunIds()], []);
 const persisted = JSON.parse(fs.readFileSync(path.join(f.scheduleDir, 'history.json'), 'utf8'));
 assert.equal(persisted.runs[0].asyncId, 'child', 'the detached launch remains recoverable on the next bind');
});

for (const outcome of ['failure', 'success']) {
 test(`late launch ${outcome} cannot release a replacement run's claim`, async t => {
  let resolveLaunch, rejectLaunch;
  const f = await fixture(t, () => new Promise((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject; }), {every: '1m'});
  const first = f.call({action: 'schedule.run', id: 'job'});
  f.clock.now += 301_000;
  const replacement = new ScheduledRunManager({
   config: {}, storeRoot: f.storeRoot, now: () => f.clock.now, randomId: () => 'replacement-run', timers: f.timersApi,
   launch: async () => ({content: [], details: {asyncId: 'replacement-child'}}),
  });
  t.after(() => replacement.stop());
  replacement.bindSession(f.ctx);
  await replacement.handleToolCall({action: 'schedule.run', id: 'job'}, f.ctx);
  const lock = path.join(f.scheduleDir, 'active.lock');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement-run');
  if (outcome === 'failure') rejectLaunch(new Error('Late launch refusal'));
  else {
   const asyncDir = path.join(f.root, 'original-child');
   fs.mkdirSync(asyncDir);
   fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({runId: 'original-child', state: 'complete'}));
   resolveLaunch({content: [], details: {asyncId: 'original-child', asyncDir}});
  }
  await first;
  assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement-run');
  const schedule = JSON.parse(fs.readFileSync(path.join(f.scheduleDir, 'schedule.json'), 'utf8'));
  assert.equal(schedule.activeRunId, 'replacement-run');
  const history = JSON.parse(fs.readFileSync(path.join(f.scheduleDir, 'history.json'), 'utf8')).runs;
  assert.equal(history.find(run => run.id === 'replacement-run').state, 'running');
  assert.equal(history.find(run => run.id === 'run-1').state, outcome === 'failure' ? 'failed_launch' : 'completed');
 });
}
