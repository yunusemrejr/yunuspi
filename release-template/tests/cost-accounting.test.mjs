import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/session-cost.ts')));
const load=rel=>import(pathToFileURL(path.join(agent,rel)));
const {collectSessionCost:collect}=await load('extensions/lib/session-cost.ts');
const {addUsageCost,addAuxiliaryUsage}=await load('extensions/pi-subagents/src/shared/cost-accounting.ts');
const {sumResultsCost,sumResultsUsage,toAgentToolUsage}=await load('extensions/pi-subagents/src/shared/utils.ts');
const {persistSubagentCost}=await load('extensions/pi-subagents/src/extension/session-cost.ts');
const {toWaitCompletion}=await load('extensions/pi-subagents/src/runs/background/wait-completions.ts');
const calculate=vm.runInNewContext('('+fs.readFileSync(path.join(agent,'scripts/patches/calculate-cost.js'),'utf8')+')');
const service=vm.runInNewContext(fs.readFileSync(path.join(agent,'scripts/patches/openai-service-pricing.js'),'utf8')+';applyServiceTierPricing',{URL});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const usage=(total,source='provider-reported',extra={})=>({input:100,output:20,cacheRead:80,cacheWrite:0,cost:{total,source},...extra});
const empty=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,turns:0});
const message=(total,provider='openai',model='example',extra={})=>({type:'message',message:{role:'assistant',provider,model,usage:usage(total),...extra}});
const receipt=(runId,results)=>({type:'custom',customType:'subagent-cost-v1',data:{runId,results}});
const child=(runId,cost,extra={})=>({runId,usage:{input:100,output:20,cacheRead:0,cacheWrite:0,turns:1,cost},...extra});
const model={provider:'openai',id:'gpt-5.6-sol',baseUrl:'https://api.openai.com/v1',cost:{input:4,output:20,cacheRead:.4,cacheWrite:5,tiers:[{inputTokensAbove:200000,input:8,output:30,cacheRead:.8,cacheWrite:10}]}};

test('per-request long-context thresholds include reads/writes and use actual output once',()=>{
 for(const [tokens,expected] of [[200000,2.44],[200001,3.880008]]){
  const u={input:tokens-100000,cacheRead:100000,cacheWrite:0,output:100000,reasoning:80000};
  calculate(model,u);close(u.cost.total,expected);assert.equal(u.cost.complete,true);
  assert.equal(u.cost.provider,'openai');assert.equal(u.cost.model,model.id);
 }
 const u={input:1,cacheRead:0,cacheWrite:200000,output:1};calculate(model,u);assert.equal(u.cost.inputTokensAbove,200000);
});

test('partial tiers inherit base buckets; hourly cache writes are disjoint',()=>{
 const m={...model,cost:{input:2,output:6,cacheRead:.2,cacheWrite:2.5,tiers:[{inputTokensAbove:100,input:4}]}};
 const u={input:100,output:10,cacheRead:0,cacheWrite:100,cacheWrite1h:50};calculate(m,u);
 close(u.cost.total,(400+60+125+400)/1e6);assert.equal(u.cost.rates.output,6);
 const bad={input:1,output:2,cacheRead:0,cacheWrite:5,cacheWrite1h:10};calculate(m,bad);assert.equal(bad.cost.complete,false);assert.ok(bad.cost.total>=0);
});

