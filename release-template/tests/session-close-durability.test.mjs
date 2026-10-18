// Close/reopen seams: a clean quit must flush a first-turn transcript, and a
// crash artifact in the session write lock must be reclaimable. These run
// offline against the owned core (dist is built by pretest/build:core).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSessionRuntime } from '../core/coding-agent/dist/core/agent-session-runtime.js';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';

const assistant = () => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  api: 'fixture',
  provider: 'fixture',
  model: 'fixture',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
});

function runtimeStub() {
  const events = [];
  const session = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: async (event) => { events.push(`shutdown:${event.reason}`); },
      invalidate: () => { events.push('invalidate'); },
    },
    sessionManager: { flush: () => { events.push('flush'); } },
    abort: async () => { events.push('abort'); },
    dispose: () => { events.push('dispose'); },
  };
  const runtime = new AgentSessionRuntime(session, { cwd: process.cwd(), agentDir: process.cwd() }, async () => { throw Error('unused'); });
  return { runtime, events };
}

test('a clean quit flushes the buffered first turn after the shutdown handlers', async () => {
  const { runtime, events } = runtimeStub();
  await runtime.dispose();
  const shutdown = events.indexOf('shutdown:quit');
  const flush = events.indexOf('flush');
  assert.ok(shutdown >= 0 && flush > shutdown, `flush must follow session_shutdown: ${events.join(',')}`);
  assert.equal(events.at(-1), 'dispose', `dispose is last: ${events.join(',')}`);
});

test('a session switch teardown flushes after the shutdown handlers too', async () => {
  const { runtime, events } = runtimeStub();
  await runtime.teardownCurrent('resume', '/tmp/next.jsonl');
  const shutdown = events.indexOf('shutdown:resume');
  const flush = events.indexOf('flush');
  assert.ok(shutdown >= 0 && flush > shutdown, `flush must follow session_shutdown: ${events.join(',')}`);
  assert.equal(events.at(-1), 'dispose');
});

function lockArtifact(file, { owner = undefined } = {}) {
  const lock = `${file}.write-lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  if (owner !== undefined) {
    fs.writeFileSync(path.join(lock, `owner-${process.pid}-00000000-0000-0000-0000-000000000000`), owner);
  }
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  return lock;
}

test('ownerless and partially published crash locks are reclaimed after the grace, not stolen while fresh', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-close-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(process.cwd(), dir);
  manager.appendMessage(assistant());
  const file = manager.getSessionFile();
  assert.ok(file && fs.existsSync(file));

  for (const owner of [undefined, '', '{"pid":', 'garbage']) {
    const lock = lockArtifact(file, owner === undefined ? {} : { owner });
    const reopened = SessionManager.open(file);
    assert.ok(reopened.getSessionId(), `opened with crash artifact ${JSON.stringify(owner)}`);
    assert.equal(fs.existsSync(lock), false, `reclaimed ${JSON.stringify(owner)}`);
    SessionManager.open(file);
  }

  // A fresh ownerless directory may belong to a live writer between mkdir and
  // publishing its owner: the grace protects it, so it stays busy.
  fs.mkdirSync(`${file}.write-lock`, { mode: 0o700 });
  assert.throws(() => SessionManager.open(file), { code: 'ESESSIONBUSY' });
  fs.rmSync(`${file}.write-lock`, { recursive: true, force: true });

  // A live owner is never stolen, even with an ancient directory mtime.
  const lock = lockArtifact(file, { owner: JSON.stringify({ pid: process.pid }) });
  assert.throws(() => SessionManager.open(file), { code: 'ESESSIONBUSY' });
  fs.rmSync(lock, { recursive: true, force: true });
  assert.ok(SessionManager.open(file).getSessionId());
});
