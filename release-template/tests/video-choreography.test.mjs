import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateToolArguments } from '@yunuspi/ai';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>syncFs.existsSync(path.join(p,'extensions/lib/video-compose.ts')));
const load=p=>import(pathToFileURL(path.join(agent,p)).href);
const math=await load('skills/remotion-video/assets/template/src/production.ts');
const compose=await load('extensions/lib/video-compose.ts'),video=await load('extensions/lib/video-studio.ts');
const shots=await load('extensions/lib/video-shot.ts'),blender=await load('extensions/lib/blender-studio.ts');
const browser=await load('extensions/lib/video-browser.ts'),assets=await load('extensions/lib/video-assets.ts');
const music=await load('extensions/lib/music-score.ts');
const workspace=async t=>{const p=await fs.mkdtemp(path.join(os.tmpdir(),'video-choreography-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;};

test('projected screens map all four authored corners, including perspective and edge-on failure',()=>{
  const points=[{x:40,y:80},{x:620,y:40},{x:560,y:380},{x:80,y:420}];
  const m=math.screenMatrix(1280,720,points);assert.ok(m);
  for(const [i,[x,y]] of [[0,[0,0]],[1,[1280,0]],[2,[1280,720]],[3,[0,720]]]){
    const w=m[3]*x+m[7]*y+m[15];
    assert.ok(Math.abs((m[0]*x+m[4]*y+m[12])/w-points[i].x)<1e-7);
    assert.ok(Math.abs((m[1]*x+m[5]*y+m[13])/w-points[i].y)<1e-7);
  }
  assert.equal(math.screenMatrix(1280,720,points.map(()=>({x:1,y:1}))),null);
});

test('native layouts reserve text/media regions for both orientations and short beats',()=>{
  for(const spec of [{width:1920,height:1080},{width:1080,height:1920}])for(const layout of ['hero-left','hero-right','screen','full']){
    const {scenes,issues}=compose.compileStoryboard([{id:'beat',seconds:.5,layout,headline:'Make the next step clear',kicker:'ONE PURPOSE',footer:'Begin here',hero:{kind:'shape',color:'#cc4411'}}],spec);
    assert.equal(issues.some(i=>i.severity==='error'),false,JSON.stringify(issues));
    const [text,,hero]=scenes[0].props.layers;
    const overlap=Math.max(0,Math.min(text.box[0]+text.box[2],hero.box[0]+hero.box[2])-Math.max(text.box[0],hero.box[0]))*Math.max(0,Math.min(text.box[1]+text.box[3],hero.box[1]+hero.box[3])-Math.max(text.box[1],hero.box[1]));
    assert.equal(overlap,0,`${layout}: reserved regions`);
  }
  assert.throws(()=>compose.compileStoryboard([{id:'a',seconds:2,layers:[{id:'a',kind:'video',src:'../private.mp4',box:[0,0,1,1]}]}],{}),/relative public/);
  assert.throws(()=>compose.compileStoryboard([{id:'a',seconds:2,layers:[{id:'a',kind:'text',text:'A',box:[0,0,1,1],motion:{cue:'missing'}}]}],{}),/missing cue/);
  assert.deepEqual(compose.validateProductionScene(null),[]);
});

test('choreography seeks independently, follows measured cues and settles its spring',()=>{
  const motion={enter:'pop',cue:'spoken',duration:.8,easing:'spring',keys:[{t:0,x:0},{t:3,x:.2}]};
  const cues={spoken:1.2};
  assert.equal(math.layerPose(.5,motion,cues).opacity,0);
  const late=math.layerPose(2.8,motion,cues);math.layerPose(.1,motion,cues);
  assert.deepEqual(math.layerPose(2.8,motion,cues),late,'random render order preserves frames');
  assert.ok(late.x>.18&&late.scale===1&&late.opacity===1);
  assert.equal(math.motionEase(1,'spring'),1);
  const strip=video.criticalReviewTimes({id:'a',seconds:4,cues,start:0,end:4},{props:{layers:[{motion}]}},30);
  assert.ok(strip.includes(2)&&strip.includes(3)&&strip.includes(119/30));
});

test('cursor camera uses observed source time, smooths jitter and clamps every crop',()=>{
  const take={width:1280,height:720,seconds:4,eventLog:[{kind:'pointer',t:.2,x:0,y:0},{kind:'pointer',t:1.2,x:1280,y:720},{kind:'pointer',t:2.8,x:100,y:300}]};
  const keys=compose.followCamera(take,2,.3);assert.ok(keys.length<=42);
  for(const key of keys){const crop=math.cameraAt(keys,key.t);assert.ok(crop.x>=.5/crop.zoom&&crop.x<=1-.5/crop.zoom&&crop.y>=.5/crop.zoom&&crop.y<=1-.5/crop.zoom);}
  const portrait=math.cameraAt([{t:0,x:.5,y:0,zoom:1}],0,{x:1,y:.3});assert.equal(portrait.y,.15,'portrait source can reach a top action while fitting its real crop');
  assert.ok(math.cameraAt(keys,.1).x>math.cameraAt(keys,.8).x);
  assert.ok(math.cameraAt(keys,2).x>math.cameraAt(keys,1).x);
  assert.throws(()=>compose.followCamera({...take,eventLog:[]}),/no observed/);
  const focused=compose.followCamera({...take,eventLog:[{kind:'pointer',t:0,x:1280,y:720},{kind:'target',t:.6,x:0,y:0,width:160,height:100}]},2,.3);
  assert.ok(math.cameraAt(focused,2).x<.3,'idle cursor does not crop away the action target');
  const wide=compose.followCamera({...take,eventLog:[{kind:'target',t:0,x:0,y:100,width:1280,height:200}]},2,.3);assert.ok(wide.at(-1).zoom<1.01,'wide subjects widen the shot instead of clipping their labels');
  assert.equal(shots.planShot({mode:'final',seconds:2},{fps:60,width:1920,height:1080}).fps,60);
  assert.throws(()=>shots.planShot({mode:'final',fps:12},{fps:30}),/film frame rate/);
  assert.equal(shots.planShot({mode:'final',fps:12,stepped:true},{fps:30}).fps,12);
});

test('native scene contract rejects hierarchy cycles and malformed geometry before output',async t=>{
  const {validateShotScene}=await load('extensions/lib/shot-scene.ts');
  assert.throws(()=>validateShotScene({objects:[{id:'a',shape:'group',parent:'b'},{id:'b',shape:'group',parent:'a'}]},2),/cyclic/);
  assert.throws(()=>validateShotScene({objects:[{id:'cup',shape:'lathe',points:[[-1,0],[1,1]]}]},2),/nonnegative/);
  assert.throws(()=>validateShotScene({objects:[{id:'flat',shape:'laptop',size:[3.5,2,.1]}]},2),/whole device/);
  assert.throws(()=>validateShotScene({objects:[{id:'a',shape:'box',motion:[{t:1},{t:.5}]}]},2),/increase/);
  const dir=await workspace(t);await fs.writeFile(path.join(dir,'video.json'),JSON.stringify({fps:30,scenes:[]}));
  await assert.rejects(shots.videoShot({dir,name:'bad',scene:{objects:[{id:'a',shape:'model',path:'missing.glb'}]}},dir),/does not exist/);
  assert.deepEqual(await fs.readdir(dir),['video.json']);
});

test('native device renders animated screen anchors and authored-camera shots preserve the source', {skip:!blender.blenderBinary()||process.env.YUNUSPI_SKIP_BLENDER_RENDER==='1',timeout:180000},async t=>{
  const dir=await workspace(t);await fs.writeFile(path.join(dir,'video.json'),JSON.stringify({fps:30,width:192,height:108,theme:{background:'#111d2b',accent:'#c78537'},scenes:[]}));
  const result=await shots.videoShot({dir,name:'phone',scene:{objects:[{id:'phone',shape:'phone',size:[1, .12,2],motion:[{t:0,rotation:[0,0,-8]},{t:.9,rotation:[0,0,8]}]}]},rig:'static',azimuth:5,elevation:5,seconds:1,fps:6,width:192,height:108,samples:8,shadow:'none'},dir);
  assert.ok(result.contactSheet);
  const folder=path.join(dir,'public/shots/phone'),track=JSON.parse(await fs.readFile(path.join(folder,'anchors.json'),'utf8'));
  assert.deepEqual(Object.keys(track.frames[0].anchors),['screen:tl','screen:tr','screen:br','screen:bl']);
  assert.ok(track.frames.every(f=>Object.values(f.anchors).every(p=>p.visible&&p.x>0&&p.x<1&&p.y>0&&p.y<1)));
  assert.notDeepEqual(track.frames[0].anchors,track.frames.at(-1).anchors,'device motion changes actual projected corners');
  const source=path.join(dir,'blender/phone.blend');
  await blender.blenderRun({blend:source,code:`import bpy,json\ns=bpy.context.scene\ns.render.engine='BLENDER_WORKBENCH'\ns.camera.name='AuthoredCamera'\ns.render.fps=3\ns.frame_end=7\nr=bpy.data.objects['phone-rig'];r.animation_data_clear()\nbpy.context.preferences.edit.keyframe_new_interpolation_type='LINEAR'\nr.location.x=-.3;r.keyframe_insert('location',frame=1)\nr.location.x=.3;r.keyframe_insert('location',frame=7)\ns.world.node_tree.nodes.get('Background').name='CustomSky'\ns.world.node_tree.nodes.get('CustomSky').inputs['Strength'].default_value=0.71\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(source)})\nprint('YUNUSPI_RESULT '+json.dumps({'saved':True}))`},dir);
  const preserved=await shots.videoShot({dir,name:'authored',blend:source,seconds:2,fps:6,anchors:['phone-rig'],width:192,height:108,samples:8},dir);
  assert.equal(preserved.rig,'scene');
  const retimed=JSON.parse(await fs.readFile(path.join(dir,'public/shots/authored/anchors.json'),'utf8'));
  assert.ok(retimed.frames.slice(1).every((f,i)=>Math.abs(f.anchors['phone-rig'].x-retimed.frames[i].anchors['phone-rig'].x)>1e-5),'higher delivery fps evaluates source subframes instead of duplicating poses');
  const saved=await blender.blenderRun({blend:path.join(dir,'blender/authored.blend'),code:`import bpy,json\ns=bpy.context.scene\nprint('YUNUSPI_RESULT '+json.dumps({'camera':s.camera.name,'engine':s.render.engine,'ambient':s.world.node_tree.nodes.get('CustomSky').inputs['Strength'].default_value,'floors':[o.name for o in s.objects if o.name=='YP_Ground']}))`},dir);
  assert.deepEqual(saved.result.floors,[]);assert.equal(saved.result.camera,'AuthoredCamera');assert.equal(saved.result.engine,'BLENDER_WORKBENCH');assert.ok(Math.abs(saved.result.ambient-.71)<1e-5);
});

test('phone takes focus typing, accept key aliases and retain observed interaction clock through import', {timeout:90000},async t=>{
  const dir=await workspace(t),file=path.join(dir,'demo.html');
  await fs.writeFile(file,`<meta name="viewport" content="width=device-width,initial-scale=1"><input id="input"><button id="go" onclick="document.getElementById('result').textContent=document.getElementById('input').value">Go</button><p id="result">Ready</p>`);
  const params={path:file,device:'phone',seconds:3.2,fps:12,width:320,height:480,outputDir:path.join(dir,'takes'),steps:[{action:'type',at:.2,selector:'#input',text:'Hello',duration:.3},{action:'press',at:.7,key:'Tab',duration:0},{action:'tap',at:1,selector:'#go',duration:.2},{action:'wait_text',at:1.4,selector:'#result',text:'Hello',duration:.1},{action:'highlight',at:1.6,selector:'#result',duration:.5}]};
  let take;try{take=await browser.videoBrowser(params,dir);}catch(error){if(process.env.PI_BROWSER_REQUIRE!=='1'&&/Executable doesn't exist|not installed/i.test(error.message)){t.skip('Browser prerequisite unavailable');return;}throw error;}
  assert.equal(take.device,'phone');assert.equal(take.decodeVerified,true);assert.equal(take.problems.length,0);
  for(const kind of ['type','key','press','tap','highlight'])assert.ok(take.eventLog.some(e=>e.kind===kind),kind);
  const project=path.join(dir,'film');await video.videoProject({action:'init',dir:project,title:'A working interaction',install:false,intent:'personal'},dir);
  const imported=await assets.videoAssets({action:'import',dir:project,path:take.artifact.path,name:'mobile',license:'authored'},dir);
  const safe=JSON.parse(await fs.readFile(path.join(project,'public',imported.take),'utf8'));
  assert.ok(!safe.artifact&&!safe.sourceUrl&&!safe.sourceFrames,'portable metadata omits runtime paths and URLs');
  await video.videoProject({dir:project,action:'compose',scenes:[{id:'demo',seconds:2,hero:{kind:'video',src:imported.file,take:imported.compose.take,startFrom:.5,speed:1,zoom:1.8,chrome:'phone'},headline:'A real response',layout:'hero-right'}]},dir);
  const spec=JSON.parse(await fs.readFile(path.join(project,'video.json'),'utf8'));
  const observed=take.eventLog.find(e=>e.kind==='tap').t-.5;
  assert.ok(spec.scenes[0].soundEvents.some(e=>Math.abs(e.at-observed)<.001));
  assert.equal(spec.scenes[0].props.layers.find(l=>l.id==='hero').sourceWidth,320);
  await assert.rejects(video.videoProject({dir:project,action:'compose',scenes:[{id:'bad',seconds:10,hero:{kind:'video',src:imported.file}}]},dir),/footage ends/);
});

test('SoundFont rendering produces actual instruments on the MIDI clock with stereo pan and release tail', {timeout:60000},async t=>{
  const bank='/usr/share/sounds/sf2/TimGM6mb.sf2';
  let installed=false;try{installed=syncFs.existsSync(bank)&&(await exec('python3',['-I','-c',"import ctypes.util; print(bool(ctypes.util.find_library('fluidsynth')))"])).stdout.trim()==='True';}catch{}
  if(!installed){if(process.env.PI_REQUIRE_SOUNDFONT_TEST==='1')assert.fail('SoundFont prerequisites required');t.skip('Optional SoundFont prerequisite unavailable');return;}
  const dir=await workspace(t),score={bpm:120,beats:4,tracks:[{program:0,pan:-1,notes:[{pitch:60,start:1,duration:1,velocity:90}]}]};
  const a=await music.composeMusic({score,backend:'soundfont',soundfont:bank,releaseTail:.5},dir);
  const b=await music.composeMusic({score:{...score,tracks:[{...score.tracks[0],program:48}]},backend:'soundfont',soundfont:bank,releaseTail:.5},dir);
  const wav=await fs.readFile(a.files.find(f=>f.path.endsWith('.wav')).path);
  assert.equal(wav.readUInt16LE(22),2);assert.equal(wav.readUInt32LE(24),44100);assert.equal(wav.readUInt32LE(40)/4,110250);
  assert.equal(a.scoreSeconds,2);assert.equal(a.seconds,2.5);assert.ok(a.sourcePeak>0&&a.previewGain>0&&a.soundfont.sha256.length===64);
  const energy=(from,to,ch)=>{let n=0;for(let i=Math.round(from*44100);i<Math.round(to*44100);i++){const x=wav.readInt16LE(44+i*4+ch*2);n+=x*x;}return n;};
  assert.equal(energy(0,.48,0),0,'the half-second authored rest is preserved');
  assert.ok(energy(.55,.9,0)>energy(.55,.9,1)*2,'pan affects real instrument signal');
  assert.notEqual(wav.compare(await fs.readFile(b.files.find(f=>f.path.endsWith('.wav')).path)),0,'MIDI programs change instrument timbre');
  await assert.rejects(music.composeMusic({score,backend:'soundfont',soundfont:'missing.sf2'},dir),/ENOENT/);
});


test('final checks cover referenced shots beyond forty and ignore unused drafts',async t=>{
  const dir=await workspace(t);await video.videoProject({action:'init',dir:path.join(dir,'film'),title:'A long film',install:false,intent:'personal'},dir);
  const film=path.join(dir,'film');
  for(let i=0;i<45;i++){const folder=path.join(film,'public/shots',`shot-${i}`);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'shot.json'),JSON.stringify({fps:30,width:640,height:360,quality:i===44?'preview':'final'}));}
  await video.videoProject({action:'compose',dir:film,scenes:[{id:'last',seconds:2,headline:'The final part',hero:{kind:'shot',shot:'shot-44'}}]},dir);
  const check=await video.videoProject({action:'check',dir:film},dir);assert.ok(check.issues.some(i=>/shot-44.*preview/.test(i.message)));
  await video.videoProject({action:'compose',dir:film,scenes:[{id:'first',seconds:2,headline:'The first part',hero:{kind:'shot',shot:'shot-0'}}]},dir);
  const used=await video.videoProject({action:'check',dir:film},dir);assert.ok(!used.issues.some(i=>/shot-44/.test(i.message)));
});

test('production tool schemas expose native graphs, screen clocks, take controls and instrument rendering',async()=>{
  const tools=new Map();const api={registerTool:d=>tools.set(d.name,d)};
  (await load('extensions/video-studio.ts')).default(api);(await load('extensions/media-tools.ts')).default(api);
  const valid=(name,args)=>validateToolArguments(tools.get(name),{type:'toolCall',id:'fixture',name,arguments:args});
  assert.doesNotThrow(()=>valid('video_shot',{dir:'.',name:'device',scene:{objects:[{id:'device',shape:'laptop',motion:[{t:0,rotation:[0,0,-10]}]}]}}));
  assert.doesNotThrow(()=>valid('video_project',{action:'compose',dir:'.',scenes:[{id:'hero',seconds:3,hero:{kind:'shot',shot:'device',screen:{src:'assets/take.mp4',speed:1.2}}}]}));
  assert.doesNotThrow(()=>valid('video_browser',{path:'demo.html',device:'phone',steps:[{action:'press',key:'Enter'}]}));
  assert.doesNotThrow(()=>valid('music_compose',{score:{tracks:[{notes:[{pitch:60,start:0,duration:1}]}]},backend:'soundfont',soundfont:'bank.sf2'}));
});
