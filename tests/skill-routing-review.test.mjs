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

// Gate tests opt into strict review explicitly. The runtime default is
// advisory so an applicable hint does not require a read/defer round-trip.
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

test('catalog names match ordinary prose and several relevant workflows can be offered',()=>{
  const skills=['orbital-mechanics','ephemeris-integrator','stellar-navigation','generic-one','generic-two','generic-three'].map(name=>({name,file:`/s/${name}/SKILL.md`,description:'Applicable workflow'}));
  assert.equal(rankSkills(buildSkillIndex(skills),'orbital mechanics')[0]?.skill.name,'orbital-mechanics');
  const f=fixture(skills.map(s=>s.name));f.start('Review orbital mechanics and ephemeris integrator with stellar navigation');
  const offers=[];
  for(let i=0;i<3;i++){const hints=f.g.candidates();offers.push(...hints.filter(h=>h.skill));f.g.commit(hints);}
  assert.equal(new Set(offers.map(h=>h.skill)).size,3);
  f.start('Write TypeScript');
  assert.ok(!f.g.candidates().some(h=>h.skill),'a new domain does not resurrect old lexical matches');
  f.start('Do not inspect orbital mechanics. Review ephemeris integrator');
  assert.ok(!f.g.candidates().some(h=>h.skill?.includes('orbital-mechanics')));
});

test('ignored offers, failures and partial reads cannot satisfy an exact pre-edit review',async()=>{
  const f=fixture();f.start('Implement Python and TypeScript');
  f.g.commit(f.g.candidates());
  f.g.record({toolName:'read',input:{path:'main.py'}});
  assert.equal(f.edit('main.py')?.block,true);
  assert.equal(f.edit('main.py')?.block,true,'retry cannot silently bypass');
  const name='python-software-engineering';
  f.read(name,{isError:true});assert.equal(f.edit('main.py')?.block,true);
  f.read(name,{input:{path:`/fixture/skills/${name}/SKILL.md`,limit:5}});assert.equal(f.edit('main.py')?.block,true);
  f.read(name,{details:{truncation:{truncated:true}}});assert.equal(f.edit('main.py')?.block,true);
  f.read(name);assert.equal(f.edit('main.py'),undefined);
  assert.equal(f.edit('other.py'),undefined,'one real read covers other files in the language');
  assert.equal(f.edit('main.ts')?.block,true,'a new language receives its own applicable workflow');
  assert.ok((await f.decide({action:'inspect'})).details.skills.some(s=>s.status==='read'));
});

test('scoped deferrals unblock only the named workflow and expire on new input',async()=>{
  const f=fixture();f.edit('main.py');f.edit('main.ts');
  assert.equal((await f.decide({action:'defer',skill:'unknown',reason:'Not relevant to this change'})).isError,true);
  assert.equal((await f.decide({action:'defer',skill:'python-software-engineering',reason:'skip'})).isError,true);
  await f.decide({action:'defer',skill:'python-software-engineering',reason:'Only updating a generated fixture for the parser test'});
  assert.equal(f.edit('main.py'),undefined);assert.equal(f.edit('main.ts')?.block,true);
  assert.ok(!f.entries.some(e=>e.data.read?.includes('/fixture/skills/python-software-engineering/SKILL.md')));
  f.entries.push({type:'compaction'});f.g.restore(f.ctx);assert.equal(f.edit('main.py'),undefined,'task-specific deferral survives compaction');
  f.start();assert.equal(f.edit('main.py')?.block,true);
});

test('read-only work, disabled skills, unavailable tools and unrelated files stay unblocked',()=>{
  const f=fixture();
  assert.equal(f.g.beforeToolCall({toolName:'read',input:{path:'main.py'}}),undefined);
  for(const file of ['README.md','vendor/main.py','generated/main.ts','node_modules/main.py','SKILL.md']) assert.equal(f.edit(file),undefined,file);
  f.start('Fix this without skills');assert.equal(f.edit('main.py'),undefined);
  f.start('Fix this without tools');assert.equal(f.edit('main.py'),undefined);
  f.start();f.active.splice(f.active.indexOf('skill_review'),1);assert.equal(f.edit('main.py'),undefined);
  assert.equal(fixture([]).edit('main.py'),undefined);
});

test('new file workflows remain checked after four skills and compaction invalidates reads',()=>{
  const f=fixture(['python-software-engineering','typescript-contract-engineering','php-application-engineering','rust-systems-engineering','java-platform-engineering']);
  for(const file of ['x.py','x.ts','x.php','x.rs']) assert.equal(f.edit(file)?.block,true);
  assert.equal(f.edit('x.java')?.block,true,'there is no lifetime four-skill bypass');
  f.read('python-software-engineering');f.entries.push({type:'compaction'});f.g.restore(f.ctx);f.start();
  assert.equal(f.edit('x.py')?.block,true);
});

