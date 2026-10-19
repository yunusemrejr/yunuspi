import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
