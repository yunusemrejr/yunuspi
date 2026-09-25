import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderCapture} from '../agent/scripts/render-capture.mjs';
import registerRender from '../agent/extensions/render-and-wait.ts';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'design-noise-patterns-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
let sequence=0;
const css=`html,body{margin:0;background:white;color:black;font:16px Arial}main{padding:12px}.pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:#eee}.dot,.pseudo::before{display:inline-block;content:"";width:8px;height:8px;border-radius:50%;background:green;animation:pulse .8s infinite}.static .dot{animation:none}.entrance .dot{animation-iteration-count:1}.square{border-radius:0}.panel{border-left:6px solid blue;margin:4px;padding:8px;width:240px;height:50px}@keyframes pulse{0%,100%{opacity:.2;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}@media(prefers-reduced-motion:reduce){.dot,.pseudo::before{animation:none}}`;
async function capture(body,options={}) {
 const source=path.join(root,`fixture-${sequence++}.html`);
 fs.writeFileSync(source,`<!doctype html><meta charset="utf-8"><title>Noise patterns</title><style>${css}</style><main>${body}</main>`);
 return {source,rendered:await renderCapture({source,output:'text',width:900,height:900,...options},path.join(root,'unused.png'))};
}
const kinds=result=>(result.noise?.findings??[]).map(f=>f.kind);

test('visible aria-hidden branding and dots on full-width headings cannot escape the same-capture checks',async()=>{
 const {rendered}=await capture('<style>h2{width:750px;font:16px Arial}.mark{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#ddd}h2::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:blue;margin-right:8px}</style><header><span class="mark" aria-hidden="true"><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg></span></header><h2>Answer</h2>');
 assert.ok(kinds(rendered).includes('icon-tile'));
 assert.ok(kinds(rendered).includes('decorative-dot-marker'));
 const inline=await capture('<style>.brand{width:38px;height:38px;border-radius:10px;border:1px solid #777;background:#eee}.heading{width:750px;height:24px}</style><header><svg class="brand" aria-hidden="true"><circle cx="19" cy="19" r="8"/></svg></header><main aria-live="polite" style="height:400px"><h2 class="heading pseudo">Answer</h2></main>');
 assert.ok(kinds(inline.rendered).includes('icon-tile'),'self-styled inline SVG counts as a tile');
 assert.ok(kinds(inline.rendered).includes('decorative-dot-marker'),'a large live conversation region is not a blanket state exemption');
 const hidden=await capture('<span hidden class="mark"><svg></svg></span><h2 style="display:none" class="pseudo">Answer</h2>');
 assert.deepEqual(kinds(hidden.rendered),[]);
});

test('actual repeated dot motion in a status capsule produces measured automatic advice',async()=>{
 const {rendered}=await capture('<span class="pill"><i aria-hidden="true" class="dot"></i>Live</span><span class="pill pseudo">Connected</span>');
 assert.deepEqual(kinds(rendered),['animated-status-pill','animated-status-pill']);
 for(const finding of rendered.noise.findings){assert.ok(finding.dot.widthPx>=5&&finding.dot.widthPx<=8);assert.equal(finding.dot.durationMs,800);assert.match(finding.reason,/repeatedly animated/);assert.match(finding.selector,/:nth-of-type/);}
 assert.equal(rendered.noise.findings[1].dot.pseudo,'::before');
 assert.equal(rendered.noise.measurements,undefined,'automatic receipt stays compact');
});

