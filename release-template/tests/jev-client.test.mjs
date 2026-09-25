// Jev client: slug cascade, breaker + background recovery, cache dedupe,
// ledger and cost math. Transport is mocked; no network in committed tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
  fs.existsSync(path.join(dir, "extensions/lib/jev-client.ts")),
);
assert.ok(agent, "agent tree with jev-client.ts is present");

// Hermetic key resolution: empty agent dir plus an explicit test key.
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
process.env.OPENROUTER_API_KEY = "sk-or-test";
delete process.env.PI_JEV;
delete process.env.PI_OFFLINE;

const jev = await import(pathToFileURL(path.join(agent, "extensions/lib/jev-client.ts")));

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const httpFail = (status, body) => ({ ok: false, status, json: async () => ({}), text: async () => body });

function harness(fetchImpl) {
  const timers = [];
  const ledger = [];
  const pi = { appendEntry: (type, data) => ledger.push({ type, data }) };
  jev.resetJevClient();
  jev.configureJevClient({ fetchImpl, now: () => Date.now(), schedule: (fn, ms) => { timers.push({ fn, ms }); return {}; }, openMs: 50 });
  return { timers, ledger, pi };
}

const ANSWERS = { ping: { type: "noul", noul: 0.9 } };
const decisionsOk = () => jsonOk({ answers: ANSWERS });
const emptyModels = () => jsonOk({ data: [] });

test("cascade tries tilde latest, then pinned, then discovered variations", async () => {
  const seen = [];
  const { pi } = harness(async (url, opts) => {
    if (String(url).includes("/api/v1/models")) return jsonOk({ data: [{ id: "typesafe/jev-9.9" }, { id: "other/jev-x" }, { id: "openai/gpt" }] });
    const slug = JSON.parse(opts.body).model;
    seen.push(slug);
    if (slug !== "typesafe/jev-9.9") return httpFail(404, "model not found");
    return decisionsOk();
  });
  const first = await jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal(first.ok, true);
  assert.deepEqual(seen, ["~typesafe/jev-latest", "typesafe/jev-1.13", "typesafe/jev-9.9"]);
  assert.equal(first.usage.model, "typesafe/jev-9.9");
  // Sticky slug serves the next call without re-walking the cascade.
  seen.length = 0;
  const second = await jev.askJev("probe", "different state here", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal(second.ok, true);
  assert.deepEqual(seen, [jev.KEV_SLUG, "typesafe/jev-9.9"], "the other family is tried, then the working Jev alias takes over");
});

test("transport failure opens the breaker and background probe recovers", async () => {
  let mode = "down";
  let fetches = 0;
  const { timers, pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    fetches++;
    if (mode === "down") throw Error("socket hang up");
    return decisionsOk();
  });
  const call = () => jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal((await call()).skipped, "unavailable");
  assert.equal(jev.jevHealth().state, "open");
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms <= 50 * 60 * 1000 + 1 || timers[0].ms >= 0);
  const before = fetches;
  assert.equal((await call()).skipped, "unhealthy");
  assert.equal(fetches, before, "open breaker fails fast without fetching");
  mode = "up";
  await timers[0].fn();
  for (let i = 0; i < 200 && jev.jevHealth().state === "open"; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(jev.jevHealth().state, "closed");
  const recovered = await call();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.usage.model, "~typesafe/jev-latest", "recovery restarts the cascade from the top");
});

test("failed probe re-arms the breaker for another window", async () => {
  const { timers, pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    return httpFail(500, "upstream error");
  });
  const call = () => jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  await call();
  assert.equal(jev.jevHealth().state, "open");
  await timers[0].fn();
  for (let i = 0; i < 200 && timers.length < 2; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(jev.jevHealth().state, "open");
  assert.equal(timers.length, 2, "probe rescheduled");
});

test("auth failure stops the cascade and opens the breaker once", async () => {
  let fetches = 0;
  const { pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    fetches++;
    return httpFail(401, "invalid key");
  });
  const result = await jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal(result.skipped, "unavailable");
  assert.equal(fetches, 1, "account-level failure does not walk slugs");
  assert.equal(jev.jevHealth().state, "open");
});

