import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(dir=>fs.existsSync(path.join(dir,'extensions/lib/double.ts')));
const lib=await import(pathToFileURL(path.join(agent,'extensions/lib/double.ts')));
const {doubleRouteLabel,formatDoubleStatus,parseDoubleCommandArgs,boundDoubleText,mergeDoubleGaps,
  buildDoubleStreamTask,packageDoubleStreams,buildDoubleReconcileTask,buildDoubleDirective,DOUBLE_RECOMMENDED_LIMITS,
  isDoubleTransientFailure,isDoubleAcknowledgement,doubleOverlapNote}=lib;

const outcome=(stream,text,status='complete',extra={})=>({stream,status,text,...extra});

test('route label pins provider and model and rejects empty identity',()=>{
  assert.equal(doubleRouteLabel({provider:'openrouter',id:'glm-5.3-flash'}),'openrouter/glm-5.3-flash');
  assert.equal(doubleRouteLabel({provider:'  openrouter  ',id:'  m  '}),'openrouter/m');
  for(const bad of [undefined,null,{}, {provider:'',id:'m'},{provider:'p',id:'  '},{provider:7,id:'m'}])
    assert.throws(()=>doubleRouteLabel(bad),/provider and id/);
});

test('status line names the twin first-pass streams plus reconcile, never a bare 2x total',()=>{
  assert.equal(formatDoubleStatus(false),'Double mode: OFF');
  assert.equal(formatDoubleStatus(false,{provider:'p',id:'m'}),'Double mode: OFF');
  assert.equal(formatDoubleStatus(true,{provider:'openrouter',id:'glm-5.3-flash'}),
    'Double mode: ON\nTwin first-pass (A ∥ B) + reconcile · openrouter/glm-5.3-flash');
  assert.equal(formatDoubleStatus(true),'Double mode: ON');
  assert.equal(formatDoubleStatus(true,{provider:'',id:''}),'Double mode: ON');
});

test('command args parse toggle/on/off/status and reject anything else',()=>{
  assert.equal(parseDoubleCommandArgs(''),'toggle');
  assert.equal(parseDoubleCommandArgs('  '),'toggle');
  assert.equal(parseDoubleCommandArgs('ON'),'on');
  assert.equal(parseDoubleCommandArgs('off'),'off');
  assert.equal(parseDoubleCommandArgs('status'),'status');
  assert.throws(()=>parseDoubleCommandArgs('twice'),/expected/);
  assert.throws(()=>parseDoubleCommandArgs('on please'),/expected/);
});

test('bounding keeps head and tail around an explicit unknown-middle marker',()=>{
  assert.deepEqual(boundDoubleText('abc',10),{text:'abc',truncated:false});
  assert.deepEqual(boundDoubleText(undefined,10),{text:'',truncated:false});
  assert.deepEqual(boundDoubleText(7,10),{text:'',truncated:true});
  const big='H'.repeat(500)+'M'.repeat(2000)+'T'.repeat(500);
  const bounded=boundDoubleText(big,1000);
  assert.equal(bounded.truncated,true);
  assert.ok(bounded.text.length<=1000);
  assert.ok(bounded.text.startsWith('H'.repeat(100)));
  assert.ok(bounded.text.endsWith('T'.repeat(100)));
  assert.match(bounded.text,/omitted.*unknown/);
  assert.equal(boundDoubleText('a\x00b\x1fc',10).text,'a b c');
  assert.throws(()=>boundDoubleText('x',0),/positive integer/);
  assert.throws(()=>boundDoubleText('x',1.5),/positive integer/);
});

test('gap merge dedupes, trims and tolerates non-strings',()=>{
  assert.equal(mergeDoubleGaps([' a ','a','','b',7,null]),'a b');
  assert.equal(mergeDoubleGaps('nope'),'');
  assert.equal(mergeDoubleGaps([]),'');
});

