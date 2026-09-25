// Smol/Kompress expansion: line-calibrated retention, extended tools,
// windowed offers, mini warmup/timeout accounting, intent pre-screen.
// Loopback runtimes are mocked; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/smol-preprocessor.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const smol = await load("extensions/lib/smol-preprocessor.ts");
const ext = await load("extensions/lib/smol-extraction.ts");
const mini = await load("extensions/lib/mini-preprocessor.ts");
const intent = await load("extensions/lib/micro-intelligence/intent.ts");

const smolRuntime = {
  version: 2, enabled: true, model: "Qwen3.5-0.8B",
  endpoint: "http://127.0.0.1:18735/completion",
  apiKey: "TEST_SMOL_KEY_1234567890abcdef", execution: "background", timeoutMs: 2000,
};

const listing = (lines = 82, width = 42) => {
  const rows = ["header line for output"];
  for (let i = 0; i < lines - 2; i++) rows.push(`entry-${String(i).padStart(3, "0")}.log bytes=${10000 + i * 137}`.padEnd(width, "."));
  rows.push("listing complete");
  return rows.join("\n");
};

test("numeric listings are eligible (line-calibrated retention)", () => {
  const raw = listing();
  assert.ok(raw.length >= 3000 && raw.length <= 4096);
  assert.equal(smol.safeSmolOutput("bash", raw, false, undefined), true);
  // Extended line-oriented tools share the same safety gates.
  for (const tool of ["read", "grep", "find", "ls"]) {
    assert.equal(smol.safeSmolOutput(tool, raw, false, undefined), true, tool);
  }
  assert.equal(smol.safeSmolOutput("edit", raw, false, undefined), false);
  assert.equal(smol.safeSmolOutput("bash", raw, true, undefined), false);
});

test("retention deduplicates exact boilerplate and abstains on distinct protected facts", () => {
  const many = (n, reason) => Array.from({ length: n }, (_, i) => ({ id: i + 1, reason }));
  assert.deepEqual(smol.compressRequired([{ id: 1, reason: "boundary" }, { id: 9, reason: "boundary" }]), [1, 9]);
  const reps = smol.compressRequired([
    { id: 1, reason: "boundary" },
    ...many(20, "status").map((e, i) => ({ id: i + 2, reason: "status", text: "status: completed" })),
    { id: 99, reason: "boundary" },
  ]);
  assert.deepEqual(reps, [1, 2, 99]);
  assert.equal(smol.compressRequired(many(20, "status")), undefined);
  assert.equal(smol.compressRequired(many(11, "task")), undefined);
  assert.ok(smol.compressRequired([...many(10, "task"), { id: 50, reason: "boundary" }]).length <= 16);
});

test("safety exclusions survive the expansion", () => {
  const base = listing();
  assert.equal(smol.safeSmolOutput("bash", `${base}\nTraceback (most recent call last):`, false, undefined), false);
  assert.equal(smol.safeSmolOutput("bash", `${base}\n    at parse (src/parser.ts:41:10)`, false, undefined), false);
  // Status words in a successful result are retained by the host, not a reason to abstain.
  assert.equal(smol.safeSmolOutput("bash", `${base}\nwarning: 2 deprecated packages`, false, undefined), true);
  assert.equal(smol.safeSmolOutput("bash", `${base}\npassword: hunter2`, false, undefined), false);
  assert.equal(smol.safeSmolOutput("bash", base.slice(0, 2000), false, undefined), false);
});

test("direct offer selects lines from a numeric listing", async () => {
  const raw = listing();
  const lines = raw.split("\n").length;
  const sp = smol.createSmolPreprocessor({
    runtime: smolRuntime,
    acquireLease: async () => true,
    fetch: async () => new Response(JSON.stringify({ content: JSON.stringify({ status: "SELECT", lineIds: [1, 40, lines] }) })),
  });
  sp.offer("t1", raw, 0.5, "list entries", "bash");
  const taken = await sp.takeAsync("t1", raw, 2000);
  assert.ok(taken, "selection seals instead of abstaining");
  const parsed = JSON.parse(taken);
  assert.equal(parsed.totalLines, lines);
  assert.ok(parsed.omittedLines > 40);
  assert.deepEqual(parsed.lines.map((l) => l.id), [1, 40, lines]);
  assert.equal(sp.inspect().accepted, 1);
});

