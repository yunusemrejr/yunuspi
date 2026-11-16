import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "@yunuspi/agent-core";
import { AssistantMessageEventStream } from "@yunuspi/ai";
import { createAgentSession } from "../core/coding-agent/src/core/sdk.js";
import { DefaultResourceLoader } from "../core/coding-agent/src/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/src/core/settings-manager.js";

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-durable-"));
const originalHomeDirectory = os.homedir;
os.homedir = () => fixtureHome;
syncBuiltinESMExports();
const [{ default: registerReminders }, reminderState] = await Promise.all([
  import("../agent/extensions/reminders.ts"), import("../agent/extensions/lib/reminders-state.ts"),
]);
test.after(() => {
  os.homedir = originalHomeDirectory;
  syncBuiltinESMExports();
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

async function fixture(t, { eventType, sendTool = false, pauseUntilReleased = false }) {
  const cwd = fs.mkdtempSync(path.join(fixtureHome, "session-"));
  const manager = SessionManager.create(cwd, cwd);
  const sid = manager.getSessionId();
  const nextFireAt = Date.now() + (sendTool ? 60_000 : -1);
  const state = reminderState.defaultRemindersState();
  state.manual.push({ id: "fixture-reminder", text: "Synthetic durable reminder", active: true,
    createdAt: nextFireAt - reminderState.MANUAL_INTERVAL_MS, nextFireAt, delivered: 0 });
  assert.equal(reminderState.writeRemindersState(sid, state), true);
  const scheduled = () => reminderState.readRemindersState(sid).manual[0];
  const remindersInHistory = () => manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "reminders");
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  let waitOnce = true;
  const laterExtension = pi => pi.on(eventType, async (_event, ctx) => {
    if (!waitOnce) return;
    waitOnce = false;
    entered.resolve();
    if (pauseUntilReleased) return resumed.promise;
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
  });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, extensionFactories: [registerReminders, laterExtension] });
  await loader.reload();
  const model = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
    input: ["text"], reasoning: false, contextWindow: 65_536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let dispatches = 0;
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: "synthetic-token" } }),
    streamSimple() {
      const tool = ++dispatches === 1 && sendTool;
      if (tool) t.mock.timers.tick(60_000);
      const content = tool ? [{ type: "toolCall", id: "fixture-tool", name: "fixture_missing_tool", arguments: {} }]
        : [{ type: "text", text: "Synthetic answer" }];
      const message = { role: "assistant", content, stopReason: tool ? "toolUse" : "stop", api: model.api, model: model.id,
        provider: model.provider, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    },
  };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager: settings,
    resourceLoader: loader, sessionManager: manager, noTools: "all", thinkingLevel: "off" });
  t.after(() => session.dispose());
  return { session, manager, entered: entered.promise, resume: resumed.resolve,
    nextFireAt, scheduled, remindersInHistory, dispatches: () => dispatches };
}

test("Stop during later prompt preflight leaves a reminder due for the next durably accepted prompt", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { eventType: "before_agent_start" });
  const stopped = f.session.prompt("Synthetic canceled prompt");
  const rejected = assert.rejects(stopped);
  await f.entered;
  assert.equal(f.scheduled().delivered, 0);
  await f.session.abort();
  await rejected;
  assert.equal(f.scheduled().nextFireAt, f.nextFireAt);
  assert.equal(f.remindersInHistory().length, 0);
  assert.equal(f.dispatches(), 0);

  await f.session.prompt("Synthetic replacement prompt");
  assert.equal(f.scheduled().delivered, 1);
  assert.equal(f.scheduled().nextFireAt, f.nextFireAt + reminderState.MANUAL_INTERVAL_MS);
  assert.equal(f.remindersInHistory().length, 1);
  const reopened = SessionManager.open(f.manager.getSessionFile(), f.manager.getSessionDir());
  assert.equal(reopened.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "reminders").length, 1);
  await f.session.prompt("Synthetic prompt before next recurrence");
  assert.equal(f.remindersInHistory().length, 1);
});

test("Stop after a continuing turn queued a reminder does not consume or duplicate it", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date() });
  const f = await fixture(t, { eventType: "turn_end", sendTool: true });
  const stopped = f.session.prompt("Synthetic initial tool request");
  await f.entered;
  assert.equal(f.scheduled().delivered, 0);
  assert.equal(f.remindersInHistory().length, 0);
  assert.equal(f.session.agent.hasQueuedMessages(), true);
  f.session.agent.steer({ role: "user", content: "Synthetic separate steering", timestamp: Date.now() });
  await f.session.abort();
  await stopped;
  assert.equal(f.scheduled().nextFireAt, f.nextFireAt);
  assert.equal(f.dispatches(), 1);
  await f.session.prompt("Synthetic replacement prompt");
  assert.equal(f.scheduled().delivered, 1);
  assert.equal(f.remindersInHistory().length, 1);
  assert.ok(f.manager.getEntries().some(entry => entry.type === "message" && entry.message.content === "Synthetic separate steering"));
  assert.equal(f.dispatches(), 2);
});

test("clearing a staged reminder during agent startup prevents its delivery", { timeout: 10_000 }, async t => {
  const f = await fixture(t, { eventType: "agent_start", pauseUntilReleased: true });
  const turn = f.session.prompt("Synthetic prompt awaiting startup");
  await f.entered;
  try {
    await f.session.prompt("/reminder clear 1");
  } finally {
    f.resume();
  }
  await turn;
  assert.equal(f.dispatches(), 1);
  assert.equal(f.remindersInHistory().length, 0);
  assert.equal(f.scheduled().active, false);
  assert.equal(f.scheduled().delivered, 0);
});

test("a conditional steer discarded at delivery cannot start a turn or hide the following steer", async () => {
  for (const [queueNext, checkQueue, afterRun] of [[false, false, false], [true, false, false], [true, true, false], [true, false, true]]) {
    const consumed = [];
    let dispatches = 0;
    let turnStarts = 0;
    const stale = { role: "custom", customType: "reminders", content: "Stale staged reminder", timestamp: 1 };
    const agent = new Agent({
      canDeliverMessage: message => message !== stale || turnStarts < 2,
      streamFn(model) {
        dispatches++;
        const message = { role: "assistant", content: [{ type: "text", text: "Fixture response" }], stopReason: "stop",
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });
    const queue = () => {
      agent.steer(stale, checkQueue ? { canDeliver: () => turnStarts < 2 } : undefined);
      if (queueNext) agent.steer({ role: "user", content: "Live steering", timestamp: 2 });
    };
    agent.subscribe(event => {
      if (event.type === "turn_start") turnStarts++;
      if (!afterRun && event.type === "turn_end" && dispatches === 1) queue();
      if (event.type === "message_end" && event.message.role !== "assistant") consumed.push(event.message.content);
    });
    await agent.prompt({ role: "user", content: "Fixture prompt", timestamp: 0 });
    if (afterRun) {
      queue();
      await agent.continue();
    }
    assert.deepEqual(consumed, queueNext ? ["Fixture prompt", "Live steering"] : ["Fixture prompt"]);
    assert.equal(dispatches, queueNext ? 2 : 1);
  }
});
