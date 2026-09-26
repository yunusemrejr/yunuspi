import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/child-ledger.ts')),
);
assert.ok(agent, 'agent tree with child-ledger.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { reduceChildEvents, deriveAttemptOutcome, deriveLogicalState, summarizeLedger, projectTranscriptChildren } = await import(shared + 'child-ledger.ts');
const { buildChildTaskIdentity, nextAttemptIdentity, labelChildTask } = await import(shared + 'child-identity.ts');
const { classifyFailure } = await import(shared + 'failure-cause.ts');

test('persisted redacted failure retains its category without accepting arbitrary diagnostic text', () => {
  const cause=classifyFailure({stage:'provider',providerCode:400,error:true});
  const retained=deriveAttemptOutcome({status:'failed',exitCode:1,error:'child-error',cause:{...cause,privateText:'do not expose'}});
  assert.equal(retained.execution.cause.category,'invalid-request');
  assert.equal(retained.execution.cause.providerCode,'400');
  assert.doesNotMatch(JSON.stringify(retained),/do not expose/);
  assert.equal(deriveAttemptOutcome({status:'stopped',cause}).execution.cause.category,'stopped');
  assert.equal(deriveAttemptOutcome({status:'failed',error:'child-error',cause:{category:'fabricated'}}).execution.cause.category,'unknown');
});

test('terminal states are never overwritten by secondary flags', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 't1', label: 'task', attempt: 1, runId: 'r1' },
    { type: 'stop', taskId: 't1', runId: 'r1' },
    { type: 'completion', taskId: 't1', runId: 'r1', row: { status: 'failed', exitCode: 1, error: 'boom' } },
  ]);
  const task = ledger.tasks[0];
  assert.equal(task.state, 'stopped');
  assert.equal(task.attempts[0].exitCode, 1, 'exit code kept as secondary evidence');
});

test('interrupted work pauses; it is not failed', () => {
  const outcome = deriveAttemptOutcome({ interrupted: true, exitCode: 1 });
  assert.equal(outcome.state, 'paused');
});

test('execution and acceptance outcomes stay independent', () => {
  const executedButRejected = deriveAttemptOutcome({ status: 'completed', exitCode: 0, acceptance: { status: 'rejected', reason: 'missing tests' } });
  assert.equal(executedButRejected.state, 'failed');
  assert.equal(executedButRejected.execution.status, 'succeeded');
  assert.equal(executedButRejected.acceptance.status, 'failed');

  const transport = deriveAttemptOutcome({ status: 'failed', providerCode: 503 });
  assert.equal(transport.state, 'failed');
  assert.equal(transport.execution.cause.category, 'overload');
  assert.equal(transport.acceptance.status, 'none', 'provider failure is not rewritten as verification');
});

test('retries bind to the logical task as attempt trees', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 'task-4', label: 'task #4 automatic search', attempt: 1, runId: 'a' },
    { type: 'completion', taskId: 'task-4', runId: 'a', row: { status: 'failed', stopReason: 'length' } },
    { type: 'recovery', taskId: 'task-4', reason: 'resume synthesis', replacementAttempt: 2 },
    { type: 'launch', taskId: 'task-4', attempt: 2, runId: 'b' },
    { type: 'completion', taskId: 'task-4', runId: 'b', row: { status: 'completed', exitCode: 0 } },
  ]);
  assert.equal(ledger.tasks.length, 1);
  const task = ledger.tasks[0];
  assert.equal(task.state, 'completed');
  assert.equal(task.attempts.length, 2);
  assert.equal(task.attempts[0].execution.cause.category, 'output-truncated');
  assert.equal(task.attempts[1].state, 'completed');
  assert.deepEqual(ledger.unresolved, []);
});

test('accounting never moves lifecycle state', () => {
  const ledger = reduceChildEvents([
    { type: 'launch', taskId: 't', attempt: 1, runId: 'r' },
    { type: 'completion', taskId: 't', runId: 'r', row: { status: 'completed', exitCode: 0 } },
    { type: 'accounting', taskId: 't', runId: 'r', usage: { input: 10, output: 5 } },
  ]);
  assert.equal(ledger.tasks[0].state, 'completed');
  assert.equal(ledger.tasks[0].attempts[0].usage.input, 10);
});

test('identity: labels come from the child task, retries keep the task id', () => {
  assert.equal(labelChildTask('Task #4: run the Luka live search. Then report.'), 'Task #4: run the Luka live search.');
  const first = buildChildTaskIdentity({ runId: 'run-1', index: 3, childTask: 'Task #4 automatic Luka live search', todoId: 'todo-9' });
  assert.equal(first.attempt, 1);
  assert.ok(first.label.includes('Luka'));
  const second = nextAttemptIdentity(first);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.attempt, 2);
});