test("Smol UNKNOWN is a visible abstention while malformed selection is a failure", async () => {
  const activityKey = Symbol.for('yunus-pi.activity.v1'), healthKey = Symbol.for('yunus-pi.health.v1');
  const previousActivity = globalThis[activityKey], previousHealth = globalThis[healthKey];
  const outcomes = [], events = [];
  globalThis[activityKey] = () => outcome => outcomes.push(outcome);
  globalThis[healthKey] = (kind, data) => events.push({ kind, data });
  try {
    for (const content of ['{"status":"UNKNOWN","lineIds":[]}', '{"status":"SELECT","lineIds":[99999]}']) {
      const client = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => true,
        fetch: async () => new Response(JSON.stringify({ content })) });
      const raw = listing();
      client.offer('smoke', raw, 1);
      assert.equal(await client.takeAsync('smoke', raw, 2000), undefined, 'both outcomes retain the original source');
      client.reset();
    }
    assert.deepEqual(outcomes, ['skipped', 'error']);
    assert.deepEqual(events.filter(event => event.kind === 'ml.smol.inference').map(event => event.data.reason), ['unknown', 'invalid-line-ids']);
  } finally {
    if (previousActivity === undefined) delete globalThis[activityKey]; else globalThis[activityKey] = previousActivity;
    if (previousHealth === undefined) delete globalThis[healthKey]; else globalThis[healthKey] = previousHealth;
  }
});

test("tiny-model input is bounded, task-aware and deduplicates exact rows", () => {
  const raw = ["inventory begins", ...Array(35).fill("Background activity handles ordinary application housekeeping and general administration."), "Deployment remains pending verification."].join("\n");
  const source = ext.prepareSmolExtraction(raw, [1, 37]);
  const input = smol.smolModelInput(source, "investigate connection setup");
  assert.ok(Buffer.byteLength(input.prompt) <= 2048);
  assert.match(input.prompt, /Task: investigate connection setup/);
  assert.equal(input.prompt.match(/Background activity/g).length, 1);
  assert.ok(input.lineIds.has(2), "repeated rows use their first source ID");
  assert.ok(input.lineIds.has(37));
  for (const id of input.lineIds) assert.ok(input.prompt.includes(`${id}: ${source.lines[id - 1].text}`));
  const dense = smol.smolModelInput(ext.prepareSmolExtraction(listing()), "entry ".repeat(800));
  assert.ok(Buffer.byteLength(dense.prompt) <= 2048, "prompt budget includes task and framing");
  assert.ok(dense.lineIds.size < 82);
});

test("exact repeated task matches share a retention slot; distinct matches remain mandatory", () => {
  const repeated = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, reason: "task", text: "same task fact\n" }));
  assert.deepEqual(smol.compressRequired(repeated), [1]);
  assert.equal(smol.compressRequired(repeated.map((row, i) => ({ ...row, text: `task fact ${i}\n` }))), undefined);
});

test("the host orders valid model IDs but rejects duplicates and unoffered source IDs", async () => {
  const raw = listing();
  const source = ext.prepareSmolExtraction(raw, [1, 82]);
  const offered = smol.smolModelInput(source).lineIds;
  const omitted = source.lines.find(line => !offered.has(line.id)).id;
  for (const [ids, accepted] of [[[82, 1], true], [[1, 1], false], [[omitted], false]]) {
    const helper = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => true,
      fetch: async () => new Response(JSON.stringify({ content: JSON.stringify({ status: "SELECT", lineIds: ids }) })),
    });
    helper.offer("ordered", raw, 0);
    const selected = await helper.takeAsync("ordered", raw, 500);
    assert.equal(Boolean(selected), accepted, JSON.stringify(ids));
    if (selected) assert.deepEqual(JSON.parse(selected).lines.map(line => line.id), [1, 82]);
  }
  assert.equal(ext.validateSmolExtraction(source, '{"status":"SELECT","lineIds":[82,1]}').ok, false, "render-boundary validation still requires source order");
});

test("an unbounded wait cannot stall context rendering or rewrite its first exposure", async () => {
  const raw = listing();
  let finish;
  const helper = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => true,
    fetch: () => new Promise(resolve => { finish = resolve; }),
  });
  helper.offer("wait", raw, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await helper.takeAsync("wait", raw, Infinity), undefined);
  finish(new Response(JSON.stringify({ content: '{"status":"SELECT","lineIds":[1]}' })));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(helper.take("wait", raw), undefined, "late results cannot replace a raw seal");
  assert.equal(helper.inspect().cached, 1);
});

