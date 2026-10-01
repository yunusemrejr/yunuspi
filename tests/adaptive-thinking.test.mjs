import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecution, createAdaptiveThinkingController } from '../agent/extensions/lib/adaptive-execution.ts';

const direct=classifyExecution({task:'Fix a typo'}),standard=classifyExecution({task:'Investigate the parser failure'}),complex=classifyExecution({task:'Migrate cross-file source'});
function fixture(initial='high',options={}) {
  let level=initial;const setters=[],events=[];
  const ctx={cwd:'/project',sessionManager:{getSessionId:()=>'/session'},model:{reasoning:true}};
  const pi={getThinkingLevel:()=>level,setThinkingLevel(next){const previousLevel=level;level=next;setters.push(next);events.push({level:next,previousLevel});}};
  const controller=createAdaptiveThinkingController(pi,{argv:[],env:{},...options});
  const flush=()=>{for(const event of events.splice(0))controller.onSelection(event,ctx);};
  return {ctx,controller,pi,setters,events,flush,get:()=>level,manual(next){const previousLevel=level;level=next;controller.onSelection({level:next,previousLevel},ctx);}};
}

test('main reasoning follows changing scope difficulty and restores its configured ceiling',()=>{
  const f=fixture();f.controller.begin(f.ctx);
  assert.equal(f.controller.update(direct,f.ctx),'minimal');f.flush();
  assert.equal(f.controller.update(direct,f.ctx),'minimal');assert.equal(f.setters.length,1,'unchanged scope does not append another thinking mutation');
  assert.equal(f.controller.update(standard,f.ctx),'low');f.flush();
  assert.equal(f.controller.update(complex,f.ctx),'high');f.flush();
  f.controller.update(direct,f.ctx);f.flush();assert.equal(f.controller.restore(f.ctx),'high');f.flush();
  assert.equal(f.controller.state().manual,false);assert.equal(f.controller.state().ceiling,'high');
});

test('CLI thinking pins, model suffix pins, explicit off and configured ceilings stay intact',()=>{
  for(const argv of [['--thinking','high'],['--thinking=high'],['--model','provider/model:high'],['--model=provider/model:high']]) {
    const f=fixture('high',{argv});f.controller.update(direct,f.ctx);assert.equal(f.get(),'high');assert.equal(f.setters.length,0);
  }
  const off=fixture('off');off.controller.update(complex,off.ctx);assert.equal(off.get(),'off');assert.equal(off.setters.length,0);
  const capped=fixture('low');capped.controller.update(complex,capped.ctx);assert.equal(capped.get(),'low');
  capped.controller.update(direct,capped.ctx);assert.equal(capped.get(),'minimal');capped.controller.restore(capped.ctx);assert.equal(capped.get(),'low');
});

test('manual selections win over automatic changes, including delayed own selection events',()=>{
  const f=fixture();f.controller.update(direct,f.ctx);
  f.manual('medium');f.flush();
  assert.equal(f.controller.update(complex,f.ctx),'medium');assert.equal(f.controller.restore(f.ctx),'medium');
  f.controller.begin(f.ctx);f.controller.update(direct,f.ctx);assert.equal(f.get(),'medium','manual preference persists into later task scopes');
});

test('ultra defaults adapt and restore, while ultra CLI pins and later manual selections remain exact',()=>{
  const f=fixture('ultra');f.ctx.model.thinkingLevelMap={ultra:'ultra'};
  assert.equal(f.controller.update(direct,f.ctx),'minimal');f.flush();
  assert.equal(f.controller.restore(f.ctx),'ultra');f.flush();
  assert.equal(f.controller.state().manual,false);
  for(const argv of [['--model','provider/model:ultra'],['-m','provider/model:ultra'],['--model=provider/model:ultra']]) {
    const pinned=fixture('ultra',{argv});pinned.controller.update(direct,pinned.ctx);
    assert.equal(pinned.get(),'ultra');assert.equal(pinned.setters.length,0);
  }
  f.controller.update(direct,f.ctx);f.flush();f.manual('ultra');
  assert.equal(f.controller.update(direct,f.ctx),'ultra');assert.equal(f.controller.restore(f.ctx),'ultra');
});

test('an externally changed setting without an event is preserved on update and restore',()=>{
  const f=fixture();f.controller.update(direct,f.ctx);f.flush();
  f.pi.setThinkingLevel('off');
  assert.equal(f.controller.restore(f.ctx),'off');assert.equal(f.controller.update(complex,f.ctx),'off');
});

test('a replacement session cannot receive the prior session restoration',()=>{
  const f=fixture();f.controller.update(direct,f.ctx);f.flush();
  const next={...f.ctx,sessionManager:{getSessionId:()=>'/next'}};f.pi.setThinkingLevel('low');f.events.length=0;
  assert.equal(f.controller.restore(next),'low');f.controller.begin(next);
  assert.equal(f.controller.state().ceiling,'low');assert.equal(f.controller.update(complex,next),'low');
});

test('unsupported effort levels stay within actual model levels and adaptive rollback restores the default',()=>{
  const env={};const f=fixture('high',{env});f.ctx.model.thinkingLevelMap={off:null,minimal:null,low:'enabled',medium:null,high:'enabled',xhigh:null,max:null};
  assert.equal(f.controller.update(direct,f.ctx),'low');f.flush();
  env.PI_ADAPTIVE_EXECUTION='off';assert.equal(f.controller.update(complex,f.ctx),'high');f.flush();
  assert.equal(f.controller.state().manual,false);
});

test('missing or failing native thinking controls never prevent task execution',()=>{
  const ctx={sessionManager:{getSessionId:()=>'/fixture'}};
  assert.equal(createAdaptiveThinkingController({},{argv:[]}).update(complex,ctx),undefined);
  const f=fixture();f.pi.setThinkingLevel=()=>{throw Error('model changing');};assert.equal(f.controller.update(direct,f.ctx),'high');
});
