import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {createServer} from 'node:http';
import path from 'node:path';
import {renderCapture} from '../agent/scripts/render-capture.mjs';
import registerRender from '../agent/extensions/render-and-wait.ts';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'design-audit-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const file=path.join(root,'index.html');
fs.writeFileSync(file,`<!doctype html><title>Design fixture</title><style>
html,body{background:white;color:black;font:16px Arial;margin:0}main{padding:24px}.low{color:#aaa}.large{font-size:24px;color:#777}.good{color:#000}.gradient{background:linear-gradient(blue,green);color:white}.transparent{opacity:.5}.wide{width:900px}.move{animation:move 10s infinite}input{color:red}@keyframes move{to{transform:translateX(4px)}}@media(prefers-reduced-motion:reduce){.move{animation:none}}
</style><main><h1 class="good">Heading</h1><p class="low">Low contrast</p><p class="large">Large text</p><p class="gradient">Gradient indeterminate</p><p class="transparent">Opacity indeterminate</p><div class="wide">Overflow</div><div class="move">Motion</div><input value="PRIVATE_INPUT_VALUE"></main>`);

test('real design audit reports solid contrast, typography, overflow and reduced-motion evidence',async()=>{
 const rendered=await renderCapture({source:file,output:'text',width:640,height:480,designAudit:true},path.join(root,'unused.png'));
 const d=rendered.pageState.design;assert.ok(d);
 assert.ok(d.contrast.checked>=3);assert.equal(d.contrast.belowThreshold,1);assert.ok(d.contrast.indeterminate>=2);
 assert.ok(d.findings.some(x=>x.kind==='solid-text-contrast'&&x.threshold===4.5));assert.equal(d.findings.some(x=>x.kind==='solid-text-contrast'&&x.threshold===3),false);
 assert.ok(d.typography.some(x=>x.family.includes('Arial')));assert.ok(d.spacing.some(x=>x.pixels===24));assert.ok(d.horizontalOverflowPx>0);assert.ok(d.motion.running>0);
 assert.ok(!JSON.stringify(d).includes('PRIVATE_INPUT_VALUE'));assert.ok(!('score' in d));
 const reduced=await renderCapture({source:file,output:'text',width:640,height:480,designAudit:true,reducedMotion:'reduce'},path.join(root,'unused2.png'));
 assert.equal(reduced.pageState.design.motion.reducedMotion,true);assert.equal(reduced.pageState.design.motion.running,0);
});

test('ordinary DOM inspection remains lean and large design scans disclose bounds',async()=>{
 const ordinary=await renderCapture({source:file,output:'text',width:640,height:480},path.join(root,'unused3.png'));
 assert.equal(ordinary.pageState.design,undefined);
 const huge=path.join(root,'large.html');fs.writeFileSync(huge,'<style>html{background:white}p{color:#aaa}</style>'+Array.from({length:900},()=>'<p>Bounded sample</p>').join(''));
 const result=await renderCapture({source:huge,output:'text',designAudit:true},path.join(root,'unused4.png'));
 assert.equal(result.pageState.design.truncated,true);assert.ok(result.pageState.design.visited<=600);assert.ok(result.pageState.design.findings.length<=12);assert.ok(JSON.stringify(result).length<14000);
});

test('native design_audit uses the existing renderer contract and rejects PDF style claims',async()=>{
 const tools=new Map();registerRender({registerTool:def=>tools.set(def.name,def),on(){}});
 const tool=tools.get('design_audit');assert.ok(tool);assert.deepEqual(tool.parameters,tools.get('render_see').parameters);
 await assert.rejects(tool.execute('pdf',{source:'fixture.pdf'},undefined,undefined,{}),/requires rendered HTML/);
});

test('complex paint never becomes a confident solid-text contrast measurement',async()=>{
 const complex=path.join(root,'complex.html');
 fs.writeFileSync(complex,`<!doctype html><style>html,body{background:white;color:black;font:16px Arial}p{position:relative}.pseudo{color:white}.pseudo::before{content:"";position:absolute;inset:0;background:black}.inset{color:white;background:white;box-shadow:inset 0 0 0 100px black}.fill{-webkit-text-fill-color:white;color:black}.mask{mask-image:linear-gradient(black,transparent)}</style><p class="pseudo">Pseudo paint</p><p class="inset">Inset shadow</p><p class="fill">Text fill</p><p class="mask">Mask</p><svg width="180" height="30"><text x="0" y="20" fill="white">SVG paint</text></svg><p>Solid control</p>`);
 const result=await renderCapture({source:complex,output:'text',designAudit:true},path.join(root,'unused-complex.png'));
 assert.equal(result.pageState.design.contrast.checked,1);
 assert.equal(result.pageState.design.contrast.belowThreshold,0);
 assert.equal(result.pageState.design.contrast.indeterminate,5);
});


test('design measurements reject raster and PDF sources rather than inspecting generated image wrappers',async()=>{
 for(const extension of ['png','pdf']){
  const source=path.join(root,'image-source.'+extension);fs.writeFileSync(source,'fixture');
  await assert.rejects(renderCapture({source,output:'text',designAudit:true},path.join(root,'unused-nondesign.png')),error=>{
   assert.equal(error.failure.kind,'unsupported-design-source');assert.equal(error.failure.outcome,'not-audited');assert.match(error.failure.nextStep,/render_see/);return true;
  });
 }
});


test('remote raster documents cannot masquerade as rendered page design evidence',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=','base64');
 const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'image/png'});response.end(png);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await assert.rejects(renderCapture({source:`http://127.0.0.1:${server.address().port}/image`,output:'text',designAudit:true},path.join(root,'unused-remote.png')),error=>{
   assert.equal(error.failure.kind,'unsupported-design-source');assert.equal(error.failure.outcome,'not-audited');return true;
  });
 }finally{await new Promise(resolve=>server.close(resolve));}
});
