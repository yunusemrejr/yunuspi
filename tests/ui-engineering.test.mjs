import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planUiMatrix,uiExploreRun,sourceRevision } from '../agent/extensions/lib/creative-qa.ts';
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




test('native capture cancellation reaps live scroll work without publishing a final screenshot',{timeout:15000},async t=>{
  const dir=await workspace(t),source=path.join(dir,'cancel.html'),output=path.join(dir,'cancelled.png');await fs.writeFile(source,html('<style>body{height:2000px}</style><h1>Cancelled scroll</h1>'));
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),250);t.after(()=>clearTimeout(timer));
  await assert.rejects(captureToFile({source,width:240,height:200,fullPage:false,timeoutMs:10000,scrollCapture:{positions:[0,.25,.5,.75,1],settleMs:1000}},output,dir,stop.signal),/Render cancelled/);
  await assert.rejects(fs.stat(output),/ENOENT/);
});


test('source revisions honor literal hash filenames before interpreting HTML route fragments',async t=>{
  const dir=await workspace(t),literal=path.join(dir,'page#literal.html'),page=path.join(dir,'page.html');
  await fs.writeFile(literal,html('<h1>Literal file</h1>'));await fs.writeFile(page,html('<h1>Route file</h1>'));
  const exact=await sourceRevision(literal,dir),route=await sourceRevision(page+'#section',dir);
  assert.match(exact,/^[0-9a-f]{16}$/);assert.equal(route,await sourceRevision(page,dir));assert.notEqual(exact,route);
});

