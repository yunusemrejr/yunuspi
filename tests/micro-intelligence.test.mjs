// Micro-intelligence coordination: metrics, coordinator, health, retrieval,
// evidence routing, advisory, review helpers and status snapshots.
// All model dependencies are mocked; no network, no workers, no assets.
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
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");
const coordMod = await load("extensions/lib/micro-intelligence/coordinator.ts");
const healthMod = await load("extensions/lib/micro-intelligence/health.ts");
const retrievalMod = await load("extensions/lib/micro-intelligence/retrieval.ts");
const evidenceMod = await load("extensions/lib/micro-intelligence/evidence.ts");
const advisoryMod = await load("extensions/lib/micro-intelligence/advisory.ts");
const reviewMod = await load("extensions/lib/micro-intelligence/review.ts");
const statusMod = await load("extensions/lib/micro-intelligence/status.ts");

test("metrics record offers/runs/skips and render honest summaries", () => {
  const metrics = metricsMod.createMicroMetrics();
  metrics.offer("needle");
  metrics.run("needle", 12, 500);
  metrics.accept("needle");
  metrics.skip("smol", "too-small");
  metrics.jevUsage("rank", 2, 400, 0.0001, false);
  metrics.llmHelperCall();
  metrics.llmAvoided(800);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.helpers.needle.offers, 1);
  assert.equal(snapshot.helpers.needle.runs, 1);
  assert.equal(snapshot.helpers.smol.skipReasons["too-small"], 1);
  assert.equal(snapshot.jev.questions, 2);
  assert.equal(snapshot.llm.helperCalls, 1);
  assert.equal(snapshot.llm.avoided, 1);
  assert.ok(snapshot.helpers.needle.latencies.length === 1);
  const lines = metrics.summaryLines();
  assert.ok(lines.some((line) => line.startsWith("needle:")));
  assert.ok(lines.some((line) => line.includes("est-tokens-avoided")));
  // Snapshots are copies: mutating them cannot corrupt the collector.
  snapshot.helpers.needle.offers = 999;
  assert.equal(metrics.snapshot().helpers.needle.offers, 1);
});

test("latencyStats computes p50/p95 over the ring", () => {
  assert.deepEqual(metricsMod.latencyStats([]), { p50: 0, p95: 0, count: 0 });
  const stats = metricsMod.latencyStats([10, 20, 30, 40]);
  assert.equal(stats.count, 4);
  assert.ok(stats.p50 <= stats.p95);
});

test("coordinator dedupes inflight work and caches results", async () => {
  const coord = coordMod.createCoordinator({ cacheMax: 8 });
  let runs = 0;
  const worker = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return { value: 42 };
  };
  const [a, b] = await Promise.all([
    coord.assist("k1", "needle", "test", worker),
    coord.assist("k1", "needle", "test", worker),
  ]);
  assert.equal(runs, 1);
  assert.deepEqual(a.value, { value: 42 });
  assert.equal(a.provenance.helper, "needle");
  const cached = await coord.assist("k1", "needle", "test", worker);
  assert.equal(runs, 1);
  assert.equal(cached.provenance.cached, true);
  const summary = coord.ledgerSummary();
  assert.equal(summary["needle:deduped"], 1);
  assert.equal(summary["needle:served-cached"], 1);
});

test("coordinator tracks processed evidence and escalation chains", () => {
  const coord = coordMod.createCoordinator();
  coord.markProcessed("obs-1", "smol");
  coord.markProcessed("obs-1", "needle");
  assert.deepEqual(coord.processedBy("obs-1").sort(), ["needle", "smol"]);
  assert.deepEqual(coord.processedBy("obs-unknown"), []);
  coord.escalate("rank", "needle", "jev");
  assert.deepEqual(coord.escalationChain("rank"), ["needle", "jev"]);
  assert.ok(coordMod.opportunityKey(["a", 1]).length === 32);
});

