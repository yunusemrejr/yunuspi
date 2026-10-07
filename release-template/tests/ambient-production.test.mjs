import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ambientPlan,createAmbientFrames,skylineMask,featherMask} from '../agent/extensions/lib/ambient-frames.ts';
import {videoAmbient} from '../agent/extensions/lib/video-ambient.ts';
import {videoQa} from '../agent/extensions/lib/video-studio.ts';
import {encodeImage} from '../agent/extensions/lib/design-studio.ts';
import {run,FFMPEG_FLAGS} from '../agent/extensions/lib/media-process.ts';

test('evolving clouds change uniform sky, preserve the protected subject and remain neutral',()=>{
 const w=128,h=72,base=new Uint8Array(w*h*3).fill(110),mask=skylineMask([[0,.5],[1,.5]],w,h);
 const plan=ambientPlan({width:w,height:h,seconds:4,skyline:[[0,.5],[1,.5]],rain:0,clouds:1,cloudContrast:1,loop:true});
 const render=createAmbientFrames(base,mask,plan),start=render(0),middle=render(1);
 assert.notDeepEqual(start.subarray(0,w*35*3),middle.subarray(0,w*35*3),'a uniform image cannot gain evolution from image sliding alone');
 assert.deepEqual(middle.subarray(w*36*3),Buffer.from(base).subarray(w*36*3),'subject pixels remain exact');
 for(let i=0;i<middle.length;i+=3)assert.equal(middle[i]===middle[i+1]&&middle[i]===middle[i+2],true,'neutral artwork must not acquire a chroma cast');
 assert.deepEqual(render(4),start,'the closing visual state equals the first');
 assert.deepEqual(render(1),render(5),'all loop phases are periodic');
 assert.deepEqual(render(.7),render(.7),'arbitrary seek order cannot alter frames');
 assert.throws(()=>render(NaN),/finite/);
 const stopped=createAmbientFrames(base,mask,{...plan,cloudSpeed:0});assert.deepEqual(stopped(0),stopped(1));
});

test('rain, mist, reflected ripples and lightning share one periodic clock',()=>{
 const w=128,h=72,base=Uint8Array.from({length:w*h*3},(_,i)=>70+Math.floor(i/3)%71),mask=skylineMask([[0,.3],[1,.3]],w,h);
 const fog=skylineMask([[0,.6],[1,.6]],w,h),rain=new Uint8Array(base.length).fill(255),reflection=new Uint8Array(base.length);reflection.fill(255,w*50*3);
 const plan=ambientPlan({width:w,height:h,seconds:4,fps:24,skyline:[[0,.3],[1,.3]],fogMask:'fog.png',reflectionMask:'wet.png',rain:1,fog:.8,reflections:1,loop:true,lightning:[0,3.8]});
 const render=createAmbientFrames(base,mask,plan,{fog,rain,reflection});
 assert.deepEqual(render(0),render(4));assert.deepEqual(render(.125),render(4.125));assert.notDeepEqual(render(.125),render(1));
 assert.deepEqual(base,Uint8Array.from({length:w*h*3},(_,i)=>70+Math.floor(i/3)%71),'effects cannot mutate the input artwork');
 const blank=new Uint8Array(base.length);
 const protectedRender=createAmbientFrames(base,mask,{...plan,lightning:[],clouds:0},{fog:blank,rain:blank,reflection:blank});
 assert.deepEqual(protectedRender(1),Buffer.from(base),'zero mattes protect every pixel, including from near rain');
 assert.throws(()=>createAmbientFrames(base,mask,plan,{fog:new Uint8Array(1)}),/match/);
});

test('production plans expose work and reject missing mattes and nonperiodic loop modes',()=>{
 const base={clouds:0};
 assert.throws(()=>ambientPlan({...base,fog:1}),/fogMask/);assert.throws(()=>ambientPlan({...base,reflections:1}),/reflectionMask/);
 assert.throws(()=>ambientPlan({...base,loop:'yes'}),/boolean/);assert.throws(()=>ambientPlan({...base,loop:true,seconds:.25,fps:1}),/two frames/);
 assert.throws(()=>ambientPlan({skyline:[[0,.4],[1,.4]],loop:true,cloudModel:'drift'}),/cannot guarantee/);
 assert.equal(ambientPlan({...base,width:3840,height:2160,seconds:120,fps:60}).work.withinBudget,false,'plans can expose excess work without launching it');
 assert.equal(ambientPlan({...base,width:64,height:64,seconds:1,fps:2}).work.framePixels,8192);
});

