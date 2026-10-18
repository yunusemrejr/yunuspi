import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
 (p) => fs.existsSync(path.join(p, "extensions/lib/wire-warmth.ts")),
);
const { wireWarmth, lastRequestPrefix, stickyHeadText, resetStickyHead, branchHasMessage, WIRE_BUST_BUDGET_USD } = await import(
 pathToFileURL(path.join(agent, "extensions/lib/wire-warmth.ts"))
);
const deepseek = { provider: "deepseek", id: "deepseek-flash", cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } };
const turn = (tokens, at, extra = {}) => ({ type: "message", message: { role: "assistant", timestamp: at, usage: { input: tokens, cacheRead: 0, cacheWrite: 0, ...extra } } });
const ctxOf = (entries, model = deepseek, id = "s1") => ({ cwd: "/w", model, sessionManager: { getSessionId: () => id, getBranch: () => entries } });
const NOW = 1_800_000_000_000;

test("the newest assistant request with usage sets the prefix size and time", () => {
 assert.equal(lastRequestPrefix([]), undefined);
 assert.equal(lastRequestPrefix(undefined), undefined);
 const entries = [turn(5000, NOW - 9000), { type: "message", message: { role: "toolResult" } }, turn(0, NOW - 100), turn(20000, NOW - 4000, { cacheRead: 80000 })];
 const found = lastRequestPrefix(entries);
 assert.deepEqual({ tokens: found.tokens, at: found.at }, { tokens: 100000, at: NOW - 4000 }, "input + cacheRead + cacheWrite of the newest billed turn");
 const aborted = [turn(40000, NOW - 5000), { type: "message", message: { role: "assistant", timestamp: NOW - 10, usage: { input: 0, cacheRead: 0 } } }];
 assert.equal(lastRequestPrefix(aborted).tokens, 40000, "a turn that billed nothing is skipped");
});

test("a large recent prefix on a cache-priced route is warm; a small, idle or free one is not", () => {
 assert.equal(wireWarmth(ctxOf([turn(100_000, NOW - 5000)]), NOW).warm, true);
 assert.equal(wireWarmth(ctxOf([turn(100_000, NOW - 5000)]), NOW).bustUsd > WIRE_BUST_BUDGET_USD, true);
 assert.equal(wireWarmth(ctxOf([turn(8_000, NOW - 5000)]), NOW).warm, false, "8k tokens cost ~0.2 cent to rebuild: change freely");
 assert.equal(wireWarmth(ctxOf([turn(100_000, NOW - 2 * 3600_000)]), NOW).warm, false, "past the one-hour DeepSeek TTL the cache is cold");
 assert.equal(wireWarmth(ctxOf([turn(100_000, NOW - 5000)], { ...deepseek, cost: { input: 0, cacheRead: 0 } }), NOW).warm, false, "a free route has nothing to protect");
 assert.equal(wireWarmth(ctxOf([]), NOW).warm, false);
 assert.equal(wireWarmth(undefined, NOW).warm, false);
});

test("the cache window follows the route: five minutes on Anthropic, an hour on DeepSeek", () => {
 const claude = { provider: "anthropic", id: "claude-x", cost: { input: 3, cacheRead: 0.3 } };
 assert.equal(wireWarmth(ctxOf([turn(50_000, NOW - 120_000)], claude), NOW).warm, true);
 assert.equal(wireWarmth(ctxOf([turn(50_000, NOW - 400_000)], claude), NOW).warm, false);
 assert.equal(wireWarmth(ctxOf([turn(50_000, NOW - 400_000)]), NOW).warm, true);
});

test("an unpriced route is judged by tokens", () => {
 const unknown = { provider: "custom", id: "x" };
 assert.equal(wireWarmth(ctxOf([turn(30_000, NOW - 1000)], unknown), NOW).warm, true);
 assert.equal(wireWarmth(ctxOf([turn(4_000, NOW - 1000)], unknown), NOW).warm, false);
});

