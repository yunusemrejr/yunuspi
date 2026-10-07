import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const {reviewSvg,optimizeSvg,verifyOptimized,compactPath,parsePath,svgReviewRun}=await jiti.import('../agent/extensions/lib/svg-analysis.ts');
const {measureSvg}=await jiti.import('../agent/extensions/lib/svg-inspect.ts');
const {default:registerArtDirection}=await jiti.import('../agent/extensions/art-direction.ts');
const {default:registerSmallTools}=await jiti.import('../agent/extensions/lib/small-tools.ts');
const {intentBundleTools}=await jiti.import('../agent/extensions/lib/tool-discovery.ts');
const rules=(svg,options)=>reviewSvg(svg,options).findings.map(f=>f.rule);
const icon=(body,attrs='')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attrs}>${body}</svg>`;

const MESSY=`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="48" height="48" viewBox="0 0 24 24" version="1.1" id="svg5">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="12"/>
  <metadata><rdf:RDF>editor metadata editor metadata editor metadata editor metadata editor metadata</rdf:RDF></metadata>
  <defs id="defs2"><linearGradient id="unused1"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <g id="g12"></g>
  <path id="path123" fill="#333333" fill-rule="nonzero" inkscape:connector-curvature="0" d="M 12.000000,2.000000 C 6.477153,2.000000 2.000000,6.477153 2.000000,12.000000 C 2.000000,17.522847 6.477153,22.000000 12.000000,22.000000 C 17.522847,22.000000 22.000000,17.522847 22.000000,12.000000 C 22.000000,6.477153 17.522847,2.000000 12.000000,2.000000 Z"/>
</svg>`;

test('path data parses per the SVG grammar, including fused arc flags and implicit repeats',()=>{
  assert.deepEqual(parsePath('M1 2l3 4 5 6')?.map(s=>s.cmd),['M','l','l']);
  assert.deepEqual(parsePath('a1 1 0 01.5 2')?.[0].args,[1,1,0,0,1,0.5,2],'fused flag digits are not one number');
  assert.equal(parsePath('M1 2 Q'),undefined);
  assert.equal(parsePath('X1 2'),undefined);
  for (const d of ['M8 8L56,,56', 'M8 8L,56 56', 'M8 8L56 56,', ',M8 8L56 56', 'M8 8,L56 56', 'M8 8L56 56,Z', 'M1e309 2']) {
    assert.equal(parsePath(d), undefined, d);
    assert.equal(compactPath(d), d, 'malformed path must stay untouched');
  }
  assert.deepEqual(parsePath('M8,8,56,56')?.map(s=>s.cmd), ['M','L']);
  assert.deepEqual(parsePath('M.1.2L3-4')?.map(s=>s.args), [[.1,.2],[3,-4]]);
  assert.equal(compactPath('M 12.000000,2.000000 L 5.5,-3.25 z'),'M12 2L5.5-3.25z');
  assert.equal(compactPath('M0.500 0.250 l-.5 .5'),'M.5.25l-.5.5');
  assert.equal(compactPath('not a path'),'not a path','malformed data is left alone');
});

test('geometry findings come from the measured bounds, with stroke reach added',()=>{
  assert.equal(reviewSvg(icon('<rect x="-3" y="4" width="12" height="8"/>')).findings.find(f=>f.rule==='art-outside-viewbox').severity,'high');
  assert.ok(rules(icon('<rect x="0" y="0" width="24" height="24"/>')).includes('no-safe-margin'));
  assert.ok(rules(icon('<circle cx="6" cy="6" r="3"/>')).includes('off-centre'));
  assert.ok(!rules(icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>')).some(r=>['art-outside-viewbox','stroke-clipped','no-safe-margin','off-centre'].includes(r)));
  assert.ok(rules(icon('<path d="M1 12h22" stroke="currentColor" stroke-width="4"/>')).includes('stroke-clipped'),'a stroke reaching past the edge is clipped');
  assert.ok(!rules(icon('<path d="M4 12h16" stroke="currentColor" stroke-width="2"/>')).includes('stroke-clipped'));
  assert.equal(reviewSvg(icon('<rect x="-30" y="4" width="4" height="4" transform="rotate(30)"/>')).findings.find(f=>f.rule==='art-outside-viewbox').severity,'medium','rotation makes bounds approximate');
  assert.ok(!rules(icon('<rect x="-3" y="4" width="12" height="8"/>','overflow="visible"')).includes('art-outside-viewbox'));
});

test('scaling, theming and weight rules',()=>{
  const fixed='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1h2"/></svg>';
  assert.equal(reviewSvg(fixed).findings.find(f=>f.rule==='missing-viewbox').severity,'high');
  assert.ok(rules(icon('<path d="M4 4h16v16H4z" fill="#123456"/>')).includes('hardcoded-icon-colour'));
  assert.ok(!rules(icon('<path d="M4 4h16v16H4z" fill="currentColor"/>')).includes('hardcoded-icon-colour'));
  assert.ok(!rules(icon('<path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/>')).includes('hardcoded-icon-colour'));
  assert.ok(!rules(icon('<path d="M4 4h16v16H4z" fill="#111"/><path d="M6 6h4v4H6z" fill="#e33"/><path d="M12 12h4v4h-4z" fill="#3e3"/>')).includes('hardcoded-icon-colour'),'multi-colour brand marks keep their colours');
  assert.ok(rules(icon('<path d="M4 4h16v16H4z"/>')).includes('implicit-black'));
  assert.ok(rules(icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>','preserveAspectRatio="none"')).includes('stretchy-aspect'));
  assert.ok(rules(icon('<path d="M4 4 C6 6 8 8 10 10 C6 6 8 8 10 10 C6 6 8 8 10 10 C6 6 8 8 10 10"/>'.repeat(40))).includes('node-bloat'));
  assert.ok(rules(icon('<path fill="currentColor" d="M12 4C16.4 4 20 7.6 20 12C20 16.4 16.4 20 12 20C7.6 20 4 16.4 4 12C4 7.6 7.6 4 12 4Z"/>')).includes('primitive-as-path'));
  assert.ok(rules(icon('<image href="data:image/png;base64,'+'A'.repeat(20000)+'"/>')).includes('embedded-raster'));
  assert.ok(rules(icon('<text x="2" y="12">Hi</text>')).includes('live-text'));
  assert.ok(rules(icon('<circle cx="12" cy="12" r="6" fill="currentColor" filter="url(#f)"/><filter id="f" x="0" y="0" width="1" height="1"><feGaussianBlur stdDeviation="2"/></filter>')).includes('filter-cost'));
});

test('long path data is measured in full, not cut at 4096 characters',()=>{
  const d='M0 0'+Array.from({length:3000},(_,i)=>`L${(i%97)+.123456} ${(i%89)+.654321}`).join('')+'Z';
  assert.ok(d.length>4096*4);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${d}"/></svg>`;
  const measure=measureSvg(svg);
  assert.equal(measure.longestPathNodes,3002,'every command counts');
  assert.ok(measure.unionBounds.width>95,'bounds reach the far end of the path');
  assert.ok(rules(svg).includes('over-traced-path'));
});

