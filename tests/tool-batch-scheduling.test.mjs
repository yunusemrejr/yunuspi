import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { runAgentLoop } from '../core/agent/src/agent-loop.js';
import { Agent } from '../core/agent/src/agent.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate, label) { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate(), label); }
function runBatch(names, tools, overrides = {}, signal) {
  const events = []; let requests = 0;
  const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', contextWindow: 32000, maxTokens: 1000 };
  const stream = () => {
    const content = requests++ === 0 ? names.map((name, i) => ({ type: 'toolCall', id: `${name}-${i}`, name, arguments: {} })) : [{ type: 'text', text: 'done' }];
    const message = { role: 'assistant', provider: model.provider, api: model.api, model: model.id, content, stopReason: requests === 1 ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'done', message }; }, result: async () => message };
  };
  const done = runAgentLoop([{ role: 'user', content: 'fixture', timestamp: Date.now() }], { messages: [], tools, systemPrompt: '' },
    { model, convertToLlm: messages => messages, ...overrides }, event => { events.push(event); }, signal, stream);
  return { done, events, requests: () => requests };
}
function tool(name, execute, sequential = false) {
  return { name, label: name, description: name, parameters: Type.Object({}), ...(sequential ? { executionMode: 'sequential' } : {}), execute };
}
const result = terminate => ({ content: [{ type: 'text', text: 'done' }], details: {}, ...(terminate ? { terminate: true } : {}) });

test('actual tool loop overlaps independent groups while exclusive preflight, execute and finalization form barriers', async () => {
  const names = ['a', 'b', 'exclusive', 'c', 'd'];
  const gates = Object.fromEntries(names.map(name => [name, deferred()]));
  const finalization = deferred(), started = [], active = new Set(), preflight = [];
  let maxActive = 0, preflightActive = 0;
  const tools = names.map(name => tool(name, async () => {
    if (name === 'exclusive') assert.equal(active.size, 0);
    else assert.equal(active.has('exclusive'), false);
    active.add(name); started.push(name); maxActive = Math.max(maxActive, active.size);
    await gates[name].promise; active.delete(name); return result();
  }, name === 'exclusive'));
  const run = runBatch(names, tools, {
    async beforeToolCall({ toolCall }) {
      assert.equal(preflightActive++, 0, 'preflight hooks remain serial');
      if (toolCall.name === 'exclusive') assert.equal(active.size, 0);
      preflight.push(toolCall.name); await tick(); preflightActive--;
    },
    async afterToolCall({ toolCall }) { if (toolCall.name === 'a') await finalization.promise; },
  });
  await until(() => started.length >= 2, 'first independent pair must execute concurrently');
  assert.deepEqual(started, ['a', 'b']); assert.deepEqual(preflight, ['a', 'b']);
  gates.b.resolve(); gates.a.resolve(); await tick();
  assert.deepEqual(started, ['a', 'b'], 'exclusive preflight waits for earlier finalization');
  finalization.resolve(); await until(() => started.includes('exclusive'), 'exclusive tool starts');
  assert.deepEqual(preflight, ['a', 'b', 'exclusive']);
  gates.exclusive.resolve(); await until(() => started.length === 5, 'last independent pair overlaps');
  gates.d.resolve(); gates.c.resolve(); await run.done;
  assert.equal(maxActive, 2, 'five calls execute in three dependency phases instead of five serial phases');
  assert.deepEqual(run.events.filter(e => e.type === 'tool_execution_end').map(e => e.toolName), ['b', 'a', 'exclusive', 'd', 'c']);
  assert.deepEqual(run.events.filter(e => e.type === 'message_end' && e.message.role === 'toolResult').map(e => e.message.toolName), names);
  assert.equal(run.requests(), 2);
});

test('global sequential mode remains serial and abort prevents later barrier preflight', async () => {
  let active = 0, maxActive = 0;
  const sequential = runBatch(['a', 'b', 'exclusive'], ['a', 'b', 'exclusive'].map(name => tool(name, async () => {
    maxActive = Math.max(maxActive, ++active); await tick(); active--; return result();
  }, name === 'exclusive')), { toolExecution: 'sequential' });
  await sequential.done; assert.equal(maxActive, 1);
  const gate = deferred(), started = [], preflight = [], controller = new AbortController();
  const abort = runBatch(['a', 'b', 'exclusive', 'c'], ['a', 'b', 'exclusive', 'c'].map(name => tool(name, async () => {
    started.push(name); await gate.promise; return result();
  }, name === 'exclusive')), { beforeToolCall: ({ toolCall }) => { preflight.push(toolCall.name); } }, controller.signal);
  await until(() => started.length === 2, 'parallel group started'); controller.abort(); gate.resolve(); await abort.done;
  assert.deepEqual(started, ['a', 'b']); assert.deepEqual(preflight, ['a', 'b']);
  assert.equal(abort.requests(), 1, 'Stop must not start another model request');
  assert.equal(abort.events.at(-1).aborted, true);
  const receipts = abort.events.filter(event => event.type === 'message_end' && event.message.role === 'toolResult').map(event => event.message);
  assert.deepEqual(receipts.map(message => [message.toolName, message.isError]), [['a', false], ['b', false], ['exclusive', true], ['c', true]]);
});

test('Stop during turn refresh skips the next provider request', async () => {
  const controller = new AbortController();
  const began = deferred(), refresh = deferred();
  const run = runBatch(['read'], [tool('read', () => result())], {
    async prepareNextTurn() { began.resolve(); await refresh.promise; },
  }, controller.signal);
  await began.promise;
  controller.abort();
  refresh.resolve();
  await run.done;
  assert.equal(run.requests(), 1);
  assert.equal(run.events.filter(event => event.type === 'turn_start').length, 1);
});

