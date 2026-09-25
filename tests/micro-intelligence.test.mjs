// Micro-intelligence coordination: metrics, health, retrieval,
// evidence routing, advisory, review helpers and status snapshots.
// All model dependencies are mocked; no network, no workers, no assets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");
const healthMod = await load("extensions/lib/micro-intelligence/health.ts");
const retrievalMod = await load("extensions/lib/micro-intelligence/retrieval.ts");
const evidenceMod = await load("extensions/lib/micro-intelligence/evidence.ts");
const advisoryMod = await load("extensions/lib/micro-intelligence/advisory.ts");
const reviewMod = await load("extensions/lib/micro-intelligence/review.ts");
const statusMod = await load("extensions/lib/micro-intelligence/status.ts");

test("isolated extensions report to one collector and session reset reaches every import", async () => {
  const isolated = await import(pathToFileURL(path.join(agent, "extensions/lib/micro-intelligence/metrics.ts")) + "?extension-isolate");
  metricsMod.resetMicroMetrics();
  isolated.resetMicroMetrics();
  try {
    const previous = isolated.microMetrics();
    previous.run("smol", 12, 3000);
    assert.equal(metricsMod.microMetrics().snapshot().helpers.smol.runs, 1, "status sees helpers in other extensions");
    metricsMod.resetMicroMetrics();
    const next = isolated.microMetrics();
    assert.notEqual(next, previous);
    assert.equal(next, metricsMod.microMetrics());
    previous.run("smol", 8, 3000);
    assert.equal(next.snapshot().helpers.smol.runs, 0, "captured work retains its original session collector");
  } finally {
    metricsMod.resetMicroMetrics();
    isolated.resetMicroMetrics();
  }
});

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
  assert.equal(error.needle, false, "error families belong to deterministic rules, not Needle similarity");
  assert.ok(error.reasons.includes("needle:errors-use-deterministic-rules"));
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

test("deterministic request family covers everyday change and analysis verbs", () => {
  const { deterministicRequestPass } = advisoryMod;
  for (const prompt of ["make the app GUI a web UI, not desktop", "remove the desktop gui code", "update the harness to the latest version", "turn these scattered images into one sheet"])
    assert.equal(deterministicRequestPass(prompt).family, "implementation", prompt);
  assert.equal(deterministicRequestPass("understand everything about the website and its hosting").family, "investigation");
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

test("perspective cues reject shadow, weak and unrecognized model choices", async () => {
  const task = "audit the authentication flow for vulnerabilities";
  const good = { ok: true, cached: false, ms: 1, shadow: false, value: { ranked: [{ id: "security", score: 0.97 }], margin: 0.04 } };
  for (const bad of [
    { ...good, shadow: true },
    { ...good, value: { ...good.value, margin: 0.001 } },
    { ...good, value: { ...good.value, ranked: [{ id: "invented", score: 0.98 }] } },
    { ...good, value: { ...good.value, ranked: [{ id: "security", score: NaN }] } },
    { ...good, value: { ...good.value, ranked: [{ id: "security", score: 0.97 }, { id: "security", score: 0.96 }] } },
  ]) assert.deepEqual(await reviewMod.selectPerspectives(task, async () => bad), []);
  assert.deepEqual(await reviewMod.selectPerspectives(task, async () => good), ["security"]);
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
      advisoryFamily: "lookup",
    });
    assert.equal(snapshot.health.layers.length, 5);
    assert.equal(snapshot.request.family, "implementation");
    assert.equal(snapshot.request.advisoryFamily, "lookup");
    const unstarted = statusMod.microStatusSnapshot({ family: "lookup", substantive: true, terms: ["show"] });
    assert.ok(!("advisoryFamily" in unstarted.request));
    assert.ok(snapshot.needle && typeof snapshot.needle === "object");
    assert.ok(Array.isArray(snapshot.metrics));
    assert.ok(snapshot.smol && typeof snapshot.smol === "object");
    assert.deepEqual(snapshot.kompress, { status: "unavailable" });
  } finally {
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
  }
});


test("retrieval validates accepted disagreement and preserves Jev during shadow", async () => {
  for (const shadow of [false, true]) {
    let calls = 0;
    const outcome = await retrievalMod.multiStageRetrieve({
      kind: "tool", site: "rank", query: "browser screenshot", lexical: lexicalTools,
      needle: async () => ({ ok: true, cached: false, ms: 4, shadow,
        value: { ranked: [{ id: "bash", score: 0.99 }, { id: "read", score: 0.9 }, { id: "browser_session", score: 0.8 }], margin: 0.09 } }),
      jev: async () => { calls++; return { ok: true, answers: { rank: { choice: "browser_session", probabilities: { browser_session: 0.9 } }, exists: { noul: 0.9 } }, usage: { inputTokens: 40, cached: false } }; },
    });
    assert.equal(calls, 1);
    assert.equal(outcome.applied, "jev");
    assert.equal(outcome.ordered[0].id, "browser_session");
  }
});

