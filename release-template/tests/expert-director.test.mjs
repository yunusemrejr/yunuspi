import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
// Calibration: the prompt corpus measures inference false positives and
// negatives across all 16 domains; the SVG/prose fixtures measure whether
// the deterministic check engines behind the lenses discriminate good from
// mediocre artifacts. Model-tier lens judgment needs a model and is
// verified by live session inspection, not asserted here.
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..'),path.resolve(root,'../..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/svg-check.ts')));
const load=p=>import(pathToFileURL(path.join(agent,'extensions/lib',p)));
const loadExt=p=>import(pathToFileURL(path.join(agent,'extensions',p)));
const {detectExpertDomains,detectTaskType,detectOpenEnded,representativeFamilies,EXPERT_DOMAIN_IDS}=await load('expert-domains.ts');
const {EXPERT_PACKS,selectDoctrineBrief,getDoctrinePack}=await load('expert-doctrine.ts');
const {LENS_CATALOG,buildCriticPlan,criticPlanSummary,isSubstantiveFinding}=await load('expert-critics.ts');
const {evaluateExpertConvergence,emptyExpertPassLedger,foldExpertPass,expertReviewerRows}=await load('expert-convergence.ts');
const {emptyTasteStore,foldTastePreference,recallTaste,renderTasteContext,forgetTastePreference,readTasteStore,writeTasteStore}=await load('expert-taste.ts');
const {buildExpertBrief,qualifiesForExpertBrief,expertEnabled,expertTasteWritable}=await load('expert-brief.ts');
const {inspectSvg}=await load('svg-check.ts');
const {proseReport}=await load('code-quality.ts');
const {numericCheck}=await load('numeric-checks.ts');
const corpus=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/expert-prompts.json'),'utf8'));
const fixture=name=>fs.readFileSync(path.join(root,'tests/fixtures',name),'utf8');
const verdictInput=over=>({openRequirements:[],invariantViolations:[],failingChecks:[],openBlocking:0,openImprovements:0,openPolish:0,fixedBlocking:0,fixedImprovements:0,newSubstantive:0,pass:1,maxPasses:3,evidenceCurrent:true,unavailable:[],...over});

test('domain inference calibrates across the prompt corpus without false positives/negatives',()=>{
  let checked=0;
  for(const item of corpus.cases){
    const result=detectExpertDomains({prompt:item.prompt});
    const top=result.domains.map(d=>d.domain);
    assert.deepEqual(top.slice(0,item.expect.length),item.expect,JSON.stringify(item.prompt));
    if(!item.expect.length)assert.equal(result.domains.length,0,'negative: '+item.prompt);
    if(item.taskType)assert.equal(result.taskType,item.taskType,item.prompt);
    if(item.openEnded!==undefined)assert.equal(result.openEnded,item.openEnded,item.prompt);
    for(const signal of result.domains){
      assert.ok(signal.confidence>0&&signal.confidence<=1);
      assert.ok(signal.signals.length>0);
    }
    checked++;
  }
  assert.ok(checked>=18,'corpus covers all 16 domains plus negatives');
});

test('task-type precedence and open-ended reading stay conservative',()=>{
  assert.equal(detectTaskType('Fix the crash when the queue worker retries'),'fix');
  assert.equal(detectTaskType('Review this migration for data loss'),'review');
  assert.equal(detectTaskType('Research prior work on reranking'),'research');
  assert.equal(detectTaskType('Deploy the release to production'),'operate');
  assert.equal(detectTaskType('Build a status dashboard'),'create');
  assert.equal(detectTaskType('What time is it?'),'transform');
  assert.equal(detectOpenEnded('Make it stunning'),true);
  assert.equal(detectOpenEnded('Fix the typo on line 3'),false);
  assert.equal(detectOpenEnded('Redesign the hero following our brand guide'),false);
});

test('file evidence corroborates weak lexical signals without inventing domains',()=>{
  const weak=detectExpertDomains({prompt:'Improve the icon'});
  const strong=detectExpertDomains({prompt:'Improve the icon',files:['assets/icons/save.svg']});
  assert.ok(strong.domains.some(d=>d.domain==='svg-iconography'));
  assert.ok((strong.domains.find(d=>d.domain==='svg-iconography')?.confidence??0)>=(weak.domains.find(d=>d.domain==='svg-iconography')?.confidence??0));
  assert.equal(detectExpertDomains({prompt:'What time is it?',files:['src/server.ts']}).domains.length,0);
});