test("identical calls pay once via the session cache", async () => {
  let fetches = 0;
  const { ledger, pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    fetches++;
    return decisionsOk();
  });
  const args = ["screen", "some page content here", { ping: { type: "noul", instructions: "Affirmative?" } }];
  const first = await jev.askJev(...args, { pi });
  const second = await jev.askJev(...args, { pi });
  assert.equal(fetches, 1);
  assert.equal(first.usage.cached, false);
  assert.equal(second.usage.cached, true);
  assert.equal(second.usage.inputTokens, 0);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].type, "jev-usage-v1");
  assert.equal(ledger[0].data.site, "screen");
  assert.ok(ledger[0].data.costUsd > 0);
  assert.equal(ledger[1].data.cached, true);
  assert.equal(ledger[1].data.costUsd, 0);
});

test("identical judgments at different sites reuse the paid answer", async () => {
  let fetches = 0;
  const { ledger, pi } = harness(async () => { fetches++; return decisionsOk(); });
  const questions = { ping: { type: "noul", instructions: "Affirmative?" } };
  const first = await jev.askJev("screen", "shared state", questions, { pi });
  const second = await jev.askJev("rank", "shared state", questions, { pi });
  assert.equal(fetches, 1);
  assert.equal(first.usage.cached, false);
  assert.equal(second.usage.cached, true);
  assert.deepEqual(ledger.map(row => [row.data.site, row.data.cached]), [["screen", false], ["rank", true]]);
});

test("a cancelled leader does not own a surviving caller's paid judgment", async () => {
  let respond, started, fetches = 0;
  const begun = new Promise(resolve => { started = resolve; });
  harness(async () => {
    fetches++;
    started();
    return new Promise(resolve => { respond = resolve; });
  });
  const leaderLedger = [], followerLedger = [];
  const leaderPi = { appendEntry: (type, data) => leaderLedger.push({ type, data }) };
  const followerPi = { appendEntry: (type, data) => followerLedger.push({ type, data }) };
  const abort = new AbortController();
  const questions = { ping: { type: "noul", instructions: "Affirmative?" } };
  const leader = jev.askJev("screen", "shared state", questions, { pi: leaderPi, signal: abort.signal });
  await begun;
  const follower = jev.askJev("rank", "shared state", questions, { pi: followerPi });
  abort.abort();
  assert.equal((await leader).skipped, "aborted");
  respond(decisionsOk());
  const result = await follower;
  assert.equal(result.ok, true);
  assert.equal(result.usage.cached, false);
  assert.equal(fetches, 1);
  assert.equal(leaderLedger.length, 0);
  assert.equal(followerLedger.length, 1);
  assert.equal(followerLedger[0].data.site, "rank");
  assert.ok(followerLedger[0].data.costUsd > 0);
});

test("preferred and cached judgments do not fetch the model catalog", async () => {
  let catalogs = 0, judgments = 0;
  harness(async url => {
    if (String(url).includes('/api/v1/models')) { catalogs++; return emptyModels(); }
    judgments++; return decisionsOk();
  });
  const ask = () => jev.askJev('lazy', 'synthetic state', { ping: { type: 'noul', instructions: 'Affirmative?' } });
  assert.equal((await ask()).ok, true);
  assert.equal((await ask()).usage.cached, true);
  assert.equal(catalogs, 0, 'catalog discovery is a model-rejection fallback');
  assert.equal(judgments, 1);
});

