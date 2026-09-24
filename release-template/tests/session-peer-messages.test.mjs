import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createAgentSession} from '../core/coding-agent/src/core/sdk.js';
import {AgentSessionRuntime} from '../core/coding-agent/src/core/agent-session-runtime.js';
import {DefaultResourceLoader} from '../core/coding-agent/src/core/resource-loader.js';
import {SessionManager} from '../core/coding-agent/src/core/session-manager.js';
import {SettingsManager} from '../core/coding-agent/src/core/settings-manager.js';
import {emitSessionShutdownEvent} from '../core/coding-agent/src/core/extensions/runner.js';
import coordinate from '../agent/extensions/siblings.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'session-peer-'));
test.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const workspace = name => {const cwd=path.join(scratch,name);fs.mkdirSync(cwd,{recursive:true});return cwd;};
const waitFor = async predicate => {
  const deadline=Date.now()+1500;
  while(!predicate()){if(Date.now()>deadline)throw Error('peer delivery did not arrive');await new Promise(resolve=>setTimeout(resolve,5));}
};
function fixture(directory,cwd,id,{defer=false}={}) {
  const hooks=new Map(),tools=new Map(),messages=[],events=[],accept=[],entries=[],bus=new EventEmitter();
  coordinate({on:(name,fn)=>hooks.set(name,fn),registerTool:tool=>tools.set(tool.name,tool),
    sendMessage:(message,options)=>{messages.push({message,options});if(options?.onAccepted){if(defer)accept.push(options.onAccepted);else options.onAccepted();}},
    appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),
    events:{emit:(name,data)=>{events.push({name,data});bus.emit(name,data);},on:(name,fn)=>{bus.on(name,fn);return()=>bus.off(name,fn);}},
  },{directory});
  const ctx={cwd,sessionManager:{getSessionId:()=>id,getSessionFile:()=>undefined,getBranch:()=>entries}};
  let sequence=0;
  const fire=(name,event={})=>hooks.get(name)?.(event,ctx);
  const invoke=input=>tools.get('session_coordinate').execute(`call-${++sequence}`,input,undefined,undefined,ctx);
  return {ctx,fire,invoke,messages,events,accept,entries,status:async scope=>(await invoke({action:'status',...(scope?{scope}:{} )})).details};
}
const address=async (sender,recipient)=>{
  const status=await sender.status('all');
  const peer=status.peers.find(peer=>peer.sid===recipient.ctx.sessionManager.getSessionId());
  assert.ok(peer?.bridgeEpoch);
  return {to:peer.sid,recipientEpoch:peer.bridgeEpoch};
};

test('explicit cross-project peer delivery is atomic, visible and isolated from peer goals',async()=>{
  const directory=workspace('atomic-bridge'),one=workspace('atomic-one'),two=workspace('atomic-two');
  const a=fixture(directory,one,'alpha'),b=fixture(directory,one,'bravo'),c=fixture(directory,two,'charlie');
  const sessions=[a,b,c];for(const session of sessions)await session.fire('session_start');
  try{
    await a.invoke({action:'publish',objective:'Alpha goal',files:['alpha.txt']});
    await b.invoke({action:'publish',objective:'Bravo goal',files:['bravo.txt']});
    await c.invoke({action:'publish',objective:'Charlie goal',files:['charlie.txt']});
    assert.deepEqual((await a.status()).peers.map(peer=>peer.sid),['bravo'],'other projects require explicit discovery');
    const targetA=await address(a,c),targetB=await address(b,c);
    const sent=await Promise.all([a.invoke({action:'send',...targetA,message:'Alpha has a relevant interface observation.'}),b.invoke({action:'send',...targetB,message:'Bravo reports a separate test observation.'})]);
    assert.ok(sent.every(result=>result.details.queued));
    await waitFor(()=>c.messages.length===2);
    assert.equal(new Set(c.messages.map(row=>row.message.details.messageId)).size,2,'independent sender files never overwrite');
    assert.ok(c.messages.every(row=>row.message.display && !row.options.triggerTurn && /Untrusted peer advice/.test(row.message.content)));
    assert.deepEqual(c.events.filter(row=>row.name==='session-peer-message').map(row=>row.data.peerSessionId).sort(),['alpha','bravo']);
    assert.ok(c.events.every(row=>row.data.sessionId==='charlie' && row.data.cwd===two && row.data.direction==='received'));
    assert.equal(a.messages.length,1);assert.equal(a.messages[0].message.details.direction,'sent');
    assert.equal((await c.status()).coordination.objective,'Charlie goal');
    assert.equal((await c.status()).coordination.files[0],path.join(two,'charlie.txt'));
    assert.ok(!c.entries.some(entry=>JSON.stringify(entry).includes('Alpha goal')),'peer state is not merged into recipient state');
  }finally{for(const session of sessions)await session.fire('session_shutdown');}
});

