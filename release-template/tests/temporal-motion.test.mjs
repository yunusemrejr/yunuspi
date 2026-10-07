import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {renderCapture,normalizeTemporalCapture} from '../agent/scripts/render-capture.mjs';
import {captureToFile} from '../agent/extensions/render-and-wait.ts';
import {motionInspectRun} from '../agent/extensions/lib/motion-inspect.ts';
import {visualReviewRun,creativeCompareRun} from '../agent/extensions/lib/creative-qa.ts';
import {encodeImage} from '../agent/extensions/lib/design-studio.ts';

const html = `<!doctype html><title>Shared motion fixture</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css">
<svg width="320" height="200" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="200" fill="#faf9f5"/><circle id="subject" cx="30" cy="80" r="24" fill="#176351"/></svg>
<script>window.__renderReady=false;window.renderFrame=async seconds=>{await new Promise(resolve=>setTimeout(resolve,10));document.querySelector('#subject').setAttribute('cx',matchMedia('(prefers-reduced-motion: reduce)').matches?130:30+seconds*100)};setTimeout(()=>{window.__renderReady=true},60)</script>`;

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'yunuspi-temporal-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('temporal plans reject invalid clocks, unbounded work and conflicting capture scopes',async t => {
  assert.deepEqual(normalizeTemporalCapture({timesMs:[0,1000,0]}),{timesMs:[0,1000,0],clock:'document'});
  for (const raw of [null,[],{}, {timesMs:[0]}, {timesMs:[0,NaN]}, {timesMs:[0,600001]}, {timesMs:[0,.1]}, {timesMs:Array(13).fill(0)}, {timesMs:[0,1],clock:'auto'}]) assert.throws(() => normalizeTemporalCapture(raw));
  const dir=await workspace(t);
  await assert.rejects(renderCapture({source:'missing.html',width:2048,height:2048,temporalCapture:{timesMs:Array(9).fill(0)}},path.join(dir,'too-big.png')),/physical-pixel work bound/);
  await assert.rejects(renderCapture({source:'missing.html',fullPage:true,temporalCapture:{timesMs:[0,1]}},path.join(dir,'full.png')),/viewport images/);
});

