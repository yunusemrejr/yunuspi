import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const runtime=fs.existsSync(path.join(root,'core'))?root:path.dirname(root);
const agent=fs.existsSync(path.join(root,'agent/extensions'))?path.join(root,'agent'):path.dirname(runtime);
const load=relative=>import(pathToFileURL(path.join(runtime,'core',relative)));
const chat=await load('ai/dist/api/openai-completions.js');
const responses=await load('ai/dist/api/openai-responses.js');
const codex=await load('ai/dist/api/openai-codex-responses.js');
const {getSupportedThinkingLevels}=await load('ai/dist/models.js');
const model={id:'fixture',name:'Fixture',provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',reasoning:true,
 input:['text'],contextWindow:65536,maxTokens:8192,cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0},
 thinkingLevelMap:{off:null,minimal:null,low:null,medium:null,high:'high',xhigh:null,max:'max'}};
const context={systemPrompt:'Fixed instructions',messages:[{role:'user',content:'fixture',timestamp:1}]};
const reply={type:'response.completed',response:{id:'resp_fixture',status:'completed',model:'fixture',output:[],usage:{input_tokens:5,output_tokens:1}}};
async function request(driver,m,options={},simple=false){
 let body,calls=0;
 const token=['fixture',Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64'),'fixture'].join('.');
 const result=await driver[simple?'streamSimple':'stream'](m,context,{apiKey:token,maxRetries:0,transport:'sse',sessionId:'stable',...options,fetch:async(_url,init)=>{
  calls++;body=JSON.parse(new Headers(init.headers).get("content-encoding")==="zstd" ? zlib.zstdDecompressSync(init.body).toString() : init.body);
  const text=driver===chat?'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n':'event: response.completed\ndata: '+JSON.stringify(reply)+'\n\n';
  return new Response(text,{headers:{'content-type':'text/event-stream'}});
 }}).result();
 assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(calls,1);return body;
}
test('direct calls and simple calls obey the same reasoning enum across request families',async()=>{
 for(const [driver,api] of [[chat,'openai-completions'],[responses,'openai-responses'],[codex,'openai-codex-responses']]){
  const m={...model,api};
  const direct=await request(driver,m,{reasoningEffort:'low'});
  const simple=await request(driver,m,{reasoning:'low'},true);
  assert.equal(direct.reasoning_effort??direct.reasoning?.effort,'high');
  assert.equal(simple.reasoning_effort??simple.reasoning?.effort,'high');
  const off=await request(driver,m,{reasoningEffort:'none'});
  assert.equal(off.reasoning_effort??off.reasoning?.effort,'high','always-on models clamp off');
 }
 const optional={...model,api:'openai-codex-responses',thinkingLevelMap:{...model.thinkingLevelMap,off:'none'}};
 assert.equal((await request(codex,optional,{reasoning:'off'},true)).reasoning.effort,'none');
 assert.equal((await request(codex,{...optional,reasoning:false},{reasoningEffort:'high'})).reasoning,undefined);
});
test('long-cache fields need an exact supported endpoint or explicit compatibility',async()=>{
 for(const driver of [chat,responses]){
  for(const baseUrl of ['https://fixture.invalid/v1','https://api.openai.com.attacker.invalid/v1','https://fixture.invalid/api.openai.com']){
   const body=await request(driver,{...model,baseUrl},{cacheRetention:'long'});
   assert.equal(body.prompt_cache_retention,undefined);
   if(driver===chat)assert.equal(body.prompt_cache_key,undefined);
  }
  const supported=await request(driver,{...model,baseUrl:'https://eu.api.openai.com/v1'},{cacheRetention:'long'});
  assert.equal(supported.prompt_cache_retention,'24h');assert.equal(supported.prompt_cache_key,'stable');
  assert.equal((await request(driver,{...model,compat:{supportsLongCacheRetention:true}},{cacheRetention:'long'})).prompt_cache_retention,'24h');
  assert.equal((await request(driver,{...model,baseUrl:'https://api.openai.com/v1'},{cacheRetention:'none'})).prompt_cache_key,undefined);
 }
});
test('live provider metadata wins over snapshots, survives cache, and drives actual wire fields',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-capabilities-'));
 const oldDir=process.env.PI_CODING_AGENT_DIR,oldFetch=globalThis.fetch;
 process.env.PI_CODING_AGENT_DIR=dir;
 try{
  fs.writeFileSync(path.join(dir,'models.json'),'{"providers":{}}');
  const stored={...model,id:'future',thinkingLevelMap:{...model.thinkingLevelMap,medium:'medium'}};
  fs.writeFileSync(path.join(dir,'models-store.json'),JSON.stringify({openrouter:{models:[stored,{...stored,id:'retired'},{...stored,id:'~alias'}]}}));
  const providers={},hooks={};
  const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/live-models.ts')));
  await register({registerProvider:(id,p)=>providers[id]=p,on:(name,fn)=>hooks[name]=fn});
  const refresh=async(id,rows)=>{
   globalThis.fetch=async()=>new Response(JSON.stringify({data:rows}));
   return providers[id].refreshModels({allowNetwork:true,force:true,signal:new AbortController().signal});
  };
  const rows=await refresh('openrouter',[{id:'bad',architecture:{input_modalities:42}},
   {id:'future',context_length:64000,top_provider:{context_length:32000,max_completion_tokens:16000},supported_parameters:['reasoning'],reasoning:{mandatory:true,supported_efforts:['none','high','max']}}]);
  const fresh=rows.find(m=>m.id==='future');
  assert.equal(fresh.contextWindow,32000);assert.equal(fresh.maxTokens,16000);
  assert.deepEqual(getSupportedThinkingLevels(fresh),['high','max']);
  assert.ok(!rows.some(m=>m.id==='retired'||m.id==='bad'));assert.ok(rows.some(m=>m.id==='~alias'));
  const routerWire=await request(chat,{...model,...fresh,provider:'openrouter'},{reasoningEffort:'medium'});
  assert.equal(routerWire.reasoning.effort,'high');
  const [friend]=await refresh('friendli',[{id:'new-family',reasoning:true,reasoning_options:[{type:'effort',values:['high','max']},{type:'toggle'},{type:'budget_tokens'}]}]);
  assert.deepEqual(getSupportedThinkingLevels(friend),['off','high','max']);
  const f={...model,...friend,provider:'friendli'};
  const enabled=await request(chat,f,{reasoningEffort:'low',maxTokens:4096});
  assert.equal(enabled.reasoning_effort,'high');assert.equal(enabled.chat_template_kwargs.enable_thinking,true);assert.equal(enabled.reasoning_budget,3072);
  const disabled=await request(chat,f,{});
  assert.equal(disabled.reasoning_effort,undefined);assert.equal(disabled.chat_template_kwargs.enable_thinking,false);assert.equal(disabled.reasoning_budget,0);
  const [cerebras]=await refresh('cerebras',[{id:'qwen-3.8-27b',limits:{max_context_length:65536,max_completion_tokens:32768},capabilities:{reasoning:true,vision:true},supported_parameters:{max_completion_tokens:true},pricing:{prompt:'0.00000099',completion:'0.00000149'}}]);
  assert.equal(cerebras.maxTokens,32768,'dated 65536 override must not supersede live limit');
  assert.equal(cerebras.contextWindow,65536);assert.deepEqual(cerebras.input,['text','image']);
  const cached=await providers.cerebras.refreshModels({allowNetwork:false,signal:new AbortController().signal});
  assert.equal(cached[0].maxTokens,32768);
  const realNow=Date.now;
  try {
   Date.now=()=>Date.parse('2026-10-11T00:00:00Z');
   const expired=await providers.cerebras.refreshModels({allowNetwork:false,signal:new AbortController().signal});
   assert.equal(expired[0].maxTokens,32768,'expiry of a fallback fact cannot discard live metadata');
  } finally { Date.now=realNow; }
  const cwire=await request(chat,{...model,...cerebras,provider:'cerebras'},{maxTokens:1024});
  assert.equal(cwire.max_completion_tokens,1024);assert.equal(cwire.max_tokens,undefined);
  let scope,signal;
  await hooks.session_start({}, {hasUI:false,model:{provider:'openai-codex'},modelRegistry:{getAvailable:()=>[{provider:'nvidia'}],refresh:async opts=>{scope=opts.providers;signal=opts.signal;return {errors:new Map()};}}});
  assert.ok(scope.includes('nvidia')&&scope.includes('openai-codex'));
  hooks.session_shutdown({}, {hasUI:false});
  assert.equal(signal.aborted,true);
 }finally{globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;fs.rmSync(dir,{recursive:true,force:true});}
});
test('native catalogs reject malformed network and disk data and keep healthy models',async()=>{
 const {withRemoteCatalog}=await load('coding-agent/dist/core/remote-catalog-provider.js');
 const saved=globalThis.fetch;
 let stored={models:[model],lastModified:1,checkedAt:0};
 const provider=withRemoteCatalog({id:'fixture',getModels:()=>[model]},'https://catalog.invalid');
 const refresh=()=>provider.refreshModels({allowNetwork:true,force:true,stored,signal:new AbortController().signal,publish:async p=>{if(p.persist)stored=p.persist;p.update?.();return true;}});
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify([{...model,id:'new',contextWindow:2048,maxTokens:8192},{id:'broken'},null]),{headers:{'last-modified':new Date().toUTCString()}});
  await refresh();assert.equal(provider.getModels().find(m=>m.id==='new').maxTokens,2048);
  const previous=stored;
  globalThis.fetch=async()=>new Response(JSON.stringify([{...model,contextWindow:-1}]));
  await assert.rejects(refresh(),/Invalid or empty/);assert.equal(stored,previous);assert.ok(provider.getModels().some(m=>m.id==='new'));
  stored={models:[{...model,thinkingLevelMap:{high:42}},null],lastModified:1};
  await provider.refreshModels({allowNetwork:false,stored,signal:new AbortController().signal,publish:async p=>{p.update?.();return true;}});
  assert.deepEqual(provider.getModels(),[model]);
 }finally{globalThis.fetch=saved;}
});
