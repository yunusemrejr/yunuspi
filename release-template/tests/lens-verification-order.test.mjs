import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseExpressionAt} from 'acorn';
import {configureDeferredMutationDrain,flushLensBeforeVerification} from '../agent/extensions/pi-lens/context-lsp.mjs';
import {createProjectTestLifecycle,createWorkspaceRevision,projectCheckCommand,checkInvocation} from '../agent/extensions/lib/project-tests.ts';
import {createQualityReviewLifecycle} from '../agent/extensions/lib/quality-review.ts';
import {GuardianSupervisor,tagGuardianRequestMessage} from '../core/coding-agent/dist/core/guardian/guardian-supervisor.js';
import {createReadToolDefinition} from '../core/coding-agent/dist/core/tools/read.js';
import {createEditToolDefinition} from '../core/coding-agent/dist/core/tools/edit.js';

// Exercise the shipped queue owner, drain, format phase and hook callbacks.
// Only external clients and formatter transport are injected; writes are real.
const bundle=fs.readFileSync(new URL('../agent/extensions/pi-lens/dist/index.js',import.meta.url),'utf8');
const checkpoints=fs.readFileSync(new URL('../agent/extensions/checkpoints.ts',import.meta.url),'utf8');
function expression(source,needle,offset=0) {
  const start=source.indexOf(needle)+offset;
  assert.ok(start>=offset,`shipped seam ${needle} exists`);
  const node=parseExpressionAt(source,start,{ecmaVersion:'latest'});
  return source.slice(start,node.end);
}
const functionSource=name=>expression(bundle,`async function ${name}(`);
const callbackCall=expression(bundle,'configureDeferredMutationDrain(ctx, async (');
const callbackNode=parseExpressionAt(callbackCall,0,{ecmaVersion:'latest'}).arguments[1];
const callback=callbackCall.slice(callbackNode.start,callbackNode.end);
const pendingNode=parseExpressionAt(callbackCall,0,{ecmaVersion:'latest'}).arguments[2];
const pendingCallback=callbackCall.slice(pendingNode.start,pendingNode.end);
const nativeHookCall=expression(checkpoints,'pi.on("tool_call", async (event, ctx) =>');
const nativeHookNode=parseExpressionAt(nativeHookCall,0,{ecmaVersion:'latest'}).arguments[1];
const nativeHook=nativeHookCall.slice(nativeHookNode.start,nativeHookNode.end);

