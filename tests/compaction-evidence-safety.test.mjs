import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/session-signals.ts')));
const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/session-signals.ts')));
const jev=await import(pathToFileURL(path.join(agent,'extensions/lib/jev-client.ts')));

test('compaction makes no unused Jev requests and cannot replace authoritative evidence with clipped previews',async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-compaction-evidence-'));
  const keys=['PI_CODING_AGENT_DIR','OPENROUTER_API_KEY','PI_JEV'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.PI_CODING_AGENT_DIR=temporary;process.env.OPENROUTER_API_KEY='synthetic-test-key';delete process.env.PI_JEV;
  try {
    for(const window of [2048,1_000_000]){
      let calls=0;
      jev.resetJevClient();
      jev.configureJevClient({fetchImpl:async()=>{
        calls++;
        return new Response(JSON.stringify({data:[],answers:{}}));
      }});
      const hooks=new Map(),entries=[];
      register({on:(name,fn)=>hooks.set(name,fn),registerTool(){},registerCommand(){},appendEntry:(type,data)=>entries.push({type,data})});
      const messages=Array.from({length:60},(_,index)=>({role:index===20?'user':'toolResult',content:[{type:'text',text:'Routine synthetic activity. '.repeat(80)+(index===20?'CURRENT REQUIREMENT: deployment remains blocked; preserve /tmp/release and 17 unresolved failures.':'') }]}));
      const preparation={messagesToSummarize:messages,previousSummary:'Earlier synthetic context. '.repeat(220)+'UNRESOLVED REQUIREMENT AT END.',firstKeptEntryId:'synthetic-boundary',tokensBefore:40000};
      const original=structuredClone(preparation);
      const result=await hooks.get('session_before_compact')?.({preparation,reason:window===2048?'overflow':'threshold'},{model:{contextWindow:window}});
      assert.equal(result,undefined,'normal compaction/overflow recovery remains the authoritative path');
      assert.deepEqual(preparation,original,'every original message and the complete previous summary stay intact');
      assert.equal(calls,0,'neither ordinary nor overflow compaction pays for an unused remote plan');
      assert.deepEqual(entries,[],'no unused plan or usage receipt is appended');
    }
  }finally{
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    fs.rmSync(temporary,{recursive:true,force:true});jev.resetJevClient();
  }
});
