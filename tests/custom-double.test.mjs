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
const url = (relative) => pathToFileURL(path.join(agent, 'extensions', relative)).href;
const { registerDoubleMode, DOUBLE_RUNNER } = await import(url('pi-subagents/src/extension/double-runner.ts'));
const lib = await import(url('lib/double.ts'));
const board = await import(url('lib/reviewer-board.ts'));
const pairLib = await import(url('pi-subagents/src/extension/double-pair.ts'));
const { resolveEffectiveThinking, splitKnownThinkingSuffix } = await import(url('pi-subagents/src/shared/model-info.ts'));

const PI_DOUBLE = process.env.PI_DOUBLE;
// Forking needs the parent session file to exist on disk.
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-double-session-'));
const SESSION_FILE = path.join(SESSION_DIR, 'session.jsonl');
fs.writeFileSync(SESSION_FILE, '{"type":"session"}\n');
after(() => fs.rmSync(SESSION_DIR, { recursive: true, force: true }));
beforeEach(() => {
  if (PI_DOUBLE === undefined) delete process.env.PI_DOUBLE;
  else process.env.PI_DOUBLE = PI_DOUBLE;
  delete process.env.PI_SUBAGENT_CHILD;
});

const MODELS = [
  { provider: 'openrouter', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true },
  { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
  { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true },
  { provider: 'cheap', id: 'plain-model', name: 'Plain', reasoning: false },
];

const makePi = () => {
  const handlers = new Map();
  const pi = {
    handlers, commands: new Map(), entries: [], sends: [], notifies: [], statuses: [],
    activeTools: ['subagent'], thinkingLevel: 'high',
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
    registerCommand(name, def) { pi.commands.set(name, def); },
    registerMessageRenderer() {},
    appendEntry(type, data) { pi.entries.push({ type: 'custom', customType: type, data }); },
    sendMessage(message, options) { pi.sends.push({ message, options }); return Promise.resolve(); },
    getActiveTools() { return [...pi.activeTools]; },
    getThinkingLevel() { return pi.thinkingLevel; },
  };
  return pi;
};

const makeCtx = (pi, overrides = {}) => ({
  model: { provider: 'openrouter', id: 'glm-5.3-flash' },
  cwd: '/work/proj',
  sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => SESSION_FILE, getLeafId: () => 'leaf-1', getEntries: () => pi.entries },
  modelRegistry: { getAvailable: () => MODELS },
  signal: new AbortController().signal,
  ui: { notify: (text, level) => pi.notifies.push({ text, level }), setStatus: (key, text) => pi.statuses.push({ key, text }) },
  ...overrides,
});

const fire = (pi, event, payload, ctx) => Promise.all((pi.handlers.get(event) ?? []).map((fn) => fn(payload, ctx)));
const okResult = (text, extra = {}) => ({ details: { results: [{ exitCode: 0, output: text, usage: { input: 1, output: 2 }, ...extra }] } });
const kindOf = (params) => {
  const task = params.task ?? '';
  if (task.includes('reconciling two independent')) return 'reconcile';
  if (task.includes('You are Double instance A;')) return 'A';
  if (task.includes('You are Double instance B;')) return 'B';
  return 'unknown';
};
const tmpAgentDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'custom-double-'));
const lastNotice = (pi) => pi.notifies.at(-1);

test('arguments: no args opens the picker; two models set a pair; junk is an error', () => {
  assert.deepEqual(lib.parseCustomDoubleArgs(''), { kind: 'picker' });
  assert.deepEqual(lib.parseCustomDoubleArgs('on'), { kind: 'resume' });
  assert.deepEqual(lib.parseCustomDoubleArgs('OFF'), { kind: 'off' });
  assert.deepEqual(lib.parseCustomDoubleArgs('status'), { kind: 'status' });
  assert.deepEqual(lib.parseCustomDoubleArgs('deepseek/deepseek-flash:high zai/glm-5.3-flash reconcile=session'),
    { kind: 'pair', a: 'deepseek/deepseek-flash:high', b: 'zai/glm-5.3-flash', reconcile: 'session' });
  assert.deepEqual(lib.parseCustomDoubleArgs('x y reconcile:B'), { kind: 'pair', a: 'x', b: 'y', reconcile: 'b' });
  assert.throws(() => lib.parseCustomDoubleArgs('only-one'), /expected two models/);
  assert.throws(() => lib.parseCustomDoubleArgs('a b c'), /expected two models/);
});