function fixture(t,{noFormat=false,autofix=false,failFormat=false,deferredFlush,recentWrite=true,inlineSvg=false,maintained=true,document=false,documentChanged=true}={}) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'lens-verification-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,document?'README.md':'range.js'),order=[];
  fs.writeFileSync(file,'export const value=1;\n');
  let session='owner-1',ambient;
  const abort=new AbortController();
  const ctx={cwd,signal:abort.signal,isIdle:()=>true,sessionManager:{getSessionId:()=>session,getBranch:()=>[]}};
  const environment={fs,nodeFs7:fs,nodeFs8:fs,path152:path,path153:path,path155:path,process,Date,Map,Set,Promise,setImmediate,
    normalizeMapKey:value=>path.resolve(value),pathsEqual:(a,b)=>path.resolve(a)===path.resolve(b),
    BoundedLruCache:class extends Map {constructor(){super();}},TurnSummaryCollector:class{clear(){}},
    TOOL_CALL_ATTRIBUTION_CAPACITY:256,DEFERRED_FORMAT_STALE_AFTER_MS:600000,DEFERRED_FORMAT_CONCURRENCY:3,
    lensWorkState:()=>maintained,__piLensRecentlyWritten:()=>recentWrite,__piLensPreserveInlineSvgOnWrite:()=>inlineSvg,
    recordDegradationOnce(){},logLatency(){},publishFilesTouched(){},publishFormatStart(){},publishAutofixStart(){},
    getAmbientAbortSignal:()=>ambient,setAmbientAbortSignal:value=>{ambient=value;},
    resyncLspFile:async()=>{},getAutofixPolicyForFile:()=>({scope:'file',defaultTool:'biome'}),
    runAutofix:async target=>{order.push('autofix');fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace('value=1','value=2'));return {autofixTools:['biome'],changedFiles:[target]};},
    admitBounded:()=>false,emitBounded(){},lensEnabled:true,probeCtxActive:()=>true,
    flushDebouncedToolResults:async(target,owner)=>{assert.equal(owner,'owner-1');if(deferredFlush)await deferredFlush(target);},
    debouncedPipelines:new Map(),
    classifyOwnedSessionEmission:()=> 'primary',getStableSessionId:context=>context.sessionManager.getSessionId(),
    getLensFlag:name=>name==='no-read-guard'||name==='no-autoformat'&&noFormat,
    getLensFlagSource:()=>undefined,
    notifyUi(){},dbg(){},loadBootstrapClients:async()=>({biomeClient:{},ruffClient:{}}),
  };
  for(const name of ['Eslint','Stylelint','Sqlfluff','Rubocop','Biome','Golangci','Detekt','Oxlint','Ktfmt','Ktlint'])environment[`has${name}Config`]=()=>false;
  environment.PathKeyedMap=vm.runInNewContext(`(${expression(bundle,'PathKeyedMap = class', 'PathKeyedMap = '.length)})`,environment);
  const Runtime=vm.runInNewContext(`(${expression(bundle,'var RuntimeCoordinator = class','var RuntimeCoordinator = '.length)})`,environment);
  const runtime=new Runtime();runtime.projectRoot=cwd;
  runtime.recordProjectMutation=()=>{runtime._projectSeq++;order.push('mutation');};
  const formatService={recordRead(){},async formatFile(target){
    order.push('format');if(failFormat)throw Error('Synthetic configured formatter failure');
    const before=fs.readFileSync(target,'utf8'),after=document ? documentChanged ? before.replace('Use the example.','Use\nthe example.') : before : before.replace(/value=(\d)/,'value = $1');
    fs.writeFileSync(target,after);
    return {anyChanged:before!==after,allSucceeded:true,formatters:[{name:'configured-fixture',success:true,changed:before!==after}]};
  }};
  Object.assign(environment,{runtime,cacheManager:{addModifiedRange(){}},getFormatService:()=>formatService,getFlagSource:undefined});
  environment.recordProjectChange=vm.runInNewContext(`(${expression(bundle,'function recordProjectChange(')})`,environment);
  environment.runFormatPhase=vm.runInNewContext(`(${functionSource('runFormatPhase')})`,environment);
  environment.handleAgentEnd=vm.runInNewContext(`(${functionSource('handleAgentEnd')})`,environment);
  environment.runDeferredMutationDrain=vm.runInNewContext(`(${functionSource('runDeferredMutationDrain')})`,environment);
  const drain=vm.runInNewContext(`(${callback})`,environment);
  const readbackPaths=vm.runInNewContext(`(${pendingCallback})`,environment);
  configureDeferredMutationDrain(ctx,drain,readbackPaths);
  const queue=(target=file,owner='owner-1',origin=cwd)=>{
    runtime.deferFormat(target,cwd,'edit',cwd,owner,origin);
    if(autofix)runtime.deferMutation(target,cwd,'edit',cwd,'autofix',owner,origin);
  };
  return {cwd,file,ctx,runtime,order,abort,queue,drain,readbackPaths,environment,
    settled:()=>environment.runDeferredMutationDrain(ctx),changeSession:value=>{session=value;runtime._sessionGeneration++;}};
}
const event=(name='bash',command='node --test')=>({toolName:name,toolCallId:`${name}-check`,input:{command}});
const readEvent=(input={path:'README.md'})=>({toolName:'read',toolCallId:'readback',input});
async function bounded(pending,label) {
  let timer;
  try {return await Promise.race([pending,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(`Fixture timed out: ${label}`)),5000);})]);}
  finally {clearTimeout(timer);}
}

