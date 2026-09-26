import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createHelperUsageLedger, collectHarnessUsage, harnessUsageHtml, collectSkillEvidence, HELPER_USAGE_ENTRY, HELPER_USAGE_VIEW } from '../agent/extensions/lib/helper-usage.ts';
import { buildUsedSummary, usedSummaryHtml, renderPopupHtml } from '../agent/extensions/session-signals.ts';
import healthLog from '../agent/extensions/health-log.ts';
import { sessionObservability } from '../agent/extensions/lib/session-observability.ts';
import { HEALTH_SINK } from '../agent/extensions/lib/health-log.ts';

const custom=(customType,data,id)=>({type:'custom',customType,data,id});
const notice=(customType,details,content='',id)=>({type:'custom_message',customType,details,content,id,timestamp:'2026-09-24T12:00:00.000Z'});
const component=(summary,name)=>summary.components.find(row=>row.name===name);

test('shared reviewer usage keeps Watchmaker attribution and delivery receipts',()=>{
  const entries=[
    custom('auxiliary-model-usage-v1',{id:'watch-request',owner:'session-watchmaker',provider:'fixture',model:'timekeeper',status:'completed',usage:{input:12,output:3}}),
    notice('session-watchmaker',{status:'completed',adviceId:'watch-note',note:'Review the slow build stage.',evidence:['time-ledger']}),
    custom('watchmaker-delivery-v1',{adviceId:'watch-note',status:'prepared-context'}),
    custom('watchmaker-delivery-v1',{adviceId:'watch-note',status:'provider-received',at:1000,provider:'fixture',model:'main'}),
  ];
  const data=collectHarnessUsage(entries);
  assert.equal(data.observer.requests[0].owner,'session-watchmaker');
  assert.equal(data.observer.noteTotal,1);
  assert.equal(data.observer.received,1);
  assert.equal(data.observer.notes[0].reviewer,'Watchmaker');
  const html=harnessUsageHtml(data);
  assert.match(html,/Session observer & Watchmaker/);
  assert.match(html,/Reviewer<\/dt><dd>Watchmaker/);
});

test('helper ledger separates execution, cache, abstention, application and delivery without summing cumulative snapshots',()=>{
  const ledger=createHelperUsageLedger();
  ledger.note('ml.needle.call',{op:'classify',accepted:false,durationMs:10});
  const first=ledger.snapshot();
  ledger.note('ml.needle.call',{op:'rank',accepted:true,durationMs:20});
  ledger.note('ml.needle.call',{op:'embed',accepted:true,cached:true,durationMs:1});
  ledger.note('ml.needle.call',{op:'rank',accepted:true,coalesced:true});
  ledger.note('ml.evidence.delivered',{helper:'needle'});
  ledger.note('ml.fuzzy.used',{count:6});ledger.note('ml.fuzzy.used',{count:6});
  ledger.note('ml.jev.skipped',{reason:'no-key'});
  const final=ledger.snapshot(),entry=custom(HELPER_USAGE_ENTRY,final,'second');
  const summary=collectHarnessUsage([custom(HELPER_USAGE_ENTRY,first,'first'),entry,entry],final);
  assert.equal(summary.segments,1);
  assert.deepEqual(Object.fromEntries(['executions','cached','skipped','delivered','timingSamples','durationMs'].map(key=>[key,component(summary,'Needle3')[key]])),{executions:2,cached:2,skipped:1,delivered:1,timingSamples:3,durationMs:31});
  assert.equal(component(summary,'Fuzzy matching').applied,2);assert.equal(component(summary,'Fuzzy matching').matches,12);
  assert.equal(component(summary,'JEV').failed,1);assert.equal(component(summary,'JEV').executions,0);
  assert.equal(component(summary,'Local LM').measured,false);
  let attempts=0;assert.throws(()=>ledger.flush(()=>{attempts++;throw new Error('disk');}));
  ledger.flush(()=>attempts++);ledger.flush(()=>attempts++);assert.equal(attempts,2,'failed persistence keeps dirty state, successful retry clears it');
});

