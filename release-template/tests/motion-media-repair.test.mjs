import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ambientPlan, createAmbientFrames, skylineMask } from '../agent/extensions/lib/ambient-frames.ts';
import { videoAmbient } from '../agent/extensions/lib/video-ambient.ts';
import { videoQa } from '../agent/extensions/lib/video-studio.ts';
import { blenderWorker } from '../agent/extensions/lib/blender-studio.ts';
import { encodeImage, decodeImage } from '../agent/extensions/lib/design-studio.ts';
import { measureFrameColor } from '../agent/extensions/lib/video-color-evidence.ts';
import { installVideoReviewEvidence, mediaReviewReceipt, mediaReviewWaiverIntent } from '../agent/extensions/lib/video-review-evidence.ts';
import { collectVerificationReceipts } from '../agent/extensions/lib/continuation-notice.ts';
import { completionGateReceipts } from '../agent/extensions/lib/completion-gate.ts';
import { goalCompletionGate, createGoal, recordEvidence, complete, reopenRejectedGoal } from '../agent/extensions/lib/goal-state.ts';
import { visionModel } from '../agent/extensions/lib/image-understand.ts';

async function workspace(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(),'yunuspi-media-repair-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir; }
test('RGB atmosphere preserves stationary detail and neutral pixels; absolute-time rain is deterministic', () => {
  const plan=ambientPlan({width:64,height:64,seconds:2,clouds:0,rain:0}), base=new Uint8Array(64*64*3).fill(92);
  const render=createAmbientFrames(base,undefined,plan);
  assert.deepEqual(render(0),Buffer.from(base)); assert.deepEqual(render(1.7),Buffer.from(base));
  const rain=createAmbientFrames(base,undefined,{...plan,rain:1});
  assert.deepEqual(rain(.8),rain(.8)); assert.notDeepEqual(rain(.8),rain(1.2));
  const mask=new Uint8Array(base.length); mask.fill(255,0,64*24*3);
  const sky=createAmbientFrames(Uint8Array.from(base,(_,i)=>i%251),mask,{...plan,clouds:1,cloudSpeed:10});
  assert.deepEqual(sky(2).subarray(64*24*3),sky(0).subarray(64*24*3),'station/terrain stay exact');
  assert.notDeepEqual(sky(2).subarray(0,64*24*3),sky(0).subarray(0,64*24*3),'masked clouds move');
  assert.throws(()=>ambientPlan({clouds:1}),/skyMask/);
  assert.throws(()=>ambientPlan({clouds:0,width:65}),/even/);
  assert.equal(ambientPlan({clouds:0,seconds:.25,fps:1}).seconds,1,'timeline is quantized to at least one frame');
  const boundary=skylineMask([[0,.4],[1,.4]],64,64);
  assert.equal(boundary[(32*64+20)*3],0,'skyline cannot move the foreground');
  assert.throws(()=>ambientPlan({skyline:[[0,.2],[.8,.5]]}),/skyline/);
});

test('an encoded RGB plate remains neutral instead of becoming magenta', {timeout:60000}, async t => {
  const cwd=await workspace(t), data=new Uint8Array(64*64*4).fill(255);
  for(let i=0;i<data.length;i+=4){data[i]=90;data[i+1]=100;data[i+2]=110;}
  await fs.writeFile(path.join(cwd,'plate.png'),await encodeImage({width:64,height:64,data},'png'));
  const result=await videoAmbient({action:'render',plate:'plate.png',width:64,height:64,seconds:1,fps:6,clouds:0,rain:0,stage:'final'},cwd);
  const decoded=await decodeImage(await fs.readFile(result.detailFrame));
  const color=measureFrameColor(decoded.data);
  assert.equal(color.magentaFraction,0); assert.ok(color.meanRgb.every((v,i)=>Math.abs(v-[90,100,110][i])<5),JSON.stringify(color));
  assert.equal(result.decodeVerified,true); assert.equal(result.deliveryReady,false);
  assert.equal(result.plan.frames,6); assert.equal(result.direction.camera,'locked');
  const qa=await videoQa({path:result.output},cwd);
  assert.equal(qa.reviewStatus,'unreviewed'); assert.equal(qa.colorEvidence.samples.length,12);
  const status=await videoQa({action:'status',path:result.output,report:qa.report},cwd);
  assert.equal(status.stale,false);
  const hooks=new Map(), manager={getSessionId:()=> 'waiver-fixture',getBranch:()=>[]},ctx={cwd,sessionManager:manager};
  const ledger=installVideoReviewEvidence({on:(name,fn)=>hooks.set(name,fn),appendEntry(){}});
  await hooks.get('session_start')({},ctx);hooks.get('before_agent_start')({prompt:'create a video'},ctx);
  await ledger.observe('video_qa',{},qa,ctx);
  await hooks.get('input')({source:'extension',text:'Skip video review.'},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].requiresUserWaiver,true);
  await hooks.get('input')({source:'interactive',text:'Skip video review.'},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].requiresUserWaiver === true,false);
  const originalReport=await fs.readFile(qa.report),edited=JSON.parse(originalReport);edited.reviewStatus='passed';
  await fs.writeFile(qa.report,JSON.stringify(edited));await ledger.refresh(ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].state,'stale','raw QA metadata edits cannot approve delivery');
  await assert.rejects(ledger.assertVisualReviews({action:'record',path:result.output,report:qa.report,reviews:[]},ctx),/changed outside/);
  await fs.writeFile(qa.report,originalReport);await ledger.refresh(ctx);
  const recipe=JSON.parse(await fs.readFile(result.request,'utf8'));recipe.plan.rain=.5;
  await fs.writeFile(result.request,JSON.stringify(recipe));
  assert.equal((await videoQa({action:'status',path:result.output,report:qa.report},cwd)).stale,true,'editing the native recipe invalidates a review');
  await hooks.get('tool_call')({toolName:'goal',input:{action:'complete'}},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].requiresUserWaiver,true,'edited bytes revoke the human waiver');
  hooks.get('session_shutdown')();
  const replacement=path.join(cwd,'replacement.mp4');await fs.copyFile(result.output,replacement);
  await videoQa({action:'supersede',path:result.output,report:qa.report,replacement,reason:'The earlier take was rejected for its color and detail.'},cwd);
  assert.equal((await videoQa({action:'status',path:result.output,report:qa.report},cwd)).deliveryReady,false);
  await assert.rejects(videoQa({action:'record',path:result.output,report:qa.report,reviews:[{criterion:'composition',verdict:'pass',evidence:'frames',note:'Intentional composition'}]},cwd),/superseded/);
  const preview=await videoAmbient({action:'preview',plate:'plate.png',width:64,height:64,seconds:.25,fps:1,clouds:0,rain:0},cwd);
  assert.equal(preview.plan.frames,1);
  assert.equal((await videoQa({path:preview.output},cwd)).passedAutomatedChecks,false,'a preview cannot become delivery-approved');
});