test('real deferred autofix/format settles before native check capture and stays current through settlement',async t=>{
  const f=fixture(t,{autofix:true}),tools={};
  fs.writeFileSync(f.file,'export const value=0;\n');
  fs.writeFileSync(path.join(f.cwd,'range.test.mjs'),"import assert from 'node:assert/strict'; import {value} from './range.js'; assert.equal(value,2);\n");
  const pi={registerTool:d=>tools[d.name]=d,getActiveTools:()=>['quality_review','project_tests','bash','subagent'],appendEntry(){},on(){}};
  const revisionOwner=createWorkspaceRevision();
  let quality;
  const api=createProjectTestLifecycle(pi,{revision:revisionOwner,onFacts:(facts,observe,token)=>quality?.observe(facts,observe,token)});
  quality=createQualityReviewLifecycle(pi,{revision:revisionOwner,refresh:context=>api.start(context),tests:()=>api.snapshot(),
    runner:async request=>request.aspects.map(aspect=>({aspect:aspect.id,ok:true,text:JSON.stringify({outcome:'pass',evidence:['range.js:1 exports value 2; range.test.mjs:1 verifies that value with the current source.'],findings:[],gap:''})})),
    context:async()=>({graph:'The current fixture contains one exported value and its test.',history:[]})});
  t.after(()=>{quality.shutdown();api.shutdown();});quality.restore(f.ctx);await api.restore(f.ctx);
  const input={source:'interactive',text:'Fix the parser and verify the behavior'};api.input(input);quality.input(input);
  fs.writeFileSync(f.file,'export const value=1;\n');
  await api.result({toolName:'edit',toolCallId:'edit',input:{path:'range.js'},isError:false},f.ctx);
  const hook=vm.runInNewContext(`(${nativeHook})`,{flushLensBeforeVerification,projectCheckCommand,checkInvocation,gateCompletion:()=>undefined,starts:new Map(),mutationVersion:0,batchOf:()=> 'scope',projectTests:api});
  f.queue();
  await hook(event('project_tests'),f.ctx);
  assert.deepEqual(f.order,['autofix','mutation','format','mutation']);
  await tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The focused check exercises the changed parser.',commands:['node --test']},undefined,undefined,f.ctx);
  const check=event();await hook(check,f.ctx);
  const actual=spawnSync(process.execPath,['--test'],{cwd:f.cwd,encoding:'utf8'});
  assert.equal(actual.status,0,actual.stderr+actual.stdout);
  await api.result({...check,isError:false,details:{exitCode:actual.status},content:[{type:'text',text:actual.stdout}]},f.ctx);
  assert.equal(api.snapshot().need,null);
  const before=fs.readFileSync(f.file,'utf8'),tree=api.snapshot().tree,revision=api.snapshot().revision;
  await hook(event('quality_review'),f.ctx);
  await tools.quality_review.execute('review',{action:'review'},undefined,undefined,f.ctx);
  assert.equal(quality.snapshot().status,'awaiting_assessment',JSON.stringify(quality.snapshot()));
  await hook(event('quality_review'),f.ctx);
  await tools.quality_review.execute('accept',{action:'assess',disposition:'accepted',reason:'Current independent report and actual focused test verified the final source.'},undefined,undefined,f.ctx);
  assert.equal(quality.snapshot().status,'accepted');
  await f.settled();await f.settled();await api.start(f.ctx);
  assert.equal(fs.readFileSync(f.file,'utf8'),before,'later settlement cannot rewrite accepted source');
  assert.equal(api.snapshot().tree,tree);assert.equal(api.snapshot().revision,revision);assert.equal(api.snapshot().need,null);
  assert.equal(quality.snapshot().status,'accepted','settlement cannot invalidate accepted independent review');
  assert.equal(f.runtime.pendingDeferredMutationCount,0);
});

test('verification admission preserves owner/workspace fencing and ignores read-only commands',async t=>{
  const f=fixture(t);f.queue();
  await flushLensBeforeVerification(event('bash','cat range.js'),f.ctx);
  await flushLensBeforeVerification(event(),{...f.ctx,sessionManager:{getSessionId:()=> 'owner-1'}});
  await flushLensBeforeVerification(event(),{...f.ctx,cwd:path.dirname(f.cwd)});
  assert.equal(f.order.length,0);assert.equal(f.runtime.pendingDeferredMutationCount,1);
  const foreign=path.join(f.cwd,'foreign.js');fs.writeFileSync(foreign,'export const value=1;');f.queue(foreign,'owner-2',path.dirname(f.cwd));
  await flushLensBeforeVerification(event(),f.ctx);
  assert.match(fs.readFileSync(f.file,'utf8'),/value = 1/);assert.match(fs.readFileSync(foreign,'utf8'),/value=1/);
  assert.equal(f.runtime.pendingDeferredMutationCount,1,'another owner remains queued');
});

test('cancelled or replaced sessions leave deferred work unstarted',async t=>{
  const cancelled=fixture(t);cancelled.queue();cancelled.abort.abort();
  await flushLensBeforeVerification(event(),cancelled.ctx);
  assert.equal(cancelled.order.length,0);assert.equal(cancelled.runtime.pendingDeferredMutationCount,1);
  let release,began;const started=new Promise(resolve=>{began=resolve;});
  const replaced=fixture(t,{deferredFlush:()=>{began();return new Promise(resolve=>{release=resolve;});}});replaced.queue();
  t.after(()=>release?.());
  const pending=flushLensBeforeVerification(event(),replaced.ctx);await bounded(started,'deferred flush startup');
  replaced.changeSession('owner-2');release();const refusal=await pending;
  assert.equal(refusal.block,true,'an old callback cannot start validation in its replacement session');
  assert.equal(replaced.order.length,0);assert.equal(replaced.runtime.pendingDeferredMutationCount,1);
});

