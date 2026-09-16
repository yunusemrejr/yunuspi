import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release=path.resolve(import.meta.dirname,'..');
const agent=[path.join(release,'agent'),path.resolve(release,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/extension/scope-council-runner.ts')));
if(!agent) throw new Error('Scope council runner source is missing');
const extension=pathToFileURL(path.join(agent,'extensions/pi-subagents/src/extension/')).href;
const shared=pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/')).href;
const {registerScopeCouncilRunner,SCOPE_COUNCIL_LIMITS,SCOPE_COUNCIL_RUNNER}=await import(extension+'scope-council-runner.ts');
const {registerAutonomousRecovery}=await import(extension+'autonomous-recovery.ts');
const {publishFreeEvidence,FREE_BASE_URL,FREE_CATALOG_URL}=await import(shared+'free-route-evidence.ts');
const {resetSharedControl}=await import(pathToFileURL(path.join(agent,'extensions/lib/intervention-shared.ts')));
// Step 21: marked flows spend from the shared control; each test models a
// separate request, so isolate the singleton per test.
beforeEach(()=>resetSharedControl());

const root=fs.mkdtempSync(path.join(os.tmpdir(),'scope-council-'));
const environment={
  PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR,
  PI_SUBAGENTS_ECONOMY_CONFIG:process.env.PI_SUBAGENTS_ECONOMY_CONFIG,
  PI_PROVIDER_STATE_FILE:process.env.PI_PROVIDER_STATE_FILE,
  PI_MODEL_EXCLUSIONS_PATH:process.env.PI_MODEL_EXCLUSIONS_PATH,
  PI_SCOPE_COUNCIL:process.env.PI_SCOPE_COUNCIL,
  PI_AUTONOMOUS_FREE_ASSIST:process.env.PI_AUTONOMOUS_FREE_ASSIST,
  PI_SUBAGENT_CHILD:process.env.PI_SUBAGENT_CHILD,
};
process.env.PI_CODING_AGENT_DIR=root;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG=path.join(root,'economy.json');
process.env.PI_PROVIDER_STATE_FILE=path.join(root,'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH=path.join(root,'exclusions.json');
process.env.PI_SCOPE_COUNCIL='on';
process.env.PI_AUTONOMOUS_FREE_ASSIST='on';
delete process.env.PI_SUBAGENT_CHILD;
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG,'{}');

const ids=['free/preservation','free/change','free/synthesis'];
publishFreeEvidence([...ids.map(id=>({id,pricing:{prompt:'0',completion:'0'},capabilities:{toolCalling:true,contextWindow:65536,maxTokens:8192}})),{id:'paid/model-0',pricing:{prompt:'0.1',completion:'0.2'},capabilities:{toolCalling:true,contextWindow:65536,maxTokens:8192}},{id:'paid/model-1',pricing:{prompt:'0.1',completion:'0.2'},capabilities:{toolCalling:true,contextWindow:65536,maxTokens:8192}}],FREE_CATALOG_URL);
const model=id=>({provider:'openrouter',id,api:'openai-completions',baseUrl:FREE_BASE_URL,contextWindow:65536,maxTokens:8192,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
const models=ids.map(model);
const task='Rework src/widget.ts?mode=wide while preserving the exact title "Keep title" and reconsider the assistant-selected easing.';
const context=()=>({cwd:root,model:model('parent'),sessionManager:{getSessionId:()=> 'session-1',getSessionFile:()=>path.join(root,'session.json')},ui:{setStatus(){}}});
const result=(text,usage={input:30,output:40,cacheRead:0,cacheWrite:0,cost:0,turns:1})=>({details:{results:[{exitCode:0,output:text,usage}]}});

test('dispatches two independent scope opinions and a synthesis peer under read-only ceilings',async()=>{
  const calls=[],entries=[],published=[];
  const pi={getActiveTools:()=>['subagent'],appendEntry:(customType,data)=>entries.push({customType,data})};
  let restriction={};
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{
    calls.push({id,params});
    const body=String(params.task);
    if(body.includes('Peer critique synthesizer')) return result('Synthesis: preserve the exact user reference; challenge the assistant-selected easing; verify the source before deciding whether a local adjustment or larger change is needed.');
    if(body.includes('Preservation peer')) return result('Preserve src/widget.ts?mode=wide and the exact title "Keep title" because they are explicit user references; assistant-selected easing is provisional.');
    return result('Meaningful change should address the requested rework and test the observable behavior; compare local adjustment with substantive revision before replacing unrelated behavior.');
  },available:()=>models,constraints:()=>restriction});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  assert.equal(typeof runner,'function');
  const request={task,graph:'src/widget.ts owns the widget behavior.',history:{evidence:[
    {id:'older-without-origin',role:'assistant',text:'An agent-only preference that must not be treated as evidence.'},
    {id:'current-user',role:'user',source:'interactive-message',at:'2026-09-13',text:'Preserve src/widget.ts?mode=wide and the exact title "Keep title".'},
  ],incomplete:false,coverage:'Synthetic current-project messages.'},limits:{tokens:999999,tools:999999,costUsd:999,deadlineMs:999999},onResult:value=>published.push(value)};
  const output=await runner(request,context(),new AbortController().signal);
  assert.equal(output.status,'complete');
  assert.equal(output.proposals.length,2);
  assert.equal(output.proposals[0].role,'preservation');
  assert.equal(output.proposals[1].role,'meaningful-change');
  assert.match(output.discussion,/assistant-selected easing/);
  assert.equal(published.length,1);
  assert.equal(calls.length,3);
  assert.match(calls[0].params.task,/src\/widget\.ts\?mode=wide/);
  assert.match(calls[1].params.task,/Keep title/);
  assert.match(calls[2].params.task,/Preserve src\/widget\.ts\?mode=wide/);
  assert.match(calls[2].params.task,/Meaningful change should address/);
  for(const {params} of calls){
    assert.equal(params.agent,'automatic-free-assistant');
    assert.equal(params.modelOrigin,'explicit');
    assert.equal(params.context,'fresh');
    assert.equal(params.async,false);
    assert.equal(params.foregroundOnly,true);
    assert.equal(params.usageBudget.tokens.hard,48000);
    assert.ok(params.usageBudget.costUsd.hard<=SCOPE_COUNCIL_LIMITS.costUsd/3);
    assert.equal(params.toolBudget.hard,4);
    assert.equal(params.toolBudget.soft,3);
    assert.equal(params.toolBudget.block,'*');
    assert.ok(params.timeoutMs<=240000);
    assert.ok(params.capabilityCeiling.allowedTools.includes('read'));
    for(const forbidden of ['write','edit','delete','bash','subagent','project_intel','sandbox_run','net_probe']) assert.ok(!params.capabilityCeiling.allowedTools.includes(forbidden),forbidden);
    assert.equal(params.capabilityCeiling.denyExtensions,false);
    assert.match(params.task,/Current user direction wins/);
  }
  assert.ok(entries.some(entry=>entry.customType==='subagent-lifecycle-v1'));
  assert.ok(entries.some(entry=>entry.customType==='subagent-cost-v1'));
  assert.doesNotMatch(JSON.stringify(entries),/assistant-only preference/);
});

test('current route restrictions and cancellation fail closed without late publication',async()=>{
  const calls=[],entries=[],pi={getActiveTools:()=>['subagent'],appendEntry:(customType,data)=>entries.push({customType,data})};
  let restriction={sameModel:true};
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{calls.push({id,params});return result('unexpected');},available:()=>models,constraints:()=>restriction});
  let runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const request={task:'Rework the src/widget.ts behavior because it is confusing.',history:{evidence:[]}};
  const denied=await runner(request,context(),new AbortController().signal);
  assert.equal(denied.status,'unavailable');
  assert.equal(calls.length,0);

  restriction={};
  let resolveCall;
  const started=[];
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{calls.push({id,params});started.push(id);return new Promise(resolve=>{resolveCall=resolve;});},available:()=>models,constraints:()=>restriction});
  runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const controller=new AbortController();
  const pending=runner({...request,onResult:()=>{throw new Error('late council publication');}},context(),controller.signal);
  try {
    const waitUntil=Date.now()+1000;
    while(started.length<2 && Date.now()<waitUntil) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(started.length,2,'cancellation fixture must dispatch both independent peers before aborting');
    controller.abort();
    const cancelled=await pending;
    assert.equal(cancelled.status,'unavailable');
    assert.match(cancelled.gap,/cancelled|superseded/i);
    assert.equal(entries.filter(entry=>entry.customType==='scope-council-result').length,0);
    resolveCall?.(result('late output that must be ignored'));
  } finally {
    controller.abort();
  }
});

