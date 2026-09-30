import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';
import { OutputAccumulator } from '../core/coding-agent/dist/core/tools/output-accumulator.js';
import { createBashToolDefinition } from '../core/coding-agent/dist/core/tools/bash.js';
import * as coreGuard from '../core/coding-agent/dist/utils/disk-guard.js';

// A bare ffmpeg `apad` once wrote a 74 GB file and filled the SSD. Every shell
// the agent can start must cap single files and stop runaway disk consumption.
const jiti=createJiti(import.meta.dirname);
const extGuard=await jiti.import('../agent/extensions/lib/disk-guard.ts');
const {runManagedCommand}=await jiti.import('../agent/extensions/managed-bash.ts');
const {BackgroundTaskRegistry}=await jiti.import('../agent/extensions/pi-background-tasks/src/core/registry.ts');

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'disk-guard-'));
process.on('exit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
const context={cwd:scratch,sessionManager:{getSessionId:()=> 'disk-guard',getSessionFile:()=>undefined}};
const MiB=1024**2, GiB=1024**3;
const onPosix={skip:process.platform==='win32'};

function withEnv(vars, fn){
 return async()=>{
  const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
  Object.assign(process.env,vars);
  try{await fn();}finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 };
}

test('core and extension guards agree on defaults, overrides and the ulimit prefix',()=>{
 for(const guard of [coreGuard,extGuard]){
  const env={PI_DISK_BUDGET_GB:undefined,PI_DISK_RESERVE_GB:undefined,PI_MAX_FILE_GB:undefined};
  const saved={...process.env};
  for(const k of Object.keys(env))delete process.env[k];
  try{
   assert.deepEqual(guard.getDiskLimits(),{budgetBytes:40*GiB,reserveBytes:10*GiB,maxFileBytes:32*GiB});
   process.env.PI_MAX_FILE_GB='2';process.env.PI_DISK_BUDGET_GB='nonsense';
   const limits=guard.getDiskLimits();
   assert.equal(limits.budgetBytes,40*GiB,'invalid values fall back to the default');
   assert.equal(guard.fileSizeLimitPrefix(limits),'ulimit -f 2097152 2>/dev/null\n');
   assert.equal(guard.fileSizeLimitPrefix({...limits,maxFileBytes:0}),'','0 disables the file cap');
  }finally{for(const k of Object.keys(env)){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
 }
});

test('watchDisk trips once when a writer exceeds the budget',async()=>{
 for(const guard of [coreGuard,extGuard]){
  const file=path.join(scratch,'watch.bin');
  const reasons=[];
  const stop=guard.watchDisk(scratch,{budgetBytes:8*MiB,reserveBytes:0,maxFileBytes:0},r=>reasons.push(r),20);
  try{
   fs.writeFileSync(file,Buffer.alloc(32*MiB));
   for(let n=0;n<100&&!reasons.length;n++)await new Promise(r=>setTimeout(r,20));
   assert.equal(reasons.length,1);assert.match(reasons[0],/per-command budget/);
  }finally{stop();fs.rmSync(file,{force:true});}
 }
});

test('core bash caps single files and stops a runaway writer',onPosix,withEnv({PI_MAX_FILE_GB:String(1/1024),PI_DISK_BUDGET_GB:'0'},async()=>{
 const tool=createBashToolDefinition(scratch);
 const capped=path.join(scratch,'capped.bin');
 await tool.execute('cap',{command:`ulimit -f; head -c ${4*MiB} /dev/zero > capped.bin; echo exit=$?`},undefined,undefined,context).then(
  r=>assert.match(r.content[0].text,/^1024\n[\s\S]*exit=153/),
  e=>assert.match(e.message,/1024[\s\S]*exit=153/));
 assert.ok(fs.statSync(capped).size<=MiB,'the file stops at the cap');
 fs.rmSync(capped,{force:true});
}));

test('core bash reports a disk guard stop',onPosix,withEnv({PI_MAX_FILE_GB:'0',PI_DISK_BUDGET_GB:String(16/1024)},async()=>{
 const tool=createBashToolDefinition(scratch);
 const started=Date.now();
 await assert.rejects(tool.execute('runaway',{command:`head -c ${64*MiB} /dev/zero > runaway.bin; sleep 20`},undefined,undefined,context),/stopped by disk guard: (command )?consumed/);
 assert.ok(Date.now()-started<10000,'stopped well before the command would finish');
 fs.rmSync(path.join(scratch,'runaway.bin'),{force:true});
}));

test('managed bash caps single files and stops a runaway writer',onPosix,withEnv({PI_MAX_FILE_GB:String(1/1024),PI_DISK_BUDGET_GB:'0'},async()=>{
 // Isolate the file cap from the filesystem-growth guard: other concurrent
 // suite processes share this filesystem and may exceed the tiny test budget.
 const capped=await runManagedCommand(`ulimit -f; head -c ${4*MiB} /dev/zero > m-capped.bin; echo exit=$?`,scratch,30,undefined,Infinity);
 assert.match(capped.output,/^1024\n[\s\S]*exit=153/);
 process.env.PI_MAX_FILE_GB='0';
 process.env.PI_DISK_BUDGET_GB=String(16/1024);
 const started=Date.now();
 await assert.rejects(runManagedCommand(`head -c ${64*MiB} /dev/zero > m-runaway.bin; sleep 20`,scratch,30,undefined,Infinity),/^Error: disk-guard:consumed/);
 assert.ok(Date.now()-started<10000);
 for(const f of ['m-capped.bin','m-runaway.bin'])fs.rmSync(path.join(scratch,f),{force:true});
}));

test('background tasks cap single files and stop a runaway writer',onPosix,async()=>{
 const registry=new BackgroundTaskRegistry({sendCompletionNotification:()=>{},env:{...process.env,SHELL:'/bin/bash',PI_MAX_FILE_GB:'0',PI_DISK_BUDGET_GB:String(16/1024)}});
 try{
  const ctx={cwd:scratch,sessionId:'disk-guard',modelRegistry:{getAll:()=>[]}};
  const task=await registry.startTask(ctx,`head -c ${64*MiB} /dev/zero > bg-runaway.bin; sleep 20`,{name:'runaway',isAgent:false,notifyOnCompletion:false});
  for(let n=0;n<200&&task.status==='running';n++)await new Promise(r=>setTimeout(r,50));
  assert.equal(task.status,'failed');
  assert.equal(task.killKind,'disk_guard');
  assert.match(task.error,/Stopped by disk guard: consumed/);
 }finally{await registry.stopAllRunning?.('shutdown');fs.rmSync(path.join(scratch,'bg-runaway.bin'),{force:true});}
});

test('shell output spill stops at the capture cap and discards the partial file',async()=>{
 const output=new OutputAccumulator({maxBytes:1024,maxCaptureBytes:64*1024});
 for(let n=0;n<32;n++)output.append(Buffer.alloc(4096,0x61));
 output.finish();
 const snap=output.snapshot();
 await output.closeTempFile();
 await new Promise(r=>setTimeout(r,50));
 assert.equal(snap.fullOutputPath,undefined,'a capped capture is never advertised');
 assert.match(snap.captureError,/64 MiB|0\.1 MiB|capture cap/);
 assert.ok(!output.tempFilePath||!fs.existsSync(output.tempFilePath),'the partial spill file is deleted');
});