test('measured RGB evidence flags the color defect without pretending to judge intentional art', () => {
  const bad=measureFrameColor(new Uint8Array([150,4,180,255,125,0,140,255]));
  assert.equal(bad.magentaFraction,1);
  assert.equal(measureFrameColor(new Uint8Array([30,60,90,255])).magentaFraction,0);
});

test('media completion cannot be waived by repeated agent calls, including settled goal prose', () => {
  const row={path:'/tmp/film.mp4',report:'/tmp/qa.json',identity:{video:'v1'},reviewStatus:'unreviewed'};
  const receipt=mediaReviewReceipt(row), refused=new Set();
  const first=completionGateReceipts('plan-complete',[receipt],refused); refused.add(first.key);
  assert.equal(completionGateReceipts('plan-complete',[receipt],refused).block,true);
  let goal=createGoal('Create a film'); for(const c of goal.criteria) goal=recordEvidence(goal,c.id,'met','render.mp4: file decodes, exit 0').goal;
  assert.equal(goalCompletionGate(goal,{unverifiedWrites:0,refused,verification:[receipt]}).block,true);
  assert.equal(mediaReviewReceipt({...row,deliveryReady:true}),undefined);
});

test('a direct correction reopens completion evidence without resuming paused goals or ordinary questions', () => {
  const old=complete(createGoal('Create a detailed animation'),false);
  const revised=reopenRejectedGoal(old,'This is terrible. Remake it with the requested detail.');
  assert.equal(revised.id,old.id); assert.equal(revised.status,'active'); assert.ok(revised.criteria.every(c=>c.status==='open' && !c.evidence));
  assert.equal(reopenRejectedGoal(old,'What format is the video?'),undefined);
  assert.equal(reopenRejectedGoal({...old,status:'paused'},'Fix this'),undefined);
});

