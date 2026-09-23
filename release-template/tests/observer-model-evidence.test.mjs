import test from 'node:test';
import assert from 'node:assert/strict';
import { observerModelEvidence } from '../agent/extensions/lib/observer-model-evidence.ts';
const model = {provider:'fixture',id:'preferred',api:'openai-completions',baseUrl:'https://invalid.example',contextWindow:32000,maxTokens:4096};
const preferences = {version:1,models:{chosen:{provider:'fixture',model:'preferred'}},preferences:{subagents:{models:['chosen']}}};
test('observer sees configured choices and measured usage without credentials or private text', () => {
 const text = observerModelEvidence({models:[{...model,apiKey:'PRIVATE_KEY'}],preferences,entries:[{type:'message',id:'response',message:{role:'assistant',provider:'fixture',model:'preferred',content:[{type:'text',text:'PRIVATE_BODY'}],stopReason:'error',usage:{input:3,output:1,cost:{total:0.02,source:'provider-reported'}}}}]});
 const evidence=JSON.parse(text);
 assert.equal(evidence.preferences[0].routes[0].route,'fixture/preferred');
 assert.equal(evidence.preferences[0].routes[0].seen,true);
 assert.equal(evidence.usage[0].failedResponses,1);
 assert.equal(evidence.cost.reportedUsd,0.02);
 assert.deepEqual(evidence.provenFreeCandidates,[]);
 assert.doesNotMatch(text,/PRIVATE|invalid\.example/);
 assert.match(evidence.policy,/not quality scores/);
});
test('missing usage and unresolved preferences stay unknown without fabricated free routes', () => {
 const evidence=JSON.parse(observerModelEvidence({models:[{...model,cost:{input:0,output:0}}],preferences,entries:[{type:'message',message:{role:'assistant',provider:'fixture',model:'preferred'}}],restrictions:{sameModel:true,freeOnly:true},currentModel:model}));
 assert.equal(evidence.cost.unknown,true);
 assert.deepEqual(evidence.provenFreeCandidates,[]);
 assert.equal(evidence.restrictions.sameModel,true);
 const missing=JSON.parse(observerModelEvidence({models:[],preferences,entries:[]}));
 assert.equal(missing.preferences[0].routes[0].available,false);
 assert.equal(missing.preferences[0].routes[0].seen,false);
});
test('large histories disclose their scope and bounded payload remains whole JSON', () => {
 const entries=Array.from({length:2100},()=>({type:'message',message:{role:'assistant',provider:'fixture',model:'preferred'}}));
 const text=observerModelEvidence({models:[model],preferences,entries});
 assert.ok(text.length<=2600); assert.match(JSON.parse(text).scope,/earlier usage unknown/);
 assert.equal(JSON.parse(text).usage[0].responses,2000);
});

test('incomplete model identity remains unknown instead of generating a fictitious route', () => {
 const evidence=JSON.parse(observerModelEvidence({models:[model,{}],preferences,entries:[
  {type:'message',message:{role:'assistant',stopReason:'error'}},
  {type:'message',message:{role:'assistant',provider:'fixture',stopReason:'error'}},
 ]}));
 assert.deepEqual(evidence.usage,[]);
 assert.doesNotMatch(JSON.stringify(evidence),/undefined\/undefined|fixture\/undefined/);
});


test('relevant configured swarm and fusion roles are sampled explicitly without inventing unset roles', () => {
 const configured={...preferences,preferences:{...preferences.preferences,swarm:{models:['chosen']},fusion:{models:['chosen']}}};
 const evidence=JSON.parse(observerModelEvidence({models:[model],entries:[],preferences:configured,preferredRoles:['swarm','fusion','unrelated']}));
 assert.deepEqual(evidence.preferences.map(row=>row.role),['subagents','swarm','fusion','council','quality_review']);
 assert.equal(evidence.preferences.find(row=>row.role==='fusion').routes[0].route,'fixture/preferred');
 assert.match(evidence.preferenceScope,/omitted for budget/);
 const absent=JSON.parse(observerModelEvidence({models:[model],entries:[],preferences,preferredRoles:['swarm','fusion']}));
 assert.ok(!absent.preferences.some(row=>row.role==='swarm'||row.role==='fusion'));
});
