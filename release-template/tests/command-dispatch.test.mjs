import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../core/coding-agent/src/core/agent-session.js";
import { InteractiveMode } from "../core/coding-agent/src/modes/interactive/interactive-mode.js";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../core/coding-agent/src/core/slash-commands.js";
import { expandPromptTemplate } from "../core/coding-agent/src/core/prompt-templates.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/coding-agent/src/core/extensions/loader.js";
import { ExtensionRunner } from "../core/coding-agent/src/core/extensions/runner.js";
import { createEventBus } from "../core/coding-agent/src/core/event-bus.js";

const commandMethods = {
  settings: "showSettingsSelector", "scoped-models": "showModelsSelector", model: "handleModelCommand",
  thinking: "handleThinkingCommand", export: "handleExportCommand", import: "handleImportCommand",
  guardian: "handleGuardianCommand",
  share: "handleShareCommand", copy: "handleCopyCommand", name: "handleNameCommand", session: "handleSessionCommand",
  changelog: "handleChangelogCommand", hotkeys: "handleHotkeysCommand", fork: "showUserMessageSelector",
  clone: "handleCloneCommand", tree: "showTreeSelector", trust: "showTrustSelector", login: "handleLoginCommand",
  logout: "showOAuthSelector", new: "handleClearCommand", compact: "handleCompactCommand", reload: "handleReloadCommand",
  resume: "showSessionSelector", quit: "shutdown",
};

function editorFixture() {
  const calls = [], errors = [], prompts = [], queued = [], inputs = [];
  const mode = Object.create(InteractiveMode.prototype);
  mode.defaultEditor = mode.editor = { setText() {}, addToHistory() {} };
  mode.runtimeHost = { session: {
    isCompacting: false, isStreaming: false, promptTemplates: [],
    extensionRunner: { getCommand: (name) => name === "fixture" ? { handler() {} } : undefined },
    async prompt(...args) { prompts.push(args); },
  } };
  mode.showError = (message) => errors.push(message);
  mode.queueCompactionMessage = (...args) => queued.push(args);
  mode.flushPendingBashComponents = () => {};
  mode.updatePendingMessagesDisplay = () => {};
  mode.ui = { requestRender() {} };
  mode.onInputCallback = (text) => inputs.push(text);
  for (const method of Object.values(commandMethods)) mode[method] = (...args) => { calls.push({ method, args }); };
  mode.setupEditorSubmitHandler();
  return { mode, calls, errors, prompts, queued, inputs };
}

test("every advertised builtin command has a working interactive dispatch route", async (t) => {
  assert.deepEqual(new Set(BUILTIN_SLASH_COMMANDS.map(({ name }) => name)), new Set(Object.keys(commandMethods)));
  for (const { name } of BUILTIN_SLASH_COMMANDS) {
    await t.test(name, async () => {
      const fixture = editorFixture();
      await fixture.mode.defaultEditor.onSubmit(`  /${name}\t `);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0].method, commandMethods[name]);
      assert.deepEqual(fixture.errors, []);
      assert.deepEqual(fixture.inputs, []);
    });
  }
});

test("builtin arguments accept tab and newline separators without modifying ordinary prompts", async () => {
  const fixture = editorFixture();
  await fixture.mode.defaultEditor.onSubmit("/model\tprovider/model");
  await fixture.mode.defaultEditor.onSubmit("/compact\nKeep the plan.\nPreserve remaining tasks.");
  await fixture.mode.defaultEditor.onSubmit("/thinking\u00a0high");
  await fixture.mode.defaultEditor.onSubmit("/some/path\nThis is a prompt, not a command.");
  assert.deepEqual(fixture.calls, [
    { method: "handleModelCommand", args: ["provider/model"] },
    { method: "handleCompactCommand", args: ["Keep the plan.\nPreserve remaining tasks."] },
    { method: "handleThinkingCommand", args: ["high"] },
  ]);
  assert.deepEqual(fixture.inputs, ["/some/path\nThis is a prompt, not a command."]);
});

