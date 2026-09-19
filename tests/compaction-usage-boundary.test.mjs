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
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'scripts/compatibility/legacy-transforms/compaction-early.mjs')));
let parser;
try {parser=await import('acorn');} catch {parser=createRequire(path.join(agent,'npm/package.json'))('acorn');}
const {parseExpressionAt}=parser;

let core;
try {core=path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@yunuspi/coding-agent'))),'..');}
catch {core=path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@yunuspi/coding-agent');}
const saved=process.env.PI_HARNESS_PATCH_TEST_CORE;
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'pi-compaction-usage-'));
function fn(source,name,scope) {
 const match=new RegExp(`function ${name}\\(`).exec(source);
 assert.ok(match,`real runtime owner ${name}`);
 const node=parseExpressionAt(source,match.index,{ecmaVersion:'latest'});
 return vm.runInNewContext(`(${source.slice(node.start,node.end)})`,scope);
}
try {
 const targets=()=>[
  {name:'owned shouldCompact',file:path.join(core,'dist/core/compaction/compaction.js')},
  {name:'owned automatic full-window gates',file:path.join(core,'dist/core/agent-session.js')},
  {name:'owned post-compaction usage',file:path.join(core,'dist/core/compaction/compaction.js')},
 ];
 for (const target of targets().filter(t=>t.name.includes('shouldCompact'))) {
  await test(target.name+' waits for exactly 80% of the whole model window',()=>{
   const predicate=fn(fs.readFileSync(target.file,'utf8'),'shouldCompact',{});
   for (const window of [8192,128000,272000,1000000,1310720]) {
    const threshold=Math.ceil(window*.8);
    for(const cap of [undefined,96000,256000,1]) {
     const settings={enabled:true,maxContextTokens:cap,reserveTokens:window};
     assert.equal(predicate(Math.floor(window*.06),window,settings),false);
     assert.equal(predicate(threshold-1,window,settings),false);
     assert.equal(predicate(threshold,window,settings),true);
     assert.equal(predicate(window,window,{...settings,enabled:false}),false);
    }
   }
  });
 }
 for (const target of targets().filter(t=>t.name.includes('automatic full-window gates'))) {
  await test(target.name+' prevents early overflow or length recovery without changing history',async()=>{
   const source=fs.readFileSync(target.file,'utf8');
   for(const name of ['_checkCompaction','_runAutoCompaction']) {
    const index=source.indexOf('async '+name+'(');assert.ok(index>=0);
    const expression='async function '+source.slice(index+6);
    const node=parseExpressionAt(expression,0,{ecmaVersion:'latest'});
    let usage=95138,authCalls=0;
    const execute=vm.runInNewContext('('+expression.slice(0,node.end)+')',{shouldCompact:(tokens,window,settings)=>settings.enabled&&tokens>=Math.ceil(window*.8),estimateContextTokens:()=>({tokens:usage})});
    const messages=[{role:'assistant',stopReason:'error',errorMessage:'context length exceeded'}];
    const host={model:{contextWindow:1000000},settingsManager:{getCompactionSettings:()=>({enabled:true,maxContextTokens:96000})},agent:{state:{messages}},_getSummarizationRequestAuth:async()=>{authCalls++;throw new Error('fixture stops before inference');},_resolveIdleWaitIfIdle(){}};
    assert.equal(await execute.call(host,name==='_checkCompaction'?messages[0]:'overflow',true),false);
    assert.equal(authCalls,0);assert.equal(host.agent.state.messages,messages);assert.equal(host._overflowRecoveryAttempted,undefined);
    if(name==='_runAutoCompaction') {usage=800000;await execute.call(host,'threshold',false);assert.equal(authCalls,1,'exact threshold admits automatic preparation');}
   }
  });
 }
 for(const target of targets().filter(t=>t.name.includes('post-compaction usage'))) {
  await test(target.name+' ignores retained stale usage without changing billing records',()=>{

   const once=fs.readFileSync(target.file,'utf8');
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
   assert.ok(estimator(compacted).tokens<100,'retained usage cannot immediately retrigger automatic compaction');
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
