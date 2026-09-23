import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OutputAccumulator } from '../core/coding-agent/dist/core/tools/output-accumulator.js';
import { createBashToolDefinition, createLocalBashOperations } from '../core/coding-agent/dist/core/tools/bash.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const command=code=>`${quote(process.execPath)} -e ${quote(code)}`;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'shell-output-flow-'));
process.on('exit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
const context={cwd:scratch,sessionManager:{getSessionId:()=> 'output-fixture',getSessionFile:()=>undefined}};
const remove=result=>{const p=result?.details?.fullOutputPath;if(p)fs.rmSync(p,{force:true});};

test('real shell output keeps beginning/end within budget and exact private UTF-8 artifact',async()=>{
 const tool=createBashToolDefinition(scratch);
 const text='BEGIN important failure\n'+('ç🙂 line\n'.repeat(15000))+'END final summary\n';
 const fixture=path.join(scratch,'source.txt');fs.writeFileSync(fixture,text);
 const result=await tool.execute('flow',{command:command(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}))`),maxOutputBytes:2048,outputMode:'head-tail'},undefined,undefined,context);
 try{
  assert.match(result.content[0].text,/BEGIN important failure/);assert.match(result.content[0].text,/END final summary/);
  assert.match(result.content[0].text,/middle output omitted/);assert.ok(!result.content[0].text.includes('\uFFFD'));
  assert.ok(result.details.truncation.outputBytes<=2048);assert.equal(result.details.truncation.totalBytes,Buffer.byteLength(text));
  assert.equal(fs.readFileSync(result.details.fullOutputPath,'utf8'),text);
  assert.equal(fs.statSync(result.details.fullOutputPath).mode&0o777,0o600);
 }finally{remove(result);}
});

test('slow capture pauses real stdout/stderr and does not drop buffered output after exit',async()=>{
 const original=fs.createWriteStream;let queued=0,peak=0;const chunks=[];
 class SlowCapture extends Writable{constructor(){super({highWaterMark:1024});} _write(chunk,enc,cb){queued+=chunk.length;peak=Math.max(peak,this.writableLength);setTimeout(()=>{chunks.push(Buffer.from(chunk));queued-=chunk.length;cb();},125);}}
 fs.createWriteStream=()=>new SlowCapture();syncBuiltinESMExports();
 try{
  const output=new OutputAccumulator({maxBytes:1024});let delivered=0;
  const result=await createLocalBashOperations().exec(command(`process.stdout.write('a'.repeat(200000));process.stderr.write('b'.repeat(200000));`),scratch,{onData:data=>{delivered+=data.length;return output.append(data);},timeout:10});
  output.finish();await output.closeTempFile();
  assert.equal(result.exitCode,0);assert.equal(delivered,400000);assert.equal(Buffer.concat(chunks).length,400000);
  assert.equal(queued,0);assert.ok(peak<256*1024,`queued ${peak} bytes`);assert.equal(output.snapshot().captureError,undefined);
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();}
});

test('capture disk failure stays explicit without crashing, hanging or claiming a full artifact',async()=>{
 const original=fs.createWriteStream;
 fs.createWriteStream=()=>new Writable({highWaterMark:1024,write(_chunk,_enc,cb){setImmediate(()=>cb(Object.assign(new Error('disk full'),{code:'ENOSPC'})));}});syncBuiltinESMExports();
 try{
  const tool=createBashToolDefinition(scratch);
  const result=await tool.execute('disk',{command:command("process.stdout.write('x'.repeat(100000))"),maxOutputBytes:1024},undefined,undefined,context);
  assert.match(result.content[0].text,/Full output unavailable: ENOSPC/);
  assert.equal(result.details.fullOutputPath,undefined);assert.match(result.details.captureError,/ENOSPC/);
  assert.ok(!result.content[0].text.includes('Full output: undefined'));
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();}
});

test('legacy producers ignoring backpressure cannot grow the capture queue indefinitely',async()=>{
 const original=fs.createWriteStream;let sink;
 fs.createWriteStream=()=>sink=new Writable({write(_chunk,_enc,cb){setTimeout(cb,10);}});syncBuiltinESMExports();
 try{
  const output=new OutputAccumulator({maxBytes:1024});const pending=[];
  for(let n=0;n<160;n++){const p=output.append(Buffer.alloc(65536,97));if(p)pending.push(p);}
  output.finish();await output.closeTempFile();await Promise.all(pending);
  assert.match(output.snapshot().captureError,/backpressure/);assert.equal(output.snapshot().fullOutputPath,undefined);
  assert.ok(sink.writableLength<=2*1024*1024);assert.ok(output.snapshot().truncation.outputBytes<=1024);
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();}
});

test('output controls validate before launching and old default tail semantics remain',async()=>{
 let starts=0;const tool=createBashToolDefinition(scratch,{operations:{async exec(_cmd,_cwd,{onData}){starts++;await onData(Buffer.from('first\nlast\n'));return{exitCode:0};}}});
 for(const args of [{maxOutputBytes:0},{maxOutputBytes:1024.5},{maxOutputBytes:Infinity},{outputMode:'unknown'}]) await assert.rejects(tool.execute('bad',{command:'unused',...args}),/maxOutputBytes|outputMode/);
 assert.equal(starts,0);const result=await tool.execute('ok',{command:'unused'});assert.equal(result.content[0].text,'first\nlast\n');assert.equal(starts,1);
});

test('installed-style managed bash uses bounded capture and preserves both real output streams',async()=>{
 const {default:register}=await import('../agent/extensions/managed-bash.ts');
 const tools=new Map();register({registerTool:tool=>tools.set(tool.name,tool),on(){}});
 const tool=tools.get('bash');
 const result=await tool.execute('managed',{command:command("process.stdout.write('BEGIN\\n'+'x'.repeat(1500000));process.stderr.write('y'.repeat(1500000)+'\\nEND\\n')"),maxOutputBytes:4096,outputMode:'head-tail',timeout:20},undefined,undefined,context);
 try{assert.match(result.content[0].text,/BEGIN/);assert.match(result.content[0].text,/END/);assert.equal(result.details.captureError,undefined);assert.equal(fs.statSync(result.details.fullOutputPath).size,3000011);}finally{remove(result);}
});

test('abort during asynchronous cwd admission prevents core and managed shell spawn',async()=>{
 const {default:register}=await import('../agent/extensions/managed-bash.ts');
 const tools=new Map();register({registerTool:tool=>tools.set(tool.name,tool),on(){}});
 const originalAccess=fs.promises.access,originalSpawn=childProcess.spawn;
 try{
  for(const kind of ['core','managed']){
   const controller=new AbortController();let spawns=0;
   fs.promises.access=async(...args)=>{await originalAccess(...args);controller.abort();};
   childProcess.spawn=()=>{spawns++;throw new Error('SPAWNED_AFTER_ABORT');};syncBuiltinESMExports();
   if(kind==='core')await assert.rejects(createLocalBashOperations().exec('unused',scratch,{onData(){},signal:controller.signal}),/aborted/i);
   else await assert.rejects(tools.get('bash').execute('cancel',{command:'unused'},controller.signal,undefined,context),/aborted/i);
   assert.equal(spawns,0,`${kind} does not spawn after stop while checking cwd`);
  }
 }finally{fs.promises.access=originalAccess;childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
});

test('exclusive capture open failure never deletes a file this accumulator did not create',async()=>{
 const original=fs.createWriteStream;let collision;
 fs.createWriteStream=(file,options)=>{collision=file;fs.writeFileSync(file,'pre-existing capture fixture',{flag:'wx'});return original(file,options);};syncBuiltinESMExports();
 try{
  const output=new OutputAccumulator({maxBytes:1024});await output.append(Buffer.alloc(2048,97));output.finish();await output.closeTempFile();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(output.snapshot().captureError,/EEXIST/);
  assert.equal(output.snapshot().fullOutputPath,undefined);
  assert.equal(fs.readFileSync(collision,'utf8'),'pre-existing capture fixture');
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();if(collision)fs.rmSync(collision,{force:true});}
});