test("submitted builtin and streaming errors are displayed without rejecting into the terminal loop", async () => {
  const fixture = editorFixture();
  fixture.mode.showSessionSelector = async () => { throw new Error("Session directory unavailable"); };
  fixture.mode.handleCloneCommand = async () => { throw new Error("Clone failed"); };
  await fixture.mode.defaultEditor.onSubmit("/resume");
  await fixture.mode.defaultEditor.onSubmit("/clone");
  fixture.mode.session.isStreaming = true;
  fixture.mode.session.prompt = async () => { throw new Error("Queue unavailable"); };
  await fixture.mode.defaultEditor.onSubmit("Continue the task");
  assert.deepEqual(fixture.errors, ["Session directory unavailable", "Clone failed", "Queue unavailable"]);
});

test("Guardian controls route immediately through prompt while idle, active, and Alt+Enter", async () => {
  for (const command of ["/guardian", "/guardian status", "/guardian off"]) {
    const fixture = editorFixture();
    const delivered = [];
    fixture.mode.runtimeHost.session.isStreaming = true;
    fixture.mode.runtimeHost.session.prompt = async (...args) => delivered.push(args);
    fixture.mode.handleGuardianCommand = async (text) => fixture.mode.runtimeHost.session.prompt(text);
    await fixture.mode.defaultEditor.onSubmit(command);
    assert.deepEqual(delivered, [[command]]);
    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.queued, []);
  }

  const fixture = editorFixture();
  const delivered = [];
  fixture.mode.runtimeHost.session.isStreaming = true;
  fixture.mode.runtimeHost.session.prompt = async (...args) => delivered.push(args);
  fixture.mode.handleGuardianCommand = async (text) => fixture.mode.runtimeHost.session.prompt(text);
  fixture.mode.editor.getText = () => fixture.mode._guardianTestText ?? "";
  fixture.mode.editor.getExpandedText = () => fixture.mode._guardianTestText ?? "";
  fixture.mode.editor.setText = (text) => { fixture.mode._guardianTestText = text; };
  fixture.mode._guardianTestText = "/guardian off";
  await fixture.mode.handleFollowUp();
  assert.deepEqual(delivered, [["/guardian off"]]);
  assert.deepEqual(fixture.prompts, []);
  assert.deepEqual(fixture.queued, []);
});

test("extension commands with whitespace arguments run immediately while compacting or streaming", async () => {
  const fixture = editorFixture();
  fixture.mode.session.isCompacting = true;
  await fixture.mode.defaultEditor.onSubmit("/fixture\targument");
  fixture.mode.session.isCompacting = false;
  fixture.mode.session.isStreaming = true;
  await fixture.mode.defaultEditor.onSubmit("/fixture\nargument");
  assert.deepEqual(fixture.prompts, [
    ["/fixture\targument"],
    ["/fixture\nargument", { streamingBehavior: "steer" }],
  ]);
  assert.deepEqual(fixture.queued, []);
  assert.deepEqual(fixture.errors, []);
});

test("extension dispatch preserves multiline args and reports handler failure once", async () => {
  const calls = [], errors = [];
  const ctx = { marker: true };
  const session = {
    _extensionRunner: {
      getCommand: (name) => name === "fixture" ? { handler: async (...args) => { calls.push(args); } }
        : name === "broken" ? { handler: async () => { throw new Error("Command failed"); } } : undefined,
      createCommandContext: () => ctx,
      emitError: (error) => errors.push(error),
    },
  };
  for (const separator of [" ", "\t", "\n", "\u00a0"]) {
    assert.equal(await AgentSession.prototype._tryExecuteExtensionCommand.call(session, `/fixture${separator}first\nsecond`), true);
  }
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ["first\nsecond", ctx]));
  assert.equal(await AgentSession.prototype._tryExecuteExtensionCommand.call(session, "/unknown"), false);
  assert.equal(await AgentSession.prototype._tryExecuteExtensionCommand.call(session, "/broken"), true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, "Command failed");
});

