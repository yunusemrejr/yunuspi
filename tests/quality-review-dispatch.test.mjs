import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const repositoryRoot=path.resolve(import.meta.dirname,'..');
const agentRoot=[path.join(repositoryRoot,'agent'),path.resolve(repositoryRoot,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/shared/utils.ts')));
const load=relative=>import(pathToFileURL(path.join(agentRoot,relative)));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'quality-dispatch-'));
process.env.PI_CODING_AGENT_DIR=root;
process.env.PI_MODEL_EXCLUSIONS_PATH=path.join(root,'exclusions.json');
process.env.PI_PROVIDER_STATE_FILE=path.join(root,'health.json');
delete process.env.PI_AUTONOMOUS_FREE_ASSIST;delete process.env.PI_SUBAGENT_CHILD;
const {compactForegroundResult}=await load('extensions/pi-subagents/src/shared/utils.ts');
const shared=pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/runs/shared/')).href;
const evidence=await import(shared+'free-route-evidence.ts');
const {registerAutonomousRecovery}=await load('extensions/pi-subagents/src/extension/autonomous-recovery.ts');
const prices={prompt:'0',completion:'0',image:'0',request:'0',input_cache_read:'0',input_cache_write:'0'};
evidence.publishFreeEvidence(['free/a','free/b','free/c'].map(id=>({id,pricing:prices,capabilities:{toolCalling:true}})),evidence.FREE_CATALOG_URL);
const free=id=>({provider:'openrouter',id,api:'openai-completions',baseUrl:evidence.FREE_BASE_URL,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},input:['text'],reasoning:false,contextWindow:65536,maxTokens:8192});
const aspects=['correctness','security','interface','content','runtime','delivery'].map(id=>({id,rubric:'Review actual relevant source; require evidence.'}));
const request={task:'Implement this scoped change with quality review',revision:1,files:['src/value.js'],aspects,graph:'Current project source graph',history:[],tests:{need:null}};
function fixture({models=['free/a','free/b','free/c'].map(free),branch=[],result,appendThrows=false}={}) {
 const hooks=new Map(),calls=[],entries=[];
 let session='parent';
 const ctx={cwd:root,model:{...free('parent'),provider:'parent'},modelRegistry:{getAvailable:()=>models},scopedModels:[],sessionManager:{getSessionFile:()=>session,getBranch:()=>branch},ui:{setStatus(){}}};
 const pi={on:(name,fn)=>hooks.set(name,[...(hooks.get(name)??[]),fn]),getActiveTools:()=>['quality_review','subagent'],appendEntry:(customType,data)=>{if(appendThrows)throw Error('sink unavailable');entries.push({customType,data});},sendMessage(){},setModel:async()=>true};
 registerAutonomousRecovery(pi,async(id,params,signal)=>{
  calls.push({id,params,signal});
  if(result)return result(params,signal);
  const assigned=JSON.parse(params.task.split('assigned aspects: ')[1].split('.\nReturn ONLY JSON')[0]);
  return {details:{results:[compactForegroundResult({exitCode:0,messages:[{role:'assistant',content:[{type:'toolCall',id:'source-read',name:'read',arguments:{path:'src/value.js'}}]},{role:'toolResult',toolCallId:'source-read',toolName:'read',isError:false,content:[{type:'text',text:'source'}]}],output:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1: checked the stated input contract against source'],findings:[],gap:''}))})})]}};
 });
 const runner=globalThis[Symbol.for('yunus-pi.quality-review-runner.v1')];
 return {ctx,calls,entries,run:(req=request,signal=new AbortController().signal)=>runner(req,ctx,signal),switch:()=>session='other',emit:async(name,event)=>{for(const fn of hooks.get(name)??[])await fn(event,ctx);}};
}
try {
 const start={role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/value.js'}}]};
 const receipt={role:'toolResult',toolCallId:'read-1',toolName:'read',isError:false,content:[]};
 for(const messages of [[start],[{...receipt,toolCallId:'foreign'}],[start,{...receipt,isError:true}],[receipt]])assert.equal(compactForegroundResult({messages}).reviewEvidence.sourceReads,0);
 const compact=compactForegroundResult({messages:[start,receipt,receipt]});assert.equal(compact.messages,undefined);assert.equal(compact.reviewEvidence.sourceReads,1);assert.equal(compactForegroundResult(compact).reviewEvidence.sourceReads,1);
 const f=fixture();const results=await f.run();assert.equal(f.calls.length,3);assert.equal(results.length,6);assert.ok(results.every(r=>r.ok));
 assert.equal(new Set(f.calls.map(c=>c.params.model)).size,3);
 for(const {params} of f.calls){assert.equal(params.agent,'automatic-free-assistant');assert.equal(params.context,'fresh');assert.equal(params.toolBudget.hard,4);assert.equal(params.toolBudget.block,'*');assert.equal(params.timeoutMs,30000);assert.equal(params.usageBudget.tokens.hard,12000);assert.ok(params.usageBudget.costUsd.hard<=.01/3);assert.ok(params.capabilityCeiling.allowedTools.includes('git_info'));assert.ok(!params.capabilityCeiling.allowedTools.includes('bash'));assert.ok(!params.capabilityCeiling.allowedTools.includes('write'));assert.match(params.task,/Current project source graph/);}
 assert.equal(f.entries.filter(e=>e.customType==='subagent-lifecycle-v1').length,3);
 const one=fixture({models:[free('free/a')]});assert.equal((await one.run()).length,6);assert.equal(one.calls.length,1,'limited capacity groups aspects without dropping coverage');
 for(const text of ['No subagents.','Do not delegate.','Use only this model.','Do not change the provider.']){const restricted=fixture({branch:[{type:'message',message:{role:'user',content:text}}]});assert.deepEqual(await restricted.run(),[]);assert.equal(restricted.calls.length,0);}
 const costly=fixture({models:[{...free('expensive'),cost:{input:5,output:20,cacheRead:0,cacheWrite:0}}]});assert.deepEqual(await costly.run(),[]);assert.equal(costly.calls.length,0);
 const noRead=fixture({result:async()=>({details:{results:[{exitCode:0,messages:[],output:JSON.stringify({reviews:aspects.map(a=>({aspect:a.id,outcome:'pass',evidence:['Claim with no native successful source read'],findings:[],gap:''}))})}]}})});assert.ok((await noRead.run()).every(r=>!r.ok));
 for(const value of [undefined,{details:{results:[null]}},{isError:true,details:{results:[]}},{details:{results:[{exitCode:0,stopped:true}]}}]){const bad=fixture({models:[free('free/a')],result:async()=>value});assert.ok((await bad.run()).every(r=>!r.ok));assert.equal(bad.entries.at(-1).data.state,'failed');}
 const brokenSink=fixture({appendThrows:true});assert.ok((await brokenSink.run()).every(r=>r.ok));
 let resolve;const late=fixture({models:[free('free/a')],result:()=>new Promise(r=>resolve=r)});const pending=late.run();while(!resolve)await new Promise(r=>setImmediate(r));late.switch();const count=late.entries.length;resolve({details:{results:[]}});assert.ok((await pending).every(r=>!r.ok));assert.equal(late.entries.length,count);
 process.env.PI_AUTONOMOUS_FREE_ASSIST='off';const disabled=fixture();assert.deepEqual(await disabled.run(),[]);assert.equal(disabled.calls.length,0);
 console.log('PASS quality dispatch: native launch contracts, free/cost routing, 3 reviewers / 6 aspects, read receipts, restrictions, failure lifecycle, accounting and session isolation');
}finally{fs.rmSync(root,{recursive:true,force:true});}
