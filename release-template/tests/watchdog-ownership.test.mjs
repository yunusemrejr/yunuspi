import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/quality-review.ts')));
const load=p=>import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/watchdog',p)));
const {DEFAULT_WATCHDOG_CONFIG,resolveWatchdogConfig}=await load('settings.ts');
const {MainWatchdogRuntime}=await load('runtime.ts');
const {createCoordinatedWatchdogReview}=await load('coordinated-review.ts');
const {resolveChildWatchdogConfig}=await load('child-status.ts');

test('default watchdog supplies fresh diagnostics without a nested reviewer or competing followup',async()=>{
 const config=structuredClone(DEFAULT_WATCHDOG_CONFIG),ctx={cwd:'/fixture/watchdog'};
 assert.equal(config.enabled,true);assert.equal(config.main.enabled,true);
 assert.equal(resolveChildWatchdogConfig({config,agent:'worker'}).enabled,true);
 assert.equal(Object.hasOwn(config,'asyncCompletion'),false,'retired unused completion mode is absent from default capabilities');
 let key='baseline',diagnostics=0,independent=0,wakes=0;const warnings=[];
 const review=createCoordinatedWatchdogReview(()=>ctx,()=>{independent++;return {warnings:[]};});
 const runtime=new MainWatchdogRuntime({cwd:ctx.cwd,resolveConfig:()=>({ok:true,config,errors:[],sources:[]}),review,reviewChangesOnly:true,ownsAutoFollow:()=>false,
  repoChangeSignature:()=>({root:ctx.cwd,key,changedPaths:key==='baseline'?[]:['src/value.ts']}),
  lspDiagnostics:async()=>{diagnostics++;return {status:'ok',checkedPaths:['src/value.ts'],skippedPaths:[],diagnostics:[{path:'src/value.ts',line:1,column:1,severity:'error',source:'fixture',message:'The referenced identifier does not exist.'}]};},
  displayWarning:warning=>warnings.push(warning),sendUserMessage:()=>wakes++});
 try{
  runtime.handleBeforeAgentStart({prompt:'Fix the reported behavior'},ctx);key='changed';runtime.enqueueDelta('Changed src/value.ts');
  await runtime.handleAgentEnd({},ctx);await runtime.handleAgentEnd({},ctx);
  assert.equal(diagnostics,1);assert.equal(warnings.length,1);assert.equal(warnings[0].source,'lsp');
  assert.equal(independent,0);assert.equal(wakes,0);assert.equal(runtime.getSnapshot().autoFollowActive,false);
  config.main.model='fixture/explicit-reviewer';
  await review({config,delta:'Changed source',epoch:1,hasScope:true,reviewId:1,emitWarning:()=>true});
  assert.equal(independent,1,'an explicitly configured model retains standalone review');
 }finally{runtime.dispose();}
 const legacy=resolveWatchdogConfig('/fixture/watchdog',{session:{asyncCompletion:{enabled:true,autoFollowBlockers:true}}});
 assert.equal(legacy.ok,true,'legacy completion settings remain readable without pretending to schedule another reviewer');
});
