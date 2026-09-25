import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {register} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(rootDir,'agent'),path.resolve(rootDir,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/background/async-status.ts')));
register('data:text/javascript,'+encodeURIComponent(`import fs from 'node:fs';export function resolve(n,c,next){if(n.startsWith('.')&&n.endsWith('.js')){const u=new URL(n.slice(0,-3)+'.ts',c.parentURL);if(fs.existsSync(u))return next(u.href,c);}return next(n,c);}`),import.meta.url);
const bg=p=>pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/background',p)).href;
const {describeAvailableAsyncRuns}=await import(bg('async-status.ts'));
const {updateActiveRunIndex}=await import(bg('active-run-index.ts'));
const {updateTerminalRunIndex}=await import(bg('terminal-run-index.ts'));
const {inspectSubagentStatus}=await import(bg('run-status.ts'));
const {resolveAsyncResumeTarget}=await import(bg('async-resume.ts'));
const {registerSubagentRpcBridge,SUBAGENT_RPC_REQUEST_EVENT,SUBAGENT_RPC_PROTOCOL_VERSION,subagentRpcReplyEvent}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/extension/rpc.ts')).href);

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'run-notfound-'));
 const asyncDirRoot=path.join(root,'async'); fs.mkdirSync(asyncDirRoot,{recursive:true});
 const resultsDir=path.join(root,'results'); fs.mkdirSync(resultsDir,{recursive:true});
 const now=Date.now();
 const live={runId:'run-live-alpha',state:'running',sessionId:'sess-1',startedAt:now-10000,lastUpdate:now,steps:[]};
 const liveDir=path.join(asyncDirRoot,live.runId); fs.mkdirSync(liveDir);
 fs.writeFileSync(path.join(liveDir,'status.json'),JSON.stringify(live));
 updateActiveRunIndex(liveDir,'running');
 const done={runId:'run-done-beta',state:'complete',sessionId:'sess-1',startedAt:now-20000,lastUpdate:now-5000,endedAt:now-5000,steps:[]};
 const doneDir=path.join(asyncDirRoot,done.runId); fs.mkdirSync(doneDir);
 fs.writeFileSync(path.join(doneDir,'status.json'),JSON.stringify(done));
 updateTerminalRunIndex(doneDir,done);
 return {root,asyncDirRoot,resultsDir};
}

test('run hint lists live runs first with states, names emptiness honestly',()=>{
 const {asyncDirRoot,root}=fixture();
 const hint=describeAvailableAsyncRuns(asyncDirRoot);
 assert.match(hint,/Known runs: .*run-live-alpha \(running\).*run-done-beta \(complete\)/);
 assert.ok(hint.indexOf('run-live-alpha')<hint.indexOf('run-done-beta'),'live runs sort first');
 assert.equal(describeAvailableAsyncRuns(path.join(root,'missing-root')),'No async runs are known in this registry.');
 assert.equal(describeAvailableAsyncRuns(asyncDirRoot,{sessionId:'other-session'}),'No async runs are known in this registry.');
 assert.match(describeAvailableAsyncRuns(asyncDirRoot,{states:['complete']}),/run-done-beta \(complete\)/);
 assert.doesNotMatch(describeAvailableAsyncRuns(asyncDirRoot,{states:['complete']}),/run-live-alpha/);
});

test('status for an unknown id names the target and the known runs',()=>{
 const {asyncDirRoot,resultsDir}=fixture();
 const result=inspectSubagentStatus({id:'run-missing-gamma'},{asyncDirRoot,resultsDir,state:{currentSessionId:'sess-1',foregroundControls:new Map(),asyncJobs:new Map(),foregroundRuns:new Map()}});
 assert.equal(result.isError,true);
 const text=result.content.map(part=>part.text??'').join('\n');
 assert.match(text,/Async run not found\. No live or retained run matches 'run-missing-gamma'\./);
 assert.match(text,/Known runs: .*run-live-alpha \(running\)/);
 assert.match(text,/Provide id or dir\./);
});

test('resume for an unknown id throws the same recovery hint',()=>{
 const {asyncDirRoot,resultsDir}=fixture();
 assert.throws(()=>resolveAsyncResumeTarget({id:'run-missing-gamma'},{asyncDirRoot,resultsDir}),/Async run not found\. No live or retained run matches 'run-missing-gamma'\..*Known runs: .*run-live-alpha \(running\)/);
});

test('rpc stop for an unknown id replies with live runs only',async()=>{
 const {asyncDirRoot,resultsDir}=fixture();
 const events=new EventEmitter();
 const ctx={sessionManager:{getSessionFile:()=>null,getSessionId:()=>'sess-1'}};
 const bridge=registerSubagentRpcBridge({events,asyncDirRoot,resultsDir,state:{},getContext:()=>ctx});
 try{
  const reply=await new Promise(resolve=>{
   events.once(subagentRpcReplyEvent('req-stop-1'),resolve);
   events.emit(SUBAGENT_RPC_REQUEST_EVENT,{version:SUBAGENT_RPC_PROTOCOL_VERSION,requestId:'req-stop-1',method:'stop',params:{id:'run-missing-gamma'}});
  });
  assert.equal(reply.success,false);
  assert.equal(reply.error.code,'not_found');
  assert.match(reply.error.message,/stop requires a live async run directory\./);
  assert.match(reply.error.message,/Known runs: .*run-live-alpha \(running\)/);
  assert.doesNotMatch(reply.error.message,/run-done-beta/,'terminal runs are not stoppable');
 }finally{
  bridge.dispose();
 }
});
