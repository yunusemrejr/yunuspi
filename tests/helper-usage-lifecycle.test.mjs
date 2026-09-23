import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import healthLog from '../agent/extensions/health-log.ts';
import { HEALTH_SINK } from '../agent/extensions/lib/health-log.ts';
import { HELPER_USAGE_ENTRY, HELPER_USAGE_VIEW, collectHarnessUsage } from '../agent/extensions/lib/helper-usage.ts';
import { sessionObservability } from '../agent/extensions/lib/session-observability.ts';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-usage-lifecycle-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const hooks = new Map(), entries = [], messages = [];
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
  return { start, close, entries, messages };
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
