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
import registerWorkflows from '../agent/extensions/adaptive-workflows.ts';

// Real owned SDK, file-loaded tools and hooks; the simulated transport cannot
// reach a provider and returns only the declared calls below.
test('UI goals, source mutations and short follow-ups refresh real SDK tools and context within one owner', {timeout:60000}, async () => {
 const root=path.resolve(import.meta.dirname,'..'),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ui-routing-sdk-'));
 const envNames=['PI_CODING_AGENT_DIR','PI_JEV','PI_NEEDLE','PI_TOOL_DISCOVERY','PI_SUBAGENT_CHILD','PI_LOCAL_LM','PI_UI_VERIFICATION'];
 const prior=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{PI_CODING_AGENT_DIR:cwd,PI_JEV:'off',PI_NEEDLE:'off',PI_LOCAL_LM:'off',PI_TOOL_DISCOVERY:'on',PI_UI_VERIFICATION:'on'});delete process.env.PI_SUBAGENT_CHILD;
 const html='<!doctype html><html lang="en"><head><title>Collection</title><style>:root{--space:16px}@media(max-width:768px){main{padding:var(--space)}}</style></head><body><main><h1>A real collection</h1><section id="story"><div class="layer">Explore the materials</div></section></main></body></html>';
 fs.writeFileSync(path.join(cwd,'index.html'),html);
 let session;
 try {
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   additionalExtensionPaths:['art-direction.ts','design-studio.ts','render-and-wait.ts','blender-studio.ts'].map(file=>path.join(root,'agent/extensions',file)),extensionFactories:[registerToolDiscovery,registerWorkflows]});
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const model={id:'ui-fixture',name:'UI fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
  const plans=[{name:'read',arguments:{path:'index.html'}},{name:'ui_recipe',arguments:{action:'plan',pattern:'scroll-story'}},{name:'write',arguments:{path:'index.html',content:html+'\n<!-- integration revision -->'}}];
  const contexts=[],errors=[];
  const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),
   streamSimple(selected,context,options){
    const call=plans[contexts.length];contexts.push({model:selected.id,thinking:options?.reasoning,tools:context.tools.map(tool=>tool.name),messages:structuredClone(context.messages)});
    const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:call?[{type:'toolCall',id:`ui-${contexts.length}`,...call}]:[{type:'text',text:'Fixture boundary reached.'}],stopReason:call?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
    return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},result:async()=>message};
   }};
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),thinkingLevel:'high'}));
  await session.bindExtensions({onError:error=>errors.push(error)});
  await session.prompt('/goal Build a responsive interface with layered scroll animations and a Three.js model. Keep shared tokens consistent across pages. No image generation.',{source:'rpc'});
  assert.equal(contexts.length,6,'the three owned calls and their boundary allow only two native missing-UI-evidence follow-ups');assert.deepEqual(errors,[]);
  for(const name of ['creative_direct','ui_recipe','asset_register'])assert.ok(contexts[0].tools.includes(name),`${name} available at the authored goal boundary: ${contexts[0].tools.join(', ')}; ${JSON.stringify(contexts[0].messages).slice(-2000)}`);
  assert.ok(contexts.every(context=>!context.tools.includes('image_generate')),'authored exclusion persists after observed source and tool receipts');
  const results=session.messages.filter(message=>message.role==='toolResult');
  assert.equal(results.find(message=>message.toolCallId==='ui-2').isError,false,'real ui_recipe plan dispatch');
  assert.equal(results.find(message=>message.toolCallId==='ui-3').isError,false,'native write mutation dispatch');
  for(const name of ['ui_explore','motion_inspect','ui_consistency'])assert.ok(contexts[3].tools.includes(name),`${name} ready after implementation receipt`);
  assert.match(JSON.stringify(contexts[3].messages),/ui-scroll|forward\/backtrack|forward and backward/);
  const phoneBoundary=contexts.length;
  await session.prompt('Make it work on phones too.',{source:'rpc'});
  assert.ok(contexts[phoneBoundary].tools.includes('ui_explore'),JSON.stringify({tools:contexts[phoneBoundary].tools,messages:contexts[phoneBoundary].messages}).slice(-3300));assert.ok(!contexts[phoneBoundary].tools.includes('image_generate'));
  assert.match(JSON.stringify(contexts[phoneBoundary].messages),/Three\.js|three-model/,'original purpose survives steering');
  const arithmeticBoundary=contexts.length;
  await session.prompt('Calculate 2 + 2.',{source:'rpc'});
  assert.ok(!contexts[arithmeticBoundary].tools.includes('ui_recipe'));assert.ok(!contexts[arithmeticBoundary].tools.includes('ui_consistency'));
  assert.ok(contexts.every(context=>context.model==='ui-fixture'));assert.equal(session.model.id,'ui-fixture');assert.equal(session.thinkingLevel,'high');
 } finally {
  if(session){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}
  for(const key of envNames)prior[key]===undefined?delete process.env[key]:process.env[key]=prior[key];
  fs.rmSync(cwd,{recursive:true,force:true});
 }
});