test('pair labels, status text and same-route detection name both routes', () => {
  const pair = { a: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' }, b: { provider: 'zai', id: 'glm-5.3-flash' }, reconcile: 'b' };
  assert.equal(lib.doublePairLabel(pair), 'A deepseek/deepseek-flash ∥ B zai/glm-5.3-flash');
  assert.equal(lib.doubleReconcilerLabel(pair), 'B (zai/glm-5.3-flash)');
  assert.equal(lib.doubleReconcilerLabel({ ...pair, reconcile: 'session' }), 'the session model');
  assert.equal(lib.formatDoubleStatus(true, { provider: 'p', id: 'm' }, pair),
    'Double mode: ON (custom pair)\nA deepseek/deepseek-flash ∥ B zai/glm-5.3-flash + reconcile on B (zai/glm-5.3-flash)');
  assert.equal(lib.doublePairSameRoute(pair), false);
  assert.equal(lib.doublePairSameRoute({ ...pair, b: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'low' } }), true, 'thinking alone does not make two routes');
});

test('prompts for two different models say so and keep the independence rule', () => {
  const pair = { a: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' }, b: { provider: 'zai', id: 'glm-5.3-flash' }, reconcile: 'a' };
  const a = lib.buildDoubleStreamTask({ stream: 'A', task: 'Fix it.', pair });
  const b = lib.buildDoubleStreamTask({ stream: 'B', task: 'Fix it.', pair });
  for (const brief of [a, b]) {
    assert.match(brief.task, /on a different model \(A runs deepseek\/deepseek-flash \(thinking high\); B runs zai\/glm-5\.3-flash\)/);
    assert.match(brief.task, /do not guess what your peer concluded/);
    assert.doesNotMatch(brief.task, /same model, thinking level and evidence/);
  }
  let shared = 0;
  while (shared < a.task.length && a.task[shared] === b.task[shared]) shared++;
  assert.ok(a.task.length - shared <= 720, 'only the closing identity differs');
  const one = { stream: 'A', status: 'complete', text: 'plan a' };
  const two = { stream: 'B', status: 'complete', text: 'plan b' };
  const reconcile = lib.buildDoubleReconcileTask({ task: 'Fix it.', outcomeA: one, outcomeB: two, pair });
  assert.match(reconcile.task, /two different models \(A: deepseek\/deepseek-flash \(thinking high\); B: zai\/glm-5\.3-flash\)/);
  assert.match(reconcile.task, /Never defer to a model's reputation/);
  assert.match(reconcile.task, /competing or complementary reasoning paths, not votes/);
  const directive = lib.buildDoubleDirective({ ref: { provider: 'p', id: 'm' }, pair, reconcileText: 'Directive — do X.', outcomeA: one, outcomeB: two });
  assert.match(directive.directive, /^\[Double A deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash: two independent analyses by different models reconciled/);
  assert.equal(directive.degraded, false);
});

test('the directive digest keeps the plan, drops the anchor and the reasoning', () => {
  const directive = lib.buildDoubleDirective({
    ref: { provider: 'p', id: 'm' },
    requirements: ['Do not touch auth.ts.'],
    reconcileText: 'Directive — Read src/auth.ts first. Then add the redirect; run the tests.\nReconciliation — both agreed.',
    outcomeA: { stream: 'A', status: 'complete', text: 'a' }, outcomeB: { stream: 'B', status: 'complete', text: 'b' },
  }).directive;
  const digest = lib.doubleDirectiveDigest(directive);
  assert.match(digest, /^Double mode directive: Read src\/auth\.ts first\./);
  assert.doesNotMatch(digest, /Reconciliation|Do not touch auth|never an instruction/);
  assert.match(lib.doubleDirectiveDigest(lib.buildDoubleDirective({ ref: { provider: 'p', id: 'm' }, reconcileText: 'Directive — x.', outcomeA: { stream: 'A', status: 'complete', text: 'a' }, outcomeB: { stream: 'B', status: 'failed', text: '', gap: 'B died.' } }).directive), /^Double mode directive \(partial\): x\./);
  assert.ok(lib.doubleDirectiveDigest('[Double p/m: ok]\n\n' + 'word. '.repeat(500), 200).length <= 200);
  assert.throws(() => lib.doubleDirectiveDigest('x', 0), /positive integer/);
});

test('model tokens resolve to exact routes, with honest errors and clamped thinking', () => {
  const resolve = (token, options) => pairLib.resolveDoubleModel(token, MODELS, options);
  assert.deepEqual(resolve('deepseek/deepseek-flash:low'), { ok: true, ref: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'low' } });
  assert.deepEqual(resolve('deepseek-flash', { sessionThinking: 'high' }), { ok: true, ref: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' } }, 'unique bare id, session thinking');
  assert.match(resolve('glm-5.3-flash').error, /carried by openrouter, zai; write provider\/id/);
  assert.deepEqual(resolve('glm-5.3-flash', { sessionProvider: 'zai' }).ref, { provider: 'zai', id: 'glm-5.3-flash' }, 'the session provider breaks a tie');
  assert.match(resolve('nope/none').error, /No available model "nope\/none"/);
  assert.match(resolve('cheap/plain-model:high').error, /does not support thinking "high" \(it supports off\)/);
  assert.deepEqual(resolve('cheap/plain-model', { sessionThinking: 'high' }).ref, { provider: 'cheap', id: 'plain-model', thinking: 'off' }, 'a model without thinking levels runs off, never an unsupported level');
  assert.match(resolve('').error, /required/);
});

test('/custom-double with two models pins the pair, persists it and remembers it', async () => {
  const dir = tmpAgentDir();
  const pi = makePi();
  registerDoubleMode(pi, { launch: async () => ({}), agentDir: () => dir });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const command = pi.commands.get('custom-double');
  assert.ok(command, 'custom-double is registered beside double');
  await command.handler('deepseek/deepseek-flash zai/glm-5.3-flash:low reconcile=session', ctx);
  assert.match(lastNotice(pi).text, /Double mode: ON \(custom pair\)\nA deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash \+ reconcile on the session model/);
  const entry = pi.entries.filter((row) => row.customType === 'double-mode-v1').at(-1);
  assert.deepEqual(entry.data.pair, {
    a: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' },
    b: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'low' },
    reconcile: 'session',
  });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'double-pair.json'), 'utf8'));
  assert.equal(stored.a.id, 'deepseek-flash');
  assert.equal(stored.reconcile, 'session');
  // /custom-double status and /double status describe the same state.
  await command.handler('status', ctx);
  assert.match(lastNotice(pi).text, /custom pair/);
  await pi.commands.get('double').handler('status', ctx);
  assert.match(lastNotice(pi).text, /custom pair/);
  // /double means the session model twice: it toggles the pair off, then back on as a twin.
  await pi.commands.get('double').handler('', ctx);
  assert.equal(lastNotice(pi).text, 'Double mode: OFF');
  await pi.commands.get('double').handler('', ctx);
  assert.match(lastNotice(pi).text, /Twin first-pass \(A ∥ B\) \+ reconcile · openrouter\/glm-5\.3-flash/);
  assert.equal(pi.entries.filter((row) => row.customType === 'double-mode-v1').at(-1).data.pair, undefined);
  // `on` resumes the remembered pair without the popup.
  await command.handler('on', ctx);
  assert.match(lastNotice(pi).text, /custom pair\)\nA deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash/);
  await command.handler('off', ctx);
  assert.equal(lastNotice(pi).text, 'Double mode: OFF');
});

