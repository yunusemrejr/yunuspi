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
const names=['scene_create','scene_render','video_compose','audio_mix','design_audit','workflow_probe','web_asset_check','sys_probe'];
const call=(name,args,id=name)=>({type:'toolCall',name,id,arguments:args});

// Only model transport is simulated. Real file extension loading, SDK, discovery
// boundaries, tool schemas, argument validation, native wrappers and MCP workers
// execute; these fixtures never access credentials or a model provider.
test('real SDK lazy discovery activates all studio/preflight tools and preserves native schemas and dispatch',async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'studio-sdk-'));
 const envNames=['PI_CODING_AGENT_DIR','PI_JEV','PI_NEEDLE','PI_TOOL_DISCOVERY','PI_SUBAGENT_CHILD'];
 const previous=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 process.env.PI_CODING_AGENT_DIR=cwd;process.env.PI_JEV='off';process.env.PI_NEEDLE='off';process.env.PI_TOOL_DISCOVERY='on';delete process.env.PI_SUBAGENT_CHILD;
 fs.writeFileSync(path.join(cwd,'workflow.yml'),'on: push\njobs:\n  inspect: {runs-on: ubuntu-latest}\n');
 fs.writeFileSync(path.join(cwd,'index.html'),'<img src="present.svg">');fs.writeFileSync(path.join(cwd,'present.svg'),'<svg/>');
 let session;
 try {
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   additionalExtensionPaths:['media-tools.ts','render-and-wait.ts','utility-tools.ts','sys-probe.ts'].map(file=>path.join(root,'agent/extensions',file)),extensionFactories:[registerToolDiscovery]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const model={id:'studio-fixture',name:'Fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
  const plans=[
   [call('tool_search',{group:'media',names:['scene_create'],enable:false},'media-preview'),call('tool_search',{group:'web',names:['design_audit'],enable:false},'web-preview'),
    ...['creative-studio','rendered-design-review','delivery-preflight'].map(id=>call('tool_search',{kind:'capabilities',id,enable:true},id))],
   names.map((name,index)=>call(name,[{preset:'invalid'},{mode:'frame'},{clips:[]},{tracks:[]},{width:10},{path:{}},{files:'not-an-array'},{action:'restart'}][index],`invalid-${name}`)),
   [call('scene_create',{preset:'sculpture'},'create'),call('workflow_probe',{path:'workflow.yml'},'workflow'),call('workflow_probe',{path:'missing.yml'},'workflow-failure'),call('web_asset_check',{files:['index.html']},'assets'),
    call('sys_probe',{action:'service_detail',unit:'--all'},'unit-validation'),call('sys_probe',{action:'journal',unit:'fixture.service',cursor:'bad\n--all'},'cursor-validation'),call('design_audit',{source:'fixture.pdf'},'design-source-validation')],
   [call('scene_render',{path:'missing-scene.json'},'render-dispatch'),call('video_compose',{clips:[{path:'missing.mp4',duration:1}]},'video-dispatch'),call('audio_mix',{tracks:[{path:'missing.wav'}]},'audio-dispatch')],
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
  for(const name of ['scene_create','scene_render','video_compose','audio_mix'])assert.equal(capabilityGroup(name,catalog.get(name).description),'media');
  assert.equal(capabilityGroup('design_audit',catalog.get('design_audit').description),'web');
  assert.equal(capabilityGroup('workflow_probe',catalog.get('workflow_probe').description),'operations');
  assert.equal(capabilityGroup('web_asset_check',catalog.get('web_asset_check').description),'web');
  assert.equal(capabilityGroup('sys_probe',catalog.get('sys_probe').description),'operations');
  await session.bindExtensions({onError:error=>errors.push(error)});
  assert.ok(names.every(name=>!session.getActiveToolNames().includes(name)),'specialized schemas begin off wire');
  await session.prompt('Inspect the synthetic workflow and web assets, validate tool contracts and author one local scene.',{source:'rpc'});
  assert.equal(contexts.length,5);assert.deepEqual(errors,[]);
  assert.ok(names.every(name=>!contexts[0].tools.some(tool=>tool.name===name)));
  assert.ok(names.every(name=>contexts[1].tools.some(tool=>tool.name===name)),'discovered bundles join the next model turn of the same request');
  for(const name of names)assert.deepEqual(contexts[1].tools.find(tool=>tool.name===name).parameters,JSON.parse(JSON.stringify(catalog.get(name).parameters)));
  const results=new Map(session.messages.filter(message=>message.role==='toolResult').map(message=>[message.toolCallId,message]));
  for(const id of ['media-preview','web-preview','creative-studio','rendered-design-review','delivery-preflight'])assert.equal(results.get(id).isError,false,id);
  for(const name of names){const result=results.get(`invalid-${name}`);assert.equal(result.isError,true,name);assert.match(JSON.stringify(result.content),/validation|required|allowed|must|expected|schema/i,name);}
  assert.equal(results.get('create').isError,false);const created=results.get('create').details;assert.equal(created.rendered,false);assert.ok(fs.existsSync(created.scene.path));
  assert.equal(results.get('workflow').isError,false);assert.equal(JSON.parse(results.get('workflow').content[0].text).items[0].id,'inspect');
  assert.equal(results.get('assets').isError,false);assert.equal(JSON.parse(results.get('assets').content[0].text).counts.present,1);
  for(const id of ['unit-validation','cursor-validation','design-source-validation','render-dispatch','video-dispatch','audio-dispatch','workflow-failure'])assert.equal(results.get(id).isError,true,id);
  assert.match(JSON.stringify(results.get('unit-validation').content),/exact systemd unit/);
  assert.match(JSON.stringify(results.get('cursor-validation').content),/Invalid journal cursor/);
  assert.match(JSON.stringify(results.get('design-source-validation').content),/requires rendered HTML/);
  assert.ok(!session.getAllTools().some(tool=>/restart|publish|upload/.test(tool.name)));
 }finally{
  if(session){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}
  for(const key of envNames)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  fs.rmSync(cwd,{recursive:true,force:true});
 }
});