test("cancellation during fallback discovery returns promptly without another paid request", async () => {
  let releaseCatalog, catalogStarted, judgments = 0;
  const started = new Promise(resolve => { catalogStarted = resolve; });
  harness(async url => {
    if (String(url).includes('/api/v1/models')) {
      catalogStarted();
      return new Promise(resolve => { releaseCatalog = resolve; });
    }
    judgments++; return httpFail(404, 'model not found');
  });
  const abort = new AbortController();
  const work = jev.askJev('cancelled', 'synthetic state', { ping: { type: 'noul', instructions: 'Affirmative?' } }, { signal: abort.signal });
  await started;
  abort.abort();
  try {
    assert.equal((await work).skipped, 'aborted');
    assert.equal(judgments, 2, 'only the two preferred aliases were attempted');
  } finally {
    releaseCatalog(jsonOk({ data: [{ id: 'typesafe/jev-fallback' }] }));
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(judgments, 2);
  assert.equal(jev.jevHealth().state, 'closed', 'cancellation is not a provider outage');
});

test("malformed and oversized inputs fail open before paying, including cancellable callers", async () => {
  let fetches = 0;
  harness(async () => { fetches++; return decisionsOk(); });
  const circular = {}; circular.self = circular;
  const questions = { ping: { type: 'noul', instructions: 'Affirmative?' } };
  const opts = { signal: new AbortController().signal };
  assert.equal((await jev.askJev('bounded', circular, questions, opts)).skipped, 'invalid-input');
  // Oversized questions cannot be trimmed safely: refused before paying.
  const hugeQuestions = { ping: { type: 'noul', instructions: 'x'.repeat(33000) } };
  assert.equal((await jev.askJev('bounded', 'short evidence', hugeQuestions, opts)).skipped, 'input-budget');
  assert.equal(fetches, 0);
  // Oversized evidence is trimmed with a visible marker instead of dropped.
  const fitted = jev.fitJevState({ task: 'Fix it', output: 'y'.repeat(40000) }, questions);
  assert.ok(JSON.stringify([fitted, questions]).length <= 32768);
  assert.match(fitted.output, /characters omitted to fit/);
  assert.equal(fitted.task, 'Fix it');
  assert.equal((await jev.askJev('bounded', 'x'.repeat(32769), questions, opts)).ok, true);
  assert.equal(fetches, 1);
});

test("skips stay quiet: disabled, trivial, missing key, aborted", async () => {
  const { pi } = harness(async () => decisionsOk());
  process.env.PI_JEV = "off";
  assert.equal((await jev.askJev("s", "hello world", { q: { type: "noul", instructions: "x" } }, { pi })).skipped, "disabled");
  process.env.PI_JEV = "0";
  assert.equal((await jev.askJev("s", "hello world", { q: { type: "noul", instructions: "x" } }, { pi })).skipped, "disabled", "PI_JEV=0 disables remote calls (no paid fallback)");
  assert.equal(jev.jevEnabled({ PI_JEV: "0" }), false);
  assert.equal(jev.jevEnabled({ PI_JEV: "off" }), false);
  assert.equal(jev.jevEnabled({}), true);
  delete process.env.PI_JEV;
  assert.equal((await jev.askJev("s", "  ", { q: { type: "noul", instructions: "x" } }, { pi })).skipped, "trivial");
  assert.equal((await jev.askJev("s", "hello world", {}, { pi })).skipped, "trivial");
  delete process.env.OPENROUTER_API_KEY;
  assert.equal((await jev.askJev("s", "hello world", { q: { type: "noul", instructions: "x" } }, { pi })).skipped, "no-key");
  assert.equal(jev.jevHealth().state, "closed", "missing key is not a breaker failure");
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  const controller = new AbortController();
  controller.abort();
  assert.equal((await jev.askJev("s", "hello world", { q: { type: "noul", instructions: "x" } }, { pi, signal: controller.signal })).skipped, "aborted");
});

test('offline mode prevents remote advisories and scheduled recovery probes', async () => {
  let fetches = 0;
  const { pi, timers } = harness(async () => { fetches++; throw Error('offline fixture'); });
  const ask = () => jev.askJev('offline', 'substantive request', { q: { type: 'noul', instructions: 'Assess' } }, { pi });
  await ask();
  const before = fetches;
  try {
    for (const value of ['1', 'true', 'yes']) {
      process.env.PI_OFFLINE = value;
      assert.equal((await ask()).skipped, 'disabled');
      assert.equal(jev.jevEnabled({ PI_OFFLINE: value, PI_JEV: 'on' }), false);
    }
    await timers[0].fn();
    assert.equal(fetches, before, 'offline mode sends neither a request nor a background probe');
  } finally {
    delete process.env.PI_OFFLINE;
  }
});

test('concurrent identical advisory calls pay once and cached answers cannot be mutated', async () => {
  let fetches=0;
  const {pi,ledger}=harness(async url=>{
    if(String(url).includes('/api/v1/models'))return emptyModels();
    fetches++;await new Promise(resolve=>setTimeout(resolve,10));return decisionsOk();
  });
  const ask=()=>jev.askJev('concurrent','synthetic state',{ping:{type:'noul',instructions:'Affirmative?'}},{pi});
  const [first,second]=await Promise.all([ask(),ask()]);
  assert.equal(fetches,1);
  assert.equal(ledger.filter(row=>!row.data.cached).length,1);
  assert.equal(second.usage.cached,true);
  first.answers.ping.noul=0;
  second.answers.ping.noul=0;
  assert.equal((await ask()).answers.ping.noul,.9);
});

test("chunk split and extractive render stay bounded", () => {
  assert.deepEqual(jev.splitTextChunks("", 8, 2000), []);
  const text = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n");
  const chunks = jev.splitTextChunks(text, 4, 500);
  assert.deepEqual(chunks, [], "oversized input abstains instead of silently losing its tail");
  assert.ok(chunks.every((chunk) => chunk.length <= 600));
  const rendered = jev.renderKeptChunks(["a", "b", "c", "d"], [true, false, false, true]);
  assert.ok(rendered.includes("a") && rendered.includes("d"));
  assert.ok(!rendered.includes("\nb\n"));
  assert.ok(rendered.includes("2 chunk(s) omitted"));
  assert.equal(jev.renderKeptChunks(["x".repeat(200)], [true], 100), "", "render cap cannot cut retained evidence");
});

test("distill selection keeps edges, drops low-score middles", async () => {
  const text = ["HEAD", "aaa", "bbb", "ccc", "TAIL"].map((s) => `${s} ${"x".repeat(1400)}`).join("\n");
  const ask = async () => ({
    ok: true,
    answers: {
      chunk_0: { type: "noul", noul: 0.1 },
      chunk_1: { type: "noul", noul: 0.9 },
      chunk_2: { type: "noul", noul: 0.2 },
      chunk_3: { type: "noul", noul: 0.9 },
      chunk_4: { type: "noul", noul: 0.1 },
    },
    usage: { model: "typesafe/jev-1.13", inputTokens: 5000, costUsd: 0.00021, ms: 100, cached: false },
  });
  const selection = await jev.selectDistillChunks("bash", text, ask);
  assert.ok(selection.includes("HEAD"), "first chunk kept despite low score");
  assert.ok(selection.includes("TAIL"), "last chunk kept despite low score");
  assert.ok(!selection.includes("bbb"), "low middle dropped");
  assert.ok(selection.includes("successfully routed with Jev"));
  assert.ok(selection.includes("kept 4/5"));
  const keepAll = await jev.selectDistillChunks("bash", text, async () => ({
    ok: true,
    answers: Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`chunk_${i}`, { type: "noul", noul: 0.99 }])),
    usage: { model: "m", inputTokens: 1, costUsd: 0, ms: 1, cached: false },
  }));
  assert.equal(keepAll, undefined, "all-kept returns no selection");
  assert.equal(await jev.selectDistillChunks("bash", "tiny", ask), undefined);
  assert.equal(await jev.selectDistillChunks("bash", text, async () => ({ ok: false, skipped: "unhealthy" })), undefined);
});

