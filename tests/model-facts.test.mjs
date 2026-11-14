import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/model-facts.ts')));
const {MODEL_FACTS_VERSION,MODEL_FACTS,currentModelFacts,knownModelFacts,directDeepseekCost,antLingCost,antLingRetired}=await import(pathToFileURL(path.join(agent,'extensions/lib/model-facts.ts')));
test('dated model facts have explicit provenance and expire without becoming free evidence',()=>{
 assert.equal(MODEL_FACTS_VERSION,1);
 for(const [provider,row] of Object.entries(MODEL_FACTS)){
  const expiry=Date.parse(row.expiresAt);
  assert.ok(row.source && Date.parse(row.verifiedAt)<expiry);
  assert.ok(currentModelFacts(provider,expiry-1));
  assert.equal(currentModelFacts(provider,expiry),undefined);
  assert.equal(currentModelFacts(provider,Date.parse(row.verifiedAt)-1),undefined);
 }
 assert.equal(currentModelFacts('__proto__'),undefined);
 assert.equal(directDeepseekCost('deepseek-flash',Date.parse(MODEL_FACTS.deepseek.expiresAt)),undefined);
 assert.deepEqual(directDeepseekCost('deepseek-flash',Date.parse(MODEL_FACTS.deepseek.expiresAt)-1),{input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0});
});
test('a snapshot past its window is stale, not gone: limits and wire formats keep applying, prices stop',()=>{
 for(const [provider,row] of Object.entries(MODEL_FACTS)){
  const expiry=Date.parse(row.expiresAt);
  assert.equal(knownModelFacts(provider,expiry+365*86_400_000),row,'still the best evidence a year later');
  assert.equal(knownModelFacts(provider,Date.parse(row.verifiedAt)-1),undefined,'never before its evidence date');
 }
 assert.equal(knownModelFacts('__proto__'),undefined);
 const later=Date.parse('2027-06-01T00:00:00Z');
 assert.equal(knownModelFacts('deepseek',later).models['deepseek-flash'].compat.thinkingFormat,'deepseek');
 assert.equal(directDeepseekCost('deepseek-flash',later),undefined,'an old price is not quoted as current');
});
test('versioned direct price schedule preserves its original boundary',()=>{
 const cutover=Date.parse('2026-09-14T04:00:00Z');
 assert.equal(directDeepseekCost('deepseek-v4-pro',cutover-1).input,1.32);
 assert.equal(directDeepseekCost('deepseek-v4-pro',cutover).input,0.3);
 const back=Date.parse('2026-11-10T00:00:00Z');
 assert.equal(directDeepseekCost('deepseek-v4-pro',back-1).input,0.3);
 assert.deepEqual(directDeepseekCost('deepseek-v4-pro',back),{input:1.32,output:3.96,cacheRead:0.044,cacheWrite:0});
 assert.equal(directDeepseekCost('unknown',cutover),undefined);
});
test('Ant Ling prices stop at their review dates and withdrawn models stop at the vendor\'s moment',()=>{
 const day=iso=>Date.parse(iso);
 assert.deepEqual(antLingCost('Ling-3.2-flash',day('2026-11-17T23:59:59Z')),{input:0,output:0,cacheRead:0,cacheWrite:0,knownFree:true});
 assert.equal(antLingCost('Ling-3.2-flash',day('2026-11-18T00:00:00Z')),undefined,'the price after the free fortnight is not published');
 assert.equal(antLingCost('Ling-3.1-flash',day('2026-11-27T23:59:59Z')).input,0.07494);
 assert.equal(antLingCost('Ling-3.1-flash',day('2026-11-28T00:00:00Z')),undefined);
 assert.equal(antLingCost('Ling-3.0-tiny',day('2026-11-15T00:00:00Z')),undefined,'unpublished stays unknown');
 assert.equal(antLingCost('__proto__',day('2026-11-15T00:00:00Z')),undefined);
 assert.equal(antLingRetired('Ling-2.6-flash',day('2026-11-14T15:59:59Z')),false);
 for(const id of ['Ling-2.6-1T','Ling-2.6-flash','Ring-2.6-1T'])assert.equal(antLingRetired(id,day('2026-11-14T16:00:00Z')),true);
 assert.equal(antLingRetired('Ling-3.1-flash',day('2030-01-01T00:00:00Z')),false);
});
