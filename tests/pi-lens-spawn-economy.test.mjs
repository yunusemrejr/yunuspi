import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseExpressionAt} from 'acorn';

// The pi-lens bundle is shipped as one file, so these tests evaluate the shipped
// function sources with injected collaborators instead of importing it.
const bundle=fs.readFileSync(new URL('../agent/extensions/pi-lens/dist/index.js',import.meta.url),'utf8');
function declaration(name) {
  const marker=[`async function ${name}(`,`function ${name}(`].map(needle=>bundle.indexOf(needle)).filter(at=>at>=0).sort((a,b)=>a-b)[0];
  assert.ok(marker!==undefined,`shipped function ${name} exists`);
  return bundle.slice(marker,parseExpressionAt(bundle,marker,{ecmaVersion:'latest'}).end);
}
function load(names,globals,prelude='') {
  const context=vm.createContext({...globals});
  vm.runInContext(`${prelude}\n${names.map(declaration).join('\n')}\nthis.api={${names.join(',')}};`,context);
  return context.api;
}

test('a registry lock held by this very process is not waited out by the synchronous shutdown path',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lens-lock-'));
  try {
    const target=path.join(dir,'instances.json');
    const lock=`${target}.lock`;
    const api=load(
      ['withInstanceRegistryLockSync','staleLock','takeOverStale','ownerPid','ownsLock','isPidAlive','isLockContention','releaseLockSync','backoff','backoffMs','recordLockTimeout'],
      {fs6:fs,path9:path,process,Date,Atomics,SharedArrayBuffer,Int32Array,Number,randomInt:(low,high)=>low+Math.floor(Math.random()*(high-low)),lockPath:()=>lock,incrementDegradationCount:()=>{}},
      'var LOCK_STALE_MS=5000,LOCK_WAIT_MS=500,LOCK_MIN_BACKOFF_MS=5,LOCK_MAX_BACKOFF_MS=25;',
    );
    // An async registry write in this process owns the lock; it cannot finish while the sync path blocks the loop.
    fs.writeFileSync(lock,`${process.pid} ${Date.now()}\n`);
    const started=Date.now();
    let ran=0;
    assert.equal(api.withInstanceRegistryLockSync(target,()=>++ran),1);
    assert.equal(ran,1);
    assert.ok(Date.now()-started<200,`expected no wait, took ${Date.now()-started} ms`);
    assert.ok(fs.existsSync(lock),'the in-flight async owner still releases its own lock');
    fs.rmSync(lock);
    // The ordinary path still takes and releases the lock around the operation.
    assert.equal(api.withInstanceRegistryLockSync(target,()=>fs.existsSync(lock)),true);
    assert.equal(fs.existsSync(lock),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('global bin directories are looked up once per manager, concurrently, and a managed binary skips the lookup',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'lens-home-'));
  try {
    const calls=[];
    const answers={npm:'/prefix/npm',pnpm:'/prefix/pnpm/bin',yarn:'/prefix/yarn/bin'};
    let inFlight=0,peak=0;
    const safeSpawnAsync=async(command,args)=>{
      calls.push(`${command} ${args.join(' ')}`);
      peak=Math.max(peak,++inFlight);
      await new Promise(resolve=>setTimeout(resolve,20));
      inFlight--;
      return {status:0,stdout:`${answers[command]}\n`};
    };
    const api=load(
      ['findGlobalBinary','allAvailableGlobalBinDirs','globalBinDirsFor','globalBinDirsForUncached','pmBinary','_resetPackageManagerCache'],
      {path23:path,fs17:fs,os6:os,process,Date,Map,Promise,safeSpawnAsync,onWindows:()=>false,getGlobalPiLensDir:()=>home,
        isAvailable:async()=>true,availabilityLatches:new Map(),packageManagerProbeFlights:new Map()},
      'var PREFERENCE=["npm","pnpm","yarn"];var globalBinDirMemo=new Map();',
    );
    const dirs=await api.allAvailableGlobalBinDirs();
    assert.deepEqual([...dirs],['/prefix/npm/bin','/prefix/pnpm/bin','/prefix/yarn/bin'],'order follows the manager preference');
    assert.equal(calls.length,3);
    assert.ok(peak>1,'the managers are asked at the same time');
    await api.allAvailableGlobalBinDirs();
    assert.equal(calls.length,3,'a second lookup reuses the first answers');

    // A tool pi-lens installed itself is found without asking any package manager.
    const managed=path.join(home,'tools','node_modules','.bin');
    fs.mkdirSync(managed,{recursive:true});
    fs.writeFileSync(path.join(managed,'biome'),'#!/bin/sh\n');
    api._resetPackageManagerCache();
    const before=calls.length;
    assert.equal(await api.findGlobalBinary('biome'),path.join(managed,'biome'));
    assert.equal(calls.length,before,'no manager was spawned for a managed binary');
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});

test('opaque changes are resolved against the Git root when Bash runs in a nested directory', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lens-nested-git-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const nested=path.join(dir,'app'), edited=path.join(nested,'value.js');
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'});
  git(dir,'init','-q');
  fs.mkdirSync(nested);
  fs.writeFileSync(edited,'const value=1;\n');
  git(dir,'add','app/value.js');
  git(dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const startedAt=Date.now();
  fs.writeFileSync(edited,'const value=2;\n');
  const api=load(['resolveGitToplevel','recoverOpaqueChangesViaGit'],{
    path159:path,fs109:fs,normalizeMapKey:f=>f,
    safeSpawnAsync:async(_cmd,args,{cwd})=>({stdout:git(cwd,...args),status:0}),
    truncatedByOutputCap:()=>false,isStructurallyValidStatus:()=>true,isKnownPorcelainStatus:()=>true,isUnmergedStatus:()=>false,
    freshnessFromMtime:({mtimeMs,referenceMs})=>({verdict:mtimeMs>=referenceMs?'stale':'fresh'}),
  },'var gitToplevelMemo=new Map(),OPAQUE_MTIME_TOLERANCE_MS=150,MAX_GIT_STATUS_OUTPUT_BYTES=16777216;');
  const result=await api.recoverOpaqueChangesViaGit(nested,startedAt);
  assert.equal(result.verdict,'recovered');
  assert.deepEqual([...result.paths],[edited]);
});

test('opaque baselines belong to the individual Bash call and survive out-of-order results', async () => {
  const marker='var OpaqueBaselineStore = class';
  const offset=bundle.indexOf(marker)+'var OpaqueBaselineStore = '.length;
  const source=bundle.slice(offset,parseExpressionAt(bundle,offset,{ecmaVersion:'latest'}).end);
  const Store=vm.runInNewContext(`(${source})`);
  const store=new Store();
  let clock=10;
  const recovered=[],logs=[];
  const api=load(['opaqueBaselineKey','handleToolCallImpl','handleToolResult'],{
    path159:path,Date:{now:()=>clock},normalizeMapKey:f=>f,resolveToolCallCorrelationId:e=>e.toolCallId,
    getReadGuardCorrelationId:e=>e.toolCallId,getStableSessionId:ctx=>ctx.sessionManager.getSessionId(),
    getOpaqueBaselineStore:()=>store,logLatency:e=>logs.push(e),
    isGitWorktree:async()=>true,captureFileStats:async()=>assert.fail('Git worktree should not need a full file snapshot'),
    getToolCallRawFilePath:()=>undefined,resolveToolCallFilePath:()=>undefined,
    extractWrittenPathsFromCommand:()=>[],extractReadPathsFromCommand:()=>[],isFailedGitIntegrationCommand:()=>false,
    recoverOpaqueChangesViaGit:async(root,start)=>{recovered.push([root,start]);return {verdict:'recovered',paths:[]};},
    AUTHORITATIVE_CONTENT_MAX_BYTES:1024,process,
  });
  const key=id=>api.opaqueBaselineKey('/fixture','session',1,{toolCallId:id});
  const ctx={cwd:'/fixture',sessionManager:{getSessionId:()=> 'session'}};
  const runtime={projectRoot:'/fixture',sessionGeneration:1,takeToolCallAttribution(){}};
  let disabled=false;
  const getFlag=name=>name==='no-lsp'||(name==='no-read-guard'&&disabled);
  const event=toolCallId=>({toolCallId,toolName:'bash',input:{command:'fixture command'},content:[]});
  const call=id=>api.handleToolCallImpl({event:event(id),ctx,runtime,lensEnabled:true,getFlag,getTreeSitterClient(){}});
  const result=id=>api.handleToolResult({event:event(id),runtime,getFlag,ctxCwd:ctx.cwd,sessionId:'session',dbg(){},agentBehaviorRecord:()=>[]});
  await call('first');clock++;
  await call('second');clock++;
  await result('second');
  await result('first');
  assert.deepEqual(recovered,[['/fixture',11],['/fixture',10]]);
  disabled=true;
  await call('disabled');
  assert.equal(store.take(key('disabled')),undefined);
  assert.equal(logs.filter(e=>e.phase==='opaque_mutation_prescan').length,2);
  assert.notEqual(key('first'),api.opaqueBaselineKey('/fixture','different',1,{toolCallId:'first'}));
  for(let i=0;i<256;i++) store.record(key(String(i)),{startedAt:i});
  assert.ok(store.evictionCount>0);
  assert.equal(store.take(key('0')),undefined);
  assert.equal(store.take(key('255')).startedAt,255);
});

test('opaque file snapshots bound concurrent I/O and preserve byte budget and walk order', async () => {
  const files=['a','b','c','d','directory'].map(file=>path.resolve('/fixture',file));
  const data=Buffer.from('xx');
  let pending=0,peak=0,reads=0;
  const io=(fn)=>async file=>{
    peak=Math.max(peak,++pending);
    await new Promise(resolve=>setImmediate(resolve));
    pending--;
    return fn(file);
  };
  const api=load(['captureFileStats'],{
    path159:path,createHash16:createHash,normalizeMapKey:f=>f,
    collectSourceFilesWithBudgetAsync:async()=>({files}),
    fs109:{promises:{
      stat:io(file=>({size:data.length,mtimeMs:16,isFile:()=>file!==files.at(-1)})),
      readFile:io(()=>{reads++;return data;}),
    }},
  },'var OPAQUE_HASH_BUDGET_BYTES=4,OPAQUE_SCAN_MAX_FILES=2000,OPAQUE_SCAN_BATCH_SIZE=3;');
  const result=await api.captureFileStats('/fixture',{withHashes:true});
  const expected=createHash('sha256').update(data).digest('hex');
  assert.deepEqual([...result.snapshot.keys()],files.slice(0,4));
  assert.deepEqual([...result.snapshot.values()].map(item=>item.hash),[expected,expected,undefined,undefined]);
  assert.equal(reads,2);
  assert.equal(peak,3);
});