test('Guardian cumulative snapshots use latest owner receipt across reload and exclude unscoped historical status',()=>{
  const a=createHelperUsageLedger();
  a.note('guardian.evaluated',{guardianInstanceId:'owner-a',count:4,evaluations:8,similarityEvaluations:3,stats:{admitted:1,peerMessagesReceived:0}});
  const b=createHelperUsageLedger();
  b.note('guardian.evaluated',{guardianInstanceId:'owner-a',count:6,evaluations:12,similarityEvaluations:5,stats:{admitted:2}});
  b.note('guardian.evaluated',{guardianInstanceId:'owner-b',count:1,evaluations:2,stats:{admitted:0}});
  const summary=collectHarnessUsage([
    custom(HELPER_USAGE_ENTRY,a.snapshot()),
    notice('guardian_status',{stats:{toolResults:6,classifierEvaluations:12,admitted:2}}),
    custom(HELPER_USAGE_ENTRY,b.snapshot()),
  ]);
  assert.equal(summary.guardian.classifierEvaluations,14);assert.equal(summary.guardian.toolResults,7);assert.equal(summary.guardian.admitted,2);
  assert.equal(summary.guardian.instances,2);assert.equal(summary.guardian.legacyCoverage,true);
  assert.equal(summary.guardian.peerMessagesSent,undefined);
  const historical=collectHarnessUsage([notice('guardian_status',{stats:{classifierEvaluations:12}})]);
  assert.equal(historical.guardian.classifierEvaluations,undefined);
  assert.match(harnessUsageHtml(summary),/Latest recorded snapshot/);assert.match(harnessUsageHtml(summary),/earlier branches/);assert.match(harnessUsageHtml(summary),/without an owner ID are excluded/);
});

test('observer receipts distinguish returned, prepared and provider-received advice and dedupe auxiliary requests',()=>{
  const branch=[
    notice('session-observer',{status:'completed',detail:'120 ms',adviceId:'advice-a',note:'Check the test result.',tools:['project_tests']}),
    notice('session-observer',{status:'completed',detail:'80 ms',adviceId:'advice-b',note:'Follow up with the reviewer.'}),
    notice('session-observer',{status:'completed'},'Observer returned a note\nHistorical advice.'),
    custom('session-observer-delivery-v1',{adviceId:'advice-a',status:'prepared-context'}),
    custom('session-observer-delivery-v1',{adviceId:'advice-a',status:'provider-received',at:1,provider:'fixture',model:'main'}),
    custom('session-observer-delivery-v1',{adviceId:'advice-a',status:'provider-received',at:1,provider:'fixture',model:'main'}),
    custom('session-observer-delivery-v1',{adviceId:'advice-b',status:'prepared-context'}),
    custom('auxiliary-model-usage-v1',{id:'request-a',owner:'session-observer',provider:'fixture',model:'reviewer',status:'pending'}),
    custom('auxiliary-model-usage-v1',{id:'request-a',owner:'session-observer',provider:'fixture',model:'reviewer',status:'completed',usage:{input:100,output:20}}),
    custom('auxiliary-model-usage-v1',{id:'request-b',owner:'session-observer',provider:'fixture',model:'reviewer',status:'cancelled'}),
  ];
  const summary=collectHarnessUsage(branch),observer=summary.observer;
  assert.equal(observer.noteTotal,3);assert.equal(observer.prepared,2);assert.equal(observer.received,1);assert.equal(observer.requests.length,2);
  assert.equal(observer.notes[0].received.model,'main');assert.equal(observer.notes[1].prepared,true);assert.equal(observer.notes[1].received,undefined);assert.equal(observer.notes[2].prepared,false);
  const html=harnessUsageHtml(summary);assert.match(html,/Provider received/);assert.match(html,/provider delivery unknown/);assert.match(html,/never proves the agent acted/);assert.match(html,/cancelled/);
  assert.equal(collectHarnessUsage([]).observer.requests,undefined);
});

