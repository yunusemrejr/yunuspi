import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionRuntime, loadExtensionFromFactory } from '../core/coding-agent/src/core/extensions/loader.js';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';
import { wrapToolDefinition } from '../core/coding-agent/src/core/tools/tool-definition-wrapper.js';
import { sessionObservability, withSessionObservability } from '../core/coding-agent/src/core/session-observability.js';
import healthLog from '../agent/extensions/health-log.ts';
import { identifierTerms } from '../agent/extensions/pi-lens/semantic-radar/fuzzy-identifiers.mjs';
import { createActivityIndicators } from '../agent/extensions/lib/activity-indicators.ts';
import { microMetrics, resetMicroMetrics } from '../agent/extensions/lib/micro-intelligence/metrics.ts';
import { multiStageRetrieve } from '../agent/extensions/lib/micro-intelligence/retrieval.ts';
import { buildSkillIndex, rankSkills } from '../agent/extensions/lib/skill-relevance.ts';
import { recordModelRoutingAttempt, getModelRoutingMetrics } from '../agent/extensions/lib/model-routing-metrics.ts';

const HEALTH = Symbol.for('yunus-pi.health.v1');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intelligence-observability-'));
process.env.PI_CODING_AGENT_DIR = directory;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function fixture() {
  const messages = [], entries = [], runtime = createExtensionRuntime();
  runtime.sendMessage = message => messages.push(message);
  runtime.appendEntry = (...args) => entries.push(args);
  runtime.getActiveTools = () => [];
  let current = 'same-id';
  const manager = { getSessionId: () => current, getEntries: () => [], getBranch: () => [] };
  const ctx = { cwd: '/synthetic-project', sessionManager: manager, hasUI: false, ui: { notify() {} } };
  const ext = await loadExtensionFromFactory(api => {
    healthLog(api);
    api.on('tool_call', async event => {
      if (event.wait) await event.wait;
      sessionObservability()[HEALTH]?.('ml.jev.used', { count: 1 });
      microMetrics().run('jev');
      recordModelRoutingAttempt({ route: 'fixture/model', source: 'test', fallback: true });
    });
    api.registerCommand('probe', { handler: async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { micro: microMetrics().snapshot(), routing: getModelRoutingMetrics() };
    }});
  }, ctx.cwd, createEventBus(), runtime, '<observability-test>');
  const emit = async (type, data = {}) => {
    for (const handler of ext.handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
  };
  await emit('session_start');
  return { messages, emit, ctx, ext, switchTo: id => { current = id; }, close: () => emit('session_shutdown') };
}

test('real loaded hooks, commands and tools retain isolated session observability across awaits', async () => {
  const a = await fixture(), b = await fixture();
  try {
    let release;
    const pending = a.emit('tool_call', { toolCallId: 'a', toolName: 'probe', wait: new Promise(resolve => { release = resolve; }) });
    await b.emit('tool_call', { toolCallId: 'b', toolName: 'probe' });
    assert.equal(a.messages.filter(m => m.content === 'JEV used').length, 0);
    assert.equal(b.messages.filter(m => m.content === 'JEV used').length, 1);
    release(); await pending;
    assert.equal(a.messages.filter(m => m.content === 'JEV used').length, 1);
    for (const item of [a, b]) {
      const report = await item.ext.commands.get('probe').handler('', item.ctx);
      assert.equal(report.micro.helpers.jev.runs, 1);
      assert.equal(report.routing.routes.attempts, 1);
    }
    const tool = wrapToolDefinition({ name: 'scope_probe', execute: async () => {
      await new Promise(resolve => setImmediate(resolve));
      sessionObservability()[HEALTH]?.('ml.retrieval.used', { count: 1 });
      return { content: [] };
    }}, () => a.ctx);
    await tool.execute('tool', {}, undefined);
    assert.equal(a.messages.filter(m => m.content === 'Retrieval intelligence used').length, 1);
    assert.equal(b.messages.filter(m => m.content === 'Retrieval intelligence used').length, 0);
  } finally { await a.close(); await b.close(); }
});

