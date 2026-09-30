import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname,'..');
const agent = [path.join(root,'agent'),path.join(root,'..','agent'),root].find(dir => fs.existsSync(path.join(dir,'extensions/lib/adaptive-execution.ts')));
const {adaptiveDispatchDefaults,adaptiveChildBrief,adaptiveNativeChildThinking} = await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/adaptive-dispatch.ts')));
const route = 'fixture/reasoner';
const model = {provider:'fixture',id:'reasoner',fullId:route,reasoning:true};
const plain = {agent:'worker',task:'Correct a one-line README typo'};
const hard = {agent:'worker',task:'Redesign authentication across multiple services'};
const thinking = (brief,extra={}) => adaptiveNativeChildThinking({brief,model:route,availableModels:[model],...extra});
delete process.env.PI_ADAPTIVE_EXECUTION;
delete process.env.PI_SUBAGENT_THINKING_CEILING;

test('requested independent children retain all work, defaults scale and requests are immutable',()=>{
  const request = {tasks:[plain,plain,plain,plain]};
  const direct = adaptiveDispatchDefaults(request);
  assert.equal(direct.params.concurrency,2);
  assert.equal(direct.params.tasks,request.tasks);
  assert.equal(request.concurrency,undefined);
  const mixed = adaptiveDispatchDefaults({tasks:[plain,hard,plain,plain]});
  assert.equal(mixed.params.concurrency,3);
  assert.equal(adaptiveDispatchDefaults({tasks:[plain]}).params.concurrency,1);
  assert.equal(adaptiveDispatchDefaults(request,{}, {failures:2}).params.concurrency,3);
});

test('tool concurrency and configured human capacity stay exact',()=>{
  assert.equal(adaptiveDispatchDefaults({tasks:[plain,hard],concurrency:7},{parallel:{concurrency:2}}).params.concurrency,7);
  const configured = adaptiveDispatchDefaults({tasks:[plain,hard]},{parallel:{concurrency:6}});
  assert.equal(configured.params.concurrency,6);
  assert.equal(configured.changes[0].source,'configuration');
  assert.equal(adaptiveDispatchDefaults({tasks:[plain,hard]},{globalConcurrencyLimit:8}).params.concurrency,undefined);
  assert.equal(adaptiveDispatchDefaults({workflowScript:'await runs.all([])',globalConcurrencyLimit:9}).params.globalConcurrencyLimit,9);
  assert.equal(adaptiveDispatchDefaults({workflowScript:'await runs.all([])'},{globalConcurrencyLimit:7}).params.globalConcurrencyLimit,undefined);
});

test('chain groups and dynamic templates use independent defaults and explicit group choices',()=>{
  const request={chain:[plain,{parallel:[plain,plain,plain]},{parallel:[hard,plain,plain],concurrency:5},{parallel:plain,expand:{maxItems:8},collect:{as:'all'}}]};
  const output=adaptiveDispatchDefaults(request).params;
  assert.equal(output.chain[0],plain);
  assert.equal(output.chain[1].concurrency,2);
  assert.equal(output.chain[2].concurrency,5);
  assert.equal(output.chain[3].concurrency,2,'unknown expansion should retain useful parallelism');
  assert.equal(request.chain[1].concurrency,undefined);
  assert.equal(adaptiveDispatchDefaults({chain:[{parallel:[plain,hard]}],concurrency:6}).params.chain[0].concurrency,6);
});

test('thinking follows each authored child and supports count expansion and reserved dynamic indices',()=>{
  assert.equal(thinking(plain),'minimal');
  assert.equal(thinking({task:'Investigate an intermittent parser failure'}),'low');
  assert.equal(thinking(hard),'high');
  const request={chain:[{parallel:[{...plain,count:2},hard]},{parallel:plain,expand:{maxItems:3}},hard]};
  assert.equal(adaptiveChildBrief(request,0).task,plain.task);
  assert.equal(adaptiveChildBrief(request,1).task,plain.task);
  assert.equal(adaptiveChildBrief(request,2),hard);
  assert.equal(adaptiveChildBrief(request,5),plain);
  assert.equal(adaptiveChildBrief(request,6),hard);
  assert.equal(adaptiveChildBrief(request,7),undefined);
  assert.equal(adaptiveChildBrief(request,-1),undefined);
  assert.equal(adaptiveChildBrief({tasks:[{...plain,count:2},hard]},2),hard);
});

test('thinking settings, model suffixes and configured fallback thinking remain exact',()=>{
  for(const value of ['off','high',false]){
    assert.equal(thinking(plain,{agentThinking:value}),undefined);
    assert.equal(thinking(plain,{requestThinking:value}),undefined);
    assert.equal(thinking({...plain,thinking:value}),undefined);
  }
  assert.equal(thinking(plain,{model:`${route}:high`}),undefined);
  assert.equal(thinking(plain,{fallbackModels:[`${route}:high`]}),undefined);
});

test('native default is bounded by agent and inherited ceilings and real model support',()=>{
  assert.equal(thinking(hard,{maxThinking:'low'}),'low');
  process.env.PI_SUBAGENT_THINKING_CEILING='off';
  try { assert.equal(thinking(hard),'off'); } finally { delete process.env.PI_SUBAGENT_THINKING_CEILING; }
  assert.equal(thinking(plain,{availableModels:[{...model,thinkingLevelMap:{minimal:null,low:null}}]}),'medium');
  assert.equal(thinking(plain,{maxThinking:'minimal',availableModels:[{...model,thinkingLevelMap:{minimal:null}}]}),'off');
  assert.equal(thinking(hard,{availableModels:[{...model,reasoning:false}]}),undefined);
  assert.equal(thinking(hard,{availableModels:[]}),undefined);
  assert.equal(thinking(hard,{externalRunner:true}),undefined);
  assert.equal(thinking({task:'{previous}'}),'low','unresolved templates retain proportionate uncertainty');
  assert.equal(thinking({}),'low');
});

test('malformed requests retain their native validation owner instead of throwing in optional defaults',()=>{
  for(const request of [{tasks:'bad'},{tasks:[null]},{chain:[null]},{chain:[{parallel:[null]}]},{chain:[{parallel:null}]}]){
    assert.equal(adaptiveDispatchDefaults(request).params,request);
  }
});

test('script fan-out receives a bounded absent default including file-backed workflows',()=>{
  assert.equal(adaptiveDispatchDefaults({workflowScript:'await runs.all([])'}).params.globalConcurrencyLimit,3);
  assert.equal(adaptiveDispatchDefaults({workflowScriptPath:'workflow.js'}).params.globalConcurrencyLimit,3);
  assert.equal(adaptiveDispatchDefaults({task:'Fix a typo'}).params.globalConcurrencyLimit,undefined);
});

test('rollback disables adaptive defaults without discarding configured capacities',()=>{
  for(const switchValue of ['off','0','OFF']){
    process.env.PI_ADAPTIVE_EXECUTION=switchValue;
    try {
      const request={tasks:[plain,hard]};
      assert.equal(adaptiveDispatchDefaults(request).params,request);
      assert.equal(adaptiveDispatchDefaults({workflowScript:'...'}).params.globalConcurrencyLimit,undefined);
      assert.equal(thinking(hard),undefined);
      assert.equal(adaptiveDispatchDefaults(request,{parallel:{concurrency:7}}).params.concurrency,7);
    }finally{delete process.env.PI_ADAPTIVE_EXECUTION;}
  }
});
