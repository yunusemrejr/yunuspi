// Span behavior sensor: catalog, trace bounds, cache, thresholds, shadow,
// advisory gating, scorer fallback. All remote calls are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { collectSessionCost } from '../core/coding-agent/src/core/session-accounting.js';

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const spanMod = await load("extensions/lib/micro-intelligence/span-sensor.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/micro-intel/traces.json"), "utf8"));

const {
  SPAN_CATALOG, SPAN_ADVISE_THRESHOLD, createSpanTrace, spanTraceFingerprint,
  parseSpanScores, scoreSpanTrace: rawScoreSpanTrace, spanAdvisory, sessionSpanScorer,
  clearSpanCache, spanEnabled, spanShadow,
} = spanMod;

// Scoring fixtures explicitly opt in; production no longer spends on
// record-only calibration unless the operator enables it.
const scoreSpanTrace = (trace, scorer, options = {}) => rawScoreSpanTrace(trace, scorer, {
  ...options, env: { PI_SPAN: 'on', ...options.env },
});

const scoresFor = (presentIds) => {
  const out = {};
  for (const signal of SPAN_CATALOG) {
    out[signal.id] = presentIds.includes(signal.id)
      ? { present: 0.9, absent: 0.05, notObservable: 0.05 }
      : { present: 0.05, absent: 0.9, notObservable: 0.05 };
  }
  return out;
};

const traceFrom = (events) => {
  const collector = createSpanTrace();
  for (const [kind, text] of events) collector.record(kind, text, 1000);
  return collector.trace;
};

test("catalog is fixed: twelve stable signal ids", () => {
  assert.equal(SPAN_CATALOG.length, 12);
  const ids = new Set(SPAN_CATALOG.map((s) => s.id));
  assert.equal(ids.size, 12);
  for (const id of ["repeated-failure-loop", "scope-drift", "ignored-requirements", "premature-completion", "verification-gap", "stale-evidence", "redundant-verification", "capability-misuse", "unnecessary-delegation", "review-churn", "unproductive-progress", "unsafe-assumptions"]) {
    assert.ok(ids.has(id), `catalog keeps ${id}`);
  }
});

test("trace ring bounds events and clips text", () => {
  const collector = createSpanTrace(8);
  for (let i = 0; i < 20; i++) collector.record("tool-call", `bash-${"x".repeat(2000)}`, 1000 + i);
  assert.equal(collector.trace.events.length, 8);
  assert.ok(collector.trace.events.every((e) => e.text.length <= 400));
  collector.record("note", "   ");
  assert.equal(collector.trace.events.length, 8);
  collector.clear();
  assert.equal(collector.trace.events.length, 0);
});

test("fingerprint is stable and order/content sensitive", () => {
  const a = traceFrom(fixtures.traces[0].events);
  const b = traceFrom(fixtures.traces[0].events);
  assert.equal(spanTraceFingerprint(a), spanTraceFingerprint(b));
  const c = traceFrom([...fixtures.traces[0].events, ["note", "extra"]]);
  assert.notEqual(spanTraceFingerprint(a), spanTraceFingerprint(c));
});

test("score parsing validates shape and normalization", () => {
  assert.ok(parseSpanScores(scoresFor(["repeated-failure-loop"])));
  assert.equal(parseSpanScores({}), undefined);
  assert.equal(parseSpanScores([]), undefined);
  assert.equal(parseSpanScores({ "repeated-failure-loop": { present: 0.5, absent: 0.5 } }), undefined);
  assert.equal(parseSpanScores({ "repeated-failure-loop": { present: 0.9, absent: 0.9, notObservable: 0.9 } }), undefined);
  assert.equal(parseSpanScores({ "not-a-signal": { present: 1, absent: 0, notObservable: 0 } }), undefined);
});

test("scoring caches by fingerprint and skips trivial/disabled traces", async () => {
  metricsMod.resetMicroMetrics();
  clearSpanCache();
  try {
    let calls = 0;
    const scorer = async (prompt) => {
      calls++;
      assert.ok(prompt.startsWith("Recent agent session trace:") && !prompt.includes("repeated-failure-loop"), "the catalog travels as questions, not in the state");
      return { text: JSON.stringify(scoresFor(["repeated-failure-loop"])), model: "mock", inputTokens: 10, ms: 5 };
    };
    const trace = traceFrom(fixtures.traces[0].events);
    const env = { PI_SPAN_SHADOW: "0" };
    const first = await scoreSpanTrace(trace, scorer, { env });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(calls, 1);
    const second = await scoreSpanTrace(trace, scorer, { env });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    const snapshot = metricsMod.microMetrics().snapshot();
    assert.equal(snapshot.helpers.span.runs, 2);
    assert.equal(snapshot.helpers.span.cacheHits, 1);
    assert.equal(await scoreSpanTrace(traceFrom([["note", "one"]]), scorer, { env }).then((r) => r.skipped), "trivial");
    assert.equal(await scoreSpanTrace(trace, scorer, { env: { PI_SPAN: "off" } }).then((r) => r.skipped), "disabled");
  } finally {
    metricsMod.resetMicroMetrics();
    clearSpanCache();
  }
});