test('structure and safety findings are high severity; kind can be overridden',()=>{
  const bad=reviewSvg(icon('<script>alert(1)</script><circle cx="12" cy="12" r="6" fill="currentColor" onclick="x()"/>'));
  assert.equal(bad.findings.find(f=>f.rule==='active-content').severity,'high');
  const broken=reviewSvg(icon('<use href="#missing"/><circle id="a" cx="12" cy="12" r="6" fill="currentColor"/><circle id="a" cx="1" cy="1" r="1"/>'));
  assert.ok(broken.findings.some(f=>f.rule==='missing-reference'&&f.severity==='high'));
  assert.ok(broken.findings.some(f=>f.rule==='duplicate-id'&&f.severity==='high'));
  assert.ok(broken.score<=60&&broken.verdict!=='ship');
  assert.equal(reviewSvg(icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>')).verdict,'ship');
  assert.equal(reviewSvg(icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>')).kind,'icon');
  assert.equal(reviewSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#123"/></svg>').kind,'illustration');
  assert.equal(reviewSvg(icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>'),{kind:'logo'}).kind,'logo');
  assert.throws(()=>reviewSvg('<div>not svg</div>'),/No <svg>/);
  assert.throws(()=>reviewSvg('x'.repeat(2*1024*1024+1)),/2 MiB/);
});

test('optimizer removes editor cruft losslessly, verifies against measurements, and keeps what is referenced',()=>{
  const result=optimizeSvg(MESSY);
  assert.ok(result.after<result.before*0.4,`${result.before} -> ${result.after}`);
  for(const gone of ['Inkscape','sodipodi','inkscape','metadata','unused1','<g','id="path123"','fill-rule','<?xml','000000'])assert.ok(!result.svg.includes(gone),`${gone} removed`);
  assert.ok(result.svg.includes('viewBox="0 0 24 24"')&&result.svg.includes('fill="#333333"'));
  assert.deepEqual(verifyOptimized(MESSY,result.svg),{ok:true});
  const used=icon('<defs><linearGradient id="g1"><stop offset="0" stop-color="#f00"/></linearGradient></defs><circle cx="12" cy="12" r="6" fill="url(#g1)"/>');
  assert.ok(optimizeSvg(used).svg.includes('id="g1"'),'a referenced gradient survives');
  const inherited=icon('<g stroke-linecap="round"><path d="M4 12h16" stroke="currentColor" stroke-linecap="butt"/></g>');
  assert.ok(optimizeSvg(inherited).svg.includes('stroke-linecap="butt"'),'a default that overrides an inherited value is kept');
  assert.ok(optimizeSvg(icon('<text x="2" y="12">A  B</text>')).svg.includes('A  B'),'text whitespace is preserved');
  assert.equal(verifyOptimized(MESSY,icon('<circle cx="12" cy="12" r="6"/>')).ok,false,'a different drawing is not accepted as an optimization');
  assert.equal(optimizeSvg(optimizeSvg(MESSY).svg).svg,optimizeSvg(MESSY).svg,'optimizing twice is stable');
  const review=reviewSvg(MESSY);
  assert.ok(review.optimization.savedPercent>60&&review.findings.some(f=>f.rule==='optimizable'));
});

test('svgReviewRun reviews files worst-first, writes verified copies elsewhere and refuses paths outside the workspace',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'svg-review-'));
  try {
    fs.mkdirSync(path.join(dir,'icons'));
    fs.writeFileSync(path.join(dir,'icons/messy.svg'),MESSY.replace(/\n/g,' '));
    fs.writeFileSync(path.join(dir,'icons/fine.svg'),icon('<circle cx="12" cy="12" r="8" fill="currentColor"/>','role="img"'));
    const report=await svgReviewRun({paths:['icons/fine.svg','icons/messy.svg']},dir);
    assert.deepEqual(report.reviews.map(r=>r.file),['icons/messy.svg','icons/fine.svg'],'lowest score first, single-line files read');
    assert.ok(report.reducibleBytes>500);
    assert.equal(report.reviews[0].optimized,undefined,'nothing is written without optimize');
    const optimized=await svgReviewRun({path:'icons/messy.svg',optimize:true},dir);
    const copy=optimized.reviews[0].optimized;
    assert.equal(copy.verified,true);assert.ok(copy.after<copy.before);
    assert.match(copy.file,/^\.pi\/design\/svg-[0-9a-f]+\/00-messy\.svg$/);
    assert.ok(fs.readFileSync(path.join(dir,'icons/messy.svg'),'utf8').includes('Inkscape'),'the original is untouched');
    assert.match(fs.readFileSync(path.join(dir,'.pi/design/.gitignore'),'utf8'),/\*/);
    await assert.rejects(svgReviewRun({path:'../outside.svg'},dir),/inside the workspace/);
    await assert.rejects(svgReviewRun({},dir),/needs path/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('svg_inspect exposes review with its options and stays one SVG tool',()=>{
  const tools=new Map();
  registerArtDirection(new Proxy({registerTool:t=>tools.set(t.name,t)},{get:(target,key)=>key in target?target[key]:()=>{}}));
  const schema=tools.get('svg_inspect').parameters.properties;
  assert.deepEqual(schema.action.enum,['inspect','review','matrix']);
  for(const key of ['kind','optimize','precision','outputDir','paths','path'])assert.ok(schema[key],key);
  assert.match(tools.get('svg_inspect').description,/action review/);
  assert.ok(![...tools.keys()].includes('svg_audit'));
});

test('a saved .svg gets review findings on the existing svg-check note',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'svg-hook-'));
  const hooks=new Map();registerSmallTools({registerTool(){},on:(name,handler)=>hooks.set(name,handler)});
  try {
    fs.writeFileSync(path.join(dir,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1h4v4z" fill="#123456"/></svg>');
    const result=await hooks.get('tool_result')({toolName:'write',input:{path:'logo.svg'},content:[{type:'text',text:'ok'}],details:{},isError:false},{cwd:dir});
    assert.match(result.content.at(-1).text,/\[svg-review\] .*missing-viewbox/);
    assert.match(result.content.at(-1).text,/svg_inspect\(\{action:"review"\}\)/);
    assert.ok(result.content.at(-1).text.length<=600,'the receipt keeps its 600-character budget');
    fs.writeFileSync(path.join(dir,'big.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><script>x()</script><path d="M1 1h4v4z" fill="#123456"/><use href="#a"/><use href="#b"/><g id="d"/><g id="d"/></svg>');
    const crowded=await hooks.get('tool_result')({toolName:'write',input:{path:'big.svg'},content:[{type:'text',text:'ok'}],details:{},isError:false},{cwd:dir});
    assert.ok(crowded.content.at(-1).text.length<=600,'structural errors plus review findings still fit the budget');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('security, backend, SVG and pattern requests stage the audit tools; unrelated prompts do not',()=>{
  for(const prompt of ['Audit the backend API for security holes','Fix the SQL injection in the login endpoint','Fix the slow endpoint, it runs an N+1 query per row','Review our coding patterns and anti-patterns','Run an accessibility audit on the checkout'])
    assert.ok(intentBundleTools(prompt).includes('code_audit'),prompt);
  for(const prompt of ['Optimize the SVG icons in /assets','Design a vector logo mark','Fix icons.svg so it scales'])
    assert.ok(intentBundleTools(prompt).includes('svg_inspect'),prompt);
  for(const prompt of ['Fix the off-by-one error in the pagination helper','Rename the variable in the parser','Explain how the cache works'])
    assert.deepEqual(intentBundleTools(prompt).filter(t=>t==='code_audit'||t==='svg_inspect'),[],prompt);
});