test("windowed offers cover oversized output with original line numbers", () => {
  const big = Array(400).fill("x".repeat(60)).join("\n");
  const window = ext.prepareSmolWindow(big);
  assert.ok(window, "window builds");
  assert.equal(window.totalLines, 400);
  assert.ok(Buffer.byteLength(window.text, "utf8") <= 4096);
  assert.ok(window.lineMap.length > 10);
  assert.ok(window.lineMap[0] === 1, "head preserved");
  assert.ok(window.lineMap[window.lineMap.length - 1] > 300, "tail preserved");
  // Small input needs no window; huge input abstains.
  assert.equal(ext.prepareSmolWindow("short"), undefined);
  assert.equal(ext.prepareSmolWindow("x".repeat(40000)), undefined);
  assert.equal(ext.prepareSmolWindow("has\0nul"), undefined);
});

test("windowed take remaps to original lines and revalidates", async () => {
  const rows = ["first line of the build output"];
  for (let i = 0; i < 300; i++) rows.push(`Background compilation activity ${".".repeat(20)}`);
  rows.push("last line of the build output");
  const big = rows.join("\n");
  assert.ok(big.length > 4096 && big.length < 32768);
  const sp = smol.createSmolPreprocessor({
    runtime: smolRuntime,
    acquireLease: async () => true,
    fetch: async () => new Response(JSON.stringify({ content: JSON.stringify({ status: "SELECT", lineIds: [1, 2] }) })),
  });
  // Narrow task: a task matching every line correctly abstains instead.
  sp.offerWindowed("w1", big, 0.5, "summarize output", "bash");
  assert.equal(sp.inspect().windowed, 1);
  const taken = await sp.takeWindowed("w1", 2000);
  assert.ok(taken, "windowed selection renders");
  const parsed = JSON.parse(taken);
  assert.equal(parsed.windowed, true);
  assert.equal(parsed.totalLines, rows.length);
  assert.equal(parsed.lines[0].line, 1);
  assert.ok(parsed.lines[1].line > 1);
  // Unknown keys and double takes stay safe.
  assert.equal(await sp.takeWindowed("missing", 10), undefined);
});

test("window slots keep serving across turns and failed offers consume no capacity", async () => {
  const raw = ["first line of the build output", ...Array(300).fill("Background compilation activity ...................."), "last line of the build output"].join("\n");
  let calls = 0;
  const helper = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => true,
    fetch: async () => { calls++; return new Response(JSON.stringify({ content: '{"status":"SELECT","lineIds":[1]}' })); },
  });
  for (let index = 0; index < 40; index++) {
    helper.offerWindowed(`window-${index}`, raw, 0, "summarize output");
    assert.ok(await helper.takeWindowed(`window-${index}`, 500), `observation ${index} retains a usable window`);
    helper.endTurn();
    assert.ok(helper.inspect().windowedSlots <= 32, "turn cleanup bounds retained windows");
  }
  assert.equal(calls, 1, "identical evidence reuses the validated cache");
  const before = helper.inspect().windowedSlots;
  helper.offerWindowed("cooldown", raw.replace("first line", "opening line"), 0, "summarize output");
  assert.equal(helper.inspect().windowedSlots, before, "a cooldown refusal allocates no window");
});

test("windowed selection preserves raw output when its task-scoring budget is exceeded", async () => {
  const rows = Array(1050).fill("background foliage grows green");
  rows[524] = "quartz target lives amid foliage";
  const raw = rows.join("\n");
  assert.ok(raw.length < 32768);
  let calls = 0;
  const helper = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => true,
    fetch: async () => { calls++; return new Response(JSON.stringify({ content: '{"status":"SELECT","lineIds":[1]}' })); },
  });
  helper.offerWindowed("dense", raw, 0, "quartz");
  assert.equal(await helper.takeWindowed("dense", 500), undefined, "an unscored middle match cannot be omitted");
  assert.equal(calls, 0, "a retention budget failure spends no inference");
});

test("windowed render rejects mismatched sources and ids", () => {
  const big = Array(200).fill("y".repeat(60)).join("\n");
  const window = ext.prepareSmolWindow(big);
  const source = ext.prepareSmolExtraction(window.text);
  const other = ext.prepareSmolExtraction(listing());
  assert.equal(ext.renderSmolWindow(window, other, { ok: true, lineIds: [1] }), undefined);
  assert.equal(ext.renderSmolWindow(window, source, { ok: false, reason: "x" }), undefined);
  assert.equal(ext.renderSmolWindow(window, source, { ok: true, lineIds: [99999] }), undefined);
  const rendered = ext.renderSmolWindow(window, source, { ok: true, lineIds: [1, 2] });
  assert.ok(rendered && JSON.parse(rendered).windowed === true);
});

