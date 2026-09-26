// Typed Jev/Kev decisions: registry bars, shadow calibration, failure
// degradation. The judge is always mocked; no network.
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
const decisionsMod = await load("extensions/lib/micro-intelligence/jev-decisions.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

const { TYPED_DECISIONS, askTypedDecision } = decisionsMod;

const judgeWith = (answers, usage = { inputTokens: 12, cached: false, costUsd: 0.001 }) =>
  async (site, state, questions) => {
    assert.ok(typeof site === "string" && site.length);
    assert.ok(state && typeof state === "object");
    assert.ok(questions && typeof questions === "object");
    return { ok: true, answers, usage };
  };

test("registry names all thirteen decision types with owners", () => {
  const ids = Object.keys(TYPED_DECISIONS).sort();
  assert.deepEqual(ids, [
    "claim-verification", "delegation-topology", "evidence-relevance",
    "memory-admission", "observer-admission", "observer-focus",
    "recovery-strategy", "requirement-closure", "review-aspects",
    "tool-intent-alignment", "tool-skill-shortlist", "verification-method",
    "watchmaker-admission",
  ]);
  for (const spec of Object.values(TYPED_DECISIONS)) {
    assert.ok(spec.site && spec.owner && spec.maxStateChars > 0);
  }
});

test("noul decisions accept at the bars and abstain between them", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const high = await askTypedDecision("requirement-closure",
      { state: { requirement: "r", evidence: "e" } },
      { judge: judgeWith({ supported: { noul: 0.85 } }) });
    assert.equal(high.ok, true);
    assert.deepEqual(high.verdict, { supported: true, label: "supported" });

    const low = await askTypedDecision("claim-verification",
      { state: { claim: "c", evidence: "e" } },
      { judge: judgeWith({ verified: { noul: 0.1 } }) });
    assert.equal(low.ok, true);
    assert.deepEqual(low.verdict.supported, false);

    const mid = await askTypedDecision("evidence-relevance",
      { state: { question: "q", excerpt: "x" } },
      { judge: judgeWith({ relevant: { noul: 0.5 } }) });
    assert.equal(mid.ok, false);
    assert.equal(mid.reason, "low-confidence");
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("choice decisions validate the winner and its distribution", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const good = await askTypedDecision("delegation-topology",
      { state: { task: "t" } },
      { judge: judgeWith({ topology: { choice: "swarm", probabilities: { single: 0.1, swarm: 0.7, fusion: 0.2 } } }) });
    assert.equal(good.ok, true);
    assert.deepEqual(good.verdict, { topology: "swarm" });

    const weak = await askTypedDecision("recovery-strategy",
      { state: { failure: "f" } },
      { judge: judgeWith({ strategy: { choice: "escalate", probabilities: { escalate: 0.2 } } }) });
    assert.equal(weak.ok, false);

    const unknown = await askTypedDecision("verification-method",
      { state: { claim: "c" } },
      { judge: judgeWith({ method: { choice: "telepathy", probabilities: { telepathy: 0.9 } } }) });
    assert.equal(unknown.ok, false);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("review-aspects only ever adds aspects", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const verdict = await askTypedDecision("review-aspects",
      { state: { files: "a.ts", task: "t" } },
      {
        judge: judgeWith({
          correctness: { noul: 0.9 }, security: { noul: 0.95 }, interface: { noul: 0.1 },
          content: { noul: 0.1 }, runtime: { noul: 0.1 }, delivery: { noul: 0.1 },
        }),
      });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.verdict, { add: ["correctness", "security"] });

    const none = await askTypedDecision("review-aspects",
      { state: { files: "a.md", task: "t" } },
      { judge: judgeWith({ correctness: { noul: 0.1 }, security: { noul: 0.1 }, interface: { noul: 0.1 }, content: { noul: 0.1 }, runtime: { noul: 0.1 }, delivery: { noul: 0.1 } }) });
    assert.equal(none.ok, false);
    assert.equal(none.reason, "no-additions");
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("shortlist rejects trivial candidate sets", async () => {
  metricsMod.resetMicroMetrics();
  try {
    let calls = 0;
    const judge = async () => { calls++; return { ok: true, answers: {}, usage: { inputTokens: 1, cached: false } }; };
    const verdict = await askTypedDecision("tool-skill-shortlist",
      { state: { task: "t" }, candidates: ["only-one"] }, { judge });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "trivial");
    assert.equal(calls, 0);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("shadow mode interprets but never applies", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const verdict = await askTypedDecision("observer-admission",
      { state: { packet: "p" } },
      { judge: judgeWith({ worthwhile: { noul: 0.9 } }), shadow: true });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "shadow");
    assert.deepEqual(verdict.verdict, { supported: true, label: "review-worthwhile" });
    const snapshot = metricsMod.microMetrics().snapshot();
    assert.equal(snapshot.helpers.jev.skipReasons.shadow, 1);
    assert.equal(snapshot.helpers.jev.accepted, 0);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("judge failures degrade to unknown with skip reasons", async () => {
  metricsMod.resetMicroMetrics();
  try {
    assert.deepEqual(await askTypedDecision("memory-admission", { state: {} }, { judge: undefined }), { ok: false, reason: "no-judge" });
    const skipped = await askTypedDecision("memory-admission", { state: {} }, { judge: async () => ({ ok: false, skipped: "busy" }) });
    assert.equal(skipped.reason, "skipped:busy");
    const threw = await askTypedDecision("memory-admission", { state: {} }, { judge: async () => { throw Error("down"); } });
    assert.equal(threw.reason, "unavailable");
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("tool-intent reports alignment and risk separately", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const verdict = await askTypedDecision("tool-intent-alignment",
      { state: { tool: "bash", intent: "list files" } },
      { judge: judgeWith({ aligned: { noul: 0.95 }, risky: { noul: 0.1 } }) });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.verdict, { aligned: true, risky: false });
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test('review admission needs both novelty and progress evidence; cancelled or unused verdicts are not applied', async () => {
  metricsMod.resetMicroMetrics();
  try {
    for (const id of ['observer-admission', 'watchmaker-admission']) {
      for (const [worthwhile, routine, deferred] of [[.1, .9, true], [.1, .5, false], [.3, .9, false], [.1, undefined, false], [-1, 1, false]]) {
        const result = await askTypedDecision(id, { state: { previous: [], current: [] } }, {
          judge: judgeWith({ worthwhile: { noul: worthwhile }, routine: { noul: routine } }), recordAcceptance: false,
        });
        assert.equal(result.ok && result.verdict?.supported === false, deferred);
      }
    }
    assert.equal(metricsMod.microMetrics().snapshot().helpers.jev.accepted, 0);
    const controller = new AbortController();
    const result = await askTypedDecision('observer-admission', { state: { previous: [], current: [] } }, {
      signal: controller.signal, judge: async (_site, _state, _questions, options) => {
        assert.equal(options.signal, controller.signal); controller.abort();
        return judgeWith({ worthwhile: { noul: .1 }, routine: { noul: .9 } })('observer-admit', {}, {});
      },
    });
    assert.equal(result.reason, 'aborted');
    assert.equal(metricsMod.microMetrics().snapshot().helpers.jev.accepted, 0);
  } finally { metricsMod.resetMicroMetrics(); }
});