test('loop checks reach the actual ending beyond the bounded motion window',{timeout:60000},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'ambient-loop-boundary-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const file=path.join(cwd,'broken-loop.mp4');
 await run('ffmpeg',[...FFMPEG_FLAGS,'-v','error','-f','lavfi','-i','color=c=0x222222:s=128x72:r=2:d=31','-vf',"drawbox=color=white:t=fill:enable='gte(t,30)'",'-c:v','libx264','-pix_fmt','yuv420p',file]);
 const qa=await videoQa({path:file,checkMotion:true,loop:true},cwd);
 assert.equal(qa.motionEvidence.coverage.seconds,30);assert.equal(qa.motionEvidence.coverage.complete,false);
 assert.ok(qa.motionEvidence.deliveryLoop.times.at(-1)>30);
 assert.ok(qa.motionEvidence.deliveryLoop.findings.some(f=>f.id==='delivery-loop-boundary'),'an ending outside the proxy window cannot certify a seamless delivery');
});

test('matte edges fade inward without creating halos over protected pixels',()=>{
 const input=new Uint8Array(16*8*3);for(let y=0;y<8;y++)input.fill(255,(y*16+8)*3,(y*16+16)*3);
 const result=featherMask(input,16,8,4);
 for(let y=0;y<8;y++){assert.deepEqual(result.subarray(y*16*3,(y*16+8)*3),input.subarray(y*16*3,(y*16+8)*3));assert.ok(result[(y*16+8)*3]<result[(y*16+10)*3]);assert.equal(result[(y*16+12)*3],255);}
 assert.equal(input[(2*16+8)*3],255,'feathering does not mutate the authored matte');
});

test('native delivery exposes comparison frames, real decoded cadence and its actual loop boundary',{timeout:60000},async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'ambient-production-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const w=128,h=72,data=new Uint8Array(w*h*4);
 for(let i=0;i<data.length;i+=4){const x=(i/4)%w;data[i]=90+x/4;data[i+1]=100+x/4;data[i+2]=110+x/4;data[i+3]=255;}
 await fs.writeFile(path.join(cwd,'plate.png'),await encodeImage({width:w,height:h,data},'png'));
 const delivery=await videoAmbient({action:'render',plate:'plate.png',width:w,height:h,seconds:2,fps:12,skyline:[[0,.5],[1,.5]],clouds:1,rain:.7,loop:true,stage:'final'},cwd);
 assert.equal(delivery.loopClosed,true);assert.equal(delivery.reviewFrames[0].seconds,0);assert.equal(delivery.reviewFrames.at(-1).seconds,23/12);assert.ok((await fs.stat(delivery.contactSheet)).size>0);
 const qa=await videoQa({path:delivery.output},cwd);
 assert.equal(qa.motionEvidence.frames,24);assert.equal(qa.motionEvidence.timing.irregularIntervals,0);assert.equal(qa.motionEvidence.coverage.complete,true);assert.equal(qa.motionEvidence.deliveryLoop.findings.length,0);
 assert.equal(qa.reviewStatus,'unreviewed','decoded motion never confers artistic approval');assert.equal(qa.passedAutomatedChecks,true,JSON.stringify(qa.findings));
 const bad=path.join(cwd,'wrong-mask.png');await fs.writeFile(bad,await encodeImage({width:1,height:1,data:new Uint8Array([255,255,255,255])},'png'));
 await assert.rejects(videoAmbient({action:'plan',plate:'plate.png',width:w,height:h,clouds:0,fog:1,fogMask:bad},cwd),/pixel canvas/);
 await assert.rejects(videoAmbient({action:'render',plate:'plate.png',width:w,height:h,seconds:2,fps:12,clouds:0,rain:0,stage:'final',maxFramePixels:4096},cwd),/Render work/);
});
