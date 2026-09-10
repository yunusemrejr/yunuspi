import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/shared/progress-evidence.ts')));
const {createProgressEvidence,observeProgressEvidence,formatProgressEvidence}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/shared/progress-evidence.ts')));
const {formatTokenUsage,formatContextUsage}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/shared/formatters.ts')));
test('cumulative traffic is distinct from current and peak context capacity',()=>{
 assert.equal(formatTokenUsage({total:991000,window:64000}),'64k context · 991k cumulative tokens');
 assert.equal(formatContextUsage({window:64000,windowPeak:128000},256000),'context 64k/256k (25%); peak 128k');
});
test('progress tracks successful results independently of streamed activity and tool starts',()=>{
 const s=createProgressEvidence();
 const start=(id,name,target)=>observeProgressEvidence(s,{type:'tool_execution_start',toolCallId:id,toolName:name,args:{path:target}},1);
 const end=(id,isError=false)=>observeProgressEvidence(s,{type:'tool_result_end',message:{toolCallId:id,isError,content:[]}},2);
 start('read','read','a.html');start('write','write','a.html');start('failed','edit','b.html');
 assert.equal(s.summary.toolResults,0);
 end('write');end('read');end('failed',true);
 observeProgressEvidence(s,{type:'tool_execution_end',toolCallId:'write',result:{content:[]}},3);
 observeProgressEvidence(s,{type:'message_update'},4);
 const current=observeProgressEvidence(s,{type:'message_end',message:{role:'assistant'}},5);
 assert.equal(current.toolResults,3);assert.equal(current.toolErrors,1);assert.equal(current.successfulWriteCalls,1);assert.equal(current.writeTargets,1);
 assert.match(formatProgressEvidence(current),/1 turns since successful write/);
 assert.equal(current.lastResultAt,2);
});
test('research progress and missing result evidence never invent edits',()=>{
 const s=createProgressEvidence();
 observeProgressEvidence(s,{type:'tool_execution_start',toolCallId:'read',toolName:'read',args:{}},1);
 observeProgressEvidence(s,{type:'tool_execution_end',toolCallId:'read'},2);
 assert.equal(s.summary.toolResults,0);
 const current=observeProgressEvidence(s,{type:'tool_result_end',message:{toolCallId:'read',content:[]}},3);
 assert.equal(current.toolResults,1);assert.equal(current.successfulWriteCalls,0);
 assert.match(formatProgressEvidence(current),/no successful write calls observed/);
 assert.equal(formatProgressEvidence(),'progress evidence unavailable');
});
test('distinct write targets stay bounded and report a lower bound after truncation',()=>{
 const s=createProgressEvidence();
 for(let i=0;i<4200;i++) {
  observeProgressEvidence(s,{type:'tool_execution_start',toolCallId:`call-${i}`,toolName:'write',args:{path:`target-${i}`}});
  observeProgressEvidence(s,{type:'tool_execution_end',toolCallId:`call-${i}`,result:{content:[]}});
 }
 assert.equal(s.paths.size,4096);assert.equal(s.summary.writeTargets,4096);
 assert.equal(s.summary.writeTargetsTruncated,true);assert.equal(s.summary.successfulWriteCalls,4200);
 assert.ok(s.settled.size<=4096);assert.equal(s.pending.size,0);
 assert.match(formatProgressEvidence(s.summary),/at least 4096 targets/);
 assert.ok([...s.paths].every(target=>target.length===64),'retained target keys never contain unbounded path strings');
});