test("weak Needle agreement cannot reorder the rest of the candidate set", async () => {
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "read some file", lexical: lexicalTools,
    needle: async () => ({ ok: true, cached: false, ms: 4, shadow: false,
      value: { ranked: [{ id: "read", score: 0.91 }, { id: "bash", score: 0.9 }, { id: "browser_session", score: 0.89 }], margin: 0.01 } }),
  });
  assert.equal(outcome.applied, "lexical");
  assert.deepEqual(outcome.ordered, lexicalTools);
});

test("a low-margin Needle order is fused with the lexical order instead of discarded", async () => {
  const lexical = ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `${id}: candidate ${id}` }));
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "skill", site: "rank", query: "find the matching skill", lexical,
    needle: async () => ({ ok: true, cached: false, ms: 4, shadow: false,
      value: { ranked: ["d", "a", "b", "c", "e"].map((id, i) => ({ id, score: 0.96 - i * 0.001 })), margin: 0.001 } }),
  });
  assert.equal(outcome.applied, "fused");
  assert.deepEqual(outcome.ordered.map((c) => c.id), ["a", "d", "b", "c", "e"], "Needle lifts its pick; a strong lexical top stays first");
});

test("retrieval rejects Jev choices outside the submitted candidates", async () => {
  const outcome = await retrievalMod.multiStageRetrieve({
    kind: "tool", site: "rank", query: "read some file", lexical: lexicalTools,
    jev: async () => ({ ok: true, answers: { rank: { choice: "invented", probabilities: { invented: 0.9, bash: 0.8 } }, exists: { noul: 0.9 } }, usage: { inputTokens: 40, cached: false } }),
  });
  assert.equal(outcome.applied, "lexical");
  assert.deepEqual(outcome.ordered, lexicalTools);
});

test('small advisers retain final constraints and abstain on invalid confidence', async () => {
 const prompt = 'Implement the payment handler. '+ 'Background detail. '.repeat(200) + 'Do not deploy or send email.';
 let offered;
 const result = await new Promise(resolve => advisoryMod.runAdvisory({prompt,family:'implementation',terms:[],candidates:['read','edit']}, async (_site,state) => {
  offered=state;
  return {ok:true,answers:{reviewWorthy:{noul:8},needsVerification:{noul:NaN},multiPerspective:{noul:'1'},fit:{choice:'9:invented'},perspective:{probabilities:{security:Infinity,testing:-1}}},usage:{inputTokens:1,cached:false}};
 },resolve));
 assert.match(offered.prompt,/Do not deploy or send email\.$/);
 assert.match(offered.prompt,/middle omitted/);
 assert.ok(offered.prompt.length<=1600);
 assert.equal(result.preferred,undefined);
 assert.equal(result.reviewWorthy,false);
 assert.equal(result.needsVerification,false);
 assert.equal(result.multiPerspective,false);
 assert.deepEqual(result.perspectives,[]);
 assert.equal(advisoryMod.deterministicRequestPass('Implement typed API contracts and database transaction tests.').family,'implementation');
});

