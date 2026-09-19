import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'extensions/live-models.ts')));

// Exercise registered refreshers and their real dependencies. Extracting
// function text into a VM silently severed imports as the mapper evolved.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-pricing-'));
const oldDir=process.env.PI_CODING_AGENT_DIR, oldFetch=globalThis.fetch;
process.env.PI_CODING_AGENT_DIR=root;
fs.writeFileSync(path.join(root,'models.json'),'{"providers":{}}');
try {
 const providers={};
 const {default:register,formatCatalogAge}=await import(pathToFileURL(path.join(agent,'extensions/live-models.ts')));
 const commands={};
 await register({registerProvider:(id,value)=>providers[id]=value,registerCommand:(name,cmd)=>commands[name]=cmd,on(){}});
 assert.equal(formatCatalogAge(2323*60000),'1d 14h ago');
 assert.equal(formatCatalogAge(90000),'1 min ago');
 assert.equal(formatCatalogAge(0),'just now');
 assert.equal(formatCatalogAge(null),'age unknown');
 assert.equal(formatCatalogAge(NaN),'age unknown');
 const refreshes=[];
 const ctx={hasUI:true,model:{provider:'example'},modelRegistry:{refresh:async options=>refreshes.push(options)},ui:{notify(){},setStatus(){},theme:{fg:(_color,text)=>text}}};
 await commands['catalog-status'].handler('',ctx);
 assert.equal(refreshes.length,0);
 await commands['catalog-status'].handler('refresh',ctx);
 assert.deepEqual(refreshes,[{allowNetwork:true,force:true,providers:['example']}]);
 const map=async(provider,row,pricing)=>{
  fs.writeFileSync(path.join(root,'live-model-catalog.json'),JSON.stringify({version:1,providers:{}}));
  globalThis.fetch=async(url,init)=>{
   assert.notEqual(init?.method,'POST','catalog checks must never run inference');
   return new Response(JSON.stringify(String(url).endsWith('/api/pricing')
    ? {data:[{model_name:row.id,...pricing}],effective_group_ratio:1}
    : {data:[row]}));
  };
  const models=await providers[provider].refreshModels({allowNetwork:true,signal:new AbortController().signal});
  const model=models.find(m=>m.id===row.id);assert.ok(model,`${provider} published fixture`);return model;
 };
 const or=row=>map('openrouter',row), orca=(row,pricing)=>map('orcarouter',row,pricing), friendli=row=>map('friendli',row), runinfra=row=>map('runinfra',row);
 assert.equal((await or({id:'bounded',context_length:131072,top_provider:{context_length:65536}})).contextWindow,65536);
 assert.equal((await or({id:'qwen',pricing:{prompt:'0.000002',completion:'0.000003'}})).cost.cacheRead,2);
 assert.equal((await or({id:'qwen',pricing:{prompt:'0.000002',input_cache_read:'0'}})).cost.cacheRead,0);
 assert.ok(Math.abs((await or({id:'qwen',pricing:{prompt:'0.000002',input_cache_read:'0.0000002'}})).cost.cacheRead-0.2)<1e-12);
 assert.equal((await orca({id:'glm',pricing:{prompt_per_million:'2',completion_per_million:'3'}},{cache_ratio:0.25})).cost.cacheRead,0.5);
 assert.equal((await orca({id:'glm',pricing:{prompt_per_million:'2'}},{})).cost.cacheRead,2);
 assert.equal((await orca({id:'glm',pricing:{prompt_per_million:'2'}},{cache_ratio:0})).cost.cacheRead,0);
 assert.equal((await orca({id:'glm'},{model_ratio:1,completion_ratio:2})).cost.cacheRead,2);
 assert.equal((await friendli({id:'glm',pricing:{input:'0.000002'}})).cost.cacheRead,2);
 assert.equal((await friendli({id:'glm',pricing:{input:'0.000002',input_cache_read:'0'}})).cost.cacheRead,0);
 assert.equal((await orca({id:'glm',pricing:{prompt_per_million:0,completion_per_million:0}},{model_ratio:3})).cost.input,0);
 assert.equal((await orca({id:'glm',pricing:{prompt_per_million:'2',input_cache_read:'0.0000003'}},{cache_ratio:0.5})).cost.cacheRead,0.3);
 assert.equal((await runinfra({id:'qwen',pricing:{input:0.1,output:0.4}})).cost.cacheRead,0.1);
 assert.equal((await runinfra({id:'qwen',pricing:{input:0.1,output:0.4},cached_input_price:0})).cost.cacheRead,0);
 console.log('PASS registered catalog refreshers preserve explicit zero, documented ratios and conservative unknown cache rates');
} finally {
 globalThis.fetch=oldFetch;
 if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;
 fs.rmSync(root,{recursive:true,force:true});
}
