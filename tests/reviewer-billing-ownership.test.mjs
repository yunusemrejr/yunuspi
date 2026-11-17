import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { registerQualityReviewRunner } from '../agent/extensions/pi-subagents/src/extension/quality-review-runner.ts';
import { AgentSessionRuntime } from '../core/coding-agent/src/core/agent-session-runtime.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { collectSessionCost } from '../core/coding-agent/src/core/session-accounting.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';

const request = { task:'Inspect a synthetic counter', revision:1, files:['fixture.js'],
  aspects:[{id:'correctness', rubric:'Check the change'}], graph:'Synthetic graph', history:[], tests:{need:null} };
const model = {id:'fixture-model', name:'Fixture model', provider:'fixture', api:'openai-completions', baseUrl:'https://fixture.invalid',
  input:['text'], reasoning:false, contextWindow:8192, maxTokens:1024, cost:{input:0, output:0, cacheRead:0, cacheWrite:0}};
const modelRuntime = {getModel:()=>model, getAvailable:()=>[model], hasConfiguredAuth:()=>true, isUsingSubscription:()=>false,
  streamSimple(){ assert.fail('review billing must not start an extra model turn'); }};

function seed(cwd) {
  const manager = SessionManager.create(cwd, cwd);
  const earlier = manager.appendMessage({role:'user', content:'Earlier branch', timestamp:Date.now()});
  const source = manager.appendMessage({role:'user', content:'Source branch', timestamp:Date.now()});
  manager.flush();
  return {manager, earlier, source};
}

async function fixture(t, {vetoTree = false} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-billing-owner-'));
  const launches = [], terminalEvents = [], published = [];
  let host, runner, context;
  t.after(async () => {
    for (const launch of launches) launch.resolve({details:{results:[]}});
    try { await host?.dispose(); } finally { fs.rmSync(cwd, {recursive:true, force:true}); }
  });
  async function makeSession(sessionManager) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({cwd, agentDir:cwd, settingsManager, noExtensions:true, noSkills:true,
      noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[pi => {
        pi.registerTool({name:'subagent', label:'Synthetic delegation', description:'Fixture', parameters:{type:'object', properties:{}},
          execute(){ assert.fail('only the injected native reviewer should execute'); }});
        registerQualityReviewRunner(pi, () => {
          const result = Promise.withResolvers();
          launches.push(result);
          return result.promise;
        });
        runner = globalThis[Symbol.for('yunus-pi.quality-review-runner.v1')];
        if (vetoTree) pi.on('session_before_tree', () => ({cancel:true}));
        pi.on('session_start', (_event, ctx) => { context = ctx; });
      }]});
    await resourceLoader.reload();
    const sdk = await createAgentSession({cwd, agentDir:cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager, tools:['subagent']});
    await sdk.session.bindExtensions({mode:'print'});
    return {...sdk, services:{cwd, agentDir:cwd}};
  }
  const {manager, earlier} = seed(cwd);
  const original = await makeSession(manager);
  const source = manager.getLeafId();
  host = new AgentSessionRuntime(original.session, original.services, async ({sessionManager}) => makeSession(sessionManager));
  original.session.subscribe(event => {
    if (event.type === 'entry_appended' && event.entry.data?.results?.[0]?.usage) terminalEvents.push(event.entry);
  });
  function start() {
    const index = launches.length;
    const running = runner({...request, onResult: result => published.push(result)}, context, new AbortController().signal);
    assert.equal(launches.length, index + 1);
    return {running, complete(total) {
      const usage = {input:10, output:3, cacheRead:0, cacheWrite:0, turns:1, cost:total,
        costDetails:{reported:total, estimated:0, unknown:false, seen:true, subscription:false}};
      launches[index].resolve({details:{runId:randomUUID(), results:[{exitCode:0, usage, reviewEvidence:{sourceReads:1},
        output:JSON.stringify({reviews:[{aspect:'correctness', outcome:'pass', evidence:['fixture.js:1 checked the counter'], gap:'', findings:[]}]})}]}});
    }};
  }
  return {cwd, manager, host, earlier, source, published, terminalEvents, start,
    saved: () => SessionManager.open(manager.getSessionFile(), cwd).getEntries()};
}

test('canceled SDK tree navigation drops stale review presentation but settles both source-owned charges', async t => {
  const f = await fixture(t, {vetoTree:true});
  const first = f.start(), second = f.start();
  assert.equal(collectSessionCost(f.saved()).pending, 2);
  assert.deepEqual(await f.host.session.navigateTree(f.earlier), {cancelled:true});
  second.complete(.5);
  first.complete(.25);
  await Promise.all([first.running, second.running]);
  assert.equal(f.published.length, 0);
  const entries = f.saved();
  assert.equal(collectSessionCost(entries).reported, .75);
  assert.equal(collectSessionCost(entries).pending, 0);
  assert.equal(collectSessionCost([...entries, ...entries]).reported, .75);
  assert.equal(f.manager.getLeafId(), f.source);
  assert.equal(f.terminalEvents.length, 2);
  assert.ok(f.terminalEvents.every(entry => entry.parentId === f.source));
});

test('moving within the same SDK session keeps the charge on the submitting branch', async t => {
  const f = await fixture(t);
  const run = f.start();
  const targetLeaf = f.manager.getEntry(f.earlier).parentId;
  assert.equal((await f.host.session.navigateTree(f.earlier)).cancelled, false);
  run.complete(.5);
  await run.running;
  assert.equal(f.manager.getLeafId(), targetLeaf);
  assert.equal(collectSessionCost(f.saved()).reported, .5);
  assert.equal(f.host.session.getSessionStats().cost, .5);
  assert.equal(f.terminalEvents[0]?.parentId, f.source);
  assert.equal(f.published.length, 0);
});

for (const action of ['fork', 'switch']) test(`a late reviewer charge settles durably in the original file after SDK ${action}`, async t => {
  const f = await fixture(t);
  const run = f.start();
  const navigated = action === 'fork' ? await f.host.fork(f.source, {position:'at'})
    : await f.host.switchSession(seed(f.cwd).manager.getSessionFile());
  assert.equal(navigated.cancelled, false);
  run.complete(.5);
  await run.running;
  const cost = collectSessionCost(f.saved());
  assert.equal(cost.reported, .5);
  assert.equal(cost.pending, 0);
  const active = collectSessionCost(f.host.session.sessionManager.getEntries());
  assert.equal(active.total, 0);
  assert.equal(active.pending, 0);
  assert.equal(f.published.length, 0);
  assert.equal(f.terminalEvents.length, 0);
});

for (const action of ['delete', 'replace', 'overwrite']) test(`late review settlement refuses a changed source transcript (${action})`, async t => {
  const f = await fixture(t);
  const run = f.start();
  const file = f.manager.getSessionFile();
  if (action !== 'overwrite') fs.renameSync(file, `${file}.original`);
  const replacement = action === 'delete' ? undefined : fs.readFileSync(seed(f.cwd).manager.getSessionFile());
  if (replacement) fs.writeFileSync(file, replacement);
  run.complete(.5);
  await run.running;
  if (replacement) assert.ok(fs.readFileSync(file).equals(replacement));
  else assert.equal(fs.existsSync(file), false);
  assert.equal(f.terminalEvents.length, 0);
});
