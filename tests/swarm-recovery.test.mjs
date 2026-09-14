import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release=path.resolve(import.meta.dirname,'..');
const agent=[path.join(release,'agent'),path.resolve(release,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/shared/swarm-recovery.ts')));
if(!agent) throw new Error('Swarm recovery source is missing');
const {planSwarmRecovery}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/swarm-recovery.ts')));
const {planChildRespawn,childResultsToRecoveryRecords}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/workflows/recovery-seam.ts')));

const record=(key,status='error')=>({key,status,startedAt:0,endedAt:1});

test('swarm attempt suffixes are one based and respawn deterministically',()=>{
 assert.throws(()=>planSwarmRecovery([record('worker-attempt-0')]),/attempt suffix must be >= 1/);
 assert.deepEqual(planSwarmRecovery([record('worker-attempt-1')],{maxRespawnRounds:3,baseBackoffMs:10},100).respawnPlan,[
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
