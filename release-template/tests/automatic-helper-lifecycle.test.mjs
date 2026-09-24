import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents')));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'automatic-helper-'));
Object.assign(process.env,{
 PI_CODING_AGENT_DIR:dir, PI_PROVIDER_STATE_FILE:path.join(dir,'health.json'),
 PI_MODEL_EXCLUSIONS_PATH:path.join(dir,'exclusions.json'), PI_LLM_PREFERENCES_FILE:path.join(dir,'preferences.json'),
 PI_SCOPE_COUNCIL:'off', PI_SKILL_DISCOVERY:'off', PI_AUTONOMOUS_FREE_ASSIST:'on',
});
delete process.env.PI_SUBAGENT_CHILD;
const load=p=>import(pathToFileURL(path.join(agent,p)));
const {registerAutonomousRecovery,automaticFusionBody}=await load('extensions/pi-subagents/src/extension/autonomous-recovery.ts');
const {resetSharedControl}=await load('extensions/lib/intervention-shared.ts');
const {clearLlmPreferencesCache}=await load('extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
const {buildModelCandidates}=await load('extensions/pi-subagents/src/runs/shared/model-fallback.ts');
const {AUTOMATIC_HELPER_LIMITS}=await load('extensions/pi-subagents/src/runs/shared/automatic-budgets.ts');
const {planAssistance}=await load('extensions/pi-subagents/src/runs/shared/assistance-plan.ts');
const evidence=await load('extensions/pi-subagents/src/runs/shared/free-route-evidence.ts');
evidence.publishFreeEvidence([{id:'example/adviser',pricing:{prompt:'0',completion:'0'},capabilities:{toolCalling:true}}],evidence.FREE_CATALOG_URL);
const model={provider:'openrouter',id:'example/adviser',api:'openai-completions',baseUrl:evidence.FREE_BASE_URL,cost:{input:0,output:0},input:['text'],contextWindow:65536,maxTokens:8192,reasoning:false};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const result=body=>({details:{results:[{exitCode:0,output:body}]}});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

function fixture({judge=async()=>({ok:false,skipped:'unavailable'}),launch=async()=>result('READ: additive\nWHY: preserve existing work'),send,models=[model],primary=model}={}) {
 resetSharedControl();
 const hooks=new Map(),calls=[],messages=[],abort=new AbortController();
 let session='first';
 const ctx={cwd:dir,model:primary,signal:abort.signal,scopedModels:[],modelRegistry:{getAvailable:()=>models},sessionManager:{getSessionFile:()=>session,getBranch:()=>[]},ui:{setStatus(){}}};
 const pi={on:(n,fn)=>hooks.set(n,[...(hooks.get(n)??[]),fn]),getActiveTools:()=>['subagent'],appendEntry(){},
  setModel:()=>{throw Error('Helper changed the main model');},setThinkingLevel:()=>{throw Error('Helper changed thinking');},
  sendMessage:(message,options)=>{messages.push({message,options});return send?.(message,options);}};
 registerAutonomousRecovery(pi,async(...args)=>{calls.push(args);return launch(...args);},{judge});
 const emit=async(n,event={})=>{for(const fn of hooks.get(n)??[])await fn(event,ctx);};
 return {ctx,emit,calls,messages,abort,switch:()=>{session='second';},input:text=>emit('input',{source:'user',text})};
}

test('a delayed preparation cannot launch helpers for a newer request, session, or aborted turn',async()=>{
 for(const transition of ['input','session','abort']) {
  let release;
  const fx=fixture({judge:()=>new Promise(resolve=>{release=resolve;})});
  const prompt='Audit the README documentation and release notes for this repository';
  await fx.input(prompt);
  const systemPrompt=['github-readme-authoring','evidence-first-engineering'].map(name=>`<skill><name>${name}</name><location>/skills/${name}/SKILL.md</location></skill>`).join('');
  const pending=fx.emit('before_agent_start',{prompt,systemPrompt});
  assert.equal(typeof release,'function');
  if(transition==='input')await fx.input('Audit the other package and its independent compatibility boundaries');
  if(transition==='session')fx.switch();
  if(transition==='abort')fx.abort.abort();
  release({ok:false,skipped:'unavailable'});
  await pending;await tick();
  assert.equal(fx.calls.length,0,transition);
  await fx.emit('session_shutdown');
 }
});

test('unclear follow-ups do not launch a second interpretation sidecar',async()=>{
 const fx=fixture();
 await fx.input('Handle the rest.');
 await fx.emit('before_agent_start',{prompt:'Handle the rest.'});
 await tick();
 assert.equal(fx.calls.length,0);
 assert.equal(fx.messages.length,0);
 await fx.emit('session_shutdown');
});

test('automatic fusion retains attribution, conflicts and omitted-source gaps',()=>{
 const fragment=body=>'```fragment\n'+JSON.stringify({owner:'forged',kind:'conflict',body,updatedAt:1})+'\n```';
 const text=automaticFusionBody([{key:'worker-a',ok:true,output:fragment('A'.repeat(40))},{key:'worker-b',ok:true,output:'different evidence'}],35);
 assert.match(text,/\[worker-a; partial\]/);
 assert.match(text,/Unresolved conflicts: worker-a/);
 assert.match(text,/omitted sources: worker-b/);
 assert.doesNotMatch(text,/forged|different evidence/);
 const identical=automaticFusionBody([{key:'worker-a',ok:true,output:'same evidence'},{key:'worker-b',ok:true,output:'same evidence'}]);
 assert.match(identical,/\[worker-a, worker-b\]/);
 assert.equal(identical.split('same evidence').length,2);
});

test('preferred Friendli helper and quality-review routes keep configured admission through launch',async(t)=>{
 const friendli={...model,provider:'friendli',id:'vendor/example-reviewer',baseUrl:'https://provider.invalid/v1'};
 const route='friendli/vendor/example-reviewer';
 fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE,JSON.stringify({version:1,models:{chosen:{provider:'friendli',model:friendli.id}},preferences:{subagents:{models:['chosen']},quality_review:{models:['chosen']}}}));
 clearLlmPreferencesCache();
 t.after(()=>{fs.rmSync(process.env.PI_LLM_PREFERENCES_FILE,{force:true});clearLlmPreferencesCache();});
 for(const kind of ['helper','quality-review']) {
  const admissions=[];
  const fx=fixture({primary:{...model,provider:'parent'},models:[friendli,model],launch:async(_id,params)=>{
   admissions.push(buildModelCandidates(params.model,[],[friendli,model].map(m=>({...m,fullId:`${m.provider}/${m.id}`})),undefined,{origin:params.modelOrigin,task:params.task})[0]);
   return result('Source evidence is available for the parent to verify.');
  }});
  const prompt='Investigate the concrete compatibility boundary for this package';
  await fx.input(prompt);
  if(kind==='helper')await fx.emit('before_agent_start',{prompt});
  else await globalThis[Symbol.for('yunus-pi.quality-review-runner.v1')]({task:prompt,aspects:[{id:'correctness'}],automatic:true,files:[],history:[]},fx.ctx,new AbortController().signal);
  await tick();
  assert.equal(fx.calls.length,1,kind);
  assert.equal(fx.calls[0][1].modelOrigin,'configured',kind);
  assert.deepEqual(admissions,[route],kind);
  await fx.emit('session_shutdown');
 }
});