test('brief qualification suppresses trivial work and vague one-liners',()=>{
  assert.equal(qualifiesForExpertBrief({domains:[{domain:'writing',confidence:.9}],taskType:'transform',openEnded:false},'Run prettier on changed files'),false);
  assert.equal(qualifiesForExpertBrief({domains:[],taskType:'transform',openEnded:false},'What time is it?'),false);
  assert.equal(qualifiesForExpertBrief({domains:[{domain:'web-design',confidence:.8}],taskType:'create',openEnded:true},'Design a stunning landing page'),true);
});

test('expert briefs stay bounded and carry exploration, preservation and critic lines',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'expert-brief-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const saved=process.env.PI_EXPERT_DIR;process.env.PI_EXPERT_DIR=dir;
  t.after(()=>{if(saved===undefined)delete process.env.PI_EXPERT_DIR;else process.env.PI_EXPERT_DIR=saved;});
  const open=buildExpertBrief({prompt:'Design a stunning landing page with a distinctive hero'});
  assert.equal(open.qualified,true);
  assert.ok(open.text.length<=2000&&open.text.length>200);
  assert.match(open.text,/Explore before committing/);
  assert.match(open.text,/Critics for this task/);
  assert.match(open.summary,/Expert brief:/);
  const refine=buildExpertBrief({prompt:'Refactor the dashboard components to colocate state and resolve the routing waterfall',force:true});
  assert.match(refine.text,/Preserve what must survive/);
  const quiet=buildExpertBrief({prompt:'What time is it?'});
  assert.equal(quiet.qualified,false);assert.equal(quiet.text,'');assert.equal(quiet.summary,'');
  process.env.PI_EXPERT='off';
  try{assert.equal(buildExpertBrief({prompt:'Design a stunning landing page',force:true}).qualified,false);}
  finally{delete process.env.PI_EXPERT;}
  assert.equal(expertEnabled(),true);
  assert.equal(expertTasteWritable(),process.env.PI_SUBAGENT_CHILD!=='1');
});

test('doctrine packs are complete, bounded and reference real lenses and tools',()=>{
  assert.deepEqual(Object.keys(EXPERT_PACKS).sort(),[...EXPERT_DOMAIN_IDS].sort());
  const knownTools=new Set(['artifact_check','math_check','code_quality','syntax_check','claim_check','source_check','design_audit','video_qa','video_frames','audio_analyze','media_info','render_see','browser_session','project_tests','project_intel','context_slice','symbol_expand','dependency_plan','openapi_probe','contract_diff','http_request','data_query','sqlite_probe','coverage_probe','coverage_select','web_asset_check','env_audit','net_probe','sandbox_run','web_search','web_research','source_check','fetch_content','quality_review','subagent','todo','research_toolkit','video_project','video_render','narration_tts','audio_mix','audio_synth','music_compose','media_edit','scene_create','scene_render','image_ocr','skill_review','tool_search','creative_direct','visual_review','ui_explore','motion_inspect','svg_inspect','asset_register','image_generate','creative_compare']);
  for(const [id,pack] of Object.entries(EXPERT_PACKS)){
    assert.equal(pack.id,id);
    for(const [key,max] of [['principles',6],['antiPatterns',6],['invariants',5],['dimensions',6],['checks',6],['skills',4],['tools',6],['lenses',6],['evidence',4],['convergeExtra',3]]){
      assert.ok(pack[key].length>0&&pack[key].length<=max,`${id}.${key}`);
      for(const bullet of pack[key])assert.ok(String(typeof bullet==='string'?bullet:bullet.what).length<=220,`${id}.${key} bounded`);
    }
    for(const lens of pack.lenses)assert.ok(LENS_CATALOG[lens],`${id} lens ${lens} exists`);
    for(const check of pack.checks)assert.ok(knownTools.has(check.tool),`${id} check tool ${check.tool} is registered`);
    assert.ok(pack.exploreWhen.length>10);
  }
  const brief=selectDoctrineBrief([{domain:'backend',confidence:.9},{domain:'api-design',confidence:.7},{domain:'ml',confidence:.5}]);
  assert.deepEqual(brief.packs,['backend','api-design']);
  assert.ok(brief.chars<=2400&&brief.chars>200);
  assert.equal(selectDoctrineBrief([]).text,'');
  assert.equal(getDoctrinePack('nope'),undefined);
});

