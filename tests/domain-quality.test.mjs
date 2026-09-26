import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..'),path.resolve(root,'../..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/svg-check.ts')));
const load=p=>import(pathToFileURL(path.join(agent,'extensions/lib',p)));
const {inspectSvg}=await load('svg-check.ts');
const {numericCheck:check}=await load('numeric-checks.ts');
const {default:register}=await load('small-tools.ts');
const svg=body=>`<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const keys=result=>result.findings.map(f=>f.key);

test('SVG checks actual references, malformed source and bounded review cues without executing input',async()=>{
  const good=await inspectSvg(svg('<defs><linearGradient id="paint"><stop offset="0"/></linearGradient></defs><path d="M0 0 L4 4" fill="url(#paint)"/>'));
  assert.equal(good.status,'inspected');assert.deepEqual(good.findings,[]);assert.deepEqual(good.viewBox,[0,0,24,24]);assert.equal(good.counts.pathCommandLetters,2);assert.match(good.sourceHash,/^[a-f0-9]{64}$/);
  const regioned=await inspectSvg(svg('<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter></defs>'));
  assert.ok(!keys(regioned).includes('filter-region'),'explicit filter region needs no cue');
  for(const body of ['<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>','<defs><filter id="f" x="0" y="0"><feDropShadow stdDeviation="4"/></filter></defs>']){
    const clipped=await inspectSvg(svg(body));
    assert.ok(keys(clipped).includes('filter-region'),body);assert.equal(clipped.status,'inspected','region cue is advisory, not an error');
  }
  const source=svg('<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><g id="f"/><use href="#absent"/><image href="https://example.invalid/image.png"/><script>globalThis.domainExecuted=true</script><path onclick="work()"><animate attributeName="opacity"/></path>');
  const result=await inspectSvg(source);
  for(const key of ['duplicate-id','missing-reference','external-reference','active-content','event-handler','compositing-cost','motion'])assert.ok(keys(result).includes(key),key);
  assert.equal(result.status,'issues');assert.equal(result.counts.filterPrimitives,1);assert.equal(globalThis.domainExecuted,undefined);
  assert.ok(!JSON.stringify(result).includes('example.invalid'),'does not echo URLs or source');
  assert.match(result.scope,/not certified/);
  const hidden=await inspectSvg('<svg viewBox="0 0 0 24" aria-hidden="true"/>');
  assert.equal(hidden.status,'inspected');assert.deepEqual(hidden.viewBox,[0,0,0,24]);assert.equal(hidden.findings.find(f=>f.key==='empty-viewbox').severity,'review','SVG 2 zero extent disables rendering without invalidating the attribute');
  for(const source of ['<svg><g></svg>','<svg><path>','<svg id=a/>','<svg id="a" id="b"/>','<svg/><svg/>','<html/>','<svg viewBox="0 0 -1 10"/>','<svg viewBox="0,,0,10,10"/>'])assert.equal((await inspectSvg(source)).status,'issues',source);
  assert.deepEqual(keys(await inspectSvg(svg('<!-- <script/> <use href="#no"/> -->'))),[],'comments are not interpreted as elements');
  const forward=await inspectSvg(svg('<use href="#later"/><path id="later"/>'));
  assert.ok(!keys(forward).includes('missing-reference'),'forward references resolve');
  assert.ok(keys(await inspectSvg('<svg viewBox="0 0 1 1" aria-labelledby="missing"/>')).includes('missing-reference'));
  const many=await inspectSvg(svg('<use href="#secret"/>'.repeat(500)));
  assert.equal(many.findings.find(f=>f.key==='missing-reference').count,500);
  assert.equal(many.findings.find(f=>f.key==='missing-reference').offsets.length,4);
  assert.ok(JSON.stringify(many).length<4000);
  for(const source of ['<!DOCTYPE svg SYSTEM "file:///private"><svg/>','<!ENTITY x "value"><svg/>','é'.repeat(32769),'<svg>'+'<g>'.repeat(64)+'</g>'.repeat(64)+'</svg>',svg('<g/>'.repeat(4096))])await assert.rejects(()=>inspectSvg(source));
});

test('frame statistics use measured milliseconds and rendering memory scales with device-pixel area',()=>{
  const frame=check({operation:'frame_budget',values:[10,20,30,40],target_fps:50});
  assert.deepEqual([frame.meanMs,frame.p50Ms,frame.p95Ms,frame.p99Ms,frame.maxMs],[25,20,40,40,40]);
  assert.equal(frame.budgetMs,20);assert.equal(frame.effectiveFps,40);assert.equal(frame.overBudgetFrames,2);assert.equal(frame.overBudgetFraction,.5);
  assert.equal(check({operation:'frame_budget',values:[1000/60]}).overBudgetFrames,0);
  assert.equal(check({operation:'frame_budget',values:Array.from({length:100},(_,i)=>100-i)}).p95Ms,95);
  const one=check({operation:'render_budget',width:100,height:50});
  assert.equal(one.attachmentBytes,40000);assert.equal(one.pixelMultiplier,1);
  const two=check({operation:'render_budget',width:100,height:50,pixel_ratio:2,samples:4,buffers:2,bytes_per_pixel:8});
  assert.equal(two.attachmentBytes,one.attachmentBytes*32);assert.equal(two.pixelMultiplier,4);
  assert.equal(two.attachmentMiB,two.attachmentBytes/1048576);
  const rounded=check({operation:'render_budget',width:3,height:3,pixel_ratio:.5});
  assert.equal(rounded.pixels,4);assert.equal(rounded.pixelWidth,2);
  assert.ok(Number.isSafeInteger(check({operation:'render_budget',width:65536,height:65536,pixel_ratio:8,samples:16,buffers:8,bytes_per_pixel:64}).attachmentBytes));
  assert.match(two.limitations.join(' '),/resolve targets/);
  for(const input of [
    {operation:'frame_budget',values:[0]},{operation:'frame_budget',values:[-1]},{operation:'frame_budget',values:[Number.MIN_VALUE]},{operation:'frame_budget',values:[60001]},{operation:'frame_budget',values:[1],target_fps:0},{operation:'frame_budget',values:[1],target_fps:'60'},{operation:'frame_budget',values:[1],target_fps:null},
    ...[{width:0},{height:1.5},{pixel_ratio:NaN},{pixel_ratio:null},{samples:17},{samples:1.5},{buffers:0},{bytes_per_pixel:65}].map(extra=>({operation:'render_budget',width:10,height:10,...extra})),
  ])assert.throws(()=>check(input),/numeric_check:/);
});

test('registered artifact and numeric operations preserve workspace boundaries, cancellation and switches',async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'domain-quality-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const envKeys=['PI_SMALL_TOOLS','PI_REASONING_AIDS','PI_SUBAGENT_CHILD'],saved=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of envKeys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
  for(const k of envKeys)delete process.env[k];
  fs.mkdirSync(path.join(cwd,'workspace'));const workspace=path.join(cwd,'workspace');
  fs.writeFileSync(path.join(workspace,'icon.svg'),svg('<use href="#missing"/>'));
  fs.writeFileSync(path.join(cwd,'outside.svg'),svg(''));fs.symlinkSync('../outside.svg',path.join(workspace,'escape.svg'));
  const tools=new Map();register({registerTool:t=>tools.set(t.name,t)});
  const call=(name,input,signal)=>tools.get(name).execute('check',input,signal,undefined,{cwd:workspace});
  const result=await call('artifact_check',{operation:'svg',path:'icon.svg'});
  assert.notEqual(result.isError,true);assert.equal(result.details.status,'issues');assert.deepEqual(JSON.parse(result.content[0].text),result.details);
  assert.equal((await call('artifact_check',{operation:'svg',text:svg('')})).details.status,'inspected');
  for(const input of [{operation:'svg',path:'../outside.svg'},{operation:'svg',path:'escape.svg'},{operation:'svg',path:'.'},{operation:'svg',text:svg(''),path:'icon.svg'}])assert.equal((await call('artifact_check',input)).isError,true);
  assert.equal((await call('artifact_check',{operation:'svg',path:'icon.svg'},AbortSignal.abort())).isError,true);
  assert.equal((await call('math_check',{operation:'frame_budget',values:[10]})).details.meanMs,10);
  assert.equal((await call('math_check',{operation:'render_budget',width:10,height:10})).details.attachmentBytes,800);
  process.env.PI_SMALL_TOOLS='off';assert.equal((await call('artifact_check',{operation:'svg',text:svg('')})).isError,true);
  process.env.PI_SUBAGENT_CHILD='1';const child=new Map();register({registerTool:t=>child.set(t.name,t)});
  assert.ok(child.has('artifact_check'),'stable definitions in child profiles');
  assert.equal((await child.get('math_check').execute('disabled',{operation:'frame_budget',values:[10]},undefined,undefined,{cwd:workspace})).isError,true);
});

test('successful SVG saves run a bounded full-file check while unrelated and failed operations do no I/O',async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'svg-save-check-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const envKeys=['PI_SMALL_TOOLS','PI_REASONING_AIDS'],saved=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of envKeys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
  for(const k of envKeys)delete process.env[k];
  const hooks=new Map();register({registerTool(){},on:(name,handler)=>hooks.set(name,handler)});
  const originalContent=[{type:'text',text:'Wrote the file'}],originalDetails={fileMutation:{bytes:123},other:'preserved'};
  const call=(file,extra={})=>hooks.get('tool_result')({toolName:'write',input:{path:file,content:'<svg/>'},isError:false,content:originalContent,details:originalDetails,...extra},{cwd});
  const source=svg('<g id="x"/><g id="x"/><use href="#missing"/><path onclick="globalThis.svgAutoExecuted=true"/>');
  fs.writeFileSync(path.join(cwd,'drawing.svg'),source);
  const result=await call('drawing.svg',{toolName:'edit',input:{path:'drawing.svg',newText:'partial unrelated snippet'}});
  assert.equal(result.details.svgCheck.status,'issues');assert.equal(result.details.svgCheck.errorCount,2);
  assert.equal(result.details.svgCheck.sourceHash,(await inspectSvg(source)).sourceHash,'receipt hashes complete saved bytes, not edit snippet');
  assert.deepEqual(result.details.fileMutation,originalDetails.fileMutation);assert.equal(result.details.other,'preserved');assert.equal(result.content[0],originalContent[0]);
  assert.equal(result.content.length,2);assert.ok(result.content[1].text.length<=600);assert.equal(globalThis.svgAutoExecuted,undefined);
  assert.ok(result.details.svgCheck.findingKeys.length<=3);
  fs.writeFileSync(path.join(cwd,'drawing.svg'),svg(''));
  const clean=await call('drawing.svg');assert.equal(clean.details.svgCheck.status,'inspected');assert.equal(clean.details.svgCheck.errorCount,0);assert.equal(clean.content,originalContent,'no noise for no demonstrated error');
  fs.writeFileSync(path.join(cwd,'drawing.svg'),'<svg viewBox="0 0 0 24" aria-hidden="true"/>');
  const hidden=await call('drawing.svg');assert.equal(hidden.details.svgCheck.errorCount,0);assert.equal(hidden.content,originalContent,'intentional zero extent is not an automatic error');
  assert.equal(originalDetails.svgCheck,undefined,'does not mutate upstream result');
  const originalRealpath=fs.promises.realpath;let reads=0;
  fs.promises.realpath=async()=>{reads++;throw Error('unexpected I/O');};
  try{
    for(const [file,extra]of [['drawing.svg',{isError:true}],['drawing.svg',{toolName:'read'}],['drawing.svg',{toolName:'artifact_check'}],['drawing.png',{}],['vendor/drawing.svg',{}],['generated/drawing.svg',{}],['fixtures/drawing.svg',{}]])assert.equal(await call(file,extra),undefined);
    process.env.PI_SMALL_TOOLS='off';assert.equal(await call('drawing.svg'),undefined);delete process.env.PI_SMALL_TOOLS;
    process.env.PI_REASONING_AIDS='off';assert.equal(await call('drawing.svg'),undefined);delete process.env.PI_REASONING_AIDS;
    assert.equal(reads,0,'failed/disabled/non-SVG/generated inputs never touch filesystem');
  }finally{fs.promises.realpath=originalRealpath;}
});

test('automatic SVG receipts never label missing, oversized, malformed or unstable reads as inspected',async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'svg-save-boundary-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.mkdirSync(path.join(cwd,'workspace'));const workspace=path.join(cwd,'workspace');
  fs.writeFileSync(path.join(cwd,'outside.svg'),svg(''));fs.symlinkSync('../outside.svg',path.join(workspace,'escape.svg'));
  fs.writeFileSync(path.join(workspace,'huge.svg'),'x'.repeat(65537));
  fs.writeFileSync(path.join(workspace,'invalid.svg'),'<svg><g></svg>');
  fs.writeFileSync(path.join(workspace,'doctype.svg'),'<!DOCTYPE svg SYSTEM "file:///private"><svg/>');
  fs.writeFileSync(path.join(workspace,'encoding.svg'),Buffer.from([0xff]));
  const hooks=new Map();register({registerTool(){},on:(name,handler)=>hooks.set(name,handler)});
  const content=[{type:'text',text:'Saved'}],call=file=>hooks.get('tool_result')({toolName:'write',input:{path:file},isError:false,content,details:{kept:1}},{cwd:workspace});
  for(const file of ['missing.svg','../outside.svg','escape.svg','huge.svg','doctype.svg','encoding.svg']){
    const result=await call(file);assert.equal(result.details.svgCheck.status,'unavailable',file);assert.equal(result.details.svgCheck.sourceHash,undefined);assert.equal(result.content,content);assert.equal(result.details.kept,1);
  }
  const malformed=await call('invalid.svg');assert.equal(malformed.details.svgCheck.status,'issues');assert.ok(malformed.details.svgCheck.findingKeys.includes('xml-recovery'));
  fs.writeFileSync(path.join(workspace,'changing.svg'),svg(''));
  const originalOpen=fs.promises.open;
  fs.promises.open=async(...args)=>{
    const handle=await originalOpen(...args),read=handle.read.bind(handle);
    handle.read=async(...readArgs)=>{const result=await read(...readArgs);fs.appendFileSync(path.join(workspace,'changing.svg'),' ');return result;};
    return handle;
  };
  try{assert.equal((await call('changing.svg')).details.svgCheck.status,'unavailable','concurrent mutation cannot produce a checked snapshot');}
  finally{fs.promises.open=originalOpen;}
  for(const mutation of ['same-size-preserved-time','atomic-replacement']){
    const file=path.join(workspace,'changing.svg'),original=svg('<g/>'),changed=svg('<a/>');
    fs.writeFileSync(file,original);fs.utimesSync(file,new Date(1000000000000),new Date(1000000000000));
    const before=fs.statSync(file);
    fs.promises.open=async(...args)=>{
      const handle=await originalOpen(...args),read=handle.read.bind(handle);
      handle.read=async(...readArgs)=>{
        const result=await read(...readArgs);
        if(mutation==='atomic-replacement'){
          const replacement=path.join(workspace,'replacement.svg');fs.writeFileSync(replacement,changed);fs.utimesSync(replacement,before.atime,before.mtime);fs.renameSync(replacement,file);
        }else{fs.writeFileSync(file,changed);fs.utimesSync(file,before.atime,before.mtime);}
        return result;
      };
      return handle;
    };
    try{assert.equal((await call('changing.svg')).details.svgCheck.status,'unavailable',mutation+' must not attest to stale saved-file bytes');}
    finally{fs.promises.open=originalOpen;}
  }
});

test('artifact snapshots recheck leaf, ancestor and workspace symlink targets',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'svg-path-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const left=path.join(root,'left'),right=path.join(root,'right');fs.mkdirSync(left);fs.mkdirSync(right);
  fs.writeFileSync(path.join(left,'drawing.svg'),svg(''));fs.writeFileSync(path.join(right,'drawing.svg'),svg('<use href="#missing"/>'));
  const hooks=new Map();register({registerTool(){},on:(name,handler)=>hooks.set(name,handler)});
  const call=(cwd,file)=>hooks.get('tool_result')({toolName:'write',input:{path:file},content:[],details:{}},{cwd});
  const originalOpen=fs.promises.open;
  for(const kind of ['leaf','ancestor','workspace','workspace-absolute-input']){
    const leaf=kind==='leaf',alias=path.join(root,leaf?'selected.svg':'selected');
    fs.symlinkSync(leaf?path.join(left,'drawing.svg'):left,alias);
    const cwd=kind.startsWith('workspace')?alias:root;
    const request=kind==='workspace-absolute-input'?path.join(left,'drawing.svg'):kind==='workspace'?'drawing.svg':leaf?'selected.svg':'selected/drawing.svg';
    const link=alias;
    assert.equal((await call(cwd,request)).details.svgCheck.status,'inspected','unchanged in-workspace alias is readable');
    fs.promises.open=async(...args)=>{
      const handle=await originalOpen(...args),read=handle.read.bind(handle);
      handle.read=async(...readArgs)=>{const result=await read(...readArgs);fs.unlinkSync(link);fs.symlinkSync(leaf?path.join(right,'drawing.svg'):right,link);return result;};
      return handle;
    };
    try{assert.equal((await call(cwd,request)).details.svgCheck.status,'unavailable',kind+' retarget must invalidate the old snapshot');}
    finally{fs.promises.open=originalOpen;fs.unlinkSync(link);}
  }
});
