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
const {resetSharedControl}=await load('extensions/lib/intervention-shared.ts');
const {collectSessionMetrics}=await load('extensions/lib/session-metrics.ts');
const {collectSessionDiagnostics}=await load('extensions/lib/session-diagnostics.ts');
const prices={prompt:'0',completion:'0',image:'0',request:'0',input_cache_read:'0',input_cache_write:'0'};
evidence.publishFreeEvidence(['free/a','free/b','free/c'].map(id=>({id,pricing:prices,capabilities:{toolCalling:true}})),evidence.FREE_CATALOG_URL);
const free=id=>({provider:'openrouter',id,api:'openai-completions',baseUrl:evidence.FREE_BASE_URL,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},input:['text'],reasoning:false,contextWindow:65536,maxTokens:8192});
const aspects=['correctness','security','interface','content','runtime','delivery'].map(id=>({id,rubric:'Review actual relevant source; require evidence.'}));
const request={task:'Implement this scoped change with quality review',revision:1,files:['src/value.js'],aspects,graph:'Current project source graph',history:[],tests:{need:null}};
function fixture({models=['free/a','free/b','free/c'].map(free),branch=[],result,appendThrows=false}={}) {
 resetSharedControl(); // step 21: isolate shared-control spend per scenario
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
 return {ctx,calls,entries,run:(req=request,signal=new AbortController().signal)=>runner(req,ctx,signal),switch:()=>{session='other';resetSharedControl();},emit:async(name,event)=>{for(const fn of hooks.get(name)??[])await fn(event,ctx);}};
}
try {
 const start={role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/value.js'}}]};
 const receipt={role:'toolResult',toolCallId:'read-1',toolName:'read',isError:false,content:[]};
 for(const messages of [[start],[{...receipt,toolCallId:'foreign'}],[start,{...receipt,isError:true}],[receipt]])assert.equal(compactForegroundResult({messages}).reviewEvidence.sourceReads,0);
 const compact=compactForegroundResult({messages:[start,receipt,receipt]});assert.equal(compact.messages,undefined);assert.equal(compact.reviewEvidence.sourceReads,1);assert.equal(compactForegroundResult(compact).reviewEvidence.sourceReads,1);
 // One completed reviewer must survive another child's stalled cancellation.
 const stop=new AbortController(), streamed=[];let completed=false;
 const partial=fixture({models:[free('free/a'),free('free/b')],result:async params=>{
  if(completed){setImmediate(()=>stop.abort());return new Promise(()=>{});}
  completed=true;
  const assigned=JSON.parse(params.task.split('assigned aspects: ')[1].split('.\nReturn ONLY JSON')[0]);
  return {details:{results:[compactForegroundResult({exitCode:0,messages:[start,receipt],output:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 checked the actual current source contract'],findings:[],gap:''}))})})]}};
 }});
 let deadline;
 const partialResult=await Promise.race([partial.run({...request,onResult:r=>streamed.push(r)},stop.signal),new Promise(resolve=>{deadline=setTimeout(()=>resolve('hung'),500);})]);clearTimeout(deadline);
 assert.notEqual(partialResult,'hung','review fanout must settle even when a child ignores cancellation');
 assert.ok(partialResult.some(r=>r.ok),'completed review survives a sibling timeout');
 assert.ok(streamed.some(r=>r.ok),'native results are delivered before the group deadline');
 const f=fixture();const results=await f.run();assert.equal(f.calls.length,3);assert.equal(results.length,6);assert.ok(results.every(r=>r.ok));
 assert.equal(new Set(f.calls.map(c=>c.params.model)).size,3);
 for(const {params} of f.calls){assert.equal(params.agent,'automatic-free-assistant');assert.equal(params.context,'fresh');assert.equal(params.toolBudget.hard,8);assert.equal(params.toolBudget.soft,6);assert.equal(params.toolBudget.block,'*');assert.equal(params.timeoutMs,90000);assert.equal(params.usageBudget.tokens.hard,96000);assert.ok(params.usageBudget.costUsd.hard<=.01/3);assert.ok(params.capabilityCeiling.allowedTools.includes('git_info'));assert.ok(!params.capabilityCeiling.allowedTools.includes('bash'));assert.ok(!params.capabilityCeiling.allowedTools.includes('write'));assert.match(params.task,/Current project source graph/);assert.ok(params.task.includes(JSON.stringify(root)));assert.match(params.task,/already committed/);}
 assert.equal(f.entries.filter(e=>e.customType==='subagent-lifecycle-v1').length,3);
 const published=[];const streaming=fixture();await streaming.run({...request,onResult:r=>published.push(r)});assert.equal(published.length,6,'completed aspects are delivered without waiting for every peer');assert.ok(published.every(r=>r.ok));
 const native=[];
 const failed=fixture({result:async()=>{
  const runId=`native-${native.length}`;
  native.push({type:'custom',customType:'subagent-lifecycle-v1',data:{runId,mode:'single',state:'failed',results:[{index:0,status:'failed'}]}});
  return {isError:true,details:{runId,results:[{exitCode:1,error:'Test reviewer failed'}]}};
 }});
 await failed.run();
 const records=[...native,...failed.entries.map(e=>({type:'custom',...e}))];
 assert.equal(collectSessionMetrics(records).agents,3,'wrapper receipts alias the three native children');
 assert.equal(collectSessionMetrics(records).agentFailures,3);
 assert.equal(collectSessionDiagnostics(records).failures.length,3,'diagnostics do not repeat each native failure under a wrapper ID');
 const one=fixture({models:[free('free/a')]});assert.equal((await one.run()).length,6);assert.equal(one.calls.length,1,'limited capacity groups aspects without dropping coverage');
 const large=fixture({models:[free('free/a')],result:async()=>({details:{results:[compactForegroundResult({exitCode:0,messages:[start,receipt],output:JSON.stringify({reviews:aspects.map(a=>({aspect:a.id,outcome:'pass',evidence:Array.from({length:3},()=>`src/value.js:1 ${'specific inspected source evidence '.repeat(15)}`),findings:[],gap:''}))})})]}})});
 assert.ok((await large.run()).every(r=>r.ok),'multi-aspect JSON exceeding the prose-preview cap stays intact');
 const budgeted=fixture({models:[free('free/a')],result:async params=>{
  const assigned=JSON.parse(params.task.split('assigned aspects: ')[1].split('.\nReturn ONLY JSON')[0]);
  return {isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[compactForegroundResult({exitCode:1,error:'Usage budget exhausted.',messages:[start,receipt],finalOutput:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 report was emitted after reading the current source'],findings:[],gap:''}))})})]}};
 }});
 const budgetedResults=await budgeted.run();
 assert.ok(budgetedResults.every(r=>r.ok),'a source-backed final report survives a hard usage budget wrapper failure');
 assert.ok(budgetedResults.every(r=>r.text.includes('"outcome":"unknown"')&&/usage budget was exhausted/.test(r.text)),'non-clean budget salvage carries an explicit unknown gap');
 assert.equal(budgeted.entries.at(-1).data.state,'failed','budget salvage keeps the native failure lifecycle truthful');
 const cleanBudget=fixture({models:[free('free/a')],result:async params=>{
  const assigned=JSON.parse(params.task.split('assigned aspects: ')[1].split('.\nReturn ONLY JSON')[0]);
  return {isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'costUsd'},results:[compactForegroundResult({exitCode:0,messages:[start,receipt],finalOutput:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 clean terminal report checked against current source'],findings:[],gap:''}))})})]}};
 }});
 const cleanBudgetResults=await cleanBudget.run();
 assert.ok(cleanBudgetResults.every(r=>r.ok&&r.text.includes('"outcome":"pass"')),'clean child completion keeps its validated outcome when the aggregate budget closes');
 const budgetInvalid=fixture({models:[free('free/a')],result:async()=>({isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[{exitCode:1,error:'Usage budget exhausted.',reviewEvidence:{sourceReads:1},output:'not json'}]}})});
 assert.ok((await budgetInvalid.run()).every(r=>!r.ok),'budget exhaustion never promotes malformed output to review evidence');
 const budgetSignal=fixture({models:[free('free/a')],result:async params=>{
  const assigned=JSON.parse(params.task.split('assigned aspects: ')[1].split('.\nReturn ONLY JSON')[0]);
  return {isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[compactForegroundResult({exitCode:1,processSignal:'SIGTERM',messages:[start,receipt],finalOutput:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 report followed a source read'],findings:[],gap:''}))})})]}};
 }});
 assert.ok((await budgetSignal.run()).every(r=>!r.ok),'a signalled child is never salvaged as a budgeted review');
 for(const text of ['No subagents.','Do not delegate.','Use only this model.','Do not change the provider.']){const restricted=fixture({branch:[{type:'message',message:{role:'user',content:text}}]});const denied=await restricted.run();assert.equal(denied.length,6);assert.ok(denied.every(r=>!r.ok && /restriction/.test(r.gap)));assert.equal(restricted.calls.length,0);}
 const costly=fixture({models:[{...free('expensive'),cost:{input:5,output:20,cacheRead:0,cacheWrite:0}}]});assert.ok((await costly.run()).every(r=>!r.ok && /economy policy/.test(r.gap)));assert.equal(costly.calls.length,0);
 const tooSmall=fixture({models:[{...free('free/a'),maxTokens:1024}]});assert.ok((await tooSmall.run()).every(r=>!r.ok && /output capacity/.test(r.gap)));assert.equal(tooSmall.calls.length,0,'do not admit reviewers unable to fit the report budget');
 const noRead=fixture({result:async()=>({details:{results:[{exitCode:0,messages:[],output:JSON.stringify({reviews:aspects.map(a=>({aspect:a.id,outcome:'pass',evidence:['Claim with no native successful source read'],findings:[],gap:''}))})}]}})});assert.ok((await noRead.run()).every(r=>!r.ok));assert.equal(noRead.entries.at(-1).data.state,'failed','a no-source report is not recorded as completed');
 for(const value of [undefined,{details:{results:[null]}},{isError:true,details:{results:[]}},{details:{results:[{exitCode:0,stopped:true}]}}]){const bad=fixture({models:[free('free/a')],result:async()=>value});assert.ok((await bad.run()).every(r=>!r.ok));assert.equal(bad.entries.at(-1).data.state,'failed');}
 const brokenSink=fixture({appendThrows:true});assert.ok((await brokenSink.run()).every(r=>r.ok));
 let resolve;const late=fixture({models:[free('free/a')],result:()=>new Promise(r=>resolve=r)});const pending=late.run();while(!resolve)await new Promise(r=>setImmediate(r));late.switch();const count=late.entries.length;resolve({details:{results:[]}});assert.ok((await pending).every(r=>!r.ok));assert.equal(late.entries.length,count);
 const protocol=fixture({models:[free('free/a')],result:async()=>({details:{results:[{exitCode:0,reviewEvidence:{sourceReads:1},output:'<|message_model|>read<|content_invoke_tool_json|>{"path":"src/value.js"}<|end_message|>'}]}})});
 const leaked=await protocol.run();assert.ok(leaked.every(r=>!r.ok && /raw tool-protocol/.test(r.gap)));assert.equal(protocol.calls.length,1);
 await protocol.emit('input',{source:'interactive',text:'Review again'});
 const excluded=await protocol.run();assert.equal(protocol.calls.length,1,'known broken tool protocol is not retried next round or user turn');assert.ok(excluded.every(r=>/no automatic retry/.test(r.gap)));
 protocol.switch();await protocol.run();assert.equal(protocol.calls.length,2,'protocol exclusion belongs only to its session');
 process.env.PI_AUTONOMOUS_FREE_ASSIST='off';const disabled=fixture();assert.ok((await disabled.run()).every(r=>!r.ok && /disabled/.test(r.gap)));assert.equal(disabled.calls.length,0);
 console.log('PASS quality dispatch: native launch contracts, free/cost routing, 3 reviewers / 6 aspects, read receipts, restrictions, failure lifecycle, accounting and session isolation');
}finally{fs.rmSync(root,{recursive:true,force:true});}
