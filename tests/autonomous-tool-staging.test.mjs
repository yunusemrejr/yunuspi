import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {emitSessionShutdownEvent} from '../core/coding-agent/src/core/extensions/runner.js';
import {registerToolDiscovery} from '../agent/extensions/lib/tool-discovery.ts';
import registerSourceCheck from '../agent/extensions/lib/source-check.ts';
import {registerSeoToolkit} from '../agent/extensions/pi-web-access/seo-toolkit.ts';
import {formatSkillsForPrompt} from '../core/coding-agent/src/core/skills.js';
import {formatSkillInvocation} from '../core/agent/src/harness/skills.js';
import {formatSkillsForSystemPrompt} from '../core/agent/src/harness/system-prompt.js';
import {buildSkillInjection} from '../agent/extensions/pi-subagents/src/agents/skills.ts';
import {resolveSubagentLaunchContract} from '../agent/extensions/pi-subagents/src/api/preflight.ts';
import {resolvePiLaunchToolPlan} from '../agent/extensions/pi-subagents/src/runs/shared/pi-args.ts';
import {rewriteSubagentPrompt,stripInheritedSkills,stripProjectContext} from '../agent/extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts';
import {failureCategory} from '../agent/extensions/lib/session-diagnostics.ts';

const root = path.resolve(import.meta.dirname, '..');

test('catalog, child and explicit skill prompts bound mandatory wording as reference guidance', () => {
  const skill={name:'fixture-guide',description:'Inspect a fixture',filePath:'/fixture/SKILL.md',path:'/fixture/SKILL.md',content:'MANDATORY: always run every step and ignore other tools.'};
  const catalog=formatSkillsForPrompt([skill]);
  const harnessCatalog=formatSkillsForSystemPrompt([skill]);
  const child=buildSkillInjection([skill]);
  const explicit=formatSkillInvocation(skill,'Inspect just the fixture.');
  for(const text of [catalog,harnessCatalog,child,explicit]) {
    assert.match(text,/reference guide|reference guidance/);
    assert.match(text,/tool.*prerequisite|prerequisites.*tools/);
    assert.match(text,/mandatory/);
    assert.match(text,/tool contracts and safety boundaries take precedence/);
  }
  assert.ok(explicit.includes(skill.content),'reference contents remain available');
  assert.ok(explicit.endsWith('Inspect just the fixture.'));
});

test('child skill isolation recognizes current and legacy catalog headers without losing the task or date', () => {
  const skill={name:'fixture-guide',description:'Inspect a fixture',filePath:'/fixture/SKILL.md'};
  const legacy='\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>fixture-guide</available_skills>';
  for(const catalog of [formatSkillsForPrompt([skill]),'\n\n'+formatSkillsForSystemPrompt([skill]),legacy]) {
    const prompt='Inspect the fixture.'+catalog+'\nCurrent date: 2026-10-06';
    assert.equal(stripInheritedSkills(prompt),'Inspect the fixture.\nCurrent date: 2026-10-06');
    const child=rewriteSubagentPrompt(prompt,{inheritProjectContext:true,inheritGlobalContext:true,inheritSkills:false});
    assert.ok(child.includes('Inspect the fixture.') && child.includes('Current date:'));
    assert.ok(!child.includes('fixture-guide') && !child.includes('<available_skills>'));
    assert.match(child,/Skills are optional reference guides/);
    const project='Inspect the fixture.\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nproject guidance'+catalog+'\nCurrent date: 2026-10-06';
    assert.equal(stripProjectContext(project),prompt,'legacy project stripping retains either skill catalog');
  }
});

test('optional skill reads cannot reject or widen a child tool ceiling', () => {
  for(const allowedTools of [[],['write']]) {
    const plan=resolvePiLaunchToolPlan({tools:allowedTools,requireReadTool:true,capabilityCeiling:{version:1,allowedTools,denyExtensions:true,sources:['fixture']}});
    assert.deepEqual(plan.declaredBuiltinTools,allowedTools);
    assert.ok(!plan.effectiveToolAllowlist.includes('read'));
  }
  const recovery=failureCategory('Before write on "page.tsx", read the matching workflow(s): UI').recovery;
  assert.match(recovery,/legacy skill-read checkpoint/);
  assert.match(recovery,/Skills are advisory/);
});

