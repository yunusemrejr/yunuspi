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
delete process.env.PI_SUBAGENT_CHILD;
const {compactForegroundResult}=await load('extensions/pi-subagents/src/shared/utils.ts');
const {registerQualityReviewRunner}=await load('extensions/pi-subagents/src/extension/quality-review-runner.ts');
const {checkVisualSourceEvidence}=await load('extensions/pi-subagents/src/runs/shared/acceptance.ts');
const {REVIEW_LIMITS}=await load('extensions/pi-subagents/src/runs/shared/automatic-budgets.ts');
const {collectSessionMetrics}=await load('extensions/lib/session-metrics.ts');
const {collectSessionDiagnostics}=await load('extensions/lib/session-diagnostics.ts');
const activity=[],activitySymbol=Symbol.for('yunus-pi.activity.v1'),previousActivity=globalThis[activitySymbol];
globalThis[activitySymbol]=request=>{activity.push(request.label);return outcome=>activity.push(outcome);};
const sessionModel=(input=['text'])=>({provider:'parent',id:'session',api:'openai-completions',baseUrl:'https://session.example.test/v1',cost:{input:0,output:0,cacheRead:0,cacheWrite:0},input,reasoning:false,contextWindow:65536,maxTokens:8192});
const aspects=['correctness','security','interface','content','runtime','delivery'].map(id=>({id,rubric:'Review actual relevant source; require evidence.'}));
const request={task:'Implement this scoped change with quality review',revision:1,files:['src/value.js'],aspects,graph:'Current project source graph',history:[],tests:{need:null}};
const assignedOf=params=>JSON.parse(params.task.split('assigned aspects: ')[1].split('].')[0] + ']');
function defaultLaunch(params){
  const assigned=assignedOf(params);
  return {details:{results:[compactForegroundResult({exitCode:0,messages:[{role:'assistant',content:[{type:'toolCall',id:'source-read',name:'read',arguments:{path:'src/value.js'}}]},{role:'toolResult',toolCallId:'source-read',toolName:'read',isError:false,content:[{type:'text',text:'source'}]}],output:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1: checked the stated input contract against source'],findings:[],gap:''}))})})]}};
}
// model: the session model (null for none). branch: session history entries. tools: active tool names.
function fixture({model=sessionModel(),branch=[],branchThrows=false,result,appendThrows=false,tools=['quality_review','subagent']}={}) {
 const hooks=new Map(),calls=[],entries=[];
 let session='parent';
 const ctx={cwd:root,model,sessionManager:{getSessionFile:()=>session,getBranch:()=>{if(branchThrows)throw Error('history unreadable');return branch;}}};
 const pi={on:(name,fn)=>hooks.set(name,[...(hooks.get(name)??[]),fn]),getActiveTools:()=>tools,appendEntry:(customType,data)=>{if(appendThrows)throw Error('sink unavailable');entries.push({customType,data});}};
 registerQualityReviewRunner(pi,async(id,params,signal)=>{
  calls.push({id,params,signal});
  if(result)return result(params,signal,()=>defaultLaunch(params));
  return defaultLaunch(params);
 });
 const runner=globalThis[Symbol.for('yunus-pi.quality-review-runner.v1')];
 return {ctx,calls,entries,run:(req=request,signal=new AbortController().signal)=>runner(req,ctx,signal),switch:()=>{session='other';},emit:name=>{for(const fn of hooks.get(name)??[])fn();}};
}
try {
 const failedLaunch=fixture({result:async()=>{throw new ReferenceError('reviewBinding is not defined');}});
 const failedReports=await failedLaunch.run({...request,aspects:[aspects[0]]});
 assert.match(failedReports[0].gap,/ReferenceError:reviewBinding/);
 assert.match(failedReports[0].gap,/harness error/);
 const failedCost=failedLaunch.entries.filter(e=>e.customType==='subagent-cost-v1').at(-1).data.results[0];
 assert.equal(failedCost.agent,'reviewer');
 assert.equal(failedCost.scopeId,'correctness');
 assert.equal(failedCost.model,undefined,'cost rows carry no model: the session model is not a route choice');
 assert.equal(failedCost.cause.category,'internal');
 assert.equal(failedCost.evidence.cause.stage,'launch');
 assert.equal(failedCost.usage,undefined);
 const start={role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'src/value.js'}}]};
 const receipt={role:'toolResult',toolCallId:'read-1',toolName:'read',isError:false,content:[{type:'text',text:'export const value = 1;'}]};
 const imageReceipt={...receipt,content:[{type:'text',text:'Read image file [image/png]'},{type:'image',data:'fixture',mimeType:'image/png'}]};
 for(const messages of [[start],[{...receipt,toolCallId:'foreign'}],[start,{...receipt,isError:true}],[receipt],[receipt,start],[start,{...receipt,toolName:'bash'}],[start,{...receipt,content:[]}],[start,imageReceipt],[start,{...imageReceipt,content:imageReceipt.content.slice(0,1)}],[start,receipt,start]])assert.equal(compactForegroundResult({messages}).reviewEvidence.sourceReads,0,'source evidence requires unique ordered calls and nonempty source text');
 const compact=compactForegroundResult({messages:[start,receipt,receipt]});assert.equal(compact.messages,undefined);assert.equal(compact.reviewEvidence.sourceReads,1);assert.equal(compactForegroundResult(compact).reviewEvidence.sourceReads,1);
 // Cancelled, model-less or subagent-less sessions never dispatch a reviewer.
 const aborted=new AbortController();aborted.abort();
 const cancelled=fixture();assert.ok((await cancelled.run(request,aborted.signal)).every(r=>!r.ok&&r.unattempted===true&&/cancelled/.test(r.gap)));assert.equal(cancelled.calls.length,0);
 for(const gated of [fixture({model:null}),fixture({tools:['quality_review']})]){assert.ok((await gated.run()).every(r=>!r.ok&&r.unattempted===true&&/no model or the native subagent/.test(r.gap)));assert.equal(gated.calls.length,0);}
 // A user's "no subagents" forbids reviewers until a later explicit allow.
 for(const text of ['No subagents.','Do not delegate.',"Don't delegate."]){const restricted=fixture({branch:[{type:'message',message:{role:'user',content:text}}]});const denied=await restricted.run();assert.equal(denied.length,6);assert.ok(denied.every(r=>!r.ok&&r.unattempted===true&&/restriction/.test(r.gap)));assert.equal(restricted.calls.length,0);}
 const restrictedBlocks=fixture({branch:[{type:'message',message:{role:'user',content:[{type:'text',text:'No subagents.'}]}}]});assert.ok((await restrictedBlocks.run()).every(r=>r.unattempted===true),'array-form user messages are read too');
 const unreadable=fixture({branchThrows:true});assert.ok((await unreadable.run()).every(r=>!r.ok&&r.unattempted===true&&/restriction/.test(r.gap)),'unreadable history blocks automatic reviews');assert.equal(unreadable.calls.length,0);
 const relaxed=fixture({branch:[{type:'message',message:{role:'user',content:'No subagents.'}},{type:'message',message:{role:'user',content:'Allow subagents for this review.'}}]});
 assert.ok((await relaxed.run()).every(r=>r.ok),'a later explicit allow lifts the restriction');assert.equal(relaxed.calls.length,3);
 // One completed reviewer must survive another child's stalled cancellation.
 const stop=new AbortController(), streamed=[];let completed=false;
 const partial=fixture({result:async params=>{
  if(completed){setImmediate(()=>stop.abort());return new Promise(()=>{});}
  completed=true;
  const assigned=assignedOf(params);
  return {details:{results:[compactForegroundResult({exitCode:0,messages:[start,receipt],output:JSON.stringify({reviews:assigned.map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 checked the actual current source contract'],findings:[],gap:''}))})})]}};
 }});
 let deadline;
 const partialResult=await Promise.race([partial.run({...request,aspects:aspects.slice(0,2),onResult:r=>streamed.push(r)},stop.signal),new Promise(resolve=>{deadline=setTimeout(()=>resolve('hung'),500);})]);clearTimeout(deadline);
 assert.notEqual(partialResult,'hung','review fanout must settle even when a child ignores cancellation');
 assert.ok(partialResult.some(r=>r.ok),'completed review survives a sibling timeout');
 assert.ok(streamed.some(r=>r.ok),'native results are delivered before the group deadline');
 const f=fixture();const results=await f.run();assert.equal(f.calls.length,3);assert.equal(results.length,6);assert.ok(results.every(r=>r.ok));
 const missingPixels=JSON.parse(results.find(r=>r.aspect==='interface').text);assert.equal(missingPixels.outcome,'unknown');assert.match(missingPixels.gap,/No captured interface image/,'source-only reviews cannot establish displayed interface behavior');
 assert.ok(results.filter(r=>r.aspect!=='interface').every(r=>JSON.parse(r.text).outcome==='pass'),'source-only non-interface reviews retain their supported passes');
 assert.deepEqual(f.calls.map(c=>assignedOf(c.params).map(a=>a.id).join()).sort(),['correctness,content','interface,delivery','security,runtime'],'6 aspects are split round-robin over 3 reviewers');
 for(const {params} of f.calls){assert.equal(params.agent,'reviewer');assert.equal(params.context,'fresh');assert.equal(params.async,false);assert.equal(params.foregroundOnly,true);assert.equal(params.toolBudget.hard,12);assert.equal(params.toolBudget.soft,10);assert.equal(params.toolBudget.block,'*');assert.equal(params.timeoutMs,REVIEW_LIMITS.deadlineMs);assert.equal(params.usageBudget.tokens.hard,REVIEW_LIMITS.tokens);assert.ok(params.usageBudget.costUsd.hard<=REVIEW_LIMITS.costUsd/3);assert.deepEqual(params.capabilityCeiling.allowedTools,['read','grep','find','ls','git_info','context_slice','symbol_expand','project_intel']);assert.match(params.task,/Current project source graph/);assert.ok(params.task.includes(JSON.stringify(root)));assert.match(params.task,/already committed/);}
 assert.equal(f.entries.filter(e=>e.customType==='subagent-lifecycle-v1').length,3);
 assert.ok(f.calls.every(c=>!c.params.capabilityCeiling.allowedTools.includes('sandbox_run')&&!c.params.capabilityCeiling.allowedTools.includes('artifact_check')),'bounded source reviewers do not spend calls on a second test environment or image headers');
 assert.ok(f.calls.every(c=>c.params.task.includes('at most 6 evidence strings')),'prompt and parser share evidence bounds');
 assert.ok(f.calls.every(c=>c.params.task.includes("'pass' requires actual source evidence and an empty gap")&&c.params.task.includes('never in gap')),'pass requires an empty gap; scope notes belong in findings or evidence');
 // Reviewers inherit the session model: no launch names a model or route.
 const inherit=fixture({model:sessionModel(['text','image'])});await inherit.run();
 assert.equal(inherit.calls.length,3);
 assert.ok(inherit.calls.every(({params})=>params.agent==='reviewer'&&!('model' in params)&&!('modelRouteCandidates' in params)&&!('modelOrigin' in params)&&!('delegatedThinkingOverride' in params)),'no launch carries a model param; reviewers run on the session model');
 const repair=fixture();
 await repair.run({...request,previousReview:{revision:1,changedFiles:['src/value.js'],reports:aspects.map(aspect=>({aspect:aspect.id,outcome:'changes',gap:'',findings:[{id:aspect.id+'-1',file:'src/value.js',detail:'Earlier blocker owned by '+aspect.id+' requires checking its repaired source contract.'}]}))}});
 assert.equal(repair.calls.length,3,'repair focus preserves all independent reviewer slots');
 for(const {params} of repair.calls){
  const assigned=assignedOf(params);
  assert.match(params.task,/bounded repair review/);assert.match(params.task,/Prior reports are historical evidence, not current approval/);
  for(const aspect of aspects)assert.equal(params.task.includes('Earlier blocker owned by '+aspect.id+' '),assigned.some(item=>item.id===aspect.id),'each reviewer gets only its own historical blockers');
 }
 const paths=fixture();
 await paths.run({...request,aspects:[aspects[0]],evidence:[' /tmp/private.png ','C:\\private.png','..\\private.png','shots/window.png']});
 assert.match(paths.calls[0].params.task,/relevant to your assigned aspects[\s\S]*\["shots\/window.png"\]/);
 assert.ok(!paths.calls[0].params.task.includes('private.png'),'dispatch applies the shared relative-path contract');
 const vision=fixture({model:sessionModel(['text','image'])});
 const visionReports=await vision.run({...request,aspects:[aspects[0],aspects[2],aspects[3]],evidence:['shots/window.png']});
 assert.match(JSON.parse(visionReports.find(r=>r.aspect==='interface').text).gap,/image-read receipts/,'source reads and self-reported passes do not verify supplied pixels');
 const ui=vision.calls.find(c=>c.params.task.includes('"id":"interface"'));
 assert.match(ui.params.task,/^Visual review/,'native acceptance pixel audit is engaged');
 assert.ok(vision.calls.every(c=>!c.params.task.includes('assigned aspects: [].')),'no empty reviewer after vision assignment');
 const visualTask='Visual review "./shots/window.png"';
 const imageCall={role:'assistant',content:[{type:'toolCall',id:'picture',name:'read',arguments:{path:'shots/window.png'}}]};
 const imageRead={role:'toolResult',toolCallId:'picture',toolName:'read',isError:false,content:[{type:'image',data:'fixture',mimeType:'image/png'}]};
 for(const messages of [[imageRead,imageCall],[{...imageRead,toolName:undefined},imageCall],[imageCall,imageRead,imageCall],[imageCall,{...imageRead,toolName:'bash'}]])assert.equal(checkVisualSourceEvidence(visualTask,messages,root).status,'failed','visual receipts require unique preceding calls and matching tool names');
 const contextTask=visualTask+'\nContext: earlier renders live in build/shots/window.png, ~/shots/window.png and https://example.test/shots/window.png; a bare path/shots/window.png is prose.';
 assert.equal(checkVisualSourceEvidence(contextTask,[imageCall,imageRead],root).status,'passed','path tails inside relative, home and URL paths are not extra required sources');
 assert.equal(checkVisualSourceEvidence(visualTask+' and /abs/other.png',[imageCall,imageRead],root).status,'failed','a real absolute image path still requires its own receipt');
 const pixelResult=async (params,{source=true,toolName='read'}={})=>{
  const imageStart={role:'assistant',content:[{type:'toolCall',id:'pixels',name:'read',arguments:{path:'shots/window.png'}}]};
  const imageResult={role:'toolResult',toolCallId:'pixels',toolName,isError:false,content:[{type:'image',data:'fixture',mimeType:'image/png'}]};
  const messages=[...(source?[start,receipt]:[]),imageStart,imageResult],check=checkVisualSourceEvidence(params.task,messages,root);
  return {details:{results:[compactForegroundResult({exitCode:0,messages,acceptance:{runtimeChecks:[check]},output:JSON.stringify({reviews:[{aspect:'interface',outcome:'pass',evidence:['shots/window.png: inspected captured interface pixels'],findings:[],gap:''}]})})]}};
 };
 const pixel=fixture({model:sessionModel(['text','image']),result:params=>pixelResult(params)});
 const pixelReports=await pixel.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']});
 assert.equal(JSON.parse(pixelReports[0].text).outcome,'pass');
 assert.match(pixel.calls[0].params.task,/FIRST read current implementing source/);
 assert.match(pixel.calls[0].params.task,/at most three representative captures/);
 const logsOnly=fixture({model:sessionModel(['text','image']),result:async params=>{
  const result=await pixelResult(params);
  result.details.results[0].reviewEvidence.sourcePaths=['build/checks.txt'];
  return result;
 }});
 const logsReport=JSON.parse((await logsOnly.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']}))[0].text);
 assert.equal(logsReport.outcome,'unknown');assert.match(logsReport.gap,/No current interface implementation/);
 const imageOnly=fixture({model:sessionModel(['text','image']),result:params=>pixelResult(params,{source:false})});
 assert.ok((await imageOnly.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']})).every(r=>!r.ok&&/source-read/.test(r.gap)),'image inspection cannot substitute for current-source review');
 const wrongTool=fixture({model:sessionModel(['text','image']),result:params=>pixelResult(params,{toolName:'bash'})});
 assert.match(JSON.parse((await wrongTool.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']}))[0].text).gap,/image-read receipts/,'image receipts must match the source-reading tool as well as its ID');
 const textOnly=fixture({result:params=>pixelResult(params)});
 const textOnlyReport=JSON.parse((await textOnly.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']}))[0].text);
 assert.equal(textOnlyReport.outcome,'unknown');assert.match(textOnlyReport.gap,/cannot receive image input/,'image attachments omitted for a text-only session model do not establish visual inspection');
 const overflow=fixture({result:async params=>({details:{results:[compactForegroundResult({exitCode:0,messages:[start,receipt],output:JSON.stringify({reviews:assignedOf(params).map(a=>({aspect:a.id,outcome:'changes',evidence:Array.from({length:9},(_,i)=>`src/value.js:${i+1} verified an actual source boundary`),findings:[{severity:'blocking',file:'src/value.js',detail:'A negative input reaches the unchecked allocation and throws.'}],gap:''}))})})]}})});
 const retained=await overflow.run();assert.ok(retained.every(r=>r.ok&&JSON.parse(r.text).findings.length===1&&JSON.parse(r.text).evidence.length===6));
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
 const one=fixture();assert.equal((await one.run({...request,aspects:[aspects[0]]})).length,1);assert.equal(one.calls.length,1,'a single aspect gets one reviewer with full coverage');
 const large=fixture({result:async()=>({details:{results:[compactForegroundResult({exitCode:0,messages:[start,receipt],output:JSON.stringify({reviews:aspects.map(a=>({aspect:a.id,outcome:'pass',evidence:Array.from({length:3},()=>`src/value.js:1 ${'specific inspected source evidence '.repeat(15)}`),findings:[],gap:''}))})})]}})});
 assert.ok((await large.run()).every(r=>r.ok),'multi-aspect JSON exceeding the prose-preview cap stays intact');
 const budgeted=fixture({result:async params=>({isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[compactForegroundResult({exitCode:1,error:'Usage budget exhausted.',messages:[start,receipt],finalOutput:JSON.stringify({reviews:assignedOf(params).map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 report was emitted after reading the current source'],findings:[],gap:''}))})})]}})});
 const budgetedResults=await budgeted.run({...request,aspects:aspects.slice(0,2)});
 assert.ok(budgetedResults.every(r=>r.ok),'a source-backed final report survives a hard usage budget wrapper failure');
 assert.ok(budgetedResults.every(r=>r.text.includes('"outcome":"unknown"')&&/usage budget was exhausted/.test(r.text)),'non-clean budget salvage carries an explicit unknown gap');
 assert.equal(budgeted.entries.at(-1).data.state,'failed','budget salvage keeps the native failure lifecycle truthful');
 const cleanBudget=fixture({result:async params=>({isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'costUsd'},results:[compactForegroundResult({exitCode:0,messages:[start,receipt],finalOutput:JSON.stringify({reviews:assignedOf(params).map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 clean terminal report checked against current source'],findings:[],gap:''}))})})]}})});
 const cleanBudgetResults=await cleanBudget.run();
 assert.ok(cleanBudgetResults.every(r=>r.ok&&JSON.parse(r.text).outcome===(r.aspect==='interface'?'unknown':'pass')),'clean child completion keeps validated source outcomes when the aggregate budget closes, without inventing interface pixels');
 const budgetInvalid=fixture({result:async()=>({isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[{exitCode:1,error:'Usage budget exhausted.',reviewEvidence:{sourceReads:1},output:'not json'}]}})});
 assert.ok((await budgetInvalid.run()).every(r=>!r.ok),'budget exhaustion never promotes malformed output to review evidence');
 const budgetSignal=fixture({result:async params=>({isError:true,details:{usageBudget:{version:1,source:'reported',exhausted:true,reason:'tokens'},results:[compactForegroundResult({exitCode:1,processSignal:'SIGTERM',messages:[start,receipt],finalOutput:JSON.stringify({reviews:assignedOf(params).map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 report followed a source read'],findings:[],gap:''}))})})]}})});
 assert.ok((await budgetSignal.run()).every(r=>!r.ok),'a signalled child is never salvaged as a budgeted review');
 const drainKill=fixture({result:async params=>({details:{results:[compactForegroundResult({exitCode:0,processSignal:'SIGTERM',messages:[start,receipt],output:JSON.stringify({reviews:assignedOf(params).map(a=>({aspect:a.id,outcome:'pass',evidence:['src/value.js:1 report preceded the post-success drain kill'],findings:[],gap:''}))})})]}})});
 const drainResults=await drainKill.run();
 assert.ok(drainResults.every(r=>r.ok),'post-success final-drain SIGTERM keeps the validated report');
 assert.equal(drainKill.entries.at(-1).data.state,'completed','drain-after-success records completed lifecycle');
 for(const value of [undefined,{details:{results:[null]}},{isError:true,details:{results:[]}},{details:{results:[{exitCode:0,stopped:true}]}}]){const bad=fixture({result:async()=>value});assert.ok((await bad.run()).every(r=>!r.ok));assert.equal(bad.entries.at(-1).data.state,'failed');}
 const brokenSink=fixture({appendThrows:true});assert.ok((await brokenSink.run()).every(r=>r.ok));
 const noRead=fixture({result:async()=>({details:{results:[{exitCode:0,messages:[],output:JSON.stringify({reviews:aspects.map(a=>({aspect:a.id,outcome:'pass',evidence:['Claim with no native successful source read'],findings:[],gap:''}))})}]}})});assert.ok((await noRead.run()).every(r=>!r.ok));assert.equal(noRead.entries.at(-1).data.state,'failed','a no-source report is not recorded as completed');
 const protocol=fixture({result:async()=>({details:{results:[{exitCode:0,reviewEvidence:{sourceReads:1},output:'<|message_model|>read<|content_invoke_tool_json|>{"path":"src/value.js"}<|end_message|>'}]}})});
 const leaked=await protocol.run({...request,aspects:[aspects[0]]});assert.ok(leaked.every(r=>!r.ok && /raw tool-protocol/.test(r.gap)));assert.equal(protocol.calls.length,1);
 const repeated=await protocol.run({...request,aspects:[aspects[0]]});assert.equal(protocol.calls.length,2,'raw tool-protocol output does not exclude the session model from later rounds');assert.ok(repeated.every(r=>/raw tool-protocol/.test(r.gap)));
 for(const end of ['switch','session_shutdown']){
  let resolve;const late=fixture({result:()=>new Promise(r=>resolve=r)});const pending=late.run({...request,aspects:[aspects[0]]});while(!resolve)await new Promise(r=>setImmediate(r));
  if(end==='switch')late.switch();else late.emit(end);
  const count=late.entries.length;resolve({details:{results:[]}});assert.ok((await pending).every(r=>!r.ok));assert.equal(late.entries.length,count,'results that land after the session ends are not written to it ('+end+')');
 }
 const stragglerLimit=REVIEW_LIMITS.stragglerMs;REVIEW_LIMITS.stragglerMs=30;
 try{
  const straggling=fixture({result:async(params,signal,ok)=>params.task.includes('"id":"interface"')?new Promise(resolve=>signal.addEventListener('abort',()=>resolve({details:{results:[{exitCode:143,stopped:true,error:'aborted'}]}}),{once:true})):ok()});
  const started=Date.now(),reports=await straggling.run({...request,aspects:aspects.slice(0,3)});
  assert.ok(Date.now()-started<REVIEW_LIMITS.deadlineMs/10,'finished peers are not held for a dead leg until the round deadline');
  assert.equal(reports.filter(r=>r.ok).length,2,'finished peers keep their validated reviews');
  const stalled=reports.find(r=>r.aspect==='interface');assert.equal(stalled.ok,false);assert.match(stalled.gap,/stopped after its peers finished/);
  assert.equal(straggling.calls.length,3,'a stopped reviewer is not relaunched');
 }finally{REVIEW_LIMITS.stragglerMs=stragglerLimit;}
 // A failed reviewer is reported once; a harness launch error names the diagnostic.
 const down=fixture({result:async()=>({details:{results:[{exitCode:1,error:'provider down'}]}})});
 const downReports=await down.run({...request,aspects:aspects.slice(0,2)});
 assert.equal(down.calls.length,2,'a failed reviewer is reported once, not relaunched');
 assert.ok(downReports.every(r=>!r.ok&&/failed or was unable to start/.test(r.gap)));
 const broken=fixture({result:async()=>({details:{results:[{exitCode:1,error:'launch',runtimeError:'ENOENT',diagnosticCode:'LAUNCH'}]}})});
 const brokenReports=await broken.run({...request,aspects:aspects.slice(0,2)});
 assert.ok(brokenReports.every(r=>!r.ok&&/Native reviewer launch failed with LAUNCH/.test(r.gap)&&/harness error/.test(r.gap)));
 assert.equal(broken.calls.length,2);
 {
  // The visual audit rejects only pixels: the source-backed report survives as an explicit unknown.
  const visualMessage='Visual review unverified: 1 of 1 named image sources have no source-correlated successful image-bearing tool receipt.';
  const salvage=fixture({model:sessionModel(['text','image']),result:async(params,signal,ok)=>{const base=ok().details.results[0];return {details:{results:[{...base,exitCode:1,error:'Acceptance rejected: '+visualMessage,acceptance:{status:'rejected',runtimeChecks:[{id:'visual-source-evidence',status:'failed',message:visualMessage}],verifyRuns:[]}}]}};}});
  const [ui]=await salvage.run({...request,aspects:[aspects[2]],evidence:['shots/window.png']});
  assert.equal(ui.ok,true,'the reviewer report is kept, not discarded as a failed launch');
  const parsed=JSON.parse(ui.text);
  assert.equal(parsed.outcome,'unknown');
  assert.match(parsed.gap,/image-read receipts/);
  assert.equal(salvage.calls.length,1,'a salvaged report needs no retry');
 }
 assert.ok(activity.includes('review')&&activity.includes('ok')&&activity.includes('error'),'native reviews report named activity with truthful success and failure outcomes');
 console.log('PASS quality review dispatch: session-model reviewer launch contracts, delegation restriction, 3 reviewers / 6 aspects, read receipts, interface pixel gaps, failure lifecycle, accounting and session isolation');
}finally{if(previousActivity===undefined)delete globalThis[activitySymbol];else globalThis[activitySymbol]=previousActivity;fs.rmSync(root,{recursive:true,force:true});}