test("skills and prompt templates use the same whitespace command boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-command-"));
  try {
    const filePath = path.join(dir, "SKILL.md");
    fs.writeFileSync(filePath, "---\nname: fixture\n---\nSkill instructions.\n");
    const session = { resourceLoader: { getSkills: () => ({ skills: [{ name: "fixture", filePath, baseDir: dir }] }) } };
    const result = AgentSession.prototype._expandSkillCommand.call(session, "/skill:fixture\tfirst\nsecond");
    assert.ok(result.includes("Skill instructions."));
    assert.ok(result.endsWith("\n\nfirst\nsecond"));
    assert.equal(expandPromptTemplate("/fixture\tfirst\nsecond", [{ name: "fixture", content: "$1 then $2" }]), "first then second");
    assert.equal(parseSlashCommand("/"), undefined);
    assert.equal(parseSlashCommand("plain text"), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command registration validates callable entries and preserves registered identity", async () => {
  const extension = await loadExtensionFromFactory((api) => {
    for (const name of ["", "/wrong", "two words", "tab\tname", "line\nname"]) {
      assert.throws(() => api.registerCommand(name, { handler() {} }), /Command names/);
    }
    assert.throws(() => api.registerCommand("missing", {}), /handler function/);
    api.registerCommand("fixture", { name: "forged", sourceInfo: { path: "forged" }, handler() {} });
  }, process.cwd(), createEventBus(), createExtensionRuntime(), "<command-test>");
  assert.equal(extension.commands.size, 1);
  assert.equal(extension.commands.get("fixture").name, "fixture");
  assert.equal(extension.commands.get("fixture").sourceInfo.path, "<command-test>");
});

test("duplicate extension names remain callable and builtin conflicts retain explicit diagnostics", () => {
  const makeExtension = (name) => ({ commands: new Map([[name, { name, handler() {}, sourceInfo: { path: "fixture" } }]]) });
  const runner = new ExtensionRunner([makeExtension("fixture"), makeExtension("fixture"), makeExtension("settings")], {}, process.cwd(), {}, {});
  assert.ok(runner.getCommand("fixture:1"));
  assert.ok(runner.getCommand("fixture:2"));
  assert.equal(runner.getCommand("fixture"), undefined);
  const diagnostics = InteractiveMode.prototype.getBuiltInCommandConflictDiagnostics.call({}, runner);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /settings.*conflicts with built-in/);
});


test("extension error delivery survives throwing listeners and logs only safe metadata", async () => {
  const runner = new ExtensionRunner([], {}, process.cwd(), {}, {});
  const seen = [], health = [];
  const key = Symbol.for("yunus-pi.health.v1");
  const previous = globalThis[key];
  const error = { event: "command", extensionPath: "/private/work/fixture.ts", error: "Synthetic private message" };
  globalThis[key] = (...args) => health.push(args);
  try {
    runner.onError(() => { throw new Error("Broken listener"); });
    runner.onError(async () => { throw new Error("Broken async listener"); });
    runner.onError((value) => seen.push(value));
    assert.doesNotThrow(() => runner.emitError(error));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [error]);
    assert.deepEqual(health, [["hook.error", { hook: "command", owner: "fixture.ts", isError: true }]]);
    globalThis[key] = () => { throw new Error("Telemetry unavailable"); };
    assert.doesNotThrow(() => runner.emitError(error));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 2);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("context request indices are recomputed after earlier handlers insert messages", async () => {
  const requestMeta = Symbol.for("yunuspi.guardian.request-meta.v1");
  const userMessage = { role: "user", content: [{ type: "text", text: "review this" }] };
  Object.defineProperty(userMessage, requestMeta, { value: { requestId: "request-a", turnId: "turn-a" }, enumerable: false });
  let laterEvent;
  const first = { handlers: new Map([["context", [async (event) => ({ messages: [{ role: "custom", content: [] }, ...event.messages] })]]]) };
  const later = { handlers: new Map([["context", [async (event) => { laterEvent = event; }]]]) };
  const runner = new ExtensionRunner([first, later], {}, process.cwd(), {}, {});
  runner.createContext = () => ({});

  const output = await runner.emitContext([userMessage], {
    requestMessages: [{ requestId: "request-a", turnId: "turn-a", messageIndex: 0 }],
    requestId: "request-a",
    turnId: "turn-a",
    requestMessageIndex: 0,
  });

  assert.equal(laterEvent.requestMessageIndex, 1);
  assert.deepEqual(laterEvent.requestMessages, [{ requestId: "request-a", turnId: "turn-a", messageIndex: 1 }]);
  assert.equal(output[1].role, "user");
  assert.equal(Object.keys(output[1]).includes(String(requestMeta)), false);
  assert.equal(structuredClone(output).flatMap((message) => Object.getOwnPropertySymbols(message)).length, 0);
});


test("an unavailable single-token command never becomes a model prompt or queued message", async () => {
  for (const state of [{}, { isStreaming: true }, { isCompacting: true }]) {
    const fixture = editorFixture();
    Object.assign(fixture.mode.session, state);
    await fixture.mode.defaultEditor.onSubmit("/used");
    assert.equal(fixture.errors.length, 1);
    assert.match(fixture.errors[0], /Unknown command '\/used'.*\/reload/);
    assert.deepEqual(fixture.inputs, []);
    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.queued, []);
  }
});