test("shadow mode records but never advises", async () => {
  metricsMod.resetMicroMetrics();
  clearSpanCache();
  try {
    const scorer = async () => ({ text: JSON.stringify(scoresFor(["review-churn"])), model: "mock", ms: 1 });
    const result = await scoreSpanTrace(traceFrom(fixtures.traces[1].events), scorer, { env: { PI_SPAN_SHADOW: "1" } });
    assert.equal(result.ok, true);
    assert.equal(result.shadow, true);
    const advisory = spanAdvisory(result, new Set(["review-churn"]));
    assert.deepEqual(advisory.signals, []);
    assert.equal(advisory.shadow, true);
    assert.equal(metricsMod.microMetrics().snapshot().helpers.span.skipReasons.shadow, 1);
  } finally {
    metricsMod.resetMicroMetrics();
    clearSpanCache();
  }
});

test("advisory requires threshold and deterministic corroboration", async () => {
  clearSpanCache();
  try {
    const scorer = async () => ({ text: JSON.stringify(scoresFor(["verification-gap", "stale-evidence"])), model: "mock", ms: 1 });
    const result = await scoreSpanTrace(traceFrom(fixtures.traces[2].events), scorer, { env: { PI_SPAN_SHADOW: "0" } });
    assert.equal(result.ok, true);
    assert.deepEqual(spanAdvisory(result, new Set()).signals, []);
    assert.deepEqual(spanAdvisory(result, new Set()).uncorroborated.sort(), ["stale-evidence", "verification-gap"]);
    assert.deepEqual(spanAdvisory(result, new Set(["verification-gap"])).signals, ["verification-gap"]);
    assert.ok(SPAN_ADVISE_THRESHOLD >= 0.8);
  } finally {
    clearSpanCache();
  }
});

test("malformed scorer output degrades to a skip", async () => {
  metricsMod.resetMicroMetrics();
  clearSpanCache();
  try {
    const scorer = async () => ({ text: "not json", model: "mock", ms: 1 });
    const result = await scoreSpanTrace(traceFrom(fixtures.traces[0].events), scorer, { env: { PI_SPAN_SHADOW: "0" } });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "malformed");
  } finally {
    metricsMod.resetMicroMetrics();
    clearSpanCache();
  }
});

test("Span is scored on the session model through its registry, with one JSON answer", async () => {
  const seen = [];
  const session = { provider: "fixture", id: "session-model", baseUrl: "https://fixture.invalid/v1" };
  const ctx = { model: session, modelRegistry: { completeSimple: async (model, context, options) => {
    seen.push({ model, prompt: context.messages[0].content[0].text, options });
    const scores = Object.fromEntries(SPAN_CATALOG.map((signal) => [signal.id, { present: 0.1, absent: 0.8, notObservable: 0.1 }]));
    return { content: [{ type: "text", text: JSON.stringify(scores) }], stopReason: "stop", usage: { input: 9, cost: { total: 0 } } };
  } } };
  const answer = await sessionSpanScorer(ctx)("- [error] bash failed", {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, session, "the scorer never chooses another model");
  assert.equal(seen[0].options.maxRetries, 0);
  assert.match(seen[0].prompt, /- \[error\] bash failed/, "the bounded trace is judged");
  for (const signal of SPAN_CATALOG) assert.match(seen[0].prompt, new RegExp(`- ${signal.id}: `), signal.id);
  assert.equal(answer.model, "fixture/session-model");
  assert.equal(Object.keys(parseSpanScores(JSON.parse(answer.text))).length, SPAN_CATALOG.length);
  assert.equal(answer.inputTokens, 9);
  assert.equal(answer.costUsd, 0);
});

test("without a session model Span refuses instead of choosing another route", async () => {
  let calls = 0;
  const ctx = { model: undefined, modelRegistry: { completeSimple: async () => { calls++; return { content: [], stopReason: "stop" }; } } };
  await assert.rejects(sessionSpanScorer(ctx)("trace", {}), /no session model/);
  assert.equal(calls, 0);
});

test('Span reuses scores only on the selected model and endpoint', async () => {
  const trace = traceFrom(fixtures.traces[0].events);
  const model = { provider: 'fixture', id: 'session-model', api: 'openai-completions', baseUrl: 'https://primary.invalid/v1' };
  const calls = [];
  const modelRegistry = { completeSimple: async selected => {
    calls.push(selected);
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(scoresFor([])) }] };
  } };
  clearSpanCache();
  try {
    const score = selected => scoreSpanTrace(trace, sessionSpanScorer({ model: selected, modelRegistry }));
    assert.equal((await score(model)).cached, false);
    assert.equal((await score({ ...model })).cached, true);
    assert.equal((await score({ ...model, id: 'other-model' })).cached, false);
    assert.equal((await score({ ...model, baseUrl: 'https://other.invalid/v1' })).cached, false);
    assert.equal((await score(undefined)).ok, false);
    assert.equal(calls.length, 3);
  } finally { clearSpanCache(); }
});

