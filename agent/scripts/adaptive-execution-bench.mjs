#!/usr/bin/env node
/** Deterministic before/after replay of the real observer scheduler. Provider
 * responses are fixtures: dispatch counts are measured; token counts are UTF-8
 * estimates, never billing or a claim of live task completion speed. */
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { classifyExecution, automaticCapabilityDecision } from '../extensions/lib/adaptive-execution.ts';
import { buildObserverPacket, createSessionObserver } from '../extensions/lib/session-observer.ts';

const durationMs=180000;
const flush=async()=>{for(let n=0;n<32;n++)await Promise.resolve();};
function clock() {
  let now=0,id=0;const jobs=new Map();
  return {now:()=>now,setTimeout(fn,delay){jobs.set(++id,{at:now+delay,fn});return id;},clearTimeout(id){jobs.delete(id);},
    async advance(ms){const until=now+ms;while(true){const next=[...jobs.entries()].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();await flush();}now=until;await flush();}};
}
const cases=[
  {id:'simple',task:'Fix the typo in README.md and run the existing check'},
  {id:'complex',task:'Implement cross-file concurrency fixes in the frontend and backend with regression tests'},
  {id:'critical',task:'Fix authentication token validation and verify production compatibility'},
];
async function replay(task,adaptive) {
  const started=performance.now(),time=clock(),profile=classifyExecution({task});
  let dispatches=0,packets=0,inputTokensEstimate=0,outputTokensEstimate=0;
  const owners=['session-observer','session-watchmaker'].map(usageOwner=>createSessionObserver({...time,
    usageOwner,intervalMs:usageOwner==='session-watchmaker'?60000:30000,
    ...(adaptive?{execution:()=>profile}:{}),salience:()=>Math.floor(time.now()/30000),
    snapshot(){packets++;const packet=buildObserverPacket(task,[{id:`event-${time.now()}`,kind:'tool result',text:'Fixture check passed; current source verified.'}],[],[]);return {packet,route:{route:'fixture/reviewer',model:{provider:'fixture',id:'reviewer'}}};},
    notice(){},receipt(){},dispatch:async(_route,packet)=>{dispatches++;inputTokensEstimate+=Math.ceil(Buffer.byteLength(packet.text)/4);
      const text='{"note":"","evidence":[],"tools":[],"skills":[]}';outputTokensEstimate+=Math.ceil(Buffer.byteLength(text)/4);
      return {stopReason:'stop',content:[{type:'text',text}]};},
  }));
  for(const owner of owners){owner.begin('fixture');owner.start();}
  await time.advance(durationMs);for(const owner of owners)owner.close();
  // Admission does not remove any required check/tool. Duplicate completed
  // checks stay satisfied without turning success into a new request.
  assert.equal(automaticCapabilityDecision(profile,'qualityReview',{required:true}).run,true);
  assert.equal(automaticCapabilityDecision(profile,'qualityReview',{alreadySatisfied:true}).run,false);
  return {localReplayMs:performance.now()-started,dispatches,packetBuilds:packets,inputTokensEstimate,outputTokensEstimate,requiredCapabilitiesPreserved:true};
}
const rows=[];
for(const fixture of cases) {
  const before=[],after=[];
  for(let iteration=0;iteration<9;iteration++){before.push(await replay(fixture.task,false));after.push(await replay(fixture.task,true));}
  const result=samples=>{const times=samples.map(row=>row.localReplayMs).sort((a,b)=>a-b);const {localReplayMs,...counts}=samples.at(-1);return {...counts,localReplayP50Ms:Number(times[4].toFixed(3)),localReplayP95Ms:Number(times.at(-1).toFixed(3))};};
  rows.push({id:fixture.id,task:fixture.task,tier:classifyExecution(fixture).tier,before:result(before),after:result(after)});
}
assert.equal(rows[0].after.dispatches,0);
for(const row of rows)assert.ok(row.after.dispatches<=row.before.dispatches,`${row.id}: automatic review regression`);
console.log(JSON.stringify({kind:'deterministic actual-scheduler replay',simulatedTaskDurationMs:durationMs,
  tokenMethod:'Estimated UTF-8 packet bytes / 4 plus fixture output; no live inference, provider usage or end-to-end completion time measured.',
  baseline:'Existing scheduler without a shared execution profile; same event timeline and fixture responses.',rows},null,2));
