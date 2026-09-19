import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..'), path.resolve(root, '../..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/lib/stall-core.ts')));
assert.ok(agent);
const {createLoopTracker} = await import(pathToFileURL(path.join(agent, 'extensions/lib/stall-core.ts')));
const read = (file, text=file) => ({toolName:'read', input:{path:file}, isError:false, content:[{type:'text', text}]});
const turn = (tracker, events) => {for (const event of events) tracker.record(event); return tracker.finishTurn();};
const repeat = (tracker, cycle, times=4) => {for(let i=0;i<times;i++) for(const events of cycle) turn(tracker, events);};

test('exact two/three-turn inspection cycles require four complete repetitions', () => {
  for (const period of [2,3]) {
    const tracker = createLoopTracker();
    const cycle = Array.from({length:period}, (_,i) => [read(`private-fixture-${i}`)]);
    for(let i=0;i<period*4;i++) {
      for(const [event] of cycle) assert.equal(tracker.block(event), undefined);
      turn(tracker, cycle[i%period]);
    }
    for(const [event] of cycle) {
      const reason = tracker.block(event);
      assert.match(reason, new RegExp(`${period}-turn observation cycle repeated four times`));
      assert.doesNotMatch(reason, /private-fixture/);
    }
    assert.equal(tracker.block(read('new-file')), undefined);
    assert.equal(tracker.block({...cycle[0][0], input:{...cycle[0][0].input, offset:2}}), undefined);
    assert.equal(tracker.block({toolName:'grep', input:{pattern:'new evidence'}}), undefined);
  }
});

test('parallel batches count once per turn regardless of completion order', () => {
  const tracker = createLoopTracker(), batch = [read('a'),read('b')];
  for(let i=0;i<3;i++) {
    turn(tracker, i%2 ? [...batch].reverse() : batch);
    assert.equal(tracker.block(batch[0]), undefined);
  }
  turn(tracker, [...batch].reverse());
  assert.match(tracker.block(batch[0]), /strategy-change-required/);
  assert.match(tracker.block(batch[1]), /strategy-change-required/);
  // Parallel siblings with different evidence for the same input prove change.
  turn(tracker, [read('a'),read('a','updated')]);
  assert.equal(tracker.block(batch[0]), undefined);
  assert.equal(tracker.block(batch[1]), undefined);
});

test('changing results, productive actions, waits and incomplete evidence release the cycle', () => {
  const cycle = [[read('a')],[read('b')]];
  for(const progress of [
    read('a','new result'), read('new-file'),
    {...read('a'),toolName:'write'},
    {...read('a'),toolName:'bash',details:{deduplicated:true}},
    {...read('a'),toolName:'process',input:{action:'wait'}},
    {...read('a'),toolName:'subagent',input:{action:'status'},isError:true},
    {...read('a'),toolName:'todo',input:{action:'update'}},
    read('a','x'.repeat(100_000)),
    {...read('a'),content:[{type:'image',data:'synthetic',mimeType:'image/png'}]},
  ]) {
    const tracker=createLoopTracker(); repeat(tracker,cycle);
    assert.ok(tracker.block(read('a')));
    turn(tracker,[progress]);
    assert.equal(tracker.block(read('a')),undefined,progress.toolName);
    assert.equal(tracker.block(read('b')),undefined,progress.toolName);
  }
  const changing=createLoopTracker();
  for(let i=0;i<24;i++) turn(changing,[read('a',`live value ${i%2}`)]);
  assert.equal(changing.block(read('a')),undefined,'periodic live data is changed evidence');
  const wide=createLoopTracker();
  repeat(wide,[Array.from({length:17},(_,i)=>read(`file-${i}`))]);
  assert.equal(wide.block(read('file-0')),undefined,'oversized batches abstain');
});

test('observation receipts compare original evidence while guard errors do not reset it', () => {
  const tracker=createLoopTracker();
  for(let i=0;i<8;i++) {
    const event=read(i%2?'b':'a',`observation receipt ${i}`);
    event.details={observationResultHash:(i%2?'b':'a').repeat(64)};
    turn(tracker,[event]);
  }
  const reason=tracker.block(read('a'));
  assert.ok(reason);
  turn(tracker,[{...read('a',reason),isError:true}]);
  assert.ok(tracker.block(read('a')));
  turn(tracker,[{...read('a'),details:{observationResultHash:'c'.repeat(64)}}]);
  assert.equal(tracker.block(read('b')),undefined);
});

test('native reminder hooks share one nudge and reset cycle enforcement on user/lifecycle boundaries', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pi-loop-cycle-'));
  const priorHome=process.env.HOME; process.env.HOME=home;
  try {
    const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/reminders.ts')));
    const hooks=new Map(), sent=[];
    const ctx={cwd:home,sessionManager:{getSessionId:()=> 'loop-cycle',getBranch:()=> []},ui:{notify(){}}};
    register({on:(name,fn)=>{const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);},registerCommand(){},sendMessage:m=>sent.push(m)});
    const emit=async(name,event={})=>{let result;for(const fn of hooks.get(name)??[])result=await fn(event,ctx)??result;return result;};
    await emit('session_start',{reason:'startup'}); await emit('agent_start');
    const exercise=async()=>{for(let i=0;i<8;i++) {const result=read(i%2?'b':'a'); await emit('tool_result',result); await emit('turn_end',{message:{role:'assistant',stopReason:'toolUse',content:[]},toolResults:[result]});}};
    await exercise();
    assert.equal((await emit('tool_call',read('a')))?.block,true);
    assert.equal(sent.filter(m=>m.content.includes('loop-check')).length,1);
    await emit('input',{source:'extension'});
    assert.equal((await emit('tool_call',read('a')))?.block,true);
    for(const [name,event] of [
      ['input',{source:'interactive'}],['session_compact',{}],['session_tree',{}],['model_select',{}],
      ['turn_end',{message:{role:'assistant',stopReason:'aborted'},toolResults:[read('a')]}],
    ]) {
      await emit(name,event);
      assert.equal(await emit('tool_call',read('a')),undefined,name);
      await exercise();
      assert.equal((await emit('tool_call',read('b')))?.block,true,name);
    }
  } finally {
    if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;
    fs.rmSync(home,{recursive:true,force:true});
  }
});
