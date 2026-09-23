import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

test('model picker preserves uncertainty and displays unknown prices and estimated output allowances',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'routing-unknown-metadata-'));
  const previous=Object.fromEntries(['PI_PROVIDER_STATE_FILE','PI_MODEL_EXCLUSIONS_PATH','PI_SUBAGENTS_ECONOMY_CONFIG'].map(key=>[key,process.env[key]]));
  process.env.PI_PROVIDER_STATE_FILE=path.join(directory,'health.json');
  process.env.PI_MODEL_EXCLUSIONS_PATH=path.join(directory,'exclusions.json');
  process.env.PI_SUBAGENTS_ECONOMY_CONFIG=path.join(directory,'economy.json');
  await fs.writeFile(process.env.PI_SUBAGENTS_ECONOMY_CONFIG,'{}');
  t.after(async()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;await fs.rm(directory,{recursive:true,force:true});});
  const {readModelRoutingSnapshot}=await import('../agent/extensions/lib/model-routing-store.ts');
  const {createModelRoutingEditorServer}=await import('../agent/extensions/model-routing-config.ts');
  const configPath=path.join(directory,'llm_preferences.json');
  await fs.writeFile(configPath,JSON.stringify({version:1,models:{},preferences:{subagents:{models:[{provider:'fixture',model:'unknown-price'}]}}}));
  const base={provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid/v1',contextWindow:272000,maxTokens:16384,input:['text'],reasoning:true};
  const models=[
    {...base,id:'unknown-price',name:'Unknown price',outputLimitEstimated:true,cost:{input:0,output:0,knownFree:true,missing:['input','output','cacheRead','cacheWrite','input','unrelated']}},
    {...base,id:'known-free',name:'Known free',outputLimitEstimated:false,cost:{input:0,output:0,knownFree:true}},
    {...base,id:'zero-placeholder',name:'Zero placeholder',cost:{input:0,output:0}},
    {...base,id:'known-price',name:'Known price',cost:{input:1,output:2}},
  ];
  const modelRegistry={getAll:()=>models,getAvailable:()=>models};
  const snapshot=readModelRoutingSnapshot(configPath,modelRegistry);
  const unknown=snapshot.models.find(model=>model.id==='unknown-price');
  assert.equal(unknown.outputLimitEstimated,true);assert.equal(unknown.maxTokens,16384);
  assert.deepEqual(unknown.cost,{knownFree:false,missing:['input','output','cacheRead','cacheWrite']});
  assert.equal(snapshot.models.find(model=>model.id==='known-free').cost.knownFree,true);
  assert.deepEqual(snapshot.models.find(model=>model.id==='known-price').cost,{input:1,output:2});
  const server=await createModelRoutingEditorServer({modelRegistry,hasUI:true},{configPath});
  t.after(()=>server.close());
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.goto(server.url);
  const saved=page.locator('.route-row[data-route="fixture/unknown-price"]');
  assert.match(await saved.innerText(),/price unknown/);assert.match(await saved.innerText(),/16,384 output allowance \(limit unverified\)/);assert.doesNotMatch(await saved.innerText(),/known free|\$0/);
  const search=page.getByRole('searchbox',{name:'Search models'});await search.fill('fixture');
  await page.waitForFunction(()=>document.querySelectorAll('.result').length===4);
  const unknownResult=page.locator('.result').filter({has:page.locator('.result-title',{hasText:'Unknown price'})});
  assert.match(await unknownResult.innerText(),/price unknown/);assert.match(await unknownResult.innerText(),/output allowance \(limit unverified\)/);assert.doesNotMatch(await unknownResult.innerText(),/known free|\$0/);
  const free=page.locator('.result').filter({has:page.locator('.result-title',{hasText:'Known free'})});
  assert.match(await free.innerText(),/known free/);assert.match(await free.innerText(),/16,384 max output/);assert.doesNotMatch(await free.innerText(),/price unknown|limit unverified/);
  const placeholder=page.locator('.result').filter({has:page.locator('.result-title',{hasText:'Zero placeholder'})});assert.match(await placeholder.innerText(),/price unknown/);
  const paid=page.locator('.result').filter({has:page.locator('.result-title',{hasText:/^Known price$/})});assert.doesNotMatch(await paid.innerText(),/price unknown|known free/);
  await page.setViewportSize({width:356,height:820});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await search.focus();assert.equal(await search.evaluate(node=>node===document.activeElement),true);
  assert.deepEqual(errors,[]);
});