test('logical state reflects the latest terminal attempt', () => {
  const { state } = deriveLogicalState([
    { attempt: 1, state: 'failed', execution: { status: 'failed' }, acceptance: { status: 'none' } },
    { attempt: 2, state: 'completed', execution: { status: 'succeeded' }, acceptance: { status: 'passed' } },
  ]);
  assert.equal(state, 'completed');
});

test('ledger agrees with embedded metrics counters on shared fixtures', async () => {
  // session-metrics.ts is embedded verbatim in footer builds and cannot import
  // the ledger. This conformance test is the sharing contract: same entries,
  // same child counts. Detached launches are the one principled vocabulary
  // difference (metrics: active; ledger: queued = accepted but not started).
  const { collectSessionMetrics } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-metrics.ts')));
  const entries = [
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', details: { runId: 'p1', results: [
      { index: 0, status: 'completed', exitCode: 0, model: 'q/m', label: 'audit login' },
      { index: 1, status: 'failed', exitCode: 1, error: 'HTTP 503 flap', model: 'q/m', label: 'probe api' },
    ] } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'p1', results: [
      { index: 0, status: 'completed', exitCode: 0, model: 'q/m', usage: { input: 20, output: 5 } },
      { index: 1, status: 'failed', exitCode: 1, error: 'HTTP 503 flap', model: 'q/m', usage: { input: 8, output: 1 } },
    ] } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'p2', results: [
      { index: 0, status: 'stopped', stopped: true, model: 'q/m' },
      { index: 1, status: 'running', model: 'q/m' },
    ] } },
  ];
  const metrics = collectSessionMetrics(entries);
  const ledger = reduceChildEvents(projectTranscriptChildren(entries));
  const summary = summarizeLedger(ledger);
  assert.equal(summary.tasks, metrics.agents, 'duplicate receipts dedupe to the same child count');
  assert.equal(summary.completed, metrics.agentsCompleted);
  assert.equal(summary.failed, metrics.agentFailures);
  assert.equal(summary.stopped, metrics.agentsStopped);
  assert.equal(summary.running + summary.queued, metrics.agentsActive);
});

test('transcript projection feeds the reducer deterministically', () => {
  const entries = [
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', details: { runId: 'p1', results: [{ index: 0, status: 'completed', exitCode: 0, model: 'q/m', label: 'audit login' }] } } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'p1', results: [{ index: 0, status: 'completed', model: 'q/m', usage: { input: 20, output: 5 } }] } },
  ];
  const first = reduceChildEvents(projectTranscriptChildren(entries));
  const second = reduceChildEvents(projectTranscriptChildren(entries));
  assert.deepEqual(first, second, 'same events reduce to the same ledger');
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].state, 'completed');
  assert.equal(first.tasks[0].attempts[0].usage.input, 20);
  assert.equal(summarizeLedger(first).completed, 1);
});

test('audit: detached children are live (running), never queued',()=>{
 for(const row of [{status:'detached'},{detached:true},{state:'detached'}]){
  const outcome=deriveAttemptOutcome(row);
  assert.equal(outcome.state,'running',JSON.stringify(row));
  assert.equal(outcome.execution.status,'running',JSON.stringify(row));
 }
 const ledger=reduceChildEvents([
  {type:'launch',taskId:'t-det',label:'detached job',attempt:1,runId:'r-det'},
  {type:'completion',taskId:'t-det',runId:'r-det',row:{status:'detached'}},
 ]);
 assert.equal(ledger.tasks[0].state,'running');
});

test('audit: ledger and /metrics agree a detached child is outstanding',async ()=>{
 const {collectSessionMetrics}=await import(pathToFileURL(path.join(agent,'extensions/lib/session-metrics.ts')));
 const entries=[{type:'custom',customType:'subagent-cost-v1',data:{runId:'dx',mode:'single',state:'detached',results:[{index:0,status:'detached'}]}}];
 const ledger=reduceChildEvents(projectTranscriptChildren(entries));
 assert.equal(ledger.tasks[0].state,'running');
 const m=collectSessionMetrics(entries);
 assert.equal(m.agentsActive,1);
 assert.equal(m.agentOutcomeUnknown,0);
});


test('empty or cost-only usage never fabricates zero token counts and partial receipts preserve prior measurements',()=>{
 const events=[{type:'launch',taskId:'fixture',attempt:1},
  {type:'completion',taskId:'fixture',attempt:1,row:{exitCode:0,usage:{cost:0}}}];
 assert.equal(reduceChildEvents(events).tasks[0].attempts[0].usage,undefined);
 events.push({type:'completion',taskId:'fixture',attempt:1,row:{exitCode:0,usage:{input:10,output:5}}},
  {type:'completion',taskId:'fixture',attempt:1,row:{exitCode:0,usage:{input:8}}});
 assert.deepEqual(reduceChildEvents(events).tasks[0].attempts[0].usage,{input:10,output:5});
});