test('invalid and zero-placeholder prices remain partial, explicit zero is supported',()=>{
 const m={...model,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const u={input:100,output:10,cacheRead:0,cacheWrite:0};calculate(m,u);assert.equal(u.cost.complete,false);assert.equal(collect([message(0,'fixture','unknown',{usage:u})]).formatted,'$?');
 calculate({...m,cost:{...m.cost,knownFree:true}},u);assert.equal(u.cost.complete,true);assert.equal(collect([message(0,'fixture','free',{usage:u})]).unknown,false);
 calculate({...m,cost:{input:1,output:NaN,cacheRead:0,cacheWrite:0}},u);assert.equal(u.cost.complete,false);close(u.cost.total,.0001);
});

test('OpenAI fast alias, flex and regional pricing; compatible gateways keep their schedule',()=>{
 for(const [tier,multiplier] of [['default',1],['fast',2],['priority',2],['flex',.5]]){
  const u={input:100,output:20,cacheRead:10,cacheWrite:0};calculate(model,u);const n=u.cost.total;service(u,tier,model);close(u.cost.total,n*multiplier);
 }
 const u={input:100,output:20,cacheRead:10,cacheWrite:0};calculate(model,u);const n=u.cost.total;service(u,'fast',{...model,baseUrl:'https://us.api.openai.com/v1'});close(u.cost.total,n*2.2);
 for(const m of [{...model,provider:'gateway'}, {...model,baseUrl:'https://api.openai.com.other.invalid/v1'}]){
  const v={input:100,output:20,cacheRead:10,cacheWrite:0};calculate(m,v);const before=v.cost.total;service(v,'fast',m);assert.equal(v.cost.total,before);assert.equal(v.cost.complete,false);
 }
});

test('model switches and duplicate response delivery never reprice or recount history',()=>{
 const a=message(.25,'openai','model-a',{responseId:'response-a'}),b=message(.8,'openrouter','model-b');
 const c=collect([a,{type:'model_change',provider:'other'},a,b]);close(c.total,1.05);assert.equal(c.estimated,0);assert.equal(c.rows.length,2);
 assert.equal(collect([a],true).subscription,false,'selecting a subscription does not imply it was used');
});

test('child cost provenance survives mixed-model attempts and subscription responses',()=>{
 const a=empty();addUsageCost(a,usage(.25),'openrouter');a.turns++;a.input=100;
 addUsageCost(a,usage(.1,'estimate'),'openai');a.turns++;
 addUsageCost(a,usage(99,'estimate'),'openai-codex');a.turns++;
 close(a.cost,.35);assert.equal(a.costDetails.subscription,true);assert.equal(a.costDetails.unknown,false);
 const b=empty();addUsageCost(b,usage(0),'openrouter');b.turns++;
 const combined=sumResultsUsage([{usage:a},{usage:b}]);close(combined.cost,.35);close(combined.costDetails.reported,.25);
 assert.equal(toAgentToolUsage(combined).costDetails.subscription,true);
 const result=collect([receipt('group',[{runId:'a',usage:combined}])]);close(result.total,.35);assert.match(result.formatted,/\(sub\)/);
});

test('unknown child responses remain partial even when other turns have positive cost',()=>{
 const a=empty();addUsageCost(a,usage(.1));a.turns++;
 addUsageCost(a,usage(0,'estimate'));a.turns++;
 assert.equal(a.costDetails.unknown,true);const result=collect([receipt('group',[{usage:a}])]);close(result.total,.1);assert.equal(result.unknown,true);
});

test('compactions and non-delegation tools count once; delegated tool totals are excluded',()=>{
 const a=empty();addAuxiliaryUsage(a,{type:'compaction_end',result:{usage:usage(.2)}});
 addAuxiliaryUsage(a,{type:'message_end',message:{role:'toolResult',toolName:'search',usage:usage(.1)}});
 for(const toolName of ['subagent','bg_wait'])addAuxiliaryUsage(a,{type:'message_end',message:{role:'toolResult',toolName,usage:usage(100)}});
 close(a.cost,.3);assert.equal(a.input,200);assert.equal(a.turns,0);
 const entries=[{type:'compaction',id:'c',usage:usage(.2)},{type:'branch_summary',usage:usage(.1)}];
 close(collect([...entries,entries[0]]).auxiliary.reported,.3);
});

test('nested swarm, workflow-step and direct receipts deduplicate the same physical child',()=>{
 const leaf={id:'leaf',totalCost:{costUsd:.3}};
 const nested={id:'nested',children:[leaf],steps:[{children:[leaf]}]};
 const parent=child('parent',.2,{children:[nested]});
 const entries=[receipt('swarm',[parent]),receipt('fusion',[child('leaf',.3)])];
 close(collect(entries).total,.5);close(sumResultsCost([parent,child('leaf',.3)]).costUsd,.5);
});

test('inclusive totals do not add descendants twice, and persisted receipts preserve that graph',()=>{
 const parent=child('parent',.2,{children:[{id:'nested',totalCost:{costUsd:.5},children:[{id:'leaf',totalCost:{costUsd:.3}}]}]});
 const evidence=[],state={currentSessionId:'session',completionOwnerId:'owner'};
 persistSubagentCost({appendEntry:(customType,data)=>evidence.push({type:'custom',customType,data})},state,{...state,sessionId:'session',runId:'swarm',results:[parent]});
 close(collect(evidence).total,.7);close(collect([...evidence,receipt('extra',[child('leaf',.3)])]).total,.7);
 assert.equal(evidence[0].data.results[0].children[0].id,'nested');
});

test('partial and stale snapshots cannot regress totals; a settled run stays settled',()=>{
 const launch={type:'message',message:{role:'toolResult',toolName:'subagent',details:{runId:'run',asyncId:'run',results:[]}}};
 const entries=[launch,receipt('run',[child('child',.4)]),receipt('run',[child('child',.2)]),launch];
 const result=collect(entries);close(result.total,.4);assert.equal(result.pending,0);assert.equal(result.unknown,false);
 assert.equal(collect([message(1),launch]).unknown,true);
});

test('same-request provider billing can correct an earlier higher estimate',()=>{
 const a=empty();addUsageCost(a,usage(.5,'estimate'));a.turns=1;
 const b=empty();addUsageCost(b,usage(.4));b.turns=1;
 const c=collect([receipt('x',[{usage:a}]),receipt('x',[{usage:b}])]);close(c.total,.4);assert.equal(c.estimated,0);
});

test('zero provider amounts and sub-microdollar charges retain meaningful formatting',()=>{
 assert.equal(collect([message(0)]).formatted,'$0.000');
 assert.equal(collect([message(0,'fixture','m',{usage:usage(0,'provider-estimate')})]).formatted,'$~0.000');
 assert.match(collect([message(1e-9)]).formatted,/1\.000e-9/);
 const a=empty();addUsageCost(a,usage(1),'openai-codex');a.turns=1;
 assert.equal(collect([receipt('x',[{usage:a}])]).formatted,'sub');
});

test('wait/replay projection retains accounting without copying arbitrary fields',()=>{
 const a=empty();addUsageCost(a,usage(.2));a.turns=1;
 const projected=toWaitCompletion({results:[{usage:{...a,privatePayload:'never-copy'},runId:'child'}]},'run');
 assert.equal(projected.results[0].usage.costDetails.reported,.2);
 assert.doesNotMatch(JSON.stringify(projected),/never-copy/);
});

test('depth guard marks incomplete accounting, and sparse nested failures remain unknown',()=>{
 let node={id:'leaf',totalCost:{costUsd:1}};for(let i=0;i<20;i++)node={id:'level'+i,children:[node]};
 assert.equal(collect([receipt('x',[child('parent',.1,{children:[node]})])]).unknown,true);
 assert.equal(collect([receipt('x',[child('parent',.1,{children:[{id:'unpriced'}]})])]).unknown,true);
});


test('mixed child routes remain separate in the cost report after attempts merge',()=>{
 const a=empty();addUsageCost(a,usage(.2),'openai','model-a');a.turns++;
 addUsageCost(a,usage(.3),'openrouter','vendor/model-b');a.turns++;
 const merged=sumResultsUsage([{usage:a}]);
 const report=collect([receipt('x',[{usage:merged,model:'last-model'}])]);
 assert.deepEqual(report.rows.map(r=>r.route).sort(),['openai/model-a','openrouter/vendor/model-b']);
 close(report.rows.reduce((n,r)=>n+r.reported+r.estimated,0),report.total);
});


test('fast prices use the published model-specific factors and unknown schedules stay partial',()=>{
 for (const [id,factor] of [['gpt-5-mini',1.8],['gpt-4.1',1.75],['gpt-4.1-mini',1.75],['gpt-4o',1.7],['gpt-4o-mini',5/3],['o3',1.75],['o4-mini',20/11]]) {
  const u={input:100,output:10,cacheRead:20,cacheWrite:0};calculate({...model,id},u);const base=u.cost.total;service(u,'fast',{...model,id});close(u.cost.total,base*factor);
 }
 const u={input:100,output:10,cacheRead:0,cacheWrite:0};calculate({...model,id:'future-model'},u);service(u,'fast',{...model,id:'future-model'});assert.equal(u.cost.complete,false);
});

test('reported zero corrects a same-turn estimate and stale estimates cannot downgrade billing evidence',()=>{
 const a=empty();addUsageCost(a,usage(.5,'estimate'));a.turns=1;
 const b=empty();addUsageCost(b,usage(0));b.turns=1;
 close(collect([receipt('x',[{usage:a}]),receipt('x',[{usage:b}]),receipt('x',[{usage:a}])]).total,0);
 const c=empty();addUsageCost(c,usage(.5));c.turns=1;
 assert.equal(collect([receipt('x',[{usage:c}]),receipt('x',[{usage:a}])]).estimated,0);
});

test('native provider/auth billing classification follows each response across switches',async()=>{
 const {transform}=await load('scripts/patches/provider-price-accuracy.mjs');
 const body=transform('async function handle(event){await this._emitExtensionEvent(event)}','billing');
 const handle=vm.runInNewContext('('+body+')');
 const delivered=[];
 const owner={modelRuntime:{isUsingSubscription:provider=>provider==='subscription-provider'},_emitExtensionEvent:event=>delivered.push(event)};
 for(const provider of ['subscription-provider','openai']){
  const event={type:'message_end',message:{role:'assistant',provider,model:'same-model',usage:usage(1,'estimate')}};
  await handle.call(owner,event);assert.equal(event.message.usage.cost.billing,provider==='openai'?'metered':'subscription');
 }
 const c=collect(delivered.map(event=>({type:'message',message:event.message})));
 assert.equal(c.total,1);assert.equal(c.subscription,true);
});

test('detached completion replay retains nested inclusive costs and run identities',()=>{
 const a=empty();addUsageCost(a,usage(.2));a.turns=1;
 const saved=toWaitCompletion({results:[{runId:'parent',usage:a,totalCost:{costUsd:.7},children:[{id:'leaf',totalCost:{costUsd:.5},privatePayload:'never-copy'}]}]},'run');
 close(collect([receipt('run',saved.results),receipt('other',[child('leaf',.5)])]).total,.7);
 assert.doesNotMatch(JSON.stringify(saved),/never-copy/);
});
