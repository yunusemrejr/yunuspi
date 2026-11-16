import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ModelRuntime} from '../core/coding-agent/src/core/model-runtime.js';
import {AuthStorage} from '../core/coding-agent/src/core/auth-storage.js';
import {InMemoryCodingAgentModelsStore} from '../core/coding-agent/src/core/models-store.js';
import {stream as streamChat} from '../core/ai/src/api/openai-completions.js';
import {calculateCost} from '../core/ai/src/models.js';
import {collectSessionCost} from '../core/coding-agent/src/core/session-accounting.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'ant-ling-catalog-'));
const saved=Object.fromEntries(['PI_CODING_AGENT_DIR','ANT_LING_API_KEY'].map(key=>[key,process.env[key]]));
const oldFetch=globalThis.fetch;
process.env.PI_CODING_AGENT_DIR=root;delete process.env.ANT_LING_API_KEY;
fs.writeFileSync(path.join(root,'models.json'),'{"providers":{}}');
const repo=path.resolve(import.meta.dirname,'..');
const agent=[path.join(repo,'agent'),path.resolve(repo,'..')].find(p=>fs.existsSync(path.join(p,'extensions/live-models.ts')));
const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/live-models.ts')));
const providers={};await register({registerProvider:(id,p)=>providers[id]=p,registerCommand(){},on(){}});
test.after(()=>{
 globalThis.fetch=oldFetch;
 for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
 fs.rmSync(root,{recursive:true,force:true});
});
const listed=['AntAngelMed','Ling-2.6-1T','Ling-2.6-flash','Ling-3.0-flash','Ling-3.0-flash-VL','Ling-3.0-tiny','Ling-3.1-flash','Ling-3.2-flash','Ling-9.9-new',
 'Ming-3.0-asr-tiny','Ming-3.0-audio-flash','Ming-3.0-tts-0.5B','Ming-Image-0.1-Design','Ring-2.6-1T'];
const answer=()=>new Response(JSON.stringify({object:'list',data:listed.map(id=>({id,object:'model',owned_by:'AntLing',created:1}))}));
const context={allowNetwork:true,signal:new AbortController().signal,credential:{type:'api_key',key:'synthetic-key'}};

