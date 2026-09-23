import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withOpenAICodexCatalog } from '../core/coding-agent/src/core/codex-catalog-provider.js';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { AuthStorage } from '../core/coding-agent/src/core/auth-storage.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';
import { toModelInfo } from '../agent/extensions/pi-subagents/src/shared/model-info.ts';
import { isProvenFreeRoute } from '../agent/extensions/pi-subagents/src/runs/shared/free-route-evidence.ts';
const base = { id:'known', name:'Known', provider:'openai-codex', api:'openai-codex-responses', baseUrl:'https://chatgpt.com/backend-api', reasoning:true, input:['text'], contextWindow:100000, maxTokens:32000, cost:{input:1,output:2,cacheRead:0.1,cacheWrite:0}, compat:{supportsToolSearch:true} };
const payload = { models: [
  { slug:'known', display_name:'Known updated', visibility:'list', supported_in_api:true, context_window:272000, input_modalities:['text','image'], supported_reasoning_levels:[{effort:'low'},{effort:'high'}] },
  { slug:'gpt-6-luna', display_name:'GPT-6 Luna', visibility:'list', supported_in_api:true, context_window:272000, input_modalities:['text','image'], supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'max'}] },
  { slug:'hidden-model', visibility:'hide', context_window:272000, input_modalities:['text'] },
  { slug:'bad-model', visibility:'list', context_window:'272000', input_modalities:['text'] },
] };
const credential = accountId => ({ type:'oauth', accountId, access:'synthetic-access-token', refresh:'synthetic-refresh-token', expires:Date.now()+3600000 });
const wrap = () => withOpenAICodexCatalog({ id:'openai-codex', getModels:()=>[base] });
const response = () => new Response(JSON.stringify(payload), {headers:{etag:'"version-1"'}});
async function refresh(provider, state, options = {}) {
  const signal = options.signal ?? new AbortController().signal;
  await provider.refreshModels({credential:credential('account-A'),stored:state.stored,allowNetwork:true,force:true,signal,...options,
    publish:async publication=>{
      if(signal.aborted)return false;
      if(publication.persist)state.stored=structuredClone(publication.persist);
      publication.update?.();return true;
    }});
}

test('official account catalog adds exact visible IDs without inventing price or output-limit evidence', async () => {
  const originalFetch=globalThis.fetch, state={};let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++;assert.equal(new URL(url).origin,'https://chatgpt.com');assert.equal(new URL(url).pathname,'/backend-api/codex/models');
    assert.equal(init.redirect,'error');assert.equal(init.headers['chatgpt-account-id'],'account-A');assert.equal(init.headers.authorization,'Bearer synthetic-access-token');return response();
  };
  try {
    const provider=wrap();await refresh(provider,state);
    assert.equal(calls,1);assert.deepEqual(provider.getModels().map(m=>m.id),['known','gpt-6-luna']);
    const known=provider.getModels()[0], luna=provider.getModels()[1];
    assert.equal(known.maxTokens,32000);assert.deepEqual(known.cost,base.cost);assert.equal(known.compat.supportsToolSearch,true);
    assert.equal(luna.maxTokens,16384);assert.equal(luna.outputLimitEstimated,true);assert.ok(luna.cost.missing.includes('input'));
    assert.deepEqual(toModelInfo(luna).cost.missing,luna.cost.missing);assert.equal(isProvenFreeRoute(toModelInfo(luna)),false);
    assert.equal(luna.thinkingLevelMap.off,null);assert.equal(luna.thinkingLevelMap.max,'max');
    assert.ok(!JSON.stringify(state.stored).includes('synthetic-access-token'));assert.ok(!JSON.stringify(state.stored).includes('account-A'));
    await refresh(provider,state,{force:false});assert.equal(calls,1,'fresh cache avoids another network request');
    globalThis.fetch=async(_url,init)=>{assert.equal(init.headers['if-none-match'],'"version-1"');return new Response(null,{status:304});};
    await refresh(provider,state);assert.equal(provider.getModels().length,2);
  } finally {globalThis.fetch=originalFetch;}
});