test('critic plans order cheap lenses first, cap size and disclose drops',()=>{
  const plan=buildCriticPlan(['web-design','frontend']);
  assert.ok(plan.lenses.length<=6&&plan.lenses.length>0);
  const kinds=plan.lenses.map(l=>l.lens.kind);
  assert.deepEqual([...kinds].sort(),kinds,'deterministic before model');
  for(const entry of plan.lenses){
    assert.deepEqual(entry.evidencePacket,{maxFiles:6,maxChars:6000,maxFindings:8});
    assert.ok(entry.lens.checks.length<=4);
    assert.ok(entry.lens.brief.length<=400);
  }
  const wide=buildCriticPlan(['backend','api-design','database','security']);
  assert.ok(wide.lenses.length<=6);
  assert.ok(wide.dropped.length>0,'drops are reported, never silent');
  assert.match(criticPlanSummary(wide),/Critics:/);
  assert.equal(criticPlanSummary(buildCriticPlan([])),'');
  assert.equal(isSubstantiveFinding('blocking'),true);
  assert.equal(isSubstantiveFinding('improvement'),true);
  assert.equal(isSubstantiveFinding('polish'),false);
});

test('convergence verdicts require every clause and name the next action',()=>{
  assert.equal(evaluateExpertConvergence(verdictInput({openRequirements:['R1']})).reason,'requirements-open');
  assert.equal(evaluateExpertConvergence(verdictInput({invariantViolations:['brand tokens replaced']})).reason,'invariants-violated');
  assert.equal(evaluateExpertConvergence(verdictInput({failingChecks:['artifact_check svg: missing-reference']})).reason,'checks-failing');
  assert.equal(evaluateExpertConvergence(verdictInput({openBlocking:1})).reason,'blocking-open');
  assert.equal(evaluateExpertConvergence(verdictInput({evidenceCurrent:false})).reason,'evidence-stale');
  const open=evaluateExpertConvergence(verdictInput({openImprovements:2,fixedImprovements:1,pass:2}));
  assert.equal(open.reason,'improvements-open');assert.equal(open.converged,false);
  assert.ok(open.nextActions.length===1&&open.detail.includes('2/3'));
  assert.equal(evaluateExpertConvergence(verdictInput({openImprovements:1,pass:3})).reason,'pass-budget-spent');
  assert.equal(evaluateExpertConvergence(verdictInput({openImprovements:1,newSubstantive:2,pass:2})).reason,'regressing');
  const done=evaluateExpertConvergence(verdictInput({openPolish:4,fixedImprovements:2,pass:2}));
  assert.equal(done.converged,true);assert.equal(done.reason,'converged');
  assert.deepEqual(done.nextActions,[]);
  const unavailable=evaluateExpertConvergence(verdictInput({unavailable:['browser_session: no display']}));
  assert.equal(unavailable.converged,true);
  assert.match(unavailable.detail,/no display/,'skipped layers stay visible');
});

test('pass ledger folds bounded verdict history',()=>{
  let ledger=emptyExpertPassLedger(3);
  ledger=foldExpertPass(ledger,evaluateExpertConvergence(verdictInput({openImprovements:2,pass:1,fixedImprovements:1})),verdictInput({pass:1,fixedImprovements:1}));
  ledger=foldExpertPass(ledger,evaluateExpertConvergence(verdictInput({pass:2})),verdictInput({pass:2}));
  assert.deepEqual([ledger.pass,ledger.fixedImprovements,ledger.recentReasons], [2,1,['improvements-open','converged']]);
});

test('reviewer rows carry focus and verdicts without inventing evidence',()=>{
  assert.deepEqual(expertReviewerRows([]),[]);
  const branch=[
    {type:'custom',customType:'expert-director-v1',data:{action:'brief',domains:['ml'],taskType:'fix',openEnded:false,detail:{lenses:['leakage-check'],tasteApplied:1}}},
    {type:'custom',customType:'expert-director-v1',data:{action:'assess',converged:false,reason:'improvements-open',ledger:{pass:2,maxPasses:3,recentReasons:['checks-failing','improvements-open']}}},
  ];
  const rows=expertReviewerRows(branch);
  assert.equal(rows.length,2);
  assert.match(rows[0].text,/ml/);assert.match(rows[0].text,/leakage-check/);
  assert.match(rows[1].text,/pass 2\/3/);assert.match(rows[1].text,/perfectionism/);
  const done=expertReviewerRows([{type:'custom',customType:'expert-director-v1',data:{action:'assess',converged:true,ledger:{pass:1}}}]);
  assert.match(done[0].text,/converged/);
});