test('Ant Ling lists chat models from its authenticated catalog, withholds retired and non-chat ids and dates its prices',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-15T00:00:00Z')});
 assert.equal(providers['ant-ling'].name,'Ant Ling');
 assert.equal(providers['ant-ling'].baseUrl,'https://api.ant-ling.com/v1');
 assert.equal(providers['ant-ling'].apiKey,undefined,'the core owns the key: auth.json or ANT_LING_API_KEY');
 let calls=0;
 globalThis.fetch=async(url,opts)=>{
  calls++;assert.equal(url,'https://api.ant-ling.com/v1/models');
  assert.equal(opts.headers.Authorization,'Bearer synthetic-key');assert.equal(opts.redirect,'error');
  return answer();
 };
 const models=await providers['ant-ling'].refreshModels(context);
 assert.equal(calls,1);
 assert.deepEqual(models.map(m=>m.id).sort(),['AntAngelMed','Ling-3.0-flash','Ling-3.0-flash-VL','Ling-3.0-tiny','Ling-3.1-flash','Ling-3.2-flash','Ling-9.9-new'],
  'retired Ling-2.6/Ring-2.6 and the Ming speech and image models are not offered');
 const by=id=>models.find(m=>m.id===id);
 const newest=by('Ling-3.2-flash');
 assert.equal(newest.contextWindow,1_000_000);assert.deepEqual(newest.input,['text','image']);assert.equal(newest.reasoning,true);
 assert.equal(newest.compat.thinkingFormat,'enabled');assert.equal(newest.compat.supportsReasoningEffort,false);
 assert.deepEqual(Object.entries(newest.thinkingLevelMap).filter(([,v])=>v).map(([k])=>k),['off','medium']);
 const cutoff=Date.parse('2026-11-18T00:00:00Z');
 assert.deepEqual(newest.cost,{input:0,output:0,cacheRead:0,cacheWrite:0,knownFree:true,validUntil:cutoff},'free during its launch fortnight');
 assert.deepEqual(by('Ling-3.1-flash').cost,{input:0.07494,output:0.22482,cacheRead:0.014988,cacheWrite:0,validUntil:Date.parse('2026-11-28T00:00:00Z')});
 assert.deepEqual(by('Ling-3.0-flash-VL').cost,by('Ling-3.0-flash').cost);
 assert.deepEqual(by('Ling-3.0-flash-VL').input,['text','image']);assert.deepEqual(by('Ling-3.0-flash').input,['text']);
 assert.equal(by('Ling-3.0-flash').contextWindow,262_144);assert.equal(by('Ling-3.0-tiny').contextWindow,131_072);
 assert.deepEqual(by('Ling-3.0-tiny').input,['text']);assert.ok(by('Ling-3.0-tiny').cost.missing.includes('input'),'no published price stays unknown');
 for(const id of ['AntAngelMed','Ling-9.9-new']){
  assert.equal(by(id).reasoning,false,'an unlisted id establishes no thinking support');assert.deepEqual(by(id).input,['text']);
  assert.ok(by(id).cost.missing.includes('output'));assert.equal(by(id).compat,undefined);
 }
 assert.equal(newest.maxTokens,8192,'no output limit is published, so none is invented');

 await providers['ant-ling'].refreshModels({...context,allowNetwork:false});assert.equal(calls,1,'the saved list serves an offline start');
 t.mock.timers.setTime(Date.parse('2026-11-19T00:00:00Z'));
 const selected={...newest,api:'openai-completions',provider:'ant-ling',baseUrl:providers['ant-ling'].baseUrl};
 for(const [created,complete] of [[(cutoff-1000)/1000,true],[cutoff/1000,false],[undefined,false]]) {
  const frame={id:'test-completion',created,choices:[{index:0,delta:{content:'Test'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:5}};
  const message=await streamChat(selected,{messages:[{role:'user',content:'Test',timestamp:Date.now()}]},{
   apiKey:'synthetic-key',maxRetries:0,fetch:async()=>new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}}),
  }).result();
  assert.equal(message.stopReason,'stop',message.errorMessage);
  assert.equal(message.usage.totalTokens,105);
  assert.equal(message.usage.cost.complete,complete);
  assert.equal(collectSessionCost([{type:'message',message}]).unknown,!complete);
 }
 const cacheFile=path.join(root,'live-model-catalog.json');
 const savedCatalog=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
 for (const row of savedCatalog.providers['ant-ling'].models) {
  if (row.id===newest.id) row.cost={input:0,output:0,cacheRead:0,cacheWrite:0,knownFree:true};
  if (row.id==='Ling-3.1-flash') row.cost={input:0.3,output:0.9,cacheRead:0.06,cacheWrite:0.3};
 }
 fs.writeFileSync(cacheFile,JSON.stringify(savedCatalog));
 const after=await providers['ant-ling'].refreshModels({...context,allowNetwork:false});
 assert.ok(after.find(m=>m.id==='Ling-3.2-flash').cost.missing.includes('input'),'the free fortnight is not quoted past its review date');
 assert.equal(after.find(m=>m.id==='Ling-3.1-flash').cost.input,0.07494);
 t.mock.timers.setTime(Date.parse('2026-12-01T00:00:00Z'));
 const stale=await providers['ant-ling'].refreshModels({...context,allowNetwork:false});
 assert.ok(stale.every(m=>m.cost.input===0&&m.cost.missing?.includes('input')),'no old price is quoted as current');
 assert.equal(stale.find(m=>m.id==='Ling-3.2-flash').contextWindow,1_000_000,'limits and wire formats stay in force');
 assert.equal(stale.find(m=>m.id==='Ling-3.2-flash').compat.thinkingFormat,'enabled');
 t.mock.timers.setTime(Date.parse('2026-11-14T15:00:00Z'));
 const before=await providers['ant-ling'].refreshModels({...context,allowNetwork:false});
 assert.ok(before.some(m=>m.id==='Ling-2.6-flash'),'a model is offered until the moment its vendor retires it');
});