test('cache restores only for its account and valid source; failures retain same-account models; cancellation cannot publish', async()=>{
  const originalFetch=globalThis.fetch,state={};globalThis.fetch=async()=>response();
  try {
    await refresh(wrap(),state);
    const saved=structuredClone(state.stored),provider=wrap();
    await refresh(provider,state,{allowNetwork:false});assert.equal(provider.getModels().length,2);
    for(const code of [401,404,500]) {
      globalThis.fetch=async()=>new Response(null,{status:code});
      await assert.rejects(refresh(provider,state),new RegExp(String(code)));
      assert.equal(provider.getModels().length,2);assert.deepEqual(state.stored,saved);
    }
    await refresh(provider,state,{allowNetwork:false,credential:credential('account-B')});assert.deepEqual(provider.getModels(),[base]);
    globalThis.fetch=async()=>new Response(null,{status:401});
    await assert.rejects(refresh(provider,state,{credential:credential('account-B')}),/401/);assert.deepEqual(provider.getModels(),[base]);
    for (const patch of [{catalogSource:'legacy'},{validatedAt:'unknown'},{credentialScope:'other-account'}]) {
      await refresh(provider,{stored:{...saved,...patch}},{allowNetwork:false});assert.deepEqual(provider.getModels(),[base]);
    }
    const controller=new AbortController();globalThis.fetch=async()=>{controller.abort();return response();};
    await assert.rejects(refresh(provider,state,{signal:controller.signal}));assert.deepEqual(state.stored,saved);
  } finally {globalThis.fetch=originalFetch;}
});

test('native runtime discovers Luna during startup, composes explicit user metadata, and restores the account catalog offline',async()=>{
  const originalFetch=globalThis.fetch, directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-catalog-'));
  try {
    const modelsPath=path.join(directory,'models.json');
    await fs.writeFile(modelsPath,JSON.stringify({providers:{'openai-codex':{modelOverrides:{'gpt-6-luna':{maxTokens:8192}},models:[{id:'explicit-user-model',contextWindow:64000,maxTokens:4096}]}}}));
    const store=new InMemoryCodingAgentModelsStore(),credentials=AuthStorage.inMemory({'openai-codex':credential('account-A')});let calls=0;
    globalThis.fetch=async(url,init)=>{
      if(new URL(url).origin==='https://catalog.invalid'){assert.ok(!new Headers(init?.headers).has('authorization'));return new Response(null,{status:404});}
      assert.equal(new URL(url).pathname,'/backend-api/codex/models');calls++;return response();
    };
    const options={credentials,modelsPath,modelsStore:store,catalogBaseUrl:'https://catalog.invalid'};
    const runtime=await ModelRuntime.create({...options,allowModelNetwork:true});
    assert.equal(calls,1);assert.ok(runtime.getAvailableSnapshot().some(m=>m.id==='gpt-6-luna'));
    assert.equal(runtime.getModel('openai-codex','gpt-6-luna').maxTokens,8192);
    assert.equal(runtime.getModel('openai-codex','gpt-6-luna').outputLimitEstimated,false,'explicit output metadata replaces the estimated allowance');
    assert.ok(runtime.getModel('openai-codex','explicit-user-model'),'custom model entries survive live publication');
    globalThis.fetch=async()=>{throw new Error('Offline boot must not fetch');};
    const restarted=await ModelRuntime.create({...options,allowModelNetwork:false});
    assert.ok(restarted.getAvailableSnapshot().some(m=>m.id==='gpt-6-luna'));
    const other=await ModelRuntime.create({...options,credentials:AuthStorage.inMemory({'openai-codex':credential('account-B')}),allowModelNetwork:false});
    assert.equal(other.getModel('openai-codex','gpt-6-luna'),undefined,'another account cannot inherit discovery');
  } finally {globalThis.fetch=originalFetch;await fs.rm(directory,{recursive:true,force:true});}
});
