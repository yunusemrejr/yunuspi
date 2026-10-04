import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExecution, createAdaptiveExecutionController, automaticCapabilityDecision,
  registerAdaptiveExecution, currentExecutionProfile, automaticChildThinking, completionExecutionProfile,
} from '../agent/extensions/lib/adaptive-execution.ts';

test('direct tasks use no automatic coordination while required and deliberate capabilities remain callable', () => {
  for (const task of ['Fix the typo in a single file.', 'Run the existing parser test.', 'Explain what this function returns.', 'Change animation-duration to 2s.']) {
    const profile = classifyExecution({task});
    assert.equal(profile.tier, 'direct', task);
    assert.equal(profile.assistance.maxAgents, 0);
    assert.equal(profile.reasoning, 'minimal');
    for (const capability of Object.keys(profile.features)) {
      assert.equal(automaticCapabilityDecision(profile, capability).run, false, `${task}: ${capability}`);
      assert.equal(automaticCapabilityDecision(profile, capability, {required:true}).run, true);
      assert.equal(automaticCapabilityDecision(profile, capability, {explicit:true}).run, true);
      assert.equal(automaticCapabilityDecision(profile, capability, {explicit:true,running:true}).run, false);
    }
  }
});

test('breadth, alternatives, risk and uncertainty determine independent work and review width', () => {
  const broad = classifyExecution({task:'Implement cross-file changes in frontend and backend with tests',independentWorkItems:2});
  assert.equal(broad.tier,'complex');assert.equal(broad.assistance.mode,'swarm');assert.equal(broad.assistance.maxAgents,2);
  assert.equal(broad.review.reviewers,3);
  assert.equal(classifyExecution({task:'Compare architectural alternatives for the API cache'}).assistance.mode,'fusion');
  assert.equal(classifyExecution({task:'Fix authentication token validation'}).tier,'critical');
  assert.equal(classifyExecution({task:'Fix parser',uncertainty:.9}).tier,'complex');
  const diagnosis=classifyExecution({task:'Investigate why the parser check fails'});
  assert.equal(diagnosis.tier,'standard');assert.equal(diagnosis.assistance.maxAgents,1);assert.equal(diagnosis.review.reviewers,1);
  assert.equal(diagnosis.features.jev,false,'deterministic diagnosis routing needs no judge');
});

test('scope shape ignores quoted/fenced requests and retains current delegation constraints', () => {
  assert.equal(classifyExecution({task:'Hello\n> Implement cross-file migration with security review'}).tier,'direct');
  assert.equal(classifyExecution({task:'```\nRedesign all the subsystems\n```'}).tier,'direct');
  for (const constraint of ['Do not spawn subagents.', 'No helpers.', 'Only use the current provider.']) {
    const p=classifyExecution({task:`Investigate cross-file failures. ${constraint}`});
    assert.equal(p.features.assistance,false,constraint);assert.equal(p.features.council,false,constraint);
  }
  assert.equal(classifyExecution({task:'Investigate the parser failure. Only use HTML, CSS and PHP.'}).features.assistance,true);
  assert.equal(classifyExecution({task:'Investigate the parser failure. Only use free models.'}).features.assistance,true);
  assert.equal(classifyExecution({task:`Investigate the parser failure. ${'context '.repeat(5000)} Do not spawn helpers.`}).constraints.noDelegation,true,'tail constraints survive routing-prefix bounds');
});

test('failures escalate during execution, unrelated successes retain uncertainty and verified repairs simplify', () => {
  const controller=createAdaptiveExecutionController();
  assert.equal(controller.begin({task:'Fix a one-line typo'}).tier,'direct');
  assert.equal(controller.observe({ok:false,transient:true,failureKey:'quota'}).tier,'direct');
  controller.observe({ok:false,failureKey:'parser'});
  assert.equal(controller.observe({ok:false,failureKey:'parser'}).tier,'standard');
  assert.equal(controller.observe({ok:true}).tier,'standard','an unrelated read does not resolve the failure');
  assert.equal(controller.observe({ok:false,failureKey:'parser'}).tier,'complex');
  assert.equal(controller.observe({ok:true,verified:true}).tier,'direct');
  assert.equal(controller.observe({ok:false,failureKey:'different'}).failures,1,'a new failure cannot be masked by old verification');
});