test("health renders the compact five-layer block", () => {
  const snapshot = healthMod.microHealthSnapshot([
    { layer: "deterministic", status: "ready", detail: "" },
    { layer: "needle", status: "ready", detail: "dim 3072" },
    { layer: "smol", status: "busy", detail: "" },
    { layer: "kompress", status: "unavailable", detail: "" },
    { layer: "jev", status: "no-key", detail: "" },
  ]);
  assert.equal(snapshot.assisted, true);
  const text = healthMod.renderMicroHealth(snapshot);
  assert.ok(text.includes("needle: ready (dim 3072)"));
  assert.ok(text.includes("jev: no-key"));
  assert.equal(healthMod.needleStatus("healthy"), "ready");
  assert.equal(healthMod.needleStatus("cooling"), "breaker-open");
  assert.equal(healthMod.jevStatus(true, true), "breaker-open");
  assert.equal(healthMod.jevStatus(false, false), "no-key");
});

const lexicalTools = [
  { id: "read", text: "read: read a file from disk" },
  { id: "browser_session", text: "browser_session: capture a browser screenshot" },
  { id: "bash", text: "bash: run a shell command" },
];

test("retrieval keeps lexical order for trivial/single inputs", async () => {
  let needleCalls = 0;
  const single = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "screenshot", lexical: lexicalTools.slice(0, 1),
    needle: async () => { needleCalls++; throw new Error("must not run"); },
  });
  assert.equal(single.applied, "lexical");
  const trivial = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "x", lexical: lexicalTools,
    needle: async () => { needleCalls++; throw new Error("must not run"); },
  });
  assert.equal(trivial.applied, "lexical");
  assert.equal(needleCalls, 0);
});

test("retrieval applies an accepted needle win", async () => {
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "take a browser screenshot",
    lexical: lexicalTools,
    needle: async () => ({
      ok: true, cached: false, ms: 5, shadow: false,
      value: {
        ranked: [
          { id: "browser_session", score: 0.97 },
          { id: "read", score: 0.91 },
          { id: "bash", score: 0.90 },
        ],
        margin: 0.06,
      },
    }),
  });
  assert.equal(outcome.applied, "needle");
  assert.equal(outcome.ordered[0].id, "browser_session");
  assert.equal(outcome.needleTop, "browser_session");
});

test("retrieval escalates disagreement to jev validation", async () => {
  let jevCalls = 0;
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "take a browser screenshot",
    lexical: lexicalTools,
    needle: async () => ({
      ok: true, cached: false, ms: 5, shadow: false,
      value: {
        // Uncertain: thin margin and disagreement with lexical top.
        ranked: [{ id: "bash", score: 0.9 }, { id: "read", score: 0.895 }, { id: "browser_session", score: 0.89 }],
        margin: 0.005,
      },
    }),
    jev: async () => {
      jevCalls++;
      return {
        ok: true,
        answers: {
          rank: { choice: "browser_session", probabilities: { browser_session: 0.8, read: 0.1, bash: 0.1 } },
          exists: { noul: 0.9 },
        },
        usage: { inputTokens: 120, cached: false, costUsd: 0.00001 },
      };
    },
    jevMark: (site, detail) => `[jev ${site} ${detail}]`,
  });
  assert.equal(outcome.applied, "jev");
  assert.equal(jevCalls, 1);
  assert.equal(outcome.ordered[0].id, "browser_session");
  assert.ok(outcome.mark.includes("browser_session"));
});

test("retrieval shadow mode measures but keeps lexical order", async () => {
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "take a browser screenshot",
    lexical: lexicalTools,
    needle: async () => ({
      ok: true, cached: false, ms: 5, shadow: true,
      value: { ranked: [{ id: "bash", score: 0.99 }, { id: "read", score: 0.9 }], margin: 0.09 },
    }),
  });
  assert.equal(outcome.applied, "lexical");
  assert.equal(outcome.ordered[0].id, "read");
  assert.equal(outcome.needleTop, "bash");
});

test("retrieval survives total helper failure", async () => {
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "take a browser screenshot",
    lexical: lexicalTools,
    needle: async () => { throw new Error("down"); },
    jev: async () => { throw new Error("down"); },
  });
  assert.equal(outcome.applied, "lexical");
  assert.deepEqual(outcome.ordered.map((c) => c.id), ["read", "browser_session", "bash"]);
});

