import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWaitSubscriptionManager } from '../agent/extensions/pi-subagents/src/runs/background/wait-subscriptions.ts';
import { createAgentSession } from '../core/coding-agent/dist/core/sdk.js';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';
import { DefaultResourceLoader } from '../core/coding-agent/dist/core/resource-loader.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture(t, sendMessage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-wait-'));
  const channels = new Map(), receipts = new Set(); let scans = 0;
  const state = { currentSessionId: 'session-a', foregroundRuns: new Map([['run-a', { sessionId: 'session-a', children: [] }]]) };
  const lookup = state.foregroundRuns.get.bind(state.foregroundRuns);
  state.foregroundRuns.get = key => { scans++; return lookup(key); };
  const options = { subscriptionsDir: dir, resultsDir: path.join(dir, 'results'), asyncDirRoot: path.join(dir, 'async'), pollIntervalMs: 60000,
    acceptedTokens: () => receipts };
  const pi = { sendMessage, events: { on: (name, fn) => { channels.set(name, fn); return () => channels.delete(name); } } };
  const manager = createWaitSubscriptionManager(pi, state, options);
  const arm = () => manager.arm({ targetKind: 'foreground', runId: 'run-a', requestedId: 'run-a', timeoutMs: 60000 });
  t.after(() => { manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { manager, state, arm, dir, channels, receipts, options, pi, scans: () => scans };
}

test('durable wait survives sync and async rejection, retries later once, and coalesces event bursts', async t => {
  for (const mode of ['throw', 'reject']) {
    let sends = 0, accept;
    const f = fixture(t, (_message, options) => {
      sends++; accept = options.onAccepted;
      if (sends === 1) {
        if (mode === 'throw') throw new Error('fixture queue rejection');
        return Promise.reject(new Error('fixture queue rejection'));
      }
      return Promise.resolve(); // Queued, but not yet persisted.
    });
    const record = f.arm();
    f.manager.reconcile(); await tick();
    assert.equal(f.state.waitSubscriptions.size, 1);
    assert.ok(fs.existsSync(path.join(f.dir, `${record.token}.json`)));
    const before = f.scans();
    for (let i = 0; i < 100; i++) for (const wake of f.channels.values()) wake();
    await tick();
    assert.equal(f.scans() - before, 1, '600 wake events require one reconciliation');
    assert.equal(sends, 2);
    f.manager.reconcile(); assert.equal(sends, 2, 'volatile queue is single-flight');
    accept();
    assert.equal(f.state.waitSubscriptions.size, 0);
    assert.equal(fs.existsSync(path.join(f.dir, `${record.token}.json`)), false);
  }
});

test('preaccept failures are bounded and preserve durable evidence', async t => {
  let sends = 0;
  const f = fixture(t, () => { sends++; return Promise.reject(new Error('fixture unavailable')); });
  const record = f.arm();
  for (let i = 0; i < 10; i++) { f.manager.reconcile(); await tick(); }
  assert.equal(sends, 3);
  assert.ok(fs.existsSync(path.join(f.dir, `${record.token}.json`)));
});

test('persisted acceptance prevents replay after model failure or cleanup interrupted by restart', async t => {
  let sends = 0; const model = deferred();
  const f = fixture(t, (message, options) => {
    sends++; f.receipts.add(message.details.token); options.onAccepted(); return model.promise;
  });
  const record = f.arm(); f.manager.reconcile();
  model.reject(new Error('fixture model failed after persistence')); await tick();
  f.manager.reconcile(); assert.equal(sends, 1);
  fs.writeFileSync(path.join(f.dir, `${record.token}.json`), JSON.stringify(record));
  f.manager.restore(); await tick();
  assert.equal(sends, 1, 'durable session token suppresses replay after interrupted unlink');
  assert.equal(fs.existsSync(path.join(f.dir, `${record.token}.json`)), false);
});

test('queued old-session acknowledgements cannot consume a restored subscription', async t => {
  const callbacks = []; let sends = 0;
  const f = fixture(t, (_message, options) => { sends++; callbacks.push(options.onAccepted); return Promise.resolve(); });
  const record = f.arm(); f.manager.reconcile();
  f.state.currentSessionId = 'session-b'; f.manager.restore();
  callbacks[0]();
  assert.ok(fs.existsSync(path.join(f.dir, `${record.token}.json`)));
  f.state.currentSessionId = 'session-a'; f.manager.restore();
  assert.equal(sends, 2);
  callbacks[0](); assert.equal(f.state.waitSubscriptions.size, 1);
  callbacks[1](); assert.equal(f.state.waitSubscriptions.size, 0);
});

async function sdkFixture(t, transport, persistent = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-accept-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 };
  const modelRuntime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false, getAuth: async () => ({ auth: { apiKey: ['synthetic', 'fixture'].join('-') } }), streamSimple: transport };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: persistent ? SessionManager.create(cwd, cwd) : SessionManager.inMemory(cwd), tools: [], thinkingLevel: 'off' });
  t.after(() => { session.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return session;
}
function response(gate, stopReason = 'stop') {
  const message = { role: 'assistant', provider: 'fixture', api: 'openai-completions', model: 'fixture', content: [{ type: 'text', text: 'fixture' }], stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return { async *[Symbol.asyncIterator]() { await gate; yield { type: 'done', message }; }, result: async () => message };
}

test('real SDK acknowledges persisted custom receipt before inference completes and retains completion Promise', async t => {
  const model = deferred(); let accepted = 0, finished = false, calls = 0;
  const session = await sdkFixture(t, () => { calls++; return response(model.promise, 'error'); }, true);
  const delivery = session.sendCustomMessage({ customType: 'receipt', content: 'terminal result', display: false, details: { token: 'one' } }, {
    triggerTurn: true, onAccepted() {
      accepted++;
      assert.ok(session.sessionManager.getBranch().some(e => e.type === 'custom_message' && e.details?.token === 'one'));
      assert.match(fs.readFileSync(session.sessionManager.getSessionFile(), 'utf8'), /"token":"one"/, 'receipt is already on disk before first model response');
    },
  }).then(() => { finished = true; });
  await tick(); await tick();
  assert.equal(accepted, 1); assert.equal(calls, 1); assert.equal(finished, false);
  model.resolve(); await delivery;
  assert.equal(accepted, 1); assert.equal(finished, true);
});

test('real SDK queued receipts acknowledge only on persistence, including abort flush and next-turn deferral', async t => {
  const model = deferred(); const session = await sdkFixture(t, () => response(model.promise, 'aborted'));
  const running = session.prompt('fixture request'); await tick(); await tick();
  let accepted = 0;
  await session.sendCustomMessage({ customType: 'receipt', content: 'queued result', display: false }, { triggerTurn: false, onAccepted: () => accepted++ });
  assert.equal(accepted, 0, 'queue admission is not durability');
  assert.equal(session.sessionManager.getBranch().filter(e => e.type === 'custom_message').length, 0);
  model.resolve(); await running;
  assert.equal(accepted, 1);
  await session.sendCustomMessage({ customType: 'deferred', content: 'next request', display: false }, { deliverAs: 'nextTurn', onAccepted: () => accepted++ });
  assert.equal(accepted, 1, 'next-turn message remains unacknowledged while queued');
  await session.prompt('next request'); assert.equal(accepted, 2);
});

test('real SDK follow-up receipt is unacknowledged until consumed and persisted', async t => {
  const model = deferred(); let calls = 0, accepted = 0;
  const session = await sdkFixture(t, () => response(++calls === 1 ? model.promise : Promise.resolve()));
  const running = session.prompt('fixture request'); await tick(); await tick();
  await session.sendCustomMessage({ customType: 'follow-up', content: 'terminal result', display: false }, {
    triggerTurn: true, deliverAs: 'followUp', onAccepted: () => accepted++,
  });
  assert.equal(accepted, 0); assert.equal(calls, 1);
  model.resolve(); await running;
  assert.equal(accepted, 1); assert.equal(calls, 2);
});

test('real wait manager with SDK does not start inference again after an accepted receipt and model error', async t => {
  const gate = deferred(); let calls = 0, delivery;
  const session = await sdkFixture(t, () => { calls++; return response(gate.promise, 'error'); }, true);
  const f = fixture(t, (message, options) => { delivery = session.sendCustomMessage(message, options); return delivery; });
  f.arm(); f.manager.reconcile(); await tick(); await tick();
  assert.equal(calls, 1); assert.equal(f.state.waitSubscriptions.size, 0);
  gate.resolve(); await delivery;
  for (let i = 0; i < 10; i++) f.manager.reconcile();
  assert.equal(calls, 1);
  assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'subagent-wait-subscription').length, 1);
});