test('bad models leave the mode unchanged and say why', async () => {
  const pi = makePi();
  registerDoubleMode(pi, { launch: async () => ({}), agentDir: () => tmpAgentDir() });
  // The session runs on a provider that does not carry the ambiguous id, so nothing breaks the tie.
  const ctx = makeCtx(pi, { model: { provider: 'cheap', id: 'plain-model' } });
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const command = pi.commands.get('custom-double');
  await command.handler('nope/none deepseek/deepseek-flash', ctx);
  assert.equal(lastNotice(pi).level, 'error');
  assert.match(lastNotice(pi).text, /Custom Double unchanged\. A: No available model "nope\/none"/);
  await command.handler('glm-5.3-flash deepseek/deepseek-flash', ctx);
  assert.match(lastNotice(pi).text, /A: "glm-5\.3-flash" is carried by openrouter, zai/);
  await command.handler('only-one', ctx);
  assert.match(lastNotice(pi).text, /expected two models/);
  assert.equal(pi.entries.filter((row) => row.customType === 'double-mode-v1').length, 0, 'nothing was enabled');
  process.env.PI_DOUBLE = 'off';
  await command.handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  assert.match(lastNotice(pi).text, /PI_DOUBLE=off/);
  delete process.env.PI_DOUBLE;
  const empty = makeCtx(pi, { modelRegistry: { getAvailable: () => [] } });
  await command.handler('a b', empty);
  assert.match(lastNotice(pi).text, /No models are available/);
});

