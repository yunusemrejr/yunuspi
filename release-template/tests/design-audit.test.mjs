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

test('ordinary capture automatically reports exact visible noise candidates without another render',async()=>{
 const source=path.join(root,'noise.html');
 fs.writeFileSync(source,`<!doctype html><title>Noise fixture</title><main>
 <h2>Invoices</h2><h2>Invoices</h2>
 <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
 <nav><a href="/invoices">Open invoices</a><a href="/invoices">Open invoices</a></nav>
 <label for="customer">Customer</label><label for="customer">Customer</label><input id="customer" value="PRIVATE_VALUE">
 </main>`);
 const rendered=await renderCapture({source,output:'text'},path.join(root,'unused-noise.png'));
 assert.equal(rendered.pageState.design,undefined,'automatic noise review does not expand the full design scan');
 assert.deepEqual(rendered.noise.findings.map(f=>f.kind),['repeated-adjacent-label','placeholder-copy','repeated-adjacent-link','repeated-adjacent-label']);
 for(const finding of rendered.noise.findings) assert.match(finding.selector,/:nth-of-type\(/);
 assert.equal(JSON.stringify(rendered.noise).includes('Invoices'),false,'no copied page text in the noise receipt');
 assert.equal(JSON.stringify(rendered.noise).includes('PRIVATE_VALUE'),false);
 const image=await renderCapture({source,output:'image',width:400,height:300},path.join(root,'noise.png'));
 assert.equal(image.noise.findings.length,4,'vision output gets the same automatic advisory');
 const previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=path.join(root,'native-agent');
 try {
  const tools=new Map();registerRender({registerTool:tool=>tools.set(tool.name,tool),on(){}});
  const result=await tools.get('render_see').execute('noise-fixture',{source,output:'text'},undefined,undefined,{cwd:root,model:{input:['text']},sessionManager:{getSessionId:()=> 'noise-fixture'}});
  assert.deepEqual(result.details.noise.findings,rendered.noise.findings);
  assert.equal(JSON.parse(result.content[0].text).noise.findings.length,4,'advisories reach the actual native tool result');
 } finally {if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('noise review abstains on hidden clones, separate regions, different actions and code examples',async()=>{
 const source=path.join(root,'intentional.html');
 fs.writeFileSync(source,`<!doctype html><title>Intentional repetition</title>
 <h2>Invoices</h2><h2 hidden>Invoices</h2>
 <div style="opacity:0"><h2>Hidden</h2><h2>Hidden</h2><p>Your title here</p></div>
 <nav><a href="/one?view=a">Open</a><a href="/one?view=b">Open</a></nav>
 <nav><a href="/one">Open</a></nav><footer><a href="/one">Open</a></footer>
 <h3 role="presentation">Decorative</h3><h3 role="presentation">Decorative</h3>
 <label for="first">Name</label><label for="second">Name</label>
 <pre>Lorem ipsum dolor sit amet</pre><code>Your title here</code><blockquote>Lorem ipsum dolor sit amet</blockquote>
 <p>The history of lorem ipsum is documented here.</p><input value="Placeholder text" placeholder="Your title here">
 <button>Save</button><button>Save</button>`);
 const ordinary=await renderCapture({source,output:'text'},path.join(root,'unused-intentional.png'));
 assert.equal(ordinary.noise,undefined,'clean automatic checks add no context payload');
 const explicit=await renderCapture({source,output:'text',designAudit:true},path.join(root,'unused-intentional-audit.png'));
 assert.deepEqual(explicit.noise.findings,[]);
 assert.match(explicit.noise.scope,/intentional/);
 const bounded=path.join(root,'noise-bounded.html');
 fs.writeFileSync(bounded,'<!doctype html>'+Array.from({length:100},()=>'<p>Your title here</p>').join(''));
 const many=await renderCapture({source:bounded,output:'text'},path.join(root,'unused-noise-bounded.png'));
 assert.equal(many.noise.findings.length,6);assert.equal(many.noise.truncated,true);assert.ok(many.noise.visited<=600);
 assert.ok(JSON.stringify(many).length<=14000);
});

test('design audit counts rendered slop signatures with locations, not verdicts',async()=>{
 const source=path.join(root,'slop.html');
 const pills=Array.from({length:7},(_,i)=>`<span class="pill">Tag ${i}</span>`).join('');
 fs.writeFileSync(source,`<!doctype html><style>
html,body{background:#111;color:#eee;font:16px Arial;margin:0}main{padding:24px}
.pill{display:inline-block;padding:4px 16px;border-radius:999px;background:#222}
.glow{width:120px;height:40px;margin:8px 0;box-shadow:0 0 24px rgba(255,150,50,.55)}
.drop{width:120px;height:40px;box-shadow:4px 6px 8px rgba(0,0,0,.3)}
.panel{width:600px;height:300px;border-radius:24px;background:#1a1a1a}
.gtext{background:linear-gradient(red,blue);-webkit-background-clip:text;background-clip:text;color:transparent}
.glass{width:200px;height:80px;margin:8px 0;backdrop-filter:blur(12px);background:rgba(255,255,255,.2)}
.tglow{text-shadow:0 0 12px orange}
</style><main><div class="panel">Panel</div>${pills}
<div class="glow"></div><div class="glow"></div><div class="glow"></div><div class="glow"></div><div class="drop"></div>
<p class="gtext">Gradient headline</p>
<div class="glass"></div><div class="glass"></div><div class="glass"></div>
<p class="tglow">Glow one</p><p class="tglow">Glow two</p><p class="tglow">Glow three</p><p class="tglow">Glow four</p></main>`);
 const rendered=await renderCapture({source,output:'text',width:800,height:600,designAudit:true},path.join(root,'unused-slop.png'));
 const d=rendered.pageState.design;assert.ok(d);assert.equal(d.version,2);
 assert.deepEqual(d.slopSignals,{pills:7,glowShadows:4,gradientText:1,glass:3,textGlow:4});
 const kinds=d.findings.filter(f=>f.kind.startsWith('slop-')).map(f=>f.kind).sort();
 assert.deepEqual(kinds,['slop-glass','slop-glow-shadows','slop-gradient-text','slop-pills','slop-text-glow']);
 for(const f of d.findings.filter(f=>f.kind.startsWith('slop-'))){assert.match(f.selector,/:nth-of-type\(/);assert.ok(f.count>=f.threshold);}
 assert.match(d.limitations,/not verdicts/);
});
