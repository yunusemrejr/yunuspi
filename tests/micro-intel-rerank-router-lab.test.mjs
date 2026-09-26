// Remote rerank, router shadow, and the model qualification lab. No
// network, no keys: transports and completions are mocked.
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
const rerankMod = await load("extensions/lib/micro-intelligence/rerank.ts");
const shadowMod = await load("extensions/lib/micro-intelligence/router-shadow.ts");
const labMod = await load("extensions/lib/micro-intelligence/model-qual-lab.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

test("remote rerank is off by default and degrades to local order", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const ranker = rerankMod.remoteRanker({ model: "voyage-rerank-3", transport: async () => ({ order: [1, 0] }) });
    const cands = [{ id: "a", text: "first" }, { id: "b", text: "second" }, { id: "c", text: "third" }];
    assert.equal(await ranker.rank("q", cands), undefined);
    assert.equal(metricsMod.microMetrics().snapshot().helpers.rerank.skipReasons.disabled, 1);

    const unconfigured = rerankMod.remoteRanker({ env: { PI_RERANK: "on" } });
    assert.equal(await unconfigured.rank("q", cands), undefined);

    const failing = rerankMod.remoteRanker({
      model: "m", env: { PI_RERANK: "on" },
      transport: async () => { throw Error("down"); },
    });
    assert.equal(await failing.rank("q", cands), undefined);

    const ok = rerankMod.remoteRanker({
      model: "m", env: { PI_RERANK: "on" },
      transport: async ({ documents }) => {
        assert.equal(documents.length, 3);
        return { order: [2, 0, 1] };
      },
    });
    assert.deepEqual(await ok.rank("q", cands), ["c", "a", "b"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("router shadow records both choices and never routes", async () => {
  const shadow = shadowMod.createRouterShadow(4);
  const first = await shadow.compare("pick a cheap model", "openrouter/a", async () => ({ suggestion: { model: "openrouter/b", effort: "high" } }), ["openrouter/a", "openrouter/b"]);
  assert.equal(first.router, "openrouter/b");
  assert.equal(first.agree, false);
  shadow.recordOutcome(first.id, { success: true, latencyMs: 100, costUsd: 0.01 });
  const second = await shadow.compare("t2", "x/y", async () => ({ suggestion: { model: "x/y" } }), ["x/y"]);
  assert.equal(second.agree, true);
  const report = shadow.report();
  assert.equal(report.comparisons, 2);
  assert.equal(report.withSuggestion, 2);
  assert.equal(report.agreements, 1);
  assert.equal(report.yunuspiSuccess, 1);
  assert.equal(report.yunuspiDecided, 1);
  assert.ok(report.note.includes("Shadow only"));
  const missing = await shadow.compare("t3", "x", undefined, []);
  assert.equal(missing.router, null);
  assert.equal(shadowMod.discoverRouterSlug(["a/b", "typesafe/jev-router-v1"]), "typesafe/jev-router-v1");
  assert.equal(shadowMod.discoverRouterSlug(["a/b"]), undefined);
});

test("qual battery scores deterministically and qualifies roles", async () => {
  const complete = async ({ prompt }) => {
    if (prompt.includes("dark mode")) return { text: '{"items":["Add dark mode","fix the login redirect","never log passwords"]}', latencyMs: 10 };
    if (prompt.includes("md5")) return { text: "md5 is an insecure hash; keep bcrypt for passwords.", latencyMs: 10 };
    if (prompt.includes("three colors")) return { text: "red\ngreen\nblue", latencyMs: 10 };
    if (prompt.includes("value of echo")) return { text: "55", latencyMs: 10 };
    if (prompt.includes("refresh token rotation")) return { text: "src/auth/session.ts", latencyMs: 10 };
    if (prompt.includes("always returns 0")) return { text: "n = +1 assigns instead of adding; use n += 1.", latencyMs: 10 };
    if (prompt.includes('"ports"')) return { text: '{"name":"ada","ports":[80,443],"enabled":true}', latencyMs: 10 };
    if (prompt.includes('"tool"')) return { text: '{"tool":"bash","args":{}}', latencyMs: 10 };
    if (prompt.includes('"name":"read"')) return { text: '{"name":"read","arguments":{"path":"src/index.ts","offset":1,"limit":50}}', latencyMs: 10 };
    throw Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
  const summary = await labMod.runQualBattery("openrouter/mock", complete, {});
  assert.equal(summary.tasks.length, 9);
  assert.ok(summary.meanScore >= 0.8, `mean ${summary.meanScore}`);
  assert.equal(summary.reliability, 1);
  assert.equal(summary.privacyTier, "unknown");
  assert.equal(labMod.qualifyForRole(summary, "micro-worker").eligible, true);
  assert.equal(labMod.qualifyForRole(summary, "skill-router").eligible, true);
  assert.equal(labMod.qualifyForRole(summary, "coding-child").eligible, true);

  const weak = await labMod.runQualBattery("openrouter/weak", async () => ({ text: "???", latencyMs: 5 }), {});
  assert.equal(weak.meanScore < 0.6, true);
  assert.equal(labMod.qualifyForRole(weak, "micro-worker").eligible, false);
  assert.equal(labMod.qualifyForRole(weak, "main-fallback").eligible, false);
});

test("eligibility expires and persists to the private store", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-qual-"));
  const file = path.join(dir, "elig.json");
  let now = 1_000_000;
  const store = labMod.createEligibilityStore({ file, ttlMs: 1000, now: () => now });
  const summary = {
    route: "openrouter/mock", at: now, meanScore: 0.9, passRate: 1,
    p95LatencyMs: 10, totalCostUsd: 0, reliability: 1, privacyTier: "unknown", privacyReason: "x",
    tasks: [{ id: "tool-selection", score: 1, latencyMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 }],
  };
  const entry = store.record(summary, "micro-worker");
  assert.equal(entry.eligible, true);
  assert.ok(fs.existsSync(file), "store persists privately");
  assert.ok(store.get("openrouter/mock", "micro-worker"));
  now += 10_000;
  assert.equal(store.get("openrouter/mock", "micro-worker"), undefined);
  const reopened = labMod.createEligibilityStore({ file, ttlMs: 1000, now: () => now });
  assert.equal(reopened.snapshot().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
