import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import healthLog from '../agent/extensions/health-log.ts';
import { HEALTH_SINK } from '../agent/extensions/lib/health-log.ts';
import { HELPER_USAGE_ENTRY, HELPER_USAGE_VIEW, collectHarnessUsage, helperUsageView } from '../agent/extensions/lib/helper-usage.ts';
import { sessionObservability } from '../agent/extensions/lib/session-observability.ts';
import { createMicroMetrics } from '../agent/extensions/lib/micro-intelligence/metrics.ts';

async function fixture(t, captureCadence = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-usage-lifecycle-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const hooks = new Map(), entries = [], messages = [], ticks = [];
  if (captureCadence) t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 5000, 'reuse the existing health cadence');
    ticks.push(callback);
    return { unref() {} };
  });
  healthLog({
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerCommand() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendMessage(message) { messages.push(message); },
  });
  // Isolate the health lifecycle registered last; telemetry has its own owner.
  const start = id => hooks.get('session_start').at(-1)({}, {
    sessionManager: { getSessionId: () => id }, ui: { notify() {} },
  });
  const close = () => hooks.get('session_shutdown').at(-1)();
  t.after(async () => {
    await close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { start, close, entries, messages, ticks };
}

test('health shutdown fences its sink before asynchronous log close and preserves its final snapshot', async t => {
  const f = await fixture(t);
  await f.start('first');
  const oldSink = sessionObservability()[HEALTH_SINK];
  oldSink('ml.fuzzy.used', { count: 2 });
  const closing = f.close();
  const messageCount = f.messages.length;
  oldSink('ml.fuzzy.used', { count: 900 });
  assert.equal(sessionObservability()[HEALTH_SINK], undefined, 'closed ownership must end before the close promise resolves');
  assert.equal(sessionObservability()[HELPER_USAGE_VIEW], undefined);
  assert.equal(f.messages.length, messageCount, 'a late result cannot write a new display message');
  await closing;
  const summary = collectHarnessUsage(f.entries.filter(entry => entry.customType === HELPER_USAGE_ENTRY));
  assert.equal(summary.components.find(row => row.name === 'Fuzzy matching').matches, 2);
});

test('an overlapping new session survives old asynchronous shutdown and ignores its captured callbacks', async t => {
  const f = await fixture(t);
  await f.start('first');
  const oldSink = sessionObservability()[HEALTH_SINK];
  oldSink('ml.fuzzy.used', { count: 2 });
  const closing = f.close();
  const starting = f.start('second');
  await Promise.all([closing, starting]);
  const newSink = sessionObservability()[HEALTH_SINK];
  const view = sessionObservability()[HELPER_USAGE_VIEW];
  assert.equal(typeof newSink, 'function', 'old close must not invalidate the new start generation');
  assert.notEqual(newSink, oldSink);
  assert.equal(view('first'), undefined);
  newSink('ml.fuzzy.used', { count: 3 });
  oldSink('ml.fuzzy.used', { count: 900 });
  assert.equal(view('second').components['Fuzzy matching'].matches, 3);
  await f.close();
  const summary = collectHarnessUsage(f.entries.filter(entry => entry.customType === HELPER_USAGE_ENTRY));
  assert.equal(summary.segments, 2);
  assert.equal(summary.components.find(row => row.name === 'Fuzzy matching').matches, 5);
});

test('late consumer acceptance retains its original guarded session sink', async t => {
  const f = await fixture(t);
  await f.start('first');
  const oldMetrics = createMicroMetrics();
  oldMetrics.accept('needle');
  await f.close();
  await f.start('second');
  oldMetrics.accept('needle');
  const currentMetrics = createMicroMetrics();
  currentMetrics.accept('jev');
  const current = sessionObservability()[HELPER_USAGE_VIEW]('second');
  assert.equal(current.components.Needle3, undefined, 'old consumer work cannot count as new-session application');
  assert.equal(current.components.JEV.applied, 1);
  await f.close();
  const summary = collectHarnessUsage(f.entries);
  assert.equal(summary.components.find(row => row.name === 'Needle3').applied, 1);
  assert.equal(summary.components.find(row => row.name === 'JEV').applied, 1);
});

test('existing health cadence persists idle background usage and fences old callbacks', async t => {
  const f = await fixture(t, true);
  await f.start('first');
  sessionObservability()[HEALTH_SINK]('ml.jev.used', { durationMs: 12 });
  assert.equal(helperUsageView('first').components.JEV.executions, 1, 'the live view includes work before a flush');
  assert.equal(helperUsageView('other'), undefined);
  assert.equal(f.entries.length, 0);
  f.ticks[0]();
  assert.equal(f.entries.length, 1, 'background work persists without another agent or turn end');
  f.ticks[0]();
  assert.equal(f.entries.length, 1, 'clean ticks do not duplicate snapshots');
  await f.close();
  await f.start('second');
  sessionObservability()[HEALTH_SINK]('ml.jev.used', { durationMs: 10 });
  f.ticks[0]();
  assert.equal(f.entries.length, 1, 'an old timer callback cannot flush the new owner');
  f.ticks[1]();
  assert.equal(f.entries.length, 2);
  assert.equal(collectHarnessUsage(f.entries).components.find(row => row.name === 'JEV').executions, 2);
});
