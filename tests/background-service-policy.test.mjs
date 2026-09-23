import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const release = path.resolve(import.meta.dirname, '..');
const agent = [path.join(release, 'agent'), path.resolve(release, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-background-tasks/src/core/service-policy.ts')));
const base = path.join(agent, 'extensions/pi-background-tasks/src/core');
const { isPersistentService, defaultCompletionTrigger, serviceNotificationOnly, taskTriggersCompletion } = await import(pathToFileURL(path.join(base, 'service-policy.ts')));
const { createCompletionNotifier } = await import(pathToFileURL(path.join(base, 'completion-wake.ts')));
const command = 'cd /tmp/project && php -S 127.0.0.1:8099 -t . 2>&1';

test('persistent server defaults and legacy snapshots never promise an automatic continuation', () => {
  for (const cmd of [command, 'python3 -m http.server 8080', 'npm run dev -- --host', 'pnpm start', 'npx vite --host']) {
    assert.equal(isPersistentService(cmd), true);
    assert.equal(defaultCompletionTrigger(cmd, false), false);
    assert.equal(taskTriggersCompletion({command:cmd,isAgent:false,notifyOnCompletion:true,triggerOnCompletion:true}), false, 'legacy default true is not explicit intent');
  }
  for (const cmd of ['npm test', 'npm run build', 'echo "php -S 127.0.0.1:8080"', 'grep "npm run dev" README.md', 'echo "example; php -S 127.0.0.1:8080"']) {
    assert.equal(isPersistentService(cmd), false);
    assert.equal(defaultCompletionTrigger(cmd, false), true);
  }
  assert.equal(defaultCompletionTrigger(command, false, false), false);
  assert.equal(defaultCompletionTrigger(command, false, true), true);
  assert.equal(taskTriggersCompletion({command,isAgent:false,notifyOnCompletion:true,triggerOnCompletion:true,triggerOnCompletionExplicit:true}), true);
  assert.equal(taskTriggersCompletion({command,isAgent:false,notifyOnCompletion:false,triggerOnCompletion:true,triggerOnCompletionExplicit:true}), false);
});

function notifier(options = {graceMs:0}) {
  const sent = [], ui = [], hooks = new Map();
  const ctx = { isIdle: () => true, ui: { notify: text => ui.push(text) }, sessionManager: { getBranch: () => [] } };
  const pi = { on: (name, fn) => hooks.set(name, fn), sendMessage: (message, options) => { sent.push({message,options}); options.onAccepted?.(); } };
  return { sent, ui, hooks, ctx, notify: createCompletionNotifier(pi, () => ctx, options) };
}

test('legacy service exit is UI-only even when old registry asks to wake', () => {
  const f = notifier();
  f.notify({customType:'background-task-notification',content:'receipt',details:{command,name:'fixture dev server',status:'completed',isAgent:false,notifyOnCompletion:true,triggerOnCompletion:true}}, {triggerTurn:true});
  f.hooks.get('agent_settled')();
  assert.equal(f.sent.length, 0);
  assert.equal(f.ui.length, 1);
  assert.match(f.ui[0], /fixture dev server/);
});

test('finite local task completion still sends its receipt and exactly one wake', async () => {
  const f = notifier();
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("done")'], {stdio:'ignore'});
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0);
  const task = {command:'node finite-build.mjs',isAgent:false,notifyOnCompletion:true,triggerOnCompletion:true,status:'completed'};
  f.notify({customType:'background-task-notification',content:'finite completion',details:task}, {triggerTurn:taskTriggersCompletion(task)});
  f.hooks.get('agent_settled')();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].options.triggerTurn, false);
  assert.equal(f.sent[1].options.triggerTurn, true);
  assert.equal(f.ui.length, 0);
  const disabled = notifier();
  disabled.notify({details:{...task,triggerOnCompletion:false}}, {triggerTurn:false});
  assert.equal(disabled.sent.length, 1);
  assert.equal(disabled.sent[0].options.triggerTurn, false);
  assert.equal(serviceNotificationOnly({...task,command,triggerOnCompletionExplicit:true}), false);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('old completion acknowledgement cannot consume work from a newer user request', async () => {
  const hooks = new Map(), sent = [], firstWake = deferred();
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
  let wakes = 0;
  const pi = { on: (name, fn) => hooks.set(name, fn), sendMessage(message, options) {
    sent.push({ message, options });
    if (options.triggerTurn && ++wakes === 1) return firstWake.promise.then(() => options.onAccepted?.());
    options.onAccepted?.();
  } };
  const notify = createCompletionNotifier(pi, () => ctx, {graceMs:0});
  notify({ content: 'first receipt' }, { triggerTurn: true });
  hooks.get('input')({ source: 'interactive', text: 'Continue with the updated task' });
  notify({ content: 'second receipt' }, { triggerTurn: true });
  assert.equal(wakes, 2, 'a fresh request does not inherit the old delivery lock');
  firstWake.resolve();
  await tick();
  await hooks.get('agent_settled')();
  assert.equal(wakes, 2, 'the newer completion retains its own acknowledgement');
  assert.equal(sent.filter(item => item.options.triggerTurn).length, 2);
});

test('completion wake waits until its durable receipt is accepted and ignores stale receipt delivery', async () => {
  const hooks = new Map(), sent = [], receipt = deferred();
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
  const pi = { on: (name, fn) => hooks.set(name, fn), sendMessage(message, options) {
    sent.push({ message, options });
    if (!options.triggerTurn) return receipt.promise.then(() => options.onAccepted?.());
    options.onAccepted?.();
  } };
  const notify = createCompletionNotifier(pi, () => ctx, {graceMs:0});
  notify({ content: 'delayed receipt' }, { triggerTurn: true });
  await tick();
  assert.equal(sent.length, 1, 'a wake cannot precede the receipt it refers to');
  hooks.get('input')({ source: 'interactive', text: 'A newer user request' });
  receipt.resolve();
  await tick();
  await hooks.get('agent_settled')();
  assert.equal(sent.length, 1, 'a stale completion cannot wake a newer request');
});

test('a failed completion receipt cannot trigger inference with missing results', async () => {
  const hooks = new Map(), sent = [];
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
  const pi = { on: (name, fn) => hooks.set(name, fn), sendMessage(message, options) {
    sent.push({ message, options });
    if (!options.triggerTurn) return Promise.reject(new Error('Receipt unavailable'));
    options.onAccepted?.();
  } };
  const notify = createCompletionNotifier(pi, () => ctx, {graceMs:0});
  notify({ content: 'failed receipt' }, { triggerTurn: true });
  await tick();
  await hooks.get('agent_settled')();
  assert.equal(sent.length, 1);
});

test('same-generation completion arriving during a wake drains after the settled event', async () => {
  const hooks = new Map(), firstWake = deferred(); let idle = true, wakes = 0;
  const ctx = { isIdle: () => idle, sessionManager: { getBranch: () => [] } };
  const notify = createCompletionNotifier({ on: (name, fn) => hooks.set(name, fn), sendMessage(_message, options) {
    if (options.triggerTurn && ++wakes === 1) { idle = false; options.onAccepted?.(); return firstWake.promise; }
    options.onAccepted?.();
  } }, () => ctx, {graceMs:0});
  notify({ content: 'A' }, { triggerTurn: true });
  notify({ content: 'B' }, { triggerTurn: true });
  idle = true;
  await hooks.get('agent_settled')();
  firstWake.resolve(); await tick();
  assert.equal(wakes, 2, 'B must not wait forever for another unrelated settled event');
  await hooks.get('agent_settled')();
  assert.equal(wakes, 2, 'accepted wakes are consumed once');
});

test('failed wake does not spin, and abort or shutdown prevents a latched continuation', async () => {
  for (const end of ['rejection', 'abort', 'shutdown']) {
    const hooks = new Map(), firstWake = deferred(); let wakes = 0;
    const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };
    const notify = createCompletionNotifier({ on: (name, fn) => hooks.set(name, fn), sendMessage(_message, options) {
      if (options.triggerTurn) { wakes++; return firstWake.promise; }
      options.onAccepted?.();
    } }, () => ctx, {graceMs:0});
    notify({ content: 'A' }, { triggerTurn: true });
    notify({ content: 'B' }, { triggerTurn: true });
    await hooks.get('agent_settled')();
    if (end === 'abort') hooks.get('message_end')({ message: { role: 'assistant', stopReason: 'aborted' } });
    if (end === 'shutdown') hooks.get('session_shutdown')();
    if (end === 'rejection') firstWake.reject(new Error('fixture unavailable'));
    else firstWake.resolve();
    await tick(); await tick();
    assert.equal(wakes, 1, end);
  }
});