async function promptContextFixture(t, sendMessage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-context-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_PROVIDER_STATE_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_MICRO_INTELLIGENCE', 'PI_SUBAGENT_CHILD'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_LLM_PREFERENCES_FILE = path.join(directory, 'preferences.json');
  process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(directory, 'exclusions.json');
  process.env.PI_PROVIDER_STATE_FILE = path.join(directory, 'health.json');
  process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(directory, 'economy.json');
  delete process.env.PI_MICRO_INTELLIGENCE;
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ version: 1,
    models: { advisor: { provider: 'micro-fixture', model: 'advisor' } },
    preferences: { prompt_analysis: { models: ['advisor'] } } }));
  const { clearLlmPreferencesCache } = await load('extensions/pi-subagents/src/runs/shared/llm-preferences.ts');
  const { default: register } = await load('extensions/micro-intelligence.ts');
  clearLlmPreferencesCache();
  const model = { provider: 'micro-fixture', id: 'advisor', api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1',
    contextWindow: 65536, maxTokens: 4096, reasoning: false, input: ['text'], cost: { input: .1, output: .1, cacheRead: 0, cacheWrite: 0 } };
  let sessionId = 'micro-session-1';
  const handlers = new Map();
  const ctx = { cwd: directory, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    modelRegistry: { getAvailable: () => [model], find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic-key' }) },
    ui: { setStatus() {} } };
  register({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerMessageRenderer() {},
    events: { emit() {} }, sendMessage }, { classify: () => undefined, warmup() {}, completePromptAnalysis: async () => ({
      stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ intent: 'Inspect the parser', taskLabel: 'Parser review', confidence: .9, subtasks: ['Verify the parser'] }) }],
    }) });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const request = { source: 'interactive', originalText: 'Inspect the parser and verify its behavior.', requestId: 'micro-request-1', turnId: 'micro-turn-1',
    processId: 'micro-process', sessionId, guardianOwnerId: 'micro-owner-1', signal: new AbortController().signal };
  await emit('session_start', { reason: 'new' });
  await emit('input', request);
  t.after(() => { emit('session_shutdown'); for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; fs.rmSync(directory, { recursive: true, force: true }); });
  const messages = [{ role: 'user', content: [{ type: 'text', text: request.originalText }] }];
  return { context: (input = messages) => emit('context', { messages: input, requestMessages: [{ requestId: request.requestId, turnId: request.turnId, messageIndex: 0 }] }),
    switchSession: () => { sessionId = 'micro-session-2'; emit('session_tree'); } };
}

test('failed prompt-analysis display can retry without duplicating the context capsule', async t => {
  let sends = 0;
  const f = await promptContextFixture(t, async () => { if (++sends === 1) throw new Error('Synthetic display failure'); });
  const first = await f.context();
  assert.equal(first.messages.filter(message => message.customType === 'prompt-analysis-context').length, 1);
  const second = await f.context(first.messages);
  assert.equal(sends, 2, 'a rejected display send remains eligible on the next context pass');
  assert.equal(second, undefined, 'the already inserted context capsule is not duplicated');
  await f.context(first.messages);
  assert.equal(sends, 2, 'a successful display send is delivered once');
});

test('session switch during prompt-analysis display cannot return stale context advice', async t => {
  let release;
  const f = await promptContextFixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = f.context();
  while (!release) await Promise.resolve();
  f.switchSession();
  release();
  assert.equal(await pending, undefined, 'the old session must not receive a capsule after the display await');
  assert.equal(await f.context(), undefined, 'the replacement session cannot inherit old request advice');
});

test('confident local shortlist promotion retains all evidence and avoids paid judge calls', async () => {
  let paid = 0;
  const outcome = await retrievalMod.multiStageRetrieve({ kind: 'tool', site: 'rank', query: 'capture a screenshot of the site', lexical: lexicalTools,
    local: async (_query, candidates) => { assert.deepEqual(candidates.map(c => c.id), lexicalTools.map(c => c.id)); return { ok: true, id: 'browser_session', p: .96, margin: .92, ms: 12, cached: false }; },
    jev: async () => { paid++; throw Error('not needed'); },
  });
  assert.equal(outcome.applied, 'local'); assert.equal(outcome.ordered[0].id, 'browser_session'); assert.equal(paid, 0);
  assert.deepEqual([...outcome.ordered.map(c => c.id)].sort(), [...lexicalTools.map(c => c.id)].sort());
});

test('local discovery uncertainty, invalid choices, exact names and cancellation preserve fallback', async () => {
  for (const choice of [{ ok: false, reason: 'low-confidence' }, { ok: true, id: 'invented', p: .99, margin: .98 }, { ok: true, id: 'bash', p: .7, margin: .5 }]) {
    let calls = 0;
    const result = await retrievalMod.multiStageRetrieve({ kind: 'tool', site: 'rank', query: 'inspect a screenshot of the page', lexical: lexicalTools,
      local: async () => choice, jev: async () => { calls++; return { ok: false, skipped: 'unavailable' }; } });
    assert.equal(calls, 1); assert.equal(result.applied, 'lexical');
  }
  const c = new AbortController(); c.abort();
  for (const extra of [{ query: 'browser_session' }, { signal: c.signal }]) {
    let calls = 0;
    await retrievalMod.multiStageRetrieve({ kind: 'tool', site: 'rank', query: 'take a screenshot of a site', lexical: lexicalTools,
      local: async () => { calls++; throw Error(); }, ...extra });
    assert.equal(calls, 0);
  }
});