test('Span keeps paid physical responses when the scorer cannot use them', async () => {
  const trace = traceFrom(fixtures.traces[0].events);
  const entries = [];
  const append = (customType, data) => entries.push({ type: 'custom', customType, data });
  const pi = { appendEntry: append, bindAuxiliaryUsage: () => data => { append('auxiliary-model-usage-v1', data); return true; } };
  const model = { provider: 'anthropic', id: 'fixture' };
  const responses = [
    { content: [{ type: 'text', text: 'malformed fixture' }], stopReason: 'stop', usage: { input: 9, output: 3, cost: { total: .021, complete: true } } },
    { content: [], stopReason: 'error', errorMessage: 'Fixture request failed', usage: { input: 9, output: 3, cost: { total: .013, source: 'provider-reported' } } },
    { content: [{ type: 'text', text: JSON.stringify(scoresFor([])) }], stopReason: 'stop', usage: { input: 9, output: 3, cost: { total: .005, complete: true } } },
  ];
  clearSpanCache();
  try {
    const scorer = sessionSpanScorer({ model, modelRegistry: { completeSimple: async () => responses.shift() } });
    assert.equal((await scoreSpanTrace(trace, scorer, { pi })).skipped, 'malformed');
    assert.equal((await scoreSpanTrace(trace, scorer, { pi })).skipped, 'unavailable');
    assert.equal((await scoreSpanTrace(trace, scorer, { pi })).ok, true);
    const account = collectSessionCost(entries);
    assert.equal(account.reported, .013);
    assert.ok(Math.abs(account.estimated - .026) < 1e-12);
    assert.equal(account.formatted, '$~0.039000');
    assert.equal(account.pending, 0);
    const receipts = entries.filter(entry => entry.customType === 'auxiliary-model-usage-v1');
    assert.deepEqual(receipts.map(entry => entry.data.status), ['pending', 'completed', 'pending', 'failed', 'pending', 'completed']);
    assert.ok(receipts.every(entry => entry.data.owner === 'span' && entry.data.provider === 'anthropic' && entry.data.model === 'fixture'));
    assert.equal(new Set(receipts.map(entry => entry.data.id)).size, 3);
    assert.equal(collectSessionCost([...entries, ...receipts]).total, account.total);
    assert.doesNotMatch(JSON.stringify(entries), /malformed fixture|Fixture request failed/);
  } finally { clearSpanCache(); }
});