test('task, subtask and todo keep evidence separate and explicit constraints can be inherited', () => {
  const c=createAdaptiveExecutionController();
  c.begin({task:'Migrate cross-file authentication and deployment',scope:'task'},'parent');
  assert.equal(c.profile().tier,'critical');
  c.begin({task:'Format one source file',scope:'todo'},'format');
  assert.equal(c.profile().tier,'direct');
  c.observe({ok:false,failureKey:'parse'});c.observe({ok:false,failureKey:'parse'});
  c.begin({task:'Run the existing smoke check',scope:'subtask'},'smoke');
  assert.equal(c.profile().tier,'direct');
  assert.equal(c.select('format').tier,'standard');
  assert.equal(c.select('parent').tier,'critical');
  c.update({noDelegation:true});assert.equal(c.profile().features.assistance,false);
  c.reset();assert.equal(c.select('parent'),undefined);
});

test('profile owners isolate managers that happen to open the same transcript and stale disposal', () => {
  let id='a';
  const manager={getSessionFile:()=>'/session.jsonl',getSessionId:()=>id};
  const one={cwd:'/project',sessionManager:manager};
  const two={cwd:'/project',sessionManager:{...manager}};
  const direct=()=>classifyExecution({task:'Fix one typo'}), complex=()=>classifyExecution({task:'Migrate cross-file source'});
  const old=registerAdaptiveExecution(one,direct);const replacement=registerAdaptiveExecution(one,complex);const other=registerAdaptiveExecution(two,direct);
  old();assert.equal(currentExecutionProfile(one).tier,'complex');assert.equal(currentExecutionProfile(two).tier,'direct');
  id='b';assert.equal(currentExecutionProfile(one),undefined);id='a';
  replacement();assert.equal(currentExecutionProfile(one),undefined);assert.equal(currentExecutionProfile(two).tier,'direct');other();
});

test('automatic child reasoning follows the scope without overriding configured route thinking', () => {
  const p=classifyExecution({task:'Investigate a parser failure'});
  assert.equal(automaticChildThinking(p,'provider/model'),'low');
  assert.equal(automaticChildThinking(p,'provider/model:high'),undefined);
  assert.equal(automaticChildThinking(p,'provider/model:ultra'),undefined);
  assert.equal(automaticChildThinking(p,'provider/model',true),undefined);
  assert.equal(automaticChildThinking(classifyExecution({task:'Migrate schema'}),'provider/model'),'high');
});

test('malformed numeric observations do not create imaginary scope or errors', () => {
  assert.equal(classifyExecution({task:'Run one test',changedFiles:Infinity,failures:NaN,uncertainty:Infinity}).tier,'direct');
  const c=createAdaptiveExecutionController(1);c.begin({task:'Read one file'},'first');c.begin({task:'Read another file'},'second');assert.equal(c.select('first'),undefined);
});