test("lease contention is visible instead of silent", async () => {
  const seen = [];
  const prior = globalThis[Symbol.for("yunus-pi.health.v1")];
  globalThis[Symbol.for("yunus-pi.health.v1")] = (kind, data) => seen.push([kind, data]);
  try {
    const sp = smol.createSmolPreprocessor({ runtime: smolRuntime, acquireLease: async () => false });
    sp.offer("t1", listing(), 0.5, "list", "bash");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.some(([kind, data]) => kind === "ml.smol.offer" && data.decision === "no-lease"));
  } finally {
    if (prior === undefined) delete globalThis[Symbol.for("yunus-pi.health.v1")];
    else globalThis[Symbol.for("yunus-pi.health.v1")] = prior;
  }
});

const miniRuntime = {
  version: 1, enabled: true,
  endpoint: "http://127.0.0.1:18736/select",
  apiKey: "TEST_MINI_PREPROCESSOR_KEY_1234567890",
};
const filler = "General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.";
const fact = "The current status remains blocked until verification confirms the deployment result.";

test("mini clients leave service warmup and its shared rate slot alone", async () => {
  let calls = 0;
  const c = mini.createMiniPreprocessor({runtime: miniRuntime,fetch: async () => { calls++; return new Response('{"version":1,"status":"UNKNOWN"}'); }});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);
  const raw=[fact,...Array(9).fill(filler)].join('\n\n');
  assert.equal(await c.select(raw,10,'verification status'),undefined);
  assert.equal(calls,1);
  assert.equal(c.inspect().timeouts,0);
  assert.ok(c.inspect().cooldownMs<=10000,'valid refusal retains the normal cooldown');
  c.reset();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1,'a session reset cannot trigger another warmup');
});

test("mini timeouts are counted apart from refusals", async () => {
  const raw = [fact, ...Array(9).fill(filler)].join("\n\n");
  const slow = mini.createMiniPreprocessor({
    runtime: miniRuntime,
    // Settles long after the 450ms budget: the abort path fires first.
    // (A never-settling mock would drain the test loop; production is
    // always held by the session.)
    fetch: () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), 2000)),
  });
  const selection = await slow.select(raw, 10, "verification status");
  assert.equal(selection, undefined);
  assert.equal(slow.inspect().timeouts, 1);
  assert.equal(slow.inspect().fallbacks, 1);
});

test("intent pre-screen defers safely without helpers", async () => {
  // Hermetic: the live checkout may sit beside installed Needle assets or an
  // OpenRouter key, either of which would legitimately resolve the screen.
  // Force both helpers off so "without helpers" holds in every environment.
  const runtime = await load("extensions/lib/needle-runtime.ts");
  const saved = {
    needle: process.env.PI_NEEDLE,
    jev: process.env.PI_JEV,
    screen: process.env.PI_INTENT_PRESCREEN,
  };
  process.env.PI_NEEDLE = "off";
  process.env.PI_JEV = "off";
  delete process.env.PI_INTENT_PRESCREEN;
  runtime.resetNeedleForTests();
  try {
    assert.equal(await intent.cheapMutationScreen("x"), "defer");
    assert.equal(await intent.cheapMutationScreen("review the authentication module for logic errors"), "defer");
    assert.equal(await intent.cheapMutationScreen("x".repeat(9000)), "defer");
    process.env.PI_INTENT_PRESCREEN = "off";
    assert.equal(await intent.cheapMutationScreen("review the authentication module for logic errors"), "defer");
  } finally {
    if (saved.needle === undefined) delete process.env.PI_NEEDLE; else process.env.PI_NEEDLE = saved.needle;
    if (saved.jev === undefined) delete process.env.PI_JEV; else process.env.PI_JEV = saved.jev;
    if (saved.screen === undefined) delete process.env.PI_INTENT_PRESCREEN; else process.env.PI_INTENT_PRESCREEN = saved.screen;
    runtime.resetNeedleForTests();
  }
});

test("screen-then-fallback stands on verdicts and survives screen faults", async () => {
  let fallbacks = 0;
  const fallback = async () => { fallbacks++; return "implementation"; };
  assert.deepEqual(await intent.resolveWithScreen(async () => "read-only", fallback), { verdict: "read-only", screened: true });
  assert.equal(fallbacks, 0);
  assert.deepEqual(await intent.resolveWithScreen(async () => "defer", fallback), { verdict: "implementation", screened: false });
  assert.equal(fallbacks, 1);
  assert.deepEqual(await intent.resolveWithScreen(async () => { throw new Error("boom"); }, fallback), { verdict: "implementation", screened: false });
  assert.equal(fallbacks, 2);
});