test('the popup flow adopts the confirmed pair, leaves a cancel alone, and prefills with runnable models only', async () => {
  const dir = tmpAgentDir();
  const pi = makePi();
  const seen = [];
  let answer = { a: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'medium' }, b: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' }, reconcile: 'b' };
  registerDoubleMode(pi, { launch: async () => ({}), agentDir: () => dir, unreliableRoutes: () => new Set(['zai/glm-5.3-flash']), pickPair: async (_ctx, options) => { seen.push(options); return answer; } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const command = pi.commands.get('custom-double');
  await command.handler('', ctx);
  assert.equal(seen[0].models.length, MODELS.length, 'every available model, from every provider, is offered');
  assert.deepEqual(seen[0].session, { provider: 'openrouter', id: 'glm-5.3-flash' });
  assert.equal(seen[0].sessionThinking, 'high');
  assert.deepEqual([...seen[0].unreliable], ['zai/glm-5.3-flash'], 'the run ledger\'s unreliable routes reach the popup');
  assert.equal(seen[0].sessionTokens, undefined, 'no usage known, nothing to mark');
  assert.equal(seen[0].initial, undefined, 'nothing remembered yet');
  assert.match(lastNotice(pi).text, /A zai\/glm-5\.3-flash ∥ B deepseek\/deepseek-flash \+ reconcile on B/);
  // Cancelling keeps the pair as it was.
  answer = undefined;
  await command.handler('', ctx);
  assert.match(lastNotice(pi).text, /^Custom Double unchanged\./);
  assert.equal(seen[1].initial.a.id, 'glm-5.3-flash', 'the active pair prefills the popup');
  // A remembered model that can no longer run is not offered back.
  const lost = makeCtx(pi, { modelRegistry: { getAvailable: () => MODELS.filter((model) => model.provider !== 'zai') } });
  await command.handler('', lost);
  assert.equal(seen[2].initial.a, undefined, 'the unavailable slot is empty in the popup');
  assert.equal(seen[2].initial.b.id, 'deepseek-flash');
  // `on` with an unrunnable remembered pair falls through to the popup instead of enabling it.
  const before = pi.entries.length;
  await command.handler('on', lost);
  assert.equal(seen.length, 4);
  assert.equal(pi.entries.length, before, 'a cancelled popup writes nothing');
  // Without the interactive popup the command asks for explicit models.
  const headless = makePi();
  registerDoubleMode(headless, { launch: async () => ({}), agentDir: () => tmpAgentDir() });
  const hctx = makeCtx(headless, { hasUI: false });
  await fire(headless, 'session_start', { reason: 'startup' }, hctx);
  await headless.commands.get('custom-double').handler('', hctx);
  assert.match(lastNotice(headless).text, /needs an interactive session\. Name both models/);
});

test('a resumed session restores its pair; an unreadable pair falls back to the twin and says so once', async () => {
  const pi = makePi();
  registerDoubleMode(pi, { launch: async () => ({}), agentDir: () => tmpAgentDir() });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  const revived = makePi();
  revived.entries.push(...pi.entries);
  registerDoubleMode(revived, { launch: async () => ({}), agentDir: () => tmpAgentDir() });
  const ctx2 = makeCtx(revived);
  await fire(revived, 'session_start', { reason: 'resume' }, ctx2);
  await revived.commands.get('double').handler('status', ctx2);
  assert.match(lastNotice(revived).text, /custom pair\)\nA deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash/);
  assert.equal(globalThis[DOUBLE_RUNNER].snapshot().kind, 'custom');

  const damaged = makePi();
  damaged.entries.push({ type: 'custom', customType: 'double-mode-v1', data: { enabled: true, pair: { a: { provider: 'x' }, b: 7 } } });
  let launches = 0;
  registerDoubleMode(damaged, { warmWaitMs: 0, launch: async () => { launches++; return okResult('plan'); } });
  const ctx3 = makeCtx(damaged);
  await fire(damaged, 'session_start', { reason: 'resume' }, ctx3);
  assert.equal(globalThis[DOUBLE_RUNNER].snapshot().kind, 'twin');
  await fire(damaged, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, ctx3);
  assert.equal(damaged.notifies.filter((row) => /saved custom pair could not be read/.test(row.text)).length, 1);
  await fire(damaged, 'before_agent_start', { prompt: 'Fix it again.', systemPrompt: 's' }, ctx3);
  assert.equal(damaged.notifies.filter((row) => /saved custom pair could not be read/.test(row.text)).length, 1, 'said once');
  assert.ok(launches >= 2, 'the twin still ran');
});

test('a turn runs each stream on its own route and thinking, reconciles on the chosen route, and starts both at once', async () => {
  const pi = makePi();
  const calls = [];
  const gates = new Map();
  const gate = (kind) => { if (!gates.has(kind)) { let resolve; const promise = new Promise((r) => { resolve = r; }); gates.set(kind, { promise, resolve }); } return gates.get(kind); };
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async (_id, params) => { calls.push(params); return gate(kindOf(params)).promise; } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash:low zai/glm-5.3-flash:high reconcile=b', ctx);
  const pending = fire(pi, 'before_agent_start', { prompt: 'Add a login redirect. Do not modify auth.ts.', systemPrompt: 's' }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Different routes share no prompt cache, so there is no staggering: both launched before either answered.
  assert.deepEqual(calls.map(kindOf).sort(), ['A', 'B']);
  const byKind = Object.fromEntries(calls.map((params) => [kindOf(params), params]));
  assert.equal(byKind.A.model, 'deepseek/deepseek-flash:low');
  assert.equal(byKind.B.model, 'zai/glm-5.3-flash:high');
  for (const params of calls) assert.equal(params.thinking, undefined, 'thinking travels as the model suffix, the only place the executor reads it');
  // The executor's own parser (what the child actually runs with) reads the pinned level back from the route.
  assert.equal(resolveEffectiveThinking(byKind.A.model, 'off'), 'low');
  assert.equal(resolveEffectiveThinking(byKind.B.model, 'off'), 'high');
  assert.equal(splitKnownThinkingSuffix(byKind.B.model).baseModel, 'zai/glm-5.3-flash');
  for (const params of calls) {
    assert.equal(params.modelOrigin, 'explicit');
    assert.equal(params.context, 'fork');
    assert.match(params.task, /A runs deepseek\/deepseek-flash \(thinking low\); B runs zai\/glm-5\.3-flash \(thinking high\)/);
    assert.match(params.task, /The agent that acts on the reconciled directive runs openrouter\/glm-5\.3-flash/);
    assert.deepEqual(params.capabilityCeiling.allowedTools, ['read', 'grep', 'find', 'ls', 'git_info']);
  }
  gate('A').resolve(okResult('A plan.', { model: 'deepseek/deepseek-flash', thinking: 'low' }));
  gate('B').resolve(okResult('B plan.', { model: 'zai/glm-5.3-flash', thinking: 'high' }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const reconcile = calls.find((params) => kindOf(params) === 'reconcile');
  assert.equal(reconcile.model, 'zai/glm-5.3-flash:high', 'reconcile=b runs on B, at B\'s thinking level');
  assert.match(reconcile.task, /two different models/);
  gate('reconcile').resolve(okResult('Directive — add the redirect.\nReconciliation — agreed.', { model: 'zai/glm-5.3-flash', thinking: 'high' }));
  const [result] = await pending;
  assert.match(result.message.content, /^\[Double A deepseek\/deepseek-flash ∥ B zai\/glm-5\.3-flash: two independent analyses by different models reconciled/);
  assert.doesNotMatch(result.message.content, /partial result/, 'correct routes and thinking leave the directive clean');
  assert.match(result.message.content, /Do not modify auth\.ts/, 'the user\'s requirement anchor still leads');
  const costs = pi.entries.filter((row) => row.customType === 'subagent-cost-v1');
  const models = costs.map((row) => row.data.results?.[0]?.model).filter(Boolean);
  assert.ok(models.includes('deepseek/deepseek-flash') && models.includes('zai/glm-5.3-flash'), 'accounting names each stream\'s own route');
  assert.ok(pi.statuses.some((row) => row.text === 'Double A ∥ B · deepseek/deepseek-flash ∥ zai/glm-5.3-flash'));
});

test('reconcile=session runs on the session model, and reconcile=a on stream A', async () => {
  for (const [choice, expected] of [['session', 'openrouter/glm-5.3-flash:high'], ['a', 'deepseek/deepseek-flash:high']]) {
    const pi = makePi();
    const seen = {};
    registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async (_id, params) => { seen[kindOf(params)] = params; return okResult(`${kindOf(params)} text`); } });
    const ctx = makeCtx(pi);
    await fire(pi, 'session_start', { reason: 'startup' }, ctx);
    await pi.commands.get('custom-double').handler(`deepseek/deepseek-flash zai/glm-5.3-flash reconcile=${choice}`, ctx);
    await fire(pi, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, ctx);
    assert.equal(seen.reconcile.model, expected, choice);
  }
});

test('a stream that ran on another route than its pin is a visible gap', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    agentDir: () => tmpAgentDir(),
    launch: async (_id, params) => kindOf(params) === 'B' ? okResult('B text', { model: 'someone/else' }) : okResult(`${kindOf(params)} text`),
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, ctx);
  assert.match(result.message.content, /partial result/);
  assert.match(result.message.content, /ran on someone\/else instead of the pinned zai\/glm-5\.3-flash/);
});

test('a pinned route that can no longer run continues single with one warning, never a substitute', async () => {
  const pi = makePi();
  let launches = 0;
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async () => { launches++; return okResult('x'); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  const gone = makeCtx(pi, { modelRegistry: { getAvailable: () => MODELS.filter((model) => model.provider !== 'zai') } });
  const [first] = await fire(pi, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, gone);
  const [second] = await fire(pi, 'before_agent_start', { prompt: 'Fix it again.', systemPrompt: 's' }, gone);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(launches, 0);
  const warnings = pi.notifies.filter((row) => /zai\/glm-5\.3-flash is not available right now/.test(row.text));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'warning');
});

test('Double and the reviewers share one board: reviewer notes go in, a directive digest comes out, status is visible', async () => {
  const pi = makePi();
  const tasks = [];
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), warmWaitMs: 0, launch: async (_id, params) => {
    tasks.push(params.task);
    return okResult(kindOf(params) === 'reconcile' ? 'Directive — read src/a.ts, then fix the redirect. Run the tests.\nReconciliation — agreed.' : 'plan');
  } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  const key = board.reviewerSessionKey(ctx);
  assert.equal(board.plannerStatusText(), undefined, 'Double is off, so nothing is reported');
  await pi.commands.get('double').handler('on', ctx);
  assert.match(board.plannerStatusText(), /^Double mode: ON \(the session model, twice\): every user prompt is analyzed by two independent streams/);
  assert.match(board.plannerStatusText(), /Do not advise repeating that deliberation/);
  board.publishReviewerNote(key, 'observer', 'The failing test is test/login.test.ts, not the redirect itself.', [], Date.now() - 90_000);
  board.publishReviewerNote(key, 'watchmaker', 'Stop re-reading the router; edit it.', [], Date.now() - 20_000);
  board.publishReviewerNote(key, 'double', 'an older Double digest', [], Date.now() - 5_000);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Fix the login redirect.', systemPrompt: 's' }, ctx);
  assert.ok(result);
  const streamTasks = tasks.filter((task) => /You are Double instance [AB];/.test(task));
  assert.equal(streamTasks.length, 2);
  for (const task of streamTasks) {
    assert.match(task, /Notes other harness reviewers already gave the agent this session/);
    assert.match(task, /- Watchmaker, under a minute ago: Stop re-reading the router; edit it\./);
    assert.match(task, /- Observer, 2 min ago: The failing test is test\/login\.test\.ts/);
    assert.doesNotMatch(task, /older Double digest/, 'its own earlier digest is not fed back as another reviewer');
  }
  let shared = 0;
  while (shared < streamTasks[0].length && streamTasks[0][shared] === streamTasks[1][shared]) shared++;
  assert.ok(streamTasks[0].length - shared <= 720, 'the notes are identical in both streams, so cache order holds');
  const mine = board.peerReviewerNotes(key, 'observer').find((note) => note.reviewer === 'double');
  assert.match(mine.note, /^Double mode directive: read src\/a\.ts, then fix the redirect\./);
  assert.doesNotMatch(mine.note, /Reconciliation/);
  assert.equal(board.reviewerLabel('double'), 'Double mode');
  assert.equal(board.reviewerLabel('council'), 'Scope council');
  await pi.commands.get('double').handler('off', ctx);
  assert.equal(board.plannerStatusText(), undefined, 'turning Double off clears the reviewers\' evidence');
});

