import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find((dir) => fs.existsSync(path.join(dir, 'extensions/pi-subagents/src/extension/double-runner.ts')));
if (!agent) throw new Error('Double runner source is missing');
const extension = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/extension/')).href;
const { registerDoubleMode, DOUBLE_RUNNER, DOUBLE_PROGRESS, DOUBLE_LIMITS } =
  await import(extension + 'double-runner.ts');

const PI_DOUBLE = process.env.PI_DOUBLE;
// Forking reads the parent session file, so a session with history has one on disk; a brand-new session does not yet.
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'double-runner-session-'));
after(() => fs.rmSync(SESSION_DIR, { recursive: true, force: true }));
const persistedSession = () => {
  const file = path.join(SESSION_DIR, 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
};
beforeEach(() => {
  if (PI_DOUBLE === undefined) delete process.env.PI_DOUBLE;
  else process.env.PI_DOUBLE = PI_DOUBLE;
  delete process.env.PI_SUBAGENT_CHILD;
});

const makePi = () => {
  const handlers = new Map();
  const pi = {
    handlers,
    commands: new Map(),
    renderers: new Map(),
    entries: [],
    sends: [],
    statuses: [],
    notifies: [],
    activeTools: ['subagent'],
    thinkingLevel: 'medium',
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    registerCommand(name, def) { pi.commands.set(name, def); },
    registerMessageRenderer(type, fn) { pi.renderers.set(type, fn); },
    appendEntry(type, data) { pi.entries.push({ type: 'custom', customType: type, data }); },
    sendMessage(message, options) {
      pi.sends.push({ message, options });
      return Promise.resolve();
    },
    getActiveTools() { return [...pi.activeTools]; },
    getThinkingLevel() { return pi.thinkingLevel; },
  };
  return pi;
};

const makeCtx = (pi, overrides = {}) => {
  const session = {
    id: 'session-1',
    file: persistedSession(),
    ...(overrides.session ?? {}),
  };
  return {
    model: { provider: 'openrouter', id: 'glm-5.3-flash' },
    cwd: '/work/proj',
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getLeafId: () => 'leaf-1',
      getEntries: () => pi.entries,
    },
    signal: new AbortController().signal,
    ui: {
      notify: (text, level) => pi.notifies.push({ text, level }),
      setStatus: (key, text) => pi.statuses.push({ key, text }),
    },
    ...overrides.ctx,
    _session: session,
  };
};

const fire = (pi, event, payload, ctx) =>
  Promise.all((pi.handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));

const okResult = (text, extra = {}) => ({
  details: { results: [{ exitCode: 0, output: text, usage: { input: 10, output: 20 }, ...extra }] },
});
const failResult = (error = 'boom') => ({ details: { results: [{ exitCode: 1, error }] } });

const ANALYSIS_A = 'Conclusions — migrate theauth module.\nProposed actions — 1. read src/auth.ts (read-only).';
const ANALYSIS_B = 'Conclusions — wrap the auth module.\nProposed actions — 1. read src/auth.ts (read-only).';
const RECONCILED = 'Directive — migrate behind a wrapper.\nReconciliation — agreed on reading first.';

const kindOf = (params) => {
  const task = params.task ?? '';
  if (task.includes('reconciling two independent')) return 'reconcile';
  if (task.includes('You are Double instance A;')) return 'A';
  if (task.includes('You are Double instance B;')) return 'B';
  return 'unknown';
};

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('Stop during reconciliation cancels the owner and emits no directive', async () => {
  const pi = makePi();
  const abort = new AbortController();
  let reconciled = false;
  registerDoubleMode(pi, { warmWaitMs: 0, launch: async (_id, params) => {
    if (kindOf(params) === 'reconcile') { reconciled = true; abort.abort(); return okResult(RECONCILED); }
    return okResult(kindOf(params) === 'A' ? ANALYSIS_A : ANALYSIS_B);
  } });
  const ctx = makeCtx(pi, { ctx: { signal: abort.signal } });
  await pi.commands.get('double').handler('on', ctx);
  const [reply] = await fire(pi, 'before_agent_start', { prompt: 'Fix the login flow' }, ctx);
  assert.equal(reconciled, true);
  assert.equal(reply, undefined);
});