test('configured format disablement stays exact and failures block before check capture',async t=>{
  const disabled=fixture(t,{noFormat:true});disabled.queue();
  await flushLensBeforeVerification(event(),disabled.ctx);
  assert.equal(disabled.order.length,0);assert.equal(disabled.runtime.pendingDeferredMutationCount,0);
  const failed=fixture(t,{failFormat:true});failed.queue();
  const block=await flushLensBeforeVerification(event('quality_review'),failed.ctx);
  assert.equal(block.block,true);assert.match(block.reason,/formatter errors/);
  assert.equal(failed.runtime.pendingDeferredMutationCount,1,'a failed formatter remains retryable, never accepted');
});

test('overlapping verification calls join one owned deferred drain',async t=>{
  const f=fixture(t);f.queue();
  await Promise.all([flushLensBeforeVerification(event(),f.ctx),flushLensBeforeVerification(event('quality_review'),f.ctx)]);
  assert.equal(f.order.filter(value=>value==='format').length,1);
  assert.equal(f.runtime.pendingDeferredMutationCount,0);
});

test('a same-session tool result refreshing the adapter cannot replace an in-flight drain',async t=>{
  let release,began,starts=0;const started=new Promise(resolve=>{began=resolve;});
  const f=fixture(t,{deferredFlush:()=>{starts++;began();return new Promise(resolve=>{release=resolve;});}});f.queue();
  t.after(()=>release?.());
  const first=flushLensBeforeVerification(event(),f.ctx);await bounded(started,'shared drain startup');
  configureDeferredMutationDrain(f.ctx,f.drain);
  const second=flushLensBeforeVerification(event('quality_review'),f.ctx);
  release();await Promise.all([first,second]);
  assert.equal(starts,1);assert.equal(f.order.filter(value=>value==='format').length,1);
});

test('a thrown deferred drain refuses verification instead of relying on isolated hook errors',async t=>{
  const f=fixture(t,{deferredFlush:()=>{throw Error('Synthetic debounce failure');}});f.queue();
  const refusal=await flushLensBeforeVerification(event(),f.ctx);
  assert.equal(refusal.block,true);assert.match(refusal.reason,/could not finish/);
  assert.equal(f.runtime.pendingDeferredMutationCount,1);
});

test('native configured check plans flush custom runners before recording their source identity',async t=>{
  const f=fixture(t),tools={};
  const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){}});
  t.after(()=>api.shutdown());await api.restore(f.ctx);api.input({source:'interactive',text:'Verify the declared project check'});
  await tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The configured project runner exercises the changed behavior.',commands:['make test']},undefined,undefined,f.ctx);
  f.queue();
  const hook=vm.runInNewContext(`(${nativeHook})`,{flushLensBeforeVerification,projectCheckCommand,checkInvocation,gateCompletion:()=>undefined,starts:new Map(),mutationVersion:0,batchOf:()=> 'scope',projectTests:api});
  await hook(event('bash','make test'),f.ctx);
  assert.equal(f.order.filter(value=>value==='format').length,1);
  assert.equal(f.runtime.pendingDeferredMutationCount,0);
});

test('the shipped debounce flush leaves another session pending for its own owner',async t=>{
  const queued=new Map(),seen=[];
  for(const owner of ['owner-1','owner-2']) {
    let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});
    const timer=setTimeout(()=>{},30000);t.after(()=>clearTimeout(timer));
    queued.set(owner,{timer,promise,resolve,reject,latestDeps:{sessionId:owner}});
  }
  const flush=vm.runInNewContext(`(${functionSource('flushDebouncedToolResults')})`,{debouncedPipelines:queued,clearTimeout,Promise,
    handleToolResult:async deps=>{seen.push(deps.sessionId);return {};}});
  await flush(undefined,'owner-1');
  assert.deepEqual(seen,['owner-1']);assert.deepEqual([...queued.keys()],['owner-2']);
});

