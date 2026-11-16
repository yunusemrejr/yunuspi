import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createJiti } from 'jiti';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';
import { collectSessionCost } from '../core/coding-agent/src/core/session-accounting.js';
const jiti = createJiti(import.meta.dirname);
const {default:registerBackground} = await jiti.import('../agent/extensions/pi-background-tasks/src/extension.ts');

const billed = total => ({input:2, output:1, cacheRead:0, cacheWrite:0, totalTokens:3,
  cost:{total, source:'provider-reported'}});

test('real managed subprocess carries observed Pi spend into a detached parent once', {timeout:15_000}, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-background-cost-'));
  const child = path.join(cwd, 'child-fixture.cjs');
  const wrap = (customType, data, fields) => ({type:'entry_appended', entry:{type:'custom', customType, data, ...fields}});
  const toolResult = {role:'toolResult', toolName:'metered-tool', toolCallId:'tool-1', usage:billed(.02)};
  const launchEvents = [
    {type:'session', id:'fixture-child'},
    {type:'message_end', message:{role:'assistant', provider:'fixture', model:'test', responseId:'response-1', usage:billed(.04)}},
    {type:'tool_result_end', message:toolResult},
    {type:'message_end', message:toolResult},
    wrap('auxiliary-model-usage-v1',{id:'search-1',provider:'fixture',model:'search',owner:'web_search',status:'pending'}),
    wrap('auxiliary-model-usage-v1',{id:'search-1',provider:'fixture',model:'search',owner:'web_search',status:'completed',usage:billed(.01)}),
    wrap('auxiliary-model-usage-v1',{id:'summary-1',provider:'fixture',model:'test',owner:'compaction',status:'completed',usage:billed(.02)},{accountingOnly:true}),
    {type:'compaction_end',result:{usage:{...billed(.02),summaryReceiptIds:['summary-1']}}},
    {type:'compaction_end',result:{usage:{...billed(.02),summaryReceiptIds:['summary-1']}}},
    wrap('subagent-cost-v1',{runId:'native-1',results:[{runId:'child-native-1',usage:billed(.01)}]}),
    {type:'message_end', message:{role:'toolResult', toolName:'bg_wait', usage:billed(70)}},
  ];
  fs.writeFileSync(child, '#!/usr/bin/env node\n' +
    `setTimeout(() => { for (const event of ${JSON.stringify(launchEvents)}) process.stdout.write(JSON.stringify(event)+'\\n'); }, 100);\n`, {mode:0o700});
  const old = process.env.PI_SUBAGENT_PI_BINARY;
  process.env.PI_SUBAGENT_PI_BINARY = child;
  const tools = new Map(), entries = [];
  const sessionManager = {getSessionId:()=> 'fixture-parent', getBranch:()=> entries, getEntries:()=> entries};
  const ctx = {cwd, sessionManager, isIdle:()=>true, hasUI:false, modelRegistry:{getAll:()=>[]}};
  const events = createEventBus(), hooks = new Map();
  registerBackground({
    events,
    on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    appendEntry(customType, data) { entries.push({type:'custom',customType,data}); },
    sendMessage() { assert.fail('notification disabled for this test'); },
  });
  const hook = async name => { for (const callback of hooks.get(name) ?? []) await callback({type:name}, ctx); };
  t.after(async () => {
    await hook('session_shutdown');
    if (old === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = old;
    fs.rmSync(cwd, {recursive:true, force:true});
  });
  await hook('session_start');
  const run = await tools.get('bg_run').execute('launch-1', {command:'pi -p "fixture"',name:'fixture child',isAgent:true,notifyOnCompletion:false}, undefined, undefined, ctx);
  assert.equal(collectSessionCost(entries).pending,1);
  const {id} = run.details.task;
  assert.equal(entries[0].data.id,id);
  for (const deadline = Date.now() + 6_000; Date.now() < deadline && entries.length < 2;) {
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.deepEqual(entries.map(entry => entry.data.status),['pending','completed']);
  assert.equal(collectSessionCost(entries).formatted,'$0.100000');
  const status = await tools.get('bg_status').execute('look-1',{taskId:id});
  const replay = ['bg_status','bg_wait','bg_wait'].map(toolName => ({
    type:'message',message:{role:'toolResult',toolName,details:status.details},
  }));
  assert.equal(collectSessionCost([...entries, ...replay]).formatted,'$0.100000');

  // A terminal registry record can survive an interrupted transcript append.
  entries.pop();
  await hook('session_start');
  for (const deadline = Date.now() + 2_000; Date.now() < deadline && entries.length < 2;)
    await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(collectSessionCost(entries).formatted,'$0.100000');

  const opaque = await tools.get('bg_run').execute('launch-2', {
    command:`printf '%s\\n' '{"type":"background-task-telemetry","tokenUsage":{"totalTokens":27,"costTotal":99}}'`,
    name:'fixture opaque agent',isAgent:true,notifyOnCompletion:false,
  }, undefined, undefined, ctx);
  const opaqueId = opaque.details.task.id;
  for (const deadline = Date.now() + 2_000; Date.now() < deadline && entries.length < 4;)
    await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(entries[3].data.id, opaqueId);
  assert.equal(entries[3].data.usage.costDetails.unknown,true);
  assert.equal(collectSessionCost(entries).formatted,'$0.100000+?');
});

test('managed cancellation drains final billing and still escalates when Pi ignores TERM', {
  skip: process.platform === 'win32', timeout: 15_000,
}, async t => {
  const {BackgroundTaskRegistry} = await jiti.import('../agent/extensions/pi-background-tasks/src/core/registry.ts');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-background-shutdown-cost-'));
  const child = path.join(cwd, 'child-fixture.cjs');
  t.after(() => process.once('beforeExit', () => fs.rmSync(cwd, {recursive:true, force:true})));
  const first = {type:'message_end', message:{role:'assistant', provider:'fixture', model:'test',
    responseId:'initial-response', usage:billed(.03)}};
  const last = {type:'entry_appended', entry:{type:'custom', customType:'auxiliary-model-usage-v1',
    data:{id:'shutdown-spend',provider:'fixture',model:'test',owner:'shutdown',status:'completed',usage:billed(.07)}}};
  fs.writeFileSync(child, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.argv.at(-1);
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const keepAlive = setInterval(() => {}, 1000);
process.stdout.on('error', () => {});
process.on('SIGTERM', () => {
  if (mode === 'stubborn') return;
  setTimeout(() => {
    emit(${JSON.stringify(last)});
    clearInterval(keepAlive);
    process.exitCode = 143;
  }, 30);
});
emit({type:'session',id:'fixture-child'});
emit(${JSON.stringify(first)});
fs.writeFileSync(mode + '.ready', 'ready');
`, {mode:0o700});
  const signals = [];
  const registry = new BackgroundTaskRegistry({
    env: {...process.env, PI_SUBAGENT_PI_BINARY:child}, killGraceMs:1000, stopWaitMs:3000,
    sendCompletionNotification: () => undefined,
    killProcess(pid, signal) { signals.push(signal); return process.kill(pid, signal); },
  });
  t.after(async () => { await registry.stopAllRunning('shutdown'); });
  const ctx = {cwd, sessionId:'fixture-shutdown', modelRegistry:{getAll:()=>[]}};
  const cancel = async mode => {
    signals.length = 0;
    const task = await registry.startTask(ctx, `pi -p ${mode}`, {isAgent:true,notifyOnCompletion:false});
    const ready = path.join(cwd, `${mode}.ready`);
    for (const deadline = Date.now() + 3000; Date.now() < deadline && !fs.existsSync(ready);)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(ready), 'fixture child started before sending TERM');
    await registry.stopTask(task, 'shutdown');
    assert.equal(task.status, 'killed');
    assert.equal(task.costEvidence.unknown, true);
    return task.costEvidence.reported;
  };
  assert.equal(await cancel('graceful'), .1);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(await cancel('stubborn'), .03);
  assert.deepEqual(signals, ['SIGTERM','SIGKILL']);
});
