import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const core=path.resolve(import.meta.dirname,'..','core','coding-agent','src');
const {AgentSession}=await import(pathToFileURL(path.join(core,'core','agent-session.js')));

const usage=cost=>({input:100,output:20,cacheRead:0,cacheWrite:0,cost:{total:cost,source:'provider-reported'}});
const entries=[
  {type:'message',id:'1',message:{role:'user',content:'hi'}},
  {type:'message',id:'2',message:{role:'assistant',provider:'openai',model:'main',content:[],usage:usage(0.5)}},
  {type:'custom',customType:'jev-usage-v1',data:{costUsd:0.02,model:'jev',cached:false}},
  {type:'custom',customType:'span-usage-v1',data:{costUsd:0.03,costSource:'provider-reported',model:'span'}},
  {type:'custom',customType:'auxiliary-model-usage-v1',data:{id:'obs1',owner:'session-observer',provider:'deepseek',model:'flash',status:'completed',usage:usage(0.05)}},
  {type:'custom',customType:'subagent-cost-v1',data:{runId:'r1',results:[{index:0,runId:'r1',model:'anthropic/child',usage:{input:100,output:20,cacheRead:0,cacheWrite:0,turns:1,cost:0.4,costDetails:{reported:0.4,estimated:0,unknown:false,subscription:false,seen:true}}}]}},
];
const session=list=>({
  model:{provider:'openai'},modelRuntime:{isUsingSubscription:()=>false},
  sessionManager:{getEntries:()=>list},
  getContextUsage:()=>undefined,
  _sessionCostSummary:AgentSession.prototype._sessionCostSummary,
});

test('session stats report one total over main, delegated and helper model calls',()=>{
  const stats=AgentSession.prototype.getSessionStats.call(session(entries));
  assert.ok(Math.abs(stats.cost-1.0)<1e-9,`total ${stats.cost}`);
  assert.ok(Math.abs(stats.costParts.main-0.5)<1e-9);
  assert.ok(Math.abs(stats.costParts.delegated-0.4)<1e-9);
  assert.ok(Math.abs(stats.costParts.helpers-0.1)<1e-9);
  assert.match(stats.costLabel,/^\$~?1\.000$/);
  assert.ok(stats.costRoutes.length>=3&&stats.costRoutes[0].cost>=stats.costRoutes[1].cost);
});

test('an empty session has no metered cost to show',()=>{
  const stats=AgentSession.prototype.getSessionStats.call(session([entries[0]]));
  assert.equal(stats.cost,0);
  assert.equal(stats.costLabel,'$?');
});
