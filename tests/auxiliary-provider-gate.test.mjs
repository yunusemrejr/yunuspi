import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AssistantMessageEventStream } from "@yunuspi/ai";
import { ModelRuntime } from "../core/coding-agent/src/core/model-runtime.js";
import { DefaultResourceLoader } from "../core/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../core/coding-agent/src/core/sdk.js";
import { SessionManager } from "../core/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/src/core/settings-manager.js";
import registerGate from "../agent/extensions/provider-gate.ts";
import * as health from "../agent/extensions/pi-subagents/src/runs/shared/provider-health.ts";

const model = {
  provider: "openrouter", id: "fixture", api: "openai-completions", name: "Synthetic fixture",
  baseUrl: "https://openrouter.ai/api/v1", input: ["text"], reasoning: false,
  contextWindow: 65_536, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0.00001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000012 } };
const context = text => ({ messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] });

async function fixture(t, dispatch = async () => undefined, sharedRuntime) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-aux-gate-"));
  if (!sharedRuntime) process.env.PI_PROVIDER_STATE_FILE = path.join(cwd, "health.json");
  delete process.env.PI_PROVIDER_GATE;
  process.env.PI_PROVIDER_GATE_MAX_WAIT_MS = "5000";
  const attempts = [], outcomes = [];
  let main = 0, transcript = 0;
  const runtime = sharedRuntime ?? await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const stream = (selected, input, options) => {
    const result = new AssistantMessageEventStream();
    const response = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
      content: [], timestamp: Date.now(), usage, stopReason: "stop" };
    void (async () => {
      try {
        const outgoing = await options?.onPayload?.({ model: selected.id, messages: input.messages }, selected);
        options?.signal?.throwIfAborted();
        const errorMessage = await dispatch(input, outgoing);
        if (errorMessage) throw new Error(errorMessage);
        response.content = [{ type: "text", text: "Synthetic provider result" }];
        result.push({ type: "done", reason: "stop", message: response });
      } catch (error) {
        response.stopReason = options?.signal?.aborted ? "aborted" : "error";
        response.errorMessage = error.message;
        result.push({ type: "error", reason: response.stopReason, error: response });
      }
    })();
    return result;
  };
  if (!sharedRuntime) {
    runtime.registerNativeProvider({
      id: model.provider, name: model.name, getModels: () => [model],
      auth: { apiKey: { name: "Fixture", resolve: async () => ({ source: "fixture", auth: { apiKey: "synthetic-token" } }) } },
      stream, streamSimple: stream,
    });
    await runtime.refresh({ allowNetwork: false });
  }
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on("before_provider_request", () => { main++; });
      registerGate(pi);
      pi.on("before_auxiliary_provider_request", ({ purpose }) => {
        attempts.push(purpose);
        return response => { outcomes.push({ purpose, stopReason: response.stopReason }); };
      });
      pi.on("message_end", ({ message }) => { if (message.role === "assistant") transcript++; });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model,
    sessionManager: SessionManager.inMemory(cwd), noTools: "all",
  });
  t.after(() => { session.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { session, runtime, registry: session.extensionRunner.createContext().modelRegistry, attempts, outcomes,
    mainCalls: () => main, transcriptMessages: () => transcript };
}

const pin = endpoint => ({ onPayload: payload => ({ ...payload, provider: { only: [endpoint], allow_fallbacks: false } }) });

test("auxiliary runtime outcomes retain their own route and leave main transforms and usage samples alone", { timeout: 10_000 }, async t => {
  let release;
  let admitted;
  const hold = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { admitted = resolve; });
  const main = await fixture(t, async (input, outgoing) => {
    const text = input.messages.at(-1)?.content?.[0]?.text;
    if (text === "hold alpha") { admitted(); await hold; }
    if (text === "fail beta") return "HTTP 502 Bad Gateway";
    assert.ok(!outgoing.provider || outgoing.provider.allow_fallbacks === false);
  });
  const sibling = await fixture(t, undefined, main.runtime);

  await main.session.prompt("main turn");
  const original = health.readHealth().providers.openrouter.models.fixture.economyUsage;
  assert.equal(original.length, 1);
  await main.registry.complete(model, context("simple auxiliary"), pin("alpha"));
  assert.deepEqual(health.readHealth().providers.openrouter.models.fixture.economyUsage, original);

  const alpha = main.registry.completeSimple(model, context("hold alpha"), pin("alpha"));
  await entered;
  try {
    const beta = await sibling.registry.complete(model, context("fail beta"), pin("beta"));
    assert.equal(beta.stopReason, "error");
  } finally {
    release();
  }
  assert.equal((await alpha).stopReason, "stop");
  const state = health.readHealth().providers.openrouter;
  assert.equal(state.requests.length, 4);
  assert.equal(state.models[health.endpointHealthKey(model.id, "beta")].failure.source, "auxiliary");
  assert.equal(state.models[health.endpointHealthKey(model.id, "beta")].failure.consecutive, 1);
  assert.equal(state.models[health.endpointHealthKey(model.id, "alpha")].failure, undefined);
  assert.equal(main.mainCalls(), 1);
  assert.equal(main.transcriptMessages(), 1);
  assert.equal(sibling.mainCalls(), 0);
  assert.equal(sibling.transcriptMessages(), 0);
  assert.equal(main.outcomes.length, 2);
  assert.equal(sibling.outcomes.length, 1);
});

