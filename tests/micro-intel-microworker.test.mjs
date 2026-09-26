// Micro-worker: eligibility gates (price/quality/health/privacy), budgets,
// output validation, caching. The remote call is always mocked.
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
const workerMod = await load("extensions/lib/micro-intelligence/micro-worker.ts");
const privacyMod = await load("extensions/lib/micro-intelligence/route-privacy.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

const { microWorkerEligibility, runMicroWorker, clearMicroWorkerCache, microWorkerCandidates } = workerMod;
const { routePrivacyTier, routeSafeForPrivateRepo } = privacyMod;

const facts = (over = {}) => ({ provider: "openrouter", model: "cheap/free", healthy: true, privateInput: false, pricePerM: .05, quality: .85, ...over });

test("privacy tiers: unknown is never safe for private input", () => {
  assert.equal(routePrivacyTier("ollama", "qwen", {}, 'http://127.0.0.1:11434').tier, "local");
  assert.equal(routePrivacyTier("lm-studio", "x", {}, 'http://[::1]:1234').tier, "local");
  for (const baseUrl of [undefined, 'https://remote.example/v1', 'file:///tmp/model', 'http://127.0.0.1.remote.example', 'http://localhost:1234'])
    assert.equal(routePrivacyTier('local-example', 'model', {}, baseUrl).tier, 'unknown');
  assert.equal(routePrivacyTier("openrouter", "x/y").tier, "unknown");
  assert.equal(routeSafeForPrivateRepo("openrouter", "x/y"), false);
  assert.equal(routeSafeForPrivateRepo("openrouter", "x/y", { PI_PRIVATE_ROUTES: "openrouter/x/y" }), true);
  assert.equal(routeSafeForPrivateRepo("openrouter", "x/y", { PI_PRIVATE_ROUTES: "openrouter/other" }), false);
  // Malformed allowlist entries are ignored, never crash.
  assert.equal(routePrivacyTier("openrouter", "x/y", { PI_PRIVATE_ROUTES: "nope,,," }).tier, "unknown");
});

test("eligibility gates health, cooldown, price, quality and privacy", () => {
  assert.deepEqual(microWorkerEligibility(facts()), { eligible: true, reason: "eligible" });
  assert.equal(microWorkerEligibility(facts({ healthy: false })).reason, "unhealthy");
  assert.equal(microWorkerEligibility(facts({ cooldownUntil: Date.now() + 60_000 })).reason, "cooldown");
  assert.equal(microWorkerEligibility(facts({ pricePerM: 5 })).reason, "over-price-cap");
  assert.equal(microWorkerEligibility(facts({ pricePerM: undefined })).reason, 'unknown-price');
  assert.equal(microWorkerEligibility(facts({ quality: undefined })).reason, 'unknown-quality');
  for (const pricePerM of [NaN, Infinity, -1]) assert.equal(microWorkerEligibility(facts({ pricePerM })).reason, 'invalid-price');
  for (const quality of [NaN, Infinity, -1, 1.1]) assert.equal(microWorkerEligibility(facts({ quality })).reason, 'invalid-quality');
  assert.equal(microWorkerEligibility(facts({ quality: 0.2 })).reason, "quality-floor");
  assert.equal(microWorkerEligibility(facts({ privateInput: true })).reason, "private-input-unsafe-route");
  assert.equal(microWorkerEligibility(facts({ privateInput: true, provider: "ollama", model: "q", baseUrl: 'http://127.0.0.1:11434' })).eligible, true);
  assert.equal(microWorkerEligibility(facts({ privateInput: true, provider: "ollama", model: "q", baseUrl: 'https://remote.example/v1' })).reason, 'private-input-unsafe-route');
});

test("runner validates JSON, enforces budgets, and caches", async () => {
  metricsMod.resetMicroMetrics();
  clearMicroWorkerCache();
  try {
    let calls = 0;
    const complete = async ({ route, system, maxTokens }) => {
      calls++;
      assert.ok(route.includes("/"));
      assert.ok(system.includes("JSON only"));
      assert.ok(maxTokens <= 1000);
      return { text: '{"hypotheses":[{"cause":"x","check":"y","confidence":0.5}]}', costUsd: 0.001, ms: 4 };
    };
    const first = await runMicroWorker("error-hypothesis", "some failure text here", { complete, facts: facts() });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.ok(Array.isArray(first.output.hypotheses));
    const second = await runMicroWorker("error-hypothesis", "some failure text here", { complete, facts: facts() });
    assert.equal(second.cached, true);
    assert.equal(calls, 1);

    const malformed = await runMicroWorker("error-hypothesis", "different failure text here", {
      complete: async () => ({ text: "nope", ms: 1 }), facts: facts(),
    });
    assert.equal(malformed.skipped, "malformed");

    const pricey = await runMicroWorker("error-hypothesis", "another failure text here", {
      complete: async () => ({ text: "{}", costUsd: 1, ms: 1 }), facts: facts(),
    });
    assert.equal(pricey.skipped, "over-cost-cap");

    assert.equal((await runMicroWorker("nope", "input text here", { complete, facts: facts() })).skipped, "unknown-kind");
    assert.equal((await runMicroWorker("error-hypothesis", "x", { complete, facts: facts() })).skipped, "trivial");
    assert.equal((await runMicroWorker("error-hypothesis", "input text here", { complete: undefined, facts: facts() })).skipped, "no-route");
  } finally {
    metricsMod.resetMicroMetrics();
    clearMicroWorkerCache();
  }
});

test("private input is refused on unknown-privacy routes", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const complete = async () => ({ text: "{}", ms: 1 });
    const verdict = await runMicroWorker("handoff-brief", "private repo context here", {
      complete, facts: facts({ privateInput: true }), privateInput: true,
    });
    assert.equal(verdict.skipped, "private-input-unsafe-route");
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("candidates parse from env only", () => {
  assert.deepEqual(microWorkerCandidates({}), []);
  assert.deepEqual(microWorkerCandidates({ PI_MICRO_WORKER_ROUTES: "a/b, c/d, junk" }), ["a/b", "c/d"]);
});

test('micro-worker enforces each output schema and isolates cached structured results', async () => {
  clearMicroWorkerCache();
  const examples = {
    'error-hypothesis': { hypotheses: [{ cause: 'missing key', check: 'inspect configuration', confidence: .5 }] },
    'finding-consolidation': { groups: [{ kept: 'one', merged: ['two'], reason: 'same finding' }], singletons: [] },
    'handoff-brief': { goal: 'fix cache', done: [], open: ['test'], next: 'test cache' },
    'structured-extraction': { fields: { file: 'cache.ts', missing: null } },
    'inspection-targets': { targets: [{ target: 'cache.ts', why: 'cache owner' }] },
    'patch-compare': { verdict: 'changed', decisive: 'cache key', notes: 'preserves identity' },
    'source-glance': { summary: 'Caches results', flags: ['mutable reference'] },
  };
  try {
    for (const [kind, output] of Object.entries(examples)) {
      const opts = { facts: facts(), complete: async () => ({ text: JSON.stringify(output), costUsd: .001, ms: 1 }) };
      const first = await runMicroWorker(kind, 'inspect this bounded source example', opts);
      assert.equal(first.ok, true, kind);
      Object.assign(first.output, { ...Object.fromEntries(Object.keys(output).map(key => [key, null])) });
      const reused = await runMicroWorker(kind, 'inspect this bounded source example', opts);
      assert.deepEqual(reused.output, output); assert.equal(reused.costUsd, 0);
      Object.assign(reused.output, { ...Object.fromEntries(Object.keys(output).map(key => [key, null])) });
      assert.deepEqual((await runMicroWorker(kind, 'inspect this bounded source example', opts)).output, output);
      assert.equal((await runMicroWorker(kind, 'a different bounded source example', { ...opts, complete: async () => ({ text: '{}', ms: 1 }) })).skipped, 'malformed');
    }
    for (const kind of ['constructor', 'toString', '__proto__']) assert.equal((await runMicroWorker(kind, 'source example text', { facts: facts() })).skipped, 'unknown-kind');
    const invalid = await runMicroWorker('error-hypothesis', 'invalid confidence example', {
      facts: facts(), complete: async () => ({ text: '{"hypotheses":[{"cause":"x","check":"y","confidence":2}]}', ms: 1 }),
    });
    assert.equal(invalid.skipped, 'malformed');
  } finally { clearMicroWorkerCache(); }
});

test('micro-worker deadlines and cancellation reject late completions without caching them', async () => {
  clearMicroWorkerCache();
  const valid = { text: '{"summary":"cache owner","flags":[]}', ms: 1 };
  try {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      let release, offeredSignal;
      const pending = runMicroWorker('source-glance', `bounded source example ${cancelled}`, {
        facts: facts(), signal: controller.signal, timeoutMs: 15,
        complete: async ({ signal }) => { offeredSignal = signal; return new Promise(resolve => { release = resolve; }); },
      });
      if (cancelled) controller.abort();
      const result = await pending;
      assert.equal(result.skipped, cancelled ? 'aborted' : 'timeout');
      assert.equal(offeredSignal.aborted, true);
      release(valid); await new Promise(resolve => setImmediate(resolve));
      const retry = await runMicroWorker('source-glance', `bounded source example ${cancelled}`, { facts: facts(), complete: async () => valid });
      assert.equal(retry.ok, true); assert.equal(retry.cached, false);
    }
  } finally { clearMicroWorkerCache(); }
});