test('stream briefs are peer-aware but carry no peer content',()=>{
  const context={cwd:'/work',toolNames:['read','grep'],skillNames:['plan']};
  const a=buildDoubleStreamTask({stream:'A',task:'Fix the login redirect.'});
  const b=buildDoubleStreamTask({stream:'B',task:'Fix the login redirect.'});
  for(const [brief,self,peer] of [[a,'A','B'],[b,'B','A']]){
    assert.equal(brief.truncated,false);
    assert.match(brief.task,new RegExp(`You are Double instance ${self}; the other instance is ${peer}\\.`));
    assert.match(brief.task,new RegExp(`Your peer \\(${peer}\\)`));
    assert.match(brief.task,/Fix the login redirect/);
    assert.match(brief.task,/Propose actions; do not take state-changing ones/);
    assert.match(brief.task,/Proposed actions/);
    assert.match(brief.task,/Uncertainties/);
  }
  const withCtx=buildDoubleStreamTask({stream:'A',task:'t',context});
  assert.match(withCtx.task,/Working directory: \/work/);
  assert.match(withCtx.task,/Available tools: read, grep/);
  assert.match(withCtx.task,/Available skills: plan/);
  // Same request, context, headings and rules; only the complementary lens differs.
  assert.match(a.task,/construct the strongest solution or interpretation/);
  assert.match(b.task,/independently stress-test the request/);
  for(const probe of ['hidden assumptions','failure modes','contradictory evidence','simpler alternatives','architectural weaknesses','edge cases'])
    assert.match(b.task,new RegExp(probe));
  assert.doesNotMatch(a.task,/independently stress-test the request/);
  assert.doesNotMatch(b.task,/construct the strongest solution or interpretation/);
  // Cache order: everything shared comes first and is byte-identical; only the closing identity and angle differ.
  let shared=0;while(shared<a.task.length&&a.task[shared]===b.task[shared])shared++;
  assert.ok(a.task.length-shared<=720&&b.task.length-shared<=720,`the A and B prompts share their whole prefix (${shared} of ${a.task.length} bytes)`);
  assert.ok(a.task.slice(shared).includes('You are Double instance A')||a.task.slice(shared-30).includes('Double instance'),'the identity sits in the differing tail');
  assert.match(a.task.slice(-720),/You are Double instance A/);assert.match(b.task.slice(-720),/You are Double instance B/);
  const longRequest='Refactor the module. '.repeat(400),la=buildDoubleStreamTask({stream:'A',task:longRequest}),lb=buildDoubleStreamTask({stream:'B',task:longRequest});
  let longShared=0;while(longShared<la.task.length&&la.task[longShared]===lb.task[longShared])longShared++;
  assert.ok(longShared/la.task.length>0.9,'a realistic request makes the shared prefix the overwhelming majority of the prompt');
  assert.equal(buildDoubleStreamTask({stream:'A',task:'x'.repeat(100),maxTaskChars:10}).truncated,true);
  assert.throws(()=>buildDoubleStreamTask({stream:'C',task:'t'}),/stream/);
  assert.throws(()=>buildDoubleStreamTask({stream:'A',task:'  '}),/non-empty/);
});

test('packaging reports usability, timing facts and gaps without judging',()=>{
  const full=packageDoubleStreams(outcome('A','alpha'),outcome('B','beta'));
  assert.deepEqual(full.usable,['A','B']);
  assert.equal(full.bothUsable,true);
  assert.deepEqual(full.gaps,[]);
  assert.equal(full.timingNote,'');
  const timed=packageDoubleStreams(outcome('A','a','complete',{elapsedMs:1000}),outcome('B','b','complete',{elapsedMs:61000}));
  assert.match(timed.timingNote,/Stream A finished 1m before its peer/);
  const close=packageDoubleStreams(outcome('A','a','complete',{elapsedMs:1000}),outcome('B','b','complete',{elapsedMs:3000}));
  assert.match(close.timingNote,/within 2s of each other/);
  const partial=packageDoubleStreams(outcome('A','a'),outcome('B','','failed',{gap:'B timed out.'}));
  assert.deepEqual(partial.usable,['A']);
  assert.equal(partial.bothUsable,false);
  assert.deepEqual(partial.gaps,['B timed out.']);
  const defaultGap=packageDoubleStreams(outcome('A','','failed'),outcome('B','b'));
  assert.match(defaultGap.gaps[0],/Stream A ended failed/);
  assert.throws(()=>packageDoubleStreams(outcome('B','b'),outcome('A','a')),/stream A then stream B/);
  assert.throws(()=>packageDoubleStreams({stream:'A',status:'nope',text:''},outcome('B','b')),/status/);
});