test("an older auxiliary success cannot clear a newer failure and a cancelled hold never dispatches", { timeout: 10_000 }, async t => {
  let release;
  let admitted;
  const hold = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { admitted = resolve; });
  let dispatches = 0;
  const f = await fixture(t, async input => {
    dispatches++;
    const text = input.messages[0]?.content?.[0]?.text;
    if (text === "older request") { admitted(); await hold; }
    if (text === "rate limited") return "429 too many requests; Retry-After: 4";
  });
  const older = f.registry.completeSimple(model, context("older request"));
  await entered;
  try {
    const limited = await f.registry.completeSimple(model, context("rate limited"));
    assert.equal(limited.stopReason, "error");
  } finally {
    release();
  }
  assert.equal((await older).stopReason, "stop");
  assert.equal(health.evaluateRoute({ provider: model.provider, model: model.id }).allowed, false);

  const controller = new AbortController();
  const waiting = f.registry.completeSimple(model, context("waiting request"), { signal: controller.signal });
  for (let i = 0; i < 100 && health.readHealth().pending.length === 0; i++) await delay(10);
  assert.equal(health.readHealth().pending.length, 1);
  controller.abort();
  assert.equal((await waiting).stopReason, "aborted");
  for (let i = 0; i < 100 && health.readHealth().pending.length > 0; i++) await delay(10);
  assert.equal(health.readHealth().pending.length, 0);
  assert.equal(dispatches, 2);
  assert.equal(f.outcomes.length, 2);
  assert.equal(health.readHealth().providers.openrouter.failure.consecutive, 1);
});

test("Anthropic keeps its served model in the response and records health on the admitted alias", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const requested = {
    ...model, provider: "anthropic", api: "anthropic-messages",
    id: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com",
  };
  const served = "claude-sonnet-4-6-20261001";
  const start = {
    type: "message_start",
    message: { role: "assistant", id: "synthetic-message", model: served, usage: { input_tokens: 10, output_tokens: 0 } },
  };
  const send = async (events) => f.registry.completeSimple(requested, context("synthetic prompt"), {
    apiKey: "synthetic-anthropic",
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, "https://api.anthropic.com");
      assert.equal(JSON.parse(init.body).model, requested.id);
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    },
  });
  const success = await send([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Synthetic answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
  assert.equal(success.stopReason, "stop", success.errorMessage);
  assert.equal(success.model, served);
  const initialHealth = health.readHealth().providers.anthropic;
  assert.ok(initialHealth.models[requested.id]);
  assert.equal(initialHealth.lastResult.ok, true);
  assert.equal(initialHealth.models[served], undefined);

  const failure = await send([start, { type: "error", error: { type: "overloaded_error", message: "provider overloaded" } }]);
  assert.equal(failure.stopReason, "error");
  assert.equal(failure.model, served);
  const cooling = health.readHealth().providers.anthropic;
  assert.equal(cooling.models[requested.id].failure.source, "auxiliary");
  assert.equal(cooling.models[requested.id].failure.consecutive, 1);
  assert.equal(cooling.models[served], undefined);
});

test("manual compaction and branch summarization use auxiliary admission without main hooks", { timeout: 10_000 }, async t => {
  let failNextSummary = false;
  let retrySawFailure = false;
  const f = await fixture(t, async () => {
    if (failNextSummary) {
      failNextSummary = false;
      return "502 Bad Gateway; Retry-After: 0";
    }
    retrySawFailure ||= health.readHealth().providers.openrouter?.models.fixture?.failure?.source === "auxiliary";
  });
  await f.session.prompt("Keep the first constraint.");
  await f.session.prompt("The second constraint changed.");
  const firstUser = f.session.sessionManager.getBranch().find(entry => entry.message?.role === "user").id;
  f.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 2 } });
  failNextSummary = true;
  await f.session.compact();
  assert.ok(retrySawFailure, "provider outcome is recorded before the next summary attempt dispatches");
  assert.ok(f.session.sessionManager.getBranch().some(entry => entry.type === "compaction"));
  const result = await f.session.navigateTree(firstUser, { summarize: true });
  assert.equal(result.cancelled, false);
  assert.deepEqual(f.attempts, ["compaction", "compaction", "compaction", "branch-summary"]);
  assert.deepEqual(f.outcomes.map(outcome => outcome.stopReason), ["error", "stop", "stop", "stop"]);
  assert.equal(f.mainCalls(), 2);
  assert.equal(f.transcriptMessages(), 2);
  assert.equal(health.readHealth().providers.openrouter.requests.length, 6);
});
