import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
let agent=path.resolve(import.meta.dirname,'../agent');if(!fs.existsSync(agent))agent=path.resolve(import.meta.dirname,'../..');
const {patchSource,isAppliedSource,targets}=await import(pathToFileURL(path.join(agent,'scripts/patches/native-read-mutation-queue.mjs')));
const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('read queue patch is applied to SDK and CLI owner, idempotent, and rejects partial patches',()=>{
 for(const target of targets())assert.equal(target.isApplied(),true,target.name);
 const text=fs.readFileSync(path.join(core,'dist/core/tools/read.js'),'utf8');assert.equal(patchSource(text),text);assert.ok(isAppliedSource(text));
 assert.throws(()=>patchSource(text.replace('PI_NATIVE_READ_QUEUE_END','DRIFT')),/partial\/drifted/);
 const unpatched=text.replace('import { withFileMutationQueue } from "./file-mutation-queue.js";\n','').replace('await withFileMutationQueue(absolutePath, async () => { /* PI_NATIVE_READ_MUTATION_QUEUE */','').replace('}); /* PI_NATIVE_READ_QUEUE_END */','');
 assert.equal(patchSource(unpatched),text);
});
for(const flavor of ['sdk','bundle'])test(`${flavor}: read waits through an edit truncation gap while other files stay concurrent`,async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'pi-native-read-queue-'));const file=path.join(root,'value.txt'),alias=path.join(root,'alias.txt'),other=path.join(root,'other.txt');
 const opened=gate(),release=gate();let running;
 try{
  const api=flavor==='bundle'?await import(pathToFileURL(path.join(core,'dist/bundle/index.js'))):{...await import(pathToFileURL(path.join(core,'dist/core/tools/read.js'))),...await import(pathToFileURL(path.join(core,'dist/core/tools/edit.js')))};
  await fsp.writeFile(file,'first\nold\nthird');await fsp.writeFile(other,'independent');await fsp.symlink(file,alias);
  const edit=api.createEditToolDefinition(root,{operations:{access:fsp.access,readFile:fsp.readFile,writeFile:async(p,content)=>{await fsp.writeFile(p,'');opened.resolve();await release.promise;await fsp.writeFile(p,content);}}});
  running=edit.execute('edit',{path:file,edits:[{oldText:'old',newText:'new'}]});await opened.promise;
  const read=api.createReadToolDefinition(root);let settled=false;
  const same=read.execute('read',{path:alias,offset:2,limit:1}).finally(()=>settled=true);
  // Attach rejection immediately so a prepatch race becomes an assertion, not
  // an unhandled rejection before the deterministic paused write is released.
  const result=same.then(value=>({value}),error=>({error}));
  await tick();assert.equal(settled,false,'read must not observe transient empty file');
  const different=await read.execute('other',{path:other});assert.equal(different.content[0].text,'independent');
  const abort=new AbortController();const cancelled=read.execute('cancelled',{path:file},abort.signal);abort.abort();await assert.rejects(cancelled,/aborted/);
  release.resolve();await running;const completed=await result;assert.equal(completed.error,undefined);assert.match(completed.value.content[0].text,/^new/);
 }finally{release.resolve();await running?.catch(()=>{});await fsp.rm(root,{recursive:true,force:true});}
});
test('aborting a native read does not release its underlying in-flight I/O ahead of a queued edit',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'pi-native-read-abort-'));const file=path.join(root,'value.txt'),entered=gate(),release=gate();let edit;
 try{
  const {createReadToolDefinition}=await import(pathToFileURL(path.join(core,'dist/core/tools/read.js')));const {createEditToolDefinition}=await import(pathToFileURL(path.join(core,'dist/core/tools/edit.js')));
  await fsp.writeFile(file,'old');let writes=0;
  const read=createReadToolDefinition(root,{operations:{access:fsp.access,readFile:async p=>{entered.resolve();await release.promise;return fsp.readFile(p);}}});
  const abort=new AbortController();const pending=read.execute('read',{path:file},abort.signal);const rejected=assert.rejects(pending,/aborted/);await entered.promise;abort.abort();await rejected;
  edit=createEditToolDefinition(root,{operations:{access:fsp.access,readFile:fsp.readFile,writeFile:async(p,c)=>{writes++;await fsp.writeFile(p,c);}}}).execute('edit',{path:file,edits:[{oldText:'old',newText:'new'}]});
  await tick();assert.equal(writes,0);release.resolve();await edit;assert.equal(writes,1);
 }finally{release.resolve();await edit?.catch(()=>{});await fsp.rm(root,{recursive:true,force:true});}
});