test('verification bypasses only recent-write time debounce while skipped phases retain their contract',async t=>{
  const recent=fixture(t);recent.queue();
  const skipped=await recent.environment.runFormatPhase(recent.file,recent.environment.getFormatService,()=>{});
  assert.deepEqual(Object.keys(skipped).sort(),['fileContent','formatChanged','formatFailures','formattersUsed']);
  assert.equal(skipped.formatChanged,false);assert.equal(skipped.formatFailures.length,0);
  await flushLensBeforeVerification(event(),recent.ctx);
  assert.equal(recent.order.filter(value=>value==='format').length,1,'explicit verification finishes a recent queued write');
  for(const options of [{inlineSvg:true},{maintained:false}]) {
    const safe=fixture(t,options);safe.queue();
    await flushLensBeforeVerification(event(),safe.ctx);
    assert.equal(safe.order.length,0,'SVG and maintained-source safeguards are retained');
    assert.equal(safe.runtime.pendingDeferredMutationCount,0);
  }
  const idle=fixture(t);idle.queue();
  await idle.settled();
  assert.equal(idle.order.length,0,'ordinary settlement retains its existing recent-write debounce');
  assert.equal(idle.runtime.pendingDeferredMutationCount,0,'a skipped phase drains without a malformed-result crash');
});

for (const documentChanged of [false,true]) test(`native Guardian prose readback sees final formatting and retains hash authority: changed=${documentChanged}`,async t=>{
  const f=fixture(t,{document:true,documentChanged}),emitted=[],captured=[];
  fs.writeFileSync(f.file,'Use teh example.\n');
  const prompt='Correct the spelling typo in README.md and finish after reading the file.';
  const guardian=new GuardianSupervisor({sessionId:'owner-1',cwd:f.cwd,emit:notice=>emitted.push(notice),clock:()=>0});
  t.after(()=>guardian.dispose());
  guardian.noteInput({requestId:'request',source:'rpc',originalText:prompt});guardian.acceptRequest('request');
  await guardian.observeAgentEvent({type:'message_start',message:tagGuardianRequestMessage({role:'user',content:[{type:'text',text:prompt}]},{requestId:'request',turnId:'request',sessionId:guardian.sessionId,processId:String(process.pid),guardianOwnerId:guardian.ownerId})});
  const tools={read:createReadToolDefinition(f.cwd),edit:createEditToolDefinition(f.cwd)};
  const hook=vm.runInNewContext(`(${nativeHook})`,{flushLensBeforeVerification,projectCheckCommand,checkInvocation,gateCompletion:()=>undefined,starts:new Map(),mutationVersion:0,batchOf:()=> 'scope',projectTests:{call:async call=>captured.push({name:call.toolName,source:fs.readFileSync(f.file,'utf8')})}});
  let id=0;
  const run=async(name,args)=>{
    const toolCallId=`native-${++id}`;
    await guardian.observeAgentEvent({type:'tool_execution_start',toolName:name,toolCallId,args});
    const refusal=await hook({toolName:name,toolCallId,input:args},f.ctx);assert.equal(refusal,undefined);
    const result=await tools[name].execute(toolCallId,args);
    await guardian.observeAgentEvent({type:'tool_execution_end',toolName:name,toolCallId,result,isError:false});return result;
  };
  await run('read',{path:'README.md'});
  const edit=await run('edit',{path:'README.md',edits:[{oldText:'teh',newText:'the'}]});f.queue();
  const finalRead=await run('read',{path:'README.md'}),before=fs.readFileSync(f.file,'utf8');
  const hash=createHash('sha256').update(before).digest('hex');
  assert.equal(f.runtime.pendingDeferredMutationCount,0,'formatting finishes before native final read');
  assert.equal(captured.at(-1).source,before,'native read boundary sees the formatted source');
  assert.equal(finalRead.details.documentRead.hash,hash,'actual native receipt describes final bytes');
  assert.equal(edit.details.documentMutation.hash===hash,!documentChanged);
  await guardian.observeAgentEvent({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Done. Corrected the typo and read back the file.'}]}});
  assert.equal(emitted.filter(notice=>notice.detail?.kind==='unverified-completion').length,Number(documentChanged),'a formatter hash mismatch still requires validation; it never manufactures a prose exception');
  await f.settled();await f.settled();
  assert.equal(fs.readFileSync(f.file,'utf8'),before,'settlement cannot rewrite readback source');
  assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),finalRead.details.documentRead.hash);
  assert.equal(guardian.handleCommand('/guardian stats').stats.verifications,0,'readback is never a manufactured test pass');
});

