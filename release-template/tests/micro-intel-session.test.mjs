// Realistic micro-intelligence sessions: a substantive coding session
// exercises every layer with distinct work; research and review sessions
// use their natural subsets; a trivial session stays quiet. Helpers are
// mocked at the transport edge; the coordination, routing and gating
// logic under test is the real production code.
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
const retrievalMod = await load("extensions/lib/micro-intelligence/retrieval.ts");
const evidenceMod = await load("extensions/lib/micro-intelligence/evidence.ts");
const advisoryMod = await load("extensions/lib/micro-intelligence/advisory.ts");
const reviewMod = await load("extensions/lib/micro-intelligence/review.ts");
const smol = await load("extensions/lib/smol-preprocessor.ts");
const mini = await load("extensions/lib/mini-preprocessor.ts");

// Scripted stand-ins with production-shaped results.
const needleRank = (winner) => async (_query, candidates, topK) => ({
  ok: true, cached: false, ms: 4, shadow: false,
  value: {
    ranked: [...candidates]
      .sort((a, b) => (b.id === winner ? 1 : 0) - (a.id === winner ? 1 : 0))
      .map((c, i) => ({ id: c.id, score: 0.97 - i * 0.03 }))
      .slice(0, topK),
    margin: 0.03,
  },
});
const needleClassify = (label) => async () => ({
  ok: true, cached: false, ms: 3, shadow: false,
  value: { label, score: 0.96, margin: 0.03, accepted: true },
});
const jevRank = (winner) => async () => ({
  ok: true,
  answers: {
    rank: { choice: winner, probabilities: { [winner]: 0.75 } },
    exists: { noul: 0.9 },
  },
  usage: { inputTokens: 150, cached: false, costUsd: 0.00001 },
});

const tools = [
  { id: "read", text: "read: read a file from disk" },
  { id: "bash", text: "bash: run a shell command" },
  { id: "edit", text: "edit: modify file contents" },
];

test("coding session: every layer does distinct useful work", async () => {
  metricsMod.resetMicroMetrics();
  coordMod.resetCoordinator();
  const metrics = metricsMod.microMetrics();
  const coord = coordMod.coordinator();
  const layers = new Set(["deterministic"]);

  // 1. Request arrives: deterministic + needle classification.
  const pass = advisoryMod.deterministicRequestPass("Fix the failing authentication test in the login handler and add coverage");
  assert.equal(pass.substantive, true);
  const family = await advisoryMod.needleRequestPass("Fix the failing authentication test", needleClassify("implementation"));
  assert.equal(family.family, "implementation");
  layers.add("needle");

  // 2. Advisory batch runs once, asynchronously.
  const advisory = await new Promise((resolve) => {
    advisoryMod.runAdvisory(
      { prompt: "Fix the failing test", family: "implementation", terms: pass.terms, candidates: [] },
      async () => ({
        ok: true,
        answers: {
          kind: { choice: "implementation" },
          needsVerification: { noul: 0.1 },
          reviewWorthy: { noul: 0.8 },
          multiPerspective: { noul: 0.2 },
          perspective: { choice: "testing", probabilities: { testing: 0.7 } },
        },
        usage: { inputTokens: 200, cached: false },
      }),
      resolve,
    );
  });
  assert.equal(advisory.reviewWorthy, true);
  layers.add("jev");

  // 3. Tool ranking blends lexical + needle; main LLM would execute.
  const ranked = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "run the failing test", lexical: tools,
    needle: needleRank("bash"),
  });
  assert.equal(ranked.applied, "needle");
  assert.equal(ranked.ordered[0].id, "bash");

  // 4. Real Smol owner, schema validation and sealing; only transport is mocked.
  const log = ["Build completed and bundles ready.", ...Array(36).fill("Routine compilation background describes ordinary bundling activity and surrounding workspace operations."), "Deployment remains pending verification."].join("\n");
  const lineClient = smol.createSmolPreprocessor({
    runtime: { version: 2, enabled: true, model: "SmolLM2-135M-Instruct", endpoint: "http://127.0.0.1:18735/completion", apiKey: "TEST_SYNTHETIC_LOCAL_KEY", execution: "background", timeoutMs: 1000 },
    acquireLease: async () => true,
    fetch: async () => new Response(JSON.stringify({ content: JSON.stringify({ status: "SELECT", lineIds: [2] }) })),
  });
  lineClient.offer("coding-output", log, 0);
  const lineSelection = await lineClient.takeAsync("coding-output", log, 500);
  assert.ok(lineSelection && lineSelection.includes("pending verification"));
  assert.ok(lineSelection.length < log.length - 1000);
  assert.equal(lineClient.inspect().requests, 1);
  assert.equal(lineClient.inspect().accepted, 1);
  layers.add("smol");

  // 5. Real Kompress owner and source projection; only transport is mocked.
  const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
  const prose = ["Deployment remains blocked until external verification.", ...Array(9).fill(filler)].join("\n\n");
  const proseClient = mini.createMiniPreprocessor({
    runtime: { version: 1, enabled: true, endpoint: "http://127.0.0.1:18736/select", apiKey: "TEST_MINI_PREPROCESSOR_KEY_1234567890" },
    fetch: async () => new Response(JSON.stringify({ version: 1, status: "SELECT", sourceHash: mini.miniSource(prose).hash, keep: [0] })),
  });
  const proseSelection = await proseClient.select(prose, undefined);
  const proseProjection = mini.miniProjection(prose, proseSelection);
  assert.ok(proseProjection && proseProjection.includes("blocked until external verification"));
  assert.ok(proseProjection.length < prose.length - 1000);
  assert.equal(proseClient.inspect().requests, 1);
  assert.equal(proseClient.inspect().accepted, 1);
  layers.add("kompress");

  // 6. Review findings cluster deterministically; main LLM decides fixes.
  const groups = await reviewMod.clusterFindings([
    { id: "a", text: "the login handler leaks the session token in error messages" },
    { id: "b", text: "the login handler leaks the session token in error responses" },
  ]);
  assert.equal(groups.length, 1);

  assert.deepEqual([...layers].sort(), ["deterministic", "jev", "kompress", "needle", "smol"]);
  const snapshot = metrics.snapshot();
  assert.ok(snapshot.helpers.needle.runs >= 1);
  for (const helper of ["smol", "kompress"]) {
    assert.equal(snapshot.helpers[helper].runs, 1);
    assert.equal(snapshot.helpers[helper].accepted, 1);
    assert.ok(snapshot.helpers[helper].projectedSavedChars > 1000);
    assert.equal(snapshot.helpers[helper].savedChars, 0, "owner-only test must not claim provider rendering");
  }
  assert.ok(snapshot.jev.questions >= 5, "one batched advisory call, not many tiny ones");
});

