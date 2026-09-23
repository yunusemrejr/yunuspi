import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Text, visibleWidth, stripTerminalSequences} from '@yunuspi/tui';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {CustomMessageComponent} from '../core/coding-agent/src/modes/interactive/components/custom-message.js';
import {ToolExecutionComponent} from '../core/coding-agent/src/modes/interactive/components/tool-execution.js';
import {initTheme, theme} from '../core/coding-agent/src/modes/interactive/theme/theme.js';
import {createActivityIndicators, ACTIVITY_MESSAGE_TYPE} from '../agent/extensions/lib/activity-indicators.ts';
import {createQualityReviewLifecycle} from '../agent/extensions/lib/quality-review.ts';

const root = path.resolve(import.meta.dirname, '..');
const plain = lines => lines.map(stripTerminalSequences).join('\n');
function assertSafeLines(lines, width) {
 for (const line of lines) {
  assert.ok(visibleWidth(line) <= width, `rendered line exceeds ${width} cells: ${JSON.stringify(line)}`);
  assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f]/, 'only renderer-owned SGR colors may enter a terminal line');
 }
}

test('registered activity renderer produces bounded TUI lines for each flowing local intelligence stage', async () => {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-tui-'));
 const keys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENTS_TEMP_ROOT', 'PI_SUBAGENT_CHILD', 'PI_ACTIVITY_INDICATORS'];
 const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
 process.env.PI_CODING_AGENT_DIR = cwd; process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(cwd, 'subagents');
 delete process.env.PI_SUBAGENT_CHILD; delete process.env.PI_ACTIVITY_INDICATORS;
 let extensions = [], activity;
 try {
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   additionalExtensionPaths:[path.join(root, 'agent/extensions/pi-subagents/src/extension/index.ts')]});
  await loader.reload();
  const loaded = loader.getExtensions(); extensions = loaded.extensions;
  assert.deepEqual(loaded.errors, []);
  const renderer = extensions.flatMap(extension => [...extension.messageRenderers]).find(([name]) => name === ACTIVITY_MESSAGE_TYPE)?.[1];
  assert.equal(typeof renderer, 'function', 'the real subagent extension registered its activity renderer');
  initTheme('dark');
  const sent = [];
  activity = createActivityIndicators((message, options) => {assert.equal(options.triggerTurn, false); sent.push(message);});
  for(let i=0;i<3;i++)activity.note('ml.needle.call', {op:'rank',count:1,durationMs:2});
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.count, 3);
  const burst = plain(new CustomMessageComponent(sent[0],renderer).render(120));
  assert.match(burst, /Needle3.*6ms total.*3 completions/);
  for(let i=0;i<2;i++){activity.note('ml.needle.call',{op:'rank',count:1,cached:true});await Promise.resolve();}
  assert.equal(sent.length, 3, 'later completions create visible lines rather than vanishing behind an old cooldown');
  assert.match(plain(new CustomMessageComponent(sent[1],renderer).render(120)),/cached embeddings.*rank ready/);
  const fixtures = [
   ['ml.jev.used',{questions:3},'JEV'],
   ['ml.smol.inference',{decision:'selected'},'Smol'],
   ['ml.mini.select',{decision:'cache-hit'},'Kompress'],
   ['ml.fuzzy.used',{count:2},'Fuzzy matching'],
   ['ml.radar.rank',{decision:'on',count:3},'Neural ranker'],
   ['ml.wasm.completed',{runtime:'tree-sitter-wasm',helper:'source-check',findings:2},'WASM source check'],
   ['ml.intent',{},'Intent classifier'],
   ['ml.retrieval.used',{},'Retrieval intelligence'],
   ['ml.evidence.delivered',{helper:'deterministic',savedChars:2048},'Deterministic selection'],
   ['ml.evidence.returned',{helper:'needle',savedChars:1234},'Needle3'],
   ['ml.smol.offer',{decision:'ineligible-source',reason:'protected-content'},'Smol'],
  ];
  for(const [kind,data,label] of fixtures){
   activity.note(kind,{...data,raw:'\x1b[2JPRIVATE-PAYLOAD',route:'PRIVATE-ROUTE',text:'PRIVATE-CONTENT'});
   await Promise.resolve();
   const message=sent.at(-1);
   assert.equal(message.details.label,label);
   assert.equal(message.excludeFromContext,true);
   assert.ok(renderer(message,{expanded:false},theme) instanceof Text, 'registration uses the production TUI Text component');
   const component=new CustomMessageComponent(message,renderer);
   assert.match(plain(component.render(120)),new RegExp(label));
   assert.doesNotMatch(plain(component.render(120)),/PRIVATE|harness-activity/,'producer data cannot leak through the fallback/custom renderer');
   for(const expanded of [false,true]){
    component.setExpanded(expanded);
    for(const width of [12,20,42,120])assertSafeLines(component.render(width),width);
   }
  }
  assert.match(plain(new CustomMessageComponent(sent.find(message=>message.details.kind==='intelligence.activity'&&message.details.detail.includes('added to model context')),renderer).render(120)),/added to model context.*2048 characters saved/);
  assert.match(plain(new CustomMessageComponent(sent.find(message=>message.details.detail.includes('returned exact excerpts')),renderer).render(120)),/returned exact excerpts.*1234 characters omitted/);
  activity.note('model.skip',{route:'fixture/reasoning-model',outcome:'length-stop'});
  const limited = sent.at(-1);
  assert.equal(limited.details.status,'skip','an output ceiling is not a failed model route');
  assert.match(plain(new CustomMessageComponent(limited,renderer).render(120)),/output limit reached/);
  assert.equal(limited.excludeFromContext,true);
  activity.note('model.skip',{route:'fixture/failed-model',outcome:'provider-error'});
  assert.equal(sent.at(-1).details.status,'error','real provider errors stay visible');
 } finally {
  activity?.dispose();
  for(const extension of extensions)for(const shutdown of extension.handlers.get('session_shutdown')??[])await shutdown({type:'session_shutdown'},{});
  for(const key of keys)if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];
  fs.rmSync(cwd,{recursive:true,force:true});
 }
});