test('taste memory folds explicit direction fast and outcomes slowly',()=>{
  let store=emptyTasteStore();
  const explicit=foldTastePreference(store,{scope:'user',text:'Prefer restrained visual design with strong typography',provenance:'explicit'});
  assert.equal(explicit.preference.confidence,.9);
  store=explicit.store;
  const once=foldTastePreference(store,{scope:'user',text:'Use explicit state machines',provenance:'accepted'});
  assert.equal(once.preference.confidence,.3);
  const twice=foldTastePreference(once.store,{scope:'user',text:'Use explicit state machines',provenance:'accepted'});
  assert.ok(twice.preference.confidence>once.preference.confidence);
  const contradicted=foldTastePreference(twice.store,{scope:'user',text:'Use explicit state machines',provenance:'rejected'});
  assert.ok(contradicted.preference.confidence<twice.preference.confidence);
  assert.ok(contradicted.preference.contradictions>=1,'contradiction recorded, not deleted');
  const scoped=foldTastePreference(store,{scope:'project',project:'acme-web',domains:['web-design'],text:'Minimal cardification',provenance:'explicit'});
  const recalled=recallTaste(scoped.store,scoped.store,'acme-web',['web-design']);
  assert.equal(recalled[0].text,'Minimal cardification','project scope wins');
  const unfiltered=recallTaste(scoped.store,emptyTasteStore(),'',['no-such-domain']);
  assert.ok(!unfiltered.some(p=>p.text==='Minimal cardification'),'unrelated filter hides domain-scoped priors');
  assert.ok(unfiltered.some(p=>p.text==='Prefer restrained visual design with strong typography'),'global priors still apply');
  const listed=recallTaste(scoped.store,emptyTasteStore(),'',[]);
  assert.ok(listed.some(p=>p.text==='Minimal cardification'),'empty filter lists everything');
  assert.match(renderTasteContext(recalled),/priors/);
  assert.equal(renderTasteContext([]),'');
  const forgotten=forgetTastePreference(scoped.store,'Minimal cardification');
  assert.equal(forgotten.removed.text,'Minimal cardification');
  assert.equal(forgetTastePreference(forgotten.store,'no such pref').removed,undefined);
});

test('taste store persists atomically and degrades on corrupt files',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'expert-taste-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={...process.env,PI_EXPERT_DIR:dir};
  assert.deepEqual(readTasteStore('user','',env),emptyTasteStore());
  const {store}=foldTastePreference(emptyTasteStore(),{scope:'user',text:'Concise prose without filler',provenance:'explicit'});
  assert.equal(writeTasteStore('user','',store,env),true);
  const reread=readTasteStore('user','',env);
  assert.equal(reread.preferences.length,1);
  assert.equal(reread.preferences[0].text,'Concise prose without filler');
  assert.equal(fs.statSync(path.join(dir,'taste-user.json')).mode&0o777, 0o600);
  fs.writeFileSync(path.join(dir,'taste-user.json'),'not json{{{');
  assert.deepEqual(readTasteStore('user','',env),emptyTasteStore());
});

test('representative families group whole-project scope with bounds',()=>{
  const families=representativeFamilies(['pages/index.tsx','pages/about.tsx','components/Button.tsx','api/health.ts','migrations/001.sql','docs/guide.md','node_modules/x/index.js','README.md'],4);
  assert.ok(families.length<=4);
  assert.ok(families.some(f=>f.family==='pages/routes'));
  assert.ok(families.every(f=>f.sample.length<=3));
  assert.deepEqual(representativeFamilies([]),[]);
});

test('deterministic check engines discriminate good from mediocre artifacts',async()=>{
  const good=await inspectSvg(fixture('expert-svg-good.svg'));
  assert.equal(good.status,'inspected');assert.deepEqual(good.findings,[]);
  const bad=await inspectSvg(fixture('expert-svg-mediocre.svg'));
  assert.equal(bad.status,'issues');
  for(const key of ['duplicate-id','missing-reference','active-content','event-handler'])assert.ok(bad.findings.map(f=>f.key).includes(key),key);
  const goodProse=proseReport(fixture('expert-prose-good.md'));
  const badProse=proseReport(fixture('expert-prose-mediocre.md'));
  assert.equal(goodProse.phrases.length,0);
  assert.ok(badProse.phrases.length>=5,'mediocre prose trips stock-phrase detection');
  const frame=numericCheck({operation:'frame_budget',values:[8,9,33,8],target_fps:50});
  assert.equal(frame.overBudgetFrames,1);
  assert.equal(frame.budgetMs,20);
});