test('accepted wake is consumed before a failed model promise and cannot start inference twice',async()=>{
 const hooks=new Map();let wakes=0;
 const ctx={isIdle:()=>true,sessionManager:{getBranch:()=>[]}};
 const notify=createCompletionNotifier({on:(name,fn)=>hooks.set(name,fn),sendMessage(_message,options){
  options.onAccepted?.();
  if(options.triggerTurn){wakes++;return Promise.reject(new Error('model failed after persisted receipt'));}
  return Promise.resolve();
 }},()=>ctx,{graceMs:0});
 notify({content:'terminal receipt'},{triggerTurn:true});await tick();
 for(let i=0;i<4;i++)await hooks.get('agent_settled')();
 assert.equal(wakes,1);
});

test('volatile receipt admission cannot wake and volatile wake admission remains single-flight',async()=>{
 const hooks=new Map(),callbacks=[];let wakes=0;
 const ctx={isIdle:()=>true,sessionManager:{getBranch:()=>[]}};
 const notify=createCompletionNotifier({on:(name,fn)=>hooks.set(name,fn),sendMessage(_message,options){
  callbacks.push(options.onAccepted);if(options.triggerTurn)wakes++;return Promise.resolve();
 }},()=>ctx,{graceMs:0});
 notify({content:'queued receipt'},{triggerTurn:true});await tick();
 assert.equal(wakes,0);callbacks[0]();await tick();assert.equal(wakes,1);
 for(let i=0;i<4;i++)await hooks.get('agent_settled')();
 assert.equal(wakes,1);callbacks[1]();await tick();
 await hooks.get('agent_settled')();assert.equal(wakes,1);
});

