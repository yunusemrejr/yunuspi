import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {emitSessionShutdownEvent} from '../core/coding-agent/src/core/extensions/runner.js';
import {registerToolDiscovery} from '../agent/extensions/lib/tool-discovery.ts';
import {createGoal} from '../agent/extensions/lib/goal-state.ts';

test('a resumed goal preserves discovery ownership and text models can reach native ambient tools', {timeout:60000}, async () => {
 const root=path.resolve(import.meta.dirname,'..'),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'motion-routing-sdk-'));
 const names=['PI_CODING_AGENT_DIR','PI_JEV','PI_NEEDLE','PI_TOOL_DISCOVERY','PI_SUBAGENT_CHILD','PI_LOCAL_LM','PI_GOAL'];
 const prior=Object.fromEntries(names.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{PI_CODING_AGENT_DIR:cwd,PI_JEV:'off',PI_NEEDLE:'off',PI_LOCAL_LM:'off',PI_TOOL_DISCOVERY:'on',PI_GOAL:'1'});delete process.env.PI_SUBAGENT_CHILD;
 let session;
 try {
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   additionalExtensionPaths:['goal.ts','video-studio.ts','deliverables.ts'].map(file=>path.join(root,'agent/extensions',file)),extensionFactories:[registerToolDiscovery]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const model={id:'motion-fixture',name:'Motion fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
  const manager=SessionManager.inMemory(cwd);manager.appendCustomEntry('goal-state-v1',{...createGoal('Create a detailed fixed camera ambient video'),status:'paused'});
  const contexts=[],errors=[];
  const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),
   streamSimple(selected,context,options){
    const first=contexts.length===0;contexts.push({tools:context.tools.map(tool=>tool.name),model:selected.id,thinking:options?.reasoning});
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:first?[{type:'toolCall',id:'activate',name:'tool_search',arguments:{names:['deliverable_check'],enable:true}}]:[{type:'text',text:'Fixture boundary.'}],stopReason:first?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
    return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
   }};
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:manager,thinkingLevel:'high'}));
  await session.bindExtensions({onError:error=>errors.push(error)});
  await session.prompt('Create a fixed camera ambient motion video using the approved image plate.',{source:'rpc'});
  assert.deepEqual(errors,[]);assert.equal(contexts.length,2);
  assert.ok(contexts[0].tools.includes('goal'),JSON.stringify({branch:manager.getBranch(),contexts}));assert.ok(contexts[0].tools.includes('video_ambient'));
  const result=session.messages.find(message=>message.role==='toolResult' && message.toolCallId==='activate');
  assert.equal(result.isError,false,JSON.stringify(result.content));
  assert.ok(contexts[1].tools.includes('deliverable_check'),'activation is available in the next turn of the same request');
  assert.ok(contexts.every(c=>c.model==='motion-fixture' && c.thinking==='high'));
 } finally {
  if(session){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}
  for(const key of names)prior[key]===undefined?delete process.env[key]:process.env[key]=prior[key];fs.rmSync(cwd,{recursive:true,force:true});
 }
});
