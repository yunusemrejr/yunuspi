import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OutputAccumulator } from '../core/coding-agent/dist/core/tools/output-accumulator.js';
import { createBashToolDefinition, createLocalBashOperations } from '../core/coding-agent/dist/core/tools/bash.js';
import { executeBashWithOperations } from '../core/coding-agent/dist/core/bash-executor.js';
import { NodeExecutionEnv } from '../core/agent/src/harness/env/nodejs.js';
import { applyShellOutputUpdate } from '../core/agent/src/harness/utils/output-capture.js';
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

test('head-tail previews enforce both budgets for dense output and retain the full result',async()=>{
 const input=Buffer.from('START\n'+'·\n'.repeat(4000)+'END\n');
 const accumulator=new OutputAccumulator({maxBytes:5120,maxLines:7,outputMode:'head-tail'});
 await accumulator.append(input);
 accumulator.finish();await accumulator.closeTempFile();
 const result=accumulator.snapshot();
 try{
  assert.match(result.content,/^START\n/);
  assert.match(result.content,/middle output omitted/);assert.match(result.content,/\nEND$/);
  assert.equal(result.truncation.outputLines,result.content.split('\n').length);
  assert.ok(result.truncation.outputLines<=7,`${result.truncation.outputLines} lines exceed the preview budget`);
  assert.ok(result.truncation.outputBytes<=5120);
  assert.deepEqual(fs.readFileSync(result.fullOutputPath),input);
 }finally{if(result.fullOutputPath)fs.rmSync(result.fullOutputPath,{force:true});}
});

test('real shell tail keeps evidence from a very long newline-terminated final line',async()=>{
 const tool=createBashToolDefinition(scratch);
 const output='🙂'.repeat(5000)+' LAST DIAGNOSTIC\n';
 const result=await tool.execute('one-line',{command:command("process.stdout.write('🙂'.repeat(5000)+' LAST DIAGNOSTIC\\n')"),maxOutputBytes:256},undefined,undefined,context);
 try{
  assert.match(result.content[0].text,/LAST DIAGNOSTIC/);
  assert.ok(!result.content[0].text.includes('\uFFFD'));
  assert.ok(result.details.truncation.outputBytes<=256);
  assert.equal(result.details.truncation.lastLinePartial,true);
  assert.equal(fs.readFileSync(result.details.fullOutputPath,'utf8'),output);
 }finally{remove(result);}
});

// The child waits for the parent to observe each fragment on its actual pipe
// before writing to the other pipe. No sleep assumes a particular I/O order.
async function interleavedUtf8(run) {
 const dir=fs.mkdtempSync(path.join(scratch,'pipe-utf8-'));
 const glyph=Buffer.from('🧪'), gates=[path.join(dir,'stdout'),path.join(dir,'stderr')];
 const fragments=[Buffer.concat([Buffer.from('x'.repeat(300)+'stdout:'),glyph.subarray(0,2)]),
  Buffer.from('|stderr|'),Buffer.concat([glyph.subarray(2),Buffer.from('|tail'),Buffer.from([0xe2,0x82])])];
 const script=`const fs=require('node:fs'); const waits=${JSON.stringify(gates)};
  const chunks=${JSON.stringify(fragments.map(part=>part.toString('hex')))};
  const observed=file=>new Promise(resolve=>{const timer=setInterval(()=>{
    if(fs.existsSync(file)){clearInterval(timer);resolve();}
  },5);});
  (async()=>{process.stdout.write(Buffer.from(chunks[0],'hex'));await observed(waits[0]);
    process.stderr.write(Buffer.from(chunks[1],'hex'));await observed(waits[1]);
    process.stdout.write(Buffer.from(chunks[2],'hex'));})();`;
 const original=childProcess.spawn;
 childProcess.spawn=(binary,args,options)=>{
  const child=original(binary,args,options);
  if(args.some(arg=>typeof arg==='string'&&arg.includes(gates[0]))) {
   for(const [index,pipe] of [child.stdout,child.stderr].entries()) {
    let bytes=0;
    pipe.on('data',data=>{
     bytes+=data.length;
     if(bytes>=fragments[index].length&&!fs.existsSync(gates[index]))fs.writeFileSync(gates[index],'');
    });
   }
  }
  return child;
 };
 syncBuiltinESMExports();
 try{return {result:await run(command(script)),raw:Buffer.concat(fragments)};}
 finally{childProcess.spawn=original;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true});}
}

test('builtin and managed Bash keep UTF-8 per pipe while preserving raw capture', {timeout:30000}, async()=>{
 const {default:register}=await import('../agent/extensions/managed-bash.ts');
 const registered=new Map();register({registerTool:tool=>registered.set(tool.name,tool),on(){}});
 for(const tool of [createBashToolDefinition(scratch),registered.get('bash')]) {
  const {result,raw}=await interleavedUtf8(input=>tool.execute('mixed-pipes',{command:input,maxOutputBytes:256,timeout:10},undefined,undefined,context));
  try{
   const preview=result.content[0].text.split('\n\n[')[0];
   assert.ok(preview.endsWith('stdout:|stderr|🧪|tail\uFFFD'),JSON.stringify(preview.slice(-75)));
   assert.equal([...preview].filter(c=>c==='\uFFFD').length,1,'only the incomplete EOF suffix is replaced');
   assert.equal(result.details.truncation.outputBytes<=256,true);
   assert.deepEqual(fs.readFileSync(result.details.fullOutputPath),raw);
  }finally{remove(result);}
 }
});