test('quality review partial updates replace the actual native tool display while its runner remains pending', async () => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'review-tui-'));
 const tools={};let finish,component;const frames=[];
 const ctx={cwd,sessionManager:{getBranch:()=>[],getSessionId:()=>cwd}};
 const lifecycle=createQualityReviewLifecycle({on(){},registerTool:tool=>tools[tool.name]=tool,getActiveTools:()=>['quality_review'],appendEntry(){}},
  {refresh:async()=>{},tests:()=>({need:null}),runner:request=>new Promise(resolve=>{
   request.onResult({aspect:'correctness',ok:true,text:JSON.stringify({outcome:'pass',evidence:['value.js:1 current source was inspected.'],findings:[],gap:''})});
   finish=()=>resolve([]);
  })});
 try {
  lifecycle.restore(ctx);lifecycle.input({source:'interactive',text:'Implement source behavior.'});
  fs.writeFileSync(path.join(cwd,'value.js'),'export const value=1;');
  lifecycle.result({toolName:'write',input:{path:'value.js'}},ctx);
  initTheme('dark');
  component=new ToolExecutionComponent('quality_review','review',{action:'review'},{showImages:false},tools.quality_review,{requestRender(){}},cwd);
  component.markExecutionStarted();
  const run=tools.quality_review.execute('review',{action:'review'},undefined,partial=>{
   component.updateResult(partial,true);
   const lines=component.render(120);assertSafeLines(lines,120);frames.push(plain(lines));
   for(const width of [20,42])assertSafeLines(component.render(width),width);
  },ctx);
  for(let attempt=0;attempt<1000&&!finish;attempt++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof finish,'function','review reached its pending runner');
  assert.ok(frames.some(frame=>/Quality review 1\/2: correctness received/.test(frame)));
  assert.match(frames.at(-1),/deadline 300s remaining/);
  assert.equal(component.isPartial,true,'the tool shows progress before completion');
  finish();component.updateResult(await run,false);
  assert.equal(component.isPartial,false);
  assert.doesNotMatch(plain(component.render(120)),/preparing source context|deadline 300s remaining/,'final receipt replaces transient progress');
 } finally {lifecycle.shutdown();fs.rmSync(cwd,{recursive:true,force:true});}
});
