import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const identity=JSON.parse(fs.readFileSync(path.join(root,'core/identity.json'),'utf8'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const names=['ai','agent-core','tui','coding-agent','telemetry','chord'];

test('all six runtime packages resolve from owned workspace source with exact internal versions',()=>{
 for(const name of names){
  const resolved=fileURLToPath(import.meta.resolve(`@yunuspi/${name}`));
  assert.ok(fs.realpathSync(resolved).startsWith(path.join(root,'core')+path.sep),resolved);
  const entry=lock.packages[`node_modules/@yunuspi/${name}`];assert.equal(entry.link,true);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,entry.resolved,'package.json'),'utf8'));
  assert.equal(pkg.version,identity.version);
  for(const [dep,version] of Object.entries(pkg.dependencies??{}))if(dep.startsWith('@yunuspi/'))assert.equal(version,identity.version);
 }
 for(const [name,entry] of Object.entries(lock.packages)){
  assert.doesNotMatch(name, /node_modules\/@earendil-works\/|node_modules\/@mariozechner\/pi-/);
  assert.doesNotMatch(entry.resolved??'',/registry\.npmjs\.org\/@(?:earendil-works|mariozechner)\/pi-/);
 }
});

test('hypothetical newer upstream release is ignored without even invoking transport, online or offline',async()=>{
 const api=await import('../core/coding-agent/dist/utils/version-check.js');
 const savedFetch=globalThis.fetch,savedOffline=process.env.PI_OFFLINE;let requests=0;
 globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({version:'99.0.0',packageName:'@earendil-works/pi-coding-agent'}));};
 try{for(const offline of [undefined,'1']){
  if(offline)process.env.PI_OFFLINE=offline;else delete process.env.PI_OFFLINE;
  assert.equal(await api.getLatestPiRelease(identity.version),undefined);
  assert.equal(await api.getLatestPiVersion(identity.version),undefined);
  assert.equal(await api.checkForNewPiVersion(identity.version),undefined);
 }}finally{globalThis.fetch=savedFetch;if(savedOffline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=savedOffline;}
 assert.equal(requests,0);assert.equal(identity.forkOrigin.version,'0.85.1');
});

test('core identity distinguishes product, core revision, source digest and historical origin',()=>{
 const result=spawnSync(process.execPath,[path.join(root,'core/coding-agent/dist/cli.js'),'--core-info'],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);const info=JSON.parse(result.stdout);
 assert.equal(info.product.name,'YunusPi');assert.equal(info.core.version,JSON.parse(fs.readFileSync(path.join(root,'core/identity.json'),'utf8')).version);
 assert.equal(info.core.forkOrigin.commit,'d981de1229ef899957bbe968bc8dcda02a21f477');
 assert.match(info.core.sourceDigest,/^[a-f0-9]{64}$/);
 assert.equal(info.core.releaseAuthority,'yunusemrejr/yunuspi');
});

test('build/install/update never use legacy core transforms or upstream release endpoints',()=>{
 for(const file of ['scripts/build-core.mjs','scripts/install.mjs','agent/scripts/core-update.mjs','agent/scripts/auto-update.sh','agent/scripts/verify-harness.mjs']){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(source,/legacy-transforms|pi\.dev\/api|@earendil-works\/pi-|npm[^\n]*@latest/,file);
 }
 for(const file of ['core/coding-agent/src/config.js','core/coding-agent/src/package-manager-cli.js','core/coding-agent/src/utils/version-check.js','core/coding-agent/src/modes/interactive/interactive-mode.js'])assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),/pi\.dev\/api\/(?:latest-version|installer|report-install)/,file);
});

test('owned edit API enforces optimistic concurrency and preserves rejected file bytes',async()=>{
 const {createEditToolDefinition}=await import('@yunuspi/coding-agent');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-edit-'));const file=path.join(dir,'fixture.txt');
 try{
 fs.writeFileSync(file,'first\nold\nthird');const edit=createEditToolDefinition(dir);
 const changed=await edit.execute('a',{path:file,edits:[{oldText:'old',newText:'new'}]});
 const hash=changed.details.optimisticConcurrency.after;assert.match(hash,/^[a-f0-9]{24}$/);
 fs.writeFileSync(file,'first\nconcurrent\nthird');
 await assert.rejects(edit.execute('b',{path:file,expectedHash:hash,edits:[{oldText:'concurrent',newText:'lost'}]}),/optimistic-concurrency conflict/);
 assert.equal(fs.readFileSync(file,'utf8'),'first\nconcurrent\nthird');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('owned SDK and CLI share one implementation, with no duplicate generated upstream bundle',()=>{
 assert.equal(fs.existsSync(path.join(root,'core/coding-agent/src/bundle')),false);
 const source=fs.readFileSync(path.join(root,'core/coding-agent/src/cli.js'),'utf8');assert.match(source,/\.\/main\.js/);
});


test('read-only micro diagnostics identify the actually resolved owned core',async()=>{
 const {activeCoreIdentity}=await import('../agent/extensions/lib/micro-intelligence/status.ts');
 const info=activeCoreIdentity();assert.equal(info.status,'owned');
 assert.equal(info.version,identity.version);assert.equal(info.origin.version,'0.85.1');
 assert.match(info.sourceDigest,/^[a-f0-9]{64}$/);
});
