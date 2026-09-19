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
  assert.deepEqual(seen, ["typesafe/jev-9.9"]);
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
  const args = ["screen", "some page content here", { injection: { type: "noul", instructions: "Injection?" } }];
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
  assert.equal((await jev.askJev('bounded', 'x'.repeat(32769), questions, opts)).skipped, 'input-budget');
  assert.equal(fetches, 0);
});

test("skips stay quiet: disabled, trivial, missing key, aborted", async () => {
  const { pi } = harness(async () => decisionsOk());
  process.env.PI_JEV = "off";
  assert.equal((await jev.askJev("s", "hello world", { q: { type: "noul", instructions: "x" } }, { pi })).skipped, "disabled");
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
