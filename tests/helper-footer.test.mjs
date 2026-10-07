import test from 'node:test';
import assert from 'node:assert/strict';
import { FooterComponent } from '../core/coding-agent/dist/modes/interactive/components/footer.js';
import { initTheme } from '../core/coding-agent/dist/modes/interactive/theme/theme.js';
import { stripTerminalSequences, visibleWidth } from '@yunuspi/tui';
import { AgentSession } from '@yunuspi/coding-agent';
import { registerToolDiscovery } from '../agent/extensions/lib/tool-discovery.ts';
import { collectSessionCost } from '../agent/extensions/lib/session-cost.ts';
import { collectSessionMetrics } from '../agent/extensions/lib/session-metrics.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensions } from '../core/coding-agent/dist/core/extensions/loader.js';
initTheme('dark', false);

test('extension loader and terminal share the owned accounting exports',async()=>{
 const shared=await import('@yunuspi/coding-agent/session-accounting');
 assert.equal(collectSessionCost,shared.collectSessionCost);
 assert.equal(collectSessionMetrics,shared.collectSessionMetrics);
 const dir=await mkdtemp(join(tmpdir(),'yunuspi-accounting-loader-'));
 try{
  const file=join(dir,'accounting.ts');
  await writeFile(file,`import {collectSessionCost,collectSessionMetrics} from '@yunuspi/coding-agent/session-accounting';
   export default function(pi){pi.registerCommand('accounting-fixture',{description:'fixture',handler:async()=>({cost:collectSessionCost([]).formatted,responses:collectSessionMetrics([]).responses})});}`);
  const result=await loadExtensions([file],dir);
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(await result.extensions[0].commands.get('accounting-fixture').handler(),{cost:'$?',responses:0});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('source and built terminal footer agree with receipt collectors for retries and unknown cost',async()=>{
 const source=await import('../core/coding-agent/src/modes/interactive/components/footer.js');
 (await import('../core/coding-agent/src/modes/interactive/theme/theme.js')).initTheme('dark',false);
 const lifecycle=(runId,state)=>({type:'custom',customType:'subagent-lifecycle-v1',data:{runId,mode:'single',state,results:[{index:0,status:state}]}});
 const receipt=(runId,row)=>({type:'custom',customType:'subagent-cost-v1',data:{runId,results:[row]}});
 const usage=(input,cost)=>({input,output:1,cacheRead:0,cacheWrite:0,turns:1,cost:{total:cost,source:'provider-reported'}});
 const retries=[
  receipt('skill-discovery-fixture',{index:0,attempt:1,status:'running'}),lifecycle('native-one','running'),lifecycle('native-one','failed'),
  receipt('skill-discovery-fixture',{index:0,attempt:1,runId:'native-one',status:'failed',usage:usage(10,.01)}),
  receipt('skill-discovery-fixture',{index:0,attempt:2,status:'running'}),lifecycle('native-two','running'),lifecycle('native-two','completed'),
  receipt('skill-discovery-fixture',{index:0,attempt:2,runId:'native-two',status:'completed',usage:usage(20,.02)}),
 ];
 assert.equal(collectSessionCost(retries).total,.03);
 assert.equal(collectSessionCost(retries).pending,0);
 assert.equal(collectSessionMetrics(retries).childTokens,32);
 const auxiliary=data=>({type:'custom',customType:'auxiliary-model-usage-v1',data:{id:'observer-1',owner:'session-observer',provider:'fixture',model:'observer',...data}});
 const auxiliaryFinal=auxiliary({status:'completed',usage:{input:100,output:20,cacheRead:80,cacheWrite:0,reasoning:7,cost:{total:.04,source:'provider-reported'}}});
 const auxiliaryCase=[auxiliary({status:'pending'}),auxiliaryFinal,auxiliaryFinal,auxiliary({status:'pending'})];
 const cases=[retries,auxiliaryCase,[auxiliary({status:'timeout'})],[receipt('quality-review-fixture',{index:0,status:'failed',usage:{}})],
  [receipt('quality-review-fixture',{index:0,status:'failed',stage:'launch',childProcessStarted:false,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,turns:0,cost:0,costDetails:{reported:0,estimated:0,unknown:false,subscription:false,seen:true,estimatedUsage:false}}})],
  [receipt('started-timeout',{index:0,error:true,timedOut:true,exitCode:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,turns:0,cost:0}})]];
 for(const entries of cases){
  const session={state:{model:{id:'fixture',provider:'fixture',contextWindow:10000}},getContextUsage:()=>({percent:0,contextWindow:10000}),modelRuntime:{isUsingSubscription:()=>false},sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getCwd:()=>'/workspace/fixture',getSessionName:()=>undefined,getSessionId:()=> 'fixture'}};
  const data={getGitBranch:()=>undefined,getAvailableProviderCount:()=>1,getExtensionStatuses:()=>new Map()};
  for(const Component of [source.FooterComponent,FooterComponent]){
   const footer=new Component(session,data);
   footer.setExpanded(true);
   const rendered=footer.render(240).join('\n');
   assert.ok(rendered.includes(`${collectSessionCost(entries).formatted} total`));
   for(const metric of collectSessionMetrics(entries).footer)assert.ok(rendered.includes(metric),metric);
   if(entries===auxiliaryCase){for(const text of ['↑100','↓20','R80','Agents 0 (0 active)'])assert.ok(rendered.includes(text),text);assert.ok(!rendered.includes('↓27'));}
  }
 }
});

