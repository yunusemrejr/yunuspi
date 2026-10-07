import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateToolArguments } from '@yunuspi/ai';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>syncFs.existsSync(path.join(p,'extensions/lib/video-compose.ts')));
const load=p=>import(pathToFileURL(path.join(agent,p)).href);
const math=await load('skills/remotion-video/assets/template/src/production.ts');
const video=await load('extensions/lib/video-studio.ts'),compose=await load('extensions/lib/video-compose.ts');
const shots=await load('extensions/lib/video-shot.ts'),library=await load('extensions/lib/motion-library.ts');
const {fileDigest,videoFingerprint}=await load('extensions/lib/video-segments.ts');
const art=await load('extensions/lib/video-art.ts'),blender=await load('extensions/lib/blender-studio.ts');
const workspace=async t=>{const p=await fs.mkdtemp(path.join(os.tmpdir(),'motion-quality-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;};

test('delivery identity ignores transient shot locks and staging but binds published pixels',async t=>{
  const dir=await workspace(t),folder=path.join(dir,'public','shots');
  await fs.mkdir(path.join(folder,'hero'),{recursive:true});
  const frame=path.join(folder,'hero','frame-0001.png');
  await fs.writeFile(frame,'published pixels');
  const before=await videoFingerprint(dir,{fps:30});
  await fs.writeFile(path.join(folder,'hero.lock'),'process coordination');
  const staging=path.join(folder,'.hero-render-0123456789');await fs.mkdir(staging);
  await fs.writeFile(path.join(staging,'frame-0001.png'),'unfinished replacement');
  assert.equal(await videoFingerprint(dir,{fps:30}),before);
  await fs.rm(path.join(folder,'hero.lock'));await fs.rm(staging,{recursive:true});
  assert.equal(await videoFingerprint(dir,{fps:30}),before);
  await fs.writeFile(frame,'changed published pixels');
  assert.notEqual(await videoFingerprint(dir,{fps:30}),before);
});

test('held and linear keys keep exact cuts; per-key easing controls the following interval',()=>{
  assert.equal(math.keyed([{t:0,x:0,easing:'linear'},{t:1,x:1}],.25,{x:0}).x,.25);
  assert.equal(math.keyed([{t:0,x:0,easing:'hold'},{t:1,x:1}],.999,{x:0}).x,0);
  assert.equal(math.keyed([{t:0,x:0,easing:'hold'},{t:1,x:1}],1,{x:0}).x,1);
  assert.equal(math.keyed([{t:0,x:0},{t:1,x:1}],.5,{x:0},'linear').x,.5);
  assert.equal(math.keyed([{t:0,x:0,easing:'snappy'},{t:1,x:1}],.5,{x:0}).x,.9375);
});

test('curved travel, perspective, squash and exits survive arbitrary seek order',()=>{
  const m={enter:'none',at:1,duration:2,easing:'linear',route:[[0,0],[.2,-.1],[.4,.1],[.6,0]],orient:true,keys:[{t:0,scaleX:.8,scaleY:1.2,rotateY:15,blur:3},{t:3,scaleX:1,scaleY:1,rotateY:0,blur:0}],exit:{cue:'leave',duration:.5,to:'wipe'}};
  const cues={leave:3.5};
  const final=math.layerPose(3,m,cues,16/9);
  for(const t of [4,0,2.5,.5,1.1])math.layerPose(t,m,cues,16/9);
  assert.deepEqual(math.layerPose(3,m,cues,16/9),final);
  assert.equal(final.x,.6);assert.equal(final.y,0);assert.equal(final.scaleX,1);assert.equal(final.rotateY,0);
  assert.equal(math.layerPose(4,m,cues).reveal,0);
  assert.ok(math.bezierPoint([[0,0],[1,1],[1,1],[2,2]],.5,2).angle<45,'orientation accounts for non-square pixels in normalized space');
});

test('font fitting splits long Unicode words, keeps content and bounds measurement work',()=>{
  let calls=0;const measure=(s,size)=>{calls++;return Array.from(s).length*size*.6;};
  const text='A verylongunbrokenwordwith🙂unicode';
  const fitted=math.fitLines(text,180,130,measure,220);
  assert.equal(fitted.overflow,false);assert.ok(fitted.size>=14&&fitted.size<220);
  assert.equal(fitted.lines.join('').replace(/\s/g,''),text.replace(/\s/g,''));
  assert.ok(calls<1000,'binary search stays bounded');
  assert.equal(math.fitLines('cannot fit',1,1,measure,100).overflow,true);
});

test('native contracts reject malformed geometry, exits, counters and word timing before writing',()=>{
  const layer={id:'title',kind:'text',box:[.1,.1,.8,.8],text:'A clear signal',reveal:'words',wordTimes:[.2,.4,.7],motion:{enter:'none'}};
  const good={id:'beat',seconds:3,component:'StudioScene',props:{layers:[layer]}};
  assert.deepEqual(compose.validateProductionScene(good),[]);
  for(const patch of [{text:123},{subjectFit:false},{wordTimes:[.2,.1,.7]},{motion:{keys:[null]}},{motion:{exit:{cue:'missing'}}},{motion:{keys:[{t:0,easing:'invented'}]}},{kind:'path',path:{points:[[0,0],[Infinity,1]]}},{kind:'counter',value:{from:0,to:10,decimals:99}},{motion:{route:[[0,0],[1,1]]}}]) {
    const result=compose.validateProductionScene({...good,props:{layers:[{...layer,...patch}]}});
    assert.ok(result.some(i=>i.severity==='error'),JSON.stringify(patch));
  }
  const poor={...good,seconds:1,props:{layers:[{...layer,wordTimes:[.1,.3,.9],motion:{enter:'none',exit:{at:.8,duration:.1}}}]}};
  assert.ok(compose.validateProductionScene(poor).some(i=>/reading time/.test(i.message)));
});

test('critical review frames cover cue boundaries and the real last frame at 60 fps',()=>{
  const raw={id:'a',seconds:1,component:'StudioScene',cues:{leave:.8},props:{layers:[{id:'x',kind:'text',text:'Read',box:[0,0,1,1],motion:{at:.1,duration:.2,exit:{cue:'leave',duration:.1}}}]}};
  const times=compose.productionTimes(raw,60);
  assert.ok(times.includes(59/60));assert.ok(times.includes(47/60)&&times.includes(48/60)&&times.includes(49/60));
  const strip=video.criticalReviewTimes({...raw,start:0,end:1},raw,60);assert.equal(strip.at(-1),59/60);
  const cueWords={...raw,cues:{first:.1,last:.85},props:{layers:[{wordCues:['first','last'],motion:{enter:'none'}}]}};
  assert.ok(video.criticalReviewTimes({...cueWords,start:0,end:1},cueWords,60).includes(51/60),'last cue-driven word gets a review frame');
  assert.doesNotThrow(()=>video.criticalReviewTimes({...raw,start:0,end:1},{props:{layers:[null,{motion:{keys:[null]},wordTimes:'invalid'}]}},60));
});

test('every native storyboard can be discovered, copied and composed without custom code',async t=>{
  const dir=await workspace(t),film=path.join(dir,'film');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal'},dir);
  const matches=await library.searchMotion('kinetic typography words','native',12);assert.ok(matches.matches.some(m=>m.id==='native/kinetic-words'));
  for(const example of (await library.motionCatalog()).filter(e=>e.approach==='native')) {
    const copied=await library.copyMotionExample({dir:film,id:example.id},dir);
    assert.match(copied.copied,/^storyboard\/.*\.json$/);
    const result=await video.videoProject({action:'compose',dir:film,storyboard:copied.copied},dir);
    assert.ok(result.scenes.length);assert.equal(result.issues.some(i=>i.severity==='error'),false);
  }
});

test('template upgrades preserve modified compositor sources and unrelated project files',async t=>{
  const dir=await workspace(t),film=path.join(dir,'film');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal'},dir);
  const target=path.join(film,'src/scenes/StudioScene.tsx');await fs.appendFile(target,'\n// my authored compositor\n');
  await fs.writeFile(path.join(film,'src/scenes/MyScene.tsx'),'my scene');
  const plan=await video.videoProject({action:'upgrade',dir:film},dir);assert.deepEqual(plan.conflicts,['src/scenes/StudioScene.tsx']);
  await assert.rejects(video.videoProject({action:'upgrade',dir:film,apply:true},dir),/Modified compositor/);
  assert.match(await fs.readFile(target,'utf8'),/my authored/);assert.equal(await fs.readFile(path.join(film,'src/scenes/MyScene.tsx'),'utf8'),'my scene');
});

test('shot promotion rolls back sequence and editable source when the second rename fails',async t=>{
  const dir=await workspace(t),old=path.join(dir,'shot'),staged=path.join(dir,'stage'),blend=path.join(dir,'edit.blend');
  await fs.mkdir(old);await fs.mkdir(staged);await fs.writeFile(path.join(old,'frame'),'old');await fs.writeFile(path.join(staged,'frame'),'new');await fs.writeFile(blend,'old blend');
  await assert.rejects(shots.publishShot(staged,old,path.join(dir,'missing.blend'),blend),/ENOENT/);
  assert.equal(await fs.readFile(path.join(old,'frame'),'utf8'),'old');assert.equal(await fs.readFile(blend,'utf8'),'old blend');
  assert.ok(!(await fs.readdir(dir)).some(f=>f.includes('previous')));
});

test('shot cache verifies all frame, anchor and editable bytes even with retained size and timestamp',async t=>{
  const dir=await workspace(t),blend=path.join(dir,'scene.blend');
  for(const name of ['frame-0001.png','frame-0002.png','anchors.json'])await fs.writeFile(path.join(dir,name),'abcd');
  await fs.writeFile(blend,'blend');
  const manifest={frames:2,cache:{fingerprint:'key',files:await shots.shotDigests(dir,2),editable:await fileDigest(blend)}};
  assert.equal(await shots.verifyShotCache(dir,blend,manifest,'key'),true);
  const frame=path.join(dir,'frame-0002.png'),stat=await fs.stat(frame);await fs.writeFile(frame,'efgh');await fs.utimes(frame,stat.atime,stat.mtime);
  assert.equal(await shots.verifyShotCache(dir,blend,manifest,'key'),false);
});

test('final 3D plans retain 4K pixels, validate budgets and distinguish planar cameras',()=>{
  assert.equal(shots.planShot({mode:'final',seconds:1},{width:3840,height:2160,fps:30}).width,3840);
  for(const p of [{fps:NaN},{width:-1},{seconds:-1},{samples:0},{fps:29.97},{projection:'orthographic',rig:'push-in'}])assert.throws(()=>shots.planShot(p,{}));
  assert.equal(shots.planShot({projection:'orthographic',rig:'static'},{}).mode,'preview');
});

test('asset evidence survives malformed scene and layer containers without hiding structural findings',async t=>{
  const dir=await workspace(t);
  assert.deepEqual(await art.inspectVideoAssets(dir,{scenes:[null,{props:{layers:[null]}}]}),{assets:[],issues:[]});
  assert.deepEqual(await art.inspectVideoAssets(dir,{scenes:'invalid'}),{assets:[],issues:[]});
});

test('video QA binds perceptual attestations to current files and does not approve motion from stills',{timeout:90000},async t=>{
  try{await exec('ffmpeg',['-version']);}catch{if(process.env.PI_REQUIRE_MEDIA_TEST==='1')throw Error('FFmpeg required');t.skip('FFmpeg unavailable');return;}
  const dir=await workspace(t),film=path.join(dir,'film');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal',fps:60,width:160,height:90},dir);
  await video.videoProject({action:'compose',dir:film,scenes:[{id:'one',seconds:1,layers:[{id:'shape',kind:'shape',box:[.1,.1,.8,.8]}]}]},dir);
  const file=path.join(film,'proof.mp4');
  await exec('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=red:s=160x90:r=60:d=1','-vf',"drawbox=color=blue:t=fill:enable='eq(n,59)'",'-c:v','libx264','-pix_fmt','yuv420p',file]);
  const report=await video.videoQa({path:file,dir:film},dir);assert.equal(report.reviewStatus,'unreviewed');assert.ok(report.report);
  const last=report.frames.at(-1);assert.ok(Math.abs(last.seconds-59/60)<1e-6);
  const pixel=await exec('ffmpeg',['-v','error','-i',last.path,'-vf','crop=1:1:80:45','-pix_fmt','rgb24','-f','rawvideo','-'],{encoding:'buffer'});
  assert.ok(pixel.stdout[2]>200&&pixel.stdout[0]<40,'the actual final blue frame is sampled, not the earlier red frame');
  await assert.rejects(video.videoQa({action:'record',path:file,report:report.report,reviews:[{criterion:'motion',verdict:'pass',evidence:'frames',note:'Looks fine'}]},dir),/need playback/);
  const partial=await video.videoQa({action:'record',path:file,report:report.report,reviews:[{criterion:'composition',verdict:'pass',evidence:'frames',note:'The test frame is visible'}]},dir);
  assert.equal(partial.reviewStatus,'partial');assert.equal(partial.deliveryReady,false);
  await fs.appendFile(path.join(film,'src/scenes/StudioScene.tsx'),'\n// changed revision');
  assert.equal((await video.videoQa({action:'status',path:file,report:report.report},dir)).reviewStatus,'stale');
  await assert.rejects(video.videoQa({action:'record',path:file,report:report.report,reviews:[{criterion:'typography',verdict:'pass',evidence:'frames',note:'old'}]},dir),/stale/);
});

test('tool contracts expose the native choreography, safe upgrade and independent review actions',async()=>{
  const tools=new Map();(await load('extensions/video-studio.ts')).default({registerTool:d=>tools.set(d.name,d)});
  const valid=(name,args)=>validateToolArguments(tools.get(name),{type:'toolCall',id:'fixture',name,arguments:args});
  assert.doesNotThrow(()=>valid('video_project',{action:'compose',dir:'.',scenes:[{id:'a',seconds:3,layers:[{kind:'path',path:{points:[[0,0],[1,1]],draw:true},box:[0,0,1,1],motion:{easing:'linear',exit:{at:2,to:'wipe'},keys:[{t:0,rotateY:15,scaleX:.8,easing:'hold'}]}}]}]}));
  assert.doesNotThrow(()=>valid('video_project',{action:'upgrade',dir:'.',apply:true}));
  assert.doesNotThrow(()=>valid('video_project',{action:'compose',dir:'.',scenes:[{id:'art',seconds:2,layers:[{id:'hero',kind:'shot',shot:'art',box:[0,0,1,1],subjectFit:false}]}]}));
  assert.doesNotThrow(()=>valid('video_shot',{dir:'.',name:'a',projection:'orthographic',reuse:true}));
  assert.doesNotThrow(()=>valid('video_shot',{dir:'.',name:'art',scene:{objects:[{id:'cutout',shape:'image-plane',image:'public/assets/art.png',lit:false}]}}));
  assert.doesNotThrow(()=>valid('video_qa',{action:'record',path:'video.mp4',report:'qa.json',reviews:[{criterion:'audio',verdict:'pass',evidence:'listening',note:'Ending heard'}]}));
});

test('video projects preserve and refresh the complete creative brief without inventing a second owner',async t=>{
  const dir=await workspace(t),film=path.join(dir,'film');
  const {normalizeDirection}=await load('extensions/lib/creative-direction.ts');
  const direction=normalizeDirection({name:'Rain study',intent:['cinematic'],signature:'a detailed painted kiosk',hierarchy:{primary:'kiosk',secondary:'quiet typography'},visual:{texture:'wet painted steel',depth:'layered valley'},references:['reference.png']});
  await fs.mkdir(path.join(dir,'.pi'));await fs.writeFile(path.join(dir,'.pi/creative-direction.json'),JSON.stringify(direction));
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal'},dir);
  const original=JSON.parse(await fs.readFile(path.join(film,'video.json'),'utf8'));
  assert.deepEqual(original.direction,direction);
  direction.signature='an illustrated umbrella';await fs.writeFile(path.join(dir,'.pi/creative-direction.json'),JSON.stringify(direction));
  assert.equal((await video.videoProject({action:'direction',dir:film},dir)).direction.signature,direction.signature);
});

test('asset inspection catches missing pixels and makes unfinished hero assets visible',async t=>{
  const dir=await workspace(t);await fs.mkdir(path.join(dir,'public'));
  const spec={width:1920,height:1080,scenes:[{id:'a',props:{layers:[{id:'hero',kind:'image',src:'missing.png',box:[0,0,1,1],asset:{stage:'blockout',description:'replace silhouette'}}]}}]};
  const result=await art.inspectVideoAssets(dir,spec);
  assert.ok(result.issues.some(i=>i.severity==='error'&&/missing.png/.test(i.message)));
  assert.ok(result.issues.some(i=>/explicit blockout/.test(i.message)));assert.equal(result.assets[0].stage,'blockout');
});

test('local reference bytes and recorded frame bytes independently invalidate QA', {timeout:90000}, async t=>{
  const dir=await workspace(t),film=path.join(dir,'film');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal',fps:30,width:160,height:90},dir);
  await video.videoProject({action:'compose',dir:film,scenes:[{id:'one',seconds:1,layers:[{id:'shape',kind:'shape',box:[.1,.1,.8,.8]}]}]},dir);
  const file=path.join(film,'proof.mp4'),ref=path.join(dir,'reference.png');
  await exec('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=blue:s=160x90:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p',file]);
  await fs.writeFile(ref,'reference bytes');
  const spec=JSON.parse(await fs.readFile(path.join(film,'video.json'),'utf8'));spec.direction={references:[ref]};await fs.writeFile(path.join(film,'video.json'),JSON.stringify(spec));
  const report=await video.videoQa({path:file,dir:film},dir);
  await assert.rejects(video.videoQa({action:'record',path:file,report:report.report,reviews:[{criterion:'art-direction',verdict:'pass',evidence:'frames',note:'An unsupported reference match'}]},dir),/every inspected reference/);
  assert.equal((await video.videoQa({action:'record',path:file,report:report.report,reviews:[{criterion:'art-direction',verdict:'unreviewed',evidence:'frames',note:'Reference not inspected'}]},dir)).deliveryReady,false);
  await fs.writeFile(ref,'changed reference bytes');assert.equal((await video.videoQa({action:'status',path:file,report:report.report},dir)).stale,true);
  const fresh=await video.videoQa({path:file,dir:film},dir);await fs.appendFile(fresh.frames[0].path,'tampered');
  assert.equal((await video.videoQa({action:'status',path:file,report:fresh.report},dir)).stale,true);
});

test('missing pinned font faces cancel rendering instead of silently approving fallback type',async()=>{
  const {fontsSource}=await load('extensions/lib/video-looks.ts');
  const vm=await import('node:vm');
  for (const source of [fontsSource([{package:'example',family:'Example',weights:[400]}]),await fs.readFile(path.join(agent,'skills/remotion-video/assets/template/src/fonts.ts'),'utf8')]) {
    let continued=false,cancelled;
    vm.runInNewContext(source.replace(/^import .*;$/gm,''),{document:{fonts:{load:async()=>[]}},delayRender:()=>1,continueRender:()=>continued=true,cancelRender:e=>cancelled=e});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(continued,false);assert.match(cancelled.message,/Missing font face/);
  }
});

test('video import retains generated lineage and full 4K source pixels', {timeout:90000},async t=>{
  const dir=await workspace(t),film=path.join(dir,'film'),source=path.join(dir,'art.png');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal',width:3840,height:2160},dir);
  await exec('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=blue:s=3840x2160','-frames:v','1',source]);
  const registry=await load('extensions/lib/asset-registry.ts');
  const original=await registry.registerAsset({path:source,kind:'generated',role:'hero-focal',prompt:'original distant atmosphere',license:'user-owned'},dir);
  const imported=await (await load('extensions/lib/video-assets.ts')).videoAssets({action:'import',dir:film,path:source,name:'atmosphere'},dir);
  assert.equal(imported.width,3840);assert.equal(imported.height,2160);assert.equal(imported.assetId,original.record.id);
  const manifest=JSON.parse(await fs.readFile(path.join(film,'public/assets/assets.json'),'utf8'))[0];
  assert.equal(manifest.assetKind,'generated');assert.equal(manifest.originAssetId,original.record.id);assert.equal(manifest.license,'user-owned');
  const record=(await registry.readRegistry(dir)).assets.find(a=>a.id===imported.assetId);
  assert.equal(record.kind,'generated');assert.equal(record.prompt,original.record.prompt);assert.ok(record.usage.includes('film/video.json'));
  const licensed=path.join(dir,'licensed.png');
  await exec('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=orange:s=64x64','-frames:v','1',licensed]);
  await registry.registerAsset({path:licensed,kind:'authored',role:'illustration',license:'CC BY 4.0',creator:'Fixture Artist',sourceUrl:'https://example.com/original',licenseUrl:'https://creativecommons.org/licenses/by/4.0/'},dir);
  const credited=await (await load('extensions/lib/video-assets.ts')).videoAssets({action:'import',dir:film,path:licensed,name:'licensed',title:'Licensed artwork'},dir);
  assert.equal(credited.attributionRequired,true);
  const credits=JSON.parse(await fs.readFile(path.join(film,'video.json'),'utf8')).publish.credits.join('\n');
  assert.match(credits,/Fixture Artist/);assert.match(credits,/example.com\/original/);
});

