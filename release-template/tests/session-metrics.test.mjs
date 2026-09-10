import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/lib/session-metrics.ts')));
assert.ok(agent, 'session metrics must be shipped');
const {collectSessionMetrics} = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-metrics.ts')));
const {wrapper, transform} = await import(pathToFileURL(path.join(agent, 'scripts/patches/hook-metrics.mjs')));
const message = (role, fields) => ({type:'message', message:{role, ...fields}});
const child = (runId, results) => ({type:'custom', customType:'subagent-cost-v1', data:{runId, results}});
const snapshot = (segment, calls) => ({type:'custom', customType:'session-metrics-v1', data:{segment,
  hooks:{'fixture:context':{calls, errors:1, ms:2, removedChars:40, addedChars:4}}, events:{swarms:1, fusions:1}}});

test('replayed results, child receipts and cumulative snapshots count once', () => {
  const tool = message('toolResult', {toolCallId:'call', toolName:'bash', isError:true, content:[{type:'text', text:'Blocked: fixture'}]});
  const entries = [message('assistant', {content:[{type:'toolCall', id:'call', name:'bash'}], usage:{input:10, output:5, cacheRead:90, reasoning:2}}),
    tool, tool, child('a',[{}]), child('a',[{index:0, exitCode:0, usage:{input:10, output:5, cacheRead:5}}]),
    child('b',[{index:0, error:'fixture failure', exitCode:1}]), snapshot('segment',2), snapshot('segment',4)];
  const m = collectSessionMetrics(entries);
  assert.equal(m.toolResults,1); assert.equal(m.errors,1); assert.equal(m.blocked,1);
  assert.equal(m.agents,2); assert.equal(m.agentFailures,1); assert.equal(m.agentOutcomeUnknown,0);
  assert.equal(m.childTokens,20); assert.equal(m.hookCalls,4); assert.equal(m.swarms,1); assert.equal(m.fusions,1);
  assert.equal(m.cacheRate,90); assert.equal(m.output,5); assert.equal(m.reasoning,2);
  assert.equal(collectSessionMetrics(entries, snapshot('segment',7).data).hookCalls,7);
});

test('legacy failures and missing history remain distinguishable', () => {
  const m = collectSessionMetrics([message('toolResult', {toolName:'web_search', details:{queryCount:2, successfulQueries:0}}), child('legacy',[{}])]);
  assert.equal(m.errors,1); assert.equal(m.agentOutcomeUnknown,1); assert.equal(m.telemetry,false);
  assert.match(m.detail.join('\n'), /savings: unknown/); assert.ok(m.footer.includes('Hooks ?'));
  const parallel = message('toolResult', {toolName:'subagent', details:{mode:'parallel', runId:'group', results:[{runId:'a'},{runId:'b'}]}});
  assert.equal(collectSessionMetrics([parallel]).swarms,1);
});

test('hook instrumentation preserves receiver, result, errors and sink isolation', async () => {
  const events = [], symbol = Symbol.for('yunus-pi.metrics.v1');
  const context = {performance, Symbol, globalThis:{[symbol]:(kind,data)=>events.push({kind,data})}};
  const wrap = vm.runInNewContext('('+wrapper+')',context);
  const owner = {value:9};
  const result = await wrap(function(event) {
    assert.equal(this,owner); return {messages:[{content:event.messages[0].content.slice(0,2)}]};
  },'context','/fixture/extension.ts').call(owner,{messages:[{content:'abcdefghij'}]});
  assert.equal(result.messages[0].content,'ab'); assert.equal(events[0].data.removedChars,8);
  assert.equal(events[0].data.owner,'extension.ts');
  const failure = new Error('fixture failure');
  await assert.rejects(wrap(async()=>{throw failure},'tool_call','fixture')({}), error=>error===failure);
  assert.equal(events[1].data.error,true);
  context.globalThis[symbol]=()=>{throw Error('sink failure')};
  assert.equal(await wrap(()=>3,'input','fixture')({}),3);
  delete context.globalThis[symbol]; assert.equal(await wrap(()=>4,'input','fixture')({}),4);
});

test('SDK and CLI hook patches are idempotent and reject changed anchors or payloads', () => {
  for (const [source,bundled] of [['list.push(handler);\n            extension.handlers.set(event, list);',false],
    ['list2.push(handler),extension.handlers.set(event,list2)',true]]) {
    const patched = transform(source,bundled);
    assert.match(patched,/PI_HOOK_METRICS_V1/); assert.equal(transform(patched,bundled),patched);
    assert.throws(()=>transform(patched.replace('ms:performance.now()-started','ms:0'),bundled),/drift/);
    assert.throws(()=>transform('unsupported loader',bundled),/anchor drift/);
  }
});
