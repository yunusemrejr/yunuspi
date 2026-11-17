import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { collectSessionCost, recoverRetainedChildCosts } from '../core/coding-agent/src/core/session-accounting.js';
import { bindPrivateWorkflowCostRecovery, persistSubagentCost } from '../agent/extensions/pi-subagents/src/extension/session-cost.ts';
import { createAsyncJobTracker } from '../agent/extensions/pi-subagents/src/runs/background/async-job-tracker.ts';
import { waitForImportedAsyncRoot } from '../agent/extensions/pi-subagents/src/runs/background/chain-root-attachment.ts';
import { resultCandidateFilesForSession, workflowAwaitedAsyncResultPath, writeAsyncResultFile, writePendingAsyncResultFile } from '../agent/extensions/pi-subagents/src/runs/background/result-files.ts';
import { writeGuardedStatus } from '../agent/extensions/pi-subagents/src/runs/shared/status-revision.ts';

const runId = 'dea4c675-6053-4a25-91a7-c4ffc5356c7a';
const workflowRunId = 'workflow-fixture';
const workflowKey = 'paid-child';
const charged = .037;
const usage = {input:12,output:3,cacheRead:0,cacheWrite:0,turns:1,cost:charged,
  costDetails:{reported:charged,estimated:0,unknown:false,subscription:false,seen:true,estimatedUsage:false}};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-late-workflow-cost-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const sessionFile = path.join(root,'parent.jsonl');
  const statusRoot = path.join(root,'async-subagent-runs');
  const resultsDir = path.join(root,'results');
  const asyncDir = path.join(statusRoot,runId);
  const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
  const statusPath = path.join(asyncDir,'status.json');
  const timestamp = new Date().toISOString();
  const header = {type:'session',id:'owner-header-id',version:3,timestamp,cwd:root};
  const branch = {type:'message',id:'user-entry',parentId:null,timestamp,message:{role:'user',content:'Synthetic task',timestamp:1}};
  fs.writeFileSync(sessionFile,[header,branch].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
  const manager = SessionManager.open(sessionFile);
  const state = {currentSessionId:sessionFile,completionOwnerId:'owner-runtime'};
  const pi = {appendEntry:(type,data)=>manager.appendCustomEntry(type,data),
    bindAuxiliaryUsage(type) { const bound=manager.bindAccountingReceipt(type);return data=>Boolean(bound(data)); }};
  const started = {id:runId,asyncDir,sessionId:sessionFile,completionOwnerId:state.completionOwnerId,mode:'single',
    parentWorkflowRunId:workflowRunId,workflowKey,resultDelivery:'workflow',agent:'fixture'};
  const running = {runId,sessionId:sessionFile,completionOwnerId:state.completionOwnerId,mode:'single',state:'running',
    resultDelivery:'workflow',parentWorkflowRunId:workflowRunId,workflowKey,startedAt:1,lastUpdate:1,steps:[{agent:'fixture',status:'running'}]};
  writeGuardedStatus(statusPath,running);
  const payload = {id:runId,sessionId:sessionFile,asyncDir,mode:'single',parentWorkflowRunId:workflowRunId,workflowKey,
    success:true,state:'complete',timestamp:3,results:[{agent:'fixture',model:'openrouter/fixture',output:'private fixture output',usage}]};
  const entries = () => [manager.getHeader(),...manager.getEntries()];
  const recover = () => recoverRetainedChildCosts(entries(),{sessionFile,statusRoot});
  return {root,manager,pi,state,started,running,statusRoot,resultsDir,sessionFile,asyncDir,resultPath,statusPath,payload,entries,recover};
}

test('a retained keyed workflow costs nothing until its late private fee is found, then persists it once without a wake', async t => {
  const f = fixture(t);
  const waiter = await waitForImportedAsyncRoot({runId,asyncDir:f.asyncDir,resultPath:f.resultPath,index:0},{shouldAbort:()=>true,abortedAt:()=>2});
  assert.equal(waiter.timedOut,true);
  assert.equal(waiter.usage,undefined);
  persistSubagentCost(f.pi,f.state,{runId:workflowRunId,sessionId:f.sessionFile,completionOwnerId:f.state.completionOwnerId,
    mode:'workflow',state:'stopped',results:[{runId,workflowKey,agent:'fixture',timedOut:true,success:false,exitCode:1}]});
  assert.equal(collectSessionCost(f.entries()).formatted,'$?');
  assert.deepEqual(f.recover().entries,[]);

  writeAsyncResultFile(f.resultPath,f.payload);
  const retained = f.recover();
  assert.equal(collectSessionCost(f.entries()).formatted,'$?');
  assert.equal(collectSessionCost([...f.entries(),...retained.entries]).formatted,'$0.037000');
  assert.equal(retained.entries.length,1);
  assert.deepEqual(resultCandidateFilesForSession(f.resultsDir,f.sessionFile),[]);
  assert.equal(JSON.stringify(retained.entries).includes('private fixture output'),false);

  const reopened = SessionManager.open(f.sessionFile);
  const leaf = reopened.getLeafId();
  for (const entry of retained.entries) reopened.appendCustomEntry(entry.customType,entry.data);
  assert.equal(reopened.getLeafId(),leaf);
  const entries = [reopened.getHeader(),...reopened.getEntries()];
  assert.equal(collectSessionCost([...entries,...retained.entries]).total,charged);
  assert.deepEqual(recoverRetainedChildCosts(entries,{sessionFile:f.sessionFile,statusRoot:f.statusRoot}).entries,[]);
});