test('media receipts remain scoped to the producing session and restored passes are stale', async t => {
  const hooks=new Map(), entries=[], manager={getSessionId:()=> 'one',getBranch:()=>entries},ctx={cwd:await workspace(t),sessionManager:manager};
  const pi={on:(name,fn)=>hooks.set(name,fn),appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
  const ledger=installVideoReviewEvidence(pi);
  await hooks.get('session_start')({},ctx);
  hooks.get('before_agent_start')({prompt:'create a calming video'},ctx);
  await ledger.observe('video_qa',{}, {path:path.join(ctx.cwd,'film.mp4'),report:path.join(ctx.cwd,'qa.json'),reviewStatus:'unreviewed'},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].requiresUserWaiver,true);
  assert.equal(collectVerificationReceipts(32,{}).some(r=>r.source==='media production'),false);
  await ledger.observe('video_qa',{}, {path:path.join(ctx.cwd,'film.mp4'),report:path.join(ctx.cwd,'qa.json'),reviewStatus:'passed',deliveryReady:true},ctx);
  assert.equal(collectVerificationReceipts(32,manager).length,0);
  await hooks.get('session_start')({},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].state,'stale');
  for(let n=0;n<18;n++) await ledger.observe('video_qa',{}, {path:path.join(ctx.cwd,`pending-${n}.mp4`),report:path.join(ctx.cwd,`qa-${n}.json`),reviewStatus:'unreviewed'},ctx);
  assert.equal(collectVerificationReceipts(32,manager).length,19,'pending clips survive a long session');
  await ledger.observe('video_qa',{}, {path:path.join(ctx.cwd,'film.mp4'),report:path.join(ctx.cwd,'qa.json'),supersededBy:{path:path.join(ctx.cwd,'replacement.mp4')}},ctx);
  const receipts=collectVerificationReceipts(32,manager);
  assert.ok(!receipts.some(r=>r.id.endsWith('/film.mp4')));assert.ok(receipts.some(r=>r.id.endsWith('/replacement.mp4')));
  hooks.get('session_shutdown')();
});

test('only a direct explicit human waiver releases the current review scope', () => {
  assert.equal(mediaReviewWaiverIntent('Skip audio review for this delivery.'),true);
  assert.equal(mediaReviewWaiverIntent('Do not skip audio review.'),false);
  assert.equal(mediaReviewWaiverIntent('Can you review the audio?'),false);
  const row={path:'/tmp/film.mp4',report:'/tmp/qa.json',identity:{video:'v1'},reviewStatus:'partial'};
  const waived={...row,userWaiver:{identity:row.identity,report:row.report,reviewStatus:row.reviewStatus}};
  assert.equal(mediaReviewReceipt(waived).requiresUserWaiver,false);
  assert.equal(mediaReviewReceipt({...waived,stale:true}).requiresUserWaiver,true);
  assert.equal(mediaReviewReceipt({...waived,identity:{video:'v2'}}).requiresUserWaiver,true);
});

test('resumed media goals adopt earlier native QA and short corrections retain review debt', async t => {
  const hooks=new Map(), entries=[{type:'custom',customType:'goal-state-v1',data:{text:'Create a mountain video',status:'active',createdAt:1}},
    {type:'message',timestamp:new Date().toISOString(),message:{role:'toolResult',toolName:'video_qa',details:{format:'yunuspi-video-qa-v2',path:'/tmp/earlier-film.mp4',report:'/tmp/earlier-qa.json',reviewStatus:'unreviewed'}}}];
  const manager={getSessionId:()=> 'upgraded-session',getBranch:()=>entries},ctx={cwd:await workspace(t),sessionManager:manager};
  installVideoReviewEvidence({on:(name,fn)=>hooks.set(name,fn),appendEntry(){}});
  await hooks.get('session_start')({},ctx);hooks.get('before_agent_start')({prompt:'This is terrible. Fix it.'},ctx);
  assert.equal(collectVerificationReceipts(32,manager)[0].id,'/tmp/earlier-film.mp4');
  assert.equal(collectVerificationReceipts(32,manager)[0].requiresUserWaiver,true);
  hooks.get('session_shutdown')();
});

