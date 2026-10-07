import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planUiMatrix,planUiConsistency,compareUiSnapshots,uiExploreRun,uiConsistencyRun,sourceRevision } from '../agent/extensions/lib/creative-qa.ts';
import { motionInspectRun,planScrollMotion } from '../agent/extensions/lib/motion-inspect.ts';
import { captureToFile } from '../agent/extensions/render-and-wait.ts';
import { renderCapture,normalizeScrollCapture } from '../agent/scripts/render-capture.mjs';
import { normalizeUiSnapshotOptions } from '../agent/scripts/render-design-state.mjs';
import { encodeImage } from '../agent/extensions/lib/design-studio.ts';

async function workspace(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ui-engineering-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const html=body=>`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${body}`;

test('device and breakpoint plans cover widths before variants and disclose bounded omissions',()=>{
  const plan=planUiMatrix({devices:['phone-portrait','phone-landscape'],breakpoints:[768]});
  assert.equal(plan.cells.length,5);
  assert.deepEqual(plan.cells.filter(c=>c.breakpoint).map(c=>c.width),[767,768,769]);
  assert.equal(plan.cells[0].hasTouch,true);assert.equal(plan.cells[0].deviceScaleFactor,2);
  const sameWidth=planUiMatrix({devices:['phone-portrait'],widths:[390]});
  assert.equal(sameWidth.cells.length,2,'a requested plain CSS width does not discard the separate touch/DPR condition');
  assert.deepEqual(sameWidth.cells.map(c=>[c.width,c.deviceScaleFactor,c.hasTouch]),[[390,2,true],[390,1,false]]);
  const bounded=planUiMatrix({devices:['phone-portrait','phone-landscape','tablet-portrait','desktop'],breakpoints:[400,768,1000,1280],states:['default','dark','reduced-motion','full']});
  assert.equal(bounded.cells.length,12);assert.equal(bounded.requested,64);assert.equal(bounded.omitted.length,52);
  assert.ok(bounded.cells.every(c=>c.state==='default'),'requested widths precede preference variants under the upstream evidence contract');
  assert.ok(bounded.omitted.some(c=>c.state==='default'),'excess default widths remain explicitly unverified');
  assert.deepEqual(new Set(bounded.omitted.map(c=>c.state)),new Set(['default','dark','reduced-motion','full']));
  for(const params of [{devices:['unknown']},{breakpoints:[200]},{breakpoints:[Infinity]},{widths:[NaN]},{widths:[300,400,500,600,700]}])assert.throws(()=>planUiMatrix(params));
});

test('scroll plans retain explicit bounded live observations and reject incompatible work',async()=>{
  assert.equal(planScrollMotion({source:'page.html'}).scrollCapture.backtrack,true);
  for(const params of [{positions:[0,0]},{positions:[1,0]},{positions:[0,NaN]},{positions:Array.from({length:9},(_,i)=>i/8)},{settleMs:1001},{width:2048,height:2048,positions:[0,.2,.4,.6,.8,1]}])assert.throws(()=>planScrollMotion({source:'page.html',...params}));
  assert.throws(()=>normalizeScrollCapture({selectors:Array(13).fill('body')}));
  await assert.rejects(renderCapture({source:'missing.html',width:200,height:200,scrollCapture:{positions:[0,1]},animationTimeMs:0},'/tmp/unused-scroll-capture.png'),/Live scroll requires/);
  await assert.rejects(renderCapture({source:'missing.html',width:2048,height:2048,deviceScaleFactor:3},'/tmp/unused-device-capture.png'),/physical-pixel/);
});

test('consistency comparisons respect declared variants and expose missing rather than passing coverage',()=>{
  const snapshot=(variant,padding)=>({roles:[{name:'action',variant,styles:{padding}}],tokens:[{name:'--brand-color',status:'measured',value:'#123456'}],missing:[],truncated:false});
  const mixed=compareUiSnapshots([{source:'a',ok:true,snapshot:snapshot('primary','8px')},{source:'b',ok:true,snapshot:snapshot('secondary','20px')}]);
  assert.equal(mixed.findings.length,0);assert.ok(mixed.missing.length>0);assert.equal(mixed.comparedRoles,0);
  const drift=compareUiSnapshots([{source:'a',ok:true,snapshot:snapshot('primary','8px')},{source:'b',ok:true,snapshot:snapshot('primary','20px')}]);
  assert.equal(drift.findings[0].kind,'role-drift');assert.equal(drift.findings[0].severity,'WARN');
  assert.throws(()=>planUiConsistency({sources:['a','a']}));
  assert.throws(()=>planUiConsistency({sources:['a','b'],width:Infinity}));
  assert.throws(()=>normalizeUiSnapshotOptions({tokens:['color']}));
  assert.throws(()=>normalizeUiSnapshotOptions({groups:[{name:'a',selector:'body'},{name:'a',selector:'h1'}]}));
});

test('real device captures prove touch, DPR, landscape and CSS breakpoint neighbors', {timeout:90000},async t=>{
  const dir=await workspace(t),source=path.join(dir,'responsive.html');
  await fs.writeFile(source,html(`<style>html,body{margin:0;color:black;background:white;font:16px Arial}body{padding:8px}p{margin:0}@media(min-width:768px){body{font-size:24px}}@media(pointer:coarse){body{background:#ccffcc}}</style><p>Responsive fixture</p>`));
  const result=await uiExploreRun({source,devices:['phone-portrait','phone-landscape'],breakpoints:[768]},dir,undefined,captureToFile);
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.captured,5);
  const portrait=result.cells.find(c=>c.viewport==='phone-portrait'),landscape=result.cells.find(c=>c.viewport==='phone-landscape');
  assert.equal(portrait.device.maxTouchPoints,1);assert.equal(portrait.device.pointerCoarse,true);assert.equal(portrait.device.devicePixelRatio,2);
  assert.equal(portrait.pixels.width,780);assert.equal(landscape.device.orientation,'landscape');assert.equal(landscape.pixels.width,1688);
  const neighbors=result.cells.filter(c=>c.breakpoint);
  assert.equal(neighbors[0].device.cssWidth,767);assert.ok(neighbors[0].typography.some(level=>level.sizePx===16));
  for(const cell of neighbors.slice(1))assert.ok(cell.typography.some(level=>level.sizePx===24),'the CSS branch actually rendered on and after the breakpoint');
  assert.ok(result.cells.every(c=>/^[0-9a-f]{64}$/.test(c.documentSha256)));
  assert.ok(result.cells.every(c=>c.dom.available&&c.design&&Array.isArray(c.design.typography)));
  assert.equal(result.consistent,true);assert.equal(result.sourceChanged,false);assert.equal(result.initialRevision,result.revision);
  assert.equal(result.previewOrder.length,5);assert.ok((await fs.stat(path.resolve(dir,result.preview))).size>0);
  assert.equal(result.coverage.visualJudgment,'pending');assert.equal(result.coverage.interaction,'pending');
  assert.match(result.note,/not interaction proof/);
});