test('managed helper uses the same decoded order and EOF policy', {timeout:15000}, async()=>{
 const {runManagedCommand}=await import('../agent/extensions/managed-bash.ts');
 const {result}=await interleavedUtf8(input=>runManagedCommand(input,scratch,10,undefined,Infinity));
 assert.equal(result.exitCode,0);
 assert.equal(result.output,'x'.repeat(300)+'stdout:|stderr|🧪|tail\uFFFD');
});

test('interactive Bash display and final result keep the same combined text', {timeout:15000}, async()=>{
 const displayed=[];
 const {result}=await interleavedUtf8(input=>executeBashWithOperations(input,scratch,createLocalBashOperations(),{
  signal:AbortSignal.timeout(10000),onChunk:text=>displayed.push(text),
 }));
 assert.equal(result.exitCode,0);
 assert.equal(result.output,'x'.repeat(300)+'stdout:|stderr|🧪|tail\uFFFD');
 assert.equal(displayed.join(''),result.output);
});

test('Node execution environment keeps per-pipe UTF-8 and unchanged raw spill', {timeout:15000}, async()=>{
 let output;
 const env=new NodeExecutionEnv({cwd:scratch});
 const {result,raw}=await interleavedUtf8(input=>env.exec(input,{
  timeout:10,capture:{limits:{maxBytes:256,maxLines:2000,retain:'tail'},spill:true},
  onUpdate(update){output=applyShellOutputUpdate(output,update);},
 },{}));
 assert.equal(result.ok,true);
 try{
  assert.equal(result.value.exitCode,0);
  assert.ok(output.text.endsWith('stdout:|stderr|🧪|tail\uFFFD'));
  assert.ok(output.truncation.outputBytes<=256);
  assert.deepEqual(fs.readFileSync(result.value.spillPath),raw);
 }finally{if(result.value.spillPath)fs.rmSync(result.value.spillPath,{force:true});}
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
  const interactive=await executeBashWithOperations(command("process.stdout.write('x'.repeat(100000)+' END')"),scratch,createLocalBashOperations());
  assert.equal(interactive.exitCode,0);assert.equal(interactive.fullOutputPath,undefined);
  assert.match(interactive.output,/ END\n\n\[Full output unavailable: ENOSPC\]$/);
 }finally{fs.createWriteStream=original;syncBuiltinESMExports();}
});

for (const kind of ['builtin', 'managed', 'interactive']) {
 test(`${kind} Bash Stop releases stalled capture without waiting for the write`, {timeout: 20000}, async () => {
  const original = fs.createWriteStream;
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const flushing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const waitForFlush = kind === 'interactive';
  let capturePath;
  let result;
  let phaseDeadline;

  // The interactive command exits naturally. Stop reaches it during final
  // flush, after the shell backend has already removed its signal listener.
  const script = "process.stdout.write('x'.repeat(100000)+' LAST DIAGNOSTIC\\n');" +
   (waitForFlush ? '' : 'setInterval(()=>{},1000);');
  const input = command(script);
  const {default: register} = await import('../agent/extensions/managed-bash.ts');
  const tools = new Map();
  register({registerTool: tool => tools.set(tool.name, tool), on() {}});
  fs.createWriteStream = (file, options) => {
   capturePath = file;
   fs.writeFileSync(file, 'incomplete spill', {flag: options.flags, mode: options.mode});
   const sink = new Writable({
    highWaterMark: waitForFlush ? 1024 * 1024 : 1,
    write(_chunk, _encoding, callback) {
     started.resolve(this);
     void release.promise.then(() => callback());
    },
    destroy(error, callback) { void release.promise.then(() => callback(error)); },
   });
   queueMicrotask(() => sink.emit('open'));
   const end = sink.end.bind(sink);
   sink.end = (...args) => { flushing.resolve(); return end(...args); };
   return sink;
  };
  syncBuiltinESMExports();
  try {
   const tool = kind === 'managed' ? tools.get('bash') : createBashToolDefinition(scratch);
   const execution = waitForFlush
    ? executeBashWithOperations(input, scratch, createLocalBashOperations(), {signal: controller.signal})
    : tool.execute('blocked-write', {command: input, maxOutputBytes: 1024, timeout: 12}, controller.signal, undefined, context);
   result = execution.then(value => ({value}), error => ({error}));
   const phase = await Promise.race([
    waitForFlush ? flushing.promise : started.promise,
    result.then(outcome => { throw new Error(`Bash exited before capture stalled: ${outcome.error ?? outcome.value}`); }),
   ]);
   assert.equal(fs.existsSync(capturePath), true);
   if (!waitForFlush) assert.equal(phase.writableNeedDrain, true);

   controller.abort();
   phaseDeadline = new AbortController();
   const outcome = await Promise.race([
    result,
    delay(3000, undefined, {signal: phaseDeadline.signal}).then(() => {
     throw new Error('Stop waited for the blocked capture write');
    }),
   ]);
   if (waitForFlush) {
    assert.equal(outcome.value?.cancelled, true);
    assert.equal(outcome.value.fullOutputPath, undefined);
    assert.match(outcome.value.output, /LAST DIAGNOSTIC/);
    assert.match(outcome.value.output, /Full output unavailable: capture cancelled/);
   } else {
    assert.match(outcome.error?.message, /Command aborted/);
    assert.match(outcome.error.message, /x{100}/);
    assert.match(outcome.error.message, /Full output unavailable: capture cancelled/);
    assert.doesNotMatch(outcome.error.message, /Full output: /);
   }
   // The private filename is removed even though the synthetic write and
   // its eventual stream close still cannot finish.
   for (let attempt = 0; attempt < 100 && fs.existsSync(capturePath); attempt++) await delay(20);
   assert.equal(fs.existsSync(capturePath), false);
  } finally {
   phaseDeadline?.abort();
   controller.abort();
   release.resolve();
   await result;
   fs.createWriteStream = original;
   syncBuiltinESMExports();
   if (capturePath) fs.rmSync(capturePath, {force: true});
  }
 });
}

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