test("evidence router classifies shapes deterministically", () => {
  const { contentShape, routeEvidence } = evidenceMod;
  assert.equal(contentShape("tiny"), "trivial");
  assert.equal(contentShape(null), "trivial");
  assert.equal(contentShape("x".repeat(300000)), "unsupported");
  const log = ["TAP version 13", ...Array(40).fill("ok 1 - case passes: path/to/file.js:12")].join("\n");
  assert.equal(contentShape(log), "structured");
  const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
  const prose = [filler, filler, filler, filler, filler, filler].join("\n\n");
  assert.ok(["prose", "mixed"].includes(contentShape(prose)));
  const route = routeEvidence({ tool: "bash", text: log, isError: false });
  assert.equal(route.deterministicFirst, true);
  assert.equal(route.smol, true);
  const distilled = routeEvidence({ tool: "bash", text: log, isError: false, distilled: true });
  assert.equal(distilled.smol, false);
  assert.ok(distilled.reasons.includes("deterministic-won"));
  const error = routeEvidence({ tool: "bash", text: `Error: boom\n${"x".repeat(1200)}`, isError: true });
  assert.equal(error.needle, true);
});

test("evidence router sends uncovered prose to jev and small text nowhere", () => {
  const { routeEvidence } = evidenceMod;
  // Long unstructured text with no mini/smol coverage: jev triage.
  const blob = `${"word ".repeat(2000)}\n${"tail ".repeat(200)}`;
  const route = routeEvidence({ tool: "bash", text: blob, isError: false });
  assert.equal(route.jev, true);
  const small = routeEvidence({ tool: "bash", text: "ok\n".repeat(50), isError: false });
  assert.equal(small.smol, false);
  assert.equal(small.kompress, false);
  assert.equal(small.needle, false);
  assert.equal(small.jev, false);
});

test("advisory deterministic pass extracts terms and intent cues", () => {
  const { deterministicRequestPass } = advisoryMod;
  const pass = deterministicRequestPass("Please investigate the authentication timeout in the login handler");
  assert.ok(pass.terms.includes("authentication") || pass.terms.includes("investigate"));
  assert.equal(pass.substantive, true);
  assert.equal(pass.pivot, false);
  assert.equal(deterministicRequestPass("do not continue with this").refusal, true);
  assert.equal(deterministicRequestPass("do not continue with this").substantive, false);
  assert.equal(deterministicRequestPass("forget that, start over with billing").pivot, true);
  assert.equal(deterministicRequestPass("hi").substantive, false);
});

test("advisory builds one compact batch and gates trivial requests", () => {
  const { buildAdvisoryQuestions, shouldAdvise, deterministicRequestPass } = advisoryMod;
  const impl = buildAdvisoryQuestions({ prompt: "implement x", family: "implementation", terms: ["x"], candidates: [] });
  assert.ok(impl.kind && impl.reviewWorthy && impl.multiPerspective && impl.perspective);
  assert.ok(Object.keys(impl).length <= 7);
  const lookup = buildAdvisoryQuestions({ prompt: "show x", family: "lookup", terms: ["x"], candidates: [] });
  assert.equal(lookup.multiPerspective, undefined);
  const withCandidates = buildAdvisoryQuestions({ prompt: "do x", family: "lookup", terms: ["x"], candidates: ["a", "b"] });
  assert.ok(withCandidates.fit && withCandidates.noFit);
  assert.equal(shouldAdvise(deterministicRequestPass("hi"), 0), false);
  assert.equal(shouldAdvise(deterministicRequestPass("forget that, start over"), 0), false);
  const substantive = deterministicRequestPass("Implement user authentication with session cookies and tests");
  assert.equal(shouldAdvise(substantive, 0), true);
});

