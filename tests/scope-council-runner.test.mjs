import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {visibleWidth, stripTerminalSequences} from '@yunuspi/tui';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {convertToLlm} from '../core/coding-agent/src/core/messages.js';
import {CustomMessageComponent} from '../core/coding-agent/src/modes/interactive/components/custom-message.js';
import {initTheme} from '../core/coding-agent/src/modes/interactive/theme/theme.js';

const release=path.resolve(import.meta.dirname,'..');
const agent=[path.join(release,'agent'),path.resolve(release,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/extension/scope-council-runner.ts')));
if(!agent) throw new Error('Scope council runner source is missing');
const extension=pathToFileURL(path.join(agent,'extensions/pi-subagents/src/extension/')).href;
const shared=pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/')).href;
const {registerScopeCouncilRunner,SCOPE_COUNCIL_LIMITS,SCOPE_COUNCIL_RUNNER,SCOPE_COUNCIL_PROGRESS}=await import(extension+'scope-council-runner.ts');
const {classifyTaskMutationIntent,taskMayMutate}=await import(shared+'task-intent.ts');
const {reduceChildEvents,projectTranscriptChildren}=await import(shared+'child-ledger.ts');
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
  PI_LLM_PREFERENCES_FILE:process.env.PI_LLM_PREFERENCES_FILE,
  PI_SCOPE_COUNCIL:process.env.PI_SCOPE_COUNCIL,
  PI_AUTONOMOUS_FREE_ASSIST:process.env.PI_AUTONOMOUS_FREE_ASSIST,
  PI_SUBAGENT_CHILD:process.env.PI_SUBAGENT_CHILD,
};
process.env.PI_CODING_AGENT_DIR=root;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG=path.join(root,'economy.json');
process.env.PI_PROVIDER_STATE_FILE=path.join(root,'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH=path.join(root,'exclusions.json');
process.env.PI_LLM_PREFERENCES_FILE=path.join(root,'preferences.json');
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

test('council progress persists during inference, expands member advice and never wakes or enters model context', async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'scope-council-ui-'));
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  let finishModel,modelCalls=0;
  const gate=new Promise(resolve=>{finishModel=resolve;});
  const selected=model('parent');
  const modelRuntime={getModel:()=>selected,getAvailable:()=>[selected],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,
    getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),streamSimple:()=>{
      modelCalls++;
      const message={role:'assistant',provider:selected.provider,model:selected.id,api:selected.api,content:[{type:'text',text:'Fixture complete.'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      return {async *[Symbol.asyncIterator](){await gate;yield {type:'done',message};},result:async()=>message};
    }};
  const {session}=await createAgentSession({cwd,agentDir:cwd,model:selected,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.create(cwd,cwd),tools:[],thinkingLevel:'off'});
  t.after(()=>{finishModel();session.dispose();fs.rmSync(cwd,{recursive:true,force:true});});
  const prompt=session.prompt('Synthetic fixture request.');
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  await tick(); await tick();
  assert.equal(session.isStreaming,true);
  const renderers=new Map(),events=[],sends=[],deliveries=[],peers=[];
  session.subscribe(event=>events.push(event));
  const pi={getActiveTools:()=>['subagent'],appendEntry:(type,data)=>session.sessionManager.appendCustomEntry(type,data),
    registerMessageRenderer:(type,renderer)=>renderers.set(type,renderer),
    sendMessage:(message,options)=>{sends.push({message,options});const delivery=session.sendCustomMessage(message,options);deliveries.push(delivery);return delivery;}};
  const ctx={...context(),cwd,sessionManager:session.sessionManager};
  registerScopeCouncilRunner(pi,{available:()=>models,constraints:()=>({}),rankPerspectives:null,
    launch:()=>new Promise(resolve=>peers.push(resolve))});
  const pending=globalThis[SCOPE_COUNCIL_RUNNER]({task},ctx);
  await tick();
  assert.equal(peers.length,2);
  assert.equal(sends.filter(row=>row.message.details.status==='started').length,3,'council and independent members are visible before they finish');
  assert.equal(events.filter(event=>event.type==='message_end'&&event.message?.customType===SCOPE_COUNCIL_PROGRESS).length,3);
  const advice='Keep the source-backed acceptance criteria visible. '.repeat(6)+'Review final fixture evidence.';
  peers[0](result(advice)); peers[1](result('Check the fixture edge cases.'));
  await tick();
  assert.equal(peers.length,3);
  assert.equal(sends.filter(row=>row.message.details.status==='completed').length,2);
  assert.match(sends.at(-1).message.content,/Critique perspectives.*started/);
  peers[2](result('The fixture perspectives agree on validation; check their assumptions.'));
  assert.equal((await pending).status,'complete');
  await Promise.all(deliveries);
  assert.match(sends.at(-1).message.content,/Council.*completed/);
  resetSharedControl(); peers.length=0;
  const controller=new AbortController();
  const cancelled=globalThis[SCOPE_COUNCIL_RUNNER]({task},ctx,controller.signal);
  await tick(); assert.equal(peers.length,2); controller.abort();
  assert.equal((await cancelled).status,'unavailable');
  await Promise.all(deliveries);
  assert.match(sends.at(-1).message.content,/Council.*stopped/);
  const countAfterCancellation=sends.length;
  for(const finish of peers) finish(result('A late response must never appear.'));
  await tick(); assert.equal(sends.length,countAfterCancellation);
  assert.ok(sends.every(row=>row.message.display&&row.message.excludeFromContext&&row.options.triggerTurn===false));
  assert.equal(modelCalls,1,'progress does not trigger a model turn');
  assert.doesNotMatch(JSON.stringify(convertToLlm(session.agent.state.messages)),/Scope council:|Keep the source-backed/);
  const renderer=renderers.get(SCOPE_COUNCIL_PROGRESS);
  assert.equal(typeof renderer,'function');
  initTheme('dark');
  for(const {message} of sends){
    const component=new CustomMessageComponent(message,renderer);
    for(const expanded of [false,true]){
      component.setExpanded(expanded);
      for(const width of [12,20,42,120]){
        const lines=component.render(width);
        for(const line of lines){assert.ok(visibleWidth(line)<=width);assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g,''),/[\x00-\x1f\x7f-\x9f]/);}
        assert.match(lines.map(stripTerminalSequences).join('\n'),/Scope/);
      }
    }
    if(message.details.advice===advice){
      component.setExpanded(false);assert.match(component.render(120).map(stripTerminalSequences).join(' ').replace(/\s+/g,' '),/Expand for the full council advice/);
      component.setExpanded(true);assert.match(component.render(120).map(stripTerminalSequences).join(' ').replace(/\s+/g,' '),/Review final fixture evidence/);
    }
  }
  finishModel(); await prompt;
  const restored=SessionManager.open(session.sessionManager.getSessionFile());
  const persisted=restored.getBranch().filter(entry=>entry.customType===SCOPE_COUNCIL_PROGRESS);
  assert.equal(persisted.length,sends.length);
  assert.equal(persisted.find(entry=>entry.details?.advice===advice)?.excludeFromContext,true);
  assert.doesNotMatch(JSON.stringify(restored.buildSessionContext().messages),/Scope council:|Keep the source-backed/);
});

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