test("unknown-command checks preserve extension commands, templates, skills, paths and ordinary prose", async () => {
  const fixture = editorFixture();
  fixture.mode.session.promptTemplates.push({ name: "fixture-template" });
  for (const input of ["/fixture", "/fixture-template", "/skill:example", "/tmp", "/unavailable/file.txt", "/a prose prompt"]) {
    await fixture.mode.defaultEditor.onSubmit(input);
  }
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.inputs, ["/fixture", "/fixture-template", "/skill:example", "/tmp", "/unavailable/file.txt", "/a prose prompt"]);
});


test("follow-up keyboard submission uses command routing while busy and preserves ordinary queue behavior", async () => {
  for (const state of [{ isStreaming: true }, { isCompacting: true }]) {
    const fixture = editorFixture();
    Object.assign(fixture.mode.session, state);
    for (const text of ["/model\tprovider/model", "/used"]) {
      fixture.mode.editor.getText = () => text;
      await fixture.mode.handleFollowUp();
    }
    assert.deepEqual(fixture.calls, [{ method: "handleModelCommand", args: ["provider/model"] }]);
    assert.equal(fixture.errors.length, 1);
    assert.match(fixture.errors[0], /Unknown command/);
    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.queued, []);
    fixture.mode.session.promptTemplates.push({ name: "fixture-template" });
    fixture.mode.editor.getText = () => "/fixture-template";
    await fixture.mode.handleFollowUp();
    if (state.isStreaming) assert.deepEqual(fixture.prompts, [["/fixture-template", { streamingBehavior: "followUp" }]]);
    else assert.deepEqual(fixture.queued, [["/fixture-template", "followUp"]]);
  }
});

test("follow-up queue failures are shown without unhandled rejection", async () => {
  const fixture = editorFixture();
  fixture.mode.session.isStreaming = true;
  fixture.mode.editor.getText = () => "Follow up text";
  fixture.mode.session.prompt = async () => { throw new Error("Follow-up unavailable"); };
  await fixture.mode.handleFollowUp();
  assert.deepEqual(fixture.errors, ["Follow-up unavailable"]);
});

test("the registered /run command retains multiline task text and accepts whitespace execution flags", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-slash-run-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  let registration, runtime;
  try {
    const { registerSlashCommands } = await import("../agent/extensions/pi-subagents/src/slash/slash-commands.ts");
    const { registerRuntimeAgent } = await import("../agent/extensions/pi-subagents/src/agents/runtime-agent-registry.ts");
    const commands = new Map(), requests = [], notices = [];
    const events = createEventBus();
    const pi = { events, on() {}, registerTool() {}, registerShortcut() {}, sendMessage() {},
      registerCommand: (name, command) => commands.set(name, command),
    };
    const ctx = { cwd: dir, hasUI: false, ui: { notify: text => notices.push(text) }, sessionManager: { getSessionFile: () => undefined } };
    runtime = registerRuntimeAgent({ pi, name: "command-fixture", definition: { description: "Synthetic fixture", systemPrompt: "Synthetic instructions" } });
    registration = registerSlashCommands(pi, { baseCwd: dir });
    events.on("subagent:slash:request", ({ requestId, params }) => {
      requests.push(params);
      events.emit("subagent:slash:started", { requestId });
      events.emit("subagent:slash:response", { requestId, isError: false, result: { content: [], details: { mode: "single", results: [] } } });
    });
    await commands.get("run").handler("command-fixture\tFirst task line\nSecond task line\n--bg\t--fork", ctx);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notices, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].async, true);
    const child = new Function("runs", requests[0].workflowScript)({ run: (_key, value) => value });
    assert.equal(child.agent, "command-fixture");
    assert.equal(child.task, "First task line\nSecond task line");
    assert.equal(child.context, "fork");
  } finally {
    registration?.dispose();
    runtime?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
