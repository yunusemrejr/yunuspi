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
  let elapsed = 0;
  const ledger = [], receipts = [];
  const pi = { appendEntry: (type, data) => (type === 'jev-usage-v1' ? ledger : receipts).push({ type, data }) };
  jev.resetJevClient();
  jev.configureJevClient({ fetchImpl, now: () => Date.now() + elapsed, openMs: 5000 });
  return { advance: ms => { elapsed += ms; }, ledger, receipts, pi };
}

const ANSWERS = { ping: { type: "noul", noul: 0.9 } };
const decisionsOk = () => jsonOk({ answers: ANSWERS });
const emptyModels = () => jsonOk({ data: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function mockDeadline(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.method(performance, 'now', () => Date.now());
}
async function waitForGate(promise, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Jev test did not observe ${label}`)), 5000);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); }
}

test('equivalent JSON map order shares one in-flight judgment across hook callers',async()=>{
  let calls=0,finish;
  const {pi,ledger}=harness(async()=>{calls++;await new Promise(resolve=>{finish=resolve;});return decisionsOk();});
  const first=jev.askJev('skill',{task:'Review source',evidence:{a:1,b:2}},{ping:{type:'noul',instructions:'Affirmative?'}},{pi});
  const second=jev.askJev('tool',{evidence:{b:2,a:1},task:'Review source'},{ping:{instructions:'Affirmative?',type:'noul'}},{pi});
  await new Promise(resolve=>setTimeout(resolve,0));finish();
  const results=await Promise.all([first,second]);
  assert.equal(calls,1);assert.ok(results.every(result=>result.ok));
  assert.equal(ledger.filter(row=>!row.data.cached).length,1);
  const cached=await jev.askJev('review',{evidence:{b:2,a:1},task:'Review source'},{ping:{type:'noul',instructions:'Affirmative?'}},{pi});
  assert.equal(cached.usage.cached,true);assert.equal(calls,1);
});

test('a valid cached judgment remains usable while both network routes cool down',async()=>{
  let broken=false,calls=0;
  harness(async()=>{calls++;if(broken)throw Error('offline');return decisionsOk();});
  const questions={ping:{type:'noul',instructions:'Affirmative?'}};
  assert.equal((await jev.askJev('unit','already judged evidence',questions)).ok,true);
  broken=true;assert.equal((await jev.askJev('unit','new evidence',questions)).ok,false);
  assert.equal(jev.jevHealth().state,'open');const before=calls;
  const cached=await jev.askJev('unit','already judged evidence',questions);
  assert.equal(cached.ok,true);assert.equal(cached.usage.cached,true);assert.equal(calls,before);
});

test("cascade tries tilde latest, then the current dated release, then the previous one, then discovered variations", async () => {
  const seen = [];
  const { pi } = harness(async (url, opts) => {
    if (String(url).includes("/api/v1/models")) return jsonOk({ data: [{ id: "typesafe/jev-9.9" }, { id: "other/jev-x" }, { id: "openai/gpt" }, { id: "typesafe/jev-router" }] });
    const slug = JSON.parse(opts.body).model;
    seen.push(slug);
    if (slug !== "typesafe/jev-9.9") return httpFail(404, "model not found");
    return decisionsOk();
  });
  const first = await jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal(first.ok, true);
  assert.deepEqual(seen, ["~typesafe/jev-latest", "typesafe/jev-1.14-20261014", "typesafe/jev-1.13", "typesafe/jev-9.9"]);
  assert.equal(first.usage.model, "typesafe/jev-9.9");
  assert.ok(!seen.includes("typesafe/jev-router"), "the chat-only router never joins the decisions cascade");
  // Sticky slug serves the next call without re-walking the cascade.
  seen.length = 0;
  const second = await jev.askJev("probe", "different state here", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal(second.ok, true);
  assert.deepEqual(seen, [jev.KEV_SLUG, "typesafe/jev-9.9"], "the other family is tried, then the working Jev alias takes over");
});

test("the served dated release is reported as the model and kept as the next Jev fallback", async () => {
  const seen = [];
  let calls = 0;
  const { pi } = harness(async (url, opts) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    const slug = JSON.parse(opts.body).model;
    seen.push(slug);
    calls += 1;
    // The first call proves the alias; a later call has the alias rejected and
    // must fall back to the concrete dated model the route reported.
    if (calls > 1 && slug === "~typesafe/jev-latest") return httpFail(404, "model not found");
    return jsonOk({ model: "typesafe/jev-1.14-20261014", answers: ANSWERS, usage: { input_tokens: 10, cost: 0.000001 } });
  });
  const q = { ping: { type: "noul", instructions: "Affirmative?" } };
  const first = await jev.askJev("latest", "first decision", q, { pi });
  assert.equal(first.ok, true);
  assert.equal(first.usage.model, "typesafe/jev-1.14-20261014", "the dated model that answered is reported, not only the alias");
  assert.equal(jev.jevHealth().resolvedSlug, "typesafe/jev-1.14-20261014");
  seen.length = 0;
  const second = await jev.askJev("latest", "second decision", q, { pi, family: "jev" });
  assert.equal(second.ok, true);
  assert.deepEqual(seen, ["~typesafe/jev-latest", "typesafe/jev-1.14-20261014"], "a rejected alias falls back to the known dated release");
});

test("a caller-selected deadline bounds the whole advisory call", async () => {
  harness(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  jev.configureJevClient({ requestTimeoutMs: 5_000 });
  const started = Date.now();
  const result = await jev.askJev("bounded-caller", "a slow judge decision", { ping: { type: "noul", instructions: "Affirmative?" } }, { timeoutMs: 40 });
  assert.ok(result.ok === false && ["timeout", "unavailable"].includes(result.skipped), `a short caller deadline fails open (${JSON.stringify(result)})`);
  assert.ok(Date.now() - started < 1_000, "the short caller deadline is honored instead of the full cascade deadline");
});

test('a caller deadline releases the waiter while a late physical charge keeps its original owner', async t => {
  mockDeadline(t);
  const reply = Promise.withResolvers();
  let signal, sends = 0, answer;
  const origin = harness(async (_url, options) => {
    sends++;
    signal = options.signal;
    return reply.promise;
  });
  const otherRows = [];
  const other = { appendEntry: (...entry) => otherRows.push(entry) };
  const params = ['deadline-late-billing', 'synthetic evidence', { ping: { type: 'noul' } }];
  const waiting = jev.askJev(...params, { pi: origin.pi, timeoutMs: 40 }).then(result => { answer = result; return result; });
  try {
    await tick();
    assert.ok(signal);
    t.mock.timers.tick(40);
    await tick();
    assert.deepEqual(answer, { ok: false, skipped: 'timeout' });
    assert.equal(signal.aborted, true);
    assert.equal(jev.jevHealth().routes.reduce((sum, route) => sum + route.active, 0), 1, 'transport retains its original lease until it settles');
    let duplicate;
    void jev.askJev(...params, { pi: other, timeoutMs: 40 }).then(result => { duplicate = result; });
    await tick();
    assert.deepEqual(duplicate, { ok: false, skipped: 'busy' });
    assert.equal(sends, 1);
    assert.deepEqual(otherRows, []);
    assert.deepEqual(origin.receipts.map(row => row.data.status), ['pending']);
  } finally {
    reply.resolve(jsonOk({ answers: ANSWERS, usage: { cost: 0.037 } }));
    await waiting;
  }
  await tick();
  assert.deepEqual(origin.receipts.map(row => row.data.status), ['pending', 'timeout']);
  assert.equal(origin.receipts[1].data.id, origin.receipts[0].data.id);
  assert.deepEqual(origin.receipts[1].data.usage.cost, { total: 0.037, source: 'provider-reported', complete: true });
  assert.equal(origin.ledger.length, 0, 'a late charge is not a delivered judgment');
  assert.equal(sends, 1);
  assert.ok(jev.jevHealth().routes.every(route => route.active === 0 && route.state === 'ready'));
});

test('a short coalesced deadline leaves the submitting caller and the shared route active', async t => {
  mockDeadline(t);
  const reply = Promise.withResolvers();
  let signal, sends = 0, shortResult;
  const owner = harness(async (_url, options) => { sends++; signal = options.signal; return reply.promise; });
  const params = ['deadline-coalesced', 'synthetic evidence', { ping: { type: 'noul' } }];
  const leader = jev.askJev(...params, { pi: owner.pi, timeoutMs: 100 });
  const follower = jev.askJev(...params, { timeoutMs: 10 }).then(result => { shortResult = result; return result; });
  try {
    await tick();
    assert.ok(signal);
    t.mock.timers.tick(10);
    await tick();
    assert.deepEqual(shortResult, { ok: false, skipped: 'timeout' });
    assert.equal(signal.aborted, false);
    assert.equal(sends, 1);
  } finally { reply.resolve(decisionsOk()); }
  assert.equal((await leader).ok, true);
  assert.equal((await follower).skipped, 'timeout');
  assert.deepEqual(owner.receipts.map(row => row.data.status), ['pending', 'completed']);
});

test('an optional second opinion shares the caller deadline and a late rejection is settled', async t => {
  mockDeadline(t);
  const previous = process.env.PI_JEV_SECOND_OPINION;
  delete process.env.PI_JEV_SECOND_OPINION;
  const primary = Promise.withResolvers(), second = Promise.withResolvers();
  let sends = 0, answer;
  const owner = harness(async () => (++sends === 1 ? primary.promise : second.promise));
  const first = { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.35, c: 0.25 } };
  const questions = { rank: { type: 'choice', criteria: { a: 'a', b: 'b', c: 'c' } } };
  const work = jev.askJev('deadline-opinion', 'synthetic', questions, { pi: owner.pi, timeoutMs: 100 }).then(result => { answer = result; });
  try {
    await tick();
    assert.equal(sends, 1);
    t.mock.timers.tick(20);
    primary.resolve(jsonOk({ answers: { rank: first } }));
    await tick();
    assert.equal(sends, 2);
    t.mock.timers.tick(80);
    await tick();
    assert.equal(answer?.ok, true);
    assert.deepEqual(answer.answers.rank, first);
    assert.deepEqual(owner.receipts.map(row => row.data.status), ['pending', 'completed', 'pending']);
  } finally {
    primary.resolve(jsonOk({ answers: { rank: first } }));
    // Attach an observer even if a regression prevented the second dispatch.
    void second.promise.catch(() => {});
    second.reject(new Error('late synthetic transport rejection'));
    await work;
    if (previous === undefined) delete process.env.PI_JEV_SECOND_OPINION;
    else process.env.PI_JEV_SECOND_OPINION = previous;
  }
  await tick();
  assert.equal(sends, 2);
  assert.deepEqual(owner.receipts.map(row => row.data.status), ['pending', 'completed', 'pending', 'timeout']);
  assert.ok(jev.jevHealth().routes.every(route => route.active === 0 && route.state === 'ready'));
});

test("transport failure opens the breaker and admits a single real request after cooldown", async () => {
  let mode = "down";
  let fetches = 0;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { advance, pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    fetches++;
    if (mode === "down") throw Error("socket hang up");
    entered.resolve();
    await release.promise;
    return decisionsOk();
  });
  const call = () => jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  assert.equal((await call()).skipped, "unavailable");
  assert.equal(jev.jevHealth().state, "open");
  const before = fetches;
  assert.equal((await call()).skipped, "unhealthy");
  assert.equal(fetches, before, "open breaker fails fast without fetching");
  mode = "up";
  advance(5001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, before, "elapsed time alone sends no paid probe");
  const recovering = call();
  await entered.promise;
  assert.equal((await jev.askJev('contender', 'other request', { ping: { type: 'noul' } }, { pi })).skipped, 'unhealthy');
  assert.equal(fetches, before + 1);
  release.resolve();
  const recovered = await recovering;
  assert.equal(recovered.ok, true);
  assert.equal(jev.jevHealth().state, "closed");
});

test("failed real trial re-arms the breaker for another window", async () => {
  const { advance, pi } = harness(async (url) => {
    if (String(url).includes("/api/v1/models")) return emptyModels();
    return httpFail(500, "upstream error");
  });
  const call = () => jev.askJev("probe", "hello world", { ping: { type: "noul", instructions: "Affirmative?" } }, { pi });
  await call();
  assert.equal(jev.jevHealth().state, "open");
  advance(5001);
  assert.equal((await call()).skipped, 'unavailable');
  assert.equal(jev.jevHealth().state, "open");
  assert.equal((await call()).skipped, 'unhealthy');
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

test("an in-flight judgment snapshots state and questions for validation and caching", async () => {
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const sent = [];
  harness(async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    if (sent.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return decisionsOk();
  });
  const state = { task: 'Inspect the first request', nested: { revision: 1 } };
  const questions = { ping: { type: 'noul', instructions: 'Affirmative?' } };
  const originalState = structuredClone(state), originalQuestions = structuredClone(questions);
  const first = jev.askJev('snapshot', state, questions);
  await waitForGate(begun, 'snapshot transport start');
  state.task = 'Inspect the changed request'; state.nested.revision = 2;
  questions.ping.type = 'score';
  release();
  assert.equal((await first).ok, true, 'validate the type sent to the provider');
  const reused = await jev.askJev('snapshot', originalState, originalQuestions);
  assert.equal(reused.ok, true); assert.equal(reused.usage.cached, true);
  assert.equal(sent.length, 1, 'store the paid answer under the submitted state');
  const changed = await jev.askJev('snapshot', state, originalQuestions);
  assert.equal(changed.ok, true); assert.equal(changed.usage.cached, false);
  assert.equal(sent.length, 2, 'mutated state cannot inherit the old answer');
  assert.deepEqual(sent[0].state, originalState);
});

test("a surviving coalescer uses the answer while the submitting session owns the billed request", async () => {
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
  await waitForGate(begun, 'coalesced transport start');
  const follower = jev.askJev("rank", "shared state", questions, { pi: followerPi });
  abort.abort();
  assert.equal((await leader).skipped, "aborted");
  respond(decisionsOk());
  const result = await follower;
  assert.equal(result.ok, true);
  assert.equal(result.usage.cached, true);
  assert.equal(fetches, 1);
  assert.deepEqual(leaderLedger.filter(row=>row.type==='auxiliary-model-usage-v1').map(row=>row.data.status),['pending','completed']);
  assert.equal(followerLedger.length, 1);
  assert.equal(followerLedger[0].data.site, "rank");
  assert.equal(followerLedger[0].data.costUsd, 0);
});

test('malformed billed answers and their fallback both reach the canonical ledger', async () => {
  let calls = 0;
  const { pi, ledger, receipts } = harness(async () => ++calls === 1
    ? jsonOk({ answers: { ping: { type: 'noul', noul: 99 } }, usage: { input_tokens: 10, cost: .03 } })
    : jsonOk({ answers: ANSWERS, usage: { input_tokens: 10, cost: .02 } }));
  const { collectSessionCost, collectSessionMetrics } = await import('@yunuspi/coding-agent/session-accounting');
  const params = ['bill-before-validation', 'synthetic evidence', { ping: { type: 'noul' } }];
  assert.equal((await jev.askJev(...params, { pi })).ok, true);
  assert.equal((await jev.askJev(...params, { pi })).usage.cached, true);
  assert.equal(calls, 2);
  assert.deepEqual(receipts.map(row=>row.data.status), ['pending','failed','pending','completed']);
  assert.equal(ledger[0].data.billingReceiptId, receipts[3].data.id);
  const entries = [...receipts,...ledger].map(({ type, data })=>({ type:'custom', customType:type, data }));
  const cost = collectSessionCost(entries);
  assert.equal(cost.reported, .05);
  assert.equal(cost.estimated, 0);
  assert.equal(cost.unknown, false);
  const metrics = collectSessionMetrics(entries);
  assert.equal(metrics.jev.costUsd,.05);
  assert.equal(metrics.jev.tokens,20);
  assert.deepEqual(metrics.jev.bySite['bill-before-validation'],{hits:2,tokens:20,costUsd:.05});
  const { addAuxiliaryUsage, snapshotChildUsage } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/shared/cost-accounting.ts')));
  const child = { input:0, output:0, cacheRead:0, cacheWrite:0, turns:0, cost:0 };
  for (const entry of entries) addAuxiliaryUsage(child,{ type:'entry_appended', entry });
  assert.equal(snapshotChildUsage(child).costDetails.reported,.05);
});

test('last waiter cancellation settles the original billed response even when delivery was abandoned', async () => {
  const sent = Promise.withResolvers(), response = Promise.withResolvers(), settled = Promise.withResolvers();
  const controller = new AbortController();
  let sends = 0;
  harness(async (_url, {signal}) => {
    sends++;
    sent.resolve(signal);
    return response.promise;
  });
  const rows = [];
  const pi = { appendEntry(type, data) { rows.push(data); if (type === 'auxiliary-model-usage-v1' && data.status !== 'pending') settled.resolve(); } };
  const params = ['abandoned-bill','same evidence',{ping:{type:'noul'}}];
  const first = jev.askJev(...params,{pi,signal:controller.signal});
  const networkSignal = await waitForGate(sent.promise, 'cancelled transport start');
  const second = jev.askJev(...params,{pi,signal:controller.signal});
  controller.abort();
  assert.equal((await first).skipped,'aborted');
  assert.equal((await second).skipped,'aborted');
  assert.equal(networkSignal.aborted,true);
  response.resolve(jsonOk({ answers:ANSWERS, usage:{ cost:.037 } }));
  await waitForGate(settled.promise, 'cancelled physical receipt');
  assert.equal(sends,1);
  assert.deepEqual(rows.map(row=>row.status),['pending','cancelled']);
  assert.equal(rows[0].id, rows[1].id);
  assert.deepEqual(rows[1].usage.cost,{total:.037,source:'provider-reported',complete:true});
});

test('an expired last caller records timeout and preserves unknown provider billing', async () => {
  const sent = Promise.withResolvers(), settled = Promise.withResolvers(), controller = new AbortController();
  harness(async (_url, {signal}) => {
    sent.resolve();
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const rows = [];
  const pi = {appendEntry(type,data){rows.push(data);if(type==='auxiliary-model-usage-v1'&&data.status!=='pending')settled.resolve();}};
  const answer = jev.askJev('timeout','synthetic',{ping:{type:'noul'}},{pi,signal:controller.signal});
  await waitForGate(sent.promise, 'expired transport start');
  controller.abort(new DOMException('Deadline expired','TimeoutError'));
  assert.equal((await answer).ok,false);
  await waitForGate(settled.promise, 'expired physical receipt');
  assert.deepEqual(rows.map(row=>row.status),['pending','timeout']);
  assert.equal(rows[1].usage,undefined);
});

test('declared zero on a rejected request is known while a Kev Jev-name echo cannot invent a price', async () => {
  const rejected = harness(async () => new Response(JSON.stringify({ usage:{cost:0} }),{status:402}));
  assert.equal((await jev.askJev('zero','synthetic', {ping:{type:'noul'}}, {pi:rejected.pi})).ok,false);
  assert.equal(rejected.receipts[1].data.usage.cost.total,0);
  assert.equal(rejected.receipts[1].data.usage.cost.source,'provider-reported');
  const echoed = harness(async () => jsonOk({ model:jev.JEV_LATEST_VERSIONED, answers:ANSWERS, usage:{input_tokens:100} }));
  const result = await jev.askJev('wrong-route-echo','synthetic', {ping:{type:'noul'}}, {pi:echoed.pi,family:'kev'});
  assert.equal(result.usage.model,jev.KEV_SLUG);
  assert.equal(result.usage.costUsd,undefined);
  assert.equal(echoed.receipts[1].data.settledModel,undefined);
});

test('a durable receipt settles in its submitting branch after the real SDK forks', async t => {
  const { AgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } = await import('@yunuspi/coding-agent');
  const { collectSessionCost } = await import('@yunuspi/coding-agent/session-accounting');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'jev-fork-receipt-'));
  t.after(() => fs.rmSync(cwd,{recursive:true,force:true}));
  let extension;
  const model = { id:'synthetic',name:'Synthetic',api:'openai-completions',provider:'audit',baseUrl:'https://invalid.example',
    reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:2048 };
  const modelRuntime = { getModel:()=>model,getAvailable:()=>[model],hasConfiguredAuth:()=>true,isUsingSubscription:()=>false,
    streamSimple(){assert.fail('a separate model turn was not authorized');} };
  async function makeSession(sessionManager) {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,
      noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[api=>{extension=api;}] });
    await resourceLoader.reload();
    const sdk = await createAgentSession({cwd,agentDir:cwd,model,modelRuntime,settingsManager,resourceLoader,sessionManager,tools:[]});
    await sdk.session.bindExtensions({mode:'print'});
    return {...sdk,services:{cwd,agentDir:cwd}};
  }
  const manager = SessionManager.create(cwd,cwd);
  const user = content => ({role:'user',content,timestamp:Date.now()});
  const rootId = manager.appendMessage(user('root'));
  manager.appendMessage(user('submitting branch'));
  const original = await makeSession(manager);
  const source = manager.getLeafId();
  const host = new AgentSessionRuntime(original.session, original.services, async ({sessionManager})=>makeSession(sessionManager));
  t.after(() => host.session.dispose());
  const sent = Promise.withResolvers(), response = Promise.withResolvers();
  harness(async () => { sent.resolve(); return response.promise; });
  const answer = jev.askJev('fork-bill','synthetic evidence',{ping:{type:'noul'}},{pi:extension});
  try {
    await waitForGate(sent.promise, 'forked session transport start');
    const saved = () => SessionManager.open(manager.getSessionFile(),cwd).getEntries();
    assert.equal(collectSessionCost(saved()).pending,1);
    manager.branch(rootId);
    const alternate = manager.appendMessage(user('other branch'));
    assert.equal((await host.fork(source,{position:'at'})).cancelled,false);
    assert.notEqual(host.session.sessionManager.getSessionId(),manager.getSessionId());
    assert.equal(collectSessionCost(host.session.sessionManager.getEntries()).pending,0);
    response.resolve(jsonOk({answers:ANSWERS,usage:{cost:.04}}));
    assert.equal((await answer).ok,true);
    const old = SessionManager.open(manager.getSessionFile(),cwd);
    assert.equal(old.getLeafId(),alternate);
    assert.deepEqual(old.getEntries().filter(row=>row.accountingOnly).map(row=>[row.parentId,row.data.status]),
      [[source,'pending'],[source,'completed']]);
    assert.equal(collectSessionCost(old.getEntries()).reported,.04);
    assert.equal(collectSessionCost(host.session.sessionManager.getEntries()).total,0);
  } finally { response.resolve(decisionsOk()); await answer; }
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
    assert.equal(judgments, 3, 'only the three preferred aliases were attempted');
  } finally {
    releaseCatalog(jsonOk({ data: [{ id: 'typesafe/jev-9.8-20261001' }] }));
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(judgments, 3);
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

test('offline mode prevents real recovery attempts after cooldown', async () => {
  let fetches = 0;
  const { pi, advance } = harness(async () => { fetches++; throw Error('offline fixture'); });
  const ask = () => jev.askJev('offline', 'substantive request', { q: { type: 'noul', instructions: 'Assess' } }, { pi });
  await ask();
  const before = fetches;
  advance(5001);
  try {
    for (const value of ['1', 'true', 'yes']) {
      process.env.PI_OFFLINE = value;
      assert.equal((await ask()).skipped, 'disabled');
      assert.equal(jev.jevEnabled({ PI_OFFLINE: value, PI_JEV: 'on' }), false);
    }
    assert.equal(fetches, before, 'offline mode sends no requests');
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
  assert.equal(cost.unknown, false);
  const unknown = collectSessionCost([
    ...entries,
    { type: "custom", customType: "jev-usage-v1", data: { site: "rank", model: "jaredpalmer/kev-4b", inputTokens: 1903, ms: 779, cached: false } },
  ]);
  assert.ok(Math.abs(unknown.total - 0.000084) < 1e-12, "unknown spend adds no invented dollars");
  assert.equal(unknown.unknown, true, "a priced-less judgment marks the total unknown");
  assert.match(unknown.formatted, /\+[?]/);
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
  const question={pick:{type:'choice',criteria:{a:'First',b:'Second',unknown:'Unclear'}}};
  for(const probabilities of [{a:.99},{a:.7,b:.6,unknown:.1},{a:.1,b:.8,unknown:.1},{a:.9,b:.1,outside:0}]){
    harness(async()=>jsonOk({answers:{pick:{type:'choice',choice:'a',probabilities}}}));
    assert.equal((await jev.askJev('invalid-choice','synthetic evidence',question)).ok,false);
  }
  harness(async()=>jsonOk({answers:{pick:{type:'choice',choice:'a',probabilities:{a:.7,b:.2,unknown:.1},confidence:.4}}}));
  const valid=await jev.askJev('valid-choice','synthetic evidence',question);
  assert.equal(valid.ok,true);
  assert.deepEqual(jev.readJevChoice(valid.answers.pick,['a','b','unknown']),{
    choice:'a',probability:.7,probabilities:{a:.7,b:.2,unknown:.1},margin:.7-.2,modelConfidence:.4,
  });
});

test('one deadline bounds slow helper routes and reports an error-colored outcome', async () => {
  const states = [];
  const requests = [];
  const key = Symbol.for('yunus-pi.activity.v1'), previous = globalThis[key];
  globalThis[key] = request => { states.push(request.label); return outcome => states.push(outcome); };
  harness(async (url, options) => {
    if (String(url).includes('/models')) return emptyModels();
    requests.push(options.signal);
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
    const health=jev.jevHealth();
    assert.ok(requests.length>0 && requests.length<=2 && requests.every(signal=>signal.aborted), 'deadline cancels every admitted slow request');
    assert.ok(health.routes.every(route=>route.active===0), 'every route lease is released');
    // Overall cancellation can preempt a family's own timeout on a loaded
    // runner. That family remains healthy; elapsed wall time cannot prove
    // that both independent routes completed a failure/cooldown transition.
    if(health.routes.every(route=>route.state==='cooling')) assert.equal(health.state,'open');
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

test('unpriced routes report unknown cost instead of borrowing Jev’s price', async () => {
  assert.equal(jev.resolveJevInputPricePerM('~typesafe/jev-latest'), 0.042);
  assert.equal(jev.resolveJevInputPricePerM('typesafe/jev-1.14-20261014'), 0.042, 'the dated current release is the same Jev family');
  assert.equal(jev.resolveJevInputPricePerM('typesafe/jev-1.13'), 0.042);
  assert.equal(jev.resolveJevInputPricePerM('typesafe/jev-router'), undefined, 'the chat-only router is not a decisions judge');
  assert.equal(jev.resolveJevInputPricePerM(jev.KEV_SLUG), undefined);
  assert.equal(jev.resolveJevInputPricePerM('typesafe/jev-9.9'), 0.042, 'a discovered Jev release carries the documented family price');
  const { ledger, pi } = harness(async (url, { body }) => {
    if (String(url).includes('/api/v1/models')) return emptyModels();
    return JSON.parse(body).model === jev.KEV_SLUG ? decisionsOk() : httpFail(404, 'model not found');
  });
  const q = { ping: { type: 'noul', instructions: 'Relevant?' } };
  const kev = await jev.askJev('priced', 'kev without provider cost', q, { pi });
  assert.equal(kev.ok, true);
  assert.equal(kev.usage.model, jev.KEV_SLUG);
  assert.equal(kev.usage.costUsd, undefined, 'no provider cost and no route price is unknown, not Jev-priced');
  assert.equal(ledger[0].data.costUsd, undefined);
  const priced = harness(async () => jsonOk({ answers: ANSWERS, usage: { input_tokens: 100, cost: 0.5 } }));
  const reported = await jev.askJev('priced', 'kev with provider cost', q, { pi: priced.pi });
  assert.equal(reported.usage.costUsd, 0.5, 'provider-reported cost always wins');
});

test('protected fit fields survive; unprotectable oversize abstains instead of judging damage', async () => {
  const q = { ping: { type: 'noul', instructions: 'Relevant?' } };
  const claim = 'C'.repeat(30000), evidence = 'E'.repeat(30000);
  const fitted = jev.fitJevState({ claim, evidence }, q, { protect: ['claim'] });
  assert.equal(fitted.claim, claim, 'the decisive claim is never middle-trimmed');
  assert.match(fitted.evidence, /characters omitted to fit/);
  assert.ok(JSON.stringify([fitted, q]).length <= 32768);
  const stuck = jev.fitJevState({ claim }, q, { protect: ['claim'] });
  assert.equal(stuck.claim, claim);
  assert.ok(JSON.stringify([stuck, q]).length <= 32768, 'a fitting protected state passes through');
  harness(async () => decisionsOk());
  const huge = 'H'.repeat(40000);
  const skipped = await jev.askJev('bounded', { only: huge }, q, { protect: ['only'] });
  assert.equal(skipped.skipped, 'input-budget', 'oversize with nothing trimmable abstains');
});

test('an oversized judgment response is refused without buffering it, and cancels the stream', async () => {
  let cancelled = false;
  const oversized = () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: { getReader: () => {
      let sent = 0;
      return { read: async () => { sent += 65_536; return sent > 1_000_000 ? { done: true } : { done: false, value: new Uint8Array(65_536).fill(97) }; },
        cancel: async () => { cancelled = true; }, releaseLock() {} };
    } },
  });
  harness(async () => oversized());
  const result = await jev.askJev('unit', 'evidence for a hostile upstream', { ping: { type: 'noul', instructions: 'Affirmative?' } });
  assert.equal(result.ok, false, 'a response beyond the byte ceiling is not a judgment');
  assert.equal(cancelled, true, 'the unread remainder of the stream is cancelled');
});

test('a declared oversized content-length is rejected before any body is read', async () => {
  let read = false;
  harness(async () => ({ ok: true, status: 200, headers: { get: (name) => name === 'content-length' ? '99999999' : null },
    body: { getReader: () => { read = true; return { read: async () => ({ done: true }), cancel: async () => {}, releaseLock() {} }; }, cancel: async () => {} } }));
  const result = await jev.askJev('unit', 'another hostile payload', { ping: { type: 'noul', instructions: 'Affirmative?' } });
  assert.equal(result.ok, false);
  assert.equal(read, false);
});

test('every extension\'s copy of the client shares one cache, in-flight set and breaker', async () => {
  // The loader gives each extension its own module copy (moduleCache: false).
  const other = await import(`${pathToFileURL(path.join(agent, "extensions/lib/jev-client.ts")).href}?copy=second-extension`);
  assert.notEqual(other, jev, 'two module instances');
  let calls = 0;
  harness(async () => { calls++; return decisionsOk(); });
  const questions = { ping: { type: 'noul', instructions: 'Affirmative?' } };
  assert.equal((await jev.askJev('unit', 'shared evidence', questions)).ok, true);
  const again = await other.askJev('unit', 'shared evidence', questions);
  assert.equal(again.usage.cached, true, 'the second copy reuses the first copy\'s paid answer');
  assert.equal(calls, 1);
  other.resetJevClient();
  assert.equal((await jev.askJev('unit', 'shared evidence', questions)).usage.cached, false, 'a reset through any copy resets the one client');
  assert.equal(other.jevHealth().state, jev.jevHealth().state);
});