test('failed persistent receipt writes leave no accepted memory ghost and safely retry once', async t => {
  for (const phase of ['first-flush', 'append', 'sync']) {
    const session = await sdkFixture(t, () => response(Promise.resolve()), true);
    if (phase !== 'first-flush') await session.sendCustomMessage({ customType: 'anchor', content: 'anchor', display: false }, { onAccepted() {} });
    const originalWrite = fs.writeFileSync, originalSync = fs.fsyncSync;
    let injected = false, receiptWritten = false, accepted = 0;
    fs.writeFileSync = (file, data, ...args) => {
      const isReceipt = String(data).includes('"customType":"persist-fail"');
      if (isReceipt) receiptWritten = true;
      if (!injected && typeof file === 'number' && (phase === 'first-flush' || (phase === 'append' && isReceipt))) {
        injected = true;
        originalWrite(file, String(data).slice(0, 13), ...args);
        throw Object.assign(new Error('fixture partial write failure'), { code: 'ENOSPC' });
      }
      return originalWrite(file, data, ...args);
    };
    fs.fsyncSync = fd => {
      if (!injected && phase === 'sync' && receiptWritten) { injected = true; throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' }); }
      return originalSync(fd);
    };
    syncBuiltinESMExports();
    const message = { customType: 'persist-fail', content: 'durable receipt', display: false, details: { token: phase } };
    try { await assert.rejects(session.sendCustomMessage(message, { onAccepted: () => accepted++ }), /fixture/); }
    finally { fs.writeFileSync = originalWrite; fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(accepted, 0);
    assert.equal(session.sessionManager.getBranch().some(e => e.type === 'custom_message' && e.customType === 'persist-fail'), false, `${phase}: restore cannot mistake memory for durable acceptance`);
    assert.equal(session.agent.state.messages.some(e => e.role === 'custom' && e.customType === 'persist-fail'), false);
    const file = session.sessionManager.getSessionFile();
    if (phase === 'first-flush') assert.equal(fs.existsSync(file), false, 'failed first flush removes its partial newly-created file');
    else assert.ok(!fs.readFileSync(file, 'utf8').includes('persist-fail'), 'partial receipt tail rolled back');
    await session.sendCustomMessage(message, { onAccepted: () => accepted++ });
    assert.equal(accepted, 1);
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes('persist-fail')).length, 1);
    const reopened = SessionManager.open(file);
    assert.equal(reopened.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'persist-fail').length, 1);
  }
});