test('live scroll observes JS/rAF and scroll timelines in one document, backtracks and preserves reduced pixels',{timeout:120000},async t=>{
  const dir=await workspace(t),source=path.join(dir,'scroll.html');
  await fs.writeFile(source,html(`<style>html,body{margin:0;background:#111;color:white}body{height:2200px}#state{position:fixed;top:30px;width:40px;height:40px;background:#f70}#ambient{position:fixed;top:90px;width:30px;height:30px;background:white}#scroll-css{position:fixed;top:140px;width:30px;height:30px;background:cyan;animation:travel linear both;animation-timeline:scroll(root block)}@keyframes travel{from{transform:translateX(0)}to{transform:translateX(100px)}}@media(prefers-reduced-motion:reduce){#scroll-css{animation:none}}</style><div id="state"></div><div id="ambient"></div><div id="scroll-css"></div><script>const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;function frame(t){state.style.transform='translateX('+scrollY/10+'px)';ambient.style.transform='translateX('+(reduce?20:Math.sin(t/70)*25+30)+'px)';requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>`));
  const result=await motionInspectRun({source,mode:'scroll',width:320,height:240,positions:[0,.5,1],settleMs:100,selectors:['#state','#scroll-css']},dir,undefined,captureToFile);
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.persistentDocument,true);assert.equal(result.samples.length,5);
  assert.equal(new Set(result.samples.map(s=>s.documentIdentity)).size,1);
  assert.equal(result.samples[0].actualY,0);assert.ok(result.samples[2].actualY>1900);assert.equal(result.samples[4].actualY,0);
  assert.notEqual(result.samples[0].observations[0].transform,result.samples[2].observations[0].transform,'JS/rAF follows the actual live scroll');
  assert.ok(result.samples.some(s=>s.animations.scrollTimelines>0),'a native scroll timeline runs rather than being sought to document time');
  assert.equal(result.reducedPass,'checked');assert.equal(result.reducedPixels.meanDelta,0);assert.equal(result.blocking,0);
  for(const sample of [...result.samples,...result.reducedSamples])assert.ok((await fs.stat(path.resolve(dir,sample.file))).size>0,'native staging preserved each sample');
  assert.equal(result.timing.frameCadence,'unknown');assert.equal(result.timing.gpuPerformance,'unknown');assert.equal('fps' in result,false);
});

