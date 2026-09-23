import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {createQualityReviewLifecycle} from '../agent/extensions/lib/quality-review.ts';
import checkpoints from '../agent/extensions/checkpoints.ts';

// Provider responses and the independent reviewer are deterministic fixtures;
// actual extension registration, SDK tool execution/updates, session stop and
// context conversion run. This test spends no tokens or provider requests.
test('real SDK exposes review progress without extra model turns, then stops without delegation', async () => {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-progress-sdk-'));
 const previous = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = cwd;
 let session, lifecycle, reviewCalls = 0;
 const updates = [], contexts = [];
 try {
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader = new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi => {
   // Exercise the production stop tool without unrelated checkpoint listeners.
   checkpoints({...pi,on(){},registerTool(tool){if(tool.name === 'session_stop')pi.registerTool(tool);}});
   lifecycle = createQualityReviewLifecycle(pi, {refresh:async()=>{},tests:()=>({need:null}),runner:async request => {
    reviewCalls++;
    for(const aspect of request.aspects){
     await new Promise(resolve=>setImmediate(resolve));
     request.onResult({aspect:aspect.id,ok:true,text:JSON.stringify({outcome:'pass',evidence:['value.js:1 the fixture output has the expected value.'],findings:[],gap:''})});
    }
    return [];
   }});
   pi.on('session_start', (_event,ctx) => lifecycle.restore(ctx));
   pi.on('input', event => lifecycle.input(event));
   pi.on('tool_result', (event,ctx) => lifecycle.result(event,ctx));
   pi.on('session_shutdown', () => lifecycle.shutdown());
  }]});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const model = {id:'review-fixture',name:'Fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000};
  const plans = [
   {name:'write',arguments:{path:'value.js',content:'export const value = 1;'}},
   {name:'quality_review',arguments:{action:'review'}},
   {name:'session_stop',arguments:{action:'stop',reason:'The requested source change is complete; independent review passed.'}},
  ];
  const modelRuntime = {getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:['synthetic','fixture'].join('-')}}),streamSimple(_model,context){
   contexts.push(JSON.parse(JSON.stringify(context)));
   const plan = plans[contexts.length - 1];
   const content = plan ? [{type:'toolCall',id:`call-${contexts.length}`,...plan}] : [{type:'text',text:'Unexpected continuation.'}];
   const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:plan?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
   return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
  }};
  ({session} = await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),tools:['write','quality_review','session_stop'],thinkingLevel:'off'}));
  session.subscribe(event => {if(event.type === 'tool_execution_update')updates.push(event);});
  await session.bindExtensions({});
  await session.prompt('Write the requested source and finish after review.', {source:'rpc'});
  assert.equal(reviewCalls, 1, JSON.stringify({state:lifecycle.snapshot(),messages:session.messages}));
  assert.equal(contexts.length, 3, 'progress and stop create no additional inference');
  assert.ok(updates.some(event => event.toolName === 'quality_review' && event.partialResult.details.reviewProgress.aspects.correctness === 'received'));
  assert.ok(!JSON.stringify(contexts).includes('reviewProgress'), 'transient progress never enters provider context');
  const stop = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'session_stop');
  assert.equal(stop.isError, false);
  assert.equal(stop.details.stopped, true);
  assert.equal(stop.details.gates.subagent.met, false, 'no child is manufactured solely to end the request');
 } finally {
  lifecycle?.shutdown(); session?.dispose();
  if(previous === undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR = previous;
  fs.rmSync(cwd,{recursive:true,force:true});
 }
});