test('historical display notices stay separate from measured executions and hostile text remains escaped',()=>{
  const branch=[notice('harness-activity',{kind:'intelligence.activity',label:'JEV',count:3,status:'ok'}),notice('session-observer',{status:'completed',note:'<img src=x onerror=alert(1)>','evidence':['</dd><script>bad()</script>'],tools:['evil<script>']},[{type:'thinking',thinking:'PRIVATE_REASONING_SENTINEL'},{type:'text',text:'visible'}])];
  const summary=collectHarnessUsage(branch),html=harnessUsageHtml(summary);
  assert.equal(component(summary,'JEV').measured,false);assert.equal(component(summary,'JEV').displayed,3);assert.equal(component(summary,'JEV').executions,undefined);
  assert.match(html,/3 displayed notices/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script|PRIVATE_REASONING_SENTINEL/);
  assert.doesNotThrow(()=>harnessUsageHtml(collectHarnessUsage([notice('session-observer',{status:'completed',note:'Test'},'', 'x')])));
});

test('health ledger persistence failure never interrupts shutdown and old runtime view is cleared',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'helper-ledger-'));
  const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=directory;
  const hooks=new Map(),entries=[];let rejectWrites=true;
  const api={on:(name,fn)=>hooks.set(name,[...(hooks.get(name)??[]),fn]),registerCommand(){},appendEntry:(kind,data)=>{if(rejectWrites&&kind===HELPER_USAGE_ENTRY)throw Error('fixture write failure');entries.push({kind,data});},sendMessage(){}};
  const dispatch=async(name,...args)=>{for(const handler of hooks.get(name)??[])await handler(...args);};
  t.after(async()=>{await dispatch('session_shutdown');if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await fs.rm(directory,{recursive:true,force:true});});
  healthLog(api);await dispatch('session_start',{}, {sessionManager:{getSessionId:()=> 'fixture-session'},ui:{notify(){}}});
  sessionObservability()[HEALTH_SINK]('ml.fuzzy.used',{count:6});await dispatch('turn_end');
  assert.equal(entries.filter(row=>row.kind===HELPER_USAGE_ENTRY).length,0);
  rejectWrites=false;await dispatch('turn_end');assert.equal(entries.filter(row=>row.kind===HELPER_USAGE_ENTRY).length,1);
  rejectWrites=true;sessionObservability()[HEALTH_SINK]('ml.fuzzy.used',{count:2});await dispatch('session_shutdown');
  assert.equal(sessionObservability()[HELPER_USAGE_VIEW],undefined);assert.equal(sessionObservability()[HEALTH_SINK],undefined);
});

test('skill evidence separates successful full and partial reads, failures and cumulative suggestions',()=>{
  const call=(id,args)=>({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:args}]}});
  const result=(id,isError=false)=>({type:'message',timestamp:'2026-09-24T12:01:00Z',message:{role:'toolResult',toolCallId:id,toolName:'read',isError}});
  const guidance=custom('relevant-guidance',{shown:['skill:/skills/debugging/SKILL.md'],read:['/skills/debugging/SKILL.md']});
  const branch=[guidance,call('r1',{path:'/skills/debugging/SKILL.md'}),result('r1'),result('r1'),call('r2',{path:'/skills/debugging/SKILL.md',offset:10,limit:20}),result('r2'),call('r3',{path:'/skills/debugging/SKILL.md'}),result('r3',true),guidance];
  const evidence=collectSkillEvidence(branch).debugging;
  assert.deepEqual([evidence.full,evidence.partial,evidence.failed],[1,1,1]);assert.equal(evidence.total,5);
  assert.equal(evidence.history.filter(row=>row.status==='suggested').length,1);
  assert.match(evidence.history.find(row=>row.status==='partial').range,/line 10 · up to 20 lines/);
  const html=usedSummaryHtml(buildUsedSummary(branch));assert.match(html,/Read receipts/);assert.match(html,/first recorded appearance/);assert.match(html,/2026-09-24 12:01:00 UTC/);assert.doesNotMatch(html,/skill body/);
});

