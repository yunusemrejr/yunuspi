// Keep metadata/routing fixtures independent of remote judge configuration.
process.env.PI_JEV = "off";
import os from 'node:os';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/relevant-guidance.ts')));
const load=p=>import(pathToFileURL(path.join(agent,p)));
const {createRelevantGuidance}=await load('extensions/lib/relevant-guidance.ts');
const {routeSkills}=await load('extensions/lib/skill-routing.ts');
const {buildSkillIndex,rankSkills}=await load('extensions/lib/skill-relevance.ts');

// Old installations can retain required mode. It must remain advisory and
// preserve discovery and honest reference status without blocking tools.
const inheritedSkillReview=process.env.PI_SKILL_REVIEW;
beforeEach(()=>{process.env.PI_SKILL_REVIEW='required';});
afterEach(()=>{
  if(inheritedSkillReview===undefined) delete process.env.PI_SKILL_REVIEW;
  else process.env.PI_SKILL_REVIEW=inheritedSkillReview;
});

function fixture(names=['python-software-engineering','typescript-contract-engineering'], skillRoot='/fixture/skills') {
  const active=['read','edit','write','skill_review','syntax_check'];
  const tools=new Map(),entries=[],hooks=new Map();
  const g=createRelevantGuidance({on:(name,fn)=>hooks.set(name,fn),getActiveTools:()=>active,registerTool:t=>tools.set(t.name,t),appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  const ctx={cwd:'/fixture/project',sessionManager:{getBranch:()=>entries}};
  const catalog=`<available_skills>${names.map(name=>`<skill><name>${name}</name><description>${name.replaceAll('-',' ')}</description><location>${skillRoot}/${name}/SKILL.md</location></skill>`).join('')}</available_skills>`;
  const start=(prompt='Fix the reported issue')=>{g.userInput();g.start({prompt,systemPrompt:catalog},ctx);};
  const edit=file=>g.beforeToolCall({toolName:'edit',input:{path:file}});
  const read=(name,extra={})=>g.record({toolName:'read',input:{path:`${skillRoot}/${name}/SKILL.md`,...extra.input},...extra});
  const decide=input=>tools.get('skill_review').execute('decision',input);
  const context=(messages=[])=>hooks.get('context')({messages},ctx)?.messages ?? messages;
  g.restore(ctx);start();return {g,active,ctx,start,edit,read,decide,entries,context,catalog};
}

test('positive clauses route languages without importing exclusions or quoted prose',()=>{
  for(const prompt of ['Do not write Python. Implement TypeScript contracts','Do not write Python, but implement TypeScript contracts','Implement TypeScript contracts rather than write Python']) {
    const names=routeSkills(prompt).map(r=>r.name);
    assert.ok(names.includes('typescript-contract-engineering'),prompt);
    assert.ok(!names.includes('python-software-engineering'),prompt);
  }
  for(const prompt of ['Do not write Python','Explain how to write Python','> Write Python','```\nWrite Python\n```']) {
    assert.deepEqual(routeSkills(prompt),[]);
    const f=fixture();f.start(prompt);assert.ok(!f.g.candidates().some(h=>h.skill),prompt);
  }
});

test('catalog names match ordinary prose while delivery stays bounded and advisory',()=>{
  const skills=['orbital-mechanics','ephemeris-integrator','stellar-navigation','generic-one','generic-two','generic-three'].map(name=>({name,file:`/s/${name}/SKILL.md`,description:'Applicable workflow'}));
  assert.equal(rankSkills(buildSkillIndex(skills),'orbital mechanics')[0]?.skill.name,'orbital-mechanics');
  const f=fixture(skills.map(s=>s.name));f.start('Review orbital mechanics and ephemeris integrator with stellar navigation');
  const offers=[];
  for(let i=0;i<3;i++){const hints=f.g.candidates();offers.push(...hints.filter(h=>h.skill));f.g.commit(hints);}
  assert.equal(new Set(offers.map(h=>h.skill)).size,1,'one optional invitation per request');
  f.start('Write TypeScript');
  assert.ok(!f.g.candidates().some(h=>h.skill),'a new domain does not resurrect old lexical matches');
  f.start('Do not inspect orbital mechanics. Review ephemeris integrator');
  assert.ok(!f.g.candidates().some(h=>h.skill?.includes('orbital-mechanics')));
});

test('failed and partial skill reads preserve honest status without restricting execution',async()=>{
  const f=fixture();f.start('Implement Python and TypeScript');
  const status=async name=>(await f.decide({action:'inspect'})).details.skills.find(skill=>skill.name===name)?.status;
  const name='python-software-engineering';
  f.g.commit(f.g.candidates());
  for(const extra of [{isError:true},{input:{path:`/fixture/skills/${name}/SKILL.md`,limit:5}},{details:{truncation:{truncated:true}}}]) {
    f.read(name,extra);assert.equal(await status(name),'unread');assert.equal(f.edit('main.py'),undefined);
  }
  f.read(name);assert.equal(await status(name),'read');
  assert.equal(await status('typescript-contract-engineering'),'unread');
  assert.equal(f.edit('main.ts'),undefined);
});

test('optional deferrals preserve their own status and expire on new input',async()=>{
  const f=fixture();f.edit('main.py');f.edit('main.ts');
  assert.equal((await f.decide({action:'defer',skill:'unknown',reason:'Not relevant to this change'})).isError,true);
  await f.decide({action:'defer',skill:'python-software-engineering',reason:'Only updating a generated fixture for the parser test'});
  let page=(await f.decide({action:'inspect'})).details.skills;
  assert.equal(page.find(s=>s.name==='python-software-engineering').status,'deferred');
  assert.equal(page.find(s=>s.name==='typescript-contract-engineering').status,'unread');
  assert.ok(!f.entries.some(e=>e.data.read?.includes('/fixture/skills/python-software-engineering/SKILL.md')));
  f.entries.push({type:'compaction'});f.g.restore(f.ctx);
  assert.equal((await f.decide({action:'inspect'})).details.skills.find(s=>s.name==='python-software-engineering').status,'deferred');
  f.start();f.edit('main.py');
  assert.equal((await f.decide({action:'inspect'})).details.skills.find(s=>s.name==='python-software-engineering').status,'unread');
});

test('skill modes never block relevant execution, including old required settings',async()=>{
  for(const mode of ['required','advisory','off']) {
    process.env.PI_SKILL_REVIEW=mode;
    const f=fixture(['python-software-engineering','design-slop-prevention','scientific-paper-research']);
    f.start('Build a Python website and research scientific papers');
    for(const event of [
      {toolName:'edit',input:{path:'main.py'}}, {toolName:'write',input:{path:'index.html',content:'<main>Hello</main>'}},
      {toolName:'bulk_edit',input:{action:'apply',files:['a.py']}}, {toolName:'bash',input:{command:'python main.py'}},
      {toolName:'web_search',input:{query:'papers'}}, {toolName:'browser_session',input:{action:'open'}},
      {toolName:'subagent',input:{task:'Inspect Python'}},
    ]) assert.equal(f.g.beforeToolCall(event),undefined,`${mode}: ${event.toolName}`);
    const status=await f.decide({action:'inspect'});
    assert.equal(status.details.enabled,false);assert.equal(status.details.mode,mode==='off'?'off':'advisory');
    assert.ok(!f.context().some(message=>message.customType==='skill-review-context'));
    if(mode!=='off')assert.ok(status.details.skills.length>0,'advice remains available');
  }
});

test('file-discovered references survive compaction without creating read obligations',async()=>{
  const f=fixture(['python-software-engineering','typescript-contract-engineering','php-application-engineering','rust-systems-engineering','java-platform-engineering']);
  for(const file of ['x.py','x.ts','x.php','x.rs','x.java']) assert.equal(f.edit(file),undefined);
  assert.equal((await f.decide({action:'inspect',limit:8})).details.skills.length,5);
  f.read('python-software-engineering');f.entries.push({type:'compaction'});f.g.restore(f.ctx);
  assert.equal((await f.decide({action:'inspect',limit:8})).details.skills.find(s=>s.name==='python-software-engineering').status,'unread','discarded source text is not presented as retained');
  assert.equal(f.context().length,0);assert.equal(f.edit('x.py'),undefined);
});

test('old required-read context is retired while current task messages survive',()=>{
  const f=fixture();f.start('Implement Python');
  const user={role:'user',content:'Implement Python'};
  const obsolete={role:'custom',customType:'skill-review-context',content:'Read required: old guide'};
  assert.deepEqual(f.context([user,obsolete]),[user]);
});

test('default skill guidance is advisory: ordinary execution stays open and no required checklist is projected',async()=>{
  const inherited=process.env.PI_SKILL_REVIEW;
  delete process.env.PI_SKILL_REVIEW;
  try {
    const f=fixture();f.start('Implement Python');
    const workflow=f.g.candidates().find(h=>h.discovery==='workflow');
    assert.ok(workflow?.skill && workflow.text.includes(workflow.skill),'one relevant workflow is directly accessible without a catalog search');
    assert.match(workflow.text,/optional|if useful/i,'a concrete match remains an invitation');
    assert.equal(f.edit('main.py'),undefined);
    assert.equal(f.g.beforeToolCall({toolName:'bash',input:{command:'python main.py'}}),undefined);
    assert.equal(f.context().length,0,'advisory mode does not add a persistent required checklist');
    const status=await f.decide({action:'inspect'});
    assert.equal(status.details.enabled,false,'skill enforcement stays disabled');
    assert.equal(status.details.available,true,'skill_review inspect remains available');
    assert.ok(status.details.skills.some(s=>s.status==='unread'));
    f.g.commit(f.g.candidates());
    for(let i=0;i<30;i++)f.g.record({toolName:'read',input:{path:`src/file${i}.py`},isError:false,content:[{type:'text',text:'pass'}]});
    assert.ok(!f.g.candidates().some(h=>h.discovery),'same request does not repeatedly invite discovery');
    f.g.restore(f.ctx);f.start('Implement Python');
    assert.ok(!f.g.candidates().some(h=>h.discovery),'resume preserves the invitation cooldown');
    f.start('Implement Python');f.start('Implement Python');
    assert.ok(f.g.candidates().some(h=>h.discovery),'relevant invitations become eligible after three requests');
    f.g.record({toolName:'skill_review',input:{action:'browse'},isError:false});
    assert.ok(!f.g.candidates().some(h=>h.discovery==='workflow'),'successful discovery suppresses more invitations');
  } finally {
    if(inherited===undefined) delete process.env.PI_SKILL_REVIEW;
    else process.env.PI_SKILL_REVIEW=inherited;
  }
});

test('skill_review search finds a non-task catalogue match without exposing the catalogue',async()=>{
  const inherited=process.env.PI_SKILL_REVIEW;
  delete process.env.PI_SKILL_REVIEW;
  try {
    const f=fixture(['database-migration','python-software-engineering','typescript-contract-engineering']);
    f.start('Explain the current issue');
    const before=await f.decide({action:'inspect'});
    assert.deepEqual(before.details.skills,[],'a search is usable before any deterministic review target exists');
    const found=await f.decide({action:'search',query:'database migration',limit:3});
    assert.equal(found.isError,undefined);
    assert.equal(found.details.results[0].name,'database-migration');
    assert.equal(found.details.results[0].path,'/fixture/skills/database-migration/SKILL.md');
    assert.deepEqual(Object.keys(found.details.results[0]).sort(),['description','name','path']);
    assert.ok(found.details.results.every(result=>result.description.length<=240));
    assert.doesNotMatch(found.content[0].text,/python-software-engineering|typescript-contract-engineering/);
    assert.equal(f.edit('main.py'),undefined,'advisory search does not create a review obligation');
    const unknown=await f.decide({action:'search',query:'unicorn quantum toaster'});
    assert.deepEqual(unknown.details.results,[]);
  } finally {
    if(inherited===undefined) delete process.env.PI_SKILL_REVIEW;
    else process.env.PI_SKILL_REVIEW=inherited;
  }
});

test('child catalogs offer real references without enforcing them',async()=>{
  const f=fixture(['python-software-engineering']);
  f.g.start({prompt:'Implement Python. Build a Blender 3D animation and an Excel workbook with a presentation.',systemPrompt:'<available_skills></available_skills>'+f.catalog},f.ctx);
  const page=await f.decide({action:'inspect'});
  assert.ok(page.details.skills.some(s=>s.name==='python-software-engineering'));
  assert.equal(f.g.beforeToolCall({toolName:'bash',input:{command:'python main.py'}}),undefined);
  assert.equal(f.context().length,0);
});

test('repeatedly ignored catalog offers yield the scarce slot instead of re-filling it forever',()=>{
  const names=['orbital-mechanics','asteroseismology','generic-noise-one','generic-noise-two','generic-noise-three'];
  const descriptions={
    'orbital-mechanics':'Orbital ephemeris nbody integrator residuals propagation',
    'asteroseismology':'Stellar oscillation asteroseismic overtones and orbital ephemeris overlays',
  };
  const catalog='<available_skills>'+names.map(name=>`<skill><name>${name}</name><description>${descriptions[name]??'Applicable workflow'}</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join('')+'</available_skills>';
  const active=['read','edit','write','skill_review'];
  const entries=[];
  const g=createRelevantGuidance({on(){},getActiveTools:()=>active,registerTool(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  const ctx={cwd:'/fixture/fatigue',sessionManager:{getBranch:()=>entries}};
  g.restore(ctx);
  let request=0;
  const advance=()=>{
    if(request++)g.userInput();
    g.start({prompt:'Continue orbital ephemeris nbody integrator asteroseismic overtones',systemPrompt:catalog},ctx);
    const hints=g.candidates();
    const delivered=hints.find(h=>h.skill);
    g.commit(delivered?[delivered]:[]);
    return hints;
  };
  const first=advance();
  const firstDelivered=first.find(h=>h.skill);
  assert.equal(firstDelivered?.skill,'/fixture/skills/orbital-mechanics/SKILL.md');
  assert.equal(firstDelivered?.priority,55,'a fresh offer keeps its full advisory priority');
  let last=first;
  for(let i=0;i<5;i++)last=advance();
  const demoted=last.find(h=>h.skill==='/fixture/skills/orbital-mechanics/SKILL.md');
  assert.ok(demoted,'fatigue never retires the workflow from the catalogue');
  assert.equal(demoted.priority,15,'an ignored advisory workflow yields one bounded priority step');
  const state=entries.filter(e=>e.data?.version===1).at(-1)?.data;
  const tracked=(state?.offers??[]).find(([key])=>key==='skillctx:/fixture/skills/orbital-mechanics/SKILL.md');
  assert.ok(tracked?.[1]?.n>=2,'the persisted offer count is what drives the demotion');
});

test('context skill offers must share a term with the request and stop after two unread offers',()=>{
  const names=['html-slideshow','orbital-mechanics','asteroseismology','ephemeris-tables'];
  const descriptions={
    'html-slideshow':'Browser html slide decks with javascript transitions',
    'orbital-mechanics':'Orbital ephemeris nbody integrator residuals propagation',
    'asteroseismology':'Stellar oscillation asteroseismic overtones',
    'ephemeris-tables':'Ephemeris table interpolation residuals',
  };
  const catalog='<available_skills>'+names.map(name=>`<skill><name>${name}</name><description>${descriptions[name]}</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join('')+'</available_skills>';
  const entries=[];
  const g=createRelevantGuidance({on(){},getActiveTools:()=>['read','edit','write','skill_review'],registerTool(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  const ctx={cwd:'/fixture/grounding',sessionManager:{getBranch:()=>entries}};
  g.restore(ctx);
  g.start({prompt:'Fix the orbital ephemeris nbody integrator residuals and asteroseismic overtones',systemPrompt:catalog},ctx);
  // File vocabulary alone must not ground an offer.
  g.record({toolName:'read',input:{path:'viewer.html'}});
  const offered=g.candidates().filter(h=>h.key?.startsWith('skillctx:')).map(h=>h.skill);
  assert.ok(!offered.includes('/fixture/skills/html-slideshow/SKILL.md'),'browser/html file terms are not the request');
  g.commit(g.candidates().filter(h=>h.key?.startsWith('skillctx:')));
  const before=entries.length;
  g.commit([]);
  assert.equal(entries.length,before,'identical guidance state is not re-persisted');
});

test('changed config files suggest a single batched source checker using fresh paths',()=>{
  const f=fixture([]);
  for(const file of ['first.toml','second.yaml']) f.g.record({toolName:'write',input:{path:file,content:'key = 1'}});
  const hint=f.g.candidates().find(h=>h.tool==='syntax_check');
  assert.ok(hint);assert.match(hint.text,/second.yaml/);assert.doesNotMatch(hint.text,/first.toml/);
  f.g.record({toolName:'syntax_check',input:{paths:['second.yaml']}});
  assert.ok(!f.g.candidates().some(h=>h.tool==='syntax_check'));
});

test('overlapping edit batches emit the same targeted recovery cue as stale edits',()=>{
  const f=fixture();
  f.start('Implement Python');
  f.g.record({toolName:'edit',input:{path:'main.py'},isError:true,content:[{type:'text',text:'edits[0] and edits[1] overlap in main.py. Merge them into one edit or target disjoint regions.'}]});
  const hint=f.g.candidates().find(h=>h.key==='signal:edit-recovery');
  assert.ok(hint,'overlap failures need a recovery cue');
  assert.match(hint.text,/Read the current target region/);
});

test('bounded skill reads report the bytes actually returned after compaction', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skill-full-read-'));
  const name='php-application-engineering', file=path.join(dir,name,'SKILL.md');
  const body='---\nname: php-application-engineering\n---\n\n# PHP\nVerify syntax and runtime.\n';
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,body);
  try {
    const f=fixture([name],dir);f.start('Implement PHP');
    f.read(name);f.entries.push({type:'compaction'});f.g.restore(f.ctx);
    assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'unread');
    f.read(name,{input:{path:file,limit:40},content:[{type:'text',text:body.slice(0,20)}]});
    assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'unread','partial bytes cannot establish a full read');
    f.read(name,{input:{path:file,offset:1,limit:40},content:[{type:'text',text:body}]});
    assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'read','reading beyond EOF returned all source text');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('successful Bash skill views consume verified text and suppress repeated workflow hints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-shell-read-'));
  const name = 'python-software-engineering', file = path.join(dir, name, 'SKILL.md');
  const lines = ['# Python workflow', 'Inspect the current parser inputs.', 'Fix the smallest confirmed defect.', 'Run the focused behavior checks.', 'Report the measured result.'];
  const body = lines.join('\n') + '\n';
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, body);
  try {
    for (const [command, output] of [[`cat '${file}'`, body], [`sed -n '2,4p' '${file}'`, lines.slice(1, 4).join('\n') + '\n']]) {
      const f = fixture([name], dir); f.start('Implement Python');
      assert.equal(f.g.beforeToolCall({ toolName: 'bash', input: { command } }), undefined, 'a known workflow read must not be blocked by its own required review');
      const record = (text, exitCode = 0) => f.g.record({ toolName: 'bash', input: { command }, details: { execution: { exitCode } }, content: [{ type: 'text', text }] });
      record(`Read ${file}`);
      assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'unread','mentioning a path cannot establish consumption');
      record(output, 1);
      assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'unread','a failed shell command is not a read receipt');
      record(output + '\n[bash-router] Use a bounded read when useful.');
      assert.equal(f.edit('parser.py'), undefined);
      assert.equal((await f.decide({ action: 'inspect' })).details.skills.find(skill => skill.name === name).status, 'read');
      const receipts = f.entries.length;
      record(output);
      assert.equal(f.entries.length, receipts, 're-reading cannot duplicate the consumption snapshot');
      for (let index = 0; index < 4; index++) {
        f.start('Continue to implement the Python parser');
        assert.ok(!f.g.candidates().some(hint => hint.skill === file));
      }
    }
    for (const command of [`echo '${file}'`, `cat '${file}' > /dev/null`, `cat '${dir}/$WORKFLOW/SKILL.md'`, `cd '${dir}' && cat '${name}/SKILL.md'`]) {
      const f = fixture([name], dir); f.start('Implement Python');
      f.g.record({ toolName: 'bash', input: { command }, details: { execution: { exitCode: 0 } }, content: [{ type: 'text', text: body }] });
      assert.equal((await f.decide({action:'inspect'})).details.skills[0].status,'unread','ambiguous commands cannot establish which guide was viewed');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unchanged skill guidance keeps its position across tool continuations', () => {
  const f=fixture();f.start('Implement Python');
  const user={role:'user',content:'Implement Python'};
  const first=f.context([user]);
  const continuation={role:'assistant',content:[{type:'text',text:'Inspecting'}]};
  const next=f.context([user,continuation]);
  assert.deepEqual(next.slice(0,first.length),first,'stable request prefix preserves cache reuse');
  assert.equal(next.at(-1),continuation);
});
