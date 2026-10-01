#!/usr/bin/env node
/** Counts real helper dispatches with synthetic transports. No network,
 * token estimates, wall-clock assertions or private session input. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const candidates=Array.from({length:27},(_,i)=>({id:`tool-${i}`,text:`Authorized capability ${i}`}));
const current=await import(new URL('../extensions/lib/micro-intelligence/retrieval.ts',import.meta.url));
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--baseline'))throw Error('Use [--baseline /path/to/previous/retrieval.ts]');
const baseline=args.length?await import(pathToFileURL(args[1])):undefined;
async function measure(mod) {
  const counts={exact:{requests:100,judge:0,needle:0,local:0},ambiguous:{requests:100,judge:0,needle:0,local:0}};
  for(const [scenario,counter] of Object.entries(counts))for(let n=0;n<counter.requests;n++) {
    const ordered=await mod.multiStageRetrieve({kind:'tool',site:'synthetic-benchmark',query:scenario==='exact'?'tool-14':'Find the requested capability',lexical:candidates,
      jev:async(_site,state)=>{
        counter.judge++;
        if(scenario==='exact')return {ok:false,skipped:'synthetic-no-judgment'};
        return {ok:true,answers:{rank:{choice:'tool-14',probabilities:Object.fromEntries(state.candidates.map(c=>[c.id,c.id==='tool-14'?.9:.1/24]))},exists:{noul:.95}},usage:{inputTokens:1,cached:false}};
      },
      needle:async()=>{counter.needle++;return {ok:false,reason:'synthetic-unavailable'};},
      local:async()=>{counter.local++;return {ok:false,reason:'synthetic-unavailable'};},
    });
    assert.equal(ordered.ordered.length,candidates.length);
    assert.equal(new Set(ordered.ordered.map(c=>c.id)).size,candidates.length);
    if(scenario==='ambiguous'||mod===current)assert.equal(ordered.ordered[0].id,'tool-14');
  }
  return counts;
}
const report={kind:'synthetic dispatch counts; not a live latency or billing benchmark',candidateCount:candidates.length,
  ...(baseline?{baseline:await measure(baseline)}:{}),current:await measure(current)};
assert.equal(report.current.exact.judge+report.current.exact.needle+report.current.exact.local,0);
assert.equal(report.current.ambiguous.judge,100);
assert.equal(report.current.ambiguous.needle+report.current.ambiguous.local,0);
console.log(JSON.stringify(report,null,2));
