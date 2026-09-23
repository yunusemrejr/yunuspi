import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionRuntime, loadExtensionFromFactory } from '../core/coding-agent/src/core/extensions/loader.js';
import { createEventBus } from '../core/coding-agent/src/core/event-bus.js';
import { wrapToolDefinition } from '../core/coding-agent/src/core/tools/tool-definition-wrapper.js';
import { sessionObservability, withSessionObservability } from '../core/coding-agent/src/core/session-observability.js';
import { GuardianSupervisor, relayIntelligenceUsageFromChild } from '../core/coding-agent/dist/core/guardian/guardian-supervisor.js';
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
    assert.equal(a.messages.filter(m => m.details?.label === 'JEV').length, 0);
    assert.equal(b.messages.filter(m => m.details?.label === 'JEV').length, 1);
    release(); await pending;
    assert.equal(a.messages.filter(m => m.details?.label === 'JEV').length, 1);
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
    assert.equal(a.messages.filter(m => m.details?.label === 'Retrieval intelligence').length, 1);
    assert.equal(b.messages.filter(m => m.details?.label === 'Retrieval intelligence').length, 0);
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
    assert.equal(f.messages.filter(m => m.details?.label === 'JEV').length, 0);
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
    await Promise.resolve();
    assert.equal(sent.at(-1).details.label, 'Fuzzy matching');
    const options = { kind: 'skill', site: 'fixture', query: 'orbital mechanics', lexical: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] };
    await multiStageRetrieve({ ...options, needle: async () => ({ ok: false, reason: 'unavailable' }) });
    assert.equal(sent.length, 1);
    const result = await multiStageRetrieve({ ...options, needle: async () => ({ ok: true, cached: false, ms: 1, shadow: false,
      value: { ranked: [{ id: 'b', score: .99 }, { id: 'a', score: .5 }], margin: .49 } }) });
    assert.equal(result.applied, 'needle');
    await Promise.resolve();
    assert.equal(sent.at(-1).details.label, 'Retrieval intelligence');
    for (const kind of ['ml.jev.used', 'ml.needle.call', 'ml.mini.used', 'ml.smol.used']) activity.note(kind, { isError: true });
    assert.equal(sent.length, 2);
    assert.ok(sent.every(m => m.excludeFromContext === true));
  } finally { activity.dispose(); if(before === undefined)delete globalThis[HEALTH];else globalThis[HEALTH] = before; }
});

test('ML activity flows on every completion and only simultaneous bursts aggregate', async () => {
  const sent = [], activity = createActivityIndicators(message => sent.push(message));
  try {
    for (let i = 0; i < 30; i++) activity.note('ml.needle.call', { op: 'rank', count: 1, durationMs: 2, cached: false });
    await Promise.resolve();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.count, 30);
    assert.equal(sent[0].details.ms, 60);
    assert.match(sent[0].details.detail, /local WASM · rank ready · 30 completions/);
    for (let i = 0; i < 30; i++) { activity.note('ml.needle.call', { op: 'rank', count: 1, cached: true }); await Promise.resolve(); }
    assert.equal(sent.length, 31, 'neither the old 60s cooldown nor the generic 24/min cap hides meaningful completions');
    assert.match(sent.at(-1).details.detail, /cached embeddings · rank ready/);
    assert.ok(sent.every(message => message.excludeFromContext && message.display));
    activity.note('ml.evidence.delivered', { helper: 'smol', savedChars: 4096, count: 1, raw: 'PRIVATE-TEXT' });
    await Promise.resolve();
    assert.match(sent.at(-1).details.detail, /added to model context · 4096 characters saved/);
    assert.doesNotMatch(JSON.stringify(sent), /PRIVATE-TEXT/);
    activity.note('ml.evidence.returned', { helper: 'needle', savedChars: 5000, count: 1 });
    await Promise.resolve();
    assert.match(sent.at(-1).details.detail, /returned exact excerpts · 5000 characters omitted/);
    assert.doesNotMatch(sent.at(-1).details.detail, /model context/);
    activity.note('ml.jev.used', { cached: false, durationMs: 444, questions: 3 });
    await Promise.resolve();
    assert.match(sent.at(-1).details.detail, /remote judgment ready · 3 questions/);
    activity.note('ml.wasm.completed', { helper: 'source-check', runtime: 'tree-sitter-wasm', durationMs: 3, findings: 2 });
    await Promise.resolve();
    assert.match(sent.at(-1).details.detail, /local parse complete · 2 findings/);
    activity.note('ml.smol.offer', { decision: 'ineligible-source', reason: 'protected-content' });
    await Promise.resolve();
    assert.equal(sent.at(-1).details.status, 'skip');
    assert.match(sent.at(-1).details.detail, /skipped · protected content/);
    const count = sent.length;
    activity.note('ml.needle.call', { count: 1 }); activity.reset(); await Promise.resolve();
    assert.equal(sent.length, count, 'queued prior-session events are discarded');
    activity.note('ml.needle.call', { count: 1 }); activity.dispose(); await Promise.resolve();
    assert.equal(sent.length, count, 'shutdown discards pending activity');
  } finally { activity.dispose(); }
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


test('loaded child health events relay bounded stages promptly only for their live Guardian owner', async () => {
  const channel = fs.mkdtempSync(path.join(os.tmpdir(), 'intelligence-relay-'));
  const env = { PI_SUBAGENT_CHILD: '1', PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: channel, PI_SUBAGENT_RUN_ID: 'fixture-run',
    PI_SUBAGENT_CHILD_AGENT: 'fixture-reviewer', PI_SUBAGENT_CHILD_INDEX: '0', PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: 'fixture-parent' };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const f = await fixture();
  const guardian = new GuardianSupervisor({ sessionId: 'same-id', sessionOwner: f.ctx.sessionManager, cwd: f.ctx.cwd });
  const records = () => fs.readdirSync(path.join(channel, 'requests')).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(channel, 'requests', file), 'utf8')));
  try {
    for (let i = 0; i < 3; i++) await f.emit('tool_call', { toolCallId: `fixture-${i}`, toolName: 'probe' });
    assert.equal(records().length, 3, 'separate completions are not hidden for 60 seconds');
    assert.equal(f.messages.length, 0, 'child transcript does not duplicate relayed display-only events');
    assert.ok(records().every(record => record.reason === 'intelligence_used' && /JEV · remote · result ready/.test(record.message)));
    assert.equal(relayIntelligenceUsageFromChild({ name: 'JEV', sessionId: 'same-id', ownerId: 'forged' }), false);
    withSessionObservability(f.ctx, () => {
      for (let i = 0; i < 3; i++) sessionObservability()[HEALTH]('ml.evidence.delivered', { helper: 'smol', savedChars: 1000, count: 1 });
    });
    await Promise.resolve();
    assert.equal(records().length, 4);
    assert.match(records().find(record => /Smol/.test(record.message)).message, /added to model context · 3 completions · 3000 characters saved/);
    guardian.dispose();
    await f.emit('tool_call', { toolCallId: 'after-owner-disposal', toolName: 'probe' });
    assert.equal(records().length, 4, 'a late child cannot relay after its owner was disposed');
  } finally {
    guardian.dispose(); await f.close(); fs.rmSync(channel, { recursive: true, force: true });
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
