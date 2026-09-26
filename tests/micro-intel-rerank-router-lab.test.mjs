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

test("remote rerank is available by default and degrades to local order when disabled or unconfigured", async () => {
  metricsMod.resetMicroMetrics();
  try {
    assert.equal(rerankMod.rerankEnabled({}), true);
    assert.equal(rerankMod.rerankEnabled({ PI_OFFLINE: '1' }), false);
    const ranker = rerankMod.remoteRanker({ env: { PI_RERANK: 'off' }, model: "voyage-rerank-3", transport: async () => ({ order: [1, 0] }) });
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

test('remote rerank rejects malformed provider indices and scores', async () => {
  const request = { url: 'https://fixture.invalid/rerank', model: 'fixture', query: 'cache', documents: ['a', 'b', 'c'], topK: 3, timeoutMs: 100 };
  for (const data of [
    [{ index: 1, relevance_score: .8 }, { index: 1, relevance_score: .7 }],
    [{ index: 7, relevance_score: .8 }], [{ index: 0, relevance_score: 'high' }],
    [{ index: 0, relevance_score: Infinity }], [null],
  ]) {
    const transport = rerankMod.voyageRerankTransport({ key: () => 'synthetic', fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
    await assert.rejects(transport(request), /malformed answers/);
  }
});

test('remote rerank snapshots candidate IDs and rejects invalid or cancelled injected results', async () => {
  const candidates = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'third' }];
  const env = { PI_RERANK: 'on' };
  for (const order of [[0, 0], [0, 8], [0, 1.5], ['0', 1]]) {
    assert.equal(await rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => ({ order }) }).rank('cache', candidates), undefined);
  }
  let release;
  const mutable = structuredClone(candidates);
  const ranker = rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => new Promise(resolve => { release = () => resolve({ order: [1, 0] }); }) });
  const pending = ranker.rank('cache', mutable);
  mutable[1].id = 'changed'; release();
  assert.deepEqual(await pending, ['b', 'a']);
  const controller = new AbortController();
  const cancelled = rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => { controller.abort(); return { order: [1, 0] }; } });
  assert.equal(await cancelled.rank('cache', candidates, controller.signal), undefined);
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
    if (prompt.includes("should count items")) return { text: "n = +1 assigns instead of adding; use n += 1.", latencyMs: 10 };
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
    tasks: labMod.MICRO_WORKER_QUAL_TASKS.map(id => ({ id, score: 1, latencyMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
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

test('qualification enforces deadlines and cannot pass from an incomplete battery', async () => {
  const timedOut = await labMod.runQualBattery('fixture/model', async () => new Promise(() => {}), {
    tasks: [{ id: 'structured-output', prompt: 'synthetic', maxTokens: 10, timeoutMs: 10, score: () => 1 }],
  });
  assert.match(timedOut.tasks[0].error, /timeout/i);
  const incomplete = await labMod.runQualBattery('fixture/model', async () => ({ text: '{}', latencyMs: 0 }), {
    tasks: [{ id: 'structured-output', prompt: 'synthetic', maxTokens: 10, timeoutMs: 10, score: () => 1 }],
  });
  assert.equal(incomplete.meanScore, 1);
  assert.equal(labMod.qualifyForRole(incomplete, 'micro-worker').eligible, false);
  const debug = labMod.qualBattery().find(task => task.id === 'coding-debug');
  assert.equal(debug.score('Assignment resets the accumulator. Use n++;'), 1);
  assert.equal(debug.score('Use n += 1 to increment the count.'), 1);
});

test('persisted qualification rejects malformed or future evidence and exposes independent snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-qual-invalid-'));
  const file = path.join(directory, 'eligibility.json'), now = 10_000;
  const valid = { route: 'fixture/model', role: 'micro-worker', eligible: true, reason: 'battery-pass', meanScore: .9, reliability: 1, privacyTier: 'unknown', at: 9000, expiresAt: 11000 };
  try {
    for (const patch of [{ eligible: 'yes' }, { role: 'invented' }, { meanScore: 2 }, { reliability: null }, { at: now + 1 }, { expiresAt: 1e15 }, { reason: null }]) {
      fs.writeFileSync(file, JSON.stringify({ entries: [{ ...valid, ...patch }] }));
      assert.equal(labMod.createEligibilityStore({ file, now: () => now }).get(valid.route, 'micro-worker'), undefined, JSON.stringify(patch));
    }
    fs.writeFileSync(file, JSON.stringify({ entries: [valid] }));
    const store = labMod.createEligibilityStore({ file, now: () => now });
    const first = store.get(valid.route, 'micro-worker'); first.eligible = false; first.meanScore = 0;
    store.snapshot()[0].eligible = false;
    assert.equal(store.get(valid.route, 'micro-worker').eligible, true);
    assert.equal(store.get(valid.route, 'micro-worker').meanScore, .9);
    let clock = now;
    const ticking = labMod.createEligibilityStore({ now: () => clock++, ttlMs: 100 });
    const recorded = ticking.record({ route: valid.route, meanScore: .9, reliability: 1, privacyTier: 'unknown',
      tasks: labMod.MICRO_WORKER_QUAL_TASKS.map(id => ({ id, score: 1 })) }, 'micro-worker');
    assert.equal(recorded.expiresAt - recorded.at, 100, 'one timestamp defines the entire eligibility lifetime');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
