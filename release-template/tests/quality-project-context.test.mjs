import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
let agent = path.join(release, 'agent');
try { await fs.access(agent); } catch { agent = path.resolve(release, '..'); }
let coreInterventionPath = path.join(release, 'core/coding-agent/src/core/intervention-session.js');
try { await fs.access(coreInterventionPath); } catch { coreInterventionPath = path.join(path.resolve(release, '..'), 'core/coding-agent/src/core/intervention-session.js'); }
const coreIntervention = pathToFileURL(coreInterventionPath).href;
// Only the SDK's configuration lookup is substituted. The extension, client,
// worker, discovery and SQLite store all execute their actual implementations.
const config = 'data:text/javascript,' + encodeURIComponent(`export const getAgentDir=()=>process.env.PI_CODING_AGENT_DIR; export { createInterventionSession } from ${JSON.stringify(coreIntervention)};`);
register('data:text/javascript,' + encodeURIComponent(`export function resolve(n,c,next){return n==='@yunuspi/coding-agent'?{url:${JSON.stringify(config)},shortCircuit:true}:next(n,c);}`), import.meta.url);
const { default: projectIntelligence } = await import(pathToFileURL(path.join(agent, 'extensions/project-intelligence.ts')));
const { IntelligenceClient } = await import(pathToFileURL(path.join(agent, 'extensions/lib/project-intelligence/client.mjs')));
const { openStore } = await import(pathToFileURL(path.join(agent, 'extensions/lib/project-intelligence/store.mjs')));
const key = Symbol.for('yunus-pi.quality-project-context.v1');
const read = { action: 'read', files: ['README.md'], task: 'Review content quality' };
const sample = { action: 'record', samples: [{ aspect: 'content', outcome: 'changes' }] };