test('image-plane cards preserve alpha, pack artwork, and keep old shots on cancellation', {skip:!blender.blenderBinary()||process.env.YUNUSPI_SKIP_BLENDER_RENDER==='1',timeout:180000},async t=>{
  const dir=await workspace(t),film=path.join(dir,'film');
  await video.videoProject({action:'init',dir:film,install:false,intent:'personal',width:192,height:108,fps:2},dir);
  const image=path.join(film,'public/card.png');await fs.mkdir(path.dirname(image),{recursive:true});
  await exec('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=blue:s=64x64,format=rgba','-vf',"geq=r='if(lt(X,32),255,0)':g=0:b='if(lt(X,32),0,255)':a='if(lt(X,32),255,0)'",'-frames:v','1',image]);
  const request={dir:film,name:'card',scene:{objects:[{id:'art',shape:'image-plane',image:'public/card.png',size:[2,.01,2],lit:false}]},projection:'orthographic',rig:'static',azimuth:0,elevation:0,seconds:1,mode:'final',samples:8,shadow:'none'};
  const result=await shots.videoShot(request,dir),frame=path.join(film,'public/shots/card/frame-0001.png');
  const {decodeImage}=await load('extensions/lib/design-studio.ts');const pixels=await decodeImage(await fs.readFile(frame));
  const alpha=[];for(let i=3;i<pixels.data.length;i+=4)alpha.push(pixels.data[i]);assert.ok(alpha.some(a=>a>200)&&alpha.some(a=>a===0),'opaque artwork and transparent cutout remain distinct');
  const inspected=await blender.blenderRun({blend:path.join(film,result.editable),code:"import bpy,json\nprint('YUNUSPI_RESULT '+json.dumps({'packed':any(i.packed_file for i in bpy.data.images if i.name.endswith('card.png'))}))"},dir);
  assert.equal(inspected.result.packed,true);
  const manifest=path.join(film,'public/shots/card/shot.json'),before=await fileDigest(manifest);
  const abort=new AbortController();setTimeout(()=>abort.abort(Error('test cancellation')),200);
  await assert.rejects(shots.videoShot({...request,replace:true,reuse:false},dir,abort.signal));
  assert.equal(await fileDigest(manifest),before);
  assert.ok(!(await fs.readdir(path.join(film,'public/shots'))).some(n=>n.includes('-render-')));
});