test('real cross-page consistency finds measured token/role drift and preserves intentional variants',{timeout:90000},async t=>{
  const dir=await workspace(t),sources=[];
  for(const [name,color,radius,variant] of [['a','#225577',8,'primary'],['b','#225577',8,'primary'],['drift','#bb3311',24,'primary'],['variant','#225577',32,'secondary']]){
    const source=path.join(dir,`${name}.html`);sources.push(source);
    await fs.writeFile(source,html(`<style>:root{--brand-color:${color};--asset-url:url(https://private.invalid/never-return)}body{margin:0;background:white}.action{font:16px Arial;padding:12px;border:0;border-radius:${radius}px;color:white;background:var(--brand-color)}</style><button class="action" data-ui-variant="${variant}">Continue</button>`));
  }
  const result=await uiConsistencyRun({sources,width:600,height:300,selectorGroups:[{name:'action',selector:'.action'}],tokens:['--brand-color','--asset-url']},dir,undefined,captureToFile);
  assert.equal(result.coverage.captured,4);assert.equal(result.coverage.complete,false,'missing shared variants and URL-valued tokens are not a clean coverage claim');
  assert.ok(result.findings.some(f=>f.kind==='token-drift'&&f.actual.source.endsWith('drift.html')));
  assert.ok(result.findings.some(f=>f.kind==='role-drift'&&f.actualSource.endsWith('drift.html')&&f.differences.some(d=>d.property==='borderRadius')));
  assert.ok(!result.findings.some(f=>f.kind==='role-drift'&&f.actualSource.endsWith('variant.html')),'declared secondary is a different contract');
  assert.ok(result.missing.some(m=>m.token==='--asset-url'));
  const report=await fs.readFile(path.resolve(dir,result.report),'utf8');assert.ok(!report.includes('private.invalid'));
  assert.ok(result.captures.every(c=>/^[0-9a-f]{64}$/.test(c.documentSha256)&&/^[0-9a-f]{16}$/.test(c.revision)));
});