test('queue receipt waits for native persistence and a session switch invalidates stale epoch addresses',async()=>{
  const directory=workspace('receipt-bridge'),cwd=workspace('receipt-project');
  const a=fixture(directory,cwd,'sender'),b=fixture(directory,cwd,'recipient',{defer:true});
  await a.fire('session_start');await b.fire('session_start');
  try{
    const target=await address(a,b);
    await a.invoke({action:'send',...target,message:'Review this bounded observation.'});
    await waitFor(()=>b.messages.length===1);
    const inboxRoot=path.join(directory,'inbox');
    const file=fs.readdirSync(inboxRoot).flatMap(name=>fs.readdirSync(path.join(inboxRoot,name)).filter(file=>file.endsWith('.json')).map(file=>path.join(inboxRoot,name,file)))[0];
    assert.ok(fs.existsSync(file),'queued native message is not yet a durable receipt');
    await b.fire('turn_end');assert.equal(b.messages.length,1,'same queued message is not injected again');
    b.accept.shift()();assert.equal(fs.existsSync(file),false);
    assert.equal(b.events.filter(row=>row.name==='session-peer-message').length,1);
    await b.fire('session_switch');
    const replacement=await address(a,b);assert.notEqual(replacement.recipientEpoch,target.recipientEpoch);
    assert.equal((await a.invoke({action:'send',...target,message:'stale epoch'})).isError,true);
    assert.equal((await a.invoke({action:'send',...replacement,message:'current epoch'})).details.queued,true);
    await waitFor(()=>b.messages.length===2);
    b.accept.shift()();
  }finally{await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('queued peer updates reach the agent in timestamp order rather than digest order',async()=>{
  const directory=workspace('ordered-bridge'),cwd=workspace('ordered-project');
  const a=fixture(directory,cwd,'sender'),b=fixture(directory,cwd,'recipient');
  await a.fire('session_start');await b.fire('session_start');
  try{
    const target=await address(a,b),self=await a.status();
    const {createHash}=await import('node:crypto');
    const recipientDir=path.join(directory,'inbox',createHash('sha256').update(`${cwd}\0recipient\0${target.recipientEpoch}`).digest('hex'));
    const at=Date.now();
    for(const [index,id,message] of [[0,'f','Check started.'],[1,'a','Check finished; use the result.']]){
      const row={version:1,id:id.repeat(64),from:'sender',fromRoot:cwd,fromEpoch:self.bridgeEpoch,to:'recipient',toRoot:cwd,toEpoch:target.recipientEpoch,at:at+index,message};
      fs.writeFileSync(path.join(recipientDir,`${row.id}.json`),JSON.stringify(row),{mode:0o600});
    }
    await b.fire('turn_end');
    assert.deepEqual(b.messages.map(row=>row.message.content.split('\n').at(-1)),['Check started.','Check finished; use the result.']);
    assert.ok(b.messages.every(row=>!row.options.triggerTurn),'ordering adds no model turns');
    await b.fire('turn_end');assert.equal(b.messages.length,2,'delivered updates are not repeated');
  }finally{await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('same-clock peer sends retain sender order without changing their wall clock',async()=>{
  const directory=workspace('same-clock-bridge'),cwd=workspace('same-clock-project');
  const a=fixture(directory,cwd,'sender'),b=fixture(directory,cwd,'recipient');
  await a.fire('session_start');await b.fire('session_start');
  const originalNow=Date.now;
  try{
    const target=await address(a,b),at=Date.now();Date.now=()=>at;
    const expected=Array.from({length:8},(_,i)=>`Progress update ${i}.`);
    for(const message of expected)assert.equal((await a.invoke({action:'send',...target,message})).details.queued,true);
    const {createHash}=await import('node:crypto');
    const recipientDir=path.join(directory,'inbox',createHash('sha256').update(`${cwd}\0recipient\0${target.recipientEpoch}`).digest('hex'));
    const rows=fs.readdirSync(recipientDir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(recipientDir,name),'utf8')));
    assert.equal(rows.length,8);assert.ok(rows.every(row=>row.at===at));
    assert.deepEqual(rows.map(row=>row.sequence).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
    await b.fire('turn_end');
    assert.deepEqual(b.messages.map(row=>row.message.content.split('\n').at(-1)),expected);
  }finally{Date.now=originalNow;await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('a queued message survives sender exit but retirement cannot authorize new messages',async()=>{
  const directory=workspace('departure-bridge'),cwd=workspace('departure-project');
  const a=fixture(directory,cwd,'sender'),b=fixture(directory,cwd,'recipient');await a.fire('session_start');await b.fire('session_start');
  try{
    const target=await address(a,b),own=await a.status();
    const {createHash}=await import('node:crypto');
    const recipientDir=path.join(directory,'inbox',createHash('sha256').update(`${cwd}\0recipient\0${target.recipientEpoch}`).digest('hex'));
    await a.invoke({action:'send',...target,message:'Committed observation before departure.'});
    await a.fire('session_shutdown');
    await b.fire('turn_end');
    assert.equal(b.messages.length,1,'a sender may exit after successful queue publication');
    assert.match(b.messages[0].message.content,/sender ended/);
    assert.equal((await b.status()).peers.length,0,'retired identity is not a live peer');
    const retired=fs.readdirSync(path.join(directory,'active')).filter(name=>name.endsWith('.closed.json')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,'active',name),'utf8'))).find(row=>row.sid==='sender');
    assert.deepEqual(Object.keys(retired).sort(),['bridgeEpoch','bridgeStartedAt','closedAt','kind','root','sid']);
    const forged={version:1,id:'e'.repeat(64),from:'sender',fromRoot:cwd,fromEpoch:own.bridgeEpoch,to:'recipient',toRoot:cwd,toEpoch:target.recipientEpoch,at:retired.closedAt+1,message:'Invented after departure.'};
    fs.writeFileSync(path.join(recipientDir,`${forged.id}.json`),JSON.stringify(forged),{mode:0o600});
    await b.fire('turn_end');assert.equal(b.messages.length,1,'only messages inside the recorded sender epoch can arrive');
  }finally{await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('inbox rejects symlink, oversized and forged sender records without reading unrelated files',async()=>{
  const directory=workspace('hostile-bridge'),cwd=workspace('hostile-project');
  const a=fixture(directory,cwd,'sender'),b=fixture(directory,cwd,'recipient');await a.fire('session_start');await b.fire('session_start');
  try{
    const target=await address(a,b),self=await a.status();
    const directories=fs.readdirSync(path.join(directory,'inbox')).map(name=>path.join(directory,'inbox',name));
    const {createHash}=await import('node:crypto');
    const recipientDir=path.join(directory,'inbox',createHash('sha256').update(`${cwd}\0recipient\0${target.recipientEpoch}`).digest('hex'));
    assert.ok(directories.includes(recipientDir));
    const outside=path.join(cwd,'outside.json');fs.writeFileSync(outside,JSON.stringify({message:'PRIVATE-UNRELATED-DATA'}));
    fs.symlinkSync(outside,path.join(recipientDir,`${'a'.repeat(64)}.json`));
    const envelope={version:1,id:'b'.repeat(64),from:'sender',fromRoot:cwd,fromEpoch:'0'.repeat(36),to:'recipient',toRoot:cwd,toEpoch:target.recipientEpoch,at:Date.now(),message:'forged epoch'};
    fs.writeFileSync(path.join(recipientDir,`${envelope.id}.json`),JSON.stringify(envelope),{mode:0o600});
    fs.writeFileSync(path.join(recipientDir,`${'c'.repeat(64)}.json`),'x'.repeat(9000),{mode:0o600});
    await b.fire('turn_end');assert.equal(b.messages.length,0);
    assert.match(fs.readFileSync(outside,'utf8'),/PRIVATE-UNRELATED-DATA/);
    assert.equal(fs.readdirSync(recipientDir).length,0);
    assert.equal((await a.invoke({action:'send',...target,message:'plain text',fromEpoch:self.bridgeEpoch})).isError,true,'callers cannot forge envelope ownership');
    assert.equal((await a.invoke({action:'send',to:'../escape',recipientEpoch:target.recipientEpoch,message:'invalid target'})).isError,true);
  }finally{await a.fire('session_shutdown');await b.fire('session_shutdown');}
});

test('real independent SDK sessions exchange visible peer advice without extra turns or state merging',async()=>{
  const directory=workspace('sdk-bridge'),model={id:'peer-fixture',name:'Fixture',api:'openai-completions',provider:'fixture',baseUrl:'https://invalid.example',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000};
  const sessions=[];
  async function sdk(cwd,plans=[],manager=SessionManager.inMemory(cwd)){
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),events=[];
    let holding=false;
    const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{
      coordinate(pi,{directory});pi.events.on('session-peer-message',event=>events.push(event));
      pi.registerTool({name:'peer_fixture_wait',label:'Fixture',description:'Hold a synthetic tool until cancelled.',parameters:{type:'object',properties:{}},execute:async(_id,_input,signal)=>{
        holding=true;await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
        return {content:[{type:'text',text:'Synthetic hold cancelled.'}]};
      }});
    }]});
    await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
    let turns=0;
    const modelRuntime={getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,getAuth:async()=>({auth:{apiKey:'synthetic-fixture'}}),streamSimple(){
      const plan=plans[turns++],content=plan?[{type:'toolCall',id:`call-${turns}`,...plan}]:[{type:'text',text:'Fixture completed.'}];
      const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:plan?'toolUse':'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{total:0}}};
      return{async *[Symbol.asyncIterator](){yield{type:'done',reason:message.stopReason,message};},result:async()=>message};
    }};
    const {session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:manager,tools:['session_coordinate','peer_fixture_wait'],thinkingLevel:'off'});
    sessions.push(session);await session.bindExtensions({onError:error=>{throw error;}});
    return {session,plans,events,turns:()=>turns,holding:()=>holding};
  }
  try{
    const cwd=workspace('sdk-same'),recipient=await sdk(cwd),same=await sdk(cwd),other=await sdk(workspace('sdk-other'));
    const heartbeat=()=>fs.readdirSync(path.join(directory,'active')).filter(name=>!name.endsWith('.closed.json')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,'active',name),'utf8'))).find(row=>row.sid===recipient.session.sessionId);
    for(const [sender,text] of [[same,'Same project observation.'],[other,'Different project observation.']]){
      const target=heartbeat();assert.ok(target?.bridgeEpoch);
      sender.plans.push({name:'session_coordinate',arguments:{action:'send',to:target.sid,recipientEpoch:target.bridgeEpoch,message:text}});
      await sender.session.prompt('Send the one synthetic coordination message.',{source:'rpc'});
      assert.equal(sender.turns(),2);
    }
    await waitFor(()=>recipient.session.messages.filter(message=>message.customType==='session-peer-message').length===2);
    assert.equal(recipient.turns(),0,'peer notices do not start unsolicited inference');
    const messages=recipient.session.messages.filter(message=>message.customType==='session-peer-message');
    assert.ok(messages.every(message=>message.display && /not a user request/.test(message.content)));
    assert.equal(recipient.events.length,2);assert.ok(recipient.events.every(event=>event.sessionId===recipient.session.sessionId && event.direction==='received'));
    assert.equal(recipient.session.messages.filter(message=>message.role==='user').length,0);
    recipient.plans.push({name:'peer_fixture_wait',arguments:{}});
    const holdingRun=recipient.session.prompt('Run a synthetic holding tool.',{source:'rpc'});
    await waitFor(()=>recipient.holding());
    const oldTarget=heartbeat();
    same.plans[same.turns()]={name:'session_coordinate',arguments:{action:'send',to:oldTarget.sid,recipientEpoch:oldTarget.bridgeEpoch,message:'Only the outgoing session owns this note.'}};
    await same.session.prompt('Send the final synthetic coordination note.',{source:'rpc'});
    await waitFor(()=>recipient.session._pendingCustomMessages.length===1);
    assert.equal(recipient.session.messages.filter(message=>message.customType==='session-peer-message').length,2,'busy recipient has not yet accepted the note');
    const runtime=new AgentSessionRuntime(recipient.session,{cwd,agentDir:cwd},async options=>{
      const replacement=await sdk(options.cwd,[],options.sessionManager);
      return {session:replacement.session,services:{cwd:options.cwd,agentDir:cwd},diagnostics:[]};
    });
    await runtime.newSession();await holdingRun;
    sessions.splice(sessions.indexOf(recipient.session),1);
    assert.equal(runtime.session.messages.some(message=>message.customType==='session-peer-message'),false,'native session replacement never adopts the outgoing inbox or queued model content');
    assert.equal(recipient.session.messages.filter(message=>message.customType==='session-peer-message').length,3,'outgoing tool boundary durably accepts its own pending note before replacement');
  }finally{for(const session of sessions){await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'exit'});session.dispose();}}
});