test('an abandoned Span request settles in its source session after a real SDK fork', { timeout: 10000 }, async t => {
  const { AgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } =
    await import('../core/coding-agent/src/index.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-span-fork-'));
  const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'audit', baseUrl: 'https://fixture.invalid',
    input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const modelRuntime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    streamSimple() { assert.fail('the SDK fixture makes no provider requests'); } };
  let runtimePi;
  async function create(sessionManager) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
        pi.on('session_start', () => { runtimePi = pi; });
      }] });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader, sessionManager, tools: [] });
    await result.session.bindExtensions({ mode: 'print' });
    return { ...result, services: { cwd, agentDir: cwd } };
  }
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: 'user', content: 'Fixture source', timestamp: Date.now() });
  manager.flush();
  const original = await create(manager);
  const host = new AgentSessionRuntime(original.session, original.services, ({ sessionManager }) => create(sessionManager));
  t.after(async () => { await host.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); clearSpanCache(); });
  const sourceFile = manager.getSessionFile();
  const sourceLeaf = manager.getLeafId();
  const saved = () => SessionManager.open(sourceFile, cwd).getEntries();
  const submitted = Promise.withResolvers(), response = Promise.withResolvers(), settled = Promise.withResolvers();
  const controller = new AbortController();
  const owner = runtimePi;
  const pi = { bindAuxiliaryUsage() {
    const append = owner.bindAuxiliaryUsage();
    return data => {
      const written = append(data);
      if (data.status !== 'pending') settled.resolve(written);
      return written;
    };
  } };
  const scorer = sessionSpanScorer({ model, modelRegistry: { completeSimple() { submitted.resolve(); return response.promise; } } });
  clearSpanCache();
  const score = scoreSpanTrace(traceFrom(fixtures.traces[0].events), scorer, { pi, signal: controller.signal });
  try {
    await Promise.race([submitted.promise, score.then(result => assert.fail(`Span skipped before dispatch: ${result.skipped}`))]);
    assert.equal(collectSessionCost(saved()).pending, 1);
    assert.equal((await host.fork(sourceLeaf, { position: 'at' })).cancelled, false);
    assert.equal(collectSessionCost(host.session.sessionManager.getEntries()).pending, 0);
    controller.abort();
    assert.equal((await score).skipped, 'aborted');
  } finally {
    response.resolve({ content: [{ type: 'text', text: 'late fixture' }], stopReason: 'stop', usage: { input: 12, output: 3, cost: { total: .037, source: 'provider-reported' } } });
  }
  assert.equal(await settled.promise, true);
  const entries = saved(), source = collectSessionCost(entries);
  assert.equal(source.formatted, '$0.037000');
  assert.equal(source.pending, 0);
  assert.equal(collectSessionCost([...entries, ...entries]).reported, .037);
  assert.equal(collectSessionCost(host.session.sessionManager.getEntries()).reported, 0);
  assert.equal(entries.some(entry => entry.customType === 'span-usage-v1'), false);
});

test("env gates behave", () => {
  assert.equal(spanEnabled({}), false);
  assert.equal(spanEnabled({ PI_SPAN: "on" }), true);
  assert.equal(spanEnabled({ PI_SPAN: "true" }), true);
  assert.equal(spanEnabled({ PI_SPAN: "typo" }), false);
  assert.equal(spanEnabled({ PI_SPAN: "off" }), false);
  assert.equal(spanEnabled({ PI_OFFLINE: "1" }), false);
  assert.equal(spanShadow({}), true);
  assert.equal(spanShadow({ PI_SPAN_SHADOW: "0" }), false);
});

test('default Span scoring never invokes the scorer or bills calibration', async () => {
  let calls = 0;
  const entries = [];
  const result = await rawScoreSpanTrace(traceFrom(fixtures.traces[0].events), async () => {
    calls++; throw Error('default scoring must stay idle');
  }, { env: {}, pi: { appendEntry: (...entry) => entries.push(entry) } });
  assert.equal(result.skipped, 'disabled');
  assert.equal(calls, 0);
  assert.deepEqual(entries, []);
});

test("paid calls are ledgered for cost/metrics", async () => {
  clearSpanCache();
  try {
    const entries = [];
    const scorer = async () => ({ text: JSON.stringify(scoresFor([])), model: "lite", inputTokens: 11, costUsd: 0.001, ms: 3 });
    const trace = traceFrom(fixtures.traces[3].events);
    const pi = { appendEntry: (type, data) => entries.push([type, data]) };
    await scoreSpanTrace(trace, scorer, { env: { PI_SPAN_SHADOW: "0" }, pi });
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], "span-usage-v1");
    assert.equal(entries[0][1].inputTokens, 11);
    assert.equal(entries[0][1].costSource, 'provider-reported');
    assert.equal(entries[0][1].cached, false);
    // Cached rescores ledger like cached Jev answers: counted, unbilled.
    await scoreSpanTrace(trace, scorer, { env: { PI_SPAN_SHADOW: "0" }, pi });
    assert.equal(entries.length, 2);
    assert.equal(entries[1][1].cached, true);
    assert.equal(entries[1][1].costUsd, 0);
    clearSpanCache();
    await scoreSpanTrace(trace, async () => ({ text: JSON.stringify(scoresFor([])), model: 'fixture', costUsd: 0, ms: 3 }), { pi });
    assert.equal(entries[2][1].costUsd, 0);
    assert.equal(entries[2][1].costSource, 'provider-reported');
  } finally {
    clearSpanCache();
  }
});

