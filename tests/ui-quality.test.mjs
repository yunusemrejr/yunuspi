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
  for(const edits of [Array.from({length:65},()=>({newText:pill})),[{newText:'x'.repeat(256001)}]]) assert.deepEqual(authoredReviewSnippets('edit',{edits}),[]);
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

test('large authored files retain policy cues ahead of advisory noise without exposing commented examples',()=>{
  const dot='.answer::before {width:8px;height:8px;border-radius:50%;background:blue}';
  const large='.a{outline:none}.b{font-size:10px;text-transform:uppercase}.c{position:absolute}'.repeat(400)+dot;
  const snippets=authoredReviewSnippets('write',{content:large});
  assert.ok(snippets.length>1);assert.ok(snippets.every(s=>s.length<=24000));
  assert.equal(authoredReviewSignals('ui.css',snippets)[0].key,'ui-dot-marker');
  const comments=authoredReviewSnippets('write',{content:'/*'+'x'.repeat(25000)+dot+'*/'});
  assert.deepEqual(authoredReviewSignals('ui.css',comments),[]);
  assert.ok(keys('page.js',`style.textContent = \`${dot}\`;`).includes('ui-dot-marker'));
  assert.ok(keys('page.js','brand.innerHTML = icon("lightbulb");').includes('ui-bulb-brand'));
  assert.ok(!keys('lesson.js','const diagram = "lightbulb circuit";').includes('ui-bulb-brand'));
  assert.ok(keys('theme.css',':root{--accent:#c9a24a}').includes('ui-stock-warm-palette'));
  assert.ok(!keys('theme.css',':root{--warning:#c9a24a;--accent:#125bbc}').includes('ui-stock-warm-palette'));
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

test('reader-facing copy cues flag leakage, hype and theater with docs scoping',()=>{
  for(const [file,text,key] of [
    ['page.md','Built with Next.js and hosted on Vercel.','prose-implementation-leak'],
    ['page.md','Our React frontend talks to a Postgres schema through a GraphQL pipeline.','prose-implementation-leak'],
    ['page.md','Set in our signature typography on a strict 8-pt spacing grid.','prose-implementation-leak'],
    ['page.md','## How this site works','prose-transparency-section'],
    ['page.html','<h2>Our process</h2>','prose-transparency-section'],
    ['page.md','Our AI-powered workflow writes every draft.','prose-ai-provenance'],
    ['page.md','A revolutionary, seamless, robust and scalable next-generation platform.','prose-buzzword-stack'],
    ['page.md','A carefully curated exploration of our features.','prose-self-praise'],
    ['page.md','Private by design with military-grade 256-bit encryption.','prose-theater-claim'],
    ['page.md','Our mission is to revolutionize teamwork.','prose-mission-speak'],
    ['page.md','Ship 10x faster with 99% smarter reviews.','prose-metric-theater'],
    ['nav.html','<a href="/i">Insights</a><a href="/d">Discover</a>','prose-vague-nav'],
    ['nav.md','[Explore](/e) and [Resources](/r) are top-level.','prose-vague-nav'],
  ]) assert.ok(keys(file,text).includes(key),`${key} :: ${text}`);
  // Scoping: docs explain internals legitimately; policy pages explain postures.
  assert.ok(!keys('docs/setup.md','Built with Next.js, deployed with Docker.').includes('prose-implementation-leak'));
  assert.ok(!keys('docs/setup.md','## Methodology').includes('prose-transparency-section'));
  assert.ok(!keys('privacy-policy.md','Private by design with end-to-end encrypted storage.').includes('prose-theater-claim'));
  // Basis nearby clears metric theater; single buzzwords stay quiet.
  assert.ok(!keys('page.md','10x faster in our benchmark suite, measured on 400 teams.').includes('prose-metric-theater'));
  assert.ok(!keys('page.md','A robust tool for daily use.').includes('prose-buzzword-stack'));
  // Links and code are not copy.
  assert.ok(!keys('page.md','See [repo](https://github.com/acme/site) and `docker run`.').includes('prose-implementation-leak'));
});

test('structural cues flag card, section, footer, icon, tour and widget excess',()=>{
  const cards = n => Array.from({length:n},(_,i)=>`<div class="card">c${i}</div>`).join('');
  assert.ok(keys('Grid.tsx',cards(6)).includes('ui-card-cluster'));
  assert.ok(!keys('Grid.tsx',cards(5)).includes('ui-card-cluster'));
  const thin = Array.from({length:6},(_,i)=>`<section><h2>Part ${i}</h2><p>Short.</p></section>`).join('');
  assert.ok(keys('Page.tsx',thin).includes('ui-section-sprawl'));
  const fat = Array.from({length:6},(_,i)=>`<section><h2>Part ${i}</h2><p>${'Words '.repeat(150)}</p></section>`).join('');
  assert.ok(!keys('Page.tsx',fat).includes('ui-section-sprawl'));
  const footer = `<footer>${Array.from({length:15},(_,i)=>`<a href="/${i}">l${i}</a>`).join('')}</footer>`;
  assert.ok(keys('Page.tsx',footer).includes('ui-footer-bloat'));
  const icons = Array.from({length:12},()=>'<svg viewBox="0 0 1 1"></svg>').join('');
  assert.ok(keys('Page.tsx',icons).includes('ui-icon-density'));
  assert.ok(keys('Page.tsx','<button>Take the tour</button>').includes('ui-onboarding-nudge'));
  assert.ok(keys('Page.tsx','<button>Ask AI anything</button>').includes('ui-ai-widget'));
  assert.ok(!keys('Page.tsx','<button>Save</button>').some(k=>k.startsWith('ui-')),'clean button stays cue-free');
});

test('color, order, placement and prose-tell cues fire on stock patterns and stay quiet on systemized work', () => {
  const keys = (file, text) => signals(file, text, 12).map(s => s.key);
  assert.ok(keys('site/hero.css', '.hero{background:linear-gradient(90deg,#6366f1,#ec4899)}').includes('ui-stock-palette'));
  assert.ok(keys('site/Hero.tsx', '<div className="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500">').includes('ui-stock-palette'));
  assert.ok(!keys('site/brand.css', ':root{--accent:#0f766e}.hero{background:linear-gradient(90deg,#0f766e,#134e4a)}').includes('ui-stock-palette'));
  const sprawl = Array.from({ length: 13 }, (_, i) => `.c${i}{color:#${(0x102030 + i * 0x010101).toString(16)}}`).join('');
  assert.ok(keys('site/a.css', sprawl).includes('ui-hue-sprawl'));
  assert.ok(!keys('site/a.css', `:root{${Array.from({ length: 13 }, (_, i) => `--c${i}:#${(0x102030 + i * 0x010101).toString(16)};`).join('')}}.a{color:var(--c1)}.b{color:var(--c2)}.c{color:var(--c3)}`).includes('ui-hue-sprawl'));
  assert.ok(keys('site/a.css', Array.from({ length: 9 }, (_, i) => `.s${i}{text-align:center}`).join('')).includes('ui-centered-everything'));
  assert.ok(keys('site/index.html', '<h2>Trusted by teams</h2><h2>Features</h2><h2>How it works</h2><h2>What our customers say</h2><h2>Pricing</h2>').includes('ui-template-sequence'));
  assert.ok(!keys('site/index.html', '<h2>Features</h2><h2>Pricing</h2><h2>Contact</h2>').includes('ui-template-sequence'));
  const tells = "We delve into the rich tapestry of ideas. ".repeat(3) + 'The tool is fast, simple and reliable. It is clean, calm and quick. It is bright, bold and brave. We ship fast, test often and care deeply. '.repeat(4) + 'This is a testament to our work. '.repeat(3);
  assert.ok(keys('site/about.md', tells).includes('prose-ai-tells'));
  assert.ok(!keys('site/about.md', 'We make bread every morning at five. The rye takes two days. Come early on Saturdays; it sells out by ten.').includes('prose-ai-tells'));
});

test('user-banned ornaments are cued at edit time: accent rails, dot markers and icon tiles', () => {
  const keys = (file, text) => signals(file, text, 12).map(s => s.key);
  assert.ok(keys('a.css', '.card{border-left:3px solid #4aa3ff;padding:12px}').includes('ui-accent-rail'));
  assert.ok(keys('a.css', '.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:gold}').includes('ui-accent-rail'));
  assert.ok(keys('a.tsx', '<div className="pl-4 border-l-4 border-blue-500">').includes('ui-accent-rail'));
  assert.ok(!keys('a.css', 'blockquote{border-left:4px solid #ccc}').includes('ui-accent-rail'));
  assert.ok(keys('a.css', '.dot{width:8px;height:8px;border-radius:50%;background:#4aa3ff;box-shadow:0 0 8px #4aa3ff}').includes('ui-dot-marker'));
  assert.ok(keys('a.tsx', '<span className="h-2 w-2 rounded-full bg-emerald-500"/>').includes('ui-dot-marker'));
  assert.ok(keys('a.css', '.icon-wrap{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;border:1px solid #c9a24a}').includes('ui-icon-tile'));
  assert.ok(keys('a.tsx', '<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10">').includes('ui-icon-tile'));
  assert.deepEqual(keys('a.tsx', '<button className="h-10 px-4 rounded-lg bg-black text-white">Save</button>'), []);
});