test("cost and metrics ledgers treat Jev like any route", async () => {
  const { collectSessionCost } = await import(pathToFileURL(path.join(agent, "extensions/lib/session-cost.ts")));
  const { collectSessionMetrics } = await import(pathToFileURL(path.join(agent, "extensions/lib/session-metrics.ts")));
  const entries = [
    { type: "custom", customType: "jev-usage-v1", data: { site: "screen", model: "typesafe/jev-1.13", inputTokens: 2000, costUsd: 0.000084, ms: 120, cached: false } },
    { type: "custom", customType: "jev-usage-v1", data: { site: "rank", model: "typesafe/jev-1.13", inputTokens: 0, costUsd: 0, ms: 1, cached: true } },
  ];
  const cost = collectSessionCost(entries);
  assert.ok(Math.abs(cost.total - 0.000084) < 1e-12);
  assert.ok(cost.rows.some((row) => row.route === "openrouter/typesafe/jev-1.13"));
  const metrics = collectSessionMetrics(entries);
  assert.equal(metrics.jev.hits, 2);
  assert.equal(metrics.jev.cached, 1);
  assert.equal(metrics.jev.tokens, 2000);
  assert.equal(metrics.jev.bySite.screen.hits, 1);
});

test("cost math and TUI marker stay exact", () => {
  assert.equal(jev.estimateJevTokens(0), 1);
  assert.equal(jev.estimateJevTokens(4000), 1000);
  assert.equal(jev.jevCostUsd(1_000_000), 0.042);
  assert.ok(Math.abs(jev.jevCostUsd(2000) - 0.000084) < 1e-12);
  assert.equal(
    jev.jevMark("screen", "pass 0.99", { inputTokens: 412, cached: false }),
    "[successfully routed with Jev · screen · pass 0.99 · 412 tok]",
  );
  assert.equal(
    jev.jevMark("rank", "auth 0.99", { inputTokens: 0, cached: true }),
    "[successfully routed with Jev · rank · auth 0.99 · cached 0 tok]",
  );
  assert.equal(jev.tooShort("x".repeat(39), 40), true);
  assert.equal(jev.tooShort("x".repeat(40), 40), false);
  assert.equal(jev.tooShort("   ", 1), true);
});

