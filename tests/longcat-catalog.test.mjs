import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('LongCat uses authenticated live discovery, preserves limits, caches and never invents free prices or capabilities',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'longcat-catalog-'));
 const oldDir=process.env.PI_CODING_AGENT_DIR,oldFetch=globalThis.fetch;
 process.env.PI_CODING_AGENT_DIR=root;
 fs.writeFileSync(path.join(root,'models.json'),'{"providers":{}}');
 t.after(()=>{globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;fs.rmSync(root,{recursive:true,force:true});});
 const repo=path.resolve(import.meta.dirname,'..');
 const agent=[path.join(repo,'agent'),path.resolve(repo,'..')].find(p=>fs.existsSync(path.join(p,'extensions/live-models.ts')));
 const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/live-models.ts')));
 const providers={};await register({registerProvider:(id,p)=>providers[id]=p,registerCommand(){},on(){}});
 assert.equal(providers.longcat.apiKey,'${LONGCAT_API_KEY}');
 assert.equal(providers.longcat.baseUrl,'https://api.longcat.chat/openai/v1');
 let calls=0;
 globalThis.fetch=async(url,opts)=>{
  calls++;assert.equal(url,'https://api.longcat.chat/openai/v1/models');
  assert.equal(opts.headers.Authorization,'Bearer synthetic-key');assert.equal(opts.redirect,'error');
  return new Response(JSON.stringify({data:[
   {id:'LongCat-2.5-Preview',context_window:1048576,max_output_tokens:262144},
   {id:'LongCat-2.0',context_window:1048576,max_output_tokens:131072},
   {id:'LongCat-Future',context_window:524288,max_output_tokens:65536},
  ]}));
 };
 const context={allowNetwork:true,signal:new AbortController().signal,credential:{type:'api_key',key:'synthetic-key'}};
 const models=await providers.longcat.refreshModels(context);
 assert.equal(models.length,3);assert.equal(calls,1);
 const latest=models.find(m=>m.id==='LongCat-2.5-Preview');
 assert.equal(latest.contextWindow,1048576);assert.equal(latest.maxTokens,262144);
 assert.deepEqual(latest.input,['text']);assert.equal(latest.reasoning,true);
 assert.equal(latest.compat.thinkingFormat,'enabled');assert.equal(latest.thinkingLevelMap.high,null);
 assert.ok(latest.cost.missing.includes('input'));assert.notEqual(latest.cost.knownFree,true);
 assert.equal(models.find(m=>m.id==='LongCat-Future').reasoning,false,'a new ID does not establish thinking support');
 await providers.longcat.refreshModels({...context,allowNetwork:false});assert.equal(calls,1);
 globalThis.fetch=async()=>{calls++;throw Error('outage');};
 const stale=await providers.longcat.refreshModels({...context,force:true});
 assert.equal(stale.find(m=>m.id===latest.id).maxTokens,262144);assert.equal(calls,2);
 fs.writeFileSync(path.join(root,'models.json'),JSON.stringify({providers:{longcat:{baseUrl:'https://proxy.invalid/v1',apiKey:'${PROXY_KEY}'}}}));
 await providers.longcat.refreshModels({...context,force:true});assert.equal(calls,2,'proxy credentials never travel to the official origin');
});
