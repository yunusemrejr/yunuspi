// Needle runtime: policy, text prep, similarity, queue/timeout/restart/health.
// The worker thread is faked; real WASM inference is covered by the
// asset-gated section at the bottom (skips cleanly without assets).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/needle-runtime.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const runtime = await load("extensions/lib/needle-runtime.ts");
const policy = await load("extensions/lib/needle-policy.ts");

const fixtureAssets = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-rt-"));
  for (const name of ["needle.js", "needle.wasm", "needle3.cact"]) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(2048, 7));
  }
  return dir;
};

const fakeWorkerFactory = (behavior = {}) => {
  const workers = [];
  const factory = (_script, _opts) => {
    const listeners = {};
    const worker = {
      posted: [],
      on: (event, fn) => {
        (listeners[event] ??= []).push(fn);
        return worker;
      },
      postMessage: (message) => {
        worker.posted.push(message);
        behavior.onPost?.(message, worker, (response) =>
          (listeners.message ?? []).forEach((fn) => fn(response)),
        );
      },
      terminate: async () => {
        (listeners.exit ?? []).forEach((fn) => fn(0));
        return 0;
      },
      emit: (event, ...args) => (listeners[event] ?? []).forEach((fn) => fn(...args)),
    };
    workers.push(worker);
    behavior.onCreate?.(worker);
    return worker;
  };
  factory.workers = workers;
  return factory;
};

const canned = (dim = 8) =>
  fakeWorkerFactory({
    onPost: (message, _worker, reply) => {
      const ms = 1;
      if (message.op === "init") return reply({ id: message.id, ok: true, result: { dim }, ms });
      if (message.op === "embed") {
        const vectors = message.texts.map((_, i) => Array.from({ length: dim }, (_, j) => (i + j + 1) / 10));
        return reply({ id: message.id, ok: true, result: { dim, vectors }, ms });
      }
      if (message.op === "rank") {
        const ranked = message.candidates.map((c, i) => ({ id: c.id, score: 0.99 - i * 0.02 }));
        return reply({ id: message.id, ok: true, result: { ranked: ranked.slice(0, message.topK), margin: 0.02 }, ms });
      }
      if (message.op === "classify") {
        return reply({ id: message.id, ok: true, result: { label: message.labels[0].id, score: 0.96, margin: 0.03, accepted: true }, ms });
      }
      if (message.op === "extract") {
        return reply({ id: message.id, ok: true, result: { value: { a: 1 }, confidence: 0.9, refused: false }, ms });
      }
      return reply({ id: message.id, ok: false, error: "unknown op", ms });
    },
  });

const settled = async (handle, want = "healthy", timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = handle.health().state;
    if (state === want) return state;
    if (state !== "warming") return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  return handle.health().state;
};

test("policy parses env with safe clamps", () => {
  const base = policy.needlePolicy({});
  assert.equal(base.enabled, true);
  assert.equal(base.shadow, false);
  assert.equal(policy.needlePolicy({ PI_NEEDLE: "off" }).enabled, false);
  assert.equal(policy.needlePolicy({ PI_NEEDLE_SHADOW: "1" }).shadow, true);
  assert.equal(policy.needlePolicy({ PI_NEEDLE_TIMEOUT_MS: "1" }).opTimeoutMs, 100);
  assert.equal(policy.needlePolicy({ PI_NEEDLE_TIMEOUT_MS: "999999" }).opTimeoutMs, 15000);
  assert.equal(policy.needlePolicy({ PI_NEEDLE_ACCEPT_SCORE: "0.93" }).acceptScore, 0.93);
});

test("needleText normalizes, truncates and rejects trivial input", () => {
  assert.equal(policy.needleText("  hello   world  ", 2048), "hello world");
  assert.equal(policy.needleText("hi", 2048), undefined);
  assert.equal(policy.needleText(42, 2048), undefined);
  assert.equal(policy.needleText("a".repeat(100), 10).length, 10);
  assert.equal(policy.needleText("a\0b c", 2048), "ab c");
});