test('advisors receive the tracked session requirements, not just the task excerpt',async()=>{
  const calls=[];
  registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{
    available:()=>models,constraints:()=>({}),
    launch:async(_id,params)=>{calls.push(params);return result('Evidence from peer');},
  });
  const ledgerCtx={...context(),sessionManager:{...context().sessionManager,getBranch:()=>[
    {type:'custom',customType:'requirement-ledger-v1',data:{items:[{id:'R2',text:'Preserve the exact title Keep title'},{id:'R3',text:'Rework the widget easing'}],subjective:[],unbounded:false,next:3}},
  ]}};
  const output=await globalThis[SCOPE_COUNCIL_RUNNER]({task},ledgerCtx);
  assert.equal(output.status,'complete');
  assert.match(calls[0].task,/Open requirements \(session R#\):/);
  assert.match(calls[0].task,/R2: Preserve the exact title Keep title/);
});

test('settled local perspective cues inform critique without replacing peer evidence',async()=>{
  const calls=[];
  registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{
    available:()=>models,constraints:()=>({}),
    rankPerspectives:async()=>({ok:true,ms:1,cached:false,shadow:false,value:{ranked:[{id:'security',score:.98},{id:'testing',score:.94}],margin:.04}}),
    launch:async(_id,params)=>{calls.push(params);await Promise.resolve();return result(`Evidence from peer ${calls.length}`);},
  });
  const output=await globalThis[SCOPE_COUNCIL_RUNNER]({task},context());
  assert.equal(output.status,'complete');
  assert.equal(calls.length,3);
  assert.match(calls[0].task,/Preservation peer/);
  assert.match(calls[1].task,/Meaningful-change peer/);
  assert.doesNotMatch(calls[0].task,/Optional semantic focus cues/);
  assert.match(calls[2].task,/Optional semantic focus cues.*security:.*testing:/);
  assert.match(calls[2].task,/Evidence from peer 2/);
  assert.match(calls[2].task,/do not establish findings or limit required review/);
});