test('scope council stays bounded to the shared public limits',()=>{
  assert.equal(SCOPE_COUNCIL_LIMITS.deadlineMs,240000);
  assert.equal(SCOPE_COUNCIL_LIMITS.costUsd,0.03);
  assert.equal(SCOPE_COUNCIL_LIMITS.tools,12);
  assert.equal(SCOPE_COUNCIL_LIMITS.tokens,144000);
  assert.equal(SCOPE_COUNCIL_LIMITS.proposalChars,1200);
  assert.equal(SCOPE_COUNCIL_LIMITS.discussionChars,2500);
});

test('the registered runner publishes its limits for the deliberation owner',()=>{
  const pi={getActiveTools:()=>['subagent'],appendEntry(){}};
  registerScopeCouncilRunner(pi,{launch:async()=>result('unused'),available:()=>models,constraints:()=>({})});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  assert.equal(typeof runner,'function');
  assert.equal(runner.limits,SCOPE_COUNCIL_LIMITS,'the lifecycle reads the shared deadline from here instead of a second copy');
  assert.equal(runner.limits.deadlineMs,240000);
});

test('a two-route council still critiques both perspectives and labels the reduced independence',async()=>{
  const calls=[],pi={getActiveTools:()=>['subagent'],appendEntry(){}};
  const pair=ids.slice(0,2).map(model);
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{
    calls.push({id,params});
    const body=String(params.task);
    if(body.includes('Peer critique synthesizer')) return result('Critique: the preservation side is supported by explicit user text; the meaningful-change side still needs a decisive source check before replacing unrelated behavior.');
    if(body.includes('Preservation peer')) return result('Preserve the explicit title "Keep title" and the src/widget.ts reference because the user named them.');
    return result('Reconsider the assistant-selected easing, but keep the change bounded to the reported behavior.');
  },available:()=>pair,constraints:()=>({})});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const output=await runner({task,graph:'src/widget.ts owns the widget behavior.',history:{evidence:[]}},context(),new AbortController().signal);
  assert.equal(calls.length,3);
  assert.equal(output.status,'complete');
  assert.equal(output.independence,'self-critique','a two-member council has no third route for an independent critique');
  assert.equal(output.proposals.length,2);
  assert.match(output.discussion,/decisive source check/);
});