test("cosineSimilarity is exact on basics and safe on degenerate input", () => {
  assert.equal(policy.cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(policy.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(policy.cosineSimilarity([], []), 0);
  assert.equal(policy.cosineSimilarity([1], [1, 2]), 0);
  assert.equal(policy.cosineSimilarity([NaN], [1]), 0);
});

test("disabled policy never spawns a worker", async () => {
  const factory = canned();
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({}), enabled: false },
    workerFactory: factory,
    assetDir: fixtureAssets(),
  });
  handle.warmup();
  assert.equal(handle.health().state, "disabled");
  assert.equal(factory.workers.length, 0);
  const result = await handle.embed(["hello world"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disabled");
  await handle.shutdown();
});

test("happy path serves embed/rank/classify/extract with stats", async () => {
  const handle = runtime.createNeedleRuntime({ workerFactory: canned(4), assetDir: fixtureAssets() });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  assert.equal(handle.health().dim, 4);
  const embed = await handle.embed(["alpha beta", "gamma delta"]);
  assert.equal(embed.ok, true);
  assert.equal(embed.value.dim, 4);
  assert.equal(embed.value.vectors.length, 2);
  const cached = await handle.embed(["alpha beta", "gamma delta"]);
  assert.equal(cached.ok && cached.cached, true);
  const rank = await handle.rank({ query: "screenshot", candidates: [{ id: "a", text: "take screenshot" }, { id: "b", text: "bake bread" }], topK: 2 });
  assert.equal(rank.ok && rank.value.ranked[0].id, "a");
  const classify = await handle.classify({ text: "fix the bug", labels: [{ id: "x", text: "fix code" }, { id: "y", text: "bake bread" }] });
  assert.equal(classify.ok && classify.value.label, "x");
  const extract = await handle.extract({ text: "invoice total 12", schema: { type: "object" } });
  assert.equal(extract.ok && extract.value.value.a, 1);
  const stats = handle.stats();
  assert.ok(stats.embedCalls >= 1 && stats.rankCalls === 1 && stats.classifyCalls === 1 && stats.extractCalls === 1);
  assert.equal(stats.cacheHits, 1);
  assert.ok(stats.p50 >= 0 && stats.p95 >= stats.p50);
  await handle.shutdown();
});

test("cold callers trigger warmup instead of hanging", async () => {
  const handle = runtime.createNeedleRuntime({ workerFactory: canned(4), assetDir: fixtureAssets() });
  const result = await handle.embed(["alpha beta"]);
  assert.equal(result.ok, true);
  assert.equal(handle.health().state, "healthy");
  await handle.shutdown();
});

test("trivial and oversized inputs skip before inference", async () => {
  const factory = canned();
  const handle = runtime.createNeedleRuntime({ workerFactory: factory, assetDir: fixtureAssets() });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  const posted = factory.workers[0].posted.length;
  assert.equal((await handle.embed([])).reason, "trivial");
  assert.equal((await handle.rank({ query: "x", candidates: [] })).reason, "trivial");
  assert.equal((await handle.classify({ text: "fix bug now", labels: [{ id: "a", text: "only one label here" }] })).reason, "trivial");
  assert.equal((await handle.extract({ text: "x", schema: null })).reason, "trivial");
  assert.equal(factory.workers[0].posted.length, posted);
  await handle.shutdown();
});

test("malformed worker results degrade to skips", async () => {
  const factory = fakeWorkerFactory({
    onPost: (message, _w, reply) => {
      if (message.op === "init") return reply({ id: message.id, ok: true, result: { dim: 4 }, ms: 1 });
      return reply({ id: message.id, ok: true, result: { garbage: true }, ms: 1 });
    },
  });
  const handle = runtime.createNeedleRuntime({ workerFactory: factory, assetDir: fixtureAssets() });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  assert.equal((await handle.embed(["alpha beta"])).reason, "unavailable");
  assert.equal((await handle.rank({ query: "screenshot now", candidates: [{ id: "a", text: "take one" }, { id: "b", text: "bake two" }] })).reason, "unavailable");
  await handle.shutdown();
});

test("ops queue while warming and respect the queue bound", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const factory = fakeWorkerFactory({
    onPost: (message, _w, reply) => {
      if (message.op === "init") {
        void gate.then(() => reply({ id: message.id, ok: true, result: { dim: 4 }, ms: 1 }));
        return;
      }
      void gate.then(() => reply({ id: message.id, ok: true, result: { dim: 4, vectors: [[[0.1, 0.2, 0.3, 0.4]][0]] }, ms: 1 }));
    },
  });
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({}), maxQueue: 2 },
    workerFactory: factory,
    assetDir: fixtureAssets(),
  });
  handle.warmup();
  const first = handle.embed(["alpha beta"]);
  const second = handle.embed(["gamma delta"]);
  const third = handle.embed(["epsilon zeta"]);
  assert.equal((await third).reason, "busy");
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  await handle.shutdown();
});

