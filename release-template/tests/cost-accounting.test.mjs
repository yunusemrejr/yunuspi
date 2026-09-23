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
const coreRoot=[path.join(root,'core'),path.join(agent,'runtime','core')].find(p=>fs.existsSync(path.join(p,'ai','src','models.js')));
assert.ok(coreRoot,'owned core with ai/src/models.js not found');
const {calculateCost:calculate}=await import(pathToFileURL(path.join(coreRoot,'ai','src','models.js')));
const sliceFn=(src,decl)=>{const start=src.indexOf(decl);assert.ok(start>=0,decl.trim()+' missing from owned core');let i=src.indexOf('{',start),depth=0;for(;i<src.length;i++){const c=src[i];if(c==='\''||c==='"'||c==='`'){const q=c;i++;for(;i<src.length;i++){if(src[i]==='\\'){i++;continue;}if(src[i]===q)break;if(q==='`'&&src[i]==='$'&&src[i+1]==='{'){let d=1;i+=2;for(;i<src.length&&d;i++){if(src[i]==='{')d++;else if(src[i]==='}')d--;}i--;}continue;}}else if(c==='/'&&(src[i+1]==='/'||src[i+1]==='*')){if(src[i+1]==='/'){i=src.indexOf('\n',i);if(i<0)break;}else{i=src.indexOf('*/',i+2);if(i<0)break;i++;}}else if(c==='{')depth++;else if(c==='}'){depth--;if(!depth){i++;break;}}}return src.slice(start,i);};
const responsesSrc=fs.readFileSync(path.join(coreRoot,'ai','src','api','openai-responses.js'),'utf8');
const service=vm.runInNewContext(sliceFn(responsesSrc,'function getServiceTierCostMultiplier')+'\n'+sliceFn(responsesSrc,'function applyServiceTierPricing')+';applyServiceTierPricing',{URL});
for(const f of ['api/openai-completions.js','api/openai-responses.js']){assert.ok(fs.readFileSync(path.join(coreRoot,'ai','src',f),'utf8').includes("'gpt-4o-mini':5/3"),'service pricing table missing from owned '+f);}
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
 const sessionSrc=fs.readFileSync(path.join(coreRoot,'coding-agent','src','core','agent-session.js'),'utf8');
 const marker='/* PI_RESPONSE_BILLING_V1 */';
 const mStart=sessionSrc.indexOf(marker);
 assert.ok(mStart>=0,'owned core billing marker missing from agent-session.js');
 const exprEnd=sessionSrc.indexOf(', event))',mStart);
 assert.ok(exprEnd>mStart,'owned core billing expression anchor drift');
 const expr=sessionSrc.slice(mStart+marker.length,exprEnd).trim();
 const handle=vm.runInNewContext('(async function handle(event){await this._emitExtensionEvent(('+expr+', event))})');
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

test('helper wrapper accounting settles linked native runs without unattributed rows',()=>{
 const NATIVE='690ef1a3-410e-4c1e-ae81-7dc6de94c4d8';
 const file=`/sessions/parent/${NATIVE}/run-0/session.jsonl`;
 const lifecycle=(runId,state)=>({type:'custom',customType:'subagent-lifecycle-v1',data:{runId,mode:'single',state,results:[{index:0,status:state}]}});
 const entries=[
  receipt('auto-assist-1',[{index:0,status:'running'}]),
  lifecycle(NATIVE,'running'),
  lifecycle(NATIVE,'failed'),
  receipt('auto-assist-1',[{index:0,exitCode:1,error:'child-error',timedOut:true,sessionFile:file,model:'openrouter/free/model',usage:usage(.003),totalCost:{costUsd:.003}}]),
  lifecycle('auto-assist-1','failed'),
 ];
 const result=collect(entries);
 close(result.total,.003);assert.equal(result.pending,0);assert.equal(result.unknown,false);
 assert.ok(result.rows.every(r=>r.route!=='unattributed child'));
 // An in-flight wrapper (placeholder only) still leaves honest pending state.
 const flying=collect(entries.slice(0,2));
 assert.equal(flying.unknown,true);assert.equal(flying.pending,2);
 assert.ok(flying.rows.every(r=>r.route!=='unattributed child'));
});

