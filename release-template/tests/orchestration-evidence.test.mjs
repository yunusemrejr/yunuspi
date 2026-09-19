import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/shared/run-history.ts')));
const {projectRunEvidence}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/run-history.ts')));
const {persistSubagentCost}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/extension/session-cost.ts')));
const {READ_ONLY_REASONING_TOOLS,DEFAULT_TOOL_BUDGET_BLOCK}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/tool-budget.ts')));

test('automatic child ceilings permit skill decisions within their tool budget',()=>{
 assert.ok(READ_ONLY_REASONING_TOOLS.includes('skill_review'));
 assert.ok(DEFAULT_TOOL_BUDGET_BLOCK.includes('skill_review'));
 for(const name of ['edit','write','bash','subagent'])assert.ok(!READ_ONLY_REASONING_TOOLS.includes(name));
});

test('child settlement preserves attempts and output evidence while excluding private prose',()=>{
 const entries=[],state={currentSessionId:'session',completionOwnerId:'owner'};
 const result={task:'PRIVATE_TASK_FIXTURE',error:'HTTP 503 PRIVATE_ERROR_FIXTURE',exitCode:1,model:'provider/model',outputState:'present',
  usage:{input:10,output:3,cacheRead:20,cacheWrite:0,cost:0,turns:1},
  modelAttempts:[{model:'provider/model',success:false,error:'HTTP 429 PRIVATE_ERROR_FIXTURE',usage:{input:5}},{model:'provider/model',success:false,error:'HTTP 503 PRIVATE_ERROR_FIXTURE',usage:{input:5,output:3}}]};
 persistSubagentCost({appendEntry:(type,data)=>entries.push(data)},state,{sessionId:'session',completionOwnerId:'owner',runId:'run',results:[result]});
 const evidence=entries[0].results[0].evidence;
 assert.equal(evidence.retryCount,1);assert.equal(evidence.attemptCount,2);assert.equal(evidence.outcomeReason,'transport');
 assert.equal(evidence.attempts[0].outcomeReason,'capacity');assert.equal(evidence.usage.cacheRead,20);assert.equal(evidence.output,'present');
 assert.match(evidence.taskHash,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(entries),/PRIVATE_(?:TASK|ERROR)_FIXTURE/);
});
test('stops and budgets have explicit causes; missing evidence stays unknown',()=>{
 assert.equal(projectRunEvidence({exitCode:1,stopped:true,error:'HTTP 503'}).outcomeReason,'stopped');
 assert.equal(projectRunEvidence({exitCode:1,timedOut:true}).outcomeReason,'timeout');
 assert.equal(projectRunEvidence({exitCode:1,toolBudgetBlocked:true}).outcomeReason,'budget');
 assert.equal(projectRunEvidence({exitCode:0}).retryCount,undefined);
 assert.equal(projectRunEvidence({finalOutput:'unverified generated message'}).output,'unknown');
 const many=projectRunEvidence({modelAttempts:Array(40).fill({success:false,error:'HTTP 503',usage:{input:1}})});
 assert.equal(many.attemptCount,40);assert.equal(many.attempts.length,8);assert.equal(many.attemptsTruncated,true);
 assert.deepEqual(projectRunEvidence({usage:{input:-1,output:NaN,cacheRead:Infinity}}).usage,{});
});
test('Lens profiling survives reinstall and rejects partial patch drift',async()=>{
 const {edits,applySource,targets}=await import(pathToFileURL(path.join(agent,'scripts/compatibility/legacy-transforms/pi-lens-tool-result-profile.mjs')));
 const source=fs.readFileSync(path.join(agent,'extensions/pi-lens/dist/index.js'),'utf8');
 let baseline=source;for(const [old,next]of edits)baseline=baseline.replace(next,()=>old);
 assert.equal(applySource(baseline),source);assert.equal(applySource(source),source);assert.ok(targets()[0].isApplied());
 assert.throws(()=>applySource(source.replace('phase: "tool_result_handler"','phase: "changed"')),/postcondition drift/);
});