test("op timeout fails open and a wedged worker restarts", async () => {
  const factory = fakeWorkerFactory({
    onPost: (message, _w, reply) => {
      if (message.op === "init") return reply({ id: message.id, ok: true, result: { dim: 4 }, ms: 1 });
      // Never reply to inference: every op times out.
    },
  });
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({ PI_NEEDLE_TIMEOUT_MS: "100" }), maxRestarts: 5 },
    workerFactory: factory,
    assetDir: fixtureAssets(),
  });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  assert.equal((await handle.embed(["alpha beta"])).reason, "timeout");
  assert.equal((await handle.embed(["gamma delta"])).reason, "timeout");
  // Two consecutive timeouts restart the worker; the new worker re-inits.
  // Post-restart service is honestly "degraded" (a restart occurred).
  assert.equal(await settled(handle, "degraded"), "degraded");
  assert.ok(handle.health().workerRestarts >= 1);
  const stats = handle.stats();
  assert.ok(stats.timeouts >= 2 && stats.workerRestarts >= 1);
  await handle.shutdown();
});

test("crash recovery cools down after the restart budget", async () => {
  const factory = canned();
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({}), maxRestarts: 1, restartWindowMs: 60000, cooldownMs: 60000, reprobeMs: 60000 },
    workerFactory: factory,
    assetDir: fixtureAssets(),
  });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  factory.workers[0].emit("error", new Error("boom"));
  assert.equal(await settled(handle, "degraded"), "degraded");
  assert.equal(factory.workers.length, 2);
  factory.workers[1].emit("error", new Error("boom again"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(handle.health().state, "cooling");
  assert.equal((await handle.embed(["alpha beta"])).reason, "cooldown");
  await handle.shutdown();
});

test("missing assets degrade to unavailable without spawning", async () => {
  const factory = canned();
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({}), reprobeMs: 60000 },
    workerFactory: factory,
    assetDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "needle-empty-")), "nope"),
  });
  handle.warmup();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(handle.health().state, "unavailable");
  assert.equal(factory.workers.length, 0);
  assert.equal((await handle.embed(["alpha beta"])).reason, "unavailable");
  await handle.shutdown();
});

test("shadow mode flags results for agreement measurement", async () => {
  const handle = runtime.createNeedleRuntime({
    policy: { ...policy.needlePolicy({ PI_NEEDLE_SHADOW: "1" }) },
    workerFactory: canned(4),
    assetDir: fixtureAssets(),
  });
  handle.warmup();
  assert.equal(await settled(handle), "healthy");
  assert.equal(handle.health().shadow, true);
  const rank = await handle.rank({ query: "screenshot now", candidates: [{ id: "a", text: "take one" }, { id: "b", text: "bake two" }] });
  assert.equal(rank.ok && rank.shadow, true);
  assert.equal(handle.stats().shadow, 1);
  await handle.shutdown();
});

test("escalation and agreement counters record", async () => {
  const handle = runtime.createNeedleRuntime({ workerFactory: canned(4), assetDir: fixtureAssets() });
  handle.noteEscalation("jev");
  handle.noteEscalation("llm");
  handle.noteShadowAgreement(true);
  handle.noteShadowAgreement(false);
  const stats = handle.stats();
  assert.equal(stats.escalatedToJev, 1);
  assert.equal(stats.escalatedToLlm, 1);
  await handle.shutdown();
});

// Real WASM inference: runs only when installed assets verify. Live
// deployments exercise this; clean checkouts skip with a note.
const liveAssets = await load("extensions/lib/needle-assets.mjs");
const liveCheck = await liveAssets.verifyAssets(liveAssets.needleAssetDir(), false).catch(() => ({ ok: false }));
const hasLiveAssets = liveCheck.ok === true;

test("live needle wasm embeds, ranks and classifies (asset-gated)", { skip: !hasLiveAssets && "needle assets not installed" }, async () => {
  const handle = runtime.createNeedleRuntime({});
  handle.warmup();
  assert.equal(await settled(handle), "healthy", 120000);
  assert.ok(handle.health().dim > 0);
  const rank = await handle.rank({
    query: "take a screenshot of the browser page",
    candidates: [
      { id: "shot", text: "capture a browser screenshot to a file" },
      { id: "mail", text: "send an email message" },
      { id: "test", text: "run unit tests with coverage" },
    ],
    topK: 3,
  });
  assert.equal(rank.ok, true);
  assert.equal(rank.ok && rank.value.ranked[0].id, "shot");
  const classify = await handle.classify({
    text: "fix the failing authentication test",
    labels: [
      { id: "implementation", text: "write, edit, implement, build or fix code, files, configuration or tests" },
      { id: "research", text: "research, compare, search the web, gather information or summarize knowledge" },
    ],
  });
  assert.equal(classify.ok && classify.value.label, "implementation");
  await handle.shutdown();
});
