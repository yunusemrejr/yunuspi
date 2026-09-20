import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/continuation-notice.ts')));
const {CONTINUATION_SOURCES,registerContinuationSource}=await import(pathToFileURL(path.join(agent,'extensions/lib/continuation-notice.ts')));
const {default:extension}=await import(pathToFileURL(path.join(agent,'extensions/continuation-notice.ts')));
const {registerSubagentContinuation}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/extension/continuation-notice.ts')));
const schema='data:text/javascript,'+encodeURIComponent('export const Type=new Proxy({}, {get:()=>()=>({})});');
register('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`),import.meta.url);
const {createProjectTestLifecycle}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-tests.ts')));
const {createQualityReviewLifecycle}=await import(pathToFileURL(path.join(agent,'extensions/lib/quality-review.ts')));
const {collectVerificationLines}=await import(pathToFileURL(path.join(agent,'extensions/lib/continuation-notice.ts')));

test('settled blocked verification remains visible on each final without waking the model',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  let blocked=true;const hooks={};
  registerContinuationSource({name:'project tests',pending:()=>[],verification:()=>blocked?['Live window pixels could not be verified.']:[]});
  extension({on:(name,fn)=>hooks[name]=fn});hooks.session_start();
  const event={message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'The app is ready.'}]}};
  const ctx={hasPendingMessages:()=>false};
  for(let i=0;i<2;i++) {
   const result=hooks.message_end(event,ctx),text=result.message.content.map(x=>x.text).join('\n');
   assert.match(text,/Verification incomplete/);assert.match(text,/Live window pixels/);
   assert.ok(!text.includes('will keep running'),'blocked verification creates no continuation promise');
  }
  blocked=false;assert.equal(hooks.message_end(event,ctx),undefined);
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

test('pi-lens warnings refer callers to the diagnostic owner instead of an absent cache file',()=>{
 const source=fs.readFileSync(path.join(agent,'extensions/pi-lens/dist/index.js'),'utf8');
 const match=/function formatCodeQualityWarningsAdvisory\(report\) \{[\s\S]*?\n\}/.exec(source);
 assert.ok(match);
 const format=new Function(`${match[0]}; return formatCodeQualityWarningsAdvisory;`)();
 const text=format({summary:{warnings:1,files:1,topRules:[]}});
 assert.match(text,/lens_diagnostics\(\{mode:"delta"\}\)/);
 assert.ok(!text.includes('.pi-lens/cache/'));
});

