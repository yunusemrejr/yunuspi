import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const template = path.resolve(import.meta.dirname, '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')]
  .find((p) => fs.existsSync(path.join(p, 'extensions/lib/session-stop.ts')));
assert.ok(agent, 'agent tree with session-stop.ts is present');
// Same stub technique as memory-exit-budget.test.mjs: the SDK host is not
// part of the public distribution, so tests stub its two imported packages.
register('data:text/javascript,' + encodeURIComponent(`export function resolve(name,ctx,next){
 const sources={
 '@earendil-works/pi-coding-agent':'export function getAgentDir(){return ${JSON.stringify(path.join(template, 'agentFixture'))}};export class SettingsManager{static create(){return {getCompactionSettings(){return{};}};}}',
 '@earendil-works/pi-ai':'export function StringEnum(v){return v}'};
 return name in sources?{url:'data:text/javascript,'+encodeURIComponent(sources[name]),shortCircuit:true}:next(name,ctx);
}`), import.meta.url);

const stop = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-stop.ts')));
const checkpoints = await import(pathToFileURL(path.join(agent, 'extensions/checkpoints.ts')));

const reviewEntry = (reports, extra = {}) => ({
  type: 'custom', customType: 'quality-review-v1',
  data: { root: '/repo', revision: 1, changed: ['a.ts'], rounds: 1, reviewed: 1, reports, ...extra },
});
const passReport = { aspect: 'correctness', outcome: 'pass', evidence: ['traced the changed behavior end to end'], findings: [], gap: '' };
const changesReport = { aspect: 'security', outcome: 'changes', evidence: ['input reaches the sink unescaped here'], findings: [{ id: 'security-1', severity: 'blocking', file: 'a.ts', detail: 'unsanitized input flows into the query builder sink' }], gap: '' };
const unknownReport = { aspect: 'correctness', outcome: 'unknown', evidence: [], findings: [], gap: 'No permitted reviewer returned an assessment for this aspect.' };
const costEntry = (runId, status) => ({
  type: 'custom', customType: 'subagent-cost-v1',
  data: { runId, mode: 'single', state: status, results: [{ index: 0, status, model: 'fixture/model' }] },
});
const scopeCtx = (branch, sid = 'stop-test-session') => ({
  cwd: '/repo',
  isIdle: () => true,
  hasPendingMessages: () => false,
  signal: { aborted: false },
  sessionManager: { getSessionId: () => sid, getBranch: () => branch, getEntries: () => branch },
});

test('quality gate counts pass and changes verdicts, never unavailable reviews', () => {
  assert.equal(stop.qualityStopGate([]).met, false);
  assert.equal(stop.qualityStopGate(undefined).met, false);
  assert.equal(stop.qualityStopGate([reviewEntry([passReport])]).met, true);
  assert.equal(stop.qualityStopGate([reviewEntry([changesReport])]).met, true);
  // Infra-blocked rounds leave unknown-only reports: no review happened.
  assert.equal(stop.qualityStopGate([reviewEntry([unknownReport], { disposition: 'blocked', reason: 'Independent review unavailable: capacity' })]).met, false);
  assert.equal(stop.qualityStopGate([reviewEntry([])]).met, false);
});

test('subagent gate counts completed runs only', () => {
  assert.equal(stop.subagentStopGate([]).met, false);
  assert.equal(stop.subagentStopGate([costEntry('r1', 'completed')]).met, true);
  assert.equal(stop.subagentStopGate([costEntry('r1', 'failed')]).met, false);
  assert.equal(stop.subagentStopGate([costEntry('r1', 'stopped')]).met, false);
  assert.equal(stop.subagentStopGate([costEntry('r1', 'running')]).met, false);
});

test('stop state: genuine input unlocks, extension wakes never do', () => {
  const ctx = scopeCtx([], 'stop-state-1');
  assert.equal(stop.isSessionStopped(ctx), false);
  assert.equal(stop.noteSessionStopped(ctx, 'stop-1'), true);
  assert.equal(stop.isSessionStopped(ctx), true);
  assert.equal(stop.stopInputUnlocks({ source: 'extension', text: 'wake' }, ctx), false);
  assert.equal(stop.isSessionStopped(ctx), true);
  assert.equal(stop.stopInputUnlocks({ source: 'interactive', text: 'follow up' }, ctx), true);
  assert.equal(stop.isSessionStopped(ctx), false);
  assert.equal(stop.unlockSessionStop(ctx), false);
});

test('unidentifiable scopes fail open for suppression, closed for recording', () => {
  assert.equal(stop.isSessionStopped(undefined), false);
  assert.equal(stop.isSessionStopped({ cwd: '/repo', sessionManager: {} }), false);
  assert.equal(stop.noteSessionStopped({}, 'stop-x'), false);
  assert.equal(stop.shouldAnnounceStopUnlock({}), false);
});