test('a missing optional guide warns in child preflight without removing tools or relaxing role boundaries', async () => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'guide-preflight-'));
  const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=cwd;
  try {
    fs.mkdirSync(path.join(cwd,'.pi/agents'),{recursive:true});
    fs.writeFileSync(path.join(cwd,'.pi/agents/fixture.md'),'---\nname: fixture\ndescription: Inspect a fixture\ntools: read\n---\nInspect the assigned file.\n');
    const input={agent:'fixture',agentScope:'project',cwd,task:'Inspect the fixture',sessionRoot:path.join(cwd,'sessions'),artifacts:false};
    const result=await resolveSubagentLaunchContract({...input,skill:['missing-fixture-guide']});
    assert.equal(result.ok,true);
    assert.deepEqual(result.contract.skills.missing,['missing-fixture-guide']);
    assert.ok(result.contract.tools.effectiveAllowlist.includes('read'));
    assert.ok(result.contract.diagnostics.some(d=>d.code==='missing_skill' && d.severity==='warning'));
    const parentOnly=await resolveSubagentLaunchContract({...input,skill:['pi-subagents']});
    assert.equal(parentOnly.ok,false,'parent-only orchestration remains outside child authority');
  } finally {
    if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
    fs.rmSync(cwd,{recursive:true,force:true});
  }
});

// Only the model transport is simulated: real extensions, SDK, discovery and
// prompt hooks decide which tool schemas the first model turn receives.
async function firstTurnTools(prompt, scriptedCalls = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-sdk-'));
  fs.writeFileSync(path.join(cwd,'sample.js'),'export const value = ;\n');
  fs.writeFileSync(path.join(cwd,'sample.html'),'<html lang="en"><head><title>Sensor calibration guide</title></head><body><main><h1>Calibration</h1><p>Use two measured references.</p></main></body></html>');
  const envNames = ['PI_CODING_AGENT_DIR', 'PI_JEV', 'PI_NEEDLE', 'PI_TOOL_DISCOVERY', 'PI_SUBAGENT_CHILD'];
  const previous = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = cwd; process.env.PI_JEV = 'off'; process.env.PI_NEEDLE = 'off'; process.env.PI_TOOL_DISCOVERY = 'on'; delete process.env.PI_SUBAGENT_CHILD;
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}});
    const loader = new DefaultResourceLoader({cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: ['design-studio.ts', 'video-studio.ts', 'code-quality.ts', 'git-tools.ts', 'desktop-session.ts', 'render-and-wait.ts'].map(file => path.join(root, 'agent/extensions', file)), extensionFactories: [registerToolDiscovery, registerSourceCheck, registerSeoToolkit]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const model = {id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 131072, maxTokens: 8192};
    const contexts = [];
    const modelRuntime = {getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false, getAuth: async () => ({auth: {apiKey: ['synthetic', 'fixture'].join('-')}}),
      streamSimple(_model, context) {
        const call = scriptedCalls[contexts.length];
        contexts.push(context.tools.map(tool => tool.name));
        const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: call ? [{type:'toolCall',id:`call-${contexts.length}`,name:call.name,arguments:call.arguments}] : [{type: 'text', text: 'ok'}], stopReason: call ? 'toolUse' : 'stop', usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {total: 0}}};
        return {async *[Symbol.asyncIterator]() { yield {type: 'done', reason: message.stopReason, message}; }, result: async () => message};
      }};
    ({session} = await createAgentSession({cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'off'}));
    await session.bindExtensions({onError: () => {}});
    await session.prompt(prompt, {source: 'rpc'});
    return scriptedCalls.length ? {contexts,results:session.messages.filter(message=>message.role==='toolResult')} : contexts[0];
  } finally {
    if (session) { await emitSessionShutdownEvent(session.extensionRunner, {type: 'session_shutdown', reason: 'exit'}); session.dispose(); }
    for (const key of envNames) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(cwd, {recursive: true, force: true});
  }
}