test('a chosen model whose window cannot hold the transcript is skipped with a stated reason; the survivor still carries the turn', async () => {
  const pi = makePi();
  const seen = [];
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async (_id, params) => { seen.push(params); return okResult(`${kindOf(params)} text`); } });
  const sizes = MODELS.map((model) => model.provider === 'deepseek' ? { ...model, contextWindow: 64_000 } : { ...model, contextWindow: 200_000 });
  const ctx = makeCtx(pi, { modelRegistry: { getAvailable: () => sizes }, getContextUsage: () => ({ tokens: 91_000, contextWindow: 200_000, percent: 45 }) });
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash reconcile=a', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'Fix the redirect.', systemPrompt: 's' }, ctx);
  assert.ok(result, 'the survivor and the reconciliation still produce a directive');
  assert.equal(seen.filter((params) => kindOf(params) === 'A').length, 0, 'the too-small route was never launched');
  assert.equal(seen.filter((params) => kindOf(params) === 'B').length, 1);
  const reconcile = seen.find((params) => kindOf(params) === 'reconcile');
  assert.equal(reconcile.model, 'openrouter/glm-5.3-flash:high', 'a reconciliation that cannot fit runs on the session model');
  assert.match(result.message.content, /partial result/);
  assert.match(result.message.content, /Double stream A was not started: deepseek\/deepseek-flash has a 64k-token window and the session transcript it must read is about 91k tokens/);
  assert.match(result.message.content, /Reconciliation ran on the session model openrouter\/glm-5\.3-flash because deepseek\/deepseek-flash has a 64k-token window/);
  assert.ok(pi.sends.some((send) => send.message.details.phase === 'Double stream A' && send.message.details.status === 'unavailable'));
});

