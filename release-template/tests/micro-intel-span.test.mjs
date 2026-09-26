// Span behavior sensor: catalog, trace bounds, cache, thresholds, shadow,
// advisory gating, scorer fallback. All remote calls are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  parseSpanScores, scoreSpanTrace, spanAdvisory, openRouterSpanScorer,
  clearSpanCache, spanEnabled, spanShadow,
} = spanMod;

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
      assert.ok(prompt.includes("repeated-failure-loop"));
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

test("paid fallback runs only for a missing Lite route", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    const model = JSON.parse(opts.body).model;
    seen.push(model);
    if (model === "respan/span-01-lite") {
      return { ok: false, status: 404, text: async () => "model not found" };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(scoresFor([])) } }], usage: { prompt_tokens: 5 } }),
    };
  };
  const scorer = openRouterSpanScorer({ fetchImpl, key: () => "k" });
  const answer = await scorer("trace", {});
  assert.equal(answer.model, "respan/span-01");
  assert.deepEqual(seen, ["respan/span-01-lite", "respan/span-01"]);

  // Auth failures never trigger the paid fallback.
  const seenAuth = [];
  const authFetch = async (url, opts) => {
    seenAuth.push(JSON.parse(opts.body).model);
    return { ok: false, status: 401, text: async () => "unauthorized" };
  };
  await assert.rejects(openRouterSpanScorer({ fetchImpl: authFetch, key: () => "bad" })("trace", {}), /span 401/);
  assert.deepEqual(seenAuth, ["respan/span-01-lite"]);
});

test("env gates behave", () => {
  assert.equal(spanEnabled({}), true);
  assert.equal(spanEnabled({ PI_SPAN: "off" }), false);
  assert.equal(spanEnabled({ PI_OFFLINE: "1" }), false);
  assert.equal(spanShadow({}), true);
  assert.equal(spanShadow({ PI_SPAN_SHADOW: "0" }), false);
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
    assert.equal(entries[0][1].cached, false);
    // Cached rescores ledger like cached Jev answers: counted, unbilled.
    await scoreSpanTrace(trace, scorer, { env: { PI_SPAN_SHADOW: "0" }, pi });
    assert.equal(entries.length, 2);
    assert.equal(entries[1][1].cached, true);
    assert.equal(entries[1][1].costUsd, 0);
  } finally {
    clearSpanCache();
  }
});
