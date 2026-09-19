// Needle runtime: policy, text prep, similarity, queue/timeout/restart/health.
// The worker thread is faked; real WASM inference is covered by the
// asset-gated section at the bottom (skips cleanly without assets).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/needle-runtime.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const runtime = await load("extensions/lib/needle-runtime.ts");
const policy = await load("extensions/lib/needle-policy.ts");

test("isolated extension imports share Needle and shutdown releases the shared handle", async () => {
  const isolated = await import(pathToFileURL(path.join(agent, "extensions/lib/needle-runtime.ts")) + "?extension-isolate");
  runtime.resetNeedleForTests();
  isolated.resetNeedleForTests();
  const first = runtime.needleHandle();
  try {
    assert.equal(isolated.needleHandle(), first, "all extensions own one worker, queue, cache and health state");
    await first.shutdown();
    const reopened = isolated.needleHandle();
    assert.notEqual(reopened, first, "a later session must not reuse a closed runtime");
    assert.equal(runtime.needleHandle(), reopened);
    await first.shutdown();
    assert.equal(runtime.needleHandle(), reopened, "old cleanup cannot remove the replacement");
    runtime.resetNeedleForTests();
    assert.notEqual(isolated.needleHandle(), reopened, "reset applies across extension imports");
  } finally {
    runtime.resetNeedleForTests();
    isolated.resetNeedleForTests();
  }
});

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
  assert.equal(handle.stats().accepted, 0);
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
  assert.equal(stats.shadowAgreed, 1);
  assert.equal(stats.shadowDisagreed, 1);
  await handle.shutdown();
});

test("failed initialization settles queued callers and consumes a bounded restart budget", async () => {
  const factory = fakeWorkerFactory({ onPost(message, _worker, reply) {
    if (message.op === "init") reply({ id: message.id, ok: false, error: "invalid engine", ms: 1 });
  }});
  const handle = runtime.createNeedleRuntime({ policy: { ...policy.needlePolicy({}), maxRestarts: 1 }, workerFactory: factory, assetDir: fixtureAssets() });
  try {
    const answer = await Promise.race([handle.embed(["hello world"]), new Promise((resolve) => setTimeout(() => resolve({ reason: "hung" }), 100))]);
    assert.equal(answer.reason, "unavailable");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handle.health().state, "cooling");
    assert.equal(factory.workers.length, 2);
  } finally { await handle.shutdown(); }
});

test("serial worker receives only one inference at a time", async () => {
  const releases = [];
  const factory = fakeWorkerFactory({ onPost(message, _worker, reply) {
    if (message.op === "init") return reply({ id: message.id, ok: true, result: { dim: 2 }, ms: 1 });
    releases.push(() => reply({ id: message.id, ok: true, result: { dim: 2, vectors: [[1, 2]] }, ms: 1 }));
  }});
  const handle = runtime.createNeedleRuntime({ workerFactory: factory, assetDir: fixtureAssets() });
  try {
    handle.warmup();
    await settled(handle);
    const first = handle.embed(["alpha beta"]);
    const second = handle.embed(["gamma delta"]);
    assert.equal(releases.length, 1);
    releases.shift()();
    assert.equal((await first).ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 1);
    releases.shift()();
    assert.equal((await second).ok, true);
  } finally { await handle.shutdown(); }
});

test("shutdown is terminal and cached vectors are caller-owned", async () => {
  const factory = canned(4);
  const handle = runtime.createNeedleRuntime({ workerFactory: factory, assetDir: fixtureAssets() });
  const first = await handle.embed(["alpha beta"]);
  first.value.vectors[0][0] = 123;
  const second = await handle.embed(["alpha beta"]);
  assert.notEqual(second.value.vectors[0][0], 123);
  second.value.vectors[0][0] = 456;
  const third = await handle.embed(["alpha beta"]);
  assert.notEqual(third.value.vectors[0][0], 456);
  await handle.shutdown();
  assert.equal((await handle.embed(["alpha beta"])).ok, false);
  assert.equal((await handle.embed(["new input"])).ok, false);
  handle.warmup();
  assert.equal(factory.workers.length, 1);
});

