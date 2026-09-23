import test from "node:test";
import assert from "node:assert/strict";

import { AssistantMessageEventStream } from "@yunuspi/ai";
import { AgentHarness } from "@yunuspi/agent-core";
import { BACKGROUND_CONTEXT } from "@yunuspi/agent-core/harness/context";
import { MemorySessionRepo } from "@yunuspi/agent-core/harness/session";
import { HookRegistry } from "../core/agent/src/harness/hooks.js";
import { createGate } from "../core/agent/src/harness/execution/effect-gate.js";
import { createEventBus } from "../core/coding-agent/src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/coding-agent/src/core/extensions/loader.js";
import registerSubagentNotify from "../agent/extensions/pi-subagents/src/runs/background/notify.ts";

const context = BACKGROUND_CONTEXT;
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(id = "model") {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000,
  };
}

function assistantMessage(m, text = "done", stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: m.api,
    provider: m.provider,
    model: m.id,
    usage: zeroUsage,
    stopReason,
    timestamp: Date.now(),
  };
}

function completedStream(m) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: assistantMessage(m, "") });
  stream.push({ type: "done", message: assistantMessage(m) });
  return stream;
}

async function openHarness(options = {}) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({ id: `coordination-${Date.now()}-${Math.random()}` }, context);
  const selectedModel = options.model ?? model();
  const models = options.models ?? {
    getModel: () => selectedModel,
    streamSimple: () => completedStream(selectedModel),
  };
  const created = await AgentHarness.create({
    session,
    models,
    model: selectedModel,
    tools: options.tools,
    activeToolNames: options.activeToolNames,
    resources: options.resources,
    streamOptions: options.streamOptions,
    retry: options.retry,
    compaction: options.compaction,
    systemPrompt: options.systemPrompt,
  }, context);
  const lane = await created.harness.lane("main", context);
  return { repo, session, harness: created.harness, lane, model: selectedModel };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for coordination fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("harness close waits for the installed drive task, not only its rejected completion", async () => {
  const m = model();
  let stream;
  let called = false;
  const fixture = await openHarness({
    model: m,
    models: {
      getModel: () => m,
      streamSimple: () => {
        called = true;
        stream = new AssistantMessageEventStream();
        return stream;
      },
    },
  });
  const run = fixture.lane.prompt("hold the provider open", undefined, context).catch(() => undefined);
  let closing;
  try {
    await waitFor(() => called);
    let closed = false;
    closing = fixture.harness.close(context).then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closed, false, "close must not resolve while the provider stream is still live");
    stream.push({ type: "error", reason: "aborted", error: assistantMessage(m, "", "aborted") });
    await closing;
    await run;
    await assert.rejects(fixture.session.getStats(context), /closed/i);
  } finally {
    stream?.push({ type: "error", reason: "aborted", error: assistantMessage(m, "", "aborted") });
    await Promise.race([closing ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    await run;
    await fixture.repo.close(context);
  }
});

test("harness configuration getters and setters do not expose mutable live state", async () => {
  const execute = async () => ({ content: [{ type: "text", text: "ok" }], details: {} });
  const tool = {
    name: "read",
    label: "Read",
    description: "Read a value",
    parameters: { type: "object", properties: { target: { type: "string" } } },
    execute,
  };
  const fixture = await openHarness({
    tools: [tool],
    activeToolNames: ["read"],
    resources: { skills: [{ name: "one", description: "one", content: "one", filePath: "/one" }] },
    streamOptions: { headers: { "x-test": "one" }, metadata: { source: "one" } },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
    compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 },
  });
  try {
    const active = await fixture.lane.getActiveTools(context);
    active.push("unvalidated");
    assert.deepEqual(await fixture.lane.getActiveTools(context), ["read"]);

    const names = ["read"];
    await fixture.lane.setActiveTools(names, context);
    names.push("mutated-after-set");
    assert.deepEqual(await fixture.lane.getActiveTools(context), ["read"]);

    const returnedTools = await fixture.harness.getTools(context);
    returnedTools.push({ name: "injected" });
    returnedTools[0].parameters.properties.target.type = "number";
    assert.equal((await fixture.harness.getTools(context)).length, 1);
    assert.equal((await fixture.harness.getTools(context))[0].parameters.properties.target.type, "string");

    const suppliedTools = [tool];
    await fixture.harness.setTools(suppliedTools, context);
    suppliedTools[0].parameters.properties.target.type = "boolean";
    assert.equal((await fixture.harness.getTools(context))[0].parameters.properties.target.type, "string");

    const streamOptions = { headers: { "x-test": "two" }, metadata: { source: "two" } };
    await fixture.harness.setStreamOptions(streamOptions, context);
    streamOptions.headers["x-test"] = "mutated";
    const readOptions = await fixture.harness.getStreamOptions(context);
    readOptions.headers["x-test"] = "mutated-again";
    assert.equal((await fixture.harness.getStreamOptions(context)).headers["x-test"], "two");

    const resources = await fixture.harness.getResources(context);
    resources.skills[0].description = "mutated";
    assert.equal((await fixture.harness.getResources(context)).skills[0].description, "one");
    const retry = await fixture.harness.getRetryPolicy(context);
    retry.maxRetries = 99;
    assert.equal((await fixture.harness.getRetryPolicy(context)).maxRetries, 2);
    const compaction = await fixture.harness.getCompactionSettings(context);
    compaction.reserveTokens = 99;
    assert.equal((await fixture.harness.getCompactionSettings(context)).reserveTokens, 10);
  } finally {
    await fixture.harness.close(context);
    await fixture.repo.close(context);
  }
});

