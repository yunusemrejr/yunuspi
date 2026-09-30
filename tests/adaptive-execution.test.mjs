import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExecution, createAdaptiveExecutionController, automaticCapabilityDecision,
  registerAdaptiveExecution, currentExecutionProfile, automaticChildThinking,
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
  assert.equal(automaticChildThinking(p,'provider/model',true),undefined);
  assert.equal(automaticChildThinking(classifyExecution({task:'Migrate schema'}),'provider/model'),'high');
});

test('malformed numeric observations do not create imaginary scope or errors', () => {
  assert.equal(classifyExecution({task:'Run one test',changedFiles:Infinity,failures:NaN,uncertainty:Infinity}).tier,'direct');
  const c=createAdaptiveExecutionController(1);c.begin({task:'Read one file'},'first');c.begin({task:'Read another file'},'second');assert.equal(c.select('first'),undefined);
});