test("foreign ids, nonfinite vectors and forged acceptance never leave runtime", async () => {
  const factory = fakeWorkerFactory({ onPost(message, _worker, reply) {
    const result = message.op === "init" ? { dim: 2 }
      : message.op === "embed" ? { dim: 2, vectors: [[NaN, 0]] }
      : message.op === "rank" ? { ranked: [{ id: "outside-authorized-set", score: 0.99 }], margin: 0.5 }
      : { label: "safe", score: 0.01, margin: 0, accepted: true };
    reply({ id: message.id, ok: true, result, ms: 1 });
  }});
  const handle = runtime.createNeedleRuntime({ workerFactory: factory, assetDir: fixtureAssets() });
  try {
    assert.equal((await handle.embed(["hello world"])).ok, false);
    const candidates = [{ id: "safe", text: "safe action" }, { id: "unsafe", text: "unsafe action" }];
    assert.equal((await handle.rank({ query: "pick a tool", candidates })).ok, false);
    const classification = await handle.classify({ text: "pick a tool", labels: candidates });
    assert.equal(classification.ok, true);
    assert.equal(classification.value.accepted, false);
    assert.equal(handle.stats().accepted, 0);
    assert.equal((await handle.rank({ query: "pick a tool", candidates: [candidates[0], candidates[0]] })).ok, false);
  } finally { await handle.shutdown(); }
});

// Real WASM inference: runs only when installed assets verify. Live
// deployments exercise this; clean checkouts skip with a note.
const liveAssets = await load("extensions/lib/needle-assets.mjs");
const liveCheck = await liveAssets.verifyAssets(liveAssets.needleAssetDir(), false).catch(() => ({ ok: false }));
const hasLiveAssets = liveCheck.ok === true;

