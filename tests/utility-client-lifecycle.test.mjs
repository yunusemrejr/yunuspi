import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const template = path.resolve(import.meta.dirname, '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')]
  .find(p => fs.existsSync(path.join(p, 'extensions/lib/utility-client.ts')));
const filename = path.join(agent, 'extensions/lib/utility-client.ts');
const source = stripTypeScriptTypes(fs.readFileSync(filename, 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export class UtilityClient', 'class UtilityClient')
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));

// Delay exit after kill, as real child processes do, so lifecycle races are deterministic.
function fixture({ invalidFirst = false, holdInitialize = false, holdCalls = false, virtualTimers = false } = {}) {
  const children = [];
  const timers = new Set();
  const schedule = (fn, ms) => {
    const timer = virtualTimers ? { fn, ms, unref() {} } : setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const cancelTimer = timer => { timers.delete(timer); if (!virtualTimers) clearTimeout(timer); };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = { resume() {} };
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.messages = []; child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    child.exitCode = null; child.signalCode = null;
    child.respond = (id, result) => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    child.stdin.write = line => {
      const message = JSON.parse(line); child.messages.push(message);
      if (message.id !== undefined) queueMicrotask(() => {
        if (message.method === 'initialize') {
          if (!holdInitialize) child.respond(message.id, { serverInfo: { name: invalidFirst && children[0] === child ? 'wrong-server' : 'yunuspi-utility-mcp' } });
        } else if (message.method === 'tools/list') child.respond(message.id, { tools: Array(8).fill({}) });
        else if (!holdCalls) child.respond(message.id, { ok: true });
      });
      return true;
    };
    children.push(child); return child;
  };
  const UtilityClient = vm.runInNewContext(source + '\nUtilityClient', {
    spawn, fs, fileURLToPath, URL, process, Buffer, UTILITY_CONCURRENCY: 2,
    setTimeout: schedule, clearTimeout: cancelTimer,
  });
  const client = new UtilityClient(template);
  return { client, children, timers, cleanup() { client.close(); for (const timer of timers) cancelTimer(timer); } };
}

test('a rejected handshake cannot leave a dying child available to the next call', async () => {
  const f = fixture({ invalidFirst: true });
  try {
    await assert.rejects(f.client.start(), /Unexpected utility server/);
    assert.equal((await f.client.call('fixture', {})).ok, true);
    assert.equal(f.children.length, 2);
    assert.equal(f.children[0].messages.some(m => m.method === 'tools/call'), false);
    assert.deepEqual(f.children[1].messages.map(m => m.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    // A late exit from the retired process must leave its replacement alive.
    f.children[0].emit('exit', 1);
    await f.client.call('fixture', {});
    assert.equal(f.children.length, 2);
  } finally { f.cleanup(); }
});

test('an already cancelled tool call does not launch the utility process', async () => {
  const f = fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.client.call('fixture', {}, controller.signal), /cancelled/);
    assert.equal(f.children.length, 0);
  } finally { f.cleanup(); }
});

test('concurrent calls share one completed handshake and closing rejects pending startup', async () => {
  const f = fixture();
  try {
    await Promise.all(Array.from({ length: 8 }, () => f.client.call('fixture', {})));
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].messages.filter(m => m.method === 'initialize').length, 1);
    assert.equal(f.children[0].messages.filter(m => m.method === 'tools/call').length, 8);
  } finally { f.cleanup(); }
  const waiting = fixture({ holdInitialize: true });
  try {
    const startup = waiting.client.start(); waiting.client.close();
    await assert.rejects(startup, /stopped/);
    await assert.rejects(waiting.client.start(), /closed/);
    assert.equal(waiting.children.length, 1);
  } finally { waiting.cleanup(); }
});


test('crashes trigger at most three automatic restarts and close cancels a scheduled restart', async () => {
  const f = fixture({ virtualTimers: true });
  try {
    await f.client.start();
    for (const delay of [500, 1000, 2000]) {
      f.children.at(-1).emit('exit', 1);
      assert.equal(f.timers.size, 1);
      const [restart] = f.timers;
      assert.equal(restart.ms, delay);
      f.timers.delete(restart); restart.fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    f.children.at(-1).emit('exit', 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.children.length, 4);
    await f.client.call('fixture', {});
    assert.equal(f.children.length, 5, 'an explicit call can still recover after the automatic budget is exhausted');
  } finally { f.cleanup(); }
  const closing = fixture({ virtualTimers: true });
  try {
    await closing.client.start(); closing.children[0].emit('exit', 1);
    assert.equal(closing.timers.size, 1);
    closing.client.close();
    assert.equal(closing.timers.size, 0);
    assert.equal(closing.children.length, 1);
  } finally { closing.cleanup(); }
});


test('native parallel batches respect the two-worker MCP capacity', async () => {
  const f = fixture({ holdCalls: true });
  const calls = Array.from({ length: 6 }, () => f.client.call('fixture', {}));
  const all = Promise.all(calls);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const child = f.children[0];
    let done = 0;
    for (let wave = 0; wave < 3; wave++) {
      const sent = child.messages.filter(m => m.method === 'tools/call');
      assert.equal(sent.length - done, 2, 'only two requests may occupy MCP workers');
      for (const request of sent.slice(done)) child.respond(request.id, { ok: true });
      done = sent.length;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await all).length, 6);
  } finally { f.cleanup(); await all.catch(() => {}); }
});

test('queued utility calls are cancelled or closed without dispatch', async () => {
  const f = fixture({ holdCalls: true });
  const active = [f.client.call('fixture', {}), f.client.call('fixture', {})];
  const activeDone = Promise.allSettled(active);
  const controller = new AbortController();
  const cancelled = f.client.call('cancelled', {}, controller.signal);
  const cancelledCheck = assert.rejects(cancelled, /cancelled/);
  const queued = f.client.call('closed', {});
  const closedCheck = assert.rejects(queued, /closed/);
  try {
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await cancelledCheck;
    assert.equal(f.children[0].messages.filter(m => m.method === 'tools/call').length, 2);
    f.client.close();
    await closedCheck;
    await activeDone;
    assert.equal(f.children[0].messages.some(m => ['cancelled', 'closed'].includes(m.params?.name)), false);
  } finally { f.cleanup(); }
});

test('a native batch of three real utility requests completes without a capacity error', async () => {
  const { UtilityClient } = await import(pathToFileURL(filename));
  const client = new UtilityClient(template);
  try {
    const results = await Promise.all(Array.from({length:3},()=>client.call('contract_diff',{
      before_value:{count:1},after_value:{count:'one'}
    })));
    for (const result of results) {
      assert.equal(result.isError,false,JSON.stringify(result));
      assert.ok(result.content.some(part=>part.type==='text'));
    }
  } finally { client.close(); }
});
