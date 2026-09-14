import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
  fs.existsSync(path.join(dir, "extensions/lib/session-metrics.ts")),
);
assert.ok(agent, "session metrics must be shipped");
const { collectSessionMetrics } = await import(
  pathToFileURL(path.join(agent, "extensions/lib/session-metrics.ts"))
);
const { wrapper, transform } = await import(
  pathToFileURL(path.join(agent, "scripts/patches/hook-metrics.mjs"))
);
const message = (role, fields) => ({
  type: "message",
  message: { role, ...fields },
});
const child = (runId, results) => ({
  type: "custom",
  customType: "subagent-cost-v1",
  data: { runId, results },
});
const snapshot = (segment, calls) => ({
  type: "custom",
  customType: "session-metrics-v1",
  data: {
    version: 2,
    segment,
    hooks: {
      "fixture:context": {
        calls,
        errors: 1,
        ms: 2,
        removedChars: 40,
        addedChars: 4,
      },
    },
    events: { swarms: 1, fusions: 1 },
  },
});

test("replayed results, child receipts and cumulative snapshots count once", () => {
  const tool = message("toolResult", {
    toolCallId: "call",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: "Blocked: fixture" }],
  });
  const entries = [
    message("assistant", {
      content: [{ type: "toolCall", id: "call", name: "bash" }],
      usage: { input: 10, output: 5, cacheRead: 90, reasoning: 2 },
    }),
    tool,
    tool,
    child("a", [{}]),
    child("a", [
      { index: 0, exitCode: 0, usage: { input: 10, output: 5, cacheRead: 5 } },
    ]),
    child("b", [{ index: 0, error: "fixture failure", exitCode: 1 }]),
    snapshot("segment", 2),
    snapshot("segment", 4),
  ];
  const m = collectSessionMetrics(entries);
  assert.equal(m.toolResults, 1);
  assert.equal(m.errors, 1);
  assert.equal(m.blocked, 1);
  assert.equal(m.agents, 2);
  assert.equal(m.agentFailures, 1);
  assert.equal(m.agentOutcomeUnknown, 0);
  assert.equal(m.childTokens, 20);
  assert.equal(m.hookCalls, 4);
  assert.equal(m.swarms, 1);
  assert.equal(m.fusions, 1);
  assert.equal(m.cacheRate, 90);
  assert.equal(m.output, 5);
  assert.equal(m.reasoning, 2);
  assert.equal(
    collectSessionMetrics(entries, snapshot("segment", 7).data).hookCalls,
    7,
  );
});

test("legacy failures and missing history remain distinguishable", () => {
  const m = collectSessionMetrics([
    message("toolResult", {
      toolName: "web_search",
      details: { queryCount: 2, successfulQueries: 0 },
    }),
    child("legacy", [{}]),
  ]);
  assert.equal(m.errors, 1);
  assert.equal(m.agentOutcomeUnknown, 1);
  assert.equal(m.telemetry, false);
  assert.match(m.detail.join("\n"), /savings: unknown/);
  assert.deepEqual(m.footer, ["Agents 1 (0 active)", "Failures 1 (P1 C0 W0)"]);
  // Bottom KPI layer: only harness powers actually used, plus the session id.
  // Plain utility wrappers (read/bash/grep/web_search/http_request/...) are not
  // powers and must not crowd the line.
  const powered = collectSessionMetrics([
    { type: "session", id: "01a0a0f7-1753-7646-a8e5-7d6e65bbf644" },
    message("toolResult", {
      toolCallId: "p1",
      toolName: "project_tests",
      content: [],
    }),
    message("toolResult", {
      toolCallId: "p2",
      toolName: "project_tests",
      content: [],
    }),
    message("toolResult", {
      toolCallId: "p3",
      toolName: "web_search",
      details: { queryCount: 1, successfulQueries: 1 },
      content: [],
    }),
  ]);
  assert.deepEqual(powered.footer, [
    "Agents 0 (0 active)",
    "Failures 0",
    "Powers 🧪2",
    "session 01a0a0f7",
  ]);
  const parallel = message("toolResult", {
    toolName: "subagent",
    details: {
      mode: "parallel",
      runId: "group",
      results: [{ runId: "a" }, { runId: "b" }],
    },
  });
  assert.equal(collectSessionMetrics([parallel]).swarms, 1);
});

test("async children count at acceptance and settle without duplication", () => {
  const launched = message("toolResult", {
    toolCallId: "launch",
    toolName: "subagent",
    details: {
      mode: "single",
      runId: "async-run",
      asyncId: "async-run",
      results: [],
    },
  });
  const running = collectSessionMetrics([launched]);
  assert.equal(running.agents, 1);
  assert.equal(running.agentsActive, 1);
  assert.equal(running.swarms, 0);
  assert.equal(running.fusions, 0);
  const settled = child("async-run", [
    { index: 0, exitCode: 0, usage: { input: 30, output: 4 } },
  ]);
  const finished = collectSessionMetrics([
    launched,
    settled,
    settled,
    launched,
  ]);
  assert.equal(finished.agents, 1);
  assert.equal(finished.agentsActive, 0);
  assert.equal(finished.agentsCompleted, 1);
  assert.equal(finished.childTokens, 34);
  const controller = message("toolResult", {
    toolName: "subagent",
    details: {
      mode: "workflow",
      runId: "workflow",
      asyncId: "workflow",
      results: [],
    },
  });
  assert.equal(
    collectSessionMetrics([controller]).agents,
    0,
    "a workflow controller is not a child",
  );
});

