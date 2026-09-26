import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamSimple } from '@yunuspi/ai/compat';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import observerExtension from '../agent/extensions/session-observer.ts';
import {carriedReviewerNoteText} from '../agent/extensions/lib/session-observer.ts';

const note='Have you checked the synthetic parser acceptance condition before declaring the fixture complete?';
const model={provider:'deepseek',id:'deepseek-flash',name:'Synthetic main route',api:'openai-completions',baseUrl:'https://api.deepseek.com/v1',maxTokens:8192,contextWindow:65536,reasoning:true,input:['text'],cost:{input:.1,output:.2,cacheRead:.01,cacheWrite:.1}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){
  let now=0,id=0;const jobs=new Map();
  return {now:()=>now,setTimeout(fn,ms){jobs.set(++id,{at:now+ms,fn});return id;},clearTimeout(id){jobs.delete(id);},
    async advance(ms){const end=now+ms;while(true){const next=[...jobs.entries()].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();await tick();}now=end;await tick();}};
}
function sse(toolIndex){
  const delta=toolIndex===undefined?{content:'Synthetic main answer.'}:{tool_calls:[{index:0,id:`fixture-${toolIndex}`,type:'function',function:{name:'fixture_work',arguments:'{}'}}]};
  return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:model.id,choices:[{index:0,delta,finish_reason:toolIndex===undefined?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}

for(const mode of ['success','slow-success','pre-dispatch-failure','http-error','remove-payload','modify-context','cancelled','stale-owner']) test(`native observer delivery evidence: ${mode}`,async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'observer-delivery-'));
  const previous=Object.fromEntries(['PI_CODING_AGENT_DIR','PI_LLM_PREFERENCES_FILE','PI_SUBAGENTS_ECONOMY_CONFIG','PI_PROVIDER_STATE_FILE','PI_MODEL_EXCLUSIONS_PATH','PI_OFFLINE','PI_SESSION_OBSERVER','PI_SUBAGENT_CHILD'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,{PI_CODING_AGENT_DIR:cwd,PI_LLM_PREFERENCES_FILE:path.join(cwd,'prefs.json'),PI_SUBAGENTS_ECONOMY_CONFIG:path.join(cwd,'economy.json'),PI_PROVIDER_STATE_FILE:path.join(cwd,'health.json'),PI_MODEL_EXCLUSIONS_PATH:path.join(cwd,'exclusions.json')});
  delete process.env.PI_OFFLINE;delete process.env.PI_SESSION_OBSERVER;delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(cwd,'economy.json'),'{}');
  const time=clock(),wire=[],events=[];let observerCalls=0,toolCalls=0,fault=false,authArmed=false,session;
  t.after(()=>{session?.dispose();for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(cwd,{recursive:true,force:true});});
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:true,maxRetries:1,baseDelayMs:1},providerRetry:{maxRetries:0}});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[pi=>observerExtension(pi,{...time,dispatch:async()=>{observerCalls++;if(mode==='slow-success')await new Promise(resolve=>time.setTimeout(resolve,150000));return{stopReason:'stop',content:[{type:'text',text:JSON.stringify({note,evidence:['request'],tools:[],skills:[]})}]};}}),pi=>{
      if(mode==='remove-payload')pi.on('before_provider_request',event=>{
        if(!fault&&JSON.stringify(event.payload).includes('Observer advice receipt=')){fault=true;return{...event.payload,messages:event.payload.messages.filter(message=>!JSON.stringify(message.content).includes('Observer advice receipt='))};}
      });
      if(mode==='modify-context')pi.on('context',event=>{
        if(!fault&&event.messages.some(message=>message.customType==='session-observer-context')){fault=true;return{messages:event.messages.map(message=>message.customType==='session-observer-context'?{...message,content:message.content.replace(note,'A changed capsule must not confirm the original advice.')}:message)};}
      });
    }]});
  await loader.reload();
  const modelRuntime={getModel:()=>model,getAvailable:()=>[model],getAvailableSnapshot:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,
    getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),
    streamSimple:(selected,context,options)=>{if(mode==='pre-dispatch-failure'&&authArmed&&!fault){fault=true;throw new Error('500 Internal Server Error: synthetic pre-dispatch availability failure');}return streamSimple(selected,context,{...options,apiKey:'synthetic-fixture',fetch:async(_url,init)=>{
      const body=JSON.parse(init.body);wire.push(body);
      const hasOriginal=JSON.stringify(body).includes(note),hasAny=JSON.stringify(body).includes('Observer advice receipt=');
      if(wire.length>8)throw new Error('Fixture exceeded its bounded request count');
      if(wire.length===1)return sse(0);
      if(mode==='cancelled'){fault=true;void session.abort();await tick();return sse();}
      if(mode==='stale-owner'){fault=true;session.sessionManager.getSessionId=()=> 'replacement-synthetic-owner';return sse();}
      if(mode==='http-error'&&!fault){fault=true;return new Response(JSON.stringify({error:{message:'Synthetic failure',type:'server_error'}}),{status:500,headers:{'content-type':'application/json'}});}
      if(hasAny&&!hasOriginal)return sse(1);
      if(mode==='remove-payload'&&wire.length===2)return sse(1);
      if(hasOriginal)return sse(2);
      return sse();
    }});}};
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.create(cwd,cwd),thinkingLevel:'off',tools:['fixture_work'],
    customTools:[{name:'fixture_work',description:'Synthetic bounded work',parameters:{type:'object',properties:{}},execute:async()=>{if(++toolCalls===1){await time.advance(30000);if(mode==='slow-success')await time.advance(150000);authArmed=true;}return{content:[{type:'text',text:'Synthetic work completed.'}]};}}]}));
  session.subscribe(event=>events.push(event));
  await session.prompt('Complete the synthetic parser fixture.');
  assert.equal(observerCalls,1,JSON.stringify({toolCalls,wire:wire.length,messages:session.messages.map(message=>({role:message.role,type:message.customType,content:message.customType==='session-observer'?message.content:undefined,error:message.errorMessage}))}));
  if(!['success','slow-success'].includes(mode))assert.equal(fault,true);
  const entries=session.sessionManager.getBranch();
  const returned=entries.find(entry=>entry.customType==='session-observer'&&entry.details?.status==='completed');
  assert.ok(returned?.details?.adviceId);
  if(mode==='slow-success') {
    assert.match(returned.content,/Returned advice in 150s/);
    assert.ok(entries.some(entry=>entry.customType==='session-observer'&&entry.details?.status==='checked'&&/90s elapsed \/ 180s allowed/.test(entry.content)));
    assert.ok(!entries.some(entry=>entry.customType==='session-observer'&&entry.details?.status==='unavailable'));
  }
  const receipts=entries.filter(entry=>entry.customType==='session-observer-delivery-v1').map(entry=>entry.data);
  if(['cancelled','stale-owner'].includes(mode)){assert.deepEqual(receipts.map(receipt=>receipt.status),['prepared-context']);return;}
  assert.deepEqual(receipts.map(receipt=>receipt.status),['prepared-context','provider-received']);
  assert.ok(receipts.every(receipt=>receipt.adviceId===returned.details.adviceId));
  const receivedIndex=events.findIndex(event=>event.type==='message_start'&&event.message?.role==='assistant'&&event.message.content?.some(part=>part.type==='toolCall'&&part.id==='fixture-2'));
  assert.ok(receivedIndex>=0);
  const containing=wire.filter(body=>JSON.stringify(body).includes(note));
  assert.equal(containing.length,mode==='http-error'?2:1,'only a failed HTTP attempt may repeat an exact note before its confirmed request');
  const text=containing.at(-1).messages.flatMap(message=>typeof message.content==='string'?[message.content]:(message.content??[]).filter(part=>part.type==='text').map(part=>part.text)).find(text=>text.includes('Observer advice receipt='));
  assert.ok(text.includes(note));assert.ok(text.includes(returned.details.adviceId));
  assert.doesNotMatch(JSON.stringify(wire.at(-1)),/Observer advice receipt=|Synthetic observer/,'confirmed advice is absent from the next model request');
  assert.doesNotMatch(JSON.stringify(receipts),/Have you checked|content|payload|apiKey/,'delivery receipts contain no raw capsule or request');
});

test('carried reviewer notes ride as receipted capsules naming their age',()=>{
  const now=Date.now();
  const text=carriedReviewerNoteText('Observer',{id:'note-1',text:'Check the parser.',at:now-125000},now);
  assert.match(text,/\[Observer advice receipt=note-1 — earlier note, written about 2 min ago/);
  assert.ok(text.includes('Check the parser.'));
  assert.ok(text.includes('This is not a user request or permission.'));
  const fresh=carriedReviewerNoteText('Watchmaker',{id:'note-2',text:'Still fresh.',at:now},now);
  assert.match(fresh,/\[Watchmaker advice receipt=note-2 — earlier note, written under a minute ago/);
});