test('explicit video clock awaits readiness and async drawing, reuses assets and retains out-of-order frames', {timeout:60000},async t => {
  const dir=await workspace(t);let cssLoads=0;
  const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/style.css'?'text/css':'text/html');if(req.url==='/style.css'){cssLoads++;res.end('body{margin:0;background:#faf9f5}');}else res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const result=await captureToFile({source:`http://127.0.0.1:${server.address().port}/`,width:320,height:200,fullPage:false,timeoutMs:20000,temporalCapture:{timesMs:[0,1000,0],clock:'render'}},path.join(dir,'frames.png'),dir);
  assert.equal(result.temporalSequence.coverage.complete,true);assert.equal(result.temporalSequence.coverage.persistentDocument,true);
  assert.equal(cssLoads,1,'one temporal pass loads the shared stylesheet once');
  const frames=await Promise.all(result.temporalSequence.samples.map(frame=>fs.readFile(frame.file)));
  assert.equal(hash(frames[0]),hash(frames[2]),'seeking back to the same authored time reproduces the same pixels');assert.notEqual(hash(frames[0]),hash(frames[1]));
  assert.ok(result.temporalSequence.samples.every(frame=>frame.file.startsWith(dir+path.sep)&&frame.sampling.applied===true));
});

test('CSS and SVG clocks seek in one document; explicit driver failure preserves incomplete evidence', {timeout:60000},async t => {
  const dir=await workspace(t),source=path.join(dir,'scene.html');
  await fs.writeFile(source,`<!doctype html><style>body{margin:0}.subject{width:40px;height:40px;background:#176351;animation:travel 2s linear both}@keyframes travel{from{transform:translateX(0)}to{transform:translateX(120px)}}</style><div class="subject"></div><svg width="200" height="60"><circle cx="20" cy="25" r="10" fill="#a64e24"><animate attributeName="cx" values="20;140" dur="2s" fill="freeze"/></circle></svg>`);
  const result=await renderCapture({source,width:320,height:200,temporalCapture:{timesMs:[0,1000,0]}},path.join(dir,'css.png'));
  assert.equal(result.temporalSequence.coverage.complete,true);assert.equal(result.temporalSequence.samples[1].sampling.sampled,1);assert.equal(result.temporalSequence.samples[1].sampling.smil.sampled,1);
  const frames=await Promise.all(result.temporalSequence.samples.map(frame=>fs.readFile(frame.file)));
  assert.equal(hash(frames[0]),hash(frames[2]));assert.notEqual(hash(frames[0]),hash(frames[1]));
  await assert.rejects(renderCapture({source,width:320,height:200,temporalCapture:{timesMs:[0,1000],clock:'render'}},path.join(dir,'missing.png')),/missing-render-clock/);
  await fs.writeFile(source,html.replace('await new Promise(resolve=>setTimeout(resolve,10));','if(seconds>.5)throw Error("private driver diagnostic");'));
  const partial=await renderCapture({source,width:320,height:200,temporalCapture:{timesMs:[0,1000,0],clock:'render'}},path.join(dir,'partial.png'));
  assert.equal(partial.temporalSequence.coverage.complete,false);assert.equal(partial.temporalSequence.coverage.captured,1);assert.equal(partial.temporalSequence.failure,'sample-unavailable');
  assert.equal(JSON.stringify(partial).includes('private driver diagnostic'),false);assert.ok((await fs.stat(partial.output)).size>0);
});

test('native motion inspection retains capture errors and changed source instead of recording a clean pass', {timeout:120000},async t => {
  const dir=await workspace(t),source=path.join(dir,'scene.html');await fs.writeFile(source,html.replace('<link rel="stylesheet" href="/style.css">','<style>body{margin:0}</style>'));
  let calls=0;
  const capture=async(params,dest,cwd,signal)=>{calls++;return captureToFile(params,dest,cwd,signal);};
  const result=await motionInspectRun({source,mode:'render',width:320,height:200,durationMs:1000,samples:3},dir,undefined,capture);
  assert.equal(calls,4,'inventory and temporal passes replace per-frame browser launches');assert.equal(result.coverage.complete,true);assert.equal(result.reducedPixels.meanDelta,0);assert.equal(result.blocking,0);assert.equal(result.samples.length,3);
  const changed=await motionInspectRun({source,mode:'render',width:320,height:200,durationMs:1000,samples:2,reducedMotion:false},dir,undefined,async(params,dest,cwd,signal)=>{
    const receipt=await captureToFile(params,dest,cwd,signal);
    if(params.temporalCapture){await fs.appendFile(source,'<!-- source revision changed -->');receipt.errors=['page script error (message omitted)'];}
    return receipt;
  });
  assert.equal(changed.sourceChanged,true);assert.equal(changed.coverage.complete,false);assert.ok(changed.errors.length);assert.ok(changed.findings.some(f=>f.id==='temporal-coverage-incomplete'));
});

test('typography evidence counts reading text, excludes inherited wrapper styles and abstains on taste', {timeout:60000},async t => {
  const dir=await workspace(t),source=path.join(dir,'type.html');
  await fs.writeFile(source,'<!doctype html><style>html,body{margin:0;background:white;color:black}p{font:18px/1.5 Arial}</style>'+Array.from({length:12},(_,i)=>`<div style="height:2px;font-size:${40+i}px"></div>`).join('')+'<main><section><div><p>A real reading paragraph with one intended type role.</p></div></section></main>');
  const capture=await renderCapture({source,output:'both',width:400,height:240,designAudit:true},path.join(dir,'type.png'));
  assert.equal(capture.pageState.design.textElements,1);assert.deepEqual(capture.pageState.design.typography.map(font=>font.sizePx),[18]);
  const review=await visualReviewRun({source,width:400,height:240},dir,undefined,captureToFile);
  const type=review.sections.find(section=>section.id==='typography');assert.equal(type.verdict,'UNKNOWN');assert.ok(type.needsVision);assert.match(type.evidence[0],/18px/);assert.match(type.evidence.at(-1),/this product/);
});

test('live SVG audit distinguishes paint colors from fragment references and preserves SVG motion owner labels', {timeout:60000},async t => {
  const dir=await workspace(t),source=path.join(dir,'vectors.html');
  await fs.writeFile(source,`<!doctype html><svg width="320" height="200" viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="shade"><stop stop-color="#123456"/><stop offset="1" stop-color="#abcdef"/></linearGradient></defs><g class="first-owner"><rect width="60" height="60" fill="#fff" stroke="#123456"/></g><g class="second-owner"><circle cx="100" cy="80" r="20" fill="url(#shade)"/></g><use href="#absent"/><path d="M0 0L10 10" stroke="url(#missing-paint)"/></svg><script>for(const node of document.querySelectorAll('g'))node.animate([{transform:'none'},{transform:'translateX(20px)'}],{duration:1000,fill:'both'})</script>`);
  const result=await renderCapture({source,output:'both',width:320,height:200,designAudit:true,animationInventory:true},path.join(dir,'vector.png'));
  assert.equal(result.pageState.design.svg.unresolvedRefs,2,'only the missing use target and paint server are unresolved, not hexadecimal colors');
  assert.deepEqual(result.conditions.animationSample.descriptors.map(item=>item.target),['g.first-owner','g.second-owner']);
});

test('WebGL created by the explicit frame clock uses the existing bounded software retry', {timeout:60000},async t => {
  const dir=await workspace(t),source=path.join(dir,'shader.html');
  await fs.writeFile(source,`<!doctype html><style>body{margin:0}</style><canvas width="200" height="200"></canvas><script>window.renderFrame=seconds=>{const gl=document.querySelector('canvas').getContext('webgl');if(!gl)throw Error('No context');gl.clearColor(seconds,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT)}</script>`);
  const result=await renderCapture({source,width:200,height:200,timeoutMs:20000,temporalCapture:{timesMs:[0,1000],clock:'render'}},path.join(dir,'shader.png'));
  assert.equal(result.conditions.webgl,'software');assert.equal(result.temporalSequence.coverage.complete,true);
  const frames=await Promise.all(result.temporalSequence.samples.map(frame=>fs.readFile(frame.file)));assert.notEqual(hash(frames[0]),hash(frames[1]));
  assert.match(result.limitations,/not representative of a GPU/);
});

// Synthetic pixels isolate the comparison unit contract from browser paint noise.
test('motion receipts convert pixel percentages into shares before applying thresholds', async t => {
  const dir=await workspace(t),source=path.join(dir,'units.html');await fs.writeFile(source,'<!doctype html><title>Pixel units</title>');
  const image=async(file,stripe)=>{
    const data=Buffer.alloc(200*200*4,255);
    for(let y=0;y<200;y++)for(let x=0;x<stripe;x++)data.fill(0,(y*200+x)*4,(y*200+x)*4+3);
    await fs.writeFile(file,await encodeImage({width:200,height:200,data},'png'));
  };
  const capture=async(params,dest)=>{
    await image(dest,0);
    if(params.temporalCapture){
      const samples=[];
      for(const timeMs of params.temporalCapture.timesMs){const file=dest+'.'+timeMs+'.png';await image(file,timeMs===500?2:timeMs===1000?200:0);samples.push({timeMs,file});}
      return {temporalSequence:{samples,coverage:{complete:true,persistentDocument:true}}};
    }
    return {conditions:{animationSample:{descriptors:[]}}};
  };
  const temporal=await motionInspectRun({source,width:200,height:200,durationMs:1000,samples:3,reducedMotion:false},dir,undefined,capture);
  assert.equal(temporal.samples[1].changedShare,.01);assert.equal(temporal.samples[1].flag,'ok');
  assert.equal(temporal.samples[2].changedShare,.99);assert.equal(temporal.samples[2].flag,'jump');
  const scrollCapture=stripe=>async(params,dest)=>{
    const samples=[];
    for(const [index,progress,pass] of [[0,0,'forward'],[1,1,'forward'],[2,0,'backtrack']]){const file=dest+'.'+index+'.png';await image(file,index===2?stripe:0);samples.push({index,progress,pass,file,actualY:progress*200,maxScroll:200});}
    return {scrollSequence:{samples,coverage:{complete:true,persistentDocument:true}}};
  };
  const small=await motionInspectRun({source,mode:'scroll',width:200,height:200,positions:[0,1],reducedMotion:false},dir,undefined,scrollCapture(2));
  assert.equal(small.backtrack[0].changedShare,.01);assert.ok(!small.findings.some(f=>f.id==='scroll-backtrack-state'));
  const visible=await motionInspectRun({source,mode:'scroll',width:200,height:200,positions:[0,1],reducedMotion:false},dir,undefined,scrollCapture(8));
  assert.equal(visible.backtrack[0].changedShare,.04);assert.ok(visible.findings.some(f=>f.id==='scroll-backtrack-state'));
});

test('creative variant pixel differences use the same fractional share contract', async t => {
  const dir=await workspace(t);
  const report=await creativeCompareRun({sources:['first.html','second.html'],width:200,height:200},dir,undefined,async(params,dest)=>{
    const data=Buffer.alloc(1280*200*4,255);
    if(params.source==='second.html')for(let y=0;y<200;y++)for(let x=0;x<640;x++)data.fill(0,(y*1280+x)*4,(y*1280+x)*4+3);
    await fs.writeFile(dest,await encodeImage({width:1280,height:200,data},'png'));return {};
  });
  assert.equal(report.pairs[0].changedShare,.5,'half of the image changes, reported as a share in 0..1');
});

test('required reduced motion frames cannot be complete when their receipt or pair is missing', async t => {
  const dir=await workspace(t),source=path.join(dir,'reduced-boundary.html');await fs.writeFile(source,'<!doctype html><title>Reduced evidence</title>');
  const pixels=await encodeImage({width:200,height:200,data:Buffer.alloc(200*200*4,255)},'png');
  const adapter=missing=>async(params,dest)=>{
    await fs.writeFile(dest,pixels);
    if(!params.temporalCapture)return {conditions:{animationSample:{descriptors:[]}}};
    if(params.reducedMotion==='reduce'&&missing==='receipt')return {errors:[]};
    const times=params.reducedMotion==='reduce'&&missing==='pair'?[0]:params.temporalCapture.timesMs;
    const samples=[];for(const timeMs of times){const file=dest+'.'+timeMs+'.png';await fs.writeFile(file,pixels);samples.push({timeMs,file});}
    return {temporalSequence:{samples,coverage:{complete:true,persistentDocument:true}}};
  };
  for(const missing of ['receipt','pair']){
    const result=await motionInspectRun({source,mode:'render',width:200,height:200,samples:2},dir,undefined,adapter(missing));
    assert.equal(result.reducedPass,'checked');assert.equal(result.coverage.reducedComplete,false);assert.equal(result.coverage.complete,false);
    assert.ok(result.findings.some(f=>f.id==='reduced-motion-incomplete'));assert.ok(result.findings.some(f=>f.id==='temporal-coverage-incomplete'));
  }
  const complete=await motionInspectRun({source,mode:'render',width:200,height:200,samples:2},dir,undefined,adapter());
  assert.equal(complete.coverage.complete,true);assert.equal(complete.coverage.reducedComplete,true);
  const staticPage=await motionInspectRun({source,mode:'time',width:200,height:200,samples:2},dir,undefined,adapter('receipt'));
  assert.equal(staticPage.coverage.complete,true,'a static document inventory does not request a reduced temporal pair');
});
