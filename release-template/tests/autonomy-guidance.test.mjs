import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..'),path.resolve(root,'../..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/relevant-guidance.ts')));
const load=p=>import(pathToFileURL(path.join(agent,'extensions',p)));
const {createRelevantGuidance}=await load('lib/relevant-guidance.ts');
const {matchHook}=await load('lib/session-hooks.ts');
const {default:registerHooks}=await load('session-hooks.ts');
function fixture(active=['read','write']){
  const entries=[],ctx={cwd:'/autonomy/workspace',sessionManager:{getBranch:()=>entries}};
  const g=createRelevantGuidance({getActiveTools:()=>active,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  g.restore(ctx);
  return {g,start(prompt){g.userInput();g.start({prompt,systemPrompt:''},ctx);},step(toolName,input,isError=false){g.record({toolName,input,isError});},take(){const hints=g.candidates();assert.ok(hints.length<=2);g.commit(hints);return hints;}};
}


test('non-actionable, quoted, negated and disabled requests do not acquire domain tool hints',()=>{
  for(const prompt of ['Explain SVG filters','What is WebGPU?','> Inspect the host environment','```\nBuild SVG artwork\n```','Do not inspect SVG','Optimize WebGPU without tools']){
    const f=fixture();f.start(prompt);assert.ok(!f.g.candidates().some(h=>h.tool),prompt);
  }
  const f=fixture();f.start('Update assets without tools');f.step('write',{path:'icon.svg',content:'<svg/>'});assert.equal(f.g.candidates().length,0);
});

test('first-use hooks distinguish operations and failures without repeating on each result',t=>{
  const old=process.env.PI_SESSION_HOOKS;delete process.env.PI_SESSION_HOOKS;
  t.after(()=>{if(old===undefined)delete process.env.PI_SESSION_HOOKS;else process.env.PI_SESSION_HOOKS=old;});
  const handlers=new Map();registerHooks({on:(name,handler)=>handlers.set(name,handler)});
  let nextId=0;
  const call=(toolName,input,isError=false)=>{
    const toolCallId=String(++nextId),event={toolName,input,toolCallId,isError,content:[{type:'text',text:'fixture result'}]};
    handlers.get('tool_call')(event);return handlers.get('tool_result')(event);
  };
  const edit={path:'src/Screen.tsx'};
  assert.equal(matchHook('edit',edit)?.key,'ui-first-render');
  assert.equal(matchHook('edit',{path:'docs/notes.md'}),null,'an operation outside the rule scope stays quiet');
  assert.equal(call('edit',edit,true),undefined,'failed attempt does not consume successful first use');
  const first=call('edit',edit);assert.equal(first.content.length,2);assert.match(first.content[1].text,/session-hooks/);
  assert.equal(call('edit',edit),undefined,'exactly once per hook key');
  handlers.get('session_switch')();assert.ok(call('edit',edit),'new session gets its own receipt');
  handlers.get('session_switch')();process.env.PI_SESSION_HOOKS='off';assert.equal(call('edit',edit),undefined);
});

test('browser recovery follows the observed dispatch outcome without inventing a possible submission',()=>{
 const handlers=new Map();registerHooks({on:(name,handler)=>handlers.set(name,handler)});
 const run=(id,details,text)=>{
  const event={toolCallId:id,toolName:'browser_session',input:{action:'click',session:'missing'},isError:true,details,content:[{type:'text',text}]};
  handlers.get('tool_call')(event);return handlers.get('tool_result')(event);
 };
 const validation={failure:{outcome:'not-dispatched',kind:'unknown-session',nextStep:'Use the handle returned by open.'}};
 assert.equal(run('validation',validation,'Unknown browser session'),undefined);
 assert.equal(matchHook('browser_session',{action:'click'},true,{details:validation,content:[{type:'text',text:'timeout named session is unknown'}]}).key,'browser-session-read-recovery');
 const uncertain=run('timeout',{failure:{outcome:'unknown'}},'Click timed out');
 assert.match(uncertain.content.at(-1).text,/reconcile|Reconcile/);
 assert.match(uncertain.content.at(-1).text,/successful post/);
 assert.equal(run('timeout-again',{failure:{outcome:'unknown'}},'Click timed out'),undefined,'actual uncertainty is still once per session');
});

test('browser recovery follows the observed failure outcome and stays quiet on success', () => {
 const handlers = new Map(); registerHooks({ on: (name, handler) => handlers.set(name, handler) });
 let id = 0;
 const result = (toolName, isError, text, details) => {
  const event = { toolCallId: String(++id), toolName, input: { action: 'click' }, isError, content: [{ type: 'text', text }], details };
  handlers.get('tool_call')(event); return handlers.get('tool_result')(event);
 };
 assert.equal(result('browser_session', false, 'Clicked'), undefined, 'successful actions get no recovery guidance');
 assert.ok(result('browser_session', true, 'Invalid selector'), 'generic first-use failure guidance');
 const timeout = result('browser_session', true, 'Browser action timed out');
 assert.match(timeout?.content.at(-1).text ?? '', /uncertain action/);
});
