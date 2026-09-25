import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/slop-guidance-signals.ts')));
const load=p=>import(pathToFileURL(path.join(agent,p)));
const {slopGuidanceSignals:signals,inspectUiSource}=await load('extensions/lib/slop-guidance-signals.ts');
const {authoredReviewSnippets,authoredReviewSignals}=await load('extensions/lib/authored-review.ts');
const {createQualityReviewLifecycle,reviewAspects}=await load('extensions/lib/quality-review.ts');
const {createRelevantGuidance}=await load('extensions/lib/relevant-guidance.ts');
const {routeSkills}=await load('extensions/lib/skill-routing.ts');
const {default:registerSmallTools}=await load('extensions/lib/small-tools.ts');
const {HOOK_RULES}=await load('extensions/lib/session-hooks.ts');
const pill='<span className="rounded-full"><span className="animate-ping" />Live</span>';
const keys=(file,text)=>signals(file,text,12).map(s=>s.key);

test('source checks identify specific component problems with independent negative controls',()=>{
  for(const [file,text,key] of [
    ['Status.tsx',pill,'ui-live-pill'],
    ['Status.html','<div class="badge"><i class="pulsing-dot"></i>Online</div>','ui-live-pill'],
    ['Button.tsx','<div onClick={save}>Save</div>','ui-clickable-container'],
    ['nav.html','<a href="#">Reports</a>','ui-placeholder-navigation'],
    ['theme.css','button:focus { outline: none; }','ui-focus-suppression'],
    ['theme.css','p{color:#aaa;background:#fff}','ui-low-contrast-pair'],
    ['theme.css','h1{font-family:"Alpha",serif} h2{font-family:Beta} p{font-family:Gamma}','ui-font-competition'],
    ['theme.css','small{font-size:10px;text-transform:uppercase}','ui-small-tracked-copy'],
    ['theme.css','.a{position:absolute}.b{position:absolute}.c{position:absolute}','ui-fragile-placement'],
  ]) assert.ok(keys(file,text).includes(key),key);
  for(const text of ['<span aria-live="polite">Connected</span>','<span class="rounded-full">Live</span>','<span class="animate-pulse">Loading</span>',`<!-- ${pill} -->`,`/* ${pill} */`])
    assert.ok(!keys('ui.tsx',text).includes('ui-live-pill'),text);
  for(const text of ['p{color:#000;background:#fff}','p{color:#aaa}.panel{background:#fff}','p{color:var(--muted);background:#fff}','p{color:#aaa;background:linear-gradient(white,black)}'])
    assert.ok(!keys('ui.css',text).includes('ui-low-contrast-pair'),text);
  assert.ok(!keys('ui.css','p{font-family:"Alpha",Beta,Gamma,serif}').includes('ui-font-competition'),'fallback stack is one role');
  for(const file of ['vendor/ui.css','vendor\\ui.css','ui.test.tsx','skills/example.md']) assert.equal(keys(file,pill).length,0);
  assert.equal(inspectUiSource('ui.json','{}').status,'unsupported');
  assert.throws(()=>inspectUiSource('ui.tsx','x'.repeat(24001)),/24000/);
  const quiet=inspectUiSource('ui.html','<button>Save</button>');
  assert.equal(quiet.status,'inspected');assert.deepEqual(quiet.findings,[]);assert.match(quiet.scope,/No findings does not mean good design/);
});

test('batch edits share cues between reminders and review checkpoints without joining unrelated replacements',()=>{
  const input={path:'Status.tsx',edits:[{newText:pill},{newText:'items.forEach(async item => save(item))'}]};
  const expected=['ui-live-pill','async-foreach'];
  const snippets=authoredReviewSnippets('edit',input);
  for(const key of expected) assert.ok(authoredReviewSignals(input.path,snippets).some(s=>s.key===key));
  assert.equal(authoredReviewSignals('x.ts',authoredReviewSnippets('edit',{edits:[{newText:'node.innerHTML'},{newText:'= untrusted'}]})).length,0);
  for(const edits of [Array.from({length:65},()=>({newText:pill})),[{newText:'x'.repeat(24001)}]]) assert.deepEqual(authoredReviewSnippets('edit',{edits}),[]);
  const ctx={cwd:'/quality-case',sessionManager:{getBranch:()=>[]}},pi={registerTool(){},getActiveTools:()=>['read','write','edit','artifact_check'],appendEntry(){}};
  const g=createRelevantGuidance(pi);g.restore(ctx);g.start({prompt:'Review the UI components',systemPrompt:''},ctx);
  const lifecycle=createQualityReviewLifecycle(pi,{refresh:async()=>{},tests:()=>({need:null})});lifecycle.restore(ctx);lifecycle.input({source:'interactive',text:'Review UI'});
  try {
    const event={toolName:'edit',input,isError:false};g.record(event);lifecycle.result(event,ctx);
    for(const key of expected){assert.ok(g.candidates().some(h=>h.key==='signal:'+key));assert.ok(lifecycle.snapshot().patterns.some(s=>s.key===key));}
    lifecycle.result({toolName:'edit',input:{path:'Status.tsx',newText:'const clean = true;'}},ctx);
    assert.ok(lifecycle.snapshot().patterns.some(s=>s.key==='ui-live-pill'),'unrelated edit retains cue');
    lifecycle.result({toolName:'write',input:{path:'Status.tsx',content:'<button>Save</button>'}},ctx);
    assert.deepEqual(lifecycle.snapshot().patterns,[],'complete repair clears cue');
    lifecycle.result({...event,isError:true},ctx);assert.deepEqual(lifecycle.snapshot().patterns,[],'failed write adds no source evidence');
  } finally {lifecycle.shutdown();}
});

