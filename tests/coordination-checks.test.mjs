import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createBashToolDefinition} from '../core/coding-agent/src/core/tools/bash.js';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {emitSessionShutdownEvent} from '../core/coding-agent/src/core/extensions/runner.js';

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'coordination-checks-'));
const oldHome=process.env.HOME;process.env.HOME=scratch;
const {default:coordinate}=await import('../agent/extensions/siblings.ts');
if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
process.on('exit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
const command=code=>`${quote(process.execPath)} -e ${quote(code)}`;
const sha=text=>createHash('sha256').update(text).digest('hex');

function fixture(cwd,id){
 const hooks=new Map(),tools=new Map(),entries=[],bus=new EventEmitter();
 coordinate({on:(name,fn)=>hooks.set(name,fn),registerTool:tool=>tools.set(tool.name,tool),sendMessage(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),events:{on:(name,fn)=>{bus.on(name,fn);return()=>bus.off(name,fn);}}});
 const ctx={cwd,sessionManager:{getSessionId:()=>id,getSessionFile:()=>undefined,getBranch:()=>entries}};
 const fire=(name,event={})=>hooks.get(name)?.(event,ctx);
 const invoke=(input)=>tools.get('session_coordinate').execute('coordinate',input,undefined,undefined,ctx);
 return {ctx,fire,invoke,entries,status:async()=>(await invoke({})).details,prepare:(cmd,files=['source.js'])=>invoke({action:'prepare_check',checkName:'Fixture check',command:cmd,files})};
}
async function runObserved(session,cmd,id='native-check',options){
 const event={toolName:'bash',toolCallId:id,input:{command:cmd}};
 await session.fire('tool_call',event);
 let result,isError=false;
 try{result=await createBashToolDefinition(session.ctx.cwd,options).execute(id,event.input,undefined,undefined,session.ctx);}
 catch(error){result={content:[{type:'text',text:error.message}]};isError=true;}
 await session.fire('tool_result',{...event,...result,isError});return {result,isError};
}

test('native check receipts share current source evidence without executing or copying command output',async()=>{
 const cwd=fs.mkdtempSync(path.join(scratch,'peers-'));fs.writeFileSync(path.join(cwd,'source.js'),'export const value = 1;');
 const a=fixture(cwd,'alpha'),b=fixture(cwd,'bravo');await a.fire('session_start');await b.fire('session_start');
 try{
  const cmd=command("process.stdout.write('check evidence')");
  assert.equal((await a.prepare(cmd)).details.prepared,true);
  assert.equal((await b.status()).peers[0].coordination.checks,undefined,'preparing is not execution evidence');
  const {result,isError}=await runObserved(a,cmd);assert.equal(isError,false);assert.equal(result.details.execution.exitCode,0);
  const peer=(await b.status()).peers[0],receipt=peer.coordination.checks[0];
  assert.equal(peer.sid,'alpha');assert.equal(receipt.sessionId,'alpha');assert.equal(receipt.toolCallId,'native-check');
  assert.equal(receipt.outcome,'exit-zero');assert.equal(receipt.sourceStatus,'current');assert.equal(receipt.commandSha256,sha(cmd));
  assert.ok(!JSON.stringify(receipt).includes('check evidence'),'receipt references canonical execution without copying payload');
  const response=await b.invoke({}),summary=JSON.parse(response.content[0].text);
  assert.deepEqual(summary.peers[0].coordination.checks[0].sources,['source.js']);
  assert.ok(response.content[0].text.length<JSON.stringify(response.details).length-64,'provider context omits digests while durable details retain them');
  fs.writeFileSync(path.join(cwd,'source.js'),'export const value = 2;');
  assert.equal((await b.status()).peers[0].coordination.checks[0].sourceStatus,'changed');
  assert.match((await b.status()).policy,/required checks still apply/i);
 }finally{await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('source changes during a check and spawn-hook rewrites cannot certify prepared inputs',async()=>{
 const cwd=fs.mkdtempSync(path.join(scratch,'changes-')),file=path.join(cwd,'source.js');fs.writeFileSync(file,'initial');
 const session=fixture(cwd,'changes');await session.fire('session_start');
 try{
  await session.prepare('fixture');
  await runObserved(session,'fixture','changed',{operations:{async exec(){fs.writeFileSync(file,'changed during check');return{exitCode:0};}}});
  let receipt=(await session.status()).coordination.checks.at(-1);
  assert.equal(receipt.outcome,'exit-zero');assert.equal(receipt.snapshotsMatch,false);assert.equal(receipt.sourceStatus,'changed');
  await session.prepare('original');
  await runObserved(session,'original','rewritten',{spawnHook:ctx=>({...ctx,command:'rewritten'}),operations:{async exec(){return{exitCode:0};}}});
  receipt=(await session.status()).coordination.checks.at(-1);assert.equal(receipt.outcome,'unverified');
  await session.prepare('no native evidence');
  await session.fire('tool_call',{toolName:'bash',toolCallId:'missing',input:{command:'no native evidence'}});
  await session.fire('tool_result',{toolName:'bash',toolCallId:'missing',input:{command:'no native evidence'},isError:false,content:[{type:'text',text:'PASSED 100 tests; exit 0'}]});
  assert.equal((await session.status()).coordination.checks.at(-1).outcome,'unverified','text claims never substitute for native exit provenance');
 }finally{await session.fire('session_shutdown');}
});

test('check preparation fences cancellation, session changes, mismatched commands and unsupported inputs',async()=>{
 const cwd=fs.mkdtempSync(path.join(scratch,'fences-'));fs.writeFileSync(path.join(cwd,'source.js'),'initial');
 const session=fixture(cwd,'fences');await session.fire('session_start');
 try{
  assert.equal((await session.prepare('unused',['.'])).isError,true);
  assert.equal((await session.prepare('unused', ['../outside.js'])).isError,true);
  for(const field of ['checks','recentWrites','plan']){
   const forged=await session.invoke({action:'publish',[field]:field==='checks'?[{toolCallId:'invented',outcome:'exit-zero'}]:{}});
   assert.equal(forged.isError,true);assert.equal((await session.status()).coordination.checks,undefined);
  }
  for(const transition of ['input','session_start','session_shutdown']){
   await session.prepare('fixture');
   await session.fire('tool_call',{toolName:'bash',toolCallId:transition,input:{command:'fixture'}});
   await session.fire(transition,{source:'rpc'});
   await session.fire('tool_result',{toolName:'bash',toolCallId:transition,isError:false,details:{execution:{exitCode:0,cwd,commandSha256:sha('fixture')}}});
   assert.equal((await session.status()).coordination.checks,undefined,transition);
  }
  await session.prepare('expected');await runObserved(session,'different','different',{operations:{async exec(){return{exitCode:0};}}});
  assert.equal((await session.status()).coordination.checks,undefined);
  assert.equal((await session.status()).preparedCheck,undefined);
  await session.prepare('blocked');await session.fire('tool_call',{toolName:'bash',toolCallId:'blocked',input:{command:'blocked'}});
  await session.fire('tool_result',{toolName:'bash',toolCallId:'blocked',isError:true,content:[{type:'text',text:'Blocked by existing safety policy'}]});
  assert.equal((await session.status()).coordination.checks.at(-1).outcome,'error');
  for(let index=0;index<6;index++){await session.prepare(`check ${index}`);await runObserved(session,`check ${index}`,`bounded-${index}`,{operations:{async exec(){return{exitCode:0};}}});}
  assert.equal((await session.status()).coordination.checks.length,4);assert.ok(JSON.stringify(await session.status()).length<16000);
 }finally{await session.fire('session_shutdown');}
});

test('check cwd aliases are canonical while changed execution directories remain unverified',async()=>{
 const cwd=fs.mkdtempSync(path.join(scratch,'alias-')),alias=cwd+'-link';fs.symlinkSync(cwd,alias);fs.writeFileSync(path.join(cwd,'source.js'),'initial');
 const session=fixture(alias,'alias');await session.fire('session_start');
 try{
  const cmd=command("process.stdout.write('verified alias')");await session.prepare(cmd);await runObserved(session,cmd);
  assert.equal((await session.status()).coordination.checks[0].outcome,'exit-zero');
  await session.prepare('different cwd');await runObserved(session,'different cwd','elsewhere',{spawnHook:context=>({...context,cwd:scratch}),operations:{async exec(){return{exitCode:0};}}});
  assert.equal((await session.status()).coordination.checks.at(-1).outcome,'unverified');
 }finally{await session.fire('session_shutdown');}
});

test('real SDK prepares, runs normal native bash and publishes the canonical execution receipt',async()=>{
 const cwd=fs.mkdtempSync(path.join(scratch,'sdk-'));fs.writeFileSync(path.join(cwd,'source.js'),'export const value = 1;');
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
 const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[coordinate,pi=>pi.on('tool_call',event=>event.toolName==='bash'&&event.toolCallId==='call-3'?{block:true,reason:'Fixture native safety block'}:undefined)]});
 let session;
 try{
  await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  const model={id:'coordination-fixture',name:'Fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000};
  const cmd=command("const fs=require('fs');if(!fs.readFileSync('source.js','utf8').includes('value = 1'))process.exit(1);process.stdout.write('verified fixture');");
  const plans=[
   {name:'session_coordinate',arguments:{action:'publish',checks:[{toolCallId:'forged',outcome:'exit-zero'}]}},
   {name:'session_coordinate',arguments:{action:'prepare_check',checkName:'Blocked fixture',command:cmd,files:['source.js']}},
   {name:'bash',arguments:{command:cmd}},
   {name:'session_coordinate',arguments:{action:'prepare_check',checkName:'Source fixture',command:cmd,files:['source.js']}},
   {name:'bash',arguments:{command:cmd}},
   {name:'session_coordinate',arguments:{action:'status'}},
  ];
  let turns=0;const errors=[];
  const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),streamSimple(){
   const plan=plans[turns++],content=plan?[{type:'toolCall',id:`call-${turns}`,...plan}]:[{type:'text',text:'Complete.'}];
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:plan?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
   return{async *[Symbol.asyncIterator](){yield{type:'done',reason:message.stopReason,message};},result:async()=>message};
  }};
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),tools:['bash','session_coordinate'],thinkingLevel:'off'}));
  await session.bindExtensions({onError:error=>errors.push(error)});await session.prompt('Verify the synthetic source fixture.',{source:'rpc'});
  assert.deepEqual(errors,[]);assert.equal(turns,7,'receipt publication causes no additional inference turn');
  const results=new Map(session.messages.filter(message=>message.role==='toolResult').map(message=>[message.toolCallId,message]));
  assert.equal(results.get('call-1').isError,true,'undeclared receipt injection is rejected by the native schema');
  assert.equal(results.get('call-3').isError,true,'native safety block remains authoritative');
  assert.equal(results.get('call-4').isError,false,'blocked check cannot leave preparation stuck running');
  assert.equal(results.get('call-5').details.execution.exitCode,0);
  const receipts=results.get('call-6').details.coordination.checks;assert.equal(receipts.length,2,'terminal fallback and normal completion each publish once');
  assert.equal(receipts[0].toolCallId,'call-3');assert.equal(receipts[0].outcome,'error');
  const receipt=receipts[1];assert.equal(receipt.toolCallId,'call-5');assert.equal(receipt.outcome,'exit-zero');assert.equal(receipt.sourceStatus,'current');
  assert.equal(receipt.sessionId,session.sessionManager.getSessionId());
 }finally{if(session){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}}
});
