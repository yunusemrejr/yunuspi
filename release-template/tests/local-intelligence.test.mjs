import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/local-intelligence.mjs')));
const load=relative=>import(pathToFileURL(path.join(agent,relative)));
const local=await load('extensions/lib/local-intelligence.mjs');
const mini=await load('extensions/lib/mini-preprocessor.ts');
const {outputLineDelta}=await load('extensions/lib/output-distiller.ts');
const {addCompactionSalience,makeCapsule}=await load('extensions/pi-memory/context-salience.ts');
const {finalizeSingleOutput}=await load('extensions/pi-subagents/src/runs/shared/single-output.ts');
const {default:observations}=await load('extensions/pi-observations.ts');
// Deterministic observation pins: Jev chunk selection needs ambient network
// and is covered by its own mocked tests in jev-client.test.mjs.
process.env.PI_JEV="off";
const filler='General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.';
const auth='Authentication timeout originates inside the login request handler during credential lookup.';
const cache='Cache initialization allocates storage for frequently accessed application content during startup.';
const fact='Verification remains blocked; do not deploy. The failure is in src/auth.ts:42 and the timeout is 500 ms.';
const report=[filler,...Array(7).fill(filler),auth,cache,fact,...Array(7).fill(filler),filler].join('\n\n');
const runtime={version:1,enabled:true,endpoint:'http://127.0.0.1:18736/select',apiKey:'TEST_MINI_PREPROCESSOR_KEY_1234567890'};

test('selection preserves exact critical and relevant blocks with reversible source ranges',()=>{
  const source=local.evidenceBlocks(report), selected=local.selectEvidence(report,'authentication timeout',2000);
  assert(selected);assert(selected.savedChars>2000);
  const exact=selected.ids.map(i=>report.slice(...source.spans[i])).join('\n\n');
  assert.equal(selected.text.slice(selected.text.indexOf('\n')+1),exact);
  assert(selected.text.includes(auth));assert(selected.text.includes(fact));assert(!selected.text.includes(cache));
  assert(selected.ids.includes(0));assert(selected.ids.includes(source.blocks.length-1));
  assert.equal(local.selectEvidence(report,'completely unrelated vocabulary',2000),undefined);
  assert.equal(local.selectEvidence(report.replace(fact,fact.repeat(8)),'authentication timeout',800),undefined,'critical overflow abstains');
  for(const raw of [report+'\n```code```',report+'é',report.replaceAll('\n\n','\n'),report.repeat(30)]) assert.equal(local.selectEvidence(raw,'authentication',6000),undefined);
  const markdown=report.replace(auth,`## Findings\n\n- ${auth}\n- ${fact}`);
  const md=local.selectEvidence(markdown,'authentication',2000);assert(md);assert(md.text.includes(`## Findings\n\n- ${auth}\n- ${fact}`));
});

test('decisions, file evidence and failed hypotheses survive capsule budget pressure',()=>{
  const items=[{id:'decision',kind:'decision',text:'Use the embedded database.'},{id:'file',kind:'file',text:'src/store.ts was changed.'},{id:'failure',kind:'failure',text:'Rejected retry hypothesis; cause unknown.'},{id:'verification',kind:'finding',text:'The regression tests passed.'}];
  const capsule=makeCapsule(items,'Investigate login',1500);
  assert.equal(capsule.decisions.length,1);assert.equal(capsule.files.length,1);assert.equal(capsule.failures.length,1);assert(capsule.findings.includes('The regression tests passed.'));
  assert.throws(()=>makeCapsule([{...items[0],text:'a'.repeat(2000)}],'Investigate',1000),/Critical/);
});

test('Kompress uses task-conditioned IDs and cannot reuse another task selection',async()=>{
  const raw=[filler,auth,cache,...Array(7).fill(filler)].join('\n\n');
  let calls=0,now=0;
  const client=mini.createMiniPreprocessor({runtime,now:()=>now,fetch:async()=>{calls++;return new Response(JSON.stringify({version:1,status:'SELECT',sourceHash:mini.miniSource(raw).hash,keep:[0]}));}});
  const login=await client.select(raw,5,'authentication timeout');assert(login.keep.includes(1));assert(!login.keep.includes(2));
  assert.deepEqual(await client.select(raw,5,'timeout authentication'),login);assert.equal(calls,1,'keyword order does not invalidate a task cache');
  now=10000;const startup=await client.select(raw,5,'cache initialization');assert(startup.keep.includes(2));assert(!startup.keep.includes(1));
  assert.equal(calls,2);assert.deepEqual(await client.select(raw,5,'authentication timeout'),login);assert.equal(calls,2);
  client.reset();assert.equal(client.inspect().cached,0);
  now=20000;assert.equal(await client.select(raw,5,'general authentication cache'),undefined);assert.equal(calls,2,'task retention overflow prevents unnecessary inference');
});