test('a slow or shadow perspective rank cannot delay or alter council critique',async()=>{
  for(const rankPerspectives of [()=>new Promise(()=>{}),async()=>({ok:true,ms:1,cached:false,shadow:true,value:{ranked:[{id:'security',score:.98}],margin:.04}})]) {
    resetSharedControl();
    const calls=[];
    registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{available:()=>models,constraints:()=>({}),rankPerspectives,
      launch:async(_id,params)=>{calls.push(params);return result('Original peer evidence');}});
    let timer;
    try {
      const output=await Promise.race([globalThis[SCOPE_COUNCIL_RUNNER]({task},context()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Council waited for optional local ranking')),1000);})]);
      assert.equal(output.status,'complete');
      assert.equal(calls.length,3);
      assert.doesNotMatch(calls[2].task,/Optional semantic focus cues/);
      assert.match(calls[2].task,/Original peer evidence/);
    } finally {clearTimeout(timer);}
  }
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
  assert.match(String(synth.params.task),/Recover the explicit title reference before widening the change/);
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

test('failed peers keep the categorized row and name the underlying failure',async()=>{
  const entries=[];
  const pi={getActiveTools:()=>['subagent'],appendEntry:(customType,data)=>entries.push({customType,data})};
  registerScopeCouncilRunner(pi,{launch:async()=>({isError:true,message:'402: credit limit exceeded',details:{results:[{exitCode:1,error:true,usage:{input:5,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:1}}]}}),available:()=>models,constraints:()=>({})});
  const runner=globalThis[SCOPE_COUNCIL_RUNNER];
  const output=await runner({task,graph:'src/widget.ts owns the widget behavior.',history:{evidence:[]}},context(),new AbortController().signal);
  assert.equal(output.status,'unavailable');
  assert.match(output.gap,/Underlying failure: 402: credit limit exceeded/,'gap names the cause instead of only "failed"');
  const costs=entries.filter(e=>e.customType==='subagent-cost-v1'&&e.data.state==='failed');
  assert.ok(costs.length>=1,'failed peers persist cost rows');
  assert.equal(costs[0].data.results[0].exitCode,1,'raw executor row survives instead of a generic placeholder');
  assert.equal(costs[0].data.results[0].usage.input,5,'usage survives for accounting');
});

test('read-only councils retain the parent implementation request without requiring child edits', async () => {
  const calls=[];
  registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{available:()=>models,constraints:()=>({}),rankPerspectives:null,
    launch:async(_id,params)=>{calls.push(params);return result('The current source requires the requested navigation update; this is advice only.');}});
  const objective='Implement keyboard navigation and update the tests. Preserve the existing title.';
  const output=await globalThis[SCOPE_COUNCIL_RUNNER]({task:objective},context());
  assert.equal(output.status,'complete');
  for(const params of calls) {
    assert.ok(params.task.includes(objective),'the parent task is still present verbatim');
    assert.equal(classifyTaskMutationIntent(params.agent,params.task).kind,'read-only');
    assert.equal(taskMayMutate(params.task),false);
  }
  assert.equal(classifyTaskMutationIntent('worker',objective).kind,'implementation');
  assert.equal(classifyTaskMutationIntent('worker','Never edit tests; implement the source fix.').kind,'implementation');
  assert.equal(taskMayMutate('Never edit tests; implement the source fix.'),true);
});

test('failed council wrappers link to native child identities with visible role labels', async () => {
  const entries=[];
  const pi={getActiveTools:()=>['subagent'],appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
  let sequence=0;
  registerScopeCouncilRunner(pi,{available:()=>models,constraints:()=>({}),rankPerspectives:null,launch:async()=>{
    const runId=`native-fixture-${++sequence}`;
    pi.appendEntry('subagent-lifecycle-v1',{runId,mode:'single',state:'running',results:[{index:0,status:'running'}]});
    pi.appendEntry('subagent-lifecycle-v1',{runId,mode:'single',state:'failed',results:[{index:0,status:'failed'}]});
    return {isError:true,details:{runId,results:[{index:0,exitCode:1,error:'HTTP 400 invalid_request_error',model:'fixture/route'}]}};
  }});
  await globalThis[SCOPE_COUNCIL_RUNNER]({task},context());
  const ledger=reduceChildEvents(projectTranscriptChildren(entries));
  assert.equal(ledger.tasks.length,2,'two real peers remain two tasks rather than four wrapper/native duplicates');
  assert.ok(ledger.tasks.every(task=>task.label.startsWith('Scope council:')));
  assert.ok(ledger.tasks.every(task=>task.attempts.length===1&&task.attempts[0].runId.startsWith('native-fixture-')));
});

process.on('exit',()=>{
  for(const [key,value] of Object.entries(environment)){if(value===undefined) delete process.env[key]; else process.env[key]=value;}
  fs.rmSync(root,{recursive:true,force:true});
});


test('replacing a council runner cancels its peers and a stale shutdown cannot remove the new owner', async () => {
  const hooks=[], signals=[], entries=[];
  const pi={getActiveTools:()=>['subagent'],appendEntry:(type,data)=>entries.push({type,data}),on:(name,fn)=>{if(name==='session_shutdown')hooks.push(fn);}};
  registerScopeCouncilRunner(pi,{available:()=>models,constraints:()=>({}),rankPerspectives:null,
    launch:async(_id,_params,signal)=>{signals.push(signal);return new Promise(()=>{});}});
  const old=globalThis[SCOPE_COUNCIL_RUNNER];
  const pending=old({task},context());
  assert.equal(signals.length,2);
  registerScopeCouncilRunner(pi,{available:()=>models,constraints:()=>({}),rankPerspectives:null,launch:async()=>result('Current owner advice with concrete evidence.')});
  const replacement=globalThis[SCOPE_COUNCIL_RUNNER];
  assert.ok(signals.every(signal=>signal.aborted));
  assert.equal((await pending).status,'unavailable');
  assert.match((await old({task},context())).gap,/replaced|shut down/);
  hooks[0]();
  assert.equal(globalThis[SCOPE_COUNCIL_RUNNER],replacement);
  hooks[1]();
  assert.equal(globalThis[SCOPE_COUNCIL_RUNNER],undefined);
});

test('council honors the active context signal even without an explicit parent signal', async () => {
  let launches=0;
  registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{available:()=>models,constraints:()=>({}),launch:async()=>{launches++;return result('unexpected');}});
  const controller=new AbortController();controller.abort();
  const output=await globalThis[SCOPE_COUNCIL_RUNNER]({task},{...context(),signal:controller.signal});
  assert.equal(output.status,'unavailable');assert.equal(launches,0);
});


test('cancelled councils clear their status without erasing a replacement owner status',async()=>{
  for(const mode of ['abort','replace']){
    resetSharedControl();
    const statuses=[],controller=new AbortController(),ctx={...context(),ui:{setStatus:(_key,value)=>statuses.push(value)}};
    const messages=[];
    const pi={getActiveTools:()=>['subagent'],appendEntry(){},sendMessage:message=>messages.push(message)};
    const deps={available:()=>models,constraints:()=>({}),rankPerspectives:null,launch:()=>new Promise(()=>{})};
    registerScopeCouncilRunner(pi,deps);
    const pending=globalThis[SCOPE_COUNCIL_RUNNER]({task},ctx,controller.signal);
    assert.ok(statuses.at(-1));
    if(mode==='abort')controller.abort();else registerScopeCouncilRunner(pi,deps);
    await pending;
    assert.equal(statuses.at(-1),undefined,mode);
    assert.equal(messages.filter(message=>message.details.status==='stopped').length,1,mode);
  }
});

test('council progress delivery failures do not reject successful advisory work',async()=>{
  registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){},sendMessage:()=>Promise.reject(new Error('Synthetic display failure'))},
    {available:()=>models,constraints:()=>({}),rankPerspectives:null,launch:async()=>result('Bounded fixture advice.')});
  assert.equal((await globalThis[SCOPE_COUNCIL_RUNNER]({task},context())).status,'complete');
  await new Promise(resolve=>setImmediate(resolve));
});

