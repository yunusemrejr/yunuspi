import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/continuation-notice.ts')));
const schema='data:text/javascript,'+encodeURIComponent('export const Type=new Proxy({}, {get:()=>()=>({})});');
register('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`),import.meta.url);
const load=file=>import(pathToFileURL(path.join(agent,'extensions',file)));
const {composeNotice,stripNoticeFooters,collectVerificationReceipts,registerContinuationSource,CONTINUATION_SOURCES}=await load('lib/continuation-notice.ts');
const {default:noticeExtension}=await load('continuation-notice.ts');
const {createProjectTestLifecycle}=await load('lib/project-tests.ts');
const {clipRationale}=await load('lib/tool-schema.ts');

const receipt=(id,extra={})=>({source:'quality-review',id,revision:'3',state:'unresolved',count:2,line:`quality review: ${id} long guidance addressed to the agent`,brief:`quality review: ${id}`,...extra});

test('a hand-off turn announces the continuation once and reports no verification',()=>{
 const input={continuation:['background tasks: Render film (b84f) will automatically resume this session when it finishes'],pendingMessages:false,receipts:[receipt('awaiting')],memory:{}};
 const first=composeNotice(input);
 assert.match(first.text,/Session continues after this answer/);
 assert.match(first.text,/Render film/);
 assert.ok(!first.text.includes('Verification'),'verification is expected to be open while work continues');
 assert.equal(composeNotice({...input,memory:first.memory}).text,'','an unchanged continuation is not repeated');
 const changed=composeNotice({...input,continuation:['background tasks: Encode audio (c9) will automatically resume this session when it finishes'],memory:first.memory});
 assert.match(changed.text,/Encode audio/);
 const queued=composeNotice({continuation:[],pendingMessages:true,receipts:[],memory:{}});
 assert.match(queued.text,/queued follow-up messages/);
});

test('a final answer reports each distinct open-verification set once, in reader wording',()=>{
 const input={continuation:[],pendingMessages:false,receipts:[receipt('awaiting_assessment'),{source:'project-tests',id:'need:missing',revision:'3',state:'unresolved',count:2,line:'project tests: Current checks unresolved (missing); command exits do not establish user-visible behavior.',brief:'project tests: planned checks have not passed since the latest change'}],memory:{}};
 const first=composeNotice(input);
 assert.match(first.text,/^\n\n---\n⚠️ Verification open:\n- quality review: awaiting_assessment\n- project tests: planned checks/);
 assert.ok(!first.text.includes('guidance addressed to the agent'),'the footer shows the brief, never the agent-facing text');
 assert.ok(!/quality_review\(|call /.test(first.text),'no instruction to the agent appears in the footer');
 assert.equal(composeNotice({...input,memory:first.memory}).text,'','an unchanged set is silent on the next final');
 const advanced=composeNotice({...input,receipts:[{...input.receipts[0],revision:'4'},input.receipts[1]],memory:first.memory});
 assert.match(advanced.text,/Verification open/,'a new revision is new information');
 const cleared=composeNotice({...input,receipts:[],memory:first.memory});
 assert.equal(cleared.text,'');
 assert.match(composeNotice({...input,memory:cleared.memory}).text,/Verification open/,'a gap that returns after being resolved is reported again');
});

test('verification skipped during a hand-off is still reported at the real end of the work',()=>{
 const base={receipts:[receipt('pending')],pendingMessages:false};
 const handoff=composeNotice({...base,continuation:['subagents: 1 delegated run is still active'],memory:{}});
 assert.ok(!handoff.text.includes('Verification'));
 const end=composeNotice({...base,continuation:[],memory:handoff.memory});
 assert.match(end.text,/Verification open/,'the hand-off did not consume the verification report');
 assert.equal(composeNotice({...base,continuation:['subagents: 1 delegated run is still active'],memory:end.memory}).text.includes('Session continues'),true,'a new hand-off after the end is announced again');
});

test('footers are stripped from agent text in both the current and the earlier wording, leaving prose intact',()=>{
 const current='All three charts are rendered and checked.\n\n---\n⚠️ Verification open:\n- quality review: reviewers finished, not yet accepted\n- project tests: checks still running';
 const legacy='Done.\n\n---\n⚠️ Verification incomplete (harness receipts):\n- quality review: Independent review awaiting_assessment: current reviewer reports are complete.\nThese are verification limits, not evidence of a product defect. Preserve completed checks and report any remaining blocker.\n\n---\n⚠️ Continuation pending — this session will keep running after this answer:\n- background tasks: Render (b84f) will automatically resume this session when it finishes\nThis notice is automatic; user instructions still govern what runs.';
 const hand='Waiting on the render.\n\n---\n⏳ Session continues after this answer:\n- background tasks: Render (b84f) will resume it';
 assert.equal(stripNoticeFooters({role:'assistant',content:current}).content,'All three charts are rendered and checked.');
 assert.equal(stripNoticeFooters({role:'assistant',content:legacy}).content,'Done.');
 assert.equal(stripNoticeFooters({role:'assistant',content:hand}).content,'Waiting on the render.');
 const parts=stripNoticeFooters({role:'assistant',content:[{type:'text',text:'Answer.'},{type:'text',text:'\n\n---\n⚠️ Verification open:\n- project tests: checks still running'}]});
 assert.deepEqual(parts.content,[{type:'text',text:'Answer.'}],'a footer that is its own text part is removed');
 const echoed='The review is waiting.\n\n---\n⚠️ Verification incomplete (harness receipts):\n- quality review: Independent review awaiting_assessment\nThese are verification limits, not product defects.\n\nNext I will inspect the render.';
 assert.equal(stripNoticeFooters({role:'assistant',content:echoed}).content,'The review is waiting.\n\nNext I will inspect the render.','prose that follows a copied footer survives');
});

test('stripping never mutates, never touches other roles and never leaves a message empty',()=>{
 const message={role:'assistant',content:[{type:'text',text:'Answer.\n\n---\n⚠️ Verification open:\n- x: y'},{type:'toolCall',id:'1',name:'bash',arguments:{}}]};
 const frozen=structuredClone(message);
 const clean=stripNoticeFooters(message);
 assert.deepEqual(message,frozen);
 assert.equal(clean.content[0].text,'Answer.');
 assert.deepEqual(clean.content[1],message.content[1]);
 const user={role:'user',content:'---\n⚠️ Verification open:\n- keep this: user text'};
 assert.equal(stripNoticeFooters(user),user);
 const only={role:'assistant',content:'\n\n---\n⚠️ Verification open:\n- x: y'};
 assert.equal(stripNoticeFooters(only),only,'a message that is only a footer is kept as written');
 const plain={role:'assistant',content:'Nothing to strip.'};
 assert.equal(stripNoticeFooters(plain),plain,'unchanged messages keep their identity');
});

test('the extension writes the footer for the reader and removes it from every model request',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  const hooks={},session={};
  registerContinuationSource({name:'quality review',session,pending:()=>[],verificationReceipts:()=>[receipt('pending')]});
  noticeExtension({on:(name,fn)=>hooks[name]=fn});hooks.session_start();
  const ctx={sessionManager:session,hasPendingMessages:()=>false};
  const event={message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Done.'}]}};
  const shown=hooks.message_end(event,ctx).message;
  assert.match(shown.content.map(x=>x.text).join('\n'),/Verification open/);
  assert.equal(hooks.message_end(event,ctx),undefined,'unchanged open verification is not repeated');
  const request=[{role:'user',content:'Do it.'},shown];
  const result=hooks.context({messages:request},ctx);
  assert.equal(result.messages[1].content.map(x=>x.text).join(''),'Done.','the agent never reads the footer');
  assert.ok(request[1].content.length===2,'the transcript keeps the footer');
  assert.equal(hooks.context({messages:[{role:'user',content:'Hi'}]},ctx),undefined,'a request with no footer is left alone');
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

test('verification receipts carry a bounded reader brief and stay distinct from the agent-facing line',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  const session={};
  registerContinuationSource({name:'deploy',session,pending:()=>[],verificationReceipts:()=>[{source:'deploy',id:'d1',state:'unverified',line:'deploy: compare sha256',brief:'x'.repeat(400)}]});
  const [item]=collectVerificationReceipts(4,session);
  assert.ok(item.brief.length<=110);
  assert.equal(item.line,'deploy: compare sha256');
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

async function projectFixture(t){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'test-adopt-')),tools={},sent=[];
 const ctx={cwd,isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getBranch:()=>[]}};
 const api=createProjectTestLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['project_tests','bash'],appendEntry(){},sendMessage:(...args)=>sent.push(args)});
 t.after(()=>{api.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 await api.restore(ctx);api.input({source:'interactive',text:'Fix the parser and verify it'});
 const edit=async value=>{fs.writeFileSync(path.join(cwd,'parser.js'),`export const value=${value};`);await api.result({toolName:'write',toolCallId:`write-${value}`,input:{path:'parser.js'},isError:false},ctx);};
 const run=async(command,id,{exitCode=0,text='# tests 1\n# pass 1'}={})=>{const event={toolName:'bash',toolCallId:id,input:{command}};await api.call(event,ctx);await api.result({...event,isError:false,details:{exitCode},content:[{type:'text',text}]},ctx);};
 return {api,ctx,tools,sent,edit,run};
}

test('a test runner that passed after the latest change is adopted as the verification plan without a model turn',async t=>{
 const f=await projectFixture(t);
 await f.edit(1);
 assert.equal(f.api.snapshot().need,'assessment');
 await f.run('node --test','pass');
 const snapshot=f.api.snapshot();
 assert.equal(snapshot.need,null,'the agent already ran the check; recording it is bookkeeping');
 assert.equal(snapshot.assessment.disposition,'required');
 assert.match(snapshot.assessment.reason,/Adopted from observed runs/);
 assert.equal(snapshot.assessment.adopted,true);
 assert.deepEqual(snapshot.assessment.checks.map(c=>c.label),['node --test']);
 await f.api.settled({},f.ctx);
 assert.equal(f.sent.length,0,'no automatic follow-up asks the agent to restate what it just did');
 await f.edit(2);
 assert.equal(f.api.snapshot().need,'assessment','a later edit invalidates the adopted plan');
});

test('adoption needs every observed runner to have passed and never overrides an explicit assessment',async t=>{
 const failed=await projectFixture(t);
 await failed.edit(1);await failed.run('node --test','fail',{exitCode:1,text:'# fail 1'});
 assert.equal(failed.api.snapshot().need,'assessment','a failing run is not verification');
 await failed.api.settled({},failed.ctx);
 assert.equal(failed.sent.length,1,'the agent is still told to deal with it');

 const empty=await projectFixture(t);
 await empty.edit(1);await empty.run('node --test','none',{text:'# tests 0\n# pass 0'});
 assert.equal(empty.api.snapshot().need,'assessment','a run that executed no tests proves nothing');

 const mixed=await projectFixture(t);
 await mixed.edit(1);await mixed.run('node --test a.test.js','a');
 assert.equal(mixed.api.snapshot().need,null);
 await mixed.run('node --test b.test.js','b',{exitCode:1,text:'# fail 1'});
 assert.equal(mixed.api.snapshot().need,'failed','a later failing runner reopens the adopted plan instead of hiding behind the first pass');
 await mixed.run('node --test b.test.js','b2');
 assert.equal(mixed.api.snapshot().need,null,'and a later pass of it closes the plan again');

 const explicit=await projectFixture(t);
 await explicit.edit(1);
 await explicit.tools.project_tests.execute('assess',{action:'assess',disposition:'required',reason:'The wider suite must pass for this parser change.',commands:['node --test tests/wide.test.js']},undefined,undefined,explicit.ctx);
 await explicit.run('node --test','narrow');
 assert.equal(explicit.api.snapshot().need,'missing','the agent’s own plan stays authoritative: the narrow run does not satisfy it');
});

test('project test rationales longer than the owner keeps are clipped, not refused',async t=>{
 const f=await projectFixture(t);
 await f.edit(1);
 const long=`Verdict first. ${'The parser change only touches the tokenizer branch. '.repeat(80)}Final evidence last.`;
 await f.tools.project_tests.execute('assess',{action:'assess',disposition:'not_needed',reason:long},undefined,undefined,f.ctx);
 const reason=f.api.snapshot().assessment.reason;
 assert.ok(reason.length<=1200);
 assert.ok(reason.startsWith('Verdict first.'));assert.ok(reason.endsWith('Final evidence last.'));assert.ok(reason.includes('[…]'));
 assert.equal(clipRationale('short enough',1200),'short enough');
});