test('a launched child with initial zero counters stays unknown through aggregation and persistence',async()=>{
 const {readCostEvidence}=await load('extensions/lib/cost-evidence.ts');
 const {buildUsedSummary}=await load('extensions/session-signals.ts');
 const {collectSessionMetrics}=await load('extensions/lib/session-metrics.ts');
 const {projectTranscriptChildren,reduceChildEvents}=await load('extensions/pi-subagents/src/runs/shared/child-ledger.ts');
 const initial=empty();
 assert.equal(readCostEvidence(initial).seen,false);
 assert.equal(readCostEvidence(initial).unknown,true);
 const aggregated=empty();addUsageCost(aggregated,initial);
 assert.equal(aggregated.costDetails.seen,false);assert.equal(aggregated.costDetails.unknown,true);
 assert.equal(aggregated.costByModel[0].evidence.unknown,true);
 const entries=[],state={currentSessionId:'fixture',completionOwnerId:'owner'};
 const persist=(runId,row)=>persistSubagentCost({appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})},state,{sessionId:'fixture',completionOwnerId:'owner',runId,mode:'single',results:[row]});
 persist('started',{error:true,timedOut:true,exitCode:1,usage:aggregated});
 const unknown=collect(entries);
 assert.equal(unknown.formatted,'$?');assert.equal(unknown.unknown,true);assert.equal(unknown.pending,0);
 const row=buildUsedSummary(entries).runs[0];assert.equal(row.usageRecorded,false);assert.equal(row.costUsd,undefined);
 assert.equal(collectSessionMetrics(entries).childRowsWithUsage,0);
 assert.equal(reduceChildEvents(projectTranscriptChildren(entries)).tasks[0].attempts[0].usage,undefined);
 persist('no-child',{error:true,stage:'launch',childProcessStarted:false,usage:empty()});
 const noChild=entries.slice(-1), proof=collect(noChild);
 assert.equal(proof.formatted,'$0.000');assert.equal(proof.unknown,false);
 assert.equal(buildUsedSummary(noChild).runs[0].usageRecorded,true);
 assert.equal(reduceChildEvents(projectTranscriptChildren(noChild)).tasks[0].attempts[0].usage.turns,0);
 assert.equal(collectSessionMetrics(noChild).childRowsWithUsage,1);
 persist('priced',{exitCode:0,usage:usage(.03)});
 const partial=collect(entries);assert.equal(partial.total,.03);assert.equal(partial.unknown,true);assert.match(partial.formatted,/\+\?/);
 const sameAttempt=empty();addUsageCost(sameAttempt,usage(.03));addUsageCost(sameAttempt,initial);
 assert.equal(sameAttempt.cost,.03);assert.equal(sameAttempt.costDetails.unknown,true);
 assert.equal(collect([receipt('aggregate',[{usage:sameAttempt}])]).unknown,true);
});

test('provider zero receipts and complete free pricing remain known even with zero counters',async()=>{
 const {readCostEvidence,hasRecordedTokenUsage}=await load('extensions/lib/cost-evidence.ts');
 for(const cost of [{total:0,source:'provider-reported'},{total:0,source:'provider-estimate'},{total:0,complete:true}]){
  const u={...empty(),cost};
  assert.equal(readCostEvidence(u).seen,true);assert.equal(readCostEvidence(u).unknown,false);
  assert.equal(hasRecordedTokenUsage(u),true);
 }
 assert.equal(readCostEvidence({...empty(),cost:{total:0,complete:false}}).unknown,true);
 assert.equal(hasRecordedTokenUsage({cost:{total:0,source:'provider-reported'}}),false,'cost-only receipt cannot establish token counts');
});