test('configured council routes survive economy admission without changing their role order',async()=>{
  const fallback=await import(shared+'model-fallback.ts');
  const prefs=await import(shared+'llm-preferences.ts');
  const configured=[
    {...model('vendor/preferred'),provider:'friendli',baseUrl:'https://api.friendli.ai/serverless/v1'},
    {...model('vendor/backup'),provider:'friendli',baseUrl:'https://api.friendli.ai/serverless/v1',cost:{input:99,output:99,cacheRead:0,cacheWrite:0}},
  ];
  const available=configured.map(row=>({...row,fullId:`${row.provider}/${row.id}`}));
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE,JSON.stringify({preferences:{council:configured.map(row=>({provider:row.provider,model:row.id}))}}));
  prefs.clearLlmPreferencesCache();
  const calls=[];
  try{
    for(const row of available) assert.throws(()=>fallback.buildModelCandidates(row.fullId,undefined,available,undefined,{origin:'explicit'}),/economy|price|expensive|metered/i,'direct explicit overrides retain their strict economy policy');
    registerScopeCouncilRunner({getActiveTools:()=>['subagent'],appendEntry(){}},{available:()=>configured,constraints:()=>({}),rankPerspectives:null,
      launch:async(_id,params)=>{
        calls.push(params);
        assert.equal(params.modelOrigin,'configured');
        const route=fallback.resolveEffectiveSubagentModel(params.model,undefined,undefined,available,undefined,{source:params.modelOrigin==='explicit'?'explicit':'inherited',task:params.task});
        assert.deepEqual(fallback.buildModelCandidates(route,undefined,available,undefined,{origin:params.modelOrigin,task:params.task}),[params.model]);
        return result('Bounded council advice based on the supplied source evidence.');
      }});
    const output=await globalThis[SCOPE_COUNCIL_RUNNER]({task},context());
    assert.equal(output.status,'complete');
    assert.deepEqual(calls.slice(0,2).map(row=>row.model),available.map(row=>row.fullId));
    assert.equal(calls.length,3);
  }finally{fs.rmSync(process.env.PI_LLM_PREFERENCES_FILE,{force:true});prefs.clearLlmPreferencesCache();}
});
