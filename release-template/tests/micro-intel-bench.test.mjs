// Micro-intelligence calibration benchmark. Deterministic contracts assert
// hard floors (CI must hold them); model-quality numbers print for review
// and assert only structural validity, since model behavior legitimately
// varies by deployment. Needle sections run only when assets verify;
// everything else always runs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const fixtures = path.join(import.meta.dirname, "fixtures", "micro-intel");
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const local = await load("extensions/lib/local-intelligence.mjs");
const evidenceMod = await load("extensions/lib/micro-intelligence/evidence.ts");
const mini = await load("extensions/lib/mini-preprocessor.ts");
const smol = await load("extensions/lib/smol-preprocessor.ts");
const diag = await load("extensions/lib/session-diagnostics.ts");
const needleRuntime = await load("extensions/lib/needle-runtime.ts");
const needleAssets = await load("extensions/lib/needle-assets.mjs");

const routing = JSON.parse(fs.readFileSync(path.join(fixtures, "routing.json"), "utf8"));
const intent = JSON.parse(fs.readFileSync(path.join(fixtures, "intent.json"), "utf8"));
const errors = JSON.parse(fs.readFileSync(path.join(fixtures, "errors.json"), "utf8"));

const check = await needleAssets.verifyAssets(needleAssets.needleAssetDir(), false).catch(() => ({ ok: false }));
const HAS_NEEDLE = check.ok === true;

const lexicalTop = (query, candidates) => {
  const scores = local.relevanceScores(
    candidates.map((c) => c.text),
    query,
  );
  let best = 0;
  scores.forEach((score, i) => { if (score > scores[best]) best = i; });
  return { top: candidates[best].id, scores };
};

test("lexical baseline holds the easy routing set", () => {
  let hits = 0;
  const latencies = [];
  for (const fixture of routing.lexical) {
    const start = performance.now();
    const { top } = lexicalTop(fixture.query, fixture.candidates);
    latencies.push(performance.now() - start);
    if (top === fixture.expected) hits++;
  }
  console.log(`bench lexical-routing: ${hits}/${routing.lexical.length} top-1`);
  assert.ok(hits >= 5, `lexical baseline must hold easy fixtures (got ${hits}/6)`);
});

test("paraphrase set contains genuine zero-overlap cases", () => {
  // Lexical retrieval is strong when vocabulary overlaps; the fixtures must
  // still prove that some realistic queries score nothing lexically at all.
  // Those are the cases where semantic ranking earns its keep.
  let zeroOverlap = 0;
  for (const fixture of routing.semantic) {
    const { scores } = lexicalTop(fixture.query, fixture.candidates);
    if (scores.every((score) => score === 0)) zeroOverlap++;
  }
  console.log(`bench lexical-zero-overlap: ${zeroOverlap}/${routing.semantic.length} fixtures`);
  assert.ok(zeroOverlap >= 2, "paraphrase set must include cases lexical cannot touch");
});

test("needle rank serves every query with calibrated acceptance (asset-gated)", { skip: !HAS_NEEDLE && "needle assets not installed" }, async () => {
  const handle = needleRuntime.createNeedleRuntime({});
  try {
    let hits = 0, accepted = 0, acceptedWrong = 0;
    const latencies = [];
    for (const fixture of routing.semantic) {
      const start = performance.now();
      const result = await handle.rank({ query: fixture.query, candidates: fixture.candidates, topK: 3 });
      latencies.push(performance.now() - start);
      assert.equal(result.ok, true, `needle serves ${fixture.query}`);
      const top = result.value.ranked[0];
      if (top.id === fixture.expected) hits++;
      else console.log(`bench needle-miss: "${fixture.query}" -> ${top.id} (want ${fixture.expected})`);
      // Mirror the production acceptance bars (score >= 0.93, margin >= 0.02).
      if (top.score >= 0.93 && result.value.margin >= 0.02) {
        accepted++;
        if (top.id !== fixture.expected) acceptedWrong++;
      }
    }
    latencies.sort((a, b) => a - b);
    console.log(`bench needle-routing: ${hits}/${routing.semantic.length} top-1, accepted ${accepted}, p50 ${latencies[Math.floor(latencies.length / 2)].toFixed(0)}ms`);
    assert.equal(acceptedWrong, 0, "an accepted needle verdict must never misrank (bars too loose)");
  } finally {
    await handle.shutdown();
  }
});

