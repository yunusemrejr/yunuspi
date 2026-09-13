import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/mini-preprocessor.ts')));
const {createMiniPreprocessor,miniSource}=await import(pathToFileURL(path.join(agent,'extensions/lib/mini-preprocessor.ts')));
const runtime={version:1,enabled:true,endpoint:'http://127.0.0.1:18736/select',apiKey:'TEST_MINI_PREPROCESSOR_KEY_1234567890'};
const fact='The current status remains blocked until verification confirms the deployment result.';
const filler='General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.';
const raw=[fact,...Array(9).fill(filler)].join('\n\n');
const selection=text=>({version:1,status:'SELECT',sourceHash:miniSource(text).hash,keep:[0]});

test('validated source selections save repeat inference, resist mutation and reset with the branch',async()=>{
  let calls=0,now=0;
  const c=createMiniPreprocessor({runtime,now:()=>now,fetch:async(_url,o)=>{calls++;return new Response(JSON.stringify(selection(JSON.parse(o.body).raw)));}});
  const first=await c.select(raw,0);assert.deepEqual(first,selection(raw));first.keep.push(1);
  assert.deepEqual(await c.select(raw,0),selection(raw));assert.equal(calls,1);assert.equal(c.inspect().cacheHits,1);
  const changed=raw.replace('blocked','pending');assert.equal(await c.select(changed,0),undefined,'different source cannot use cached IDs');
  now=10000;assert.deepEqual(await c.select(changed,0),selection(changed));assert.equal(calls,2);
  c.reset();assert.equal(c.inspect().cached,0);assert.equal(await c.select(raw,0),undefined,'reset preserves cooldown');
  now=20000;assert.deepEqual(await c.select(raw,0),selection(raw));assert.equal(calls,3);
  for(let i=0;i<20;i++){now+=10000;await c.select(raw.replace('status',`status ${i}`),0);}
  assert.equal(c.inspect().cached,16,'cache storage is bounded');
  assert.ok(c.inspect().projectedSavedChars>0);
});

test('worker failures back off without turning unavailable or malformed output into a selection',async()=>{
  let calls=0,now=0,healthy=false;
  const c=createMiniPreprocessor({runtime,now:()=>now,fetch:async()=>{calls++;return new Response(JSON.stringify(healthy?selection(raw):{version:1,status:'UNKNOWN'}));}});
  assert.equal(await c.select(raw,0),undefined);assert.equal(c.inspect().cooldownMs,20000);
  now=10000;assert.equal(await c.select(raw,0),undefined);assert.equal(calls,1);
  now=20000;assert.equal(await c.select(raw,0),undefined);assert.equal(calls,2);assert.equal(c.inspect().cooldownMs,40000);
  now=60000;healthy=true;assert.deepEqual(await c.select(raw,0),selection(raw));assert.equal(c.inspect().cooldownMs,10000);
  assert.equal(c.inspect().fallbacks,2);assert.equal(c.inspect().accepted,1);
});

test('noncooperative inference remains bounded and stale completions cannot populate the cache',async()=>{
  let finish;
  const c=createMiniPreprocessor({runtime,fetch:()=>new Promise(r=>finish=r)});
  const work=c.select(raw,0);c.reset();finish(new Response(JSON.stringify(selection(raw))));assert.equal(await work,undefined);assert.equal(c.inspect().cached,0);
  const hold=setTimeout(()=>{},1000),started=performance.now();
  try{const stuck=createMiniPreprocessor({runtime,fetch:()=>new Promise(()=>{})});assert.equal(await stuck.select(raw,0),undefined);assert.ok(performance.now()-started<900);assert.equal(stuck.inspect().busy,false);}finally{clearTimeout(hold);}
});
