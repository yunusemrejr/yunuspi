// Jev-backed thinking-level routing: pure policy, the shared typed decision,
// and the cost-governor wiring. Transport is mocked; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const effort = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/effort-policy.mjs')).href);
const jev = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/jev-client.ts')).href);
const decisions = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/micro-intelligence/jev-decisions.ts')).href);
const extensionUrl = pathToFileURL(path.join(root, 'agent/extensions/cost-governor.ts')).href;

const savedEnv = { ...process.env };
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-effort-test-'));
process.env.OPENROUTER_API_KEY = 'sk-or-test';
process.env.PI_COST_BUDGET_USD = 'off';
process.env.PI_JEV = 'off';
delete process.env.PI_OFFLINE;
delete process.env.PIJEV_EFFORT;
delete process.env.PI_CONTEXT_GOVERNOR;

const HEALTH = Symbol.for('yunus-pi.health.v1');
const ANSWERS = (simple = 0.94, deep = 0.04) => ({
  simple: { type: 'noul', noul: simple },
  deep: { type: 'noul', noul: deep },
});

function mockJev(handler = async () => ({ model: 'typesafe/jev-1.14-20261014', answers: ANSWERS(), usage: { input_tokens: 30, cost: 0.00000126 } })) {
  const calls = [];
  jev.resetJevClient();
  jev.configureJevClient({
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      calls.push(JSON.parse(options.body));
      const answer = await handler(JSON.parse(options.body));
      if (answer?.status) return { ok: false, status: answer.status, text: async () => String(answer.body ?? ''), json: async () => ({}) };
      return { ok: true, status: 200, json: async () => answer };
    },
    now: () => Date.now(),
    schedule: () => ({}),
    openMs: 50,
    requestTimeoutMs: 5_000,
  });
  return calls;
}

function fakePi(initial = 'high') {
  const hooks = new Map();
  const entries = [];
  let thinking = initial;
  const pi = {
    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry(type, data) { entries.push({ type, data }); },
    getThinkingLevel() { return thinking; },
    setThinkingLevel(level) {
      const previous = thinking;
      thinking = level;
      for (const handler of hooks.get('thinking_level_select') ?? []) handler({ type: 'thinking_level_select', level, previousLevel: previous });
    },
  };
  return { pi, hooks, entries, thinking: () => thinking };
}

function fakeCtx(overrides = {}) {
  const notifications = [];
  return {
    hasUI: true,
    ui: { notify: (text, kind) => notifications.push({ text, kind }) },
    model: { provider: 'deepseek', id: 'deepseek-flash', reasoning: true, contextWindow: 1_000_000, cost: { input: 0.3, cacheRead: 0.006 } },
    sessionManager: { getSessionId: () => 'jev-effort-session', getBranch: () => [] },
    cwd: root,
    notifications,
    ...overrides,
  };
}

async function start(overrides) {
  const saved = process.env.PI_JEV;
  process.env.PI_JEV = 'on';
  const { default: register } = await import(extensionUrl);
  const f = fakePi(overrides?.initial);
  register(f.pi);
  const ctx = fakeCtx(overrides?.ctx);
  const health = [];
  const previous = globalThis[HEALTH];
  globalThis[HEALTH] = (kind, data) => health.push({ kind, data });
  for (const handler of f.hooks.get('session_start') ?? []) handler({ type: 'session_start' }, ctx);
  const turn = async (text, systemPrompt = 'system prompt '.repeat(600)) => {
    for (const handler of f.hooks.get('input') ?? []) handler({ type: 'input', source: 'interactive', text }, ctx);
    for (const handler of f.hooks.get('before_agent_start') ?? []) await handler({ type: 'before_agent_start', prompt: text, systemPrompt }, ctx);
  };
  const usage = (promptTokens) => {
    for (const handler of f.hooks.get('message_end') ?? []) handler({
      type: 'message_end',
      message: { role: 'assistant', usage: { input: 100, output: 50, cacheRead: Math.max(0, promptTokens - 100), cacheWrite: 0, reasoning: 0, cost: { total: 0.0001 } } },
    }, ctx);
  };
  const cleanup = () => {
    if (previous === undefined) delete globalThis[HEALTH]; else globalThis[HEALTH] = previous;
    if (saved === undefined) delete process.env.PI_JEV; else process.env.PI_JEV = saved;
  };
  return { ...f, ctx, health, turn, usage, cleanup };
}

test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('classification sends goal rounds, complex work and long input to the ceiling', () => {
  assert.equal(effort.classifyEffortRequest('[goal gabc, continuation 2/6] keep working').kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest('Boosts in force — 3D + Video').kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest('debug the parser race condition').kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest('migrate the authentication billing flow').kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest(`${'long request '.repeat(200)}`).kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest('```ts\nconst x = 1\n```').kind, 'ceiling');
  assert.equal(effort.classifyEffortRequest('ok').kind, 'inherit');
  assert.equal(effort.classifyEffortRequest('what does the json flag mean').kind, 'judge');
  assert.equal(effort.classifyEffortRequest('please implement a new feature').kind, 'judge');
});