test("runWhenIdle callbacks can issue lane commands without waiting on their own idle claim", async () => {
  const fixture = await openHarness();
  let timeout;
  try {
    let callbackContext;
    await Promise.race([
      fixture.lane.runWhenIdle(async (context) => {
        callbackContext = context;
        await fixture.lane.setThinkingLevel("high", context);
      }, context),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("runWhenIdle callback deadlocked")), 2000); }),
    ]);
    assert.ok(callbackContext);
    assert.equal(await fixture.lane.getThinkingLevel(context), "high");
  } finally {
    clearTimeout(timeout);
    await fixture.harness.close(context);
    await fixture.repo.close(context);
  }
});

test("one drive pass uses a stable tool catalogue despite concurrent configuration changes", async () => {
  const m = model();
  const alpha = {
    name: "alpha",
    label: "Alpha",
    description: "alpha",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "alpha" }], details: {} }),
  };
  const beta = { ...alpha, name: "beta", label: "Beta" };
  let releaseSystemPrompt;
  let systemPromptStarted;
  const systemPromptReady = new Promise((resolve) => { systemPromptStarted = resolve; });
  const systemPromptGate = new Promise((resolve) => { releaseSystemPrompt = resolve; });
  const seenTools = [];
  const fixture = await openHarness({
    model: m,
    tools: [alpha],
    activeToolNames: ["alpha"],
    systemPrompt: async () => {
      systemPromptStarted();
      await systemPromptGate;
      return "stable prompt";
    },
    models: {
      getModel: () => m,
      streamSimple: (_model, aiContext) => {
        seenTools.push(aiContext.tools.map((tool) => tool.name));
        return completedStream(m);
      },
    },
  });
  try {
    const run = fixture.lane.prompt("snapshot this", undefined, context);
    await systemPromptReady;
    await fixture.harness.setTools([beta], context);
    releaseSystemPrompt();
    const result = await run;
    assert.equal(result.ok, true);
    assert.deepEqual(seenTools, [["alpha"]]);
  } finally {
    releaseSystemPrompt();
    await fixture.harness.close(context);
    await fixture.repo.close(context);
  }
});

test("before_run_end preserves follow-ups from multiple extensions", async () => {
  const errors = [];
  const registry = new HookRegistry((error) => { errors.push(error); });
  const { gate } = createGate();
  registry.on("before_run_end", () => ({ followUp: "first extension" }));
  registry.on("before_run_end", () => ({ followUp: "second extension" }));
  const result = await registry.runWithGate("before_run_end", { lane: "main", runId: "run", messages: [] }, gate, context);
  assert.deepEqual(result, { followUp: "first extension\n\nsecond extension" });
  assert.deepEqual(errors, []);
});

test("ordinary extension message APIs return the underlying acceptance promise", async () => {
  const runtime = createExtensionRuntime();
  let resolveMessage;
  const accepted = new Promise((resolve) => { resolveMessage = resolve; });
  runtime.sendMessage = () => accepted;
  let api;
  await loadExtensionFromFactory((extension) => { api = extension; }, process.cwd(), createEventBus(), runtime, "<coordination-test>");
  const returned = api.sendMessage({ customType: "test", content: "accepted" });
  assert.equal(returned, accepted);
  let settled = false;
  void returned.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveMessage();
  await returned;
  assert.equal(settled, true);
});

test("subagent completion receipts remain retryable until message acceptance", async () => {
  let rejectFirst;
  let resolveSecond;
  const first = new Promise((_, reject) => { rejectFirst = reject; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  let sends = 0;
  const pi = {
    events: createEventBus(),
    sendMessage: () => (++sends === 1 ? first : second),
  };
  const notifier = registerSubagentNotify(
    pi,
    { currentSessionId: "session", completionOwnerId: "owner" },
    { batchConfig: { enabled: false } },
  );
  const result = {
    id: "completion-1",
    sessionId: "session",
    completionOwnerId: "owner",
    source: "async",
    agent: "worker",
    success: true,
    summary: "done",
  };
  try {
    const rejected = notifier.deliver(result);
    rejectFirst(new Error("queue closed"));
    assert.equal(await rejected, false);
    const accepted = notifier.deliver(result);
    resolveSecond();
    assert.equal(await accepted, true);
    assert.equal(sends, 2);
  } finally {
    notifier.dispose();
  }
});
