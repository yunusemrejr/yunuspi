import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts')));
assert.ok(agent,'recovery support ships in public releases');
const h=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/provider-health.ts')));
const endpoints=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts')));
const {projectTestFacts}=await import(pathToFileURL(path.join(agent,'scripts/workspace-facts.mjs')));

test('an attributed upstream cooldown does not block the whole router; account quota does',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-recovery-')),old=process.env.PI_PROVIDER_STATE_FILE;
 process.env.PI_PROVIDER_STATE_FILE=path.join(dir,'health.json');
 try {
  const now=Date.now();
  h.recordFailure({provider:'openrouter',model:'lab/future',errorMessage:'429 '+JSON.stringify({error:{metadata:{provider_name:'Host A'},message:'Provider returned error'}}),now});
  assert.equal(h.evaluateRoute({provider:'openrouter',model:'lab/future',endpoints:['Host A'],now}).allowed,false);
  assert.equal(h.evaluateRoute({provider:'openrouter',model:'lab/future',endpoints:['Host B'],now}).allowed,true);
  h.recordFailure({provider:'openrouter',model:'lab/future',errorMessage:'429 account quota exceeded',now});
  assert.equal(h.evaluateRoute({provider:'openrouter',model:'other/future',endpoints:['Host B'],now}).allowed,false);
  assert.equal(h.classifyFailure('401 invalid api key').kind,'provider-auth');
  assert.equal(h.classifyFailure('content filter: unavailable').kind,'deterministic');
 } finally {if(old===undefined)delete process.env.PI_PROVIDER_STATE_FILE;else process.env.PI_PROVIDER_STATE_FILE=old;fs.rmSync(dir,{recursive:true,force:true});}
});
test('temporary endpoint routing preserves privacy/price dimensions and understands percentile metrics',()=>{
 const routing=endpoints.endpointRecoveryRouting({tag:'host-b'},{zdr:true,data_collection:'deny',ignore:['host-a'],max_price:{request:0,image:0}},{prompt:.1,completion:.2});
 assert.deepEqual(routing.only,['host-b']);assert.equal(routing.allow_fallbacks,false);assert.equal(routing.require_parameters,true);
 assert.equal(routing.zdr,true);assert.equal(routing.data_collection,'deny');assert.equal(routing.max_price.image,0);assert.equal(routing.max_price.request,0);
 assert.equal(endpoints.endpointMetric({p50:1,p90:2}),1);assert.equal(endpoints.endpointMetric(NaN),undefined);
 assert.equal(endpoints.endpointMatches('host-a/region','host-a'),true);assert.equal(endpoints.endpointMatches('host-ab','host-a'),false);
});
test('test discovery reads filenames and literal manifests without executing scripts or following symlinks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-project-tests-'));
 try {
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({scripts:{test:'touch should-never-exist'}}));
  fs.writeFileSync(path.join(dir,'example.test.js'),'throw Error("must not execute discovery input")');
  fs.symlinkSync('/etc',path.join(dir,'external'));
  const facts=await projectTestFacts(dir);
  assert.ok(facts.tests.includes('example.test.js'));assert.equal(facts.scripts[0].executed,false);assert.equal(facts.scripts[0].bodyOmitted,true);
  assert.equal(fs.existsSync(path.join(dir,'should-never-exist')),false);assert.ok(Object.keys(facts.sources).every(file=>!file.startsWith('external/')));
  const small=await projectTestFacts(dir,undefined,{maxEntries:1});assert.equal(small.truncated,true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