async function fixture(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-public-graph-'));
  const prior = process.env.PI_CODING_AGENT_DIR, priorService = globalThis[key];
  process.env.PI_CODING_AGENT_DIR = path.join(temp, 'agent');
  const cwd = path.join(temp, 'project'), other = path.join(temp, 'other');
  await fs.mkdir(cwd); await fs.mkdir(other);
  await fs.writeFile(path.join(cwd, 'README.md'), 'Fixture project architecture');
  const opened = [];
  const ctxFor = (id, root = cwd) => ({ cwd: root, sessionManager: { getSessionId: () => id }, ui: { notify() {} } });
  function open(id, root = cwd) {
    const hooks = new Map();
    projectIntelligence({ on: (n, fn) => hooks.set(n, fn), registerTool() {}, registerCommand() {}, appendEntry() {} });
    const service = globalThis[key], ctx = ctxFor(id, root);
    opened.push(hooks);
    return { hooks, ctx, service, call: (request, signal) => service(request, ctx, signal) };
  }
  try { await run({ temp, cwd, other, ctxFor, open }); }
  finally {
    await Promise.allSettled(opened.map(h => h.get('session_shutdown')()));
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (priorService === undefined) delete globalThis[key]; else globalThis[key] = priorService;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
}

test('quality context uses real graph workers and returns only prior-session category history from the same checkout', () => fixture(async ({ open, other }) => {
  const first = open('first');
  await first.call(sample);
  await first.call({ action: 'record', samples: [{ aspect: 'content', outcome: 'pass' }] });
  assert.equal((await first.call(read)).history.length, 0);
  const second = open('second'), result = await second.call(read);
  assert.equal(typeof result.graph, 'string');
  assert.equal(result.history.length, 1);
  assert.deepEqual(Object.keys(result.history[0]).sort(), ['aspect', 'at', 'hadChanges', 'outcome']);
  assert.equal(result.history[0].outcome, 'pass');
  assert.equal(result.history[0].hadChanges, true);
  assert.doesNotMatch(JSON.stringify(result.history), /first|Fixture|README/);
  assert.deepEqual((await open('third', other).call(read)).history, []);
}));

// Hold one real worker response after it completes. This models a late result
// even when the worker has already removed its AbortSignal listener.
function holdResponse(matches) {
  const original = IntelligenceClient.prototype.request;
  let used = false, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  IntelligenceClient.prototype.request = function(op, payload, options) {
    const result = original.call(this, op, payload, options);
    if (used || !matches(op, payload)) return result;
    used = true;
    return result.then(async value => { started(); await gate; return value; });
  };
  return { began, release, restore() { release(); IntelligenceClient.prototype.request = original; } };
}

test('switches during initialization, graph reads and history writes cannot publish old results into a replacement session', () => fixture(async ({ open, ctxFor, other }) => {
  for (const operation of ['init', 'query', 'review_history']) {
    const session = open('old-' + operation);
    const held = holdResponse((op, payload) => op === operation && (op !== 'query' || payload.query.includes('WAIT_FOR_SWITCH')));
    try {
      const request = operation === 'query' ? { ...read, task: 'WAIT_FOR_SWITCH' } : sample;
      const pending = session.call(request);
      const rejected = assert.rejects(pending, /session changed|session closed/i);
      await held.began;
      const next = ctxFor('replacement-' + operation, other);
      session.hooks.get('session_switch')({}, next);
      held.release(); await rejected;
      assert.deepEqual((await session.service(read, next)).history, []);
    } finally { held.restore(); }
  }
}));

test('aborted quality requests cannot return delayed graph results or initialize a worker after cancellation', () => fixture(async ({ open }) => {
  const session = open('cancelled'), controller = new AbortController();
  const held = holdResponse((op, payload) => op === 'query' && payload.query.includes('WAIT_FOR_ABORT'));
  try {
    const pending = session.call({ ...read, task: 'WAIT_FOR_ABORT' }, controller.signal);
    const rejected = assert.rejects(pending, /quality cancelled/);
    await held.began; controller.abort(Error('quality cancelled')); held.release(); await rejected;
    await assert.rejects(session.call(sample, controller.signal), /quality cancelled/);
  } finally { held.restore(); }
}));

test('history remains bounded and checkout-scoped, preserves discovered defects, and rejects unknown categories', () => fixture(async ({ temp }) => {
  const store = openStore(path.join(temp, 'history.sqlite'));
  try {
    store.reviewHistory('checkout-a', 'first', [{ aspect: 'content', outcome: 'changes', prose: 'TEST_DO_NOT_STORE' }]);
    store.reviewHistory('checkout-a', 'first', [{ aspect: 'content', outcome: 'pass' }]);
    assert.equal(store.reviewHistory('checkout-a', 'second')[0].hadChanges, true);
    assert.deepEqual(store.reviewHistory('checkout-b', 'second'), []);
    for (let i = 0; i < 90; i++) store.reviewHistory('checkout-a', 'peer-' + i, [{ aspect: 'content', outcome: 'unknown' }]);
    assert.equal(store.reviewHistory('checkout-a', 'last').length, 20);
    assert.throws(() => store.reviewHistory('checkout-a', 'last', [{ aspect: 'private prose', outcome: 'pass' }]), /Invalid review/);
    assert.doesNotMatch(JSON.stringify(store.getMeta('quality-review:checkout-a')), /TEST_DO_NOT_STORE|prose/);
  } finally { store.close(); }
}));

test('project context keeps unchanged evidence anchored across synthetic tool requests without persisting it', () => fixture(async ({ open }) => {
  const session = open('cache-prefix');
  await session.call(read);
  const user = { role: 'user', content: 'Inspect the README' };
  const context = messages => session.hooks.get('context')({ messages }, session.ctx);
  const first = await context([user]);
  assert.equal(first.messages.at(-1).customType, 'project-intelligence-context');
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'README.md' } }] };
  const result = { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'Fixture project architecture' }] };
  const next = await context([user, call, result]);
  assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(next.messages.slice(first.messages.length), [call, result]);
  const repeated = await context(next.messages);
  assert.deepEqual(repeated.messages, next.messages, 'reprocessing wire context cannot duplicate the capsule');
}));