test('legacy helper accounting joins its exact observed native session without duplicating the child', () => {
  const native='11111111-1111-4111-8111-111111111111';
  const receipt=(kind,data)=>({type:'custom',customType:kind,data});
  const entries=[
    receipt('subagent-cost-v1',{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,agent:'automatic-free-assistant',status:'running'}]}),
    receipt('subagent-lifecycle-v1',{runId:native,mode:'single',state:'running',results:[{index:0,status:'running'}]}),
    receipt('subagent-lifecycle-v1',{runId:native,mode:'single',state:'failed',results:[{index:0,status:'failed'}]}),
    receipt('subagent-cost-v1',{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,agent:'automatic-free-assistant',model:'fixture/reviewer',sessionFile:`/fixture/${native}/run-0/session.jsonl`,timedOut:true,error:'child-error',usage:{input:300,output:100,turns:3}}]}),
  ];
  entries.push(receipt('subagent-cost-v1',{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,status:'failed',error:'child-error'}]}));
  const ledger=reduceChildEvents(projectTranscriptChildren(entries));
  assert.equal(ledger.tasks.length,1);
  assert.equal(ledger.tasks[0].attempts.length,1);
  assert.equal(ledger.tasks[0].attempts[0].runId,native);
  assert.equal(ledger.tasks[0].execution.cause.category,'timeout');
  assert.equal(ledger.tasks[0].attempts[0].usage.turns,3);
  assert.equal(ledger.tasks[0].agent,'automatic-free-assistant');
});

test('legacy helper path linkage requires an unambiguous observed single run', () => {
  const native='11111111-1111-4111-8111-111111111111';
  const life={type:'custom',customType:'subagent-lifecycle-v1',data:{runId:native,mode:'single',state:'failed',results:[{index:0,status:'failed'}]}};
  const helper=(runId,sessionFile,extra={})=>({type:'custom',customType:'subagent-cost-v1',data:{runId,mode:'single',results:[{index:0,error:'child-error',sessionFile,...extra}]}});
  for(const file of [`/fixture/${native}/run-1/session.jsonl`,`/fixture/../${native}/run-0/session.jsonl`,`${native}/run-0/session.jsonl`,`/fixture/22222222-2222-4222-8222-222222222222/run-0/session.jsonl`]) {
    assert.equal(reduceChildEvents(projectTranscriptChildren([life,helper('auto-assist-one',file)])).tasks.length,2,file);
  }
  const file=`/fixture/${native}/run-0/session.jsonl`;
  assert.equal(reduceChildEvents(projectTranscriptChildren([life,helper('auto-assist-one',file),helper('auto-assist-two',file)])).tasks.length,3,'ambiguous wrapper ownership stays separate');
  assert.equal(reduceChildEvents(projectTranscriptChildren([life,helper('auto-assist-one',file,{index:1})])).tasks.length,2,'nonzero child position is not inferred');
  assert.equal(reduceChildEvents(projectTranscriptChildren([{...life,data:{...life.data,mode:'parallel'}},helper('auto-assist-one',file)])).tasks.length,2,'parallel run is not inferred');
  const other='33333333-3333-4333-8333-333333333333';
  assert.equal(reduceChildEvents(projectTranscriptChildren([life,helper('auto-assist-one',file,{runId:other})])).tasks.length,2,'explicit child ID is never replaced by path inference');
});


test('native lifecycle and restored status project observed execution without fabricated usage or acceptance', () => {
  const life = state => ({type:'custom',customType:'subagent-lifecycle-v1',data:{runId:'native-run',mode:'parallel',results:[{index:0,status:state}]}});
  for (const [state, execution] of [['queued','none'],['running','running'],['completed','succeeded'],['failed','failed'],['stopped','failed'],['paused','failed']]) {
    const task = reduceChildEvents(projectTranscriptChildren([life(state)])).tasks[0];
    assert.equal(task.execution.status, execution, state);
    assert.equal(task.attempts[0].usage, undefined);
    assert.equal(task.acceptance.status, 'none');
  }
  const status = {type:'message',message:{role:'toolResult',toolName:'subagent',details:{runId:'native-run',results:[],statusResults:[{index:0,status:'completed',exitCode:0,acceptance:{status:'review-required'}}]}}};
  const task = reduceChildEvents(projectTranscriptChildren([life('running'), status])).tasks[0];
  assert.equal(task.state, 'completed'); assert.equal(task.execution.status, 'succeeded');
  assert.equal(task.acceptance.status, 'pending'); assert.equal(task.attempts[0].usage, undefined);
  status.message.details.statusResults[0].acceptance = {status:'rejected'};
  assert.equal(reduceChildEvents(projectTranscriptChildren([status])).tasks[0].acceptance.status, 'failed');
  for (const type of ['progress','resume']) assert.equal(reduceChildEvents([{type:'launch',taskId:'fixture',attempt:1},{type,taskId:'fixture',attempt:1}]).tasks[0].execution.status, 'running');
});
