import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
 (p) => fs.existsSync(path.join(p, "extensions/lib/cache-sentinel.ts")),
);
const { createCacheSentinel, describeCacheMisses, fingerprintPayload } = await import(
 pathToFileURL(path.join(agent, "extensions/lib/cache-sentinel.ts"))
);
const tool = (name) => ({ type: "function", function: { name, parameters: { type: "object" } } });
const sys = { role: "system", content: "You are an agent." };
const turn = (n) => [{ role: "user", content: `task ${n}` }, { role: "assistant", content: `step ${n}` }, { role: "tool", content: `result ${n}` }];
const body = (tools, ...parts) => ({ model: "m", tools, messages: [sys, ...parts.flat()] });
const usage = (prompt, cached) => ({ input: prompt - cached, cacheRead: cached, cacheWrite: 0 });
const PREMIUM = 0.294;

function run(steps) {
 const sentinel = createCacheSentinel();
 const misses = [];
 for (const [payload, tokens, cached, route = "deepseek/flash", at = 0] of steps) {
  sentinel.request(payload, route, at);
  misses.push(sentinel.response(usage(tokens, cached), PREMIUM, at));
 }
 return { sentinel, misses };
}

test("an append-only request served from cache is not a miss", () => {
 const tools = [tool("read"), tool("bash")];
 const { misses, sentinel } = run([[body(tools, turn(1)), 20000, 0], [body(tools, turn(1), turn(2)), 24000, 19968], [body(tools, turn(1), turn(2), turn(3)), 28000, 23936]]);
 assert.deepEqual(misses, [undefined, undefined, undefined]);
 assert.equal(sentinel.summary().misses, 0);
});

test("a tool-set change that collapses the cache is attributed to tools, with the changed names", () => {
 const { misses } = run([[body([tool("read")], turn(1)), 30000, 0], [body([tool("read"), tool("web_search")], turn(1), turn(2)), 33000, 1280]]);
 assert.equal(misses[1].cause, "tools");
 assert.deepEqual(misses[1].toolsChanged, ["web_search"]);
 assert.equal(misses[1].rebilledTokens, 30000 - 1280);
 assert.ok(Math.abs(misses[1].usd - (28720 * PREMIUM) / 1e6) < 1e-9);
});

test("a changed system message is a system miss, a rewritten earlier message is a history miss at its index", () => {
 const tools = [tool("read")];
 const a = run([[body(tools, turn(1), turn(2)), 40000, 0], [{ ...body(tools, turn(1), turn(2), turn(3)), messages: [{ role: "system", content: "You are an agent. New rule." }, ...turn(1), ...turn(2), ...turn(3)] }, 44000, 1000]]);
 assert.equal(a.misses[1].cause, "system");
 const edited = [{ role: "user", content: "task 1 (rewritten)" }, ...turn(1).slice(1)];
 const b = run([[body(tools, turn(1), turn(2)), 40000, 0], [body(tools, edited, turn(2), turn(3)), 44000, 1000]]);
 assert.equal(b.misses[1].cause, "history");
 assert.equal(b.misses[1].atMessage, 1, "index of the first message that differs from the previous request");
});

test("a miss with an unchanged prefix belongs to the route: idle gap, route change or the provider", () => {
 const tools = [tool("read")];
 const same = (n) => body(tools, turn(1), turn(2).slice(0, n));
 assert.equal(run([[same(3), 30000, 0], [{ ...same(3), messages: [...same(3).messages, { role: "user", content: "more" }] }, 31000, 500]]).misses[1].cause, "provider");
 assert.equal(run([[same(3), 30000, 0, "deepseek/flash", 0], [{ ...same(3), messages: [...same(3).messages, { role: "user", content: "more" }] }, 31000, 500, "deepseek/flash", 2 * 3600_000]]).misses[1].cause, "idle");
 assert.equal(run([[same(3), 30000, 0, "deepseek/flash"], [{ ...same(3), messages: [...same(3).messages, { role: "user", content: "more" }] }, 31000, 500, "openrouter/qwen"]]).misses[1].cause, "route");
});

