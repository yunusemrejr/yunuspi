import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/model-facts.ts')));
const {MODEL_FACTS_VERSION,MODEL_FACTS,currentModelFacts,directDeepseekCost}=await import(pathToFileURL(path.join(agent,'extensions/lib/model-facts.ts')));
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
 assert.equal(directDeepseekCost('deepseek-flash',Date.parse('2026-10-10T00:00:00Z')),undefined);
});
test('versioned direct price schedule preserves its original boundary',()=>{
 const cutover=Date.parse('2026-09-14T04:00:00Z');
 assert.equal(directDeepseekCost('deepseek-v4-pro',cutover-1).input,1.32);
 assert.equal(directDeepseekCost('deepseek-v4-pro',cutover).input,0.3);
 assert.equal(directDeepseekCost('unknown',cutover),undefined);
});