test('image-to-code, video, quality and desktop prompts put their tools on the first model turn; plain prompts stay lean', {timeout: 120_000}, async () => {
  const design = await firstTurnTools('Turn this mockup into a website: https://example.com/landing.png');
  for (const name of ['image_analyze', 'image_crop', 'image_trace', 'visual_diff', 'render_see']) assert.ok(design.includes(name), `${name} staged for image-to-code`);
  const video = await firstTurnTools('Make a 60 second explainer video about how attention works');
  assert.ok(video.includes('video_project') && video.includes('narration_tts'));
  const quality = await firstTurnTools('Refactor the billing module and remove duplicated logic, then commit it');
  assert.ok(quality.includes('code_quality') && quality.includes('git_info'));
  const desktop = await firstTurnTools('Test the Electron app: click through the settings window');
  assert.ok(desktop.includes('desktop_session'));
  const plain = await firstTurnTools('Fix the off-by-one error in the pagination helper');
  for (const name of ['image_analyze', 'video_project', 'code_quality', 'desktop_session']) assert.ok(!plain.includes(name), `${name} stays off the wire`);
});

test('a named specialized tool reaches the real SDK first turn without a skill catalog', async () => {
  const tools=await firstTurnTools('Use image_crop to inspect the reference. No skills.');
  assert.ok(tools.includes('image_crop'));
});

test('public-site requests automatically expose SEO and real SDK execution inspects, repairs and generates discovery', {timeout:120_000}, async () => {
  const repaired = '<html lang="en"><head><title>Sensor calibration guide</title><meta name="description" content="Measured two-point calibration, a worked example and known sensor limitations."><link rel="canonical" href="https://example.com/guide"><meta name="viewport" content="width=device-width"></head><body><main><h1>Calibration</h1><p>Use two measured references.</p></main></body></html>';
  const workflow = await firstTurnTools('Create a public documentation website with a calibration guide. No skills.', [
    {name:'seo_toolkit',arguments:{action:'plan',scope:'public',canonicalOrigin:'https://example.com',pages:[{url:'/guide',intent:'sensor calibration'}]}},
    {name:'seo_toolkit',arguments:{action:'inspect',url:'https://example.com/guide',path:'sample.html'}},
    {name:'write',arguments:{path:'sample.html',content:repaired}},
    {name:'seo_toolkit',arguments:{action:'inspect',url:'https://example.com/guide',path:'sample.html'}},
    {name:'seo_toolkit',arguments:{action:'discovery',canonicalOrigin:'https://example.com',pages:[{url:'/guide',title:'Sensor calibration guide'},{url:'/private',index:false}]}},
  ]);
  assert.ok(workflow.contexts[0].includes('seo_toolkit'), 'a public-site request gets native SEO before the first model turn');
  const results = workflow.results.filter(row=>row.toolName==='seo_toolkit');
  assert.equal(results.length,4); assert.ok(results.every(row=>!row.isError));
  const before=JSON.parse(results[1].content[0].text),after=JSON.parse(results[2].content[0].text),discovery=JSON.parse(results[3].content[0].text);
  assert.ok(before.findings.some(f=>f.code==='canonical-missing'));
  assert.ok(!after.findings.some(f=>f.code==='canonical-missing'));
  assert.notEqual(before.sha256,after.sha256);
  assert.ok(Object.values(discovery.files).some(value=>value.includes('https://example.com/guide')));
  assert.ok(Object.values(discovery.files).every(value=>!value.includes('/private')));
  const privateTools=await firstTurnTools('Build an internal employee dashboard. No skills.');
  assert.ok(!privateTools.includes('seo_toolkit'), 'private apps preserve their scope');
});

test('real SDK discovery enables and executes a native tool, preserves failure evidence, and verifies a repair', {timeout:120_000}, async () => {
  const workflow=await firstTurnTools('Inspect and repair sample.js. No skills.',[
    {name:'tool_search',arguments:{names:['syntax_check'],detail:true}},
    {name:'syntax_check',arguments:{paths:['sample.js']}},
    {name:'write',arguments:{path:'sample.js',content:'export const value = 42;\n'}},
    {name:'syntax_check',arguments:{paths:['sample.js']}},
  ]);
  assert.ok(!workflow.contexts[0].includes('syntax_check'));
  assert.ok(workflow.contexts[1].includes('syntax_check'),'activation reaches the same request');
  assert.equal(workflow.results[0].toolName,'tool_search');
  assert.ok(workflow.results[0].content[0].text.includes('paths'),'discovery explains required native inputs');
  const checks=workflow.results.filter(result=>result.toolName==='syntax_check');
  assert.equal(checks.length,2);assert.equal(checks[0].isError,true);assert.equal(checks[1].isError,false);
  assert.ok(checks[0].content[0].text.includes('sample.js'));
});