test('footer keeps primary KPIs compact and expands the complete activity and status ledger',()=>{
 const entries=['subagent','quality_review','project_tests','skill_review','session_self','browser_session','bg_run','tool_search'].map((toolName,index)=>({type:'message',message:{role:'toolResult',toolName,toolCallId:String(index),content:[]}}));
 const session={state:{model:{id:'example-model',provider:'example',contextWindow:128000},thinkingLevel:'high'},getContextUsage:()=>({percent:12.5,contextWindow:128000}),modelRuntime:{isUsingSubscription:()=>false},sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getCwd:()=>'/workspace/example',getSessionName:()=>undefined,getSessionId:()=> 'example-session'}};
 const statuses=new Map([['00-harness-activity','✓ JEV returned · 25ms'],['model-catalog','Model list: example · updated 1d 14h ago · stale · /catalog-status']]);
 const footer=new FooterComponent(session,{getGitBranch:()=> 'main',getAvailableProviderCount:()=>1,getExtensionStatuses:()=>statuses});
 for(const width of [40,80,120]){
  footer.setExpanded(false);
  const lines=footer.render(width);
  assert.ok(lines.every(line=>visibleWidth(line)<=width),`width ${width}`);
  const text=lines.map(stripTerminalSequences).join('\n');
  assert.ok(lines.length<=6,`compact footer grows at ${width}`);
  for(const word of ['example-model','Context','Cache','Tools','JEV','/catalog-status'])assert.ok(text.includes(word),`${word} at ${width}`);
  assert.doesNotMatch(text,/Powers|Failures 0|Agents 0/);
  footer.setExpanded(true);
  const expanded=footer.render(width);
  assert.ok(expanded.every(line=>visibleWidth(line)<=width),`expanded width ${width}`);
  for(const word of ['Agents','Review','Tests','Skills','Self','Browser','Jobs','Tools','JEV','/catalog-status'])assert.ok(expanded.join('\n').includes(word),`${word} in details at ${width}`);
 }
});

test('footer prioritizes active work and warnings, preserves effort, and sanitizes external labels',()=>{
 const entries=[{type:'custom',customType:'subagent-lifecycle-v1',data:{runId:'fixture',mode:'single',results:[{index:0,status:'running'}]}},
  {type:'message',message:{role:'toolResult',toolCallId:'error',toolName:'read',isError:true,content:[]}}];
 const statuses=new Map([['02-harness-pulse','harness · Guardian 100 checks'],['other','\x1b[2Jprovider\x07\nnotice'],['model-output-limit','Output limit unverified: 16000 tokens'],['model-catalog','Model list: fixture · stale · /catalog-status'],['worktree-checkpoint','checkpoint 40 files']]);
 const session={state:{model:{id:'a-long-selected-model-name',provider:'fixture',reasoning:true,contextWindow:128000},thinkingLevel:'ultra'},getContextUsage:()=>({percent:95,contextWindow:128000}),modelRuntime:{isUsingSubscription:()=>false},sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getCwd:()=>'/workspace/\x1b[2Jdemo',getSessionName:()=> 'name\nnext',getSessionId:()=> 'fixture-session'}};
 const footer=new FooterComponent(session,{getGitBranch:()=> 'main\x07',getAvailableProviderCount:()=>2,getExtensionStatuses:()=>statuses});
 for(const width of [1,12,40,80,120])for(const expanded of [false,true]){
  footer.setExpanded(expanded);
  const lines=footer.render(width);
  assert.ok(lines.every(line=>visibleWidth(line)<=width));
  for(const line of lines)assert.doesNotMatch(stripTerminalSequences(line),/[\x00-\x1f\x7f-\x9f]/);
  if(width>=40){
   const text=lines.map(stripTerminalSequences).join('\n');
   assert.match(text,/ultra/);
   if(!expanded){assert.match(text,/Agents 1 active/);assert.match(text,/Failures 1/);assert.match(text,/Output limit unverified/);assert.match(text,/\+2/);assert.doesNotMatch(text,/Guardian 100/);}
   else assert.match(text,/Guardian 100/);
  }
 }
});