test('status semantics, state controls, hidden layouts and quoted/user content abstain; decorative dots are one aggregated finding',async()=>{
 const badge='<i aria-hidden="true" class="dot"></i>Active';
 const {rendered}=await capture(`<span class="pill" role="status">${badge}</span><span class="pill" aria-live="polite">${badge}</span><button class="pill" aria-pressed="true">${badge}</button><button class="pill">${badge}</button><span class="pill static">${badge}</span><span class="pill entrance">${badge}</span><span class="pill square">${badge}</span><span hidden class="pill">${badge}</span><span class="pill" style="opacity:0">${badge}</span><article><span class="pill">${badge}</span></article><div data-user-content><span class="pill">${badge}</span></div><blockquote><span class="pill">${badge}</span></blockquote><span class="pill">${badge} directory</span>`);
 // No animated-status-pill: none of these dots repeat motion without semantics.
 // Every unexempt static dot prefixing a label is the stock tell, reported once.
 assert.deepEqual(kinds(rendered),['decorative-dot-marker']);
 assert.equal(rendered.noise.findings[0].markers,5);
 const reduced=await capture(`<span class="pill">${badge}</span>`,{designAudit:true,reducedMotion:'reduce'});
 assert.deepEqual(kinds(reduced.rendered),['decorative-dot-marker']);assert.equal(reduced.rendered.noise.measurements.reducedMotion,true);
 const plain=await capture('<span class="pill">Invoices</span><span class="pill" role="status">${badge}</span>');
 assert.deepEqual(kinds(plain.rendered),[]);
});

test('accent rails, pseudo-element bars and icon tiles are flagged; plain icons and single accents are not',async()=>{
 const rails=await capture('<style>.card{position:relative;width:260px;height:60px;margin:6px;padding:8px 14px;border-radius:10px;background:#f4f4f4}.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#4aa3ff}.thin{border-left:2px solid #c9a24a;width:260px;height:60px;margin:6px}</style><div class="card">One</div><div class="card">Two</div><div class="thin">Three</div>',{designAudit:true});
 const rail=rails.rendered.noise.findings.find(f=>f.kind==='repeated-heavy-left-border');
 assert.equal(rail.panels,3);assert.deepEqual(rail.borderWidthsPx.sort(),[2,3]);
 const tile=await capture('<style>.tile{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;border:1px solid #c9a24a;background:#2a2410}</style><div class="tile"><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg></div>');
 assert.deepEqual(kinds(tile.rendered),['icon-tile']);
 const plainIcon=await capture('<p><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg> Settings</p><div style="border-left:6px solid blue;width:240px;height:50px">Only accent</div>');
 assert.deepEqual(kinds(plainIcon.rendered),[]);
});

test('font families count repeated UI text declarations, not sizes, fallback lists or article typography',async()=>{
 const families=['Arial','Georgia','monospace','Verdana'];
 const body=families.map(font=>`<div style="font-family:${font},serif"><button style="font-family:inherit">Save</button><h2>Settings</h2></div>`).join('');
 const {rendered}=await capture(body,{designAudit:true});
 const found=rendered.noise.findings.find(f=>f.kind==='many-interface-font-families');
 assert.equal(found.families,4);assert.equal(found.textElements,8);assert.equal(found.relatedSelectors.length,3);
 const intentional=await capture(`<article>${body}</article><button style="font-size:24px;font-weight:bold;font-family:Arial,Georgia,monospace,Verdana">Save</button><button style="font-size:12px;font-family:Arial,sans-serif">Open</button>`);
 assert.deepEqual(kinds(intentional.rendered),[]);
});

test('left accents need repeated measured heavy edges and exempt state/quotation examples',async()=>{
 const {rendered}=await capture('<section class="panel">First</section><section class="panel">Second</section><section class="panel">Third</section>',{designAudit:true});
 const found=rendered.noise.findings.find(f=>f.kind==='repeated-heavy-left-border');
 assert.equal(found.panels,3);assert.deepEqual(found.borderWidthsPx,[6]);assert.equal(found.relatedSelectors.length,2);
 const intentional=await capture('<section class="panel" role="alert">Failure</section><section class="panel" aria-live="polite">Saving</section><blockquote class="panel">Quotation</blockquote><section class="panel">One accent</section><div data-yunuspi-noise="ignore"><section class="panel">Intentional</section><section class="panel">Intentional</section></div>');
 assert.deepEqual(kinds(intentional.rendered),[]);
});