test('missing provider usage stays unknown in the span receipt, while cache reuse is unbilled', async () => {
  clearSpanCache();
  try {
    const entries = [];
    const scorer = async () => ({ text: JSON.stringify(scoresFor([])), model: 'fixture', ms: 3 });
    const trace = traceFrom(fixtures.traces[3].events);
    const pi = { appendEntry: (type, data) => entries.push([type, data]) };
    await scoreSpanTrace(trace, scorer, { pi });
    assert.equal(entries[0][1].inputTokens, undefined);
    assert.equal(entries[0][1].costUsd, undefined);
    assert.equal(entries[0][1].costSource, undefined);
    assert.equal(entries[0][1].cached, false);
    await scoreSpanTrace(trace, scorer, { pi });
    assert.equal(entries[1][1].cached, true);
    assert.equal(entries[1][1].inputTokens, 0);
    assert.equal(entries[1][1].costUsd, 0);
  } finally {
    clearSpanCache();
  }
});

test('span cached results cannot be changed by consumers or bill the original usage again', async () => {
  clearSpanCache();
  try {
    const trace = traceFrom(fixtures.traces[0].events), expected = scoresFor(['verification-gap']);
    const scorer = async () => ({ text: JSON.stringify(expected), model: 'fixture', inputTokens: 12, costUsd: .001, ms: 1 });
    const first = await scoreSpanTrace(trace, scorer);
    first.scores['verification-gap'].present = 0;
    const second = await scoreSpanTrace(trace, scorer);
    assert.deepEqual(second.scores, expected); assert.equal(second.inputTokens, 0); assert.equal(second.costUsd, 0);
    second.scores['verification-gap'].present = 0;
    assert.deepEqual((await scoreSpanTrace(trace, scorer)).scores, expected);
  } finally { clearSpanCache(); }
});

test('span rejects an aborted scorer result and does not preserve it in the cache', async () => {
  clearSpanCache();
  try {
    const controller = new AbortController(), trace = traceFrom(fixtures.traces[0].events);
    const answer = { text: JSON.stringify(scoresFor([])), model: 'fixture', ms: 1 };
    const result = await scoreSpanTrace(trace, async () => { controller.abort(); return answer; }, { signal: controller.signal });
    assert.equal(result.ok, false); assert.equal(result.skipped, 'aborted');
    assert.equal((await scoreSpanTrace(trace, async () => answer)).cached, false);
  } finally { clearSpanCache(); }
});


test('Span deadlines suppress late cache publication even when the scorer ignores cancellation', { timeout: 2000 }, async () => {
  const trace = traceFrom(fixtures.traces[0].events);
  const answer = () => ({ text: JSON.stringify(scoresFor(['repeated-failure-loop'])), model: 'fixture', inputTokens: 1, costUsd: .001, ms: 1 });
  try {
    for (const reason of ['timeout', 'aborted']) {
      clearSpanCache(); metricsMod.resetMicroMetrics();
      const controller = new AbortController();
      let resolveLate, rejectLate, offered;
      const pending = scoreSpanTrace(trace, (_prompt, { signal }) => {
        offered = signal; return new Promise((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
      }, { env: {}, timeoutMs: reason === 'timeout' ? 10 : 1000, signal: controller.signal });
      if (reason === 'aborted') controller.abort();
      const result = await pending;
      assert.equal(result.ok, false); assert.equal(result.skipped, reason); assert.equal(offered.aborted, true);
      assert.equal(metricsMod.microMetrics().snapshot().helpers.span.skipReasons[reason], 1);
      if (reason === 'timeout') resolveLate(answer()); else rejectLate(Error('late scorer failure'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(metricsMod.microMetrics().snapshot().helpers.span.accepted, 0);
      let calls = 0;
      const retry = await scoreSpanTrace(trace, async () => { calls++; return answer(); }, { env: {} });
      assert.equal(calls, 1, 'late score was not cached'); assert.equal(retry.cached, false);
    }
    clearSpanCache();
    let offered;
    const result = await scoreSpanTrace(trace, async (_prompt, { signal }) => { offered = signal; return answer(); }, { env: {}, timeoutMs: 10 });
    assert.equal(result.ok, true);
    await delay(20); assert.equal(offered.aborted, false, 'successful scorer clears its timer');
    clearSpanCache();
    await scoreSpanTrace(trace, async (_prompt, { timeoutMs }) => {
      assert.equal(timeoutMs, spanMod.SPAN_REQUEST_TIMEOUT_MS); return answer();
    }, { env: {}, timeoutMs: NaN });
  } finally { clearSpanCache(); metricsMod.resetMicroMetrics(); }
});