test('native steering and follow-up queues retain accepted messages when Stop interrupts turn refresh', async () => {
  for (const queue of ['steer', 'followUp']) {
    const began = deferred(), refresh = deferred(), responding = deferred();
    const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', contextWindow: 32000, maxTokens: 1000 };
    const user = text => ({ role: 'user', content: text, timestamp: Date.now() });
    let requests = 0;
    const agent = new Agent({
      initialState: { model },
      async prepareNextTurn() { began.resolve(); await refresh.promise; },
      streamFn() {
        const first = ++requests === 1;
        const message = { role: 'assistant', provider: model.provider, api: model.api, model: model.id,
          content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
        return { async *[Symbol.asyncIterator]() { if (first) await responding.promise; yield { type: 'done', message }; }, result: async () => message };
      },
    });
    const running = agent.prompt(user('initial'));
    await until(() => requests === 1, 'first request started');
    agent[queue](user('queued before refresh'));
    responding.resolve();
    await began.promise;
    agent[queue](user('queued during refresh'));
    agent.abort();
    refresh.resolve();
    await running;

    assert.equal(requests, 1);
    assert.equal(agent.hasQueuedMessages(), true, queue);
    assert.deepEqual(agent.state.messages.filter(message => message.role === 'user').map(message => message.content), ['initial']);
    await agent.continue();
    assert.deepEqual(agent.state.messages.filter(message => message.role === 'user').map(message => message.content),
      ['initial', 'queued before refresh', 'queued during refresh']);
    assert.equal(agent.hasQueuedMessages(), false, queue);
  }
});

test('steering defers unstarted calls and preserves results for each tool call', async () => {
  for (const toolExecution of ['parallel', 'sequential']) {
    const preflight = deferred(), began = deferred(), executed = [];
    const names = ['edit', 'push'];
    let steering = [];
    const run = runBatch(names, names.map(name => tool(name, () => { executed.push(name); return result(); })), {
      toolExecution,
      hasInterruptingSteering: () => steering.length > 0,
      getSteeringMessages: async () => steering.splice(0),
      async beforeToolCall({ toolCall }) {
        assert.equal(toolCall.name, 'edit', 'a queued correction bypasses stale preflight');
        began.resolve();
        await preflight.promise;
      },
    });
    await began.promise;
    steering = ['Keep the current code.', 'Do a read-only check instead.'].map(content => ({ role: 'user', content, timestamp: Date.now() }));
    preflight.resolve();
    await run.done;
    assert.deepEqual(executed, []);
    const messages = run.events.filter(event => event.type === 'message_end').map(event => event.message);
    const results = messages.filter(message => message.role === 'toolResult');
    assert.deepEqual(results.map(message => [message.toolName, message.isError]), [['edit', true], ['push', true]]);
    assert.match(results[0].content[0].text, /steering message is waiting/);
    assert.deepEqual(messages.filter(message => message.role === 'user').slice(1).map(message => message.content), ['Keep the current code.', 'Do a read-only check instead.']);
    assert.equal(run.requests(), 2);
  }
});

test('blocked barriers, tool failures, and terminate hints retain whole-batch semantics', async () => {
  for (const allTerminate of [false, true]) {
    const executed = [];
    const tools = [tool('a', () => { executed.push('a'); return result(allTerminate); }),
      tool('exclusive', () => { throw new Error('blocked tool must not execute'); }, true),
      tool('c', () => { executed.push('c'); return result(allTerminate); })];
    const run = runBatch(['a', 'exclusive', 'c'], tools, { beforeToolCall: ({ toolCall }) => toolCall.name === 'exclusive' ? { block: true, reason: 'fixture', terminate: true } : undefined });
    await run.done; assert.deepEqual(executed, ['a', 'c']);
    assert.equal(run.requests(), allTerminate ? 1 : 2, 'one terminating barrier cannot terminate other results');
  }
  const run = runBatch(['failed', 'exclusive', 'ok'], [tool('failed', () => { throw new Error('fixture tool error'); }), tool('exclusive', () => result(), true), tool('ok', () => result())]);
  await run.done;
  const messages = run.events.filter(e => e.type === 'message_end' && e.message.role === 'toolResult').map(e => e.message);
  assert.deepEqual(messages.map(m => m.isError), [true, false, false]);
});


test('explicit tool error results retain structured evidence and reach finalization hooks in both execution modes',async()=>{
 for(const toolExecution of ['parallel','sequential']){
  const observed=[];
  const tools=['failure','recovered','success','string_flag'].map(name=>tool(name,()=>({
   ...result(),details:{failure:{stage:'validation',kind:'fixture',outcome:'not-dispatched'}},
   ...(name==='success'?{}:{isError:name==='string_flag'?'true':true}),
  })));
  const run=runBatch(tools.map(t=>t.name),tools,{toolExecution,afterToolCall:({toolCall,isError,result})=>{
   observed.push([toolCall.name,isError]);assert.equal(result.details.failure.outcome,'not-dispatched');
   if(toolCall.name==='recovered')return {isError:false};
  }});
  await run.done;
  assert.deepEqual(observed,[['failure',true],['recovered',true],['success',false],['string_flag',false]]);
  const ends=run.events.filter(e=>e.type==='tool_execution_end');
  assert.deepEqual(ends.map(e=>e.isError),[true,false,false,false]);
  assert.ok(ends.every(e=>e.result.details.failure.stage==='validation'));
  assert.deepEqual(run.events.filter(e=>e.type==='message_end'&&e.message.role==='toolResult').map(e=>e.message.isError),[true,false,false,false]);
 }
});