test('the twin mode and unknown sizes never skip a stream', async () => {
  assert.equal(lib.doubleContextFits(64_000, 91_000), false);
  assert.equal(lib.doubleContextFits(200_000, 91_000), true);
  assert.equal(lib.doubleContextFits(undefined, 91_000), true);
  assert.equal(lib.doubleContextFits(64_000, undefined), true);
  assert.equal(lib.doubleContextFits(64_000, null), true);
  const pi = makePi();
  const seen = [];
  registerDoubleMode(pi, { launch: async (_id, params) => { seen.push(kindOf(params)); return okResult('text'); } });
  const ctx = makeCtx(pi, { modelRegistry: { getAvailable: () => MODELS.map((model) => ({ ...model, contextWindow: 8_000 })) }, getContextUsage: () => ({ tokens: 91_000 }) });
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('on', ctx);
  await fire(pi, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, ctx);
  assert.deepEqual(seen.sort(), ['A', 'B', 'reconcile'], 'the session model holds its own transcript by construction');
});

test('the footer keeps a chip while Double is on, between prompts and across resumes, and clears when it is off', async () => {
  const pi = makePi();
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async (_id, params) => okResult(`${kindOf(params)} text`) });
  const ctx = makeCtx(pi);
  const chip = () => pi.statuses.filter((row) => row.key === 'double').at(-1)?.text;
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  assert.equal(chip(), undefined, 'off at startup: no chip');
  await pi.commands.get('double').handler('on', ctx);
  assert.equal(chip(), 'Double ON · glm-5.3-flash ×2');
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  assert.equal(chip(), 'Double ON · A deepseek-flash ∥ B glm-5.3-flash');
  await fire(pi, 'before_agent_start', { prompt: 'Fix the redirect.', systemPrompt: 's' }, ctx);
  assert.equal(chip(), 'Double ON · A deepseek-flash ∥ B glm-5.3-flash', 'a finished run returns to the idle chip, not to blank');
  const revived = makePi();
  revived.entries.push(...pi.entries);
  registerDoubleMode(revived, { agentDir: () => tmpAgentDir(), launch: async () => ({}) });
  await fire(revived, 'session_start', { reason: 'resume' }, makeCtx(revived));
  assert.equal(revived.statuses.filter((row) => row.key === 'double').at(-1)?.text, 'Double ON · A deepseek-flash ∥ B glm-5.3-flash', 'a resumed session shows that Double is still on');
  await pi.commands.get('custom-double').handler('off', ctx);
  assert.equal(chip(), undefined);
  process.env.PI_DOUBLE = 'off';
  await pi.commands.get('double').handler('on', ctx);
  assert.equal(chip(), undefined, 'a disabled process never shows the chip');
});