test('pre-compaction reduces actual input while preserving source, tool pairing and prior summary',()=>{
  const user={role:'user',content:'Investigate authentication timeout'};
  const result={role:'toolResult',toolName:'bash',toolCallId:'call',isError:false,content:[{type:'text',text:report}],details:{exitCode:0,piObservation:{version:1,id:17}}};
  const assistant={role:'assistant',content:[{type:'toolCall',id:'call',name:'bash',arguments:{command:'fixture'}}]};
  const event={branchEntries:[{type:'message',id:'u',message:user},{type:'message',id:'o',message:result}],preparation:{messagesToSummarize:[user,assistant,result],previousSummary:'No Docker; use SQLite.'}};
  const before=JSON.stringify(event.preparation).length;
  assert(addCompactionSalience(event,true));assert.equal(addCompactionSalience(event,true),false);
  assert(JSON.stringify(event.preparation).length<before-1000);
  assert.equal(event.preparation.messagesToSummarize[0],user);assert.equal(event.preparation.messagesToSummarize[1],assistant);
  const projected=event.preparation.messagesToSummarize[2];assert.equal(projected.toolCallId,'call');assert.equal(projected.details,result.details);
  assert(projected.content[0].text.includes('obs_read({id:17})'));assert(projected.content[0].text.includes(fact));
  assert.equal(result.content[0].text,report);assert.equal(event.preparation.previousSummary,'No Docker; use SQLite.');
  for(const override of [{isError:true},{details:{truncated:true,piObservation:{version:1,id:17}}}]) {
    const original={...result,...override};const e={...event,preparation:{messagesToSummarize:[original]}};
    addCompactionSalience(e,true);assert.equal(e.preparation.messagesToSummarize[0],original);
  }
  const noReader={...event,preparation:{messagesToSummarize:[result]}};addCompactionSalience(noReader,false);assert.equal(noReader.preparation.messagesToSummarize[0],result);
  const oversized={...event,branchEntries:[...event.branchEntries,{type:'message',id:'new',message:{role:'user',content:'different request '.repeat(2000)}}],preparation:{messagesToSummarize:[result]}};
  addCompactionSalience(oversized,true);assert.equal(oversized.preparation.messagesToSummarize[0],result,'unknown latest task cannot reuse older selection cues');
});

test('child selection requires successful persisted output and retains the complete file reference',()=>{
  const params={fullOutput:report,task:'authentication timeout',savedPath:'/tmp/example-child-report.md',exitCode:0};
  const result=finalizeSingleOutput(params);assert(result.displayOutput.length<report.length);assert(result.displayOutput.includes(auth));assert(result.displayOutput.includes(fact));assert(result.displayOutput.includes(params.savedPath));
  assert.equal(params.fullOutput,report);
  assert.equal(finalizeSingleOutput({...params,savedPath:undefined}).displayOutput,report);
  assert.equal(finalizeSingleOutput({...params,exitCode:1}).displayOutput,report);
  assert.equal(finalizeSingleOutput({...params,outputMode:'file-only'}).displayOutput,result.outputReference.message);
});

test('sparse exact deltas retain PID, metrics, polarity and ordering changes',()=>{
  const lines=Array.from({length:100},(_,i)=>`status record ${i}: ${'background '.repeat(8)}`);
  lines[0]='PID 12345 server running';lines[50]='requests: 1184 memory: 381 MB';
  const before=lines.join('\n');lines[0]='PID 49301 server not running';lines[50]='requests: 1192 memory: 383 MB';[lines[80],lines[81]]=[lines[81],lines[80]];
  const after=lines.join('\n'),delta=outputLineDelta(before,after);assert(delta);
  let reconstructed=before;for(const edit of delta.edits.slice().reverse())reconstructed=reconstructed.slice(0,edit.offset)+edit.insert+reconstructed.slice(edit.offset+edit.deleteChars);
  assert.equal(reconstructed,after);assert(JSON.stringify(delta).length<after.length/4);
  assert.equal(outputLineDelta(before,after+'\nextra'),undefined);
});

test('error-family similarity preserves error type and negation',()=>{
  const a='TypeError: request_id=abc failed at /tmp/build-a/src.js:42:3 during authentication lookup';
  const b='TypeError: request_id=xyz failed at /tmp/build-b/src.js:91:8 during authentication lookup';
  assert(local.failureSimilarity(a,b)>=.85);
  assert.equal(local.failureSimilarity(a,b.replace('TypeError','RangeError')),0);
  assert.equal(local.failureSimilarity(a,b.replace('failed','not failed')),0);
  assert.equal(local.failureSimilarity('HTTP 401 authentication failed','HTTP 403 authentication failed'),0);
});

test('ranking splits source identifiers and uses corpus rarity without duplicate-keyword rewards',()=>{
  assert(local.taskTerms('providerFailureState backoffPolicy').includes('backoff'));
  const scores=local.relevanceScores(['common parser lexer','common drawing canvas','common common common'],'parser common');
  assert(scores[0]>scores[1]);assert.deepEqual(local.relevanceScores(['parser parser parser'],'parser'),local.relevanceScores(['parser'],'parser'));
  const related=local.candidateRelevance(['policy backoffPolicy','policy colorPalette'],'retry policy');assert(related[0]>related[1]);
});

