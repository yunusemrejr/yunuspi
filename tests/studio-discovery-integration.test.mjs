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
import {capabilityGroup} from '../agent/extensions/lib/capability-groups.ts';

const root=path.resolve(import.meta.dirname,'..');
const names=['audio_mix'];
const call=(name,args,id=name)=>({type:'toolCall',name,id,arguments:args});

// Only model transport is simulated. Real file extension loading, SDK, discovery
// boundaries, tool schemas, argument validation, native wrappers and MCP workers
// execute; these fixtures never access credentials or a model provider.
test('real SDK lazy discovery activates all studio/preflight tools and preserves native schemas and dispatch',async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'studio-sdk-'));
 const envNames=['PI_CODING_AGENT_DIR','PI_JEV','PI_NEEDLE','PI_TOOL_DISCOVERY','PI_SUBAGENT_CHILD'];
 const previous=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 process.env.PI_CODING_AGENT_DIR=cwd;process.env.PI_JEV='off';process.env.PI_NEEDLE='off';process.env.PI_TOOL_DISCOVERY='on';delete process.env.PI_SUBAGENT_CHILD;
 fs.writeFileSync(path.join(cwd,'index.html'),'<img src="present.svg">');fs.writeFileSync(path.join(cwd,'present.svg'),'<svg/>');
 let session;
 try {
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   additionalExtensionPaths:['media-tools.ts','render-and-wait.ts','utility-tools.ts'].map(file=>path.join(root,'agent/extensions',file)),extensionFactories:[registerToolDiscovery]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const model={id:'studio-fixture',name:'Fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
  const plans=[
   [call('tool_search',{group:'media',names:['audio_mix'],enable:false},'media-preview'),    ...['creative-studio','rendered-design-review'].map(id=>call('tool_search',{kind:'capabilities',id,enable:true},id))],
   names.map((name,index)=>call(name,[{tracks:[]},{files:'not-an-array'},{action:'restart'}][index],`invalid-${name}`)),
   [call('audio_mix',{tracks:[{path:'missing.wav'}]},'audio-dispatch')],
  ];
  const contexts=[],errors=[];let turn=0;
  const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:['synthetic','fixture'].join('-')}}),
   streamSimple(_model,context){
    contexts.push(JSON.parse(JSON.stringify(context)));const content=plans[turn++]??[{type:'text',text:'Fixture complete.'}];
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:content[0].type==='toolCall'?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
    return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
   }};
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),thinkingLevel:'off'}));
  const catalog=new Map(session.getAllTools().map(tool=>[tool.name,tool]));
  for(const name of names)assert.ok(catalog.has(name),`${name} loads from its real extension`);
  assert.equal(capabilityGroup('audio_mix',catalog.get('audio_mix').description),'media');
  await session.bindExtensions({onError:error=>errors.push(error)});
  assert.ok(names.every(name=>!session.getActiveToolNames().includes(name)),'specialized schemas begin off wire');
  await session.prompt('Inspect the synthetic workflow and web assets, validate tool contracts and author one local scene.',{source:'rpc'});
  assert.equal(contexts.length,4);assert.deepEqual(errors,[]);
  assert.ok(names.every(name=>!contexts[0].tools.some(tool=>tool.name===name)));
  assert.ok(names.every(name=>contexts[1].tools.some(tool=>tool.name===name)),'discovered bundles join the next model turn of the same request');
  for(const name of names)assert.deepEqual(contexts[1].tools.find(tool=>tool.name===name).parameters,JSON.parse(JSON.stringify(catalog.get(name).parameters)));
  const results=new Map(session.messages.filter(message=>message.role==='toolResult').map(message=>[message.toolCallId,message]));
  for(const id of ['media-preview','creative-studio','rendered-design-review'])assert.equal(results.get(id).isError,false,id);
  for(const name of names){const result=results.get(`invalid-${name}`);assert.equal(result.isError,true,name);assert.match(JSON.stringify(result.content),/validation|required|allowed|must|expected|schema/i,name);}
  for(const id of ['audio-dispatch'])assert.equal(results.get(id).isError,true,id);
  assert.ok(!session.getAllTools().some(tool=>/restart|publish|upload/.test(tool.name)));
 }finally{
  if(session){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}
  for(const key of envNames)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  fs.rmSync(cwd,{recursive:true,force:true});
 }
});
