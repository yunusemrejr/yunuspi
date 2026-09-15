import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agentRoot=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
assert.ok(agentRoot,'session recovery ships with the distribution');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adaptive-recovery-'));
process.env.PI_CODING_AGENT_DIR=dir;
process.env.PI_PROVIDER_STATE_FILE=path.join(dir,'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH=path.join(dir,'exclusions.json');
process.env.PI_AUTONOMOUS_FREE_ASSIST='0';
delete process.env.PI_SUBAGENT_CHILD;
const network=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Unexpected network');};
const h=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/runs/shared/provider-health.ts')));
const selection=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/runs/shared/model-selection.ts')));
const ep=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/runs/shared/openrouter-endpoints.ts')));
const {registerAutonomousRecovery}=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
const {default:registerGate}=await import(pathToFileURL(path.join(agentRoot,'extensions/provider-gate.ts')));
const base={provider:'openrouter',id:'lab/future-v2',api:'openai-completions',baseUrl:'https://openrouter.ai/api/v1',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,cost:{input:.1,output:.2,cacheRead:0,cacheWrite:0}};
const info=m=>({...m,fullId:`${m.provider}/${m.id}`});
const endpoints=['a','b','c'].map(tag=>({tag,provider_name:`Host ${tag}`,context_length:32768,max_completion_tokens:8192,supported_parameters:['tools'],status:0,pricing:{prompt:'0.0000001',completion:'0.0000002',request:'0',image:'0'},latency_last_30m:{p50:1},throughput_last_30m:{p50:50},uptime_last_30m:99}));
const upstream=name=>`429 ${JSON.stringify({error:{message:'Provider returned error',metadata:{provider_name:name,raw:'concurrency limit'}}})}`;
const clear=()=>fs.rmSync(process.env.PI_PROVIDER_STATE_FILE,{force:true});
const sample=(m,ok,now=Date.now())=>{
 const rates=h.economyRateIdentity(m.cost,m.baseUrl,m.api);
 if(ok)h.recordSuccess({provider:m.provider,model:m.id,now,economyUsage:{input:1000,output:100,cacheRead:0,cacheWrite:0,costUsd:.001,rates,elapsedMs:2000}});
 else h.recordFailure({provider:m.provider,model:m.id,now,errorMessage:'500 server error',rates});
};
async function fixture({model=base,models=[base,{...base,provider:'direct',baseUrl:'https://direct.invalid/v1'}],getEndpoints=async()=>endpoints,prompt='Continue the task',usage=1000,wait=async()=>{}}={}) {
 clear();
 const handlers=new Map(),selected=[],entries=[];let lookups=0;
 const ctx={model,scopedModels:[],getContextUsage:()=>({tokens:usage}),ui:{setStatus(){}},abort(){},modelRegistry:{getAvailable:()=>models},sessionManager:{getSessionFile:()=>path.join(dir,'session.jsonl'),getBranch:()=>[]}};
 const pi={on:(n,f)=>handlers.set(n,[...(handlers.get(n)??[]),f]),registerCommand(){},getActiveTools:()=>['read'],appendEntry:(type,data)=>entries.push({type,...data}),sendMessage(){},setModel:async m=>{ctx.model=m;selected.push(m);return true;}};
 registerAutonomousRecovery(pi,async()=>{throw Error('Unexpected delegation');},{endpoints:async(...args)=>{lookups++;return getEndpoints(...args);},wait});
 const emit=async(n,event={})=>{let result;for(const f of handlers.get(n)??[]) {const r=await f(event,ctx);if(r)result=r;}return result;};
 await emit('input',{source:'user',text:prompt});
 const fail=async(error=upstream('Host a'))=>{const message={role:'assistant',provider:ctx.model.provider,model:ctx.model.id,stopReason:'error',content:[],errorMessage:error};h.recordFailure({provider:message.provider,model:message.model,errorMessage:error,endpoint:ctx.model.compat?.recoveryEndpointName});const event={message,signal:new AbortController().signal};await emit('pi_provider_recovery',event);return event;};
 return {pi,ctx,selected,entries,emit,fail,lookups:()=>lookups};
}
try {
 const now=Date.now();
 h.recordFailure({provider:'openrouter',model:base.id,errorMessage:upstream('Host a'),now});
 assert.equal(h.evaluateRoute({provider:'openrouter',model:base.id,now}).allowed,true,'one upstream does not cool all OpenRouter');
 assert.equal(h.evaluateRoute({provider:'openrouter',model:base.id,endpoints:['Host a'],now}).allowed,false);
 assert.equal(h.evaluateRoute({provider:'openrouter',model:base.id,endpoints:['Host b'],now}).allowed,true);
 h.recordFailure({provider:'openrouter',model:base.id,errorMessage:'429 account quota exceeded',endpoint:'Host b',now});
 assert.equal(h.evaluateRoute({provider:'openrouter',model:base.id,endpoints:['Host c'],now}).allowed,false,'generic account quota remains global even on a pin');
 clear();
 const healthy={...base,provider:'healthy'},flaky={...base,provider:'flaky'};
 for(let i=0;i<8;i++){sample(healthy,true,now-100000+i);sample(flaky,false,now-100000+i);}
 assert.equal(selection.selectRecoveryModel([info(flaky),info(healthy)],info(base),now).model,info(healthy).fullId);
 sample(flaky,true,now);
 assert.equal(h.readHealth().providers.flaky.models[base.id].recoveryHistory.filter(s=>!s.ok).length,8,'success does not erase historical failures');
 assert.equal(h.recoveryPerformance(h.readHealth().providers.healthy.models[base.id],{...healthy,baseUrl:'https://changed.invalid'},now).samples,0,'new endpoint fingerprint cannot inherit old speed/reliability');
 assert.equal(h.recoveryPerformance(h.readHealth().providers.healthy.models[base.id],healthy,now+h.RECOVERY_HISTORY_MS+1).samples,0);
 const cheap={...base,provider:'cheap',id:'other/tiny',contextWindow:131072,maxTokens:8192,cost:{input:.001,output:.001}};
 assert.equal(selection.selectRecoveryModel([info(cheap),info(healthy)],info(base),now).model,info(healthy).fullId,'same model precedes cheap different model');
 assert.equal(selection.sameRecoveryModel(info(base),info({...base,id:'future-v2'})),true);
 assert.equal(selection.sameRecoveryModel(info(base),info({...base,id:'lab/future-v2-mini'})),false);
 clear();
 const opts={model:base,routing:{},visited:new Set(),contextTokens:1000,outputTokens:1024,tools:true,reasoning:false,caps:{prompt:.1,completion:.2}};
 assert.equal(ep.rankRecoveryEndpoints(endpoints,opts).length,3);
 for(const broken of [{pricing:{}},{supported_parameters:[]},{context_length:1000},{max_completion_tokens:100},{pricing:{prompt:'NaN',completion:'0'}},{pricing:{prompt:'.1',completion:'.1'}},{pricing:{prompt:'0',completion:'0',request:'.1'}}])assert.equal(ep.rankRecoveryEndpoints([{...endpoints[0],...broken}],opts).length,0);
 assert.equal(ep.rankRecoveryEndpoints(endpoints,{...opts,routing:{only:['b'],ignore:['b']}}).length,0);
 assert.equal(ep.rankRecoveryEndpoints(endpoints,{...opts,routing:{allow_fallbacks:false}}).length,0);
 const restricted=ep.endpointRecoveryRouting(endpoints[1],{zdr:true,data_collection:'deny',ignore:['a'],max_price:{image:0}},opts.caps);
 assert.equal(restricted.zdr,true);assert.equal(restricted.data_collection,'deny');assert.equal(restricted.max_price.image,0);assert.deepEqual(restricted.only,['b']);
 assert.equal(ep.endpointMetric({p50:2,p90:5}),2);
 let fx=await fixture();
 assert.equal((await fx.fail()).decision,'retry');assert.deepEqual(fx.ctx.model.compat.openRouterRouting.only,['b']);
 assert.equal((await fx.fail(upstream('Host b'))).decision,'retry');assert.deepEqual(fx.ctx.model.compat.openRouterRouting.only,['c']);
 assert.equal((await fx.fail(upstream('Host c'))).decision,'retry');assert.equal(fx.ctx.model.provider,'direct');assert.equal(fx.lookups(),1);
 await fx.emit('agent_settled');assert.equal(fx.ctx.model,base);
 fx=await fixture();await fx.fail();await fx.emit('agent_settled');assert.equal(fx.ctx.model,base,'same-id endpoint pin is restored at settlement');
 fx=await fixture({model:{...base,compat:{openRouterRouting:{order:['a'],allow_fallbacks:true}}}});await fx.fail();assert.deepEqual(fx.ctx.model.compat.openRouterRouting.only,['b']);await fx.emit('session_shutdown');
 fx=await fixture({prompt:'Do not switch provider. Continue the task'});await fx.fail();assert.equal(fx.lookups(),0);assert.equal(fx.ctx.model,base);await fx.emit('session_shutdown');
 fx=await fixture();await fx.fail('401 invalid api key');assert.equal(fx.lookups(),0);assert.equal(fx.ctx.model.provider,'direct');await fx.emit('session_shutdown');
 fx=await fixture();
 await fx.fail('429 account quota exceeded');
 assert.equal(fx.lookups(),0);assert.equal(fx.ctx.model,base,'first transient failure waits on the primary route');
 await fx.fail('429 account quota exceeded');
 assert.equal(fx.ctx.model,base,'second transient failure waits on the primary route');
 assert.equal((await fx.fail('429 account quota exceeded')).decision,'retry');assert.equal(fx.ctx.model.provider,'direct','third consecutive failure switches routes');
 await fx.emit('session_shutdown');
 fx=await fixture({getEndpoints:async()=>{throw Error('catalog unavailable');}});
 await fx.fail();assert.equal(fx.ctx.model,base,'endpoint outage without a catalog still waits twice');
 await fx.fail();assert.equal(fx.ctx.model,base);
 assert.equal((await fx.fail()).decision,'retry');assert.equal(fx.ctx.model.provider,'direct');
 await fx.emit('session_shutdown');
 // Gate denials wait out the shared cooldown; they never move the session.
 fx=await fixture();
 const denial='429 rate limit: provider-gate cannot safely attribute model lab/future-v2; candidate openrouter/lab/future-v2 is cooling (25s; state: provider-health.json)';
 await fx.fail(denial);await fx.fail(denial);
 assert.equal((await fx.fail(denial)).decision,'retry');assert.equal(fx.ctx.model,base,'gate denials never switch the session model');
 assert.equal(fx.selected.length,0);
 await fx.emit('session_shutdown');
 // The automatic-route marker must be visible while model_select fires, or
 // last-model.ts persists the recovery route as the user's default.
 fx=await fixture();
 const seenMarkers=[];
 const nativeSetModel=fx.pi.setModel;
 fx.pi.setModel=async model=>{const marker=(globalThis)[Symbol.for('yunus-pi.automatic-route.v1')];seenMarkers.push(typeof marker==='function'?marker():undefined);return nativeSetModel(model);};
 await fx.fail('401 invalid api key');
 assert.equal(fx.ctx.model.provider,'direct');
 assert.deepEqual(seenMarkers,['direct/lab/future-v2'],'automatic route is marked before the switch fires model_select');
 await fx.emit('session_shutdown');
 // A thrown switch pauses recovery and must not leak the marker: a later
 // manual choice of the same route has to persist as the user default.
 fx=await fixture();
 fx.pi.setModel=async()=>{throw Error('transcript unavailable');};
 assert.equal((await fx.fail('401 invalid api key')).decision,'pause');
 assert.equal((globalThis)[Symbol.for('yunus-pi.automatic-route.v1')](),undefined,'thrown switch clears the automatic marker');
 await fx.emit('session_shutdown');
 fx=await fixture();assert.equal((await fx.fail('content filter: upstream unavailable')).decision,'pause');assert.equal(fx.selected.length,0);assert.equal(fx.lookups(),0);await fx.emit('session_shutdown');
 let waitStarted=false;
 const abortableWait=(_ms,signal)=>new Promise((resolve,reject)=>{
  waitStarted=true;
  const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('Cancelled'));};
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
 fx=await fixture({models:[base],getEndpoints:async()=>[],wait:abortableWait});
 const settling=fx.fail('500 server error');
 while(!waitStarted)await Promise.resolve();
 await fx.emit('agent_settled');
 await settling;
 assert.equal(fx.entries.filter(e=>e.type==='provider-recovery').length,1,'settlement invalidates an in-flight recovery before its abort rejection can publish stale status');
 await fx.emit('session_shutdown');
 let release;fx=await fixture({getEndpoints:()=>new Promise(r=>release=r)});const pending=fx.fail();while(!release)await Promise.resolve();await fx.emit('model_select',{source:'user',model:base});release(endpoints);await pending;assert.equal(fx.selected.length,0,'manual selection cancels stale catalog continuation');await fx.emit('session_shutdown');
 // Manual selection of the original route during asynchronous auth must also
 // win over a stale temporary pin with that very same provider/model id.
 fx=await fixture();let finishSelection;const nativeSet=fx.pi.setModel;fx.pi.setModel=async m=>{if(m.compat?.recoveryEndpointName)await new Promise(resolve=>finishSelection=resolve);return nativeSet(m);};
 const changing=fx.fail();while(!finishSelection)await Promise.resolve();await fx.emit('model_select',{source:'user',model:base});finishSelection();await changing;assert.equal(fx.ctx.model,base);await fx.emit('session_shutdown');
 // Run the real gate hook against the temporary routing object: a different
 // upstream is allowed but an account-wide cooldown still blocks before send.
 fx=await fixture();await fx.fail();registerGate(fx.pi);
 let payload={model:base.id,provider:fx.ctx.model.compat.openRouterRouting,messages:[]};
 await fx.emit('before_provider_request',{payload});
 await fx.emit('message_end',{message:{role:'assistant',provider:base.provider,model:base.id,stopReason:'error',content:[],errorMessage:'500 server error'}});
 assert.equal(h.evaluateRoute({provider:base.provider,model:base.id,endpoints:['Host b']}).allowed,false);
 assert.equal(h.evaluateRoute({provider:base.provider,model:base.id,endpoints:['Host c']}).allowed,true);
 await fx.emit('session_shutdown');
 console.log('PASS adaptive recovery: upstream isolation, historical ranking, catalog admission, request gate, bounded escalation, constraints, cancellation and restoration');
} finally {globalThis.fetch=network;fs.rmSync(dir,{recursive:true,force:true});}