test('only two agreeing Jev scores authorize a tier; the level is clamped by ceiling and never off', () => {
  assert.equal(effort.interpretEffortAnswers({ simple: { noul: 0.95 }, deep: { noul: 0.05 } }).tier, 'easy');
  assert.equal(effort.interpretEffortAnswers({ simple: { noul: 0.65 }, deep: { noul: 0.28 } }).tier, 'moderate');
  assert.equal(effort.interpretEffortAnswers({ simple: { noul: 0.6 }, deep: { noul: 0.55 } }).ok, false);
  assert.equal(effort.interpretEffortAnswers({ simple: { noul: 0.95 } }).ok, false, 'a missing score is not evidence');
  assert.equal(effort.effortLevelForTier('easy', 'high', { shortPlain: true }), 'minimal');
  assert.equal(effort.effortLevelForTier('easy', 'high'), 'low');
  assert.equal(effort.effortLevelForTier('moderate', 'max'), 'medium');
  assert.equal(effort.effortLevelForTier('easy', 'minimal'), 'minimal', 'never below the configured ceiling');
  assert.equal(effort.effortLevelForTier('easy', 'off'), 'off', 'off stays off; never a mode flip');
});

test('the cache gate allows raises and only cheap demotions', () => {
  assert.equal(effort.gateEffortSwitch('high', 'low', 999_999).level, 'high', 'a raise always passes');
  assert.equal(effort.gateEffortSwitch('low', 'high', 1_000).level, 'low');
  assert.equal(effort.gateEffortSwitch('low', 'high', 9_000).level, 'high');
  assert.equal(effort.gateEffortSwitch('low', 'high', 9_000).gated, 'cache');
  assert.equal(effort.effortMissTokens('low', new Map([['low', 5_000]]), 12_000), 7_000);
  assert.equal(effort.effortMissTokens('low', new Map(), 12_000), 12_000);
});

test('the shared typed decision returns a tier from the Jev scores', async () => {
  const judged = await decisions.askTypedDecision('effort-tier', { state: { request: 'what does the json flag mean' } }, {
    judge: async () => ({ ok: true, answers: ANSWERS(), usage: { model: 'typesafe/jev-1.14-20261014', inputTokens: 40, costUsd: 0.000001, ms: 3, cached: false } }),
  });
  assert.equal(judged.ok, true);
  assert.equal(judged.verdict.tier, 'easy');
  const ambiguous = await decisions.askTypedDecision('effort-tier', { state: { request: 'maybe change this' } }, {
    judge: async () => ({ ok: true, answers: ANSWERS(0.6, 0.55), usage: { model: 'x', inputTokens: 1, ms: 1, cached: false } }),
  });
  assert.equal(ambiguous.ok, false);
});

test('a simple human turn steps down through Jev and the next complex turn restores the ceiling', async () => {
  const calls = mockJev();
  const f = await start();
  try {
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'minimal', 'a short judged-simple turn steps down from high');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, '~typesafe/jev-latest', 'the latest alias is requested');
    assert.ok(f.health.some(event => event.kind === 'effort.change' && event.data.to === 'minimal'));
    assert.ok(f.entries.some(entry => entry.type === 'jev-effort-v1' && entry.data.autoLevel === 'minimal'));

    await f.turn('debug the parser race condition and migrate the loader');
    assert.equal(f.thinking(), 'high', 'a complex turn restores the configured ceiling without asking Jev');
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test('a subagent child judges its own task: it starts at the session ceiling and steps down for an easy task', async () => {
  const calls = mockJev();
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = '1';
  const f = await start();
  try {
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'minimal', 'the child steps down exactly like a main-session turn');
    assert.equal(calls.length, 1);
  } finally {
    f.cleanup();
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous;
  }
});

test('an ambiguous answer, a failed judge or a goal round never changes the level', async () => {
  const ambiguous = mockJev(async () => ({ model: 'typesafe/jev-1.14-20261014', answers: ANSWERS(0.62, 0.5), usage: { input_tokens: 10, cost: 0 } }));
  let f = await start();
  try {
    await f.turn('maybe tidy this up somehow');
    assert.equal(f.thinking(), 'high');
    assert.equal(ambiguous.length, 1);
  } finally { f.cleanup(); }

  const failed = mockJev(async () => ({ status: 500, body: 'upstream error' }));
  f = await start();
  try {
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'high', 'a failed judge keeps the configured ceiling');
    assert.equal(failed.length, 2, 'the failing Jev route and its Kev failover both failed');
  } finally { f.cleanup(); }

  const goal = mockJev();
  f = await start();
  try {
    await f.turn('[goal gabc, continuation 1/6] do the remaining work');
    assert.equal(f.thinking(), 'high');
    assert.equal(goal.length, 0, 'goal rounds are not judged');
  } finally { f.cleanup(); }
});