test('late old-session work cannot log into a replacement session or reset another collector', async () => {
  const f = await fixture();
  try {
    let release;
    const pending = f.emit('tool_call', { toolCallId: 'old', toolName: 'probe', wait: new Promise(resolve => { release = resolve; }) });
    await new Promise(resolve => setImmediate(resolve)); // the old hook is now awaiting its result
    f.switchTo('new-session');
    await f.emit('session_switch');
    withSessionObservability(f.ctx, () => resetMicroMetrics());
    release(); await pending;
    assert.equal(f.messages.filter(m => m.content === 'JEV used').length, 0);
    const report = await f.ext.commands.get('probe').handler('', f.ctx);
    assert.equal(report.micro.helpers.jev.runs, 0);
    assert.equal(report.routing.routes.attempts, 0);
  } finally { await f.close(); }
});

test('real fuzzy matching and accepted retrieval produce markers; abstention and failures do not', async () => {
  const sent = [], activity = createActivityIndicators(message => sent.push(message));
  const before = globalThis[HEALTH];
  globalThis[HEALTH] = (kind, data) => activity.note(kind, data);
  try {
    const index = buildSkillIndex([{ name: 'orbital-mechanics', file: '/fixture/SKILL.md', description: 'orbital ephemeris propagation integrator' },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `generic-${i}`, file: `/fixture/${i}/SKILL.md`, description: 'workflow evidence checks' }))]);
    assert.equal(rankSkills(index, 'workflow checks').length, 0);
    assert.equal(sent.length, 0);
    assert.equal(rankSkills(index, 'orbitl ephemeri')[0].skill.name, 'orbital-mechanics');
    assert.equal(sent.at(-1).content, 'Fuzzy matching used');
    const options = { kind: 'skill', site: 'fixture', query: 'orbital mechanics', lexical: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] };
    await multiStageRetrieve({ ...options, needle: async () => ({ ok: false, reason: 'unavailable' }) });
    assert.equal(sent.length, 1);
    const result = await multiStageRetrieve({ ...options, needle: async () => ({ ok: true, cached: false, ms: 1, shadow: false,
      value: { ranked: [{ id: 'b', score: .99 }, { id: 'a', score: .5 }], margin: .49 } }) });
    assert.equal(result.applied, 'needle');
    assert.equal(sent.at(-1).content, 'Retrieval intelligence used');
    for (const kind of ['ml.jev.used', 'ml.needle.call', 'ml.mini.used', 'ml.smol.used']) activity.note(kind, { isError: true });
    assert.equal(sent.length, 2);
    assert.ok(sent.every(m => m.excludeFromContext === true));
  } finally { activity.dispose(); if(before === undefined)delete globalThis[HEALTH];else globalThis[HEALTH] = before; }
});

test('intelligence markers use one 60-second dedupe window per component', () => {
  const sent = [], activity = createActivityIndicators(message => sent.push(message));
  const now = Date.now;
  let time = 100_000;
  Date.now = () => time;
  try {
    activity.note('ml.needle.call', { count: 1 });
    time += 46_000; activity.note('ml.needle.call', { count: 1 });
    assert.equal(sent.length, 1, 'the previous 45-second default would have emitted twice');
    time += 14_000; activity.note('ml.needle.call', { count: 1 });
    assert.equal(sent.length, 2);
  } finally { Date.now = now; activity.dispose(); }
});

 test('semantic identifier typo recovery emits only after a real fuzzy result', () => {
  const rows = [], previous = globalThis[HEALTH];
  globalThis[HEALTH] = (kind, data) => rows.push({ kind, data });
  try {
    assert.deepEqual(identifierTerms(['parser'], new Map([['parser', true]])), [{ token: 'parser', weight: 1 }]);
    assert.equal(rows.length, 0);
    assert.equal(identifierTerms(['parsre'], new Map([['parser', true]]))[0].token, 'parser');
    assert.deepEqual(rows, [{ kind: 'ml.fuzzy.used', data: { count: 1 } }]);
  } finally { if(previous === undefined)delete globalThis[HEALTH];else globalThis[HEALTH] = previous; }
});