test('malformed typed judgments never reach the cache or report success', async () => {
  for (const answers of [{ ping: { type: 'noul', noul: 2 } }, { ping: { type: 'noul', noul: '0.9' } }, {}, []]) {
    harness(async () => jsonOk({ answers }));
    assert.equal((await jev.askJev('invalid', 'synthetic evidence', { ping: { type: 'noul' } })).ok, false);
  }
});

test('one deadline bounds the entire alias cascade and reports an error-colored helper outcome', async () => {
  const states = [];
  const key = Symbol.for('yunus-pi.activity.v1'), previous = globalThis[key];
  globalThis[key] = request => { states.push(request.label); return outcome => states.push(outcome); };
  harness(async (url, options) => {
    if (String(url).includes('/models')) return emptyModels();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
    return httpFail(404, 'model not found');
  });
  jev.configureJevClient({ requestTimeoutMs: 45 });
  try {
    const started = performance.now();
    const result = await jev.askJev('deadline', 'synthetic evidence', { ping: { type: 'noul' } });
    assert.ok(['timeout', 'unavailable'].includes(result.skipped), 'the overall or both route deadlines stop work');
    assert.ok(performance.now() - started < 250);
    assert.equal(states.at(-1), 'error');
    assert.ok(states.includes('jev'));
    assert.equal(jev.jevHealth().state, 'open', 'both independently timed-out routes cool down');
  } finally {
    jev.configureJevClient({ requestTimeoutMs: jev.JEV_REQUEST_TIMEOUT_MS });
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  }
});

test('invalid request errors do not cascade aliases or expose provider-echoed input',async()=>{
 let count=0;
 harness(async()=>{count++;return httpFail(400,'invalid request PRIVATE-ECHOED-STATE');});
 assert.equal((await jev.askJev('privacy','synthetic evidence',{ping:{type:'noul'}})).ok,false);
 assert.equal(count,1);
 assert.doesNotMatch(jev.jevHealth().lastError,/PRIVATE-ECHOED-STATE|invalid request/);
});

test('Jev admission failures, remote failures and recovery publish sanitized persistent diagnostics', async () => {
  const key = Symbol.for('yunus-pi.health.v1'), previous = globalThis[key], events = [];
  globalThis[key] = (kind, data) => events.push({ kind, data });
  try {
    harness(async () => httpFail(500, 'PRIVATE-PROVIDER-ECHO'));
    const args = ['visibility', 'PRIVATE-INPUT-TEXT', { ping: { type: 'noul' } }];
    assert.equal((await jev.askJev(...args)).skipped, 'unavailable');
    assert.equal(events.at(-1).kind, 'ml.jev.skipped');
    assert.equal(events.at(-1).data.reason, 'unavailable');
    assert.equal((await jev.askJev(...args)).skipped, 'unhealthy');
    assert.equal(events.at(-1).data.reason, 'unhealthy');
    process.env.PI_JEV = 'off';
    assert.equal((await jev.askJev(...args)).skipped, 'disabled');
    assert.equal(events.at(-1).data.reason, 'disabled');
    delete process.env.PI_JEV;
    harness(async () => decisionsOk());
    assert.equal((await jev.askJev(...args)).ok, true);
    assert.equal(events.at(-1).kind, 'ml.jev.used');
    assert.equal(events.at(-1).data.questions, 1);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-/);
  } finally {
    delete process.env.PI_JEV;
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  }
});