test("advisory runs asynchronously and never throws", async () => {
  const { runAdvisory } = advisoryMod;
  const seen = await new Promise((resolve) => {
    runAdvisory(
      { prompt: "implement x", family: "implementation", terms: ["x"], candidates: [] },
      async () => ({
        ok: true,
        answers: {
          kind: { choice: "implementation" },
          needsVerification: { noul: 0.1 },
          reviewWorthy: { noul: 0.8 },
          multiPerspective: { noul: 0.7 },
          perspective: { choice: "security", probabilities: { security: 0.6, testing: 0.3 } },
        },
        usage: { inputTokens: 200, cached: false, costUsd: 0.00002 },
      }),
      resolve,
    );
  });
  assert.equal(seen.ok, true);
  assert.equal(seen.reviewWorthy, true);
  assert.equal(seen.multiPerspective, true);
  assert.deepEqual(seen.perspectives, ["security", "testing"]);
  const skipped = await new Promise((resolve) => {
    runAdvisory({ prompt: "x", family: "lookup", terms: [], candidates: [] }, async () => ({ ok: false, skipped: "no-key" }), resolve);
  });
  assert.equal(skipped.ok, false);
  const crashed = await new Promise((resolve) => {
    runAdvisory({ prompt: "x", family: "lookup", terms: [], candidates: [] }, async () => { throw new Error("boom"); }, resolve);
  });
  assert.equal(crashed.ok, false);
  assert.equal(crashed.skipped, "unavailable");
});

test("needle request pass classifies families and degrades cleanly", async () => {
  const { needleRequestPass } = advisoryMod;
  const pass = await needleRequestPass("fix the failing login test now", async () => ({
    ok: true, cached: false, ms: 3, shadow: false,
    value: { label: "implementation", score: 0.95, margin: 0.02, accepted: true },
  }));
  assert.equal(pass.family, "implementation");
  assert.equal(await needleRequestPass("fix it", undefined), undefined);
  assert.equal(await needleRequestPass("hi", async () => { throw new Error("x"); }), undefined);
});

test("review helpers rank perspectives and cluster findings", async () => {
  const { selectPerspectives, clusterFindings, judgeDuplicatePair } = reviewMod;
  const perspectives = await selectPerspectives("audit the authentication flow for vulnerabilities", async (_q, cands, topK) => ({
    ok: true, cached: false, ms: 2, shadow: false,
    value: { ranked: [{ id: "security", score: 0.97 }, { id: "correctness", score: 0.93 }].slice(0, topK), margin: 0.04 },
  }));
  assert.deepEqual(perspectives, ["security", "correctness"]);
  assert.deepEqual(await selectPerspectives("x", undefined), []);
  // Deterministic clustering merges near-identical findings without inference.
  const groups = await clusterFindings([
    { id: "a", text: "the login handler leaks the session token in error messages" },
    { id: "b", text: "the login handler leaks the session token in error responses" },
    { id: "c", text: "the billing page uses a deprecated date picker" },
  ]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].includes("a") && groups[0].includes("b"));
  const judged = await judgeDuplicatePair(
    { id: "a", text: "finding one" },
    { id: "b", text: "finding two" },
    async () => ({ ok: true, answers: { duplicate: { noul: 0.9 } }, usage: { inputTokens: 50, cached: false } }),
  );
  assert.deepEqual(judged, { duplicate: true, ok: true });
  const uncertain = await judgeDuplicatePair({ id: "a", text: "x" }, { id: "b", text: "y" }, async () => ({
    ok: true, answers: { duplicate: { noul: 0.5 } }, usage: { inputTokens: 50, cached: true },
  }));
  assert.deepEqual(uncertain, { duplicate: false, ok: false });
});

test("status snapshot reports health without running inference", async () => {
  const key = Symbol.for("yunus-pi.micro.inspect.v1");
  const prior = globalThis[key];
  globalThis[key] = { smol: () => ({ busy: false, accepted: 3 }), mini: () => { throw new Error("x"); } };
  try {
    const snapshot = statusMod.microStatusSnapshot({
      family: "implementation", substantive: true, terms: ["auth"],
      needle: { score: 0.9, margin: 0.02, accepted: true },
      advisory: { ok: true, needsVerification: false, reviewWorthy: true, multiPerspective: false, perspectives: ["security"] },
    });
    assert.equal(snapshot.health.layers.length, 5);
    assert.equal(snapshot.request.family, "implementation");
    assert.ok(snapshot.needle && typeof snapshot.needle === "object");
    assert.ok(Array.isArray(snapshot.metrics));
    assert.ok(snapshot.smol && typeof snapshot.smol === "object");
    assert.deepEqual(snapshot.kompress, { status: "unavailable" });
  } finally {
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
  }
});