test('both premature finals expose active delegated work and the notice clears on native completion',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  const sessionManager={},hooks={};
  const state={currentSessionId:'session-a',asyncJobs:new Map([
   ['audit',{sessionId:'session-a',status:'running'}],
   ['done',{sessionId:'session-a',status:'complete'}],
   ['other',{sessionId:'session-b',status:'running'}],
  ])};
  registerSubagentContinuation(state,sessionManager);
  extension({on:(name,fn)=>hooks[name]=fn});hooks.session_start();
  const event={message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Complete and verified.'}]}};
  const ctx={sessionManager,hasPendingMessages:()=>false};
  for(let i=0;i<2;i++) {
   const text=hooks.message_end(event,ctx).message.content.map(x=>x.text).join('\n');
   assert.match(text,/Verification incomplete/);
   assert.match(text,/1 delegated run has not finished/);
   assert.match(text,/cannot support a completed or verified claim/);
   assert.equal(text.includes('Continuation pending'),i===0,'continuation announcement stays deduplicated');
  }
  state.asyncJobs.get('audit').status='complete';
  assert.equal(hooks.message_end(event,ctx),undefined,'completed jobs cannot leave a stale pending notice');
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

test('native child notices isolate concurrent sessions, switches, and replaced runtime cleanup',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  const firstSession={},secondSession={},hooks={};
  const first={currentSessionId:'session-a',asyncJobs:new Map([['a',{sessionId:'session-a',status:'queued'}]])};
  const second={currentSessionId:'session-b',asyncJobs:new Map([['b',{sessionId:'session-b',status:'running'}],['c',{sessionId:'session-b',status:'running'}]])};
  const disposeFirst=registerSubagentContinuation(first,firstSession);
  const disposeSecond=registerSubagentContinuation(second,secondSession);
  extension({on:(name,fn)=>hooks[name]=fn});hooks.session_start();
  const event={message:{role:'assistant',stopReason:'stop',content:'Done.'}};
  const final=sessionManager=>hooks.message_end(event,{sessionManager,hasPendingMessages:()=>false})?.message.content;
  assert.match(final(firstSession),/1 delegated run/);
  assert.match(final(secondSession),/2 delegated run/);
  assert.equal(final({}),undefined,'another SDK session must not inherit pending jobs');
  first.currentSessionId='session-c';
  assert.equal(final(firstSession),undefined,'old jobs do not cross a switched session identity');
  const replacement={currentSessionId:'session-a',asyncJobs:new Map([['new',{sessionId:'session-a',status:'running'}]])};
  const disposeReplacement=registerSubagentContinuation(replacement,firstSession);
  disposeFirst();
  assert.match(final(firstSession),/1 delegated run/,'old runtime cleanup cannot remove its replacement');
  replacement.currentSessionId=null;
  assert.equal(final(firstSession),undefined,'inactive runtime has no jobs in scope');
  disposeReplacement();disposeSecond();
  assert.equal(final(secondSession),undefined);
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

test('real test and review lifecycle notices remain owned by their SDK session across restore and shutdown',async()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 const fixtures=[];
 try {
  const fixture=async(label,existing)=>{
   const ctx=existing??{cwd:fs.mkdtempSync(path.join(os.tmpdir(),'completion-scope-')),sessionManager:{getBranch:()=>[]}};
   const tools={},pi={registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','quality_review','bash'],appendEntry(){}};
   const tests=createProjectTestLifecycle(pi),review=createQualityReviewLifecycle(pi,{refresh:async()=>{},tests:()=>tests.snapshot()});
   const f={ctx,tests,review,ownsDirectory:!existing};fixtures.push(f);
   f.restore=async(context)=>{f.ctx=context;await tests.restore(context);review.restore(context);};
   f.block=async(reason)=>{
    tests.input({source:'interactive',text:'Fix the application'});review.input({source:'interactive',text:'Fix the application'});
    fs.writeFileSync(path.join(f.ctx.cwd,'app.js'),`export const state=${JSON.stringify(reason)};`);
    const event={toolName:'write',toolCallId:'write',input:{path:'app.js'},isError:false};
    await tests.result(event,f.ctx);review.result(event,f.ctx);
    for(const tool of ['project_tests','quality_review'])await tools[tool].execute('assess',{action:'assess',disposition:'blocked',reason:`${reason}: verification requires unavailable runtime evidence.`},undefined,undefined,f.ctx);
   };
   await f.restore(ctx);await f.block(label);return f;
  };
  const left=await fixture('left session'),right=await fixture('right session');
  const lines=f=>collectVerificationLines(10,f.ctx.sessionManager).join('\n');
  for(const [own,other,label] of [[left,right,'left session'],[right,left,'right session']]){
   assert.match(lines(own),new RegExp(`project tests: Blocked: ${label}`));
   assert.match(lines(own),new RegExp(`quality review: Independent review blocked: ${label}`));
   assert.notEqual(lines(own),lines(other),'concurrent lifecycle registration cannot overwrite another session');
  }
  const oldSession=left.ctx.sessionManager;
  await left.restore({...left.ctx,sessionManager:{getBranch:()=>[]}});await left.block('switched session');
  assert.deepEqual(collectVerificationLines(10,oldSession),[]);
  assert.match(lines(left),/switched session/);
  const replacement=await fixture('replacement session',right.ctx);
  right.tests.shutdown();right.review.shutdown();
  assert.match(lines(replacement),/replacement session/,'old lifecycle shutdown must retain its replacement');
  replacement.tests.shutdown();replacement.review.shutdown();
  assert.deepEqual(collectVerificationLines(10,right.ctx.sessionManager),[]);
  assert.match(lines(left),/switched session/);
 } finally {
  for(const f of fixtures){f.tests.shutdown();f.review.shutdown();if(f.ownsDirectory)fs.rmSync(f.ctx.cwd,{recursive:true,force:true});}
  globalThis[CONTINUATION_SOURCES]=previous;
 }
});
