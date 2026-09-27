import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(dir=>fs.existsSync(path.join(dir,'extensions/lib/double.ts')));
const lib=await import(pathToFileURL(path.join(agent,'extensions/lib/double.ts')));
const {doubleRouteLabel,formatDoubleStatus,parseDoubleCommandArgs,boundDoubleText,mergeDoubleGaps,
  buildDoubleStreamTask,packageDoubleStreams,buildDoubleReconcileTask,buildDoubleDirective,DOUBLE_RECOMMENDED_LIMITS}=lib;

const outcome=(stream,text,status='complete',extra={})=>({stream,status,text,...extra});

test('route label pins provider and model and rejects empty identity',()=>{
  assert.equal(doubleRouteLabel({provider:'openrouter',id:'glm-5.3-flash'}),'openrouter/glm-5.3-flash');
  assert.equal(doubleRouteLabel({provider:'  openrouter  ',id:'  m  '}),'openrouter/m');
  for(const bad of [undefined,null,{}, {provider:'',id:'m'},{provider:'p',id:'  '},{provider:7,id:'m'}])
    assert.throws(()=>doubleRouteLabel(bad),/provider and id/);
});

test('status line shows the doubled route when on and nothing else when off',()=>{
  assert.equal(formatDoubleStatus(false),'Double mode: OFF');
  assert.equal(formatDoubleStatus(false,{provider:'p',id:'m'}),'Double mode: OFF');
  assert.equal(formatDoubleStatus(true,{provider:'openrouter',id:'glm-5.3-flash'}),'Double mode: ON\n2× openrouter/glm-5.3-flash');
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
    assert.match(brief.task,new RegExp(`Double instance ${self}`));
    assert.match(brief.task,new RegExp(`instance \\(${peer}\\)`));
    assert.match(brief.task,/Fix the login redirect/);
    assert.match(brief.task,/Propose actions; do not take state-changing ones/);
    assert.match(brief.task,/Proposed actions/);
    assert.match(brief.task,/Uncertainties/);
  }
  const withCtx=buildDoubleStreamTask({stream:'A',task:'t',context});
  assert.match(withCtx.task,/Working directory: \/work/);
  assert.match(withCtx.task,/Available tools: read, grep/);
  assert.match(withCtx.task,/Available skills: plan/);
  // Same request and context: the two briefs differ only in stream identity.
  const norm=(text,self,peer)=>text.replaceAll(`instance ${self}`,'instance X').replaceAll(`(${peer})`,'(X)').replaceAll(`what ${peer} concluded`,'what X concluded');
  assert.equal(norm(a.task,'A','B'),norm(b.task,'B','A'));
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
  assert.match(lone.task,/Challenge it as a skeptic/);
  assert.match(lone.task,/Do not treat one view as consensus/);
  assert.match(lone.task,/B crashed/);
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
  assert.match(clean.directive,/single authoritative plan/);
  assert.match(clean.directive,/Directive — do X/);
  const partial=buildDoubleDirective({ref,reconcileText:'Directive — do X.',
    outcomeA:outcome('A','a'),outcomeB:outcome('B','','failed',{gap:'B timed out.'})});
  assert.equal(partial.degraded,true);
  assert.match(partial.directive,/partial result/);
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
