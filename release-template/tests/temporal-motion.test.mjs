import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {renderCapture,normalizeTemporalCapture} from '../agent/scripts/render-capture.mjs';
import {captureToFile} from '../agent/extensions/render-and-wait.ts';
import {visualReviewRun} from '../agent/extensions/lib/creative-qa.ts';
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