function browserFixture(){
  const ledger=createHelperUsageLedger();
  for(let n=0;n<8;n++)ledger.note('ml.needle.call',{op:'rank',durationMs:32,accepted:true});
  ledger.note('ml.needle.call',{op:'classify',durationMs:45,accepted:false});
  ledger.note('ml.jev.used',{questions:2,durationMs:240});ledger.note('ml.evidence.delivered',{helper:'jev'});
  ledger.note('ml.smol.offer',{decision:'skipped',reason:'protected-content'});ledger.note('ml.fuzzy.used',{count:6});
  ledger.note('guardian.evaluated',{guardianInstanceId:'fixture-owner',count:23,evaluations:46,similarityEvaluations:9,stats:{admitted:2,abstained:8,quarantined:0,constraintCandidates:3,constraintRejected:0,suppressedWindow:1,suppressedHistory:1,peerMessagesSent:0,peerMessagesReceived:0},decision:'observing'});
  const native='11111111-1111-4111-8111-111111111111';
  return [custom('subagent-lifecycle-v1',{runId:native,mode:'single',results:[{index:0,status:'failed'}]}),custom('subagent-cost-v1',{runId:'auto-assist-wrapper',mode:'single',results:[{index:0,agent:'automatic-free-assistant',model:'fixture/reviewer',sessionFile:`/fixture/${native}/run-0/session.jsonl`,timedOut:true,error:'child-error',usage:{input:300,output:100,turns:3}}]}),custom('relevant-guidance',{shown:['skill:/skills/debugging/SKILL.md','skill:/skills/coding-practices/SKILL.md'],read:['/skills/debugging/SKILL.md']}),{type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'read-skill',name:'read',arguments:{path:'/skills/debugging/SKILL.md'}}]}},{type:'message',timestamp:'2026-09-24T12:01:00Z',message:{role:'toolResult',toolCallId:'read-skill',toolName:'read'}},custom(HELPER_USAGE_ENTRY,ledger.snapshot()),notice('session-observer',{status:'running',detail:'fixture/reviewer · high thinking'}),notice('session-observer',{status:'completed',detail:'2,300 ms · 14 new session events',adviceId:'a',note:'The tests passed. Have you updated the to-do list and followed up with the independent reviewer?',tools:['todo','subagent'],skills:['debugging'],evidence:['event-14']}),custom('session-observer-delivery-v1',{adviceId:'a',status:'prepared-context'}),custom('session-observer-delivery-v1',{adviceId:'a',status:'provider-received',at:Date.now(),provider:'fixture',model:'main'}),custom('auxiliary-model-usage-v1',{id:'review-1',owner:'session-observer',provider:'fixture',model:'reviewer',status:'completed',usage:{input:600,output:100}}),notice('guardian_intervention',{category:'Repeated failure'},'The same command failed twice. Inspect the error before retrying.')];
}