test('a costly re-read holds the ceiling and is reported as an effort hold', async () => {
  const calls = mockJev();
  const f = await start();
  try {
    await f.turn('debug the parser race condition');
    f.usage(60_000);
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'high', 'a demotion that would re-read the whole warm prefix is refused');
    assert.ok(f.health.some(event => event.kind === 'effort.held' && /jev step to minimal/.test(event.data.reason)));
    assert.equal(calls.length, 1, 'the judge still answered; only the change was gated');
  } finally { f.cleanup(); }
});

test('a manual thinking selection wins for the rest of the session', async () => {
  const calls = mockJev();
  const f = await start();
  try {
    await f.turn('debug the parser race condition');
    f.usage(1_000);
    f.pi.setThinkingLevel('medium');
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'medium');
    assert.equal(calls.length, 0, 'a human selection disables judged routing');
  } finally { f.cleanup(); }
});

test('two tool errors restore the ceiling at once', async () => {
  const calls = mockJev();
  const f = await start();
  try {
    await f.turn('what does the json flag mean');
    assert.equal(f.thinking(), 'minimal');
    const toolError = async () => {
      for (const handler of f.hooks.get('tool_result') ?? []) await handler({ type: 'tool_result', isError: true, toolName: 'bash', content: [] }, f.ctx);
    };
    await toolError();
    await toolError();
    assert.equal(f.thinking(), 'high', 'a judged-simple turn that starts failing goes back to the ceiling');
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test('a reopened session restores the configured ceiling, not the automatic level it saved', async () => {
  const saved = { type: 'custom', customType: 'jev-effort-v1', data: { version: 1, ceiling: 'max', autoLevel: 'low', manual: false } };
  const calls = mockJev();
  const previousJev = process.env.PI_JEV;
  process.env.PI_JEV = 'on';
  const { default: register } = await import(extensionUrl);
  const f = fakePi('low');
  register(f.pi);
  const ctx = fakeCtx({ sessionManager: { getSessionId: () => 'resume', getBranch: () => [saved] } });
  try {
    for (const handler of f.hooks.get('session_start') ?? []) handler({ type: 'session_start' }, ctx);
    assert.equal(f.thinking(), 'max', 'the human ceiling is restored on reopen');
    assert.equal(calls.length, 0, 'restoring the ceiling needs no judge call');
  } finally {
    try {
      // A later turn is still judged from the restored ceiling.
      for (const handler of f.hooks.get('input') ?? []) handler({ type: 'input', source: 'interactive', text: 'what does the json flag mean' }, ctx);
      for (const handler of f.hooks.get('before_agent_start') ?? []) await handler({ type: 'before_agent_start', prompt: 'what does the json flag mean', systemPrompt: 'x'.repeat(2_000) }, ctx);
      assert.equal(f.thinking(), 'minimal');
    } finally {
      if (previousJev === undefined) delete process.env.PI_JEV; else process.env.PI_JEV = previousJev;
    }
  }
});

test('PIJEV_EFFORT=off disables judged routing without touching the rest', async () => {
  process.env.PIJEV_EFFORT = 'off';
  const calls = mockJev();
  const saved = process.env.PI_JEV;
  process.env.PI_JEV = 'on';
  try {
    const { default: register } = await import(extensionUrl);
    const f = fakePi('high');
    register(f.pi);
    const ctx = fakeCtx();
    for (const handler of f.hooks.get('session_start') ?? []) handler({ type: 'session_start' }, ctx);
    for (const handler of f.hooks.get('input') ?? []) handler({ type: 'input', source: 'interactive', text: 'what does the json flag mean' }, ctx);
    for (const handler of f.hooks.get('before_agent_start') ?? []) await handler({ type: 'before_agent_start', prompt: 'what does the json flag mean', systemPrompt: 'x'.repeat(2_000) }, ctx);
    assert.equal(f.thinking(), 'high');
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.PIJEV_EFFORT;
    if (saved === undefined) delete process.env.PI_JEV; else process.env.PI_JEV = saved;
  }
});


test('the first request may step down even when its system prompt is large: nothing is cached yet', async () => {
  const calls = mockJev();
  const f = await start();
  try {
    // A real harness request carries ~30k tokens of system prompt and schemas.
    // On the first request that prefix is not cached at any level, so moving
    // effort re-reads nothing already paid for; the switch budget must not
    // block the one visible decision a short session gets.
    await f.turn('what does the json flag mean', 'system prompt '.repeat(4000));
    assert.equal(f.thinking(), 'minimal');
    assert.ok(!f.health.some(event => event.kind === 'effort.held'), 'a cold prefix is not reported as a costly re-read');
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});