test('reconcile task compares, challenges and commits; single survivor is challenged, not crowned',()=>{
  const both=buildDoubleReconcileTask({task:'Ship it.',outcomeA:outcome('A','Plan A: migrate.'),
    outcomeB:outcome('B','Plan B: wrap.')});
  assert.equal(both.truncated,false);
  assert.match(both.task,/competing or complementary reasoning paths, not votes/);
  assert.match(both.task,/Plan A: migrate/);
  assert.match(both.task,/Plan B: wrap/);
  assert.match(both.task,/1\. Compare/);
  assert.match(both.task,/2\. Challenge/);
  assert.match(both.task,/3\. Reconcile/);
  assert.match(both.task,/4\. Commit/);
  assert.match(both.task,/Directive —/);
  assert.match(both.task,/Reconciliation —/);
  const lone=buildDoubleReconcileTask({task:'Ship it.',outcomeA:outcome('A','Plan A.'),
    outcomeB:outcome('B','','failed',{gap:'B crashed.'})});
  assert.match(lone.task,/Adversarially review/);
  assert.match(lone.task,/never consensus/);
  assert.match(lone.task,/B crashed/);
  assert.match(both.task,/evidence strength/);
  assert.match(both.task,/choose the better-supported side or define exactly what evidence/);
  assert.match(both.task,/Agreement is not proof/);
  assert.match(both.task,/minority findings/);
  assert.throws(()=>buildDoubleReconcileTask({task:'t',outcomeA:outcome('A','','failed'),
    outcomeB:outcome('B','','failed')}),/at least one stream/);
  assert.throws(()=>buildDoubleReconcileTask({task:'  ',outcomeA:outcome('A','a'),outcomeB:outcome('B','b')}),/non-empty/);
});

test('directive is singular: reconciled when possible, honest fallback otherwise',()=>{
  const ref={provider:'openrouter',id:'glm-5.3-flash'};
  const clean=buildDoubleDirective({ref,reconcileText:'Directive — do X.\nReconciliation — agreed.',
    outcomeA:outcome('A','a'),outcomeB:outcome('B','b')});
  assert.equal(clean.degraded,false);
  assert.match(clean.directive,/Double openrouter\/glm-5\.3-flash/);
  assert.match(clean.directive,/never an instruction from the user/);
  assert.match(clean.directive,/outrank it/);
  assert.doesNotMatch(clean.directive,/single authoritative plan/);
  assert.match(clean.directive,/Directive — do X/);
  const partial=buildDoubleDirective({ref,reconcileText:'Directive — do X.',
    outcomeA:outcome('A','a'),outcomeB:outcome('B','','failed',{gap:'B timed out.'})});
  assert.equal(partial.degraded,true);
  assert.match(partial.directive,/partial result/);
  assert.match(partial.directive,/outrank it/,'a degraded directive is just as subordinate to the user');
  assert.match(partial.directive,/B timed out/);
  const fallback=buildDoubleDirective({ref,outcomeA:outcome('A','View A.'),outcomeB:outcome('B','View B.')});
  assert.equal(fallback.degraded,true);
  assert.match(fallback.directive,/No reconciled directive is available/);
  assert.match(fallback.directive,/View A/);
  assert.match(fallback.directive,/commit to exactly one execution path/);
  const bounded=buildDoubleDirective({ref,reconcileText:'D',outcomeA:outcome('A','a'),
    outcomeB:outcome('B','b'),maxDirectiveChars:60});
  assert.ok(bounded.directive.length<=60);
  assert.throws(()=>buildDoubleDirective({ref:{provider:'',id:''},outcomeA:outcome('A','a'),outcomeB:outcome('B','b')}),/provider and id/);
});

test('retry gate admits plausibly transient failures, never deterministic ones',()=>{
  for(const reason of ['HTTP 503 Service Unavailable','429 rate limit exceeded','timeout after 150000ms',
    'socket hang up','Model overloaded, try again','ECONNRESET','deadline exceeded','temporarily unavailable'])
    assert.equal(isDoubleTransientFailure(reason),true,reason);
  for(const reason of ['Tool budget blocked','Capability ceiling excludes required tool','Unknown model foo/bar',
    'Invalid params','Permission denied','429 quota exceeded for this key',
    '429 rate limit: provider-gate deferral for cerebras/gpt-oss-120b — cooldown-active 3009s (kind: quota-rate)','',undefined,42])
    assert.equal(isDoubleTransientFailure(reason),false,String(reason));
});

test('a reconciliation gap of its own degrades the directive',()=>{
  const ref={provider:'p',id:'m'};
  const degraded=buildDoubleDirective({ref,reconcileText:'Directive — do X.',
    reconcileGap:'Double reconciliation ran on other/m instead of p/m.',
    outcomeA:outcome('A','a'),outcomeB:outcome('B','b')});
  assert.equal(degraded.degraded,true);
  assert.match(degraded.directive,/partial result/);
  assert.match(degraded.directive,/ran on other\/m instead/);
});