test('measured control lightens optional coordination for earned routes, tightens it for guarded ones and never relaxes critical or failing scope', () => {
  const open = 'Redesign the settings page layout';
  const base = classifyExecution({task: open});
  assert.equal(base.tier, 'complex');assert.equal(base.control.level, 'standard');
  const earned = classifyExecution({task: open, control: {level: 'earned'}});
  assert.equal(earned.cadence.observerMs, base.cadence.observerMs * 2);
  assert.equal(earned.cadence.watchmakerMs, 0, 'periodic watchmaker review waits for a signal');
  assert.equal(earned.review.reviewers, 2);assert.equal(earned.features.assistance, false, 'open-ended work alone no longer starts a helper');
  assert.ok(earned.reasons.some(reason => /earned autonomy/.test(reason)));
  const broad = classifyExecution({task: 'Implement cross-file changes in frontend and backend with tests', independentWorkItems: 2, control: {level: 'earned'}});
  assert.equal(broad.features.assistance, true, 'explicit breadth still earns a helper');
  assert.equal(classifyExecution({task: 'Compare architectural alternatives for the API cache', control: {level: 'earned'}}).assistance.mode, 'fusion');
  const diagnosis = classifyExecution({task: 'Investigate why the parser check fails', control: {level: 'earned'}});
  assert.equal(diagnosis.features.assistance, true, 'diagnosis still gets its investigator');
  const critical = classifyExecution({task: 'Fix authentication token validation', control: {level: 'earned'}});
  const criticalBase = classifyExecution({task: 'Fix authentication token validation'});
  assert.deepEqual({...critical, control: undefined, reasons: undefined}, {...criticalBase, control: undefined, reasons: undefined}, 'critical scope ignores earned autonomy');
  const failing = classifyExecution({task: open, failures: 2, control: {level: 'earned'}});
  assert.equal(failing.cadence.observerMs, base.cadence.observerMs, 'unresolved failures suspend earned freedom');
  assert.equal(failing.review.reviewers, base.review.reviewers);
  const guardedDirect = classifyExecution({task: 'Fix a one-line typo', control: {level: 'guarded'}});
  assert.equal(guardedDirect.tier, 'direct');assert.equal(guardedDirect.features.observer, true);assert.equal(guardedDirect.features.qualityReview, true);
  assert.equal(guardedDirect.cadence.observerMs, 60000);assert.equal(guardedDirect.review.reviewers, 1, 'a small change needs one independent look, not two');
  const guardedStandard = classifyExecution({task: 'Investigate why the parser check fails', control: {level: 'guarded'}});
  assert.equal(guardedStandard.review.reviewers, 2);assert.equal(guardedStandard.cadence.observerMs, 60000);
  const constrained = classifyExecution({task: `${open}. Do not spawn subagents.`, control: {level: 'guarded'}});
  assert.equal(constrained.features.assistance, false, 'user constraints outrank the control');
});

test('a burst of mistakes raises a direct scope to verification support for its duration without starting helpers', () => {
  const burst = classifyExecution({task: 'Fix a one-line typo', control: {level: 'standard', burst: {family: 'edit', slips: 2}}});
  assert.equal(burst.tier, 'standard');assert.ok(burst.reasons.some(reason => /burst/.test(reason)));
  assert.equal(burst.features.observer, true);assert.equal(burst.assistance.maxAgents, 0, 'a burst gets guidance, not a child agent');
  assert.equal(classifyExecution({task: 'Fix a one-line typo', control: {level: 'standard'}}).tier, 'direct');
});

test('the controller applies route control across scopes, reports changes and clears on reset', () => {
  const c = createAdaptiveExecutionController();
  c.begin({task: 'Redesign the settings page layout'}, 'task');
  const before = c.profile().cadence.observerMs;
  assert.equal(c.setControl({level: 'earned'}), true);
  assert.equal(c.profile().cadence.observerMs, before * 2);
  assert.equal(c.setControl({level: 'earned'}), false, 'an unchanged control reports no change');
  c.begin({task: 'Fix a one-line typo', scope: 'todo'}, 'todo:1');
  assert.equal(c.profile().control.level, 'earned', 'route reliability is not scoped to a todo');
  assert.equal(c.setControl({level: 'standard', burst: {family: 'edit', slips: 2}}), true);
  assert.equal(c.profile().tier, 'standard');
  assert.equal(c.setControl(undefined), true);assert.equal(c.profile().control.level, 'standard');
  c.setControl({level: 'guarded'});c.reset();assert.equal(c.profile().control.level, 'standard');
});

test('completion assurance keeps the live route control', () => {
  const live = classifyExecution({task: 'Format one source file', scope: 'todo', control: {level: 'guarded'}});
  const retained = completionExecutionProfile('Fix a one-line parser comparison', ['a.js'], live);
  assert.equal(retained.control.level, 'guarded');assert.equal(retained.scope, 'task');
  assert.equal(completionExecutionProfile('Fix a one-line parser comparison', ['a.js']).control.level, 'standard');
});