test('copy density measures bounded visible UI and preserves long-form content and substantial forms',async()=>{
 const paragraph=Array.from({length:50},()=> 'Detail').join(' ');
 const copy=Array.from({length:4},()=>`<p>${paragraph}</p>`).join('');
 const {rendered}=await capture(`<form style="width:360px">${copy}<button>Save</button><button>Cancel</button></form>`,{designAudit:true,width:390,height:844});
 const found=rendered.noise.findings.find(f=>f.kind==='dense-interface-copy');
 assert.ok(found);assert.ok(found.words>=160);assert.equal(found.controls,2);assert.ok(found.wordsPer100kPx>=50);assert.ok(found.visibleAreaPx>0);
 assert.equal(JSON.stringify(rendered.noise).includes('Detail'),false);
 const article=await capture(`<form style="width:360px">${copy}${Array.from({length:8},()=>'<input value="PRIVATE_VALUE">').join('')}<button>Save</button><button>Cancel</button></form><article>${copy}</article>`,{designAudit:true,width:390,height:900});
 assert.equal(kinds(article.rendered).includes('dense-interface-copy'),false,'actual input controls count without exposing values');
 assert.equal(JSON.stringify(article.rendered.noise).includes('PRIVATE_VALUE'),false);
 const longForm=await capture(`<article>${copy}<button>Share</button><button>Bookmark</button></article>`,{designAudit:true,width:390,height:844});
 assert.equal(kinds(longForm.rendered).includes('dense-interface-copy'),false);
});

test('viewport changes exclude responsive clones and the native design tool returns fuller same-capture evidence',async()=>{
 const {source,rendered}=await capture('<style>@media(max-width:500px){.desktop{display:none}}</style><span class="pill desktop"><i class="dot"></i>Online</span>',{width:390,height:844});
 assert.deepEqual(kinds(rendered),[]);
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=path.join(root,'native-agent');
 try{
  const tools=new Map();registerRender({registerTool:tool=>tools.set(tool.name,tool),on(){}});
  const result=await tools.get('design_audit').execute('patterns',{source,output:'text',width:1200,height:900},undefined,undefined,{cwd:root,model:{input:['text']},sessionManager:{getSessionId:()=> 'noise-patterns'}});
  assert.equal(result.details.noise.findings[0].kind,'animated-status-pill');
  assert.deepEqual(result.details.noise.measurements.viewport,{width:1200,height:900});
  const receipt=JSON.parse(result.content[0].text);assert.deepEqual(receipt.noise,result.details.noise);assert.ok(!('score' in receipt.noise));
 }finally{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('new advisory output remains bounded under repeated badges and explicit scans',async()=>{
 const body=Array.from({length:100},()=>'<span class="pill"><i class="dot"></i>Live</span>').join('');
 const ordinary=await capture(body);assert.equal(ordinary.rendered.noise.findings.length,6);assert.equal(ordinary.rendered.noise.truncated,true);assert.ok(JSON.stringify(ordinary.rendered).length<=14000);
 const detailed=await capture(body,{designAudit:true});assert.ok(detailed.rendered.noise.findings.length<=12);assert.equal(detailed.rendered.noise.truncated,true);assert.ok(JSON.stringify(detailed.rendered).length<=14000);
});


test('quantified marketing candidates require evidence without classifying ordinary UI data as false',async()=>{
 const {rendered}=await capture('<p>Trusted by 10,000 teams</p><p>3× faster</p><p>99.99% uptime</p><p>Save 30% on operating costs</p>');
 assert.deepEqual(kinds(rendered),Array(4).fill('factual-claim-evidence'));
 for(const finding of rendered.noise.findings)assert.match(finding.reason,/does not establish.*false or unsupported/);
 const ordinary=await capture('<p>Invoice total 1200</p><p>Storage used 90%</p><table><tr><td>99.99% uptime</td></tr></table><figure><figcaption>3× faster</figcaption></figure><article><p>Trusted by 10,000 teams</p></article><div data-user-content><p>Save 30%</p></div><input value="Save 30%">');
 assert.deepEqual(kinds(ordinary.rendered),[]);
});