test('unlock notice is exactly-once per stop cycle', () => {
  const ctx = scopeCtx([], 'stop-announce-1');
  assert.equal(stop.shouldAnnounceStopUnlock(ctx), true);
  stop.markStopUnlockAnnounced(ctx);
  assert.equal(stop.shouldAnnounceStopUnlock(ctx), false);
  // The announce marker alone must never suppress settled triggers.
  assert.equal(stop.isSessionStopped(ctx), false);
  stop.noteSessionStopped(ctx, 'stop-2');
  assert.equal(stop.isSessionStopped(ctx), true);
  stop.unlockSessionStop(ctx);
  assert.equal(stop.shouldAnnounceStopUnlock(ctx), true);
});

function loadCheckpoints() {
  const hooks = {};
  const tools = {};
  const sent = [];
  const appended = [];
  const pi = {
    on: (name, fn) => { hooks[name] = fn; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    registerCommand: () => {},
    appendEntry: (customType, data) => appended.push({ customType, data }),
    sendMessage: (message, options) => sent.push({ message, options }),
    getActiveTools: () => ['quality_review', 'session_stop', 'checkpoint_read'],
  };
  checkpoints.default(pi);
  return { hooks, tools, sent, appended };
}

const gatedBranch = () => [reviewEntry([passReport]), costEntry('run-1', 'completed')];

test('session_stop status reports gates without terminating', async () => {
  const { tools } = loadCheckpoints();
  const ctx = scopeCtx(gatedBranch(), 'stop-tool-1');
  const result = await tools.session_stop.execute('id', { action: 'status' }, undefined, undefined, ctx);
  assert.equal(result.terminate, undefined);
  assert.equal(result.details.gates.met, true);
  assert.equal(result.details.stopped, false);
});

test('session_stop refuses locked gates, short reasons and children', async () => {
  const { tools } = loadCheckpoints();
  const ctx = scopeCtx([costEntry('run-1', 'completed')], 'stop-tool-2');
  await assert.rejects(
    tools.session_stop.execute('id', { action: 'stop', reason: 'everything is done and verified here' }, undefined, undefined, ctx),
    /locked/,
  );
  const gated = scopeCtx(gatedBranch(), 'stop-tool-3');
  await assert.rejects(
    tools.session_stop.execute('id', { action: 'stop', reason: 'too short' }, undefined, undefined, gated),
    /at least 20 characters/,
  );
  process.env.PI_SUBAGENT_CHILD = '1';
  try {
    await assert.rejects(
      tools.session_stop.execute('id', { action: 'status' }, undefined, undefined, gated),
      /main-session only/,
    );
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test('session_stop records the stop, ledgers it and terminates the turn', async () => {
  const { tools, appended } = loadCheckpoints();
  const ctx = scopeCtx(gatedBranch(), 'stop-tool-4');
  const result = await tools.session_stop.execute(
    'id', { action: 'stop', reason: 'all requested work is done and verified' }, undefined, undefined, ctx,
  );
  assert.equal(result.terminate, true);
  assert.equal(result.details.stopped, true);
  assert.ok(result.details.stopId);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].customType, 'session-stop-v1');
  assert.equal(appended[0].data.stopId, result.details.stopId);
  assert.equal(stop.isSessionStopped(ctx), true);
});

test('a stopped session emits no settled follow-ups until user input unlocks', async () => {
  const { hooks, tools, sent } = loadCheckpoints();
  const ctx = scopeCtx(gatedBranch(), 'stop-settled-1');
  await tools.session_stop.execute(
    'id', { action: 'stop', reason: 'all requested work is done and verified' }, undefined, undefined, ctx,
  );
  sent.length = 0;
  await hooks.agent_settled({}, ctx);
  assert.equal(sent.length, 0, 'stopped sessions stay silent at settle');
  hooks.input({ source: 'interactive', text: 'one more thing' }, ctx);
  await hooks.agent_settled({}, ctx);
  const unlocks = sent.filter((s) => s.message?.customType === 'session-stop-unlock');
  assert.equal(unlocks.length, 1, 'unlock notice fires exactly once after user continuation');
  assert.equal(unlocks[0].options.triggerTurn, false);
  sent.length = 0;
  await hooks.agent_settled({}, ctx);
  assert.equal(sent.filter((s) => s.message?.customType === 'session-stop-unlock').length, 0);
});

test('extension-sourced input does not unlock a stopped session', async () => {
  const { hooks, tools, sent } = loadCheckpoints();
  const ctx = scopeCtx(gatedBranch(), 'stop-settled-2');
  await tools.session_stop.execute(
    'id', { action: 'stop', reason: 'all requested work is done and verified' }, undefined, undefined, ctx,
  );
  hooks.input({ source: 'extension', text: 'automatic wake' }, ctx);
  sent.length = 0;
  await hooks.agent_settled({}, ctx);
  assert.equal(sent.length, 0);
});
