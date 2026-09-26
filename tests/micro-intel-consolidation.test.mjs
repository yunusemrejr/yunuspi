// Finding consolidation and semantic margin dedup: deterministic grouping,
// bounded Jev disambiguation, provenance. Rank/judge are mocked.
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
const reviewMod = await load("extensions/lib/micro-intelligence/review.ts");
const bookMod = await load("extensions/lib/observer-book.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

const { consolidateFindings } = reviewMod;
const { findSemanticMarginDuplicate } = bookMod;

const finding = (id, text) => ({ id, text });

test("deterministic consolidation groups overlaps with provenance", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const { groups, singletons } = await consolidateFindings([
      finding("a", "The login handler stores the session token in a cookie without the secure flag set on production domains."),
      finding("b", "The login handler stores the session token in a cookie without the secure flag on production domains."),
      finding("c", "Unrelated: the invoice total ignores discount lines in the footer."),
    ], { sourceOf: (id) => (id === "c" ? "content" : "security") });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kept, "a");
    assert.deepEqual(groups[0].merged.map((m) => m.id), ["b"]);
    assert.equal(groups[0].merged[0].method, "jaccard");
    assert.deepEqual(groups[0].sources, ["security"]);
    assert.deepEqual(singletons, ["c"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("ambiguous pairs earn a bounded Jev judgment", async () => {
  metricsMod.resetMicroMetrics();
  try {
    let calls = 0;
    const ask = async () => {
      calls++;
      return { ok: true, answers: { duplicate: { noul: 0.9 } }, usage: { inputTokens: 5, cached: false } };
    };
    // Mid-overlap pair: same auth-cookie issue, different wording.
    const { groups } = await consolidateFindings([
      finding("a", "Session cookie for authentication lacks the HttpOnly attribute in the web login flow handler."),
      finding("b", "Web login flow handler sets an authentication session cookie missing HttpOnly protection flag."),
    ], { ask, maxJudgePairs: 2 });
    assert.ok(calls <= 2);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].merged.map((m) => m.method), ["jev"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("consolidation bounds input and never throws", async () => {
  const one = await consolidateFindings([finding("a", "solo finding here")]);
  assert.deepEqual(one, { groups: [], singletons: ["a"] });
  const many = await consolidateFindings(Array.from({ length: 100 }, (_, i) => finding(`f${i}`, `finding number ${i} with enough text to qualify`)));
  assert.equal(many.groups.length, 0);
  const failing = await consolidateFindings(
    [finding("a", "alpha beta gamma delta epsilon zeta"), finding("b", "alpha beta gamma delta epsilon eta")],
    { rank: async () => { throw Error("down"); }, ask: async () => { throw Error("down"); } },
  );
  assert.ok(Array.isArray(failing.singletons));
});

test("semantic margin probe confirms paraphrases above bar", async () => {
  const notes = [
    { id: "m1", text: "Always verify production bytes after a deploy, never trust the push receipt.", struckAt: undefined },
    { id: "m2", text: "Unrelated note about font pairing in marketing pages.", struckAt: undefined },
  ];
  const rank = async (query, candidates, topK) => ({
    ok: true, ms: 1, cached: false, shadow: false,
    value: { ranked: [{ id: "m1", score: 0.96 }, { id: "m2", score: 0.5 }].slice(0, topK), margin: 0.46 },
  });
  assert.equal(await findSemanticMarginDuplicate("Never trust a push receipt; always check production bytes after deploying.", notes, rank), "m1");

  const weak = async () => ({
    ok: true, ms: 1, cached: false, shadow: false,
    value: { ranked: [{ id: "m2", score: 0.6 }], margin: 0.1 },
  });
  assert.equal(await findSemanticMarginDuplicate("Something entirely different about databases.", notes, weak), undefined);
  assert.equal(await findSemanticMarginDuplicate("short", notes, rank), undefined);
  assert.equal(await findSemanticMarginDuplicate("A long enough candidate text here.", notes, undefined), undefined);
  assert.equal(await findSemanticMarginDuplicate("A long enough candidate text here.", notes, async () => { throw Error("down"); }), undefined);
});
