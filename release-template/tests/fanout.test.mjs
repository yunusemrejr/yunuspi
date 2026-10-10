import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(dir=>fs.existsSync(path.join(dir,'extensions/pi-subagents/src/runs/shared/fanout.ts')));
if(!agent) throw new Error('Fan-out source is missing');
const {mergeFragments,parseFragmentBlocks,planRecovery}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/fanout.ts')));
const {planChildRespawn,childResultsToRecoveryRecords,fuseChildOutputs}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/workflows/recovery-seam.ts')));

const record=(key,status='error')=>({key,status,startedAt:0,endedAt:1});
const fragment=(owner,body,kind='complementary',updatedAt=1)=>({owner,body,kind,updatedAt});
const block=(value,fence='```')=>`${fence}fragment\n${JSON.stringify(value)}\n${fence}`;

test('fan-out attempt suffixes are one based and respawn deterministically',()=>{
 assert.throws(()=>planRecovery([record('worker-attempt-0')]),/attempt suffix must be >= 1/);
 assert.deepEqual(planRecovery([record('worker-attempt-1')],{maxRespawnRounds:3,baseBackoffMs:10},100).respawnPlan,[
  {key:'worker-attempt-2',attempt:2,notBeforeMs:120},
 ]);
});

test('workflow recovery preserves a consumed budget instead of respawning the child',()=>{
 const spent={key:'worker',ok:false,terminalOutcome:{state:'partial',reason:'budget_exhausted'}};
 assert.equal(childResultsToRecoveryRecords([spent],100)[0].status,'budget-exhausted');
 assert.deepEqual(planChildRespawn([spent],undefined,100),{degraded:['worker'],respawnPlan:[]});
 const history=[{key:'worker',ok:false},{...spent,key:'worker-attempt-1'}];
 assert.deepEqual(planChildRespawn(history,undefined,100),{degraded:['worker','worker-attempt-1'],respawnPlan:[]});
 assert.equal(childResultsToRecoveryRecords([{...spent,stopped:true}],100)[0].status,'stopped','explicit stop still wins');
 const ordinary={key:'worker',ok:false,terminalOutcome:{state:'partial',reason:'timeout'}};
 assert.equal(planChildRespawn([ordinary],undefined,100).respawnPlan.length,1,'other partial outcome recovery is unchanged');
});

test('fragment parsing preserves JSON-escaped markdown and follows actual fence boundaries',()=>{
  const sample=fragment('peer','Check this code:\n```js\nconsole.log("evidence");\n```\nThen verify its output.','conflict');
  for(const fence of ['```','````','~~~']){
    const output=`Advisory intro\r\n${block(sample,fence).replaceAll('\n','\r\n')}\r\n${block(fragment('other','Distinct evidence.'),fence)}\r\n`;
    assert.deepEqual(parseFragmentBlocks(output),[sample,fragment('other','Distinct evidence.')]);
  }
  assert.deepEqual(parseFragmentBlocks('Inline mention of ```fragment\n is prose, not an opening fence.'),[]);
  assert.deepEqual(parseFragmentBlocks(block(sample).replace(/\n```$/,'\n\t```\t')), [sample]);
  assert.throws(()=>parseFragmentBlocks('````fragment\n{}\n```'),/unterminated/);
  assert.throws(()=>parseFragmentBlocks('```fragment'),/unterminated/);
  assert.throws(()=>parseFragmentBlocks(block(fragment('worker','   '))),/body.*non-empty/);
  assert.throws(()=>parseFragmentBlocks(block(sample)+'\n```fragment\n{'),/fragments\[1\].*unterminated/);
});

test('byte-identical fragments keep all source attribution and distinct conflicts survive',()=>{
  const output=mergeFragments([
    fragment('first','Keep current behavior.','conflict'),
    fragment('second','Replace current behavior.','conflict'),
    fragment('third','Keep current behavior.','duplicate'),
    fragment('fourth','A distinct section mislabeled duplicate.','duplicate'),
  ]);
  assert.equal(output.strategy,'disjoint-split');assert.equal(output.requiresReview,true);
  assert.deepEqual(output.unresolvedConflicts,['first','second']);
  assert.match(output.fusedBody,/Keep current behavior/);assert.match(output.fusedBody,/Replace current behavior/);
  assert.match(output.fusedBody,/distinct section mislabeled/);
  for(const p of output.provenance){
    assert.ok(p.end>p.start);
    assert.equal(output.fusedBody.slice(p.start,p.end),p.owner==='second'?'Replace current behavior.':p.owner==='fourth'?'A distinct section mislabeled duplicate.':'Keep current behavior.');
  }
  assert.equal(output.provenance.find(p=>p.owner==='first').section,output.provenance.find(p=>p.owner==='third').section);
});

test('truncated merge identifies partial and entirely omitted source sections',()=>{
  const output=mergeFragments([fragment('a','ABCDEFGHIJ'),fragment('b','KLMNOPQRST'),fragment('c','UVWXYZ!')],{maxBodyChars:30});
  assert.equal(output.fusedBody,'ABCDEFGHIJ\n\nKLMN...[truncated]');
  assert.equal(output.truncated,true);assert.equal(output.requiresReview,true);assert.equal(output.originalChars,31);
  const [a,b,c]=output.provenance;
  assert.equal(a.truncated,undefined);assert.equal(a.omitted,undefined);
  assert.equal(b.truncated,true);assert.equal(output.fusedBody.slice(b.start,b.end),'KLMN');
  assert.equal(c.omitted,true);assert.equal(c.start,c.end);
});

test('merge truncation never emits a lone surrogate and reports an omitted conflict',()=>{
  const sample=fragment('conflicting-peer','😀😀','conflict');
  for(const maxBodyChars of [1,3,14,16]){
    const output=mergeFragments([sample,fragment('long-peer','x'.repeat(40))],{maxBodyChars});
    assert.ok(output.fusedBody.length<=maxBodyChars);
    assert.equal(output.fusedBody.isWellFormed(),true);
    assert.equal(output.requiresReview,true);
    if(maxBodyChars===1)assert.equal(output.provenance[0].omitted,true);
  }
});

test('workflow fan-out merge uses actual run keys, requires terminal success shape and accepts default options',()=>{
  const output=fuseChildOutputs([
    {key:'actual-worker',ok:true,output:block(fragment('spoofed-worker','Observed source evidence.'))},
    {key:'failed',ok:false,output:'FAILURE MUST NOT BECOME EVIDENCE'},
    {key:'stopped',ok:true,stopped:true,output:'STOPPED MUST NOT BECOME EVIDENCE'},
    {key:'interrupted',ok:true,interrupted:true,output:'INTERRUPTED MUST NOT BECOME EVIDENCE'},
  ],{});
  assert.equal(output.fusedBody,'Observed source evidence.');
  assert.deepEqual(output.provenance.map(p=>p.owner),['actual-worker']);
  for(const row of [null,[],{key:'fixture',output:'unconfirmed'},{key:'fixture',ok:'true',output:'unconfirmed'}])
    assert.throws(()=>fuseChildOutputs([row]),/runs\.fuse: results\[0\]/);
  assert.throws(()=>fuseChildOutputs([{key:'bad-worker',ok:true,output:'```fragment\ninvalid\n```'}]),/bad-worker.*not valid JSON/);
  assert.deepEqual(childResultsToRecoveryRecords([{key:'budget',ok:false,terminalOutcome:{reason:'budget_exhausted'}},{key:'interrupted',ok:false,interrupted:true}],7).map(row=>row.status),['budget-exhausted','stopped']);
});