test('disposed wait owner cannot arm or resurrect subscriptions through a stale restore call', async t => {
  const f = fixture(t, () => { throw Error('stale send'); });
  f.arm(); f.manager.dispose();
  f.manager.restore();
  assert.equal(f.state.waitSubscriptions.size, 0);
  assert.throws(f.arm, /disposed/);
});

test('failed append cannot truncate another SDK owner and both owners can write after rollback', async t => {
  const session = await sdkFixture(t, () => response(Promise.resolve()), true);
  await session.sendCustomMessage({ customType: 'anchor', content: 'anchor', display: false }, { onAccepted() {} });
  const file = session.sessionManager.getSessionFile();
  const second = SessionManager.open(file);
  const originalWrite = fs.writeFileSync;
  let raced = false;
  fs.writeFileSync = (fd, data, ...args) => {
    if (!raced && String(data).includes('"customType":"first-owner"')) {
      raced = true;
      originalWrite(fd, String(data).slice(0, 13), ...args);
      assert.throws(() => second.appendCustomMessageEntry('second-owner', 'other result', false, undefined, false, true), { code: 'ESESSIONBUSY' });
      throw Error('fixture concurrent append failure');
    }
    return originalWrite(fd, data, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(session.sendCustomMessage({ customType: 'first-owner', content: 'result', display: false }, { onAccepted() {} }), /fixture concurrent/); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(raced, true);
  second.appendCustomMessageEntry('second-owner', 'other result', false, undefined, false, true);
  await session.sendCustomMessage({ customType: 'first-owner', content: 'result', display: false }, { onAccepted() {} });
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.customType === 'first-owner').length, 1);
  assert.equal(entries.filter(e => e.customType === 'second-owner').length, 1);
  assert.equal(fs.existsSync(`${file}.write-lock`), false);
});

test('cross-process session writes serialize and positively dead owners recover after SIGKILL', { timeout: 10000 }, async t => {
  const session = await sdkFixture(t, () => response(Promise.resolve()), true);
  await session.sendCustomMessage({ customType: 'anchor', content: 'anchor', display: false }, { onAccepted() {} });
  const file = session.sessionManager.getSessionFile();
  const lockModule = new URL('../core/coding-agent/dist/utils/session-write-lock.js', import.meta.url).href;
  const program = `import { writeSync } from 'node:fs';
    const { withSessionWriteLock } = await import(process.argv[1]);
    withSessionWriteLock(process.argv[2], () => {
      writeSync(1, 'locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
    });`;
  for (const killed of [false, true]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, lockModule, file, killed ? '20000' : '80'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await once(child.stdout, 'data');
    if (killed) {
      const ancient = new Date('2000-01-01T00:00:00Z');
      fs.utimesSync(`${file}.write-lock`, ancient, ancient);
      await assert.rejects(session.sendCustomMessage({ customType: 'busy', content: 'result', display: false }, { onAccepted() {} }), { code: 'ESESSIONBUSY' });
      assert.ok(fs.existsSync(`${file}.write-lock`), 'a live owner is never stolen because its timestamp is old');
      child.kill('SIGKILL'); await exited;
    }
    await session.sendCustomMessage({ customType: killed ? 'recovered' : 'serialized', content: 'result', display: false }, { onAccepted() {} });
    if (!killed) assert.equal((await exited)[0], 0);
    assert.equal(fs.existsSync(`${file}.write-lock`), false);
  }
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(e => e.customType === 'serialized').length, 1);
  assert.equal(entries.filter(e => e.customType === 'recovered').length, 1);
});