test("system escalation rescues every needle miss (asset-gated)", { skip: !HAS_NEEDLE && "needle assets not installed" }, async () => {
  // The architectural guarantee: needle proposes, and uncertainty or
  // disagreement escalates to Jev instead of misapplying. With a correct
  // judge, the blended system must reach 6/6 even where needle alone misses.
  const retrievalMod = await load("extensions/lib/micro-intelligence/retrieval.ts");
  const handle = needleRuntime.createNeedleRuntime({});
  try {
    let appliedNeedle = 0, appliedJev = 0;
    for (const fixture of routing.semantic) {
      const scored = fixture.candidates
        .map((candidate) => ({ candidate, score: local.relevanceScores([candidate.text], fixture.query)[0] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map(({ candidate }) => candidate);
      const outcome = await retrievalMod.multiStageRetrieve({
        kind: "tool", site: "bench", query: fixture.query, lexical: scored,
        needle: (query, candidates, topK) => handle.rank({ query, candidates, topK }),
        jev: async () => ({
          ok: true,
          answers: {
            rank: { choice: fixture.expected, probabilities: { [fixture.expected]: 0.8 } },
            exists: { noul: 0.9 },
          },
          usage: { inputTokens: 100, cached: false },
        }),
      });
      if (outcome.applied === "needle") appliedNeedle++;
      if (outcome.applied === "jev") appliedJev++;
      assert.equal(outcome.ordered[0].id, fixture.expected, `system top-1 for "${fixture.query}" (applied ${outcome.applied})`);
    }
    console.log(`bench system-blend: applied needle=${appliedNeedle} jev=${appliedJev} lexical=0, top-1 6/6`);
  } finally {
    await handle.shutdown();
  }
});

test("intent pre-screen decides safely under asymmetric bars (asset-gated)", { skip: !HAS_NEEDLE && "needle assets not installed" }, async () => {
  const intentMod = await load("extensions/lib/micro-intelligence/intent.ts");
  const bars = intentMod.PRESCREEN_BARS;
  const handle = needleRuntime.createNeedleRuntime({});
  try {
    let decided = 0, correct = 0;
    for (const fixture of intent.tasks) {
      const result = await handle.classify({ text: fixture.task, labels: intentMod.PRESCREEN_LABELS });
      assert.equal(result.ok, true);
      const { label, score, margin } = result.value;
      const verdict = label === "implementation" && score >= bars.implementation.score && margin >= bars.implementation.margin
        ? "implementation"
        : label === "read-only" && score >= bars.readOnly.score && margin >= bars.readOnly.margin
          ? "read-only"
          : "defer";
      if (verdict !== "defer") {
        decided++;
        if (verdict === fixture.expected) correct++;
        else console.log(`bench intent-miss: "${fixture.task}" -> ${verdict} (want ${fixture.expected})`);
      }
    }
    console.log(`bench needle-intent: decided ${decided}/${intent.tasks.length}, correct ${correct}/${decided}`);
    assert.ok(decided >= 4, "pre-screen should decide at least half the intent set");
    assert.equal(correct, decided, "every pre-screen verdict must match (no false rescue, no false block)");
  } finally {
    await handle.shutdown();
  }
});

test("deterministic error families hold the easy set", () => {
  let hits = 0;
  for (const fixture of errors.errors) {
    const verdict = diag.failureCategory(fixture.text);
    if (verdict.category === fixture.expected) hits++;
    else console.log(`bench deterministic-error-miss: want ${fixture.expected}, got ${verdict.category}`);
    assert.ok(verdict.recovery && verdict.recovery.length > 10, "every verdict carries recovery guidance");
  }
  console.log(`bench deterministic-errors: ${hits}/${errors.errors.length}`);
  assert.ok(hits >= 4, "deterministic families must hold easy fixtures");
});

test("evidence gate fallout on realistic shapes", () => {
  const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
  const prose = ["Status update for the current deployment window.", ...Array(9).fill(filler)].join("\n\n");
  const rows = ["header line for output"];
  for (let i = 0; i < 80; i++) rows.push(`entry-${String(i).padStart(3, "0")}.log bytes=${10000 + i * 137}`.padEnd(42, "."));
  rows.push("listing complete");
  const structured = rows.join("\n");
  const log = ["Traceback (most recent call last):", '  File "app.py", line 42, in main', "ValueError: bad value", "x".repeat(1200)].join("\n");
  const cases = [
    ["prose-doc", prose, "prose"],
    ["structured-listing", structured, "structured"],
    ["error-text", log, "structured"],
    ["tiny", "ok\n", "trivial"],
  ];
  for (const [name, text, shape] of cases) {
    const got = evidenceMod.contentShape(text);
    const route = evidenceMod.routeEvidence({ tool: "bash", text, isError: name === "error-text" });
    console.log(`bench shape ${name}: shape=${got} smol=${route.smol} kompress=${route.kompress} needle=${route.needle} jev=${route.jev}`);
    if (name !== "error-text") assert.equal(got, shape, name);
  }
  assert.equal(mini.miniSource(prose) !== undefined, true, "prose doc is kompress-eligible");
  assert.equal(smol.safeSmolOutput("bash", structured, false, undefined), true, "listing is smol-eligible");
});