test('visual passes require current film and reference pixels rather than text-only QA metadata', async t => {
  const hooks=new Map(),manager={getSessionId:()=> 'pixel-witness',getBranch:()=>[]},ctx={cwd:await workspace(t),sessionManager:manager,model:{input:['text']}};
  const ledger=installVideoReviewEvidence({on:(name,fn)=>hooks.set(name,fn),appendEntry(){}});
  await hooks.get('session_start')({},ctx);
  const result={format:'yunuspi-video-qa-v2',path:path.join(ctx.cwd,'film.mp4'),report:path.join(ctx.cwd,'qa.json'),identity:{video:'v1'},evidence:[{sha256:'film-pixels'}],references:[{kind:'local',sha256:'reference-pixels'}],reviewStatus:'unreviewed'};
  await ledger.observe('video_qa',{},result,ctx);
  const record={action:'record',path:result.path,report:result.report,reviews:[{criterion:'art-direction',verdict:'pass'}]};
  await assert.rejects(ledger.assertVisualReviews(record,ctx),/current QA pixels/);
  hooks.get('tool_result')({toolName:'image_understand',details:{observations:'Visible film detail',images:[{hash:'film-pixels'}]}},ctx);
  await assert.rejects(ledger.assertVisualReviews(record,ctx),/reference pixels/);
  hooks.get('tool_result')({toolName:'image_understand',details:{observations:'Visible reference',images:[{hash:'reference-pixels'}]}},ctx);
  await ledger.assertVisualReviews(record,ctx);
  await ledger.observe('video_qa',{},result,ctx);
  await assert.rejects(ledger.assertVisualReviews(record,ctx),/current QA pixels/,'a fresh QA scope needs fresh pixel delivery');
  hooks.get('session_shutdown')();
});

test('direct user rejection invalidates an earlier pass until the delivered bytes change', async t => {
  const hooks=new Map(),manager={getSessionId:()=> 'rejection-scope',getBranch:()=>[]},ctx={cwd:await workspace(t),sessionManager:manager};
  const ledger=installVideoReviewEvidence({on:(name,fn)=>hooks.set(name,fn),appendEntry(){}});
  await hooks.get('session_start')({},ctx);hooks.get('before_agent_start')({prompt:'Create a video'},ctx);
  const result={path:path.join(ctx.cwd,'film.mp4'),report:path.join(ctx.cwd,'qa.json'),identity:{video:'v1'},reviewStatus:'passed',deliveryReady:true};
  await ledger.observe('video_qa',{},result,ctx);assert.equal(collectVerificationReceipts(32,manager).length,0);
  await hooks.get('input')({source:'interactive',text:'This video is terrible. Fix it.'},ctx);
  await ledger.observe('video_qa',{},result,ctx);
  assert.match(collectVerificationReceipts(32,manager)[0].state,/user rejection/);
  await ledger.observe('video_qa',{}, {...result,identity:{video:'v2'}},ctx);
  assert.equal(collectVerificationReceipts(32,manager).length,0);
  hooks.get('session_shutdown')();
});

test('vision accepts exact qualified ids, refuses ambiguity and never changes the current model', () => {
  const a={provider:'vision-a',id:'org/vision',input:['text','image']},b={...a,provider:'vision-b'},current={provider:'text',id:'plain',input:['text']};
  const ctx={model:current,modelRegistry:{find:()=>undefined,getAvailable:()=>[a,b]}};
  assert.equal(visionModel({model:'vision-a/org/vision'},ctx),a);
  assert.throws(()=>visionModel({model:'org/vision'},ctx),/ambiguous/);
  assert.equal(ctx.model,current);
});

test('large Blender receipts survive bounded stdout and the private transport files are removed', {timeout:60000}, async t => {
  const cwd=await workspace(t), fake=path.join(cwd,'blender'), marker=path.join(cwd,'transport.txt');
  await fs.writeFile(fake,`#!/usr/bin/env node\nconst fs=require('node:fs');const request=process.argv.at(-1);const r=JSON.parse(fs.readFileSync(request));fs.writeFileSync(${JSON.stringify(marker)},request+'\\n'+r.resultFile);fs.writeFileSync(r.resultFile,JSON.stringify({ok:true,objects:Array.from({length:900},(_,i)=>({name:'object-'+i,keys:'x'.repeat(512)}))}));console.log('YUNUSPI_RESULT '+JSON.stringify({ok:true,resultWritten:true}));\n`,{mode:0o700});
  const previous=process.env.YUNUSPI_BLENDER; process.env.YUNUSPI_BLENDER=fake;
  try { const result=await blenderWorker({op:'inspect'},{cwd,timeoutMs:30000}); assert.equal(result.objects.length,900); }
  finally { previous===undefined?delete process.env.YUNUSPI_BLENDER:process.env.YUNUSPI_BLENDER=previous; }
  for(const file of (await fs.readFile(marker,'utf8')).split('\n')) await assert.rejects(fs.stat(file),/ENOENT/);
});