test("small prefixes and failed requests do not create misses or erase the baseline", () => {
 const tools = [tool("read")];
 const small = run([[body(tools, turn(1)), 2000, 0], [body([tool("read"), tool("bash")], turn(1), turn(2)), 2500, 0]]);
 assert.equal(small.misses[1], undefined, "a 2k-token re-bill costs nothing worth naming");
 const sentinel = createCacheSentinel();
 sentinel.request(body(tools, turn(1)), "r", 0); sentinel.response(usage(30000, 0), PREMIUM, 0);
 sentinel.request(body(tools, turn(1), turn(2)), "r", 1); assert.equal(sentinel.response({ input: 0, cacheRead: 0 }, PREMIUM, 1), undefined, "an errored request bills nothing");
 sentinel.request(body([tool("read"), tool("bash")], turn(1), turn(2), turn(3)), "r", 2);
 assert.equal(sentinel.response(usage(33000, 500), PREMIUM, 2).cause, "tools", "the 30k baseline survived the failed request");
});

test("payload shapes without a message list are ignored and the summary is readable", () => {
 assert.equal(fingerprintPayload(undefined), undefined);
 assert.equal(fingerprintPayload({ prompt: "x" }), undefined);
 const sentinel = createCacheSentinel();
 sentinel.request({ nothing: true }, "r"); assert.equal(sentinel.response(usage(9000, 0), PREMIUM), undefined);
 const { sentinel: s } = run([[body([tool("a")], turn(1)), 30000, 0], [body([tool("a"), tool("b")], turn(1), turn(2)), 33000, 0]]);
 const text = describeCacheMisses(s.summary(), (n) => `${Math.round(n / 1000)}k`, (n) => `$${n.toFixed(3)}`);
 assert.match(text, /1 of 2 request\(s\) re-billed 30k tokens/);
 assert.match(text, /tools 1/);
 assert.equal(describeCacheMisses(createCacheSentinel().summary(), String, String), "Cache misses: none in 0 request(s)");
});

test("a schema-only tool edit is a tools miss without invented names, a top-level system change is a system miss", () => {
 const withSchema = (extra) => [{ type: "function", function: { name: "read", parameters: { type: "object", properties: extra } } }];
 const a = run([[body(withSchema({}), turn(1)), 30000, 0], [body(withSchema({ path: { type: "string" } }), turn(1), turn(2)), 33000, 500]]);
 assert.equal(a.misses[1].cause, "tools");
 assert.equal(a.misses[1].toolsChanged, undefined, "same names, so none are claimed");
 const anthropic = (system) => ({ model: "m", system, tools: [tool("read")], messages: [...turn(1)] });
 const b = run([[anthropic("one"), 30000, 0], [{ ...anthropic("two"), messages: [...turn(1), ...turn(2)] }, 33000, 500]]);
 assert.equal(b.misses[1].cause, "system");
});

test("Gemini-style grouped declarations are named one by one", () => {
 const gem = (...names) => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: names.map((name) => ({ name })) }] });
 const fp = fingerprintPayload(gem("a", "b"));
 assert.deepEqual(fp.toolNames, ["a", "b"]);
 const sentinel = createCacheSentinel();
 sentinel.request(gem("a"), "g", 0); sentinel.response(usage(30000, 0), PREMIUM, 0);
 sentinel.request({ ...gem("a", "b"), contents: [...gem("a").contents, { role: "model", parts: [{ text: "x" }] }] }, "g", 1);
 assert.deepEqual(sentinel.response(usage(33000, 500), PREMIUM, 1).toolsChanged, ["b"]);
});

test("the idle gap follows the route cache lifetime, and a provider that reports no cache fields never produces misses", () => {
 const tools = [tool("read")];
 const next = { ...body(tools, turn(1), turn(2)) };
 const prev = body(tools, turn(1));
 const sentinel = createCacheSentinel();
 sentinel.request(prev, "anthropic/x", 0, 300_000); sentinel.response(usage(30000, 0), PREMIUM, 0);
 sentinel.request(next, "anthropic/x", 600_000, 300_000);
 assert.equal(sentinel.response(usage(33000, 500), PREMIUM, 600_000).cause, "idle", "ten minutes is past a five-minute cache");
 const unreported = createCacheSentinel();
 unreported.request(prev, "r", 0); unreported.response(usage(30000, 0), PREMIUM, 0, false);
 unreported.request(next, "r", 1_000);
 assert.equal(unreported.response(usage(33000, 0), PREMIUM, 1_000, false), undefined, "cacheRead 0 on every request is a missing field, not a miss");
 assert.equal(unreported.summary().misses, 0);
});