test('readback admission is bounded, complete, document-specific and owner-specific',async t=>{
  const f=fixture(t,{document:true});fs.writeFileSync(f.file,'Use the example.\nAnother line.\n');f.queue();
  const other=path.join(f.cwd,'other.js');fs.writeFileSync(other,'export const value=1;');f.queue(other);
  for(const input of [{path:'README.md',offset:2},{path:'README.md',limit:1},{path:'other.js'},{path:'unmodified.md'}]) {
    await flushLensBeforeVerification(readEvent(input),f.ctx);
    assert.equal(f.order.length,0);assert.equal(f.runtime.pendingDeferredMutationCount,2);
  }
  const original=fs.readFileSync(f.file,'utf8');
  for(const oversized of ['x'.repeat(16385),'prose\n'.repeat(201)]) {
    fs.writeFileSync(f.file,oversized);await flushLensBeforeVerification(readEvent(),f.ctx);assert.equal(f.order.length,0);
  }
  fs.writeFileSync(f.file,original);
  await flushLensBeforeVerification(readEvent(),{...f.ctx,sessionManager:{getSessionId:()=> 'owner-1'}});
  assert.equal(f.order.length,0);
  await flushLensBeforeVerification(readEvent({path:'README.md',offset:1,limit:3}),f.ctx);
  assert.equal(f.order.filter(value=>value==='format').length,1);assert.equal(f.runtime.pendingDeferredMutationCount,1,'unrelated queued source is left for its own boundary');
  for(const [owner,origin] of [['foreign',f.cwd],['owner-1',path.dirname(f.cwd)]]) {
    const foreign=fixture(t,{document:true});fs.writeFileSync(foreign.file,'Use the example.\n');foreign.queue(foreign.file,owner,origin);
    await flushLensBeforeVerification(readEvent(),foreign.ctx);assert.equal(foreign.order.length,0);assert.equal(foreign.runtime.pendingDeferredMutationCount,1);
  }
});

test('prose readbacks wait for their own pending debounce and preserve another document queue',async t=>{
  let f,flushed;
  f=fixture(t,{document:true,deferredFlush:target=>{flushed=target;f.environment.debouncedPipelines.delete(target);f.queue(target);}});
  fs.writeFileSync(f.file,'Use the example.\n');
  f.environment.debouncedPipelines.set(f.file,{latestDeps:{sessionId:'owner-1',ctxCwd:f.cwd,event:{toolName:'edit'}}});
  const foreign=path.join(f.cwd,'foreign.md');fs.writeFileSync(foreign,'Use the example.\n');
  f.environment.debouncedPipelines.set(foreign,{latestDeps:{sessionId:'foreign',ctxCwd:f.cwd,event:{toolName:'edit'}}});
  await flushLensBeforeVerification(readEvent({path:'foreign.md'}),f.ctx);assert.equal(flushed,undefined);
  await flushLensBeforeVerification(readEvent(),f.ctx);
  assert.equal(flushed,f.file);assert.equal(f.order.filter(value=>value==='format').length,1);
  assert.equal(f.environment.debouncedPipelines.size,1);assert.equal(f.runtime.pendingDeferredMutationCount,0);
});

test('overlapping readbacks and whole-source checks cover every requested pending document once',async t=>{
  let release,began,first=true;const started=new Promise(resolve=>{began=resolve;});
  const f=fixture(t,{document:true,deferredFlush:()=>{if(!first)return;first=false;began();return new Promise(resolve=>{release=resolve;});}});
  fs.writeFileSync(f.file,'Use the example.\n');f.queue();
  const other=path.join(f.cwd,'other.md');fs.writeFileSync(other,'Use the example.\n');f.queue(other);
  t.after(()=>release?.());
  const a=flushLensBeforeVerification(readEvent(),f.ctx);await bounded(started,'prose debounce startup');
  const same=flushLensBeforeVerification(readEvent(),f.ctx),b=flushLensBeforeVerification(readEvent({path:'other.md'}),f.ctx),check=flushLensBeforeVerification(event(),f.ctx);
  release();await bounded(Promise.all([a,same,b,check]),'overlapping document drains');
  assert.equal(f.order.filter(value=>value==='format').length,2,'neither shared wait nor whole-source check duplicates a document drain');
  assert.equal(f.runtime.pendingDeferredMutationCount,0);
  assert.equal(fs.readFileSync(f.file,'utf8'),'Use\nthe example.\n');assert.equal(fs.readFileSync(other,'utf8'),'Use\nthe example.\n');
});