test('paid-only capacity stays unavailable: councils never spend autonomously',async()=>{
  const calls=[],pi={getActiveTools:()=>['subagent'],appendEntry(){}};
  const paid=[0,1].map(i=>({...model(`paid/model-${i}`),cost:{input:0.1,output:0.2,cacheRead:0,cacheWrite:0}}));
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{calls.push({id,params});return result('unexpected');},available:()=>paid,constraints:()=>({})});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const output=await runner({task,graph:'src/widget.ts owns the widget behavior.',history:{evidence:[]}},context(),new AbortController().signal);
  assert.equal(output.status,'unavailable');
  assert.equal(calls.length,0);
});

test('one surviving perspective is still challenged instead of returning an empty partial',async()=>{
  const calls=[],pi={getActiveTools:()=>['subagent'],appendEntry(){}};
  const pair=ids.slice(0,2).map(model);
  registerScopeCouncilRunner(pi,{launch:async(id,params)=>{
    calls.push({id,params});
    const body=String(params.task);
    if(body.includes('Peer critique synthesizer')) return result('Challenge: the single meaningful-change perspective assumes the reported behavior is the whole complaint; the missing preservation view would likely raise the explicit title, which remains unverified.');
    if(body.includes('Preservation peer')) return {details:{results:[{exitCode:1,error:true}]}};
    return result('Recover the explicit title reference before widening the change; a bounded adjustment to the reported behavior is the smallest substantive scope.');
  },available:()=>pair,constraints:()=>({})});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const output=await runner({task,graph:'src/widget.ts owns the widget behavior.',history:{evidence:[]}},context(),new AbortController().signal);
  assert.equal(calls.length,3,'the surviving perspective still receives a bounded critique');
  assert.equal(output.status,'partial');
  assert.equal(output.proposals.length,1);
  assert.equal(output.proposals[0].role,'meaningful-change');
  assert.equal(output.independence,'cross-peer','the surviving peer is critiqued by the member that did not author it');
  assert.match(output.discussion,/missing preservation view/);
  assert.match(output.gap,/peer/i,'the unavailable perspective stays an explicit gap');
  const synth=calls.find(call=>String(call.params.task).includes('Peer critique synthesizer'));
  assert.match(String(synth.params.task),/other perspective is unavailable/);
});

test('the generic proactive helper yields to the automatic scope council trigger',async()=>{
  const hooks=new Map(),launches=[];
  const pi={
    on:(name,handler)=>hooks.set(name,[...(hooks.get(name)??[]),handler]),
    getActiveTools:()=>['subagent'],
    appendEntry(){},
    sendMessage(){},
    setModel:async()=>true,
  };
  registerAutonomousRecovery(pi,async()=>{launches.push(true);return result('unexpected generic helper output');});
  const ctx={cwd:root,model:model('free/preservation'),sessionManager:{getSessionId:()=> 'session-generic',getSessionFile:()=>path.join(root,'generic.json'),getBranch:()=>[]},ui:{setStatus(){}}};
  for(const handler of hooks.get('before_agent_start')??[]) await handler({prompt:'Please redesign the animation because it looks cheap.',systemPrompt:''},ctx);
  assert.equal(launches.length,0);
});

process.on('exit',()=>{
  for(const [key,value] of Object.entries(environment)){if(value===undefined) delete process.env[key]; else process.env[key]=value;}
  fs.rmSync(root,{recursive:true,force:true});
});