const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const wakesOf = fixture => fixture.sent.filter(item => item.options.triggerTurn);

test('default completion grace batches separate-tick receipts and settled events cannot bypass it',async()=>{
  const f=notifier({}),started=performance.now();
  try {
    for(let i=0;i<8;i++) {
      f.notify({content:`receipt ${i}`},{triggerTurn:true});
      f.hooks.get('agent_settled')();
      await tick();
    }
    assert.equal(wakesOf(f).length,0,'the default 200 ms window is still open');
    await delay(220);
    assert.equal(wakesOf(f).length,1);
    assert.match(wakesOf(f)[0].message.content,/^8 background task completion/);
    assert.equal(f.sent.length,9,'eight durable receipts produce one inference wake');
    assert.ok(performance.now()-started>=190);
  } finally {f.hooks.get('session_shutdown')();}
});

test('steady arrivals do not slide the first accepted completion deadline',async()=>{
  const f=notifier({graceMs:80});
  let count=0,producing=true;
  const send=()=>f.notify({content:`receipt ${++count}`},{triggerTurn:true});
  send();await tick();send();
  const interval=setInterval(send,12);
  const producerEnd=setTimeout(()=>{producing=false;clearInterval(interval);},300);
  try {
    // A sliding debounce would remain silent throughout this arrival stream.
    await delay(130);
    assert.equal(producing,true);
    assert.equal(wakesOf(f).length,1,'the first batch wakes while arrivals continue');
    const batched=Number.parseInt(wakesOf(f)[0].message.content,10);
    assert.ok(batched>=2);assert.ok(batched<count,'later arrivals belong to a new grace window');
  } finally {clearInterval(interval);clearTimeout(producerEnd);f.hooks.get('session_shutdown')();}
});