test('a failed reduced-motion pass retains actual scroll artifacts and unverified coverage',{timeout:30000},async t=>{
  const dir=await workspace(t),source=path.join(dir,'recovery.html');await fs.writeFile(source,html('<style>body{height:1200px;background:#123456}</style><h1>Scroll recovery</h1>'));
  const capture=(params,file,cwd,signal)=>params.reducedMotion==='reduce'?Promise.reject(Error('reduced fixture unavailable')):captureToFile(params,file,cwd,signal);
  const result=await motionInspectRun({source,mode:'scroll',width:240,height:200,positions:[0,1],settleMs:0},dir,undefined,capture);
  assert.equal(result.samples.length,3);assert.equal(result.reducedPass,'failed');assert.equal(result.coverage.complete,false);
  assert.ok(result.findings.some(f=>f.id==='reduced-motion-unverified'));assert.ok((await fs.stat(path.resolve(dir,result.samples[0].file))).size>0);
});

test('native capture cancellation reaps live scroll work without publishing a final screenshot',{timeout:15000},async t=>{
  const dir=await workspace(t),source=path.join(dir,'cancel.html'),output=path.join(dir,'cancelled.png');await fs.writeFile(source,html('<style>body{height:2000px}</style><h1>Cancelled scroll</h1>'));
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),250);t.after(()=>clearTimeout(timer));
  await assert.rejects(captureToFile({source,width:240,height:200,fullPage:false,timeoutMs:10000,scrollCapture:{positions:[0,.25,.5,.75,1],settleMs:1000}},output,dir,stop.signal),/Render cancelled/);
  await assert.rejects(fs.stat(output),/ENOENT/);
});

test('partial captures and cancellation preserve measured cells while disclosing unfinished work',async t=>{
  const dir=await workspace(t),source=path.join(dir,'fixture.html');await fs.writeFile(source,html('<p>fixture</p>'));
  let calls=0;
  const pixels=await encodeImage({width:2,height:2,data:new Uint8Array(16).fill(255)},'png');
  const capture=async(p,file)=>{if(++calls===2)throw Error('fixture capture unavailable');await fs.writeFile(file,pixels);return{width:2,height:2,conditions:{documentSha256:'a'.repeat(64)},pageState:{items:[]},errors:[]};};
  const result=await uiExploreRun({source},dir,undefined,capture);assert.equal(result.coverage.requested,4);assert.equal(result.coverage.captured,3);assert.equal(result.coverage.complete,false);assert.equal(result.status,'fail');assert.equal(result.cells[1].ok,false);assert.ok(result.findings.some(f=>f.includes('fixture capture unavailable')));
  assert.equal(result.previewOrder.length,3);assert.equal(result.coverage.visualJudgment,'pending');assert.equal(result.coverage.interaction,'pending');
  const stop=new AbortController();stop.abort();await assert.rejects(uiExploreRun({source},dir,stop.signal,capture));
  await assert.rejects(motionInspectRun({source,mode:'scroll'},dir,stop.signal,capture));
  await assert.rejects(uiConsistencyRun({sources:[source,'missing.html']},dir,stop.signal,capture));
});

test('source revisions honor literal hash filenames before interpreting HTML route fragments',async t=>{
  const dir=await workspace(t),literal=path.join(dir,'page#literal.html'),page=path.join(dir,'page.html');
  await fs.writeFile(literal,html('<h1>Literal file</h1>'));await fs.writeFile(page,html('<h1>Route file</h1>'));
  const exact=await sourceRevision(literal,dir),route=await sourceRevision(page+'#section',dir);
  assert.match(exact,/^[0-9a-f]{16}$/);assert.equal(route,await sourceRevision(page,dir));assert.notEqual(exact,route);
});

test('ui_consistency and advanced QA inputs are discoverable native tool schemas',async()=>{
  const tools=[];const {default:register}=await import('../agent/extensions/art-direction.ts');
  register({registerTool:t=>tools.push(t),registerCommand:()=>{},on:()=>{}});
  const consistency=tools.find(t=>t.name==='ui_consistency');assert.ok(consistency);
  const motion=tools.find(t=>t.name==='motion_inspect'),explore=tools.find(t=>t.name==='ui_explore');
  assert.ok(motion.parameters.properties.mode&&motion.parameters.properties.positions&&explore.parameters.properties.devices&&explore.parameters.properties.breakpoints);
});