for (const boundary of ['off', 'session_tree']) test(`Double ${boundary} cancels both running streams promptly`, async () => {
  const pi = makePi();
  const entered = deferred();
  const signals = [];
  registerDoubleMode(pi, { warmWaitMs: 0, launch: async (_id, _params, signal) => {
    signals.push(signal);
    if (signals.length === 2) entered.resolve();
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(failResult('cancelled')), { once: true }));
  } });
  const ctx = makeCtx(pi);
  await pi.commands.get('double').handler('on', ctx);
  const work = fire(pi, 'before_agent_start', { prompt: 'Fix the login flow' }, ctx);
  await entered.promise;
  if (boundary === 'off') await pi.commands.get('double').handler('off', ctx);
  else await fire(pi, boundary, {}, ctx);
  const cancelled = signals.every(signal => signal.aborted);
  // Always clean up the test, including the counterexample on old code.
  globalThis[DOUBLE_RUNNER].dispose();
  await work;
  assert.equal(cancelled, true);
});

test('the /double command toggles, reports status and persists within the session', async () => {
  const pi = makePi();
  registerDoubleMode(pi, { launch: async () => ({}) });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const command = pi.commands.get('double');
  assert.ok(command, 'double command is registered');
  await command.handler('', ctx);
  assert.match(pi.notifies.at(-1).text, /Double mode: ON\nTwin first-pass \(A ∥ B\) \+ reconcile · openrouter\/glm-5\.3-flash/);
  await command.handler('', ctx);
  assert.equal(pi.notifies.at(-1).text, 'Double mode: OFF');
  await command.handler('status', ctx);
  assert.equal(pi.notifies.at(-1).text, 'Double mode: OFF');
  const modes = pi.entries.filter((entry) => entry.customType === 'double-mode-v1');
  assert.equal(modes.length, 2, 'status inspection writes no entry');
  await command.handler('on', ctx);
  assert.match(pi.notifies.at(-1).text, /Double mode: ON/);
  await command.handler('nonsense', ctx);
  assert.match(pi.notifies.at(-1).text, /expected/);
  // A resumed session restores the last persisted toggle.
  const revived = makePi();
  revived.entries.push(...pi.entries);
  registerDoubleMode(revived, { launch: async () => ({}) });
  const ctx2 = makeCtx(revived);
  await fire(revived, 'session_start', { reason: 'resume' }, ctx2);
  await revived.commands.get('double').handler('status', ctx2);
  assert.match(revived.notifies.at(-1).text, /Double mode: ON/);
});

