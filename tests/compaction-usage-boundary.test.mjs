import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'scripts/patches/compaction-early.mjs')));
let parser;
try {parser=await import('acorn');} catch {parser=createRequire(path.join(agent,'npm/package.json'))('acorn');}
const {parseExpressionAt}=parser;
const {targets}=await import(pathToFileURL(path.join(agent,'scripts/patches/compaction-early.mjs')));
let core;
try {core=path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))),'..');}
catch {core=path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');}
const saved=process.env.PI_HARNESS_PATCH_TEST_CORE;
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'pi-compaction-usage-'));
function fn(source,name,scope) {
 const match=new RegExp(`function ${name}\\(`).exec(source);
 assert.ok(match,`real runtime owner ${name}`);
 const node=parseExpressionAt(source,match.index,{ecmaVersion:'latest'});
 return vm.runInNewContext(`(${source.slice(node.start,node.end)})`,scope);
}
try {
 process.env.PI_HARNESS_PATCH_TEST_CORE=core;
 for(const file of new Set(targets().map(t=>t.file))) {
  const dest=path.join(stage,path.relative(core,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);
 }
 process.env.PI_HARNESS_PATCH_TEST_CORE=stage;
 for(const target of targets().filter(t=>t.name.includes('post-compaction usage'))) {
  await test(target.name+' ignores retained stale usage without changing billing records',()=>{
   target.apply();assert.equal(target.isApplied(),true);
   const once=fs.readFileSync(target.file,'utf8');target.apply();assert.equal(fs.readFileSync(target.file,'utf8'),once);
   const usage=m=>m.role==='assistant'&&m.stopReason!=='error'&&m.stopReason!=='aborted'&&m.usage?.input>0?m.usage:undefined;
   const count=u=>u.input+u.output+u.cacheRead+u.cacheWrite;
   const estimate=m=>Math.ceil(String(m.content??m.summary??'').length/4);
   const lookup=fn(once,'getLastAssistantUsageInfo',{getAssistantUsage:usage});
   const estimator=fn(once,'estimateContextTokens',{getLastAssistantUsageInfo:lookup,calculateContextTokens:count,estimateTokens:estimate,estimateTokens2:estimate});
   const old={role:'assistant',timestamp:10,content:'kept work',usage:{input:200000,output:100,cacheRead:0,cacheWrite:0}};
   const summary={role:'compactionSummary',timestamp:20,summary:'Decisions and constraints'};
   const tool={role:'toolResult',timestamp:11,content:'bounded evidence'};
   const compacted=[summary,old,tool];
   const snapshot=JSON.stringify(compacted);
   assert.equal(estimator([old,tool]).tokens,200104,'ordinary provider usage remains authoritative');
   assert.equal(estimator(compacted).lastUsageIndex,null,'old request is not a new context measurement');
   assert.equal(estimator(compacted).tokens,compacted.reduce((n,m)=>n+estimate(m),0));
   assert.ok(estimator(compacted).tokens<100,'retained usage cannot immediately retrigger an 80k compaction threshold');
   assert.equal(JSON.stringify(compacted),snapshot,'historical billing usage is unchanged');
   const fresh={...old,timestamp:30,usage:{...old.usage,input:12000}};
   assert.equal(estimator([...compacted,fresh,tool]).tokens,12104,'fresh provider usage resumes accounting');
   assert.equal(estimator([{...summary,timestamp:undefined},old]).lastUsageIndex,null,'unknown boundary falls back to current message size');
  });
 }
} finally {
 if(saved===undefined)delete process.env.PI_HARNESS_PATCH_TEST_CORE;else process.env.PI_HARNESS_PATCH_TEST_CORE=saved;
 fs.rmSync(stage,{recursive:true,force:true});
}