test('task skills survive ignored hints and continue until actually read or deferred',async()=>{
  const f=fixture();f.start('Implement Python');
  f.g.commit(f.g.candidates());
  for(let i=0;i<30;i++)f.g.record({toolName:'read',input:{path:'notes.md'}});
  let messages=f.context();
  assert.equal(messages.length,1);assert.match(messages[0].content,/Read required.*python-software-engineering/);
  assert.equal(f.context(messages).length,1,'ephemeral context replaces itself');
  assert.equal(f.g.beforeToolCall({toolName:'bash',input:{command:'python main.py'}})?.block,true);
  assert.equal(f.g.beforeToolCall({toolName:'read',input:{path:'main.py'}}),undefined);
  f.start('Continue');assert.match(f.context()[0].content,/python-software-engineering/);
  f.read('python-software-engineering');
  assert.equal(f.g.beforeToolCall({toolName:'bash',input:{command:'python main.py'}}),undefined);
  assert.match(f.context()[0].content,/Apply \(read\)/);
  assert.ok(f.entries.every(entry=>entry.customType!=='skill-review-context'));
  f.start('Implement TypeScript');
  assert.doesNotMatch(f.context()[0].content,/python-software-engineering/,'new task replaces old task obligations');
  await f.decide({action:'defer',skill:'typescript-contract-engineering',reason:'The assigned task is only a generated fixture inspection'});
  assert.equal(f.context().length,0);
});

test('bulk edits and research are covered, while unavailable tools and user opt-outs remain respected',async()=>{
  const f=fixture();
  const preview={toolName:'bulk_edit',input:{action:'preview',files:['a.py','b.ts']}};
  assert.equal(f.g.beforeToolCall(preview),undefined);
  f.g.record({...preview,content:[{type:'text',text:JSON.stringify({action:'preview',token:'fixture-plan',files:[{path:'a.py'},{path:'b.ts'}]})}]});
  assert.equal(f.g.beforeToolCall({toolName:'bulk_edit',input:{action:'apply',token:'fixture-plan'}})?.block,true);
  f.read('python-software-engineering');f.read('typescript-contract-engineering');
  assert.equal(f.g.beforeToolCall({toolName:'bulk_edit',input:{action:'apply',token:'fixture-plan'}}),undefined);
  const research=fixture(['scientific-paper-research']);research.start('Research scientific papers');
  assert.equal(research.g.beforeToolCall({toolName:'web_search',input:{query:'papers'}})?.block,true);
  research.start('Research scientific papers without skills');assert.equal(research.context().length,0);
  assert.equal(research.g.beforeToolCall({toolName:'web_search',input:{query:'papers'}}),undefined);
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
    assert.equal(status.details.enabled,false,'strict enforcement is opt-in');
    assert.equal(status.details.available,true,'skill_review inspect remains available');
    assert.ok(status.details.skills.some(s=>s.status==='needs_review'));
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

test('compaction keeps the workflow obligation but requires reading its source again',()=>{
  const f=fixture();f.start('Implement Python');f.read('python-software-engineering');
  f.entries.push({type:'compaction'});f.g.restore(f.ctx);
  assert.match(f.context()[0].content,/Read required.*python-software-engineering/);
  f.read('python-software-engineering');assert.match(f.context()[0].content,/Apply \(read\)/);
});

test('file-discovered workflows survive compaction in a child without reminder delivery',()=>{
  const f=fixture();f.g.record({toolName:'read',input:{path:'source.py'}});
  f.entries.push({type:'compaction'});f.g.restore(f.ctx);
  assert.match(f.context()[0].content,/Read required.*python-software-engineering/);
  assert.equal(f.edit('source.py')?.block,true);
});

test('available child catalogs participate even after another catalog and missing routes do not consume slots',()=>{
  const f=fixture(['python-software-engineering']);
  f.g.start({prompt:'Implement Python. Build a Blender 3D animation and an Excel workbook with a presentation.',systemPrompt:'<available_skills></available_skills>'+f.catalog},f.ctx);
  assert.match(f.context()[0].content,/Read required.*python-software-engineering/);
  assert.equal(f.g.beforeToolCall({toolName:'bash',input:{command:'python main.py'}})?.block,true);
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

test('changed config files suggest a single batched source checker using fresh paths',()=>{
  const f=fixture([]);
  for(const file of ['first.toml','second.yaml']) f.g.record({toolName:'write',input:{path:file,content:'key = 1'}});
  const hint=f.g.candidates().find(h=>h.tool==='syntax_check');
  assert.ok(hint);assert.match(hint.text,/second.yaml/);assert.doesNotMatch(hint.text,/first.toml/);
  f.g.record({toolName:'syntax_check',input:{paths:['second.yaml']}});
  assert.ok(!f.g.candidates().some(h=>h.tool==='syntax_check'));
});

test('a bounded read that returns the entire skill satisfies review after compaction', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skill-full-read-'));
  const name='php-application-engineering', file=path.join(dir,name,'SKILL.md');
  const body='---\nname: php-application-engineering\n---\n\n# PHP\nVerify syntax and runtime.\n';
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,body);
  try {
    const f=fixture([name],dir);f.start('Implement PHP');
    f.read(name);f.entries.push({type:'compaction'});f.g.restore(f.ctx);
    assert.equal(f.edit('index.php')?.block,true);
    f.read(name,{input:{path:file,limit:40},content:[{type:'text',text:body.slice(0,20)}]});
    assert.equal(f.edit('index.php')?.block,true,'partial content cannot satisfy the workflow');
    f.read(name,{input:{path:file,offset:1,limit:40},content:[{type:'text',text:body}]});
    assert.equal(f.edit('index.php'),undefined,'reading beyond EOF returned all instructions');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
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