test('a disabled turn passes through untouched', async () => {
  const pi = makePi();
  let launches = 0;
  registerDoubleMode(pi, { launch: async () => { launches++; return {}; } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Do it.', systemPrompt: 'sys' }, ctx);
  assert.equal(result, undefined);
  assert.equal(launches, 0);
});

test('an enabled turn doubles the pinned route concurrently, reconciles and injects one directive', async () => {
  const pi = makePi();
  const calls = [];
  const gates = { A: deferred(), B: deferred(), reconcile: deferred() };
  registerDoubleMode(pi, {
    warmWaitMs: 0,
    launch: async (id, params) => {
      calls.push({ id, params });
      return gates[kindOf(params)].promise;
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const pending = fire(pi, 'before_agent_start', {
    prompt: 'Fix the login redirect.',
    systemPrompt: 'Be helpful.',
    systemPromptOptions: { skills: ['plan', { name: 'review' }, 7] },
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Both streams launched before either finished: genuinely concurrent.
  assert.deepEqual(calls.map((call) => kindOf(call.params)).sort(), ['A', 'B']);
  for (const call of calls) {
    assert.equal(call.params.model, 'openrouter/glm-5.3-flash:medium', 'same route, never substituted, thinking pinned as the model suffix the executor honors');
    assert.equal(call.params.thinking, undefined, 'the subagent tool has no per-run thinking field; a stray one is silently ignored');
    assert.equal(call.params.context, 'fork', 'full session context');
    assert.equal(call.params.modelOrigin, 'explicit');
    assert.deepEqual(call.params.capabilityCeiling.allowedTools, ['read', 'grep', 'find', 'ls', 'git_info']);
    assert.ok(call.params.task.includes('Fix the login redirect.'));
    assert.ok(call.params.task.includes('Available skills: plan, review'));
  }
  assert.notEqual(calls[0].params.task, calls[1].params.task, 'stream identity differs');
  let shared = 0;
  while (shared < calls[0].params.task.length && calls[0].params.task[shared] === calls[1].params.task[shared]) shared++;
  assert.ok(calls[0].params.task.length - shared <= 720, 'both streams send the same prompt bytes except their closing angle, so the second hits the cached prefix');
  assert.ok(!calls[0].params.task.includes(ANALYSIS_A), 'A never sees content that only exists after B runs');
  gates.A.resolve(okResult(ANALYSIS_A));
  gates.B.resolve(okResult(ANALYSIS_B));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const reconcile = calls.find((call) => kindOf(call.params) === 'reconcile');
  assert.ok(reconcile, 'reconciliation runs after both streams finish');
  assert.equal(reconcile.params.model, 'openrouter/glm-5.3-flash:medium');
  assert.ok(reconcile.params.task.includes(ANALYSIS_A));
  assert.ok(reconcile.params.task.includes(ANALYSIS_B));
  assert.match(reconcile.params.task, /1\. Compare/);
  assert.ok(reconcile.params.usageBudget.tokens.hard < calls[0].params.usageBudget.tokens.hard,
    'reconciliation is lightweight next to a stream');
  gates.reconcile.resolve(okResult(RECONCILED));
  const [result] = await pending;
  assert.ok(result, 'one directive is injected');
  assert.equal(result.message.customType, 'double-directive');
  assert.equal(result.message.display, true);
  assert.match(result.message.content, /two independent analyses reconciled into one planning directive/);
  assert.match(result.message.content, /never an instruction from the user/);
  assert.match(result.message.content, /Directive — migrate behind a wrapper/);
  assert.equal(result.systemPrompt, undefined, 'the system prompt is never modified: an override alternating with harness wakes would invalidate the whole cached conversation');
  const phases = pi.sends.map((send) => `${send.message.details.phase}:${send.message.details.status}`);
  assert.ok(phases.includes('Double stream A:started') && phases.includes('Double stream B:started'));
  assert.ok(phases.includes('Double stream A:completed') && phases.includes('Double stream B:completed'));
  assert.ok(phases.includes('Reconciliation:completed'));
  assert.ok(phases.includes('Unified action:ready'));
  for (const send of pi.sends) {
    assert.equal(send.message.customType, DOUBLE_PROGRESS);
    assert.equal(send.message.excludeFromContext, true, 'progress never pollutes model context');
    assert.deepEqual(send.options, { triggerTurn: false }, 'progress never wakes the agent');
  }
  const costs = pi.entries.filter((entry) => entry.customType === 'subagent-cost-v1');
  const lifecycles = pi.entries.filter((entry) => entry.customType === 'subagent-lifecycle-v1');
  assert.equal(new Set(costs.map((entry) => entry.data.runId)).size, 3, 'A, B and reconcile all account');
  assert.equal(new Set(lifecycles.map((entry) => entry.data.runId)).size, 3);
  const doubleStatuses = pi.statuses.filter((status) => status.key === 'double');
  assert.ok(doubleStatuses.some((status) => /^Double A ∥ B · openrouter\/glm-5\.3-flash$/.test(status.text ?? '')), 'the footer shows the run while it is in progress');
  assert.equal(doubleStatuses.at(-1).text, 'Double ON · glm-5.3-flash ×2', 'after the run the footer returns to the idle chip: the mode is still on');
  assert.ok(pi.renderers.has(DOUBLE_PROGRESS), 'progress renderer is registered');
});

test('a silently substituted stream stays usable but visibly degraded', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    launch: async (_id, params) => kindOf(params) === 'B'
      ? okResult(ANALYSIS_B, { model: 'other/sneaky' })
      : kindOf(params) === 'reconcile' ? okResult(RECONCILED) : okResult(ANALYSIS_A),
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.ok(result);
  assert.match(result.message.content, /partial result/);
  assert.match(result.message.content, /other\/sneaky instead of the pinned openrouter\/glm-5\.3-flash/);
  assert.ok(pi.sends.some((send) => send.message.details.status === 'ready · partial'));
});

test('a substituted reconciliation stays usable but degrades the directive', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    launch: async (_id, params) => kindOf(params) === 'reconcile'
      ? okResult(RECONCILED, { model: 'other/sneaky' })
      : kindOf(params) === 'A' ? okResult(ANALYSIS_A) : okResult(ANALYSIS_B),
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.ok(result);
  assert.match(result.message.content, /partial result/);
  assert.match(result.message.content, /Double reconciliation ran on other\/sneaky/);
  assert.ok(pi.sends.some((send) => send.message.details.status === 'completed · route substituted'));
});

test('a deterministic failure never retries', async () => {
  const pi = makePi();
  let bCalls = 0;
  registerDoubleMode(pi, {
    launch: async (_id, params) => {
      const kind = kindOf(params);
      if (kind === 'B') { bCalls++; return failResult('Tool budget blocked: no calls remain'); }
      if (kind === 'reconcile') return okResult(RECONCILED);
      return okResult(ANALYSIS_A);
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.equal(bCalls, 1, 'deterministic failure runs once');
  assert.ok(!pi.sends.some((send) => send.message.details.status === 'retrying'), 'no retry announced');
  assert.ok(result);
  assert.match(result.message.content, /partial result/);
});

test('one failed stream retries once, then the turn continues on the survivor', async () => {
  const pi = makePi();
  const attempts = { A: 0, B: 0, reconcile: 0 };
  registerDoubleMode(pi, {
    launch: async (_id, params) => {
      const kind = kindOf(params);
      attempts[kind]++;
      if (kind === 'B') return failResult('provider 429');
      if (kind === 'reconcile') return okResult(RECONCILED);
      return okResult(ANALYSIS_A);
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.equal(attempts.B, 2, 'at most one relaunch');
  assert.equal(attempts.reconcile, 1, 'reconciliation still runs on the survivor');
  assert.ok(result);
  assert.match(result.message.content, /partial result/);
  assert.match(result.message.content, /provider 429/);
});

test('a stream that used its whole window is not relaunched into a shorter one', async () => {
  const pi = makePi();
  let clock = 0;
  let bCalls = 0;
  registerDoubleMode(pi, {
    now: () => clock,
    launch: async (_id, params) => {
      const kind = kindOf(params);
      if (kind === 'B') {
        bCalls++;
        clock += params.timeoutMs;
        return { details: { results: [{ exitCode: 1, timedOut: true, error: `Subagent timed out after ${params.timeoutMs}ms` }] } };
      }
      if (kind === 'reconcile') return okResult(RECONCILED);
      return okResult(ANALYSIS_A);
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.equal(bCalls, 1, 'a shorter relaunch cannot finish what the full window could not');
  const unavailable = pi.sends.find((send) => send.message.details.phase === 'Double stream B' && send.message.details.status === 'unavailable');
  assert.match(unavailable?.message.details.advice ?? '', /timed out/, 'the unavailable notice names its cause');
  assert.ok(result);
  assert.match(result.message.content, /partial result/);
});

test('an unavailable stream names its classified exit instead of child watchdog telemetry', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    launch: async (_id, params) => {
      const kind = kindOf(params);
      if (kind === 'B') return {
        content: [{ type: 'text', text: '{"type":"subagent.watchdog.status","runId":"r","phase":"idle"}' }],
        details: { results: [{ exitCode: 129, error: 'child-error', cause: { category: 'process-signal' } }] },
      };
      if (kind === 'reconcile') return okResult(RECONCILED);
      return okResult(ANALYSIS_A);
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  const advice = pi.sends.find((send) => send.message.details.phase === 'Double stream B' && send.message.details.status === 'unavailable')?.message.details.advice ?? '';
  assert.match(advice, /Underlying failure: process-signal \(exit 129\)/);
  assert.doesNotMatch(advice, /watchdog/);
});

test('a retry that recovers produces a clean directive', async () => {
  const pi = makePi();
  let aCalls = 0;
  registerDoubleMode(pi, {
    launch: async (_id, params) => {
      const kind = kindOf(params);
      if (kind === 'A') return ++aCalls === 1 ? failResult('timeout') : okResult(ANALYSIS_A);
      if (kind === 'reconcile') return okResult(RECONCILED);
      return okResult(ANALYSIS_B);
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.equal(aCalls, 2);
  assert.ok(result);
  assert.doesNotMatch(result.message.content, /partial result/);
});

test('two failed streams fall back to a normal single turn with a warning', async () => {
  const pi = makePi();
  registerDoubleMode(pi, { launch: async () => failResult('overloaded') });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.equal(result, undefined);
  assert.ok(pi.notifies.some((note) => note.level === 'warning' && /both streams unavailable/.test(note.text)));
});

test('a failed reconciliation falls back to both views with a commit instruction', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    launch: async (_id, params) => kindOf(params) === 'reconcile'
      ? failResult('synthesis blew up')
      : kindOf(params) === 'A' ? okResult(ANALYSIS_A) : okResult(ANALYSIS_B),
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  assert.ok(result);
  assert.match(result.message.content, /No reconciled directive is available/);
  assert.match(result.message.content, /migrate theauth module/);
  assert.match(result.message.content, /wrap the auth module/);
  assert.match(result.message.content, /commit to exactly one execution path/);
});

test('a session move mid-run suppresses the stale directive', async () => {
  const pi = makePi();
  const gate = deferred();
  registerDoubleMode(pi, { launch: async () => gate.promise });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const pending = fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 'sys' }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  ctx._session.id = 'session-2';
  gate.resolve(okResult('late'));
  const [result] = await pending;
  assert.equal(result, undefined);
});

test('guards: kill switch, empty prompt, missing model, missing capability, aborted signal', async () => {
  const pi = makePi();
  let launches = 0;
  registerDoubleMode(pi, { launch: async () => { launches++; return okResult('x'); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);

  process.env.PI_DOUBLE = 'off';
  assert.equal((await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 's' }, ctx))[0], undefined);
  delete process.env.PI_DOUBLE;
  assert.equal((await fire(pi, 'before_agent_start', { prompt: '   ', systemPrompt: 's' }, ctx))[0], undefined);
  const missing = makeCtx(pi, { ctx: { model: undefined } });
  assert.equal((await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 's' }, missing))[0], undefined);

  pi.activeTools = ['read'];
  const [noCap] = await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 's' }, ctx);
  assert.equal(noCap, undefined);
  assert.ok(pi.notifies.some((note) => note.level === 'warning' && /needs the subagent capability/.test(note.text)));
  pi.activeTools = ['subagent'];

  const aborted = new AbortController();
  aborted.abort();
  const cancelled = makeCtx(pi, { ctx: { signal: aborted.signal } });
  assert.equal((await fire(pi, 'before_agent_start', { prompt: 'Go.', systemPrompt: 's' }, cancelled))[0], undefined);
  assert.equal(launches, 0, 'no stream launches on guarded or cancelled turns');
});

test('an extension-sourced wake is not doubled, but the next user prompt is', async () => {
  const pi = makePi();
  let launches = 0;
  registerDoubleMode(pi, { launch: async () => { launches++; return okResult('x'); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);

  await fire(pi, 'input', { text: 'reminder fired', source: 'extension' }, ctx);
  const [woken] = await fire(pi, 'before_agent_start', { prompt: 'reminder fired', systemPrompt: 's' }, ctx);
  assert.equal(woken, undefined);
  assert.equal(launches, 0, 'no twin streams for the harness continuing its own work');

  await fire(pi, 'input', { text: 'Do the real task.', source: 'interactive' }, ctx);
  await fire(pi, 'before_agent_start', { prompt: 'Do the real task.', systemPrompt: 's' }, ctx);
  assert.ok(launches >= 2, 'a user prompt still launches both streams');
});

test('aborting the request signal mid-preflight cancels both streams and starts no reconciliation', async () => {
  const pi = makePi();
  const launched = [];
  registerDoubleMode(pi, {
    warmWaitMs: 0,
    launch: (id, params, signal) => {
      launched.push({ kind: kindOf(params), signal });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  const request = new AbortController();
  const ctx = makeCtx(pi, { ctx: { signal: request.signal } });
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const run = fire(pi, 'before_agent_start', { prompt: 'Do it.', systemPrompt: 's', signal: request.signal }, ctx);
  while (launched.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  request.abort();
  const [result] = await run;
  assert.equal(result, undefined, 'no stale directive is returned');
  assert.deepEqual(launched.map((entry) => entry.kind).sort(), ['A', 'B'], 'reconciliation never starts');
  assert.ok(launched.every((entry) => entry.signal.aborted), 'both children were aborted');
});

test('limits keep reconciliation lightweight and the run bounded', () => {
  assert.ok(DOUBLE_LIMITS.synthesisMs < DOUBLE_LIMITS.streamMs);
  assert.ok(DOUBLE_LIMITS.tokensReconcile < DOUBLE_LIMITS.tokensPerStream);
  assert.ok(DOUBLE_LIMITS.toolsReconcile < DOUBLE_LIMITS.toolsPerStream);
  assert.ok(DOUBLE_LIMITS.deadlineMs >= DOUBLE_LIMITS.streamMs);
  assert.ok(Object.isFrozen(DOUBLE_LIMITS));
});

test('registration is a no-op inside a child process', () => {
  process.env.PI_SUBAGENT_CHILD = '1';
  try {
    const before = globalThis[DOUBLE_RUNNER];
    const pi = makePi();
    registerDoubleMode(pi, { launch: async () => ({}) });
    assert.equal(pi.commands.has('double'), false);
    assert.equal(pi.handlers.has('before_agent_start'), false);
    assert.equal(globalThis[DOUBLE_RUNNER], before);
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test('stream B starts on A\'s first progress so it can use the prefix A just cached', async () => {
  const pi = makePi();
  const calls = [];
  const gates = { A: deferred(), B: deferred(), reconcile: deferred() };
  let aProgress;
  registerDoubleMode(pi, {
    warmWaitMs: 5_000,
    launch: async (id, params, signal, onUpdate) => {
      const kind = kindOf(params);
      calls.push({ kind, at: Date.now() });
      if (kind === 'A') aProgress = onUpdate;
      return gates[kind].promise;
    },
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const pending = fire(pi, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 's' }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls.map((call) => call.kind), ['A'], 'B waits while A has made no progress');
  assert.equal(typeof aProgress, 'function', 'A reports progress through the executor callback');
  aProgress({ details: { progress: [{}] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.map((call) => call.kind), ['A', 'B'], 'B starts as soon as A reports progress');
  gates.A.resolve(okResult(ANALYSIS_A)); gates.B.resolve(okResult(ANALYSIS_B));
  await new Promise((resolve) => setTimeout(resolve, 20));
  gates.reconcile.resolve(okResult(RECONCILED));
  const [result] = await pending;
  assert.match(result.message.content, /Directive — migrate behind a wrapper/);
});

test('the warm wait is bounded and a stream that fails fast never holds the other back', async () => {
  const silent = makePi();
  const launches = [];
  const gate = deferred();
  registerDoubleMode(silent, { warmWaitMs: 60, launch: async (id, params) => { launches.push({ kind: kindOf(params), at: Date.now() }); return kindOf(params) === 'reconcile' ? okResult(RECONCILED) : gate.promise; } });
  const ctx = makeCtx(silent);
  await fire(silent, 'session_start', { reason: 'startup' }, ctx);
  await silent.commands.get('double').handler('', ctx);
  const pending = fire(silent, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 's' }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(launches.map((launch) => launch.kind), ['A']);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(launches.map((launch) => launch.kind), ['A', 'B'], 'a route that is silent until it finishes costs at most the bounded wait');
  assert.ok(launches[1].at - launches[0].at >= 55);
  gate.resolve(okResult(ANALYSIS_A));
  await pending;
  const fast = makePi();
  const order = [];
  registerDoubleMode(fast, { warmWaitMs: 60_000, launch: async (id, params) => { order.push(kindOf(params)); if (kindOf(params) === 'A') throw new Error('socket hang up'); return okResult(kindOf(params) === 'reconcile' ? RECONCILED : ANALYSIS_B); } });
  const fastCtx = makeCtx(fast);
  await fire(fast, 'session_start', { reason: 'startup' }, fastCtx);
  await fast.commands.get('double').handler('', fastCtx);
  const started = Date.now();
  const [result] = await fire(fast, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 's' }, fastCtx);
  assert.ok(Date.now() - started < 5_000, 'A failing opens the gate immediately instead of waiting out the bound');
  assert.ok(order.includes('B'));assert.ok(result, 'the survivor still produces a directive');
});

test('a bare acknowledgement continues single and says so once; real requests are still doubled', async () => {
  const pi = makePi();
  let launches = 0;
  registerDoubleMode(pi, { warmWaitMs: 0, launch: async (id, params) => { launches++; return okResult(kindOf(params) === 'reconcile' ? RECONCILED : ANALYSIS_A); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const noticesBefore = pi.notifies.length;
  for (const prompt of ['thanks!', 'Looks good', 'ok']) assert.equal((await fire(pi, 'before_agent_start', { prompt, systemPrompt: 's' }, ctx))[0], undefined, prompt);
  assert.equal(launches, 0, 'no stream, no reconciliation');
  assert.equal(pi.notifies.slice(noticesBefore).filter((note) => /acknowledgement/.test(note.text)).length, 1, 'said once, not per turn');
  const [real] = await fire(pi, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 's' }, ctx);
  assert.ok(real);assert.equal(launches, 3);
});

test('the user\'s own requirements anchor every stage and the directive stays subordinate to them', async () => {
  const pi = makePi();
  const tasks = [];
  registerDoubleMode(pi, { warmWaitMs: 0, launch: async (id, params) => { tasks.push({ kind: kindOf(params), task: params.task }); return okResult(kindOf(params) === 'reconcile' ? RECONCILED : ANALYSIS_A); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('', ctx);
  const prompt = 'Add a login redirect.\n- Do not modify auth.ts.\n- Keep the public API stable.';
  const [result] = await fire(pi, 'before_agent_start', { prompt, systemPrompt: 's' }, ctx);
  for (const { kind, task } of tasks) {
    assert.match(task, /Do not modify auth\.ts\./, `${kind} sees the requirement list`);
    assert.match(task, /Keep the public API stable\./, kind);
  }
  assert.ok(tasks.some((entry) => entry.kind === 'reconcile'));
  assert.match(result.message.content, /Requirements extracted from the user's words/);
  assert.ok(result.message.content.indexOf('Do not modify auth.ts.') < result.message.content.indexOf('Directive — migrate behind a wrapper'));
  assert.match(result.message.content, /their own messages \(this prompt, earlier prompts and any active goal\) and explicit constraints outrank it/);
});

test('the first prompt of a new session has no persisted file to fork, so the streams start fresh and still run', async () => {
  const pi = makePi();
  const calls = [];
  registerDoubleMode(pi, {
    warmWaitMs: 0,
    launch: async (id, params) => {
      calls.push(params);
      const kind = kindOf(params);
      return okResult(kind === 'reconcile' ? RECONCILED : kind === 'A' ? ANALYSIS_A : ANALYSIS_B);
    },
  });
  const ctx = makeCtx(pi, { session: { file: path.join(SESSION_DIR, 'not-written-yet.jsonl') } });
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('on', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 'Be helpful.' }, ctx);
  assert.ok(result, 'the directive still arrives');
  assert.deepEqual(calls.map(kindOf).sort(), ['A', 'B', 'reconcile']);
  for (const params of calls) {
    assert.equal(params.context, 'fresh', 'a fork needs the parent file, which does not exist yet');
    assert.ok(params.task.includes('Fix the login redirect.'), 'the request itself travels in the task');
  }
  assert.match(calls.find((params) => kindOf(params) === 'A').task, /first prompt, so there is no earlier conversation/);
  // Once the session has a file the very same runner forks again.
  const later = makeCtx(pi);
  await fire(pi, 'before_agent_start', { prompt: 'Now add a test.', systemPrompt: 'Be helpful.' }, later);
  assert.ok(calls.slice(3).length >= 2);
  for (const params of calls.slice(3)) assert.equal(params.context, 'fork');
});