test('UI artifact operation uses safe workspace reads in parent and child profiles',async t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'ui-source-check-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.writeFileSync(path.join(cwd,'Status.tsx'),pill);fs.writeFileSync(path.join(cwd,'large.tsx'),'x'.repeat(24001));
  const tools=new Map();registerSmallTools({registerTool:t=>tools.set(t.name,t)});
  const call=(p,signal)=>tools.get('artifact_check').execute('check',p,signal,undefined,{cwd});
  const result=await call({operation:'ui',path:'Status.tsx'});assert.notEqual(result.isError,true);assert.equal(result.details.findings[0].key,'ui-live-pill');assert.match(result.details.sourceHash,/^[a-f0-9]{64}$/);
  for(const p of [{operation:'ui',text:pill},{operation:'ui',path:'../outside.tsx'},{operation:'ui',path:'large.tsx'}]) assert.equal((await call(p)).isError,true);
  assert.equal((await call({operation:'ui',path:'Status.tsx'},AbortSignal.abort())).isError,true);
  const hook=HOOK_RULES.find(h=>h.key==='ui-source-evidence');assert.ok(hook.when({operation:'ui'}));assert.ok(!hook.when({operation:'image'}));
});

test('anti-boilerplate intent routes the shared worker and parent policy without treating quotations as tasks',()=>{
  assert.ok(routeSkills('Improve anti-boilerplate checks').some(s=>s.name==='anti-ai-slop'));
  assert.ok(routeSkills('Review blinking status dots in UI components').some(s=>s.name==='ui-antipattern-review'));
  assert.ok(routeSkills('Review font combinations').some(s=>s.name==='ui-antipattern-review'));
  assert.deepEqual(routeSkills('> Review blinking status dots'),[]);
  assert.deepEqual(routeSkills('Do not review font combinations'),[]);
  assert.match(reviewAspects(['Status.tsx']).find(a=>a.id==='interface').rubric,/learned similarity only select inspection targets/);
});

test('DOM-generating scripts get markup-shape cues and promote the interface aspect',()=>{
  const dom='const card = `<div class="badge" onClick="open()"><i class="pulsing-dot"></i>Live</div><a href="#">more</a>`;';
  assert.ok(keys('app.js',dom).includes('ui-live-pill'));
  assert.ok(keys('app.js',dom).includes('ui-clickable-container'));
  assert.ok(keys('app.js',dom).includes('ui-placeholder-navigation'));
  assert.ok(keys('render.ts',dom).includes('ui-clickable-container'));
  // Stylesheet cues need an authorial stylesheet, not an embedded declaration.
  assert.ok(!keys('app.js','el.style.position="absolute"; el.style.position="absolute"; el.style.position="absolute";').includes('ui-fragile-placement'));
  assert.ok(!keys('app.js','// <div onClick="x"> sketch, not code').includes('ui-clickable-container'));
  assert.ok(!keys('server.js','const total = items.reduce((a,b)=>a+b,0);').length,'backend logic stays cue-free');
  // Cue promotion: an app.js-only change with markup cues demands interface review.
  assert.ok(!reviewAspects(['app.js'],'Triage mail faster').some(a=>a.id==='interface'));
  assert.ok(reviewAspects(['app.js'],'Triage mail faster',[],[{key:'ui-clickable-container',file:'app.js'}]).some(a=>a.id==='interface'));
  assert.ok(!reviewAspects(['app.js'],'Triage mail faster',[],[{key:'async-foreach'}]).some(a=>a.id==='interface'),'non-UI cues do not promote');
});
