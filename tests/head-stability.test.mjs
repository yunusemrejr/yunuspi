import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
 (p) => fs.existsSync(path.join(p, "extensions/art-direction.ts")),
);
const load = (file) => import(pathToFileURL(path.join(agent, file)));
const { resetStickyHead } = await load("extensions/lib/wire-warmth.ts");
const art = (await load("extensions/art-direction.ts")).default;

const model = { provider: "deepseek", id: "deepseek-flash", cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } };
const warmEntry = () => ({ type: "message", message: { role: "assistant", timestamp: Date.now() - 1000, usage: { input: 2000, cacheRead: 120000, cacheWrite: 0 } } });
const session = (id, entries = []) => ({ cwd: `/work/${id}`, model, sessionManager: { getSessionId: () => id, getBranch: () => entries }, hasUI: false, ui: {} });
const pi = () => {
 const handlers = {};
 return { handlers, registerTool() {}, appendEntry() {}, events: { on() {}, emit() {} }, on: (name, fn) => (handlers[name] = fn), registerCommand() {}, getActiveTools: () => [], setActiveTools() {} };
};
const UI_PROMPT = "Redesign the landing page UI of this website: improve the layout, typography and colors and make the hero section look polished and modern.";

test("the UI brief is added to a cold head once, keeps its exact bytes on later prompts, and never toggles", async () => {
 resetStickyHead();
 const host = pi();
 art(host);
 const ctx = session("cold");
 const first = host.handlers.before_agent_start({ prompt: UI_PROMPT, systemPrompt: "BASE" }, ctx);
 assert.match(first.systemPrompt, /^BASE\nUI work: inspect the existing product/);
 // The reason lapses (a non-UI follow-up) yet the head must not change: a toggled head re-bills the cached transcript.
 host.handlers.input({ source: "interactive", text: "Now fix the typo in the README" }, ctx);
 const later = host.handlers.before_agent_start({ prompt: "Fix the typo in the README", systemPrompt: "BASE" }, session("cold", [warmEntry()]));
 assert.equal(later?.systemPrompt, first.systemPrompt);
});

test("in a warm session the brief rides one persisted message and the cached head is left alone", async () => {
 resetStickyHead();
 const host = pi();
 art(host);
 const entries = [warmEntry()];
 const ctx = session("warm", entries);
 const first = host.handlers.before_agent_start({ prompt: UI_PROMPT, systemPrompt: "BASE" }, ctx);
 assert.equal(first.systemPrompt, undefined, "no system prompt rewrite on a warm cache");
 assert.equal(first.message.customType, "art-direction");
 assert.match(first.message.content, /^UI work: inspect the existing product/);
 assert.equal(first.message.display, false);
 // An aborted run never persisted the message, so the next prompt delivers it again.
 const retried = host.handlers.before_agent_start({ prompt: UI_PROMPT, systemPrompt: "BASE" }, ctx);
 assert.equal(retried.message.customType, "art-direction");
 // Once the message is part of the branch it is not sent twice.
 entries.push({ type: "custom_message", customType: "art-direction", content: first.message.content });
 assert.equal(host.handlers.before_agent_start({ prompt: UI_PROMPT, systemPrompt: "BASE" }, ctx), undefined);
});