test('first-turn tool staging cannot switch the explicit mode off: a registered subagent capability is enough', async () => {
  const pi = makePi();
  const seen = [];
  // Direct (small) tasks stage `subagent` out of the active set while it stays registered.
  pi.activeTools = ['read', 'bash'];
  pi.getAllTools = () => [{ name: 'read' }, { name: 'bash' }, { name: 'subagent' }];
  registerDoubleMode(pi, { warmWaitMs: 0, launch: async (_id, params) => { seen.push(kindOf(params)); return okResult(`${kindOf(params)} text`); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('double').handler('on', ctx);
  const [result] = await fire(pi, 'before_agent_start', { prompt: 'What is 17 times 23?', systemPrompt: 's' }, ctx);
  assert.ok(result, 'the explicit mode still ran');
  assert.deepEqual(seen.sort(), ['A', 'B', 'reconcile']);
  assert.equal(pi.notifies.some((row) => /subagent capability/.test(row.text)), false, 'no misleading capability warning');
  // A genuinely absent capability is still reported, once.
  const bare = makePi();
  bare.getAllTools = () => [{ name: 'read' }];
  registerDoubleMode(bare, { launch: async () => okResult('x') });
  const bareCtx = makeCtx(bare);
  await fire(bare, 'session_start', { reason: 'startup' }, bareCtx);
  await bare.commands.get('double').handler('on', bareCtx);
  assert.equal((await fire(bare, 'before_agent_start', { prompt: 'Fix it.', systemPrompt: 's' }, bareCtx))[0], undefined);
  assert.equal(bare.notifies.filter((row) => /needs the subagent capability/.test(row.text)).length, 1);
});

test('an off pin adds no suffix: the executor would reject a literal ":off" route', async () => {
  const pi = makePi();
  pi.thinkingLevel = 'off';
  const seen = [];
  registerDoubleMode(pi, { agentDir: () => tmpAgentDir(), launch: async (_id, params) => { seen.push(params); return okResult(`${kindOf(params)} text`); } });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash:off zai/glm-5.3-flash:low', ctx);
  await fire(pi, 'before_agent_start', { prompt: 'Fix the redirect.', systemPrompt: 's' }, ctx);
  const byKind = Object.fromEntries(seen.map((params) => [kindOf(params), params]));
  assert.equal(byKind.A.model, 'deepseek/deepseek-flash');
  assert.equal(byKind.B.model, 'zai/glm-5.3-flash:low');
  assert.equal(byKind.reconcile.model, 'deepseek/deepseek-flash', 'reconcile=a runs on A, which is pinned off');
});

test('a chosen route the economy policy would refuse is announced with the command that lifts it', async () => {
  const pi = makePi();
  registerDoubleMode(pi, {
    agentDir: () => tmpAgentDir(),
    economyBlock: (model) => model.provider === 'zai' ? 'its $0 price is a placeholder, not proof that it is free' : undefined,
    launch: async () => ({}),
  });
  const ctx = makeCtx(pi);
  await fire(pi, 'session_start', { reason: 'startup' }, ctx);
  await pi.commands.get('custom-double').handler('deepseek/deepseek-flash zai/glm-5.3-flash', ctx);
  const warnings = pi.notifies.filter((note) => note.level === 'warning');
  assert.equal(warnings.length, 1, 'only the refused stream is announced');
  assert.match(warnings[0].text, /Stream B \(zai\/glm-5\.3-flash\) will be unavailable: its \$0 price is a placeholder.*Run \/subagents-economy allow zai\/glm-5\.3-flash to use it\./);
  assert.ok(pi.notifies.some((note) => /Double mode: ON/.test(note.text)), 'the pair is still adopted: the user decides');
});

test('the live economy policy classification drives the block reason', async () => {
  const model = (cost) => ({ provider: 'minimax', id: 'MiniMax-M2.7', name: 'M2.7', reasoning: true, cost });
  const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.match(pairLib.doubleEconomyBlock(model(free)) ?? '', /\$0 price is a placeholder/);
  assert.equal(pairLib.doubleEconomyBlock(model({ input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 })), undefined, 'a priced route within budget runs');
  assert.match(pairLib.doubleEconomyBlock(model({ input: 500, output: 900, cacheRead: 0, cacheWrite: 0 })) ?? '', /above the subagent budget/);
  assert.equal(pairLib.doubleEconomyBlock({ provider: 'x', id: 'unpriced', reasoning: true }), undefined, 'an unpriced route is not refused by the executor');
});

