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

const facts = (over = {}) => ({ provider: "openrouter", model: "cheap/free", healthy: true, privateInput: false, ...over });

test("privacy tiers: unknown is never safe for private input", () => {
  assert.equal(routePrivacyTier("ollama", "qwen").tier, "local");
  assert.equal(routePrivacyTier("lm-studio", "x").tier, "local");
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
  assert.equal(microWorkerEligibility(facts({ pricePerM: undefined })).eligible, true);
  assert.equal(microWorkerEligibility(facts({ quality: 0.2 })).reason, "quality-floor");
  assert.equal(microWorkerEligibility(facts({ privateInput: true })).reason, "private-input-unsafe-route");
  assert.equal(microWorkerEligibility(facts({ privateInput: true, provider: "ollama", model: "q" })).eligible, true);
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
