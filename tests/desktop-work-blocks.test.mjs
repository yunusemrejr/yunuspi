import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentEvent, createConversation, duration, filesChanged, messageText, toolIcon, toolKind, toolLine, toolTrouble, workBlocks, workSummary } from "../desktop/renderer/conversation.mjs";

const tool = (name, args = {}, extra = {}) => ({ kind: "tool", name, args, status: "done", ...extra });

// One model message that narrates and calls a tool, then the tool's run and its result.
function step(state, { id, name, args, narration, failed = false }) {
  const output = failed ? "error: boom" : "ok";
  applyAgentEvent(state, { type: "message_start", message: { role: "assistant", content: [] } });
  applyAgentEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: narration }, { type: "toolCall", id, name, arguments: args }] } });
  applyAgentEvent(state, { type: "tool_execution_start", toolCallId: id, toolName: name, args });
  applyAgentEvent(state, { type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: output }] }, isError: failed });
  applyAgentEvent(state, { type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError: failed } });
}

function answer(state, text) {
  applyAgentEvent(state, { type: "message_start", message: { role: "assistant", content: [] } });
  applyAgentEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

// A user request, three narrated tool calls, then the final answer; the turn is over.
function threeToolRun() {
  const state = createConversation();
  applyAgentEvent(state, { type: "agent_start" });
  applyAgentEvent(state, { type: "message_start", message: { role: "user", content: "Fix the build" } });
  step(state, { id: "c1", name: "read", args: { path: "src/a.ts" }, narration: "Reading the file." });
  step(state, { id: "c2", name: "edit", args: { path: "src/a.ts" }, narration: "Fixing the import." });
  step(state, { id: "c3", name: "bash", args: { command: "npm test" }, narration: "Checking the tests." });
  answer(state, "All green.");
  applyAgentEvent(state, { type: "agent_end" });
  return state;
}

test("each tool name maps to a kind and that kind's icon; unknown names are 'other'", () => {
  const cases = [
    ["bash", "command", "terminal"],
    ["read", "read", "file"],
    ["multi_edit", "edit", "code"],
    ["subagent", "agent", "people"],
    ["todo", "plan", "target"],
    ["memory_search", "memory", "memory"],
    ["web_search", "web", "compass"],
    ["grep", "search", "search"],
    ["frobnicate", "other", "tune"],
  ];
  for (const [name, kind, icon] of cases) {
    assert.equal(toolKind(name), kind, name);
    assert.equal(toolIcon(name), icon, name);
  }
});

test("a finished bash call reads 'Ran' with its command, and 'Running' while it runs", () => {
  const done = tool("bash", { command: "npm test\n# later" });
  assert.deepEqual(toolLine(done), { kind: "command", verb: "Ran", detail: "npm test", code: true });
  assert.deepEqual(toolLine({ ...done, status: "running" }), { kind: "command", verb: "Running", detail: "npm test", code: true });
});

test("read, edit, write and grep name their path or pattern", () => {
  assert.deepEqual(toolLine(tool("read", { path: "src/app.ts" })), { kind: "read", verb: "Read", detail: "src/app.ts", code: true });
  assert.equal(toolLine(tool("read", { path: "src/app.ts" }, { status: "running" })).verb, "Reading");
  assert.deepEqual(toolLine(tool("edit", { path: "src/app.ts" })), { kind: "edit", verb: "Edited", detail: "src/app.ts", code: true });
  assert.equal(toolLine(tool("write", { path: "notes.md" })).verb, "Wrote");
  assert.deepEqual(toolLine(tool("grep", { pattern: "TODO", path: "src" })), { kind: "search", verb: "Searched", detail: "TODO in src", code: true });
});

test("a subagent call names the agent and the first line of its task", () => {
  assert.deepEqual(toolLine(tool("subagent", { agent: "scout-agent", task: "Find the failing test\nthen explain it" })), { kind: "agent", verb: "Scout agent", detail: "Find the failing test" });
});

test("several subagents at once or in a chain list their agents", () => {
  const tasks = [{ agent: "builder", task: "build" }, { agent: "reviewer", task: "review" }];
  const chain = [{ agent: "scout" }, { agent: "builder" }];
  assert.deepEqual(toolLine(tool("subagent", { tasks })), { kind: "agent", verb: "2 agents at once", detail: "builder, reviewer" });
  assert.deepEqual(toolLine(tool("subagent", { chain })), { kind: "agent", verb: "2 agents in turn", detail: "scout → builder" });
});

test("a list argument that arrives as JSON text (as the desktop projection sends it) reads like the list", () => {
  const tasks = [{ agent: "builder", task: "build" }, { agent: "reviewer", task: "review" }];
  assert.deepEqual(toolLine(tool("subagent", { tasks: JSON.stringify(tasks) })), { kind: "agent", verb: "2 agents at once", detail: "builder, reviewer" });
});

test("a failed call's trouble is the line that names the failure, without its prefix", () => {
  const failed = output => ({ ...tool("bash", { command: "x" }), status: "error", output });
  assert.equal(toolTrouble(failed("compiling\nRETRYABLE: upstream failed with 503\nretry later")), "upstream failed with 503");
  assert.equal(toolTrouble(failed("ok\nerror: file not found: a.txt")), "file not found: a.txt");
  assert.equal(toolTrouble(failed("✖ build broke")), "build broke");
  assert.equal(toolTrouble(failed("\x1b[31merror: boom\x1b[0m")), "boom");
  assert.equal(toolTrouble(failed("plain first\nplain second")), "plain first");
  assert.equal(toolTrouble(failed("error: " + "x".repeat(300))), "x".repeat(179) + "…");
});

test("a call that did not fail has no trouble line", () => {
  assert.equal(toolTrouble({ ...tool("bash", { command: "x" }), status: "done", output: "error: nope" }), "");
  assert.equal(toolTrouble({ ...tool("bash", { command: "x" }), status: "running", output: "" }), "");
});

test("duration gives 'Ns', 'Nm NNs' or 'Nh NNm', and '' for unmeasured or sub-second spans", () => {
  for (const ms of [undefined, NaN, Infinity, 999]) assert.equal(duration(ms), "", String(ms));
  assert.equal(duration(8000), "8 s");
  assert.equal(duration(59_400), "59 s");
  assert.equal(duration(59_600), "1m 00s");
  assert.equal(duration(134_000), "2m 14s");
  assert.equal(duration(3_900_000), "1h 05m");
});

test("filesChanged counts successful edits per file and ignores failed edits and reads", () => {
  const messages = [
    { kind: "assistant", content: [] },
    tool("edit", { path: "src/a.ts" }),
    tool("read", { path: "src/b.ts" }),
    tool("edit", { path: "src/c.ts" }, { status: "error" }),
    tool("edit", { path: "src/a.ts" }),
    tool("write", { file_path: "src/d.ts" }),
    tool("multi_edit", { files: JSON.stringify([{ path: "src/a.ts" }, "src/e.ts"]) }),
  ];
  assert.deepEqual(filesChanged(messages), [{ path: "src/a.ts", edits: 3 }, { path: "src/d.ts", edits: 1 }, { path: "src/e.ts", edits: 1 }]);
});

test("workSummary counts calls and distinct files, and words the phrase", () => {
  const steps = [
    { kind: "assistant", content: [], at: 1000 },
    tool("bash", { command: "npm test" }, { startedAt: 2000, at: 9000 }),
    tool("read", { path: "a.ts" }),
    tool("read", { path: "b.ts" }),
    tool("read", { path: "a.ts" }),
    tool("read", { path: "c.ts" }),
    tool("read", { path: "d.ts" }),
    tool("edit", { path: "a.ts" }),
    tool("edit", { path: "a.ts" }),
    tool("bash", { command: "npm run build" }),
    tool("bash", { command: "node x.js" }),
  ];
  const summary = workSummary(steps);
  assert.equal(summary.tools, 10);
  assert.equal(summary.failed, 0);
  assert.equal(summary.phrase, "ran 3 commands, edited 1 file, read 4 files");
  assert.equal(summary.ms, 8000);
  assert.equal(summary.last.args.command, "node x.js");
  assert.equal(workSummary([tool("bash", { command: "x" })]).ms, undefined);
});

test("workSummary's state is 'live' while the turn runs, 'failed' only when the last call errored, 'stopped' when a call was cut off", () => {
  const ok = tool("bash", { command: "a" }), broke = tool("bash", { command: "b" }, { status: "error" });
  const running = tool("bash", { command: "c" }, { status: "running" });
  assert.equal(workSummary([ok, broke]).state, "failed");
  assert.equal(workSummary([broke, ok]).state, "done");
  assert.equal(workSummary([broke, ok]).failed, 1);
  assert.equal(workSummary([ok, broke], true).state, "live");
  assert.equal(workSummary([ok, running]).state, "stopped");
});

test("chat without tool calls stays as plain messages", () => {
  const state = createConversation();
  applyAgentEvent(state, { type: "message_start", message: { role: "user", content: "hi" } });
  answer(state, "Hello.");
  answer(state, "How can I help?");
  const items = workBlocks(state.messages, false);
  assert.deepEqual(items.map(item => item.kind), ["user", "assistant", "assistant"]);
  assert.equal(items[1], state.messages[1]);
});

test("a finished run folds its narrated tool steps into one block and leaves the answer outside", () => {
  const items = workBlocks(threeToolRun().messages, false);
  assert.deepEqual(items.map(item => item.kind), ["user", "work", "assistant"]);
  const [, block, final] = items;
  assert.deepEqual(block.steps.map(step => step.kind), ["assistant", "tool", "assistant", "tool", "assistant", "tool"]);
  assert.deepEqual(block.steps.filter(step => step.kind === "assistant").map(messageText), ["Reading the file.", "Fixing the import.", "Checking the tests."]);
  assert.deepEqual(block.steps.filter(step => step.kind === "tool").map(step => step.name), ["read", "edit", "bash"]);
  assert.equal(messageText(final), "All green.");
  assert.equal(block.live, false);
  assert.equal(block.bare, false);
});

test("while the turn runs, the last text stays in the block and the block is live", () => {
  const items = workBlocks(threeToolRun().messages, true);
  assert.deepEqual(items.map(item => item.kind), ["user", "work"]);
  assert.equal(items[1].live, true);
  assert.equal(messageText(items[1].steps.at(-1)), "All green.");
});

test("a block of one or two calls is bare, a block of three or more is not", () => {
  const state = createConversation();
  applyAgentEvent(state, { type: "message_start", message: { role: "user", content: "Check it" } });
  step(state, { id: "c1", name: "read", args: { path: "a.ts" }, narration: "Reading." });
  step(state, { id: "c2", name: "bash", args: { command: "npm test" }, narration: "Testing." });
  answer(state, "Done.");
  const short = workBlocks(state.messages, false).find(item => item.kind === "work");
  assert.equal(short.bare, true);
  const long = workBlocks(threeToolRun().messages, false).find(item => item.kind === "work");
  assert.equal(long.bare, false);
});

test("a block's key comes from its first step and stays the same while the turn runs and after", () => {
  const { messages } = threeToolRun();
  const finished = workBlocks(messages, false).find(item => item.kind === "work");
  const again = workBlocks(messages, false).find(item => item.kind === "work");
  const live = workBlocks(messages, true).find(item => item.kind === "work");
  assert.equal(finished.key, `work:${messages[1].key}`);
  assert.equal(again.key, finished.key);
  assert.equal(live.key, finished.key);
});

test('a failed edit or read is not counted as a file edited or read; a failed command still ran', () => {
  const steps = [
    { kind: 'tool', name: 'edit', args: { path: 'a.ts' }, status: 'error' },
    { kind: 'tool', name: 'read', args: { path: 'gone.ts' }, status: 'error' },
    { kind: 'tool', name: 'read', args: { path: 'b.ts' }, status: 'done' },
    { kind: 'tool', name: 'bash', args: { command: 'npm test' }, status: 'error' },
  ];
  const summary = workSummary(steps);
  assert.equal(summary.phrase, 'ran 1 command, read 1 file');
  assert.equal(summary.failed, 3);
  assert.equal(summary.tools, 4);
  assert.equal(workSummary([steps[0]]).phrase, '', 'a block whose only edit failed claims no edit');
});