test('expert_director tool registers five actions with bounded outputs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'expert-tool-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const saved={PI_EXPERT_DIR:process.env.PI_EXPERT_DIR,PI_SUBAGENT_CHILD:process.env.PI_SUBAGENT_CHILD,PI_PROJECT_ID_GIT:process.env.PI_PROJECT_ID_GIT};
  Object.assign(process.env,{PI_EXPERT_DIR:dir,PI_PROJECT_ID_GIT:'off'});delete process.env.PI_SUBAGENT_CHILD;
  t.after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  const tools=new Map();const entries=[];
  const {default:register}=await loadExt('expert-director.ts');
  register({registerTool:tool=>tools.set(tool.name,tool),appendEntry:(type,data)=>entries.push({type,data})});
  assert.ok(tools.has('expert_director'));
  const call=(action,extra={})=>tools.get('expert_director').execute('brief',{action,...extra},undefined,undefined,{cwd:dir,sessionManager:{getSessionId:()=>'test-session'}});
  const brief=await call('brief',{prompt:'Design a logo mark with a geometric icon set'});
  assert.equal(brief.details.qualified,true);
  assert.ok(brief.details.domains.includes('svg-iconography')||brief.details.domains.includes('visual-art'));
  assert.ok(brief.content[0].text.length<=6000);
  const critics=await call('critics',{domains:['svg-iconography']});
  assert.ok(critics.details.lenses.length>0&&critics.details.lenses.length<=6);
  const assess=await call('assess',{pass:{openImprovements:1,pass:1}});
  assert.equal(assess.details.reason,'improvements-open');
  const recorded=await call('taste',{taste:{op:'record',text:'Prefer geometric icon grids',domains:['svg-iconography']}});
  assert.equal(recorded.details.recorded.confidence,.9);
  const listed=await call('taste',{taste:{op:'list',domains:['svg-iconography']}});
  assert.ok(listed.details.preferences.some(p=>p.text==='Prefer geometric icon grids'));
  const status=await call('status');
  assert.equal(status.details.packs.length,16);
  process.env.PI_SUBAGENT_CHILD='1';
  await assert.rejects(()=>call('taste',{taste:{op:'record',text:'Children must not write taste memory'}}),/main-session only/);
  delete process.env.PI_SUBAGENT_CHILD;
  await assert.rejects(()=>call('nope'),/Unknown expert_director action/);
  assert.ok(entries.some(e=>e.type==='expert-director-v1'),'session entries recorded');
});

test('expert assessments advance the retained task ledger and retain its configured budget',async()=>{
  const {default:register}=await loadExt('expert-director.ts');
  const entries=[]; let tool;
  register({registerTool:value=>{tool=value;},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  const ctx={cwd:root,sessionManager:{getSessionId:()=>'budget-session',getBranch:()=>entries}};
  const assess=(pass)=>tool.execute('assess',{action:'assess',pass},undefined,undefined,ctx);
  const first=await assess({openImprovements:2,maxPasses:2});
  assert.equal(first.details.ledger.pass,1);
  const second=await assess({openImprovements:1,fixedImprovements:1});
  assert.equal(second.details.reason,'pass-budget-spent');
  assert.equal(second.details.ledger.pass,2);
  assert.equal(second.details.ledger.maxPasses,2);
  entries.push({type:'message',message:{role:'user',content:'Begin the next task'}});
  const fresh=await assess({openImprovements:1});
  assert.equal(fresh.details.ledger.pass,1,'a new user task starts a new loop');
  assert.equal(fresh.details.ledger.maxPasses,3);
  const freshManager={...ctx,sessionManager:{getSessionId:()=>'budget-session',getBranch:()=>[]}};
  const isolated=await tool.execute('assess',{action:'assess',pass:{openImprovements:1}},undefined,undefined,freshManager);
  assert.equal(isolated.details.ledger.fixedImprovements,0,'another live manager never inherits same-id state');
});
