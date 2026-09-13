import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release=path.resolve(import.meta.dirname,'..');
const agent=[path.join(release,'agent'),path.resolve(release,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/shared/swarm-recovery.ts')));
if(!agent) throw new Error('Swarm recovery source is missing');
const {planSwarmRecovery}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/runs/shared/swarm-recovery.ts')));

const record=(key,status='error')=>({key,status,startedAt:0,endedAt:1});

test('swarm attempt suffixes are one based and respawn deterministically',()=>{
 assert.throws(()=>planSwarmRecovery([record('worker-attempt-0')]),/attempt suffix must be >= 1/);
 assert.deepEqual(planSwarmRecovery([record('worker-attempt-1')],{maxRespawnRounds:3,baseBackoffMs:10},100).respawnPlan,[
  {key:'worker-attempt-2',attempt:2,notBeforeMs:120},
 ]);
});
