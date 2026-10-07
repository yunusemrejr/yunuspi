import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';

async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-event-integrity-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true}));
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}});
  const model = {id:'fixture', name:'Fixture', provider:'fixture', api:'openai-completions', reasoning:false,
    input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:32000, maxTokens:1024};
  let requests = 0, calls = 0;
  const modelRuntime = {
    getModel:()=>model, getAvailable:()=>[model], hasConfiguredAuth:()=>true,
    isUsingSubscription:()=>false, getAuth:async()=>({auth:{apiKey:'synthetic'}}),
    streamSimple() {
      const content = requests++ % 2 === 0 ? [{type:'toolCall', id:`call-${requests}`, name:'probe', arguments:{}}] : [{type:'text', text:'verified fixture'}];
      const message = {role:'assistant', api:model.api, provider:model.provider, model:model.id,
        content, stopReason:requests % 2 ? 'toolUse':'stop', timestamp:Date.now(),
        usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      return {async *[Symbol.asyncIterator]() {yield {type:'done',message};}, result:async()=>message};
    },
  };
  const extension = pi => pi.registerTool({name:'probe', label:'Probe', description:'Fixture', parameters:Type.Object({}),
    execute:async(_id,_args,_signal,onUpdate)=>{
      calls++; onUpdate({content:[{type:'text',text:'observed progress'}],details:{}});
      await new Promise(resolve=>setImmediate(resolve));
      return {content:[{type:'text',text:'observed result'}],details:{verified:true}};
    },
  });
  const resourceLoader = new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,
    noPromptTemplates:true,noThemes:true,extensionFactories:[extension]});
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, path.join(cwd,'sessions'));
  const {session} = await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader,sessionManager,tools:['probe'],thinkingLevel:'off'});
  t.after(()=>session.dispose());
  return {session,sessionManager,calls:()=>calls,requests:()=>requests};
}

test('a throwing session observer cannot erase executed tool evidence or stop healthy observers', async t => {
  const {session,sessionManager,calls,requests} = await fixture(t), observed = [], errors = [];
  await session.bindExtensions({onError:error=>errors.push(error)});
  session.subscribe(event=>{
    if (['tool_execution_update','tool_execution_end'].includes(event.type) || event.type==='message_end' && event.message.role==='toolResult') throw Error(`broken observer: ${event.type}`);
  });
  session.subscribe(event=>observed.push(event));
  await session.prompt('Execute the fixture tool', {source:'rpc'});
  assert.equal(calls(),1, JSON.stringify(session.agent.state.messages));
  assert.equal(requests(),2,'a UI observer cannot turn successful execution into retry work');
  const transcript = sessionManager.getBranch().filter(entry=>entry.type==='message').map(entry=>entry.message);
  assert.equal(transcript.filter(message=>message.role==='toolResult' && message.details?.verified).length,1);
  assert.equal(transcript.at(-1).stopReason,'stop');
  assert.ok(observed.some(event=>event.type==='tool_execution_end' && !event.isError));
  assert.ok(errors.some(error=>error.event==='session_listener' && /broken observer/.test(error.error)));
  assert.equal(session.isStreaming,false);
});

test('rejected observer promises are reported and removed listeners do not skip a peer', async t => {
  const {session,sessionManager} = await fixture(t), errors = [];
  await session.bindExtensions({onError:error=>errors.push(error)});
  let stop, peerMessages = 0;
  stop = session.subscribe(event=>{if(event.type==='message_start')stop();});
  session.subscribe(event=>{if(event.type==='message_start')peerMessages++;});
  session.subscribe(async event=>{if(event.type==='tool_execution_update')throw Error('rejected observer');});
  await session.prompt('Execute another fixture tool',{source:'rpc'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(peerMessages,4,'removing the first listener must not skip the next listener during dispatch');
  assert.ok(errors.some(error=>/rejected observer/.test(error.error)));
  assert.equal(sessionManager.getBranch().filter(entry=>entry.type==='message' && entry.message.role==='toolResult').length,1);
});