test('input, abort and shutdown cancel grace work without waking a stale session',async()=>{
  for(const reason of ['input','abort','signal','shutdown']) {
    const f=notifier({graceMs:25}),controller=new AbortController();
    f.ctx.signal=controller.signal;
    f.notify({content:'old receipt'},{triggerTurn:true});
    if(reason==='input') f.hooks.get('input')({source:'interactive',text:'new request'});
    if(reason==='abort') f.hooks.get('message_end')({message:{role:'assistant',stopReason:'aborted'}});
    if(reason==='signal') controller.abort();
    if(reason==='shutdown') f.hooks.get('session_shutdown')();
    await delay(40);f.hooks.get('agent_settled')();await tick();
    assert.equal(wakesOf(f).length,0,reason);
    if(reason==='input') {
      f.notify({content:'new receipt'},{triggerTurn:true});await delay(40);
      assert.equal(wakesOf(f).length,1);
      assert.match(wakesOf(f)[0].message.content,/^1 background task completion/,'old input cannot enter the new batch');
    }
    f.hooks.get('session_shutdown')();
  }
});

test('compaction preserves the original grace deadline and resumes after its busy boundary',async()=>{
  const f=notifier({graceMs:35});let idle=false;
  f.ctx.isIdle=()=>idle;
  try {
    f.notify({content:'receipt'},{triggerTurn:true});
    f.hooks.get('session_compact_failed')();
    await delay(50);
    assert.equal(wakesOf(f).length,0);
    f.hooks.get('session_compact')();
    idle=true; // Core releases the busy flag after emitting session_compact.
    await delay(5);
    assert.equal(wakesOf(f).length,1,'elapsed grace does not restart after compaction');
    const next=notifier({graceMs:35});
    try {
      next.notify({content:'fresh receipt'},{triggerTurn:true});
      next.hooks.get('session_compact')();await delay(5);
      assert.equal(wakesOf(next).length,0,'the compaction bridge cannot shorten unelapsed grace');
      await delay(45);assert.equal(wakesOf(next).length,1);
    } finally {next.hooks.get('session_shutdown')();}
  } finally {f.hooks.get('session_shutdown')();}
});

test('an expired grace waits for lifecycle progress without polling a busy session',async()=>{
  const f=notifier({graceMs:20});let idle=false,checks=0;
  f.ctx.isIdle=()=>{checks++;return idle;};
  try {
    f.notify({content:'receipt while another turn is running'},{triggerTurn:true});
    await delay(35);
    assert.equal(wakesOf(f).length,0);const afterDeadline=checks;
    await delay(35);assert.equal(checks,afterDeadline,'there is no recurring idle probe');
    idle=true;f.hooks.get('agent_settled')();
    assert.equal(wakesOf(f).length,1,'the elapsed grace is ready on the next settled event');
  } finally {f.hooks.get('session_shutdown')();}
});

test('grace expiration during an in-flight wake drains accepted new completions once',async()=>{
  const hooks=new Map(),sent=[],firstWake=deferred();let idle=true;
  const ctx={isIdle:()=>idle,sessionManager:{getBranch:()=>[]}};
  const notify=createCompletionNotifier({on:(name,fn)=>hooks.set(name,fn),sendMessage(message,options){
    sent.push({message,options});options.onAccepted?.();
    if(options.triggerTurn && sent.filter(item=>item.options.triggerTurn).length===1){idle=false;return firstWake.promise;}
  }},()=>ctx,{graceMs:25});
  try {
    notify({content:'A'},{triggerTurn:true});await delay(40);
    notify({content:'B'},{triggerTurn:true});await tick();notify({content:'C'},{triggerTurn:true});
    await delay(40);
    assert.equal(sent.filter(item=>item.options.triggerTurn).length,1);
    idle=true;hooks.get('agent_settled')();firstWake.resolve();await tick();
    const wakes=sent.filter(item=>item.options.triggerTurn);
    assert.equal(wakes.length,2);assert.match(wakes[1].message.content,/^2 background task completion/);
    hooks.get('agent_settled')();await delay(35);
    assert.equal(sent.filter(item=>item.options.triggerTurn).length,2);
  } finally {firstWake.resolve();hooks.get('session_shutdown')();}
});