test("sticky head text latches on a cold session, is refused on first appearance when warm, and never toggles", () => {
 resetStickyHead();
 const cold = ctxOf([], deepseek, "cold");
 assert.equal(stickyHeadText(cold, "k", undefined), undefined, "peek without a latch");
 assert.equal(stickyHeadText(cold, "k", "GUIDE"), "GUIDE", "cold session may add it");
 const warmEntries = [turn(100_000, Date.now() - 1000)];
 const nowWarm = ctxOf(warmEntries, deepseek, "cold");
 assert.equal(stickyHeadText(nowWarm, "k", "DIFFERENT"), "GUIDE", "the same bytes on every later prompt");
 assert.equal(stickyHeadText(nowWarm, "k", undefined), "GUIDE", "even when the reason lapsed");
 const fresh = ctxOf(warmEntries, deepseek, "warm-first");
 assert.equal(stickyHeadText(fresh, "k", "GUIDE"), undefined, "a first appearance would rebuild the cached head");
 assert.equal(stickyHeadText(fresh, "k", undefined), undefined, "and nothing is latched by the refusal");
 assert.equal(stickyHeadText(ctxOf([], deepseek, "other"), "k", "GUIDE"), "GUIDE", "latches are per session");
});

test("a route switch starts cold: the new route has no cache to protect", () => {
 const entry = { type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-flash", timestamp: NOW - 2000, usage: { input: 100_000, cacheRead: 0, cacheWrite: 0 } } };
 assert.equal(wireWarmth(ctxOf([entry]), NOW).warm, true);
 assert.equal(wireWarmth(ctxOf([entry], { ...deepseek, id: "deepseek-v4-pro" }), NOW).warm, false, "another model on the same provider");
 assert.equal(wireWarmth(ctxOf([entry], { ...deepseek, provider: "openrouter" }), NOW).warm, false, "another provider");
});

test("a latched head survives a restart because the session carries it, and a latch read keeps it from eviction", () => {
 resetStickyHead();
 const written = [];
 const entries = [turn(100_000, Date.now() - 1000)];
 const ctx = { ...ctxOf(entries, deepseek, "persist"), sessionManager: { getSessionId: () => "persist", getBranch: () => entries, appendCustomEntry: (type, data) => { written.push({ type, data }); entries.push({ type: "custom", customType: type, data }); } } };
 const cold = ctxOf([], deepseek, "persist");
 const coldWithWriter = { ...cold, sessionManager: { ...cold.sessionManager, appendCustomEntry: (type, data) => { written.push({ type, data }); entries.push({ type: "custom", customType: type, data }); } } };
 assert.equal(stickyHeadText(coldWithWriter, "k", "GUIDE"), "GUIDE");
 assert.deepEqual(written, [{ type: "head-latch-v1", data: { key: "k", text: "GUIDE" } }], "the latch is written to the session once");
 resetStickyHead(); // a new process: nothing in memory
 assert.equal(stickyHeadText(ctx, "k", "RECOMPUTED"), "GUIDE", "the warm resumed session finds the exact bytes it already carried");
 assert.equal(written.length, 1, "reading a latch writes nothing");
 resetStickyHead();
 for (let i = 0; i < 70; i++) stickyHeadText(ctxOf([], deepseek, `filler-${i}`), "k", "X");
 assert.equal(stickyHeadText(ctx, "k", undefined), "GUIDE", "eviction from memory never loses what the session recorded");
});

test("a hidden message is delivered once per branch", () => {
 const msg = { type: "custom_message", customType: "art-direction", content: "brief" };
 assert.equal(branchHasMessage(ctxOf([turn(10, NOW)]), "art-direction"), false);
 assert.equal(branchHasMessage(ctxOf([turn(10, NOW), msg]), "art-direction"), true);
 assert.equal(branchHasMessage(ctxOf([msg]), "other"), false);
 assert.equal(branchHasMessage(undefined, "art-direction"), false);
});
