import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecution, createAdaptiveExecutionController } from '../agent/extensions/lib/adaptive-execution.ts';
import { createSessionObserver, buildObserverPacket } from '../agent/extensions/lib/session-observer.ts';

const flush = async()=>{for(let n=0;n<32;n++)await Promise.resolve();};
function clock() {
  let now=0,id=0;const jobs=new Map();
  return {now:()=>now,setTimeout(fn,ms){jobs.set(++id,{at:now+ms,fn});return id;},clearTimeout(id){jobs.delete(id);},
    async advance(ms){const until=now+ms;while(true){const next=[...jobs.entries()].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();await flush();}now=until;await flush();}};
}
const route={route:'provider/fixture',model:{provider:'provider',id:'fixture'},thinking:'low'};
const response=()=>({stopReason:'stop',content:[{type:'text',text:'{"note":"","evidence":[],"tools":[],"skills":[]}'}]});

test('direct scope never constructs observer packets, then failures enable timely review',async()=>{
  const time=clock(),controller=createAdaptiveExecutionController();let snapshots=0,dispatches=0;
  controller.begin({task:'Fix one typo'});
  const observer=createSessionObserver({...time,execution:()=>controller.profile(),snapshot:()=>{snapshots++;return {route,packet:buildObserverPacket('Fix parser',[],[],[])};},notice(){},receipt(){},dispatch:async()=>{dispatches++;return response();}});
  observer.begin('owner');observer.start();await time.advance(300000);
  assert.equal(snapshots,0);assert.equal(dispatches,0);
  controller.observe({ok:false,failureKey:'parse'});controller.observe({ok:false,failureKey:'parse'});
  await time.advance(30000);assert.equal(dispatches,1,'failures require no full routine-cadence wait');
  controller.observe({ok:true,verified:true});await time.advance(300000);assert.equal(dispatches,1);observer.close();
});

test('scope cadence runs the actual scheduler at 120s for diagnosis and 60s for broad work',async()=>{
  for(const [task,expected] of [['Investigate a parser failure',120000],['Implement cross-file changes',60000]]) {
    const time=clock();let snapshots=0,dispatches=0;
    const observer=createSessionObserver({...time,execution:()=>classifyExecution({task}),snapshot:()=>{snapshots++;return {route,packet:buildObserverPacket(task,[],[],[])};},notice(){},receipt(){},dispatch:async()=>{dispatches++;return response();}});
    observer.begin('owner');observer.start();await time.advance(expected-1);assert.equal(snapshots,0,task);await time.advance(1);assert.equal(dispatches,1,task);observer.close();
  }
});

test('Watchmaker waits for substantial work and quiet standard work spends no judge calls',async()=>{
  const time=clock();let snapshots=0,judges=0;
  const observer=createSessionObserver({...time,usageOwner:'session-watchmaker',execution:()=>classifyExecution({task:'Investigate a parser failure'}),judge:async()=>{judges++;throw Error('unexpected');},snapshot:()=>{snapshots++;return {route,packet:buildObserverPacket('Parser',[],[],[])};},notice(){},receipt(){},dispatch:async()=>response()});
  observer.begin('owner');observer.start();await time.advance(300000);assert.equal(snapshots,0);assert.equal(judges,0);observer.close();
});

test('missing policy retains existing observer lifecycle and cadence',async()=>{
  const time=clock();let calls=0;
  const observer=createSessionObserver({...time,execution:()=>undefined,snapshot:()=>({route,packet:buildObserverPacket('Fixture',[],[],[])}),notice(){},receipt(){},dispatch:async()=>{calls++;return response();}});
  observer.begin('owner');observer.start();await time.advance(30000);assert.equal(calls,1);observer.close();
});

test('adaptive kill switch restores the established observer cadence',async t=>{
  const original=process.env.PI_ADAPTIVE_EXECUTION;t.after(()=>{if(original===undefined)delete process.env.PI_ADAPTIVE_EXECUTION;else process.env.PI_ADAPTIVE_EXECUTION=original;});
  process.env.PI_ADAPTIVE_EXECUTION='off';const time=clock();let calls=0;
  const observer=createSessionObserver({...time,execution:()=>classifyExecution({task:'Fix one typo'}),snapshot:()=>({route,packet:buildObserverPacket('Fixture',[],[],[])}),notice(){},receipt(){},dispatch:async()=>{calls++;return response();}});
  observer.begin('owner');observer.start();await time.advance(30000);assert.equal(calls,1);observer.close();
});
