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
function fixture(active=['sys_probe','artifact_check','math_check','read','write']){
  const entries=[],ctx={cwd:'/autonomy/workspace',sessionManager:{getBranch:()=>entries}};
  const g=createRelevantGuidance({getActiveTools:()=>active,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
  g.restore(ctx);
  return {g,start(prompt){g.userInput();g.start({prompt,systemPrompt:''},ctx);},step(toolName,input,isError=false){g.record({toolName,input,isError});},take(){const hints=g.candidates();assert.ok(hints.length<=2);g.commit(hints);return hints;}};
}

test('host, SVG and frame-budget intent discovers concrete operations with bounded hints',()=>{
  for(const [prompt,tool,expected]of [
    ['Inspect the host environment','sys_probe',/action:"host"/],
    ['Configure ESP32 firmware tooling','sys_probe',/action:"devices"/],
    ['Build SVG artwork','artifact_check',/operation:"svg"/],
    ['Measure WebGPU frame pacing','math_check',/frame_budget/],
  ]){
    const f=fixture();f.start(prompt);const hints=f.take();assert.ok(hints.some(h=>h.tool===tool&&expected.test(h.text)),prompt);
    assert.ok(hints.every(h=>h.text.length<1000),'no catalog or long checklist');
    f.step(tool,tool==='sys_probe'?{action:'host'}:tool==='artifact_check'?{operation:'svg'}:{operation:'frame_budget'});
    assert.ok(!f.g.candidates().some(h=>h.tool===tool),'successful use suppresses general discovery');
    const unavailable=fixture(['read','write']);unavailable.start(prompt);assert.ok(!unavailable.g.candidates().some(h=>h.tool===tool),'child tool ceiling remains authoritative');
  }
});

test('non-actionable, quoted, negated and disabled requests do not acquire domain tool hints',()=>{
  for(const prompt of ['Explain SVG filters','What is WebGPU?','> Inspect the host environment','```\nBuild SVG artwork\n```','Do not inspect SVG','Optimize WebGPU without tools']){
    const f=fixture();f.start(prompt);assert.ok(!f.g.candidates().some(h=>h.tool),prompt);
  }
  for(const [file,isError]of [['icon.svg',true],['vendor/icon.svg',false],['fixtures/icon.svg',false]]){
    const f=fixture();f.start('Update the asset');f.step('write',{path:file,content:'<svg/>'},isError);
    assert.ok(!f.g.candidates().some(h=>/SVG changed/.test(h.text)),file);
  }
  const f=fixture();f.start('Update assets without tools');f.step('write',{path:'icon.svg',content:'<svg/>'});assert.equal(f.g.candidates().length,0);
  const child=fixture(['read','write']);child.start('Update the asset');child.step('write',{path:'icon.svg',content:'<svg/>'});
  assert.ok(!child.g.candidates().some(h=>/SVG changed/.test(h.text)),'source evidence does not advertise a tool outside the child ceiling');
});

test('a newly saved SVG keeps its evidence cue after unrelated artifact inspection or discovery delivery',()=>{
  for(const consumeHint of [false,true]){
    const f=fixture();f.start('Create SVG artwork');if(consumeHint)f.take();
    f.step('artifact_check',{operation:'image',path:'reference.png'});
    f.step('write',{path:'logo.svg',content:'<svg/>'});
    assert.ok(f.g.candidates().some(h=>/SVG changed/.test(h.text)),'fresh authored source is independent of generic tool-discovery receipts');
    f.take();f.step('write',{path:'logo.svg',content:'<svg viewBox="0 0 24 24"/>'});
    assert.ok(!f.g.candidates().some(h=>/SVG changed/.test(h.text)),'fresh-source cue remains bounded after delivery');
  }
});

test('pending SVG source evidence follows tool availability and an exact successful file check',()=>{
  const active=['artifact_check','read','write'],f=fixture(active);f.start('Update the logo');
  const pending=()=>f.g.candidates().some(h=>h.key==='signal:svg-source-evidence');
  f.step('write',{path:'logo.svg',content:'<svg/>'});assert.ok(pending());
  active.splice(active.indexOf('artifact_check'),1);assert.equal(pending(),false,'deactivated tool is not advertised');
  active.push('artifact_check');assert.ok(pending(),'restoring availability preserves an unresolved check');
  f.step('artifact_check',{operation:'image',path:'logo.svg'});assert.ok(pending(),'different operation is not evidence');
  f.step('artifact_check',{operation:'svg',path:'other.svg'});assert.ok(pending(),'another file is not evidence');
  f.step('artifact_check',{operation:'svg',text:'<svg/>'});assert.ok(pending(),'inline text is not saved-file evidence');
  f.step('artifact_check',{operation:'svg',path:'logo.svg'},true);assert.ok(pending(),'failed inspection is not evidence');
  f.step('artifact_check',{operation:'svg',path:'/autonomy/workspace/logo.svg'});assert.equal(pending(),false,'successful same-path inspection satisfies this source cue');
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
  for(const [tool,input,key]of [['sys_probe',{action:'host'},'host-device-preflight'],['artifact_check',{operation:'svg'},'svg-source-evidence'],['math_check',{operation:'frame_budget'},'graphics-budget-evidence']]){
    assert.equal(matchHook(tool,input)?.key,key);
    assert.equal(call(tool,input,true),undefined,'failed attempt does not consume successful first use');
    const first=call(tool,input);assert.equal(first.content.length,2);assert.match(first.content[1].text,/session-hooks/);
    assert.equal(call(tool,input),undefined,'exactly once per hook key');
  }
  assert.equal(matchHook('artifact_check',{operation:'image'}),null);
  assert.equal(matchHook('math_check',{operation:'summarize'}),null);
  assert.equal(call('sys_probe',{action:'devices'}),undefined,'host/device pair shares the contract receipt');
  assert.equal(call('math_check',{operation:'render_budget'}),undefined,'frame/memory pair shares the contract receipt');
  handlers.get('session_switch')();assert.ok(call('artifact_check',{operation:'svg'}),'new session gets its own receipt');
  handlers.get('session_switch')();process.env.PI_SESSION_HOOKS='off';assert.equal(call('artifact_check',{operation:'svg'}),undefined);
});