test("failed workflow controllers are visible even when no children start", () => {
  const started = message("toolResult", {
    toolName: "subagent",
    details: {
      mode: "workflow",
      runId: "controller",
      asyncId: "controller",
      results: [],
    },
  });
  const failed = {
    type: "custom",
    customType: "subagent-lifecycle-v1",
    data: {
      mode: "workflow",
      runId: "controller",
      state: "failed",
      results: [],
    },
  };
  const m = collectSessionMetrics([started, failed, failed, started]);
  assert.equal(m.agents, 0);
  assert.equal(m.workflows, 1);
  assert.equal(m.workflowFailures, 1);
  assert.equal(m.workflowsActive, 0);
  assert.ok(m.footer.includes("Failures 1 (P0 C0 W1)"));
  const legacy = collectSessionMetrics([
    {
      type: "custom",
      customType: "subagent-cost-v1",
      data: { mode: "workflow", runId: "legacy", results: [] },
    },
  ]);
  assert.equal(legacy.workflowFailures, 0);
  assert.equal(legacy.workflowOutcomeUnknown, 1);
});

test("skill reads require successful read evidence and retain partial coverage", () => {
  const call = (id, path, extra = {}) =>
    message("assistant", {
      content: [
        { type: "toolCall", id, name: "read", arguments: { path, ...extra } },
      ],
    });
  const result = (id, isError = false) =>
    message("toolResult", { toolCallId: id, toolName: "read", isError });
  const guidance = {
    type: "custom",
    customType: "relevant-guidance",
    data: { shown: ["skill:/skills/design/SKILL.md"], read: [] },
  };
  const before = collectSessionMetrics([
    guidance,
    call("read", "/skills/design/SKILL.md"),
  ]);
  assert.deepEqual(before.skillsRouted, ["design"]);
  assert.deepEqual(before.skillsRead, []);
  const after = collectSessionMetrics([
    guidance,
    call("read", "/skills/design/SKILL.md"),
    result("read"),
    call("part", "/skills/browser/SKILL.md", { offset: 10, limit: 20 }),
    result("part"),
    call("bad", "/skills/missing/SKILL.md"),
    result("bad", true),
  ]);
  assert.deepEqual(after.skillsRead, ["design"]);
  assert.deepEqual(after.skillsPartial, ["browser"]);
  assert.equal(after.errors, 1);
});

test("stream notifications never inflate historical or live policy-check counts", () => {
  const sample = snapshot("old", 3);
  sample.data.hooks["reminders.ts:message_update"] = {
    calls: 60000,
    changed: 0,
  };
  sample.data.hooks["health-log.ts:tool_call"] = { calls: 20, changed: 0 };
  const m = collectSessionMetrics([sample]);
  assert.equal(m.hookCalls, 3);
  assert.equal(m.hookExcluded, 60020);
  let events = 0;
  const context = {
    performance,
    Symbol,
    globalThis: { [Symbol.for("yunus-pi.metrics.v1")]: () => events++ },
  };
  const wrap = vm.runInNewContext("(" + wrapper + ")", context);
  const original = (value) => value;
  assert.equal(
    wrap(original, "message_update", "/fixture/reminders.ts"),
    original,
  );
  assert.equal(wrap(original, "tool_call", "/fixture/health-log.ts"), original);
  assert.equal(events, 0);
});

test("old group and fusion definitions remain labeled instead of becoming exact new counters", () => {
  const legacy = snapshot("legacy", 1);
  delete legacy.data.version;
  const current = snapshot("current", 2);
  const m = collectSessionMetrics([legacy, current]);
  assert.equal(m.swarms, 1);
  assert.equal(m.fusions, 1);
  assert.equal(m.legacySwarms, 1);
  assert.equal(m.legacyFusions, 1);
  assert.deepEqual(m.footer, ["Agents 0 (0 active)", "Failures 0"]);
});

test("hook instrumentation preserves receiver, result, errors and sink isolation", async () => {
  const events = [],
    symbol = Symbol.for("yunus-pi.metrics.v1");
  const context = {
    performance,
    Symbol,
    globalThis: { [symbol]: (kind, data) => events.push({ kind, data }) },
  };
  const wrap = vm.runInNewContext("(" + wrapper + ")", context);
  const owner = { value: 9 };
  const result = await wrap(
    function (event) {
      assert.equal(this, owner);
      return { messages: [{ content: event.messages[0].content.slice(0, 2) }] };
    },
    "context",
    "/fixture/extension.ts",
  ).call(owner, { messages: [{ content: "abcdefghij" }] });
  assert.equal(result.messages[0].content, "ab");
  assert.equal(events[0].data.removedChars, 8);
  assert.equal(events[0].data.owner, "extension.ts");
  const failure = new Error("fixture failure");
  await assert.rejects(
    wrap(
      async () => {
        throw failure;
      },
      "tool_call",
      "fixture",
    )({}),
    (error) => error === failure,
  );
  assert.equal(events[1].data.error, true);
  context.globalThis[symbol] = () => {
    throw Error("sink failure");
  };
  assert.equal(await wrap(() => 3, "input", "fixture")({}), 3);
  delete context.globalThis[symbol];
  assert.equal(await wrap(() => 4, "input", "fixture")({}), 4);
});

test("SDK and CLI hook patches are idempotent and reject changed anchors or payloads", () => {
  for (const [source, bundled] of [
    [
      "list.push(handler);\n            extension.handlers.set(event, list);",
      false,
    ],
    ["list2.push(handler),extension.handlers.set(event,list2)", true],
  ]) {
    const patched = transform(source, bundled);
    assert.match(patched, /PI_HOOK_METRICS_V2/);
    assert.equal(transform(patched, bundled), patched);
    assert.throws(
      () =>
        transform(
          patched.replace("ms:performance.now()-started", "ms:0"),
          bundled,
        ),
      /drift/,
    );
    assert.throws(
      () => transform("unsupported loader", bundled),
      /anchor drift/,
    );
  }
});