test('online reliability decays evidence and reports uncertainty instead of treating missing data as success',()=>{
  const now=1000000,half=10000;
  const fresh=local.estimateReliability(Array.from({length:8},()=>({at:now,ok:true})),now,half);
  const stale=local.estimateReliability(Array.from({length:8},()=>({at:now-half*8,ok:false})),now,half);
  assert.equal(fresh.support,8);assert(fresh.failureRate<.2);assert(fresh.failureUpper>fresh.failureRate);
  assert(stale.support<1);assert(stale.failureRate<.6);
  assert.equal(local.estimateReliability([],now,half).failureRate,.5);
  assert.equal(local.estimateReliability([{at:now+1,ok:false}],now,half).support,0);
});

test('observation hook proposes near predecessors but exposes exact changes and branch-scoped originals',async()=>{
  const handlers={},tools={},branch=[];
  const pi={on:(name,fn)=>handlers[name]=fn,registerTool:tool=>tools[tool.name]=tool,registerCommand(){},getActiveTools:()=>['read','bash','obs_read']};
  observations(pi,{reset(){},endTurn(){},select:async()=>undefined});
  const ctx={sessionManager:{getEntries:()=>branch,getBranch:()=>branch}};
  handlers.session_start({},ctx);handlers.before_agent_start({prompt:'Investigate authentication timeout'});
  const before=Array.from({length:100},(_,i)=>`record ${i}: ordinary background monitoring server process counters resources input output memory network storage capacity endpoint cache snapshot request duration`).join('\n');
  const after=before.replace('record 0','PID 49301 record 0').replace('record 50','not running record 50');
  const add=async(raw,path,isError=false)=>{
    const event={toolName:'read',input:{path},content:[{type:'text',text:raw}],isError};
    const patch=await handlers.tool_result(event,ctx),message={...event,role:'toolResult',details:patch.details};
    branch.push({type:'message',id:String(branch.length),message});handlers.message_end({message});return message;
  };
  const first=await add(before,'/tmp/old-status.txt'),second=await add(after,'/tmp/new-status.txt');
  const projected=(await handlers.context({messages:[first,second]},ctx)).messages;
  assert.equal(projected[0],first);assert(projected[1].content[0].text.includes('"baselineObservation":1'));
  const delta=JSON.parse(projected[1].content[0].text.split('\n').at(-1));
  let restored=before;
  for(const edit of (delta.edits??[delta]).slice().reverse())restored=restored.slice(0,edit.offset)+edit.insert+restored.slice(edit.offset+edit.deleteChars);
  assert.equal(restored,after);assert.equal(second.content[0].text,after);
  assert.equal((await tools.obs_read.execute('id',{id:2},undefined,undefined,ctx)).content[0].text,after);
  const failed=await add(`TypeError: request_id=abc failed at /tmp/build-a/src.js:42:3. ${filler.repeat(3)}`,'/tmp/a',true);
  const again=await add(`TypeError: request_id=xyz failed at /tmp/build-b/src.js:91:8. ${filler.repeat(3)}`,'/tmp/b',true);
  const failures=(await handlers.context({messages:[failed,again]},ctx)).messages;
  assert.equal(failures[1].content[0].text,again.content[0].text);assert(failures[1].content[1].text.includes('Related historical failure'));
  branch.splice(0,branch.length,branch.at(-1));handlers.session_tree({},ctx);
  await assert.rejects(tools.obs_read.execute('id',{id:3},undefined,undefined,ctx),/unavailable/);
  assert.equal(await handlers.context({messages:[again]},ctx),undefined,'a hidden branch failure cannot become a match');
});

test('skill instructions remain full reads rather than dedup pointers after compaction', async () => {
  const handlers={},branch=[];
  observations({on:(name,fn)=>handlers[name]=fn,registerTool(){},registerCommand(){},getActiveTools:()=>['read','obs_read']},{reset(){},select:async()=>undefined});
  const ctx={sessionManager:{getEntries:()=>branch,getBranch:()=>branch}};
  handlers.session_start({},ctx);
  const body='Workflow instructions and exact constraints. '.repeat(100);
  const event={toolName:'read',input:{path:'/fixture/php/SKILL.md'},content:[{type:'text',text:body}],isError:false};
  for(let i=0;i<2;i++) {
    assert.equal(handlers.tool_result(event,ctx),undefined,'full instructions reach the skill receipt and model');
    branch.push({type:'message',message:{...event,role:'toolResult'}});
    handlers.session_compact({},ctx);
  }
  const legacy={role:'toolResult',toolName:'read',toolCallId:'skill-read',content:event.content,details:{piObservation:{version:1,id:1,signature:'legacy',operation:'legacy'}}};
  const call={role:'assistant',content:[{type:'toolCall',id:'skill-read',name:'read',arguments:event.input}]};
  const messages=[call,legacy];
  assert.equal(await handlers.context({messages},ctx),undefined,'legacy full skill bodies are not distilled');
});
