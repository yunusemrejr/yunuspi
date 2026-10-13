// Kompress (mini) warmup and timeout accounting, and the intent pre-screen fallback.
// Loopback runtimes are mocked; no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/mini-preprocessor.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const mini = await load("extensions/lib/mini-preprocessor.ts");
const intent = await load("extensions/lib/micro-intelligence/intent.ts");

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