test('used popup supports compact drilldown, keyboard focus, narrow layout and honest empty coverage in a real browser',async t=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1200,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const summary=buildUsedSummary(browserFixture(),{provider:'fixture',id:'selected'});
  await page.setContent(renderPopupHtml('What this session used',usedSummaryHtml(summary)));
  assert.equal(await page.locator('h1').innerText(),'What this session used');
  assert.match(await page.locator('.usage-freshness').innerText(),/Run \/used again.*reloading this saved page keeps the same snapshot/);
  assert.match(await page.locator('#usage-captured-at').innerText(),/UTC$/);
  await page.evaluate(() => {
    Date.now = () => Date.parse(document.getElementById('usage-captured-at').dateTime) + 120000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('#usage-snapshot-age').innerText(),'2 minutes old');
  assert.doesNotMatch(await page.locator('.usage-kpi strong').first().evaluate(node=>getComputedStyle(node).fontFamily),/Emoji/);
  assert.equal(await page.locator('.usage-component').count(),13);
  for (const name of ['Span sensor', 'Micro worker', 'Remote rerank']) {
    assert.equal(await page.locator('.usage-component').filter({ has: page.locator('summary b', { hasText: new RegExp(`^${name}$`) }) }).count(), 1);
  }
  assert.equal(await page.locator('.usage-component[open]').count(),0);
  assert.equal(await page.locator('#usage-observer').getAttribute('open'),null);
  const jev=page.locator('.usage-component').filter({has:page.locator('summary b',{hasText:/^JEV$/})});
  await jev.locator('summary').focus();assert.equal(await jev.locator('summary').evaluate(node=>getComputedStyle(node).outlineStyle),'solid');
  await page.keyboard.press('Enter');assert.notEqual(await jev.getAttribute('open'),null);assert.match(await jev.innerText(),/240 ms average/);
  const modelGroup=page.locator('details.group').filter({has:page.locator(':scope > summary .group-title',{hasText:'Main conversation models'})});
  await modelGroup.locator(':scope > summary').click();await modelGroup.locator('.item summary').click();assert.match(await modelGroup.innerText(),/Token traffic\s+not recorded/);
  if(process.env.YUNUSPI_USED_SCREENSHOT_DIR){await fs.mkdir(process.env.YUNUSPI_USED_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.YUNUSPI_USED_SCREENSHOT_DIR,'used-wide.png'),fullPage:true});}
  await page.locator('#usage-observer > summary').click();assert.match(await page.locator('#usage-observer').innerText(),/1 provider receipts/);
  await page.locator('#usage-observer .item > summary').click();assert.match(await page.locator('#usage-observer').innerText(),/Provider received/);
  await page.locator('#usage-guardians > summary').click();assert.match(await page.locator('#usage-guardians').innerText(),/46/);
  const skills=page.locator('details.group').filter({has:page.locator(':scope > summary .group-title',{hasText:'Skills'})});await skills.locator(':scope > summary').click();await skills.locator('.item summary').first().click();assert.match(await skills.innerText(),/Read receipts/);
  const children=page.locator('details.group').filter({has:page.locator(':scope > summary .group-title',{hasText:'Logical child tasks'})});
  await children.locator(':scope > summary').click();
  assert.match(await children.innerText(),/1 tasks · 1 attempts/);
  assert.match(await children.innerText(),/Automatic assistant/);
  assert.match(await children.innerText(),/Timed out/);
  await children.locator('.item > summary').first().click();
  if(process.env.YUNUSPI_USED_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.YUNUSPI_USED_SCREENSHOT_DIR,'used-details.png'),fullPage:true});
  await page.setViewportSize({width:360,height:820});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.YUNUSPI_USED_SCREENSHOT_DIR){
    await page.screenshot({path:path.join(process.env.YUNUSPI_USED_SCREENSHOT_DIR,'used-narrow.png'),fullPage:true});
    await page.locator('#usage-observer').screenshot({path:path.join(process.env.YUNUSPI_USED_SCREENSHOT_DIR,'used-narrow-observer.png')});
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(process.env.YUNUSPI_USED_SCREENSHOT_DIR,'used-narrow-top.png')});
  }
  await page.setContent(renderPopupHtml('Empty evidence',usedSummaryHtml(buildUsedSummary([]))));
  assert.match(await page.locator('#usage-intelligence').innerText(),/Historical coverage|No measurement/);assert.equal(await page.locator('#usage-intelligence .usage-kpi strong').first().innerText(),'—');
  assert.deepEqual(errors,[]);
});

test('helper acceptance recorded by consumers counts as applied in the session ledger', async () => {
  const { createHelperUsageLedger } = await import('../agent/extensions/lib/helper-usage.ts');
  const ledger = createHelperUsageLedger();
  ledger.note('ml.helper.applied', { helper: 'needle' });
  ledger.note('ml.helper.applied', { helper: 'jev' });
  ledger.note('ml.helper.applied', { helper: 'llm' });
  const components = ledger.snapshot().components;
  assert.equal(components.Needle3.applied, 1);
  assert.equal(components.JEV.applied, 1);
  assert.equal(Object.keys(components).length, 2, 'remote prompt analysis is not a local helper');
});
