import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release=path.resolve(import.meta.dirname,'..');
const agent=[path.join(release,'agent'),path.resolve(release,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/tui/fleet.ts')));
if(!agent) throw new Error('Fleet source is missing');
const mod=p=>import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src',p)));
const {collectFleetSnapshot}=await mod('tui/fleet.ts');
const {collectFleetStatusEntries}=await mod('tui/fleet-status.ts');
const {projectAsyncWorkflowRows}=await mod('runs/shared/async-status-projection.ts');

const wfSteps=()=>[
 {index:0,agent:'worker',label:'plan-gap',status:'running',lastActivityAt:1500,model:'openrouter/a',thinking:'low'},
 {index:1,agent:'worker',label:'stale-check',status:'completed'},
 {index:2,agent:'scout',status:'pending'},
];
const wfJob=(steps,extra={})=>({asyncId:'wf1',asyncDir:'/tmp/wf1',status:'running',mode:'workflow',startedAt:1000,updatedAt:2000,steps,...extra});
const liveControl=(runId,workflowRunId)=>({runId,mode:'single',sessionId:null,parentWorkflowRunId:workflowRunId,workflowSteeringDir:'/tmp/steer',startedAt:1000,updatedAt:2000,activeChildren:new Map([[0,{index:0,agent:'worker',startedAt:1000,updatedAt:2000}]])});

test('fleet inspector expands workflow steps exactly like parallel steps',()=>{
 const parallel={asyncId:'p1',asyncDir:'/tmp/p1',status:'running',mode:'parallel',startedAt:1000,updatedAt:2000,steps:wfSteps()};
 const workflow=wfJob(wfSteps());
 for(const [job,want] of [[parallel,3],[workflow,4]]) {
  const state={asyncJobs:new Map([[job.asyncId,job]]),foregroundControls:new Map(),currentSessionId:null};
  const items=collectFleetSnapshot(state,{}).items.filter(i=>i.runId===job.asyncId);
  assert.equal(items.length,want);
  const rows=items.filter(i=>i.kind==='async'&&i.index!==undefined);
  assert.deepEqual(rows.map(r=>[r.key,r.agent,r.state]),[
   [`async:${job.asyncId}:0`,'plan-gap (worker)','running'],
   [`async:${job.asyncId}:1`,'stale-check (worker)','completed'],
   [`async:${job.asyncId}:2`,'scout','pending'],
  ]);
  assert.deepEqual(rows.map(r=>r.step.status),['running','completed','pending']);
 }
 const wrapped=collectFleetSnapshot({asyncJobs:new Map([['wf1',wfJob(wfSteps())]]),foregroundControls:new Map(),currentSessionId:null},{}).items;
 assert.equal(wrapped[0].key,'async:wf1');
 assert.equal(wrapped[0].agent,'workflow');
});

test('fleet inspector twin-skips only displayed foreground rows, never hiding a lone child',()=>{
 // Two live children: foreground rows display, so their step rows are skipped.
 const multi=wfJob([
  {index:0,agent:'worker',label:'one',status:'running',runId:'child-a'},
  {index:1,agent:'worker',label:'two',status:'running',runId:'child-b'},
  {index:2,agent:'scout',status:'pending'},
 ]);
 const multiState={asyncJobs:new Map([['wf1',multi]]),foregroundControls:new Map([['child-a',liveControl('child-a','wf1')],['child-b',liveControl('child-b','wf1')]]),currentSessionId:null};
 const multiItems=collectFleetSnapshot(multiState,{}).items;
 assert.ok(multiItems.some(i=>i.key==='foreground-active:child-a:0'));
 assert.ok(multiItems.some(i=>i.key==='foreground-active:child-b:0'));
 assert.ok(!multiItems.some(i=>i.key==='async:wf1:0'),'twin step row duplicated the foreground row');
 assert.ok(!multiItems.some(i=>i.key==='async:wf1:1'),'twin step row duplicated the foreground row');
 assert.ok(multiItems.some(i=>i.key==='async:wf1:2'),'pending member without a twin must stay visible');
 // One live child: the foreground row is deduped away, so the step row must show instead.
 const single=wfJob([{index:0,agent:'worker',label:'solo',status:'running',runId:'child-solo'}]);
 const singleState={asyncJobs:new Map([['wf1',single]]),foregroundControls:new Map([['child-solo',liveControl('child-solo','wf1')]]),currentSessionId:null};
 const singleItems=collectFleetSnapshot(singleState,{}).items;
 assert.ok(!singleItems.some(i=>i.key.startsWith('foreground-active:')),'single live child keeps the foreground collapse');
 assert.ok(singleItems.some(i=>i.key==='async:wf1:0'&&i.agent==='solo (worker)'),'lone live child must surface as a step row');
});

test('fleet widget parents active workflow members under the wrapper without duplicating twins',()=>{
 const job=wfJob([
  {index:0,agent:'worker',label:'live-one',workflowKey:'live-one',status:'running',runId:'child-live',model:'openrouter/a'},
  {index:1,agent:'worker',label:'queued-two',workflowKey:'queued-two',status:'pending'},
  {index:2,agent:'scout',workflowKey:'done-three',status:'completed'},
 ]);
 const state={asyncJobs:new Map([['wf1',job]]),foregroundControls:new Map([['child-live',liveControl('child-live','wf1')]]),currentSessionId:null};
 const entries=collectFleetStatusEntries(state);
 const wrapper=entries.find(e=>e.key==='async:wf1');
 assert.ok(wrapper?.workflowWrapper);
 assert.ok(entries.some(e=>e.key==='foreground-active:child-live:0'),'live member keeps its foreground entry');
 assert.ok(!entries.some(e=>e.key==='async:wf1:0'),'twin member must not duplicate the foreground entry');
 const queued=entries.find(e=>e.key==='async:wf1:1');
 assert.equal(queued?.parentKey,'async:wf1');
 assert.equal(queued?.agent,'queued-two (worker)');
 assert.equal(queued?.state,'pending');
 assert.ok(!entries.some(e=>e.key==='async:wf1:2'),'settled members stay out of the widget like parallel steps');
 assert.ok(!(wrapper.workflowRows??[]).some(r=>r.name.includes('queued-two')),'emitted member must leave the stage projection');
 assert.ok((wrapper.workflowRows??[]).some(r=>r.name.includes('live-one')),'pre-existing twin/stage overlap is unchanged');
});

test('stage projection exclusion only removes the named graph stages and lanes',()=>{
 const graph={runId:'wf1',mode:'workflow',phases:[],nodes:[
  {id:'a',kind:'step',label:'a',status:'running'},
  {id:'b',kind:'step',label:'b',status:'pending'},
 ]};
 const steps=[{agent:'worker',label:'a',workflowKey:'a',status:'running'}];
 const preflight={version:1,coverage:'complete',lanes:[{key:'c',mode:'scout'}]};
 const all=projectAsyncWorkflowRows(steps,graph,preflight);
 assert.equal(all.length,3,'loaded member plus planned stage plus planned lane');
 assert.ok(all.some(r=>r.name==='a (worker)'),'loaded member row present without exclusions');
 assert.ok(all.some(r=>r.name==='b'),'planned graph stage present without exclusions');
 assert.ok(all.some(r=>r.name==='c'&&r.state==='planned'),'planned lane present without exclusions');
 const trimmed=projectAsyncWorkflowRows(steps,graph,preflight,new Set(['a']));
 assert.ok(!trimmed.some(r=>r.name.includes('a')),'loaded member row excluded');
 assert.ok(trimmed.some(r=>r.name==='b'),'unrelated graph stage kept');
 assert.ok(trimmed.some(r=>r.name==='c'),'unrelated lane kept');
 assert.deepEqual(projectAsyncWorkflowRows(steps,graph,preflight,new Set(['a','b','c'])),[],'full exclusion leaves no rows');
 assert.deepEqual(projectAsyncWorkflowRows([],undefined,undefined,new Set(['a'])),[],'empty projection stays empty with exclusions');
});