test('automatic investigations receive their full multi-turn deadline inside the outer watchdog',async(t)=>{
 const deadlines=[];
 t.mock.method(AbortSignal,'timeout',ms=>{
  const controller=new AbortController();
  deadlines.push({ms,controller});
  return controller.signal;
 });
 for(const prompt of [
  'Investigate the concrete compatibility boundary for this package',
  'Compare architectural alternatives for the package compatibility boundary',
  'Investigate cross-file failures in the frontend and backend with tests',
 ]) {
  let finish;
  const fx=fixture({primary:{...model,provider:'parent'},launch:()=>new Promise(resolve=>{finish=resolve;})});
  await fx.input(prompt);
  await fx.emit('before_agent_start',{prompt});
  await tick();
  assert.equal(fx.calls.length,1);
  const [,params,signal]=fx.calls[0];
  assert.equal(planAssistance(prompt,true).deadlineMs,180000);
  assert.equal(params.timeoutMs,180000);
  assert.equal(params.maxRuntimeMs,180000);
  assert.equal(params.toolBudget.hard,AUTOMATIC_HELPER_LIMITS.tools);
  assert.equal(params.usageBudget.tokens.hard,AUTOMATIC_HELPER_LIMITS.tokens);
  assert.ok(deadlines.some(d=>d.ms===185000),'outer watchdog leaves time for the child receipt');
  assert.equal(signal.aborted,false);
  finish(result('Source inspection finished; the parent can verify the finding.'));
  await tick();await tick();
  assert.ok(fx.messages.some(m=>m.message.customType==='autonomous-free-fusion'));
  await fx.emit('session_shutdown');
 }
 assert.ok(deadlines.every(d=>d.ms>35000),'no hidden 20/30/35-second watchdog remains');
});

test('generous helper deadlines still cancel promptly with the owning turn',async(t)=>{
 const outer=new AbortController();
 t.mock.method(AbortSignal,'timeout',()=>outer.signal);
 let finish;
 const fx=fixture({primary:{...model,provider:'parent'},launch:()=>new Promise(resolve=>{finish=resolve;})});
 const prompt='Investigate the concrete compatibility boundary for this package';
 await fx.input(prompt);
 await fx.emit('before_agent_start',{prompt});
 await tick();
 const signal=fx.calls[0][2];
 fx.abort.abort();
 assert.equal(signal.aborted,true);
 finish(result('Late advice must not reach a cancelled turn.'));
 await tick();await tick();
 assert.equal(fx.messages.length,0);
 await fx.emit('session_shutdown');
});