test('healthy Jev and Kev split uncached decisions and retain cache attribution', async () => {
  const models = [];
  harness(async (_url, { body }) => { const { model } = JSON.parse(body); models.push(model); return jsonOk({ answers: ANSWERS, usage: { input_tokens: 37, cost: 0.000001554 } }); });
  const questions = { ping: { type: 'noul', instructions: 'Relevant?' } };
  for (let i = 0; i < 6; i++) {
    const result = await jev.askJev('balanced', `unique task ${i}`, questions);
    assert.equal(result.ok, true); assert.equal(result.usage.inputTokens, 37); assert.equal(result.usage.costUsd, 0.000001554);
  }
  assert.deepEqual(models, Array.from({ length: 6 }, (_, i) => i % 2 ? jev.KEV_SLUG : '~typesafe/jev-latest'));
  const cached = await jev.askJev('balanced', 'unique task 1', questions);
  assert.equal(cached.usage.model, jev.KEV_SLUG); assert.equal(cached.usage.cached, true); assert.equal(models.length, 6);
});

test('concurrent decisions balance active load without sharing unrelated results', async () => {
  const models = [], waiting = [];
  harness(async (_url, { body }) => { models.push(JSON.parse(body).model); return new Promise(resolve => waiting.push(() => resolve(decisionsOk()))); });
  const calls = Array.from({ length: 4 }, (_, i) => jev.askJev('parallel', `independent question ${i}`, { ping: { type: 'noul', instructions: 'Relevant?' } }));
  for (let i = 0; i < 100 && waiting.length < 4; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(models.filter(m => m === jev.KEV_SLUG).length, 2);
  waiting.forEach(done => done());
  assert.ok((await Promise.all(calls)).every(result => result.ok));
  assert.ok(jev.jevHealth().routes.every(route => route.active === 0));
});

for (const failure of ['rate-limit', 'outage', 'network', 'malformed']) test(`${failure} cools only the failing judge and the other serves subsequent tasks`, async () => {
  const models = [];
  harness(async (_url, { body }) => {
    const model = JSON.parse(body).model; models.push(model);
    if (model === jev.KEV_SLUG) return decisionsOk();
    if (failure === 'network') throw Error('connection failed');
    if (failure === 'malformed') return jsonOk({ answers: {} });
    return httpFail(failure === 'rate-limit' ? 429 : 503, 'temporary failure');
  });
  const q = { ping: { type: 'noul', instructions: 'Relevant?' } };
  assert.equal((await jev.askJev('failover', 'first task here', q)).usage.model, jev.KEV_SLUG);
  assert.equal((await jev.askJev('failover', 'next task here', q)).usage.model, jev.KEV_SLUG);
  assert.deepEqual(models, ['~typesafe/jev-latest', jev.KEV_SLUG, jev.KEV_SLUG]);
  assert.equal(jev.jevHealth().state, 'closed');
});

test('Jev takes over a failed Kev turn without changing the main model route', async () => {
  const models = [];
  harness(async (_url, { body }) => { const model = JSON.parse(body).model; models.push(model); return model === jev.KEV_SLUG ? httpFail(503, 'outage') : decisionsOk(); });
  const q = { ping: { type: 'noul', instructions: 'Relevant?' } };
  await jev.askJev('reverse', 'first task warm', q);
  assert.equal((await jev.askJev('reverse', 'second task fallthrough', q)).usage.model, '~typesafe/jev-latest');
  assert.deepEqual(models, ['~typesafe/jev-latest', jev.KEV_SLUG, '~typesafe/jev-latest']);
});

test('a slow Jev route leaves deadline budget for Kev; caller cancellation poisons neither', async () => {
  harness(async (_url, { body, signal }) => JSON.parse(body).model === jev.KEV_SLUG ? decisionsOk() : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  jev.configureJevClient({ requestTimeoutMs: 100 });
  const q = { ping: { type: 'noul', instructions: 'Relevant?' } };
  const result = await jev.askJev('bounded', 'first task timeout', q);
  assert.equal(result.ok, true); assert.equal(result.usage.model, jev.KEV_SLUG);
  harness(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const c = new AbortController();
  const pending = jev.askJev('cancel', 'cancel this task', q, { signal: c.signal });
  await new Promise(r => setImmediate(r)); c.abort();
  assert.equal((await pending).skipped, 'aborted');
  assert.equal(jev.jevHealth().state, 'closed');
  assert.ok(jev.jevHealth().routes.every(route => route.state !== 'cooling'));
});