test("research session: evidence ranking plus claim validation", async () => {
  metricsMod.resetMicroMetrics();
  const sources = [
    { id: "s1", text: "s1: transformer attention mechanisms explained" },
    { id: "s2", text: "s2: unrelated cooking recipes" },
  ];
  const ranked = await retrievalMod.multiStageRetrieve({
    kind: "source", site: "research", query: "how does attention work", lexical: sources,
    needle: needleRank("s1"),
  });
  assert.equal(ranked.ordered[0].id, "s1");
  const judged = await reviewMod.judgeDuplicatePair(
    { id: "c1", text: "attention scales quadratically with sequence length" },
    { id: "c2", text: "attention cost grows with the square of the sequence" },
    async () => ({ ok: true, answers: { duplicate: { noul: 0.88 } }, usage: { inputTokens: 60, cached: false } }),
  );
  assert.deepEqual(judged, { duplicate: true, ok: true });
});

test("review session: perspectives plus finding triage", async () => {
  const perspectives = await reviewMod.selectPerspectives(
    "audit the payment flow for correctness and safety",
    needleRank("security"),
    2,
  );
  assert.equal(perspectives[0], "security");
});

test("trivial session calls nothing gratuitous", async () => {
  metricsMod.resetMicroMetrics();
  const metrics = metricsMod.microMetrics();
  const pass = advisoryMod.deterministicRequestPass("ok thanks");
  assert.equal(pass.substantive, false);
  let needleCalls = 0, jevCalls = 0;
  await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "ok", lexical: tools,
    needle: async (...args) => { needleCalls++; return needleRank("bash")(...args); },
    jev: async (...args) => { jevCalls++; return jevRank("bash")(...args); },
  });
  assert.equal(needleCalls, 0);
  assert.equal(jevCalls, 0);
  const small = evidenceMod.routeEvidence({ tool: "bash", text: "done\n", isError: false });
  assert.equal(small.smol, false);
  assert.equal(small.kompress, false);
  assert.equal(small.needle, false);
  assert.equal(small.jev, false);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.helpers.needle.runs, 0);
  assert.equal(snapshot.jev.questions, 0);
});

test("smol and kompress selections stay source-linked under load", async () => {
  // Direct-offer path with a mocked runtime: boundary retention holds and
  // the projection never invents lines.
  const rows = ["header line for output"];
  for (let i = 0; i < 80; i++) rows.push(`entry-${String(i).padStart(3, "0")}.log bytes=${10000 + i * 137}`.padEnd(42, "."));
  rows.push("listing complete");
  const raw = rows.join("\n");
  assert.equal(smol.safeSmolOutput("bash", raw, false, undefined), true);
  const sp = smol.createSmolPreprocessor({
    runtime: {
      version: 2, enabled: true, model: "SmolLM2-135M-Instruct",
      endpoint: "http://127.0.0.1:18735/completion",
      apiKey: "TEST_SMOL_KEY_1234567890abcdef", execution: "background", timeoutMs: 2000,
    },
    acquireLease: async () => true,
    fetch: async () => new Response(JSON.stringify({ content: JSON.stringify({ status: "SELECT", lineIds: [40] }) })),
  });
  sp.offer("session:1", raw, 0.5, "list entries", "bash");
  const taken = await sp.takeAsync("session:1", raw, 2000);
  assert.ok(taken);
  const parsed = JSON.parse(taken);
  const ids = parsed.lines.map((l) => l.id);
  assert.ok(ids.includes(1) && ids.includes(rows.length), "boundary retained");
  for (const line of parsed.lines) {
    assert.equal(line.text.trimEnd(), rows[line.id - 1], "every projected line is source-verbatim");
  }
  // Kompress projection reconstructs source paragraphs exactly.
  const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
  const fact = "Verification confirmed the deployment result this morning after the staging checks passed.";
  const doc = [fact, ...Array(9).fill(filler)].join("\n\n");
  const source = mini.miniSource(doc);
  assert.ok(source);
  const projection = mini.miniProjection(doc, { version: 1, status: "SELECT", sourceHash: source.hash, keep: [0, 1] });
  assert.ok(projection && projection.includes("Verification confirmed"));
  assert.ok(projection.includes(`sha256:${source.hash}`));
  // Forged hashes and out-of-range ids never render.
  assert.equal(mini.miniProjection(doc, { version: 1, status: "SELECT", sourceHash: "0".repeat(64), keep: [0] }), undefined);
  assert.equal(mini.miniProjection(doc, { version: 1, status: "SELECT", sourceHash: source.hash, keep: [99] }), undefined);
});