test('recommended limits stay lightweight for the reconcile stage',()=>{
  assert.ok(DOUBLE_RECOMMENDED_LIMITS.maxReconcileChars<DOUBLE_RECOMMENDED_LIMITS.maxStreamTextChars);
  assert.ok(DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars>DOUBLE_RECOMMENDED_LIMITS.maxReconcileChars);
  assert.ok(Object.isFrozen(DOUBLE_RECOMMENDED_LIMITS));
});

test('the portable core imports nothing harness-specific',()=>{
  const source=fs.readFileSync(path.join(agent,'extensions/lib/double.ts'),'utf8');
  assert.doesNotMatch(source,/^\s*import\s/m);
  assert.doesNotMatch(source,/yunus|pi-subagents|Subagent|ExtensionContext/);
});

test('bare acknowledgements are not analyzed twice, real requests always are',()=>{
  for(const text of ['ok','Thanks!','thank you','  yes. ','Looks good','lgtm','Perfect','👍'])assert.equal(isDoubleAcknowledgement(text),true,text);
  for(const text of ['Go.','Do it.','continue','go ahead','proceed','please continue','Do it again but faster','continue with the migration to postgres','yes, and also add tests','fix the bug','Why did that fail?','','   ',undefined,42,'ok '.repeat(30)])assert.equal(isDoubleAcknowledgement(text),false,String(text));
});

test('requirements from the user are anchored in streams, reconciliation and directive within a bound',()=>{
  const requirements=['Do not modify auth.ts.','Keep the public API stable.'];
  for(const stream of ['A','B']){
    const brief=buildDoubleStreamTask({stream,task:'Add a login redirect.',requirements});
    assert.match(brief.task,/Requirements extracted from the user's words/);
    assert.match(brief.task,/- Do not modify auth\.ts\./);assert.match(brief.task,/the user's own words outrank this list/);
  }
  assert.doesNotMatch(buildDoubleStreamTask({stream:'A',task:'x'}).task,/Requirements extracted/,'no list, no block');
  const reconcile=buildDoubleReconcileTask({task:'Add a login redirect.',requirements,outcomeA:outcome('A','plan a'),outcomeB:outcome('B','plan b')});
  assert.match(reconcile.task,/- Keep the public API stable\./);assert.match(reconcile.task,/reject any proposed action that conflicts with the request's explicit constraints/);
  const ref={provider:'p',id:'m'};
  const directive=buildDoubleDirective({ref,requirements,reconcileText:'Directive — do X.',outcomeA:outcome('A','a'),outcomeB:outcome('B','b')});
  assert.ok(directive.directive.indexOf('Do not modify auth.ts.')<directive.directive.indexOf('Directive — do X.'),'the anchor precedes the body so a bounded directive never loses it');
  const many=Array.from({length:60},(_,index)=>`Requirement number ${index} with some descriptive wording to fill space.`);
  const bounded=buildDoubleStreamTask({stream:'A',task:'t',requirements:many});
  assert.ok(bounded.task.length<DOUBLE_RECOMMENDED_LIMITS.maxRequirementChars+4_000,'the requirement list is bounded');
  assert.ok(directive.directive.length<=DOUBLE_RECOMMENDED_LIMITS.maxDirectiveChars);
});

test('the reconciler gets a mechanical file-overlap fact, never a judgment',()=>{
  assert.match(doubleOverlapNote('edit src/a.ts and lib/b.ts','change src/a.ts plus c.py'),/1 in both \(src\/a\.ts\), 1 only in A \(lib\/b\.ts\), 1 only in B \(c\.py\); overlap 33%\./);
  assert.equal(doubleOverlapNote('no files here','none either'),'');
  assert.match(doubleOverlapNote('x.ts y.ts','x.ts y.ts'),/overlap 100%/);
  const both=buildDoubleReconcileTask({task:'t',outcomeA:outcome('A','touch src/a.ts'),outcomeB:outcome('B','touch src/b.ts')});
  assert.match(both.task,/Named files: 0 in both, 1 only in A \(src\/a\.ts\), 1 only in B \(src\/b\.ts\); overlap 0%/);
  const lone=packageDoubleStreams(outcome('A','touch src/a.ts'),outcome('B','','failed'));
  assert.equal(lone.overlapNote,'','one stream has nothing to compare');
});
