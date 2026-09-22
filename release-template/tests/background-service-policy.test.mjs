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

function notifier() {
  const sent = [], ui = [], hooks = new Map();
  const ctx = { isIdle: () => true, ui: { notify: text => ui.push(text) }, sessionManager: { getBranch: () => [] } };
  const pi = { on: (name, fn) => hooks.set(name, fn), sendMessage: (message, options) => sent.push({message,options}) };
  return { sent, ui, hooks, ctx, notify: createCompletionNotifier(pi, () => ctx) };
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
    if (options.triggerTurn && ++wakes === 1) return firstWake.promise;
  } };
  const notify = createCompletionNotifier(pi, () => ctx);
  notify({ content: 'first receipt' }, { triggerTurn: true });
  hooks.get('input')({ source: 'interactive', text: 'Continue with the updated task' });
  notify({ content: 'second receipt' }, { triggerTurn: true });
  assert.equal(wakes, 1, 'one wake is still waiting for acceptance');
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
    if (!options.triggerTurn) return receipt.promise;
  } };
  const notify = createCompletionNotifier(pi, () => ctx);
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
  } };
  const notify = createCompletionNotifier(pi, () => ctx);
  notify({ content: 'failed receipt' }, { triggerTurn: true });
  await tick();
  await hooks.get('agent_settled')();
  assert.equal(sent.length, 1);
});
