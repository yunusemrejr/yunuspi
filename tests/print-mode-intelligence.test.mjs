import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../core/coding-agent/src/core/sdk.js";
import { AgentSessionRuntime } from "../core/coding-agent/src/core/agent-session-runtime.js";
import { DefaultResourceLoader } from "../core/coding-agent/src/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/src/core/settings-manager.js";
import { runPrintMode } from "../core/coding-agent/src/modes/print-mode.js";
import { collectSessionCost } from "../core/coding-agent/src/core/session-accounting.js";

// Exercise actual print mode, SDK, AgentSession, extension delivery, and runtime
// disposal. Only the external provider transport is simulated.
async function fixture(t, { stopReason = "stop", history = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "print-intelligence-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [api => {
      api.registerCommand("fixture-compact", { handler: () => session.compact() });
      api.on("agent_end", () => api.sendMessage({ customType: "prompt-analysis", content: "Advisory analysis finished.",
        display: true, excludeFromContext: true }, { triggerTurn: false }));
      api.on("session_shutdown", () => {
        api.appendEntry("auxiliary-model-usage-v1", {
          id: "shutdown-spend", owner: "shutdown-fixture", provider: "audit", model: "print-fixture", status: "completed",
          usage: { costDetails: { reported: 0.03, estimated: 0, unknown: false, subscription: false, seen: true } },
        });
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = { id: "print-fixture", name: "Print fixture", api: "openai-completions", provider: "audit",
    baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
  const message = (text, reason = "stop") => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), content: [{ type: "text", text }], stopReason: reason,
    ...(reason === "error" || reason === "aborted" ? { errorMessage: `Synthetic provider ${reason}` } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  let requests = 0;
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
    streamSimple() {
      requests++;
      const answer = message("OK", stopReason);
      return { async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { ...answer, content: [] } };
        yield stopReason === "error" || stopReason === "aborted"
          ? { type: "error", reason: stopReason, error: answer } : { type: "done", reason: stopReason, message: answer };
      }, result: async () => answer };
    },
  };
  const sessionManager = SessionManager.inMemory(cwd);
  if (history) {
    sessionManager.appendMessage({ role: "user", content: "Previous task", timestamp: Date.now() });
    sessionManager.appendMessage(message("STALE ANSWER"));
  }
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
    resourceLoader: loader, sessionManager, tools: [], thinkingLevel: "off" });
  t.after(() => session.dispose());
  const runtime = new AgentSessionRuntime(session, { cwd }, async () => { throw new Error("Unexpected runtime replacement"); });
  return { runtime, session, requests: () => requests };
}

async function captureOutput(operation) {
  let stdout = "", stderr = "";
  const previousOut = process.stdout.write, previousErr = process.stderr.write;
  const writer = collect => (chunk, encoding, callback) => {
    collect(String(chunk));
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  };
  process.stdout.write = writer(value => { stdout += value; });
  process.stderr.write = writer(value => { stderr += value; });
  try { return { code: await operation(), stdout, stderr }; }
  finally { process.stdout.write = previousOut; process.stderr.write = previousErr; }
}

test("text print mode emits the final response despite a real post-turn intelligence marker", async t => {
  const f = await fixture(t);
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "text", initialMessage: "Reply exactly OK" }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "OK\n");
  assert.equal(f.session.state.messages.at(-1).customType, "prompt-analysis", "the regression exercises a trailing custom message");
  assert.equal(f.requests(), 1);
});

for (const stopReason of ["error", "aborted"]) test(`text print mode preserves ${stopReason} after a trailing intelligence marker`, async t => {
  const f = await fixture(t, { stopReason });
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "text", initialMessage: "Reply exactly OK" }));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`Synthetic provider ${stopReason}`));
  assert.equal(f.session.state.messages.at(-1).customType, "prompt-analysis");
});

test("control-only print invocation never reprints an assistant from saved history", async t => {
  const f = await fixture(t, { history: true });
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "text", initialMessage: "/guardian status" }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(f.requests(), 0);
  assert.equal(f.session.state.messages.at(-1).customType, "guardian_status");
});

test("a final control command cannot reuse an earlier response from this print invocation", async t => {
  const f = await fixture(t);
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "text", initialMessage: "Reply exactly OK", messages: ["/guardian status"] }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(f.requests(), 1);
});

test("JSON print mode retains both assistant and post-turn intelligence events", async t => {
  const f = await fixture(t);
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "json", initialMessage: "Reply exactly OK" }));
  assert.equal(result.code, 0);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  const assistantIndex = events.findIndex(event => event.type === "message_end" && event.message.role === "assistant");
  const markerIndex = events.findIndex(event => event.type === "message_end" && event.message.customType === "prompt-analysis");
  assert.ok(assistantIndex >= 0);
  assert.ok(markerIndex > assistantIndex);
  assert.equal(events[assistantIndex].message.content[0].text, "OK");
});

test("JSON print mode forwards persisted billing receipts from session shutdown", async t => {
  const f = await fixture(t);
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "json", initialMessage: "Reply exactly OK" }));
  assert.equal(result.code, 0);
  const receipts = f.session.sessionManager.getEntries().filter(entry => entry.customType === "auxiliary-model-usage-v1");
  assert.equal(receipts.length, 1);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === "entry_appended").map(event => event.entry), receipts);
  assert.ok(events.findIndex(event => event.type === "entry_appended") > events.findIndex(event => event.type === "agent_end"));
  assert.equal(events.find(event => event.type === "agent_start").settlementEvent, "print_settled");
  assert.deepEqual(events.at(-1), { type: "print_settled", exitCode: 0 });
});

test("JSON print mode exposes durable attempt receipts and a linked compaction checkpoint", async t => {
  const f = await fixture(t);
  await f.session.prompt("First short turn");
  await f.session.prompt("Second short turn");
  const result = await captureOutput(() => runPrintMode(f.runtime, { mode: "json", initialMessage: "/fixture-compact" }));
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  const receipts = events.filter(event => event.type === "entry_appended" && event.entry.accountingOnly).map(event => event.entry);
  const checkpoint = events.find(event => event.type === "compaction_end")?.result;
  assert.deepEqual(receipts.map(entry => entry.data.status), ["pending", "completed", "pending", "completed"]);
  assert.deepEqual(checkpoint.usage.summaryReceiptIds, receipts.filter(entry => entry.data.status === "completed").map(entry => entry.data.id));
  const entries = [...receipts, { type: "compaction", usage: checkpoint.usage }];
  assert.equal(collectSessionCost(entries).pending, 0);
});
