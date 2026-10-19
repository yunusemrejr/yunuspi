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

const GENTLE_REPEAT = '[repeat-check] You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.';
const repeatCall = (toolName, input, text='ok', isError=false) => ({toolName, input, isError, content:[{type:'text', text}]});

test('consecutive identical calls: gentle at 3, detailed at 5 and 8, silent otherwise', () => {
  const tracker = createLoopTracker();
  const out = Array.from({length:9}, () => tracker.repeatNotice(repeatCall('read', {path:'a.txt'})));
  assert.deepEqual(out.slice(0,2), [undefined, undefined]);
  assert.equal(out[2], GENTLE_REPEAT);
  assert.equal(out[3], undefined);
  assert.match(out[4], /^\[repeat-check\] Repeated tool call detected:\n- tool: read\n- consecutive_calls: 5\n- arguments: \{"path":"a\.txt"\}\nThe repeated calls are not making progress\. /);
  assert.equal(out[5], undefined);
  assert.equal(out[6], undefined);
  assert.match(out[7], /^\[repeat-check\] Repeated tool call detected:\n- tool: read\n- consecutive_calls: 8\n/);
  assert.equal(out[8], undefined);
});

test('repeat identity ignores object key order but respects array order', () => {
  const tracker = createLoopTracker();
  assert.equal(tracker.repeatNotice(repeatCall('edit', {a:1, b:{x:1, y:2}})), undefined);
  assert.equal(tracker.repeatNotice(repeatCall('edit', {b:{y:2, x:1}, a:1})), undefined);
  assert.equal(tracker.repeatNotice(repeatCall('edit', {a:1, b:{x:1, y:2}})), GENTLE_REPEAT);
  const arrays = createLoopTracker();
  assert.equal(arrays.repeatNotice(repeatCall('edit', {list:[1, 2]})), undefined);
  assert.equal(arrays.repeatNotice(repeatCall('edit', {list:[2, 1]})), undefined);
});

test('an intervening different call resets the repeat chain', () => {
  const tracker = createLoopTracker();
  const A = repeatCall('read', {path:'a'}), B = repeatCall('read', {path:'b'});
  assert.deepEqual([A, A, B, A, A].map((event) => tracker.repeatNotice(event)), [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(tracker.repeatNotice(A), GENTLE_REPEAT);
});

test('repeat chain counts bash and error results; the result is not part of identity', () => {
  const tracker = createLoopTracker();
  const out = [0, 1, 2].map((i) => tracker.repeatNotice(repeatCall('bash', {command:'npm test'}, `FAIL ${i}`, true)));
  assert.deepEqual(out, [undefined, undefined, GENTLE_REPEAT]);
  const sameName = createLoopTracker();
  assert.equal(sameName.repeatNotice(repeatCall('bash', {command:'ls'})), undefined);
  assert.equal(sameName.repeatNotice(repeatCall('edit', {command:'ls'})), undefined, 'tool name is part of identity');
});

test('passive waits and status polls neither count toward nor break the repeat chain', () => {
  const tracker = createLoopTracker();
  for (let i = 0; i < 4; i++) assert.equal(tracker.repeatNotice(repeatCall('bg_wait', {id:'build'})), undefined);
  for (let i = 0; i < 4; i++) assert.equal(tracker.repeatNotice(repeatCall('research_job', {action:'wait', id:'r1'})), undefined);
  const A = repeatCall('read', {path:'a'});
  assert.equal(tracker.repeatNotice(A), undefined);
  assert.equal(tracker.repeatNotice(repeatCall('bg_wait', {id:'build'})), undefined);
  assert.equal(tracker.repeatNotice(A), undefined);
  assert.equal(tracker.repeatNotice(A), GENTLE_REPEAT, 'the wait in between did not reset the chain');
});

test('repeat preview is capped at 500 characters with a remaining-length suffix', () => {
  const tracker = createLoopTracker();
  const input = {command:'x'.repeat(600)};
  const canonical = JSON.stringify(input);
  const more = canonical.length - 500;
  let notice;
  for (let i = 0; i < 5; i++) notice = tracker.repeatNotice(repeatCall('bash', input));
  assert.ok(notice.includes(`- arguments: ${canonical.slice(0, 500)}… (+${more} more chars)\n`));
  assert.ok(!notice.includes(canonical));
});

test('uncanonicalizable input (cyclic or over 64 KB) abstains and resets the chain', () => {
  const tracker = createLoopTracker();
  const A = repeatCall('read', {path:'a'});
  assert.equal(tracker.repeatNotice(A), undefined);
  assert.equal(tracker.repeatNotice(A), undefined);
  const cyclic = {a:1}; cyclic.self = cyclic;
  assert.equal(tracker.repeatNotice(repeatCall('read', cyclic)), undefined);
  assert.equal(tracker.repeatNotice(A), undefined, 'cyclic call reset the chain');
  assert.equal(tracker.repeatNotice(A), undefined);
  assert.equal(tracker.repeatNotice(A), GENTLE_REPEAT);
  assert.equal(tracker.repeatNotice(repeatCall('write', {data:'x'.repeat(70_000)})), undefined);
  assert.equal(tracker.repeatNotice(A), undefined, 'oversized call reset the chain');
});

test('tool_result hook appends the repeat-check text to the third identical result', async () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pi-loop-cycle-repeat-'));
  const priorHome=process.env.HOME; process.env.HOME=home;
  try {
    const {default:register}=await import(pathToFileURL(path.join(agent,'extensions/reminders.ts')));
    const hooks=new Map();
    const ctx={cwd:home,sessionManager:{getSessionId:()=> 'loop-cycle-repeat',getBranch:()=> []},ui:{notify(){}}};
    register({on:(name,fn)=>{const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);},registerCommand(){},sendMessage(){}});
    const emit=async(name,event={})=>{let result;for(const fn of hooks.get(name)??[])result=await fn(event,ctx)??result;return result;};
    await emit('session_start',{reason:'startup'}); await emit('agent_start');
    const results=[];
    for(let i=0;i<3;i++) results.push(await emit('tool_result', repeatCall('read', {path:'same'}, `same ${i}`)));
    assert.equal(results[0], undefined);
    assert.equal(results[1], undefined);
    assert.deepEqual(results[2].content.slice(0,1), [{type:'text', text:'same 2'}]);
    assert.deepEqual(results[2].content.at(-1), {type:'text', text:GENTLE_REPEAT});
  } finally {
    if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;
    fs.rmSync(home,{recursive:true,force:true});
  }
});