test('a key set for another origin never reaches the official catalog',async t=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return answer();};
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-15T00:00:00Z')});
 fs.writeFileSync(path.join(root,'models.json'),JSON.stringify({providers:{'ant-ling':{baseUrl:'https://proxy.invalid/v1'}}}));
 t.after(()=>fs.writeFileSync(path.join(root,'models.json'),'{"providers":{}}'));
 const models=await providers['ant-ling'].refreshModels({...context,force:true});assert.equal(calls,0);
 assert.equal(models.find(model=>model.id==='Ling-3.2-flash').cost.knownFree,undefined);
});

test('the stored auth.json key and ANT_LING_API_KEY both reach the catalog, and the built-in 2.6 models are replaced',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-15T00:00:00Z')});
 const seen=[];
 globalThis.fetch=async(url,opts)=>{
  if(String(url).startsWith('https://api.ant-ling.com/')){seen.push(opts.headers.Authorization);return answer();}
  return new Response('{}',{status:404});
 };
 const authPath=path.join(root,'auth.json');
 const open=async credentials=>{
  const runtime=await ModelRuntime.create({credentials,modelsPath:path.join(root,'models.json'),modelsStore:new InMemoryCodingAgentModelsStore(),allowModelNetwork:false});
  const ids=()=>runtime.getModels('ant-ling').map(m=>m.id);
  assert.ok(ids().includes('Ling-3.0-tiny')&&!ids().some(id=>/2\.6/.test(id)),'the core ships the current Ling models, not the withdrawn ones');
  runtime.registerProvider('ant-ling',providers['ant-ling']);
  await runtime.refresh({allowNetwork:true,force:true,providers:['ant-ling']});
  return {runtime,ids:ids()};
 };
 fs.writeFileSync(authPath,JSON.stringify({'ant-ling':{type:'api_key',key:'synthetic-file-key'}}));
 const fromFile=await open(AuthStorage.create(authPath));
 assert.deepEqual(seen,['Bearer synthetic-file-key']);
 assert.ok(!fromFile.ids.some(id=>/2\.6|^Ming-/.test(id)),fromFile.ids.join());assert.ok(fromFile.ids.includes('Ling-3.2-flash'));
 const request=await fromFile.runtime.getAuth(fromFile.runtime.getModel('ant-ling','Ling-3.2-flash'));
 assert.equal(request.auth.apiKey,'synthetic-file-key');
 process.env.ANT_LING_API_KEY='synthetic-env-key';
 const fromEnv=await open(AuthStorage.inMemory({}));
 assert.deepEqual(seen,['Bearer synthetic-file-key','Bearer synthetic-env-key']);
 assert.ok(fromEnv.ids.includes('Ling-3.2-flash')&&!fromEnv.ids.includes('Ring-2.6-1T'));
});

test('explicit Ant Ling rates contribute when catalog rates in an active model expire',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-15T00:00:00Z')});
 const id='Ling-3.2-flash', modelsPath=path.join(root,'models.json');
 fs.writeFileSync(modelsPath,JSON.stringify({providers:{'ant-ling':{modelOverrides:{[id]:{cost:{input:2,cacheWrite1h:6}}}}}}));
 t.after(()=>fs.writeFileSync(modelsPath,'{"providers":{}}'));
 const runtime=await ModelRuntime.create({credentials:AuthStorage.inMemory({}),modelsPath,modelsStore:new InMemoryCodingAgentModelsStore(),allowModelNetwork:false});
 runtime.registerProvider('ant-ling',providers['ant-ling']);
 await runtime.refresh({allowNetwork:false,providers:['ant-ling']});
 const active=runtime.getModel('ant-ling',id);
 assert.equal(active.cost.knownFree,true);
 const cost=calculateCost(active,{input:10000,output:500,cacheRead:0,cacheWrite:0},active.cost.validUntil);
 assert.equal(cost.total,0.02);
 assert.equal(cost.complete,false);
 assert.equal(cost.priceBasis,'catalog-price-expired');
 const longOnly=calculateCost(active,{input:0,output:0,cacheRead:0,cacheWrite:10000,cacheWrite1h:10000},active.cost.validUntil);
 assert.equal(longOnly.total,0.06);
 assert.equal(longOnly.complete,true);
 const mixed=calculateCost(active,{input:0,output:0,cacheRead:0,cacheWrite:10000,cacheWrite1h:8000},active.cost.validUntil);
 assert.equal(mixed.total,0.048);
 assert.equal(mixed.complete,false);
});