test("live needle wasm embeds, ranks and classifies (asset-gated)", { skip: !hasLiveAssets && "needle assets not installed" }, async () => {
  const handle = runtime.createNeedleRuntime({});
  handle.warmup();
  assert.equal(await settled(handle, "healthy", 120000), "healthy");
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


test("stale queued work expires without spending the worker restart budget", async () => {
  const factory = fakeWorkerFactory();
  const handle = runtime.createNeedleRuntime({ policy: { ...policy.needlePolicy({}), maxOpTimeoutMs: 30 }, workerFactory: factory, assetDir: fixtureAssets() });
  try {
    const result = await handle.embed(["wait for startup"]);
    assert.equal(result.reason, "busy");
    assert.equal(handle.health().workerRestarts, 0);
    assert.equal(handle.health().queued, 1); // init only
  } finally { await handle.shutdown(); }
});

test("real worker refuses corrupt executable assets before loading them", async () => {
  const dir = fixtureAssets();
  fs.writeFileSync(path.join(dir, "needle.js"), 'throw new Error("UNVERIFIED_LOADER_EXECUTED");' + ' '.repeat(2048));
  const handle = runtime.createNeedleRuntime({ policy: { ...policy.needlePolicy({}), maxRestarts: 0 }, assetDir: dir });
  try {
    const result = await handle.embed(["hello world"]);
    assert.equal(result.ok, false);
    assert.match(handle.health().lastError, /asset integrity failed/);
    assert.doesNotMatch(handle.health().lastError, /UNVERIFIED_LOADER_EXECUTED/);
    assert.equal(handle.health().state, "cooling");
  } finally { await handle.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("live worker honors disabled cache and topK-independent margins", { skip: !hasLiveAssets && "needle assets not installed" }, async () => {
  const dir = liveAssets.needleAssetDir();
  const worker = new Worker(new URL(pathToFileURL(path.join(agent, "extensions/lib/needle-worker.mjs"))), { workerData: { cacheMax: 0 }, execArgv: [] });
  let id = 0;
  const call = (request) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error("worker deadline")), 30000);
    const receive = (response) => {
      if (response.id !== requestId) return;
      clearTimeout(timer);
      worker.off("message", receive);
      resolve(response);
    };
    worker.on("message", receive);
    worker.postMessage({ ...request, id: requestId });
  });
  try {
    const initialized = await call({ op: "init", assets: { dir } });
    assert.equal(initialized.ok, true);
    const request = { op: "rank", query: "browser screenshot", candidates: [{ id: "screen", text: "browser screenshot" }, { id: "bread", text: "bake fresh bread" }] };
    const one = await call({ ...request, topK: 1 });
    const two = await call({ ...request, topK: 2 });
    assert.equal(one.ok, true);
    assert.ok(one.result.margin > 0);
    assert.equal(one.result.margin, two.result.margin);
    const health = await call({ op: "ping" });
    assert.equal(health.result.cached, 0);
    assert.equal(health.result.cacheHits, 0);
  } finally { await worker.terminate(); }
});

test("live mixed workload keeps the event loop responsive and reuses embeddings", { skip: !hasLiveAssets && "needle assets not installed" }, async () => {
  const handle = runtime.createNeedleRuntime({});
  const rssBefore = process.memoryUsage().rss;
  let ticks = 0;
  const pulse = setInterval(() => ticks++, 10);
  const candidates = [
    { id: "read", text: "read a file and inspect its contents" },
    { id: "edit", text: "edit a file to fix a software defect" },
    { id: "test", text: "run tests and inspect failures" },
    { id: "browser", text: "capture a browser screenshot" },
  ];
  try {
    const coldStart = performance.now();
    handle.warmup();
    assert.equal(await settled(handle, "healthy", 30000), "healthy");
    const coldMs = performance.now() - coldStart;
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => i % 3 === 0
      ? handle.embed([candidates[i % 4].text])
      : i % 3 === 1
        ? handle.rank({ query: "capture a browser screenshot", candidates, topK: 2 })
        : handle.classify({ text: "edit a file to fix a software defect", labels: candidates })));
    assert.equal(results.filter((result) => result.ok).length, 12);
    assert.ok(ticks > 0, "WASM must not block the main event loop");
    const cached = await handle.embed([candidates[0].text]);
    assert.equal(cached.ok && cached.cached, true);
    const stats = handle.stats();
    assert.equal(stats.workerRestarts, 0);
    assert.equal(stats.timeouts, 0);
    console.log(`bench needle-mixed: cold=${coldMs.toFixed(0)}ms, workload=${(performance.now() - start).toFixed(0)}ms, served=12/12, execution-p50=${stats.p50}ms, execution-p95=${stats.p95}ms, main-loop-ticks=${ticks}, RSS-delta=${((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(1)}MiB, cached=${stats.cacheHits}`);
  } finally { clearInterval(pulse); await handle.shutdown(); }
});


test("live singleton does not retain a host process after its operation settles", { skip: !hasLiveAssets && "needle assets not installed" }, () => {
  const url = pathToFileURL(path.join(agent, "extensions/lib/needle-runtime.ts")).href;
  const script = `import { needleEmbed } from ${JSON.stringify(url)}; const result = await needleEmbed(["process lifecycle check"]); console.log(JSON.stringify({ok: result.ok})); if (!result.ok) process.exitCode = 1;`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.error, undefined, `child must terminate without explicit shutdown: ${child.error}`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).ok, true);
});

test("live grammar extraction gets a decode budget and returns advisory fields", { skip: !hasLiveAssets && "needle assets not installed" }, async () => {
  const handle = runtime.createNeedleRuntime();
  try {
    handle.warmup();
    assert.equal(await settled(handle, "healthy", 30000), "healthy");
    const result = await handle.extract({
      text: "The delivery address is 42 Pine Street in Boston.", name: "address",
      schema: { type: "object", properties: { street: { type: "string" }, city: { type: "string" } }, required: ["street", "city"] },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(typeof result.value.value.street, "string");
    assert.equal(result.value.value.city, "Boston");
    assert.equal(handle.stats().timeouts, 0);
    console.log(`bench needle-extraction: ${result.ms}ms, city=${result.value.value.city}, street=${result.value.value.street}, confidence=${result.value.confidence}; fields remain advisory`);
  } finally { await handle.shutdown(); }
});