test('a live idle tracker settles the original accounting owner when the private child closes', {timeout:8000}, async t => {
  const f = fixture(t);
  const accounting = bindPrivateWorkflowCostRecovery(f.pi,f.manager,f.statusRoot);
  const leaf = f.manager.getLeafId();
  accounting.track(f.started);
  const state = {...f.state,asyncJobs:new Map(),fleetJobs:new Map(),cleanupTimers:new Map(),lastUiContext:null,poller:null};
  const events = [];
  const tracker = createAsyncJobTracker({events:{emit:(name)=>events.push(name)}},state,f.statusRoot,{
    resultsDir:f.resultsDir,widgetEnabled:false,pollIntervalMs:10,kill:()=>true,
    onPrivateWorkflowTerminal:job=>accounting.settle(job.asyncId),
  });
  t.after(()=>tracker.dispose());
  tracker.handleStarted(f.started);
  const waiting = await waitForImportedAsyncRoot({runId,asyncDir:f.asyncDir,resultPath:f.resultPath,index:0},{shouldAbort:()=>true});
  assert.equal(waiting.usage,undefined);
  writeAsyncResultFile(f.resultPath,f.payload);
  writeGuardedStatus(f.statusPath,{...f.running,state:'complete',lastUpdate:3,endedAt:3,steps:[{agent:'fixture',status:'complete'}]});
  const deadline = Date.now()+3000;
  while (collectSessionCost(f.entries()).total !== charged && Date.now()<deadline) await delay(15);
  assert.equal(collectSessionCost(f.entries()).total,charged);
  accounting.settle(runId);
  assert.equal(f.entries().filter(entry=>entry.data?.privateWorkflow&&entry.customType==='subagent-cost-v1').length,1);
  assert.equal(f.manager.getLeafId(),leaf);
  assert.deepEqual(events,[]);
  assert.deepEqual(resultCandidateFilesForSession(f.resultsDir,f.sessionFile),[]);
});

test('recovery authorizes the same owner, native run, workflow key, and real priced payload before reading fees', t => {
  const f = fixture(t);
  bindPrivateWorkflowCostRecovery(f.pi,f.manager,f.statusRoot).track(f.started);
  for (const invalid of [
    {...f.payload, workflowKey:'wrong-child'},
    {...f.payload, sessionId:f.sessionFile+'.other'},
    {...f.payload, timestamp:0},
    {...f.payload, parentWorkflowRunId:undefined},
    {...f.payload, results:[{usage:{input:0,output:0,turns:0,cost:0}}]},
  ]) {
    writeAsyncResultFile(f.resultPath,invalid);
    assert.deepEqual(f.recover().entries,[]);
  }
  fs.unlinkSync(f.resultPath);
  writePendingAsyncResultFile(f.resultPath,f.payload);
  assert.equal(fs.existsSync(f.resultPath),false);
  assert.equal(collectSessionCost([...f.entries(),...f.recover().entries]).total,charged);
  const foreign = path.join(f.root,'other.jsonl');
  fs.copyFileSync(f.sessionFile,foreign);
  assert.deepEqual(recoverRetainedChildCosts(f.entries(),{sessionFile:foreign,statusRoot:f.statusRoot}).entries,[]);
});

test('a private correction and original inline wrapper with the same native id are one physical fee', t => {
  const f = fixture(t);
  bindPrivateWorkflowCostRecovery(f.pi,f.manager,f.statusRoot).track(f.started);
  f.manager.appendMessage({role:'toolResult',toolName:'subagent',toolCallId:'workflow-call',content:[],timestamp:2,
    details:{mode:'workflow',runId:workflowRunId,results:[{runId,index:0,usage,exitCode:0}]}});
  writeAsyncResultFile(f.resultPath,f.payload);
  const settled = f.recover().entries;
  assert.equal(collectSessionCost([...f.entries(),...settled,...settled]).total,charged);
});

test('two workflow invocations on one resumed child transcript retain distinct native fees', t => {
  const f = fixture(t);
  const childSessionFile = path.join(f.root,'resumed-child.jsonl');
  const previousUsage = {...usage,cost:.015,costDetails:{...usage.costDetails,reported:.015}};
  f.manager.appendMessage({role:'toolResult',toolName:'subagent',toolCallId:'workflow-call',content:[],timestamp:2,
    details:{mode:'workflow',runId:workflowRunId,results:[
      {runId:'previous-native-run',index:0,sessionFile:childSessionFile,usage:previousUsage,exitCode:0},
      {runId,index:1,sessionFile:childSessionFile,usage,exitCode:0},
    ]}});
  assert.ok(Math.abs(collectSessionCost(f.entries()).total-(.015+charged))<1e-12);
});