test('compact cache KPI keeps unknown distinct from a measured miss and scopes reuse to the selected model',()=>{
 const response=(model,input,cacheRead,cacheReadReported=true)=>({type:'message',message:{role:'assistant',provider:'fixture',model,content:[],usage:{input,output:1,cacheRead,cacheWrite:0,cacheReadReported}}});
 const first=response('primary',200,800);
 const auxiliary={type:'custom',customType:'auxiliary-model-usage-v1',data:{id:'aux',owner:'session-observer',provider:'fixture',model:'review',status:'completed',usage:{input:1,output:1,cacheRead:99999,cacheWrite:0}}};
 for(const [entries,model,expected] of [
  [[], 'primary','?'], [[response('primary',100,0,false)],'primary','?'],
  [[{type:'message',message:{role:'assistant',provider:'fixture',model:'primary',content:[],stopReason:'error'}}],'primary','?'],
  [[response('primary',100,0)],'primary','0.0%'],
  [[first,response('primary',100,0),auxiliary],'primary','72.7%'],
  [[first,{type:'model_change',provider:'fixture',modelId:'next'},response('next',50,50)],'next','50.0%'],
 ]){
  const session={state:{model:{id:model,provider:'fixture',contextWindow:128000}},getContextUsage:()=>({contextWindow:128000}),modelRuntime:{isUsingSubscription:()=>false},sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getCwd:()=>'/workspace',getSessionName:()=>undefined,getSessionId:()=> 'fixture'}};
  const footer=new FooterComponent(session,{getGitBranch:()=>undefined,getAvailableProviderCount:()=>1,getExtensionStatuses:()=>new Map()});
  const text=plainFooter(footer.render(120));
  assert.ok(text.includes(`Cache ${expected}`),text);
  assert.match(text,/Context \?/);
  footer.setExpanded(true);
  const detail=plainFooter(footer.render(120));
  assert.ok(detail.includes(`Cache ${expected}`),detail);
  assert.doesNotMatch(detail,/NaN|undefined/);
 }
});

function plainFooter(lines){return lines.map(stripTerminalSequences).join('\n');}

test('owned next-turn snapshot includes a discovered tool without another user prompt',async()=>{
 const session=Object.create(AgentSession.prototype), hooks=new Map(), definitions=new Map();
 session.agent={state:{tools:[],model:{id:'example'},thinkingLevel:'off'}};
 session._toolRegistry=new Map(['read','tool_search','browser_session'].map(name=>[name,{name,description:name,parameters:{type:'object',properties:{}}}]));
 session._rebuildSystemPrompt=()=> 'fixture system prompt';
 session._compactBeforeNextAssistantResponse=async context=>context;
 session.setActiveToolsByName([...session._toolRegistry.keys()]);
 session._installAgentNextTurnRefresh();
 const pi={on:(name,fn)=>hooks.set(name,fn),registerTool:def=>definitions.set(def.name,def),getAllTools:()=>[...session._toolRegistry.values()],getActiveTools:()=>session.agent.state.tools.map(tool=>tool.name),setActiveTools:names=>session.setActiveToolsByName(names),appendEntry(){}};
 registerToolDiscovery(pi);
 const ctx={cwd:'/fixture',sessionManager:{getSessionId:()=> 'fixture',getBranch:()=>[]}};
 hooks.get('session_start')({},ctx);
 await definitions.get('tool_search').execute('call',{names:['browser_session']},undefined,undefined,ctx);
 assert.ok(!pi.getActiveTools().includes('browser_session'));
 hooks.get('turn_end')({},ctx);
 const next=await session.agent.prepareNextTurnWithContext({context:{messages:[],tools:[]}},new AbortController().signal);
 assert.ok(next.context.tools.some(tool=>tool.name==='browser_session'));
});