test('descriptor failures before write close safely, while close errors after durable commit do not replay receipts', async t => {
  const session = await sdkFixture(t, () => response(Promise.resolve()), true);
  await session.sendCustomMessage({ customType: 'anchor', content: 'anchor', display: false }, { onAccepted() {} });
  const originalStat = fs.fstatSync, originalClose = fs.closeSync;
  let receiptFd, closed = false, accepted = 0;
  fs.fstatSync = fd => { receiptFd = fd; throw Error('fixture descriptor stat failure'); };
  fs.closeSync = fd => { if (fd === receiptFd) closed = true; return originalClose(fd); };
  syncBuiltinESMExports();
  try { await assert.rejects(session.sendCustomMessage({ customType: 'stat-failed', content: 'result', display: false }, { onAccepted: () => accepted++ }), /descriptor stat/); }
  finally { fs.fstatSync = originalStat; fs.closeSync = originalClose; syncBuiltinESMExports(); }
  assert.equal(closed, true); assert.equal(accepted, 0);
  receiptFd = undefined;
  fs.fstatSync = fd => { receiptFd = fd; return originalStat(fd); };
  fs.closeSync = fd => { originalClose(fd); if (fd === receiptFd) throw Error('fixture close after fsync'); };
  syncBuiltinESMExports();
  try { await session.sendCustomMessage({ customType: 'close-after-commit', content: 'result', display: false }, { onAccepted: () => accepted++ }); }
  finally { fs.fstatSync = originalStat; fs.closeSync = originalClose; syncBuiltinESMExports(); }
  assert.equal(accepted, 1);
  assert.equal(session.sessionManager.getBranch().filter(e => e.customType === 'close-after-commit').length, 1);
  const rows = fs.readFileSync(session.sessionManager.getSessionFile(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(e => e.customType === 'close-after-commit').length, 1);
  assert.equal(rows.filter(e => e.customType === 'stat-failed').length, 0);
});

test('legacy load and migration cannot overwrite another owners accepted tail at lock release', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-migration-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'legacy.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 2, id: 'legacy-fixture', cwd, timestamp: new Date(0).toISOString() }) + '\n');
  const originalRemove = fs.rmdirSync;
  let interleaved = false;
  fs.rmdirSync = (dir, ...args) => {
    const result = originalRemove(dir, ...args);
    if (!interleaved && dir === `${file}.write-lock`) {
      interleaved = true;
      const other = SessionManager.open(file);
      other.appendCustomMessageEntry('concurrent-tail', 'accepted result', false, undefined, false, true);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { SessionManager.open(file); }
  finally { fs.rmdirSync = originalRemove; syncBuiltinESMExports(); }
  assert.equal(interleaved, true);
  const entries = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries[0].version, 3);
  assert.equal(entries.filter(e => e.customType === 'concurrent-tail').length, 1);
});

test('standalone export reads an unwritable archive without locks or newline repair', async t => {
  const { exportFromFile } = await import('../core/coding-agent/dist/core/export-html/index.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-readonly-'));
  const archive = path.join(cwd, 'archive'); fs.mkdirSync(archive);
  t.after(() => { fs.chmodSync(archive, 0o700); fs.rmSync(cwd, { recursive: true, force: true }); });
  const file = path.join(archive, 'legacy.jsonl');
  const bytes = JSON.stringify({ type: 'session', version: 2, id: 'readonly-fixture', cwd, timestamp: new Date(0).toISOString() });
  fs.writeFileSync(file, bytes); fs.chmodSync(archive, 0o500);
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = (dir, ...args) => {
    if (String(dir).startsWith(archive)) throw Object.assign(Error('archive is read-only'), { code: 'EACCES' });
    return originalMkdir(dir, ...args);
  };
  syncBuiltinESMExports();
  const output = path.join(cwd, 'export.html');
  try { await exportFromFile(file, { outputPath: output }); }
  finally { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.ok(fs.readFileSync(output, 'utf8').includes('<!DOCTYPE html>'));
});