test('native completion evidence identifies actual post-hook command and signal exits are errors',async()=>{
 const actual=command("process.stdout.write('checked')"), tool=createBashToolDefinition(scratch,{spawnHook:context=>({...context,command:actual})});
 const result=await tool.execute('provenance',{command:'model-facing command'},undefined,undefined,context);
 assert.deepEqual(result.details.execution,{exitCode:0,cwd:scratch,commandSha256:createHash('sha256').update(actual).digest('hex')});
 assert.equal(result.content[0].text,'checked');
 const killed=createBashToolDefinition(scratch,{operations:{async exec(){return {exitCode:null};}}});
 await assert.rejects(killed.execute('killed',{command:'synthetic killed child'}),/Command terminated by signal/);
 await assert.rejects(createBashToolDefinition(scratch).execute('nonzero',{command:command('process.exit(7)')}),/Command exited with code 7/);
});

test('installed-style managed bash uses bounded capture and preserves both real output streams',async()=>{
 const {default:register}=await import('../agent/extensions/managed-bash.ts');
 const tools=new Map();register({registerTool:tool=>tools.set(tool.name,tool),on(){}});
 const tool=tools.get('bash');
 const result=await tool.execute('managed',{command:command("process.stdout.write('BEGIN\\n'+'x'.repeat(1500000));process.stderr.write('y'.repeat(1500000)+'\\nEND\\n')"),maxOutputBytes:4096,outputMode:'head-tail',timeout:20},undefined,undefined,context);
 try{assert.match(result.content[0].text,/BEGIN/);assert.match(result.content[0].text,/END/);assert.equal(result.details.captureError,undefined);assert.equal(fs.statSync(result.details.fullOutputPath).size,3000011);}finally{remove(result);}
});

test('bash refuses bg_run arguments before running the command',async()=>{
 const {default:register}=await import('../agent/extensions/managed-bash.ts');
 const tools=new Map(),hooks={};register({registerTool:tool=>tools.set(tool.name,tool),on:(name,handler)=>{hooks[name]=handler;}});
 const marker=path.join(scratch,'bg-argument-must-not-run');
 const tool=tools.get('bash');
 // The bash schema keeps bg_run's keys, so the tool_call hook sees them; the
 // runner turns {block:true, reason} into an immediate error without executing.
 const {prepareToolCall}=await import('../core/agent/src/harness/execution/tools.js');
 const args=extra=>{const prepared=prepareToolCall({id:'bg',name:'bash',arguments:{command:`touch ${quote(marker)}`,...extra}},[tool]);assert.ok(prepared.args,'the args reach the tool_call hook unchanged');return prepared.args;};
 for(const extra of [{run_in_background:true,name:'baseline tests',isAgent:false},{background:true},{run_in_background:'true'},{background:'true'}]){
  const blocked=hooks.tool_call({toolName:'bash',input:args(extra)});
  assert.equal(blocked?.block,true);
  assert.equal(blocked.reason,'bash has no run_in_background. Start a long command with bg_run({ command, name }): it returns at once and reports when the command finishes. To keep it in the foreground, pass timeout in seconds.');
  assert.equal(fs.existsSync(marker),false,'the refused call never ran the command');
 }
 assert.equal(hooks.tool_call({toolName:'bash',input:args({})}),undefined,'an ordinary call passes');
 const result=await tool.execute('normal',args({}),undefined,undefined,context);
 assert.equal(result.details.execution.exitCode,0);assert.equal(fs.existsSync(marker),true,'the ordinary call runs');
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
