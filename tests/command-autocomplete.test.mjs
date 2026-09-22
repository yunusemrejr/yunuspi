import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../core/coding-agent/src/core/sdk.js";
import { DefaultResourceLoader } from "../core/coding-agent/src/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/src/core/settings-manager.js";
import { KeybindingsManager } from "../core/coding-agent/src/core/keybindings.js";
import { BUILTIN_SLASH_COMMANDS } from "../core/coding-agent/src/core/slash-commands.js";
import { InteractiveMode } from "../core/coding-agent/src/modes/interactive/interactive-mode.js";
import { CustomEditor } from "../core/coding-agent/src/modes/interactive/components/custom-editor.js";
import { CombinedAutocompleteProvider } from "../core/tui/src/autocomplete.js";

const identity = text => text;
const editorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };

// Real CustomEditor, production autocomplete registration, interactive submit,
// SDK session and extension runner. Only terminal I/O, modal UIs and the model
// transport are simulated; an accidental paid-prompt path increments requests.
async function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "command-autocomplete-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const commands = [], errors = [], submitted = [], inputs = [], tasks = [], builtin = [];
  const settingsManager = SettingsManager.inMemory({ enableSkillCommands: false,
    compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [api => {
      for (const name of ["used", "user"]) api.registerCommand(name, {
        description: `Fixture ${name}`,
        handler: async args => { commands.push({ name, args }); },
        getArgumentCompletions: prefix => [{ value: prefix.startsWith("/") ? "/chosen" : "detail", label: "detail" }],
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "audit",
    baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
  let requests = 0;
  const modelRuntime = {
    getModel: () => model, getAvailable: () => [model], getAvailableSnapshot: () => [model],
    hasConfiguredAuth: () => true, isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
    streamSimple() {
      requests++;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: "text", text: "Fixture response" }], stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
    },
  };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "interactive", onError: error => errors.push(error) });
  const ui = { requestRender() {}, terminal: { rows: 30, columns: 100 } };
  const editor = new CustomEditor(ui, editorTheme, new KeybindingsManager());
  const mode = Object.create(InteractiveMode.prototype);
  Object.assign(mode, { runtimeHost: { session }, ui, defaultEditor: editor, editor,
    skillCommands: new Map(), fdPath: null,
    showError: error => errors.push(error), flushPendingBashComponents() {},
    onInputCallback: text => { inputs.push(text); tasks.push(session.prompt(text)); },
    showSettingsSelector: () => builtin.push({ name: "settings" }),
    handleModelCommand: args => builtin.push({ name: "model", args }),
  });
  editor.setAutocompleteProvider(mode.createBaseAutocompleteProvider());
  mode.setupEditorSubmitHandler();
  const onSubmit = editor.onSubmit;
  editor.onSubmit = text => { submitted.push(text); tasks.push(onSubmit(text)); };
  async function key(data) {
    editor.handleInput(data);
    await editor.autocompleteRequestTask;
    await Promise.all(tasks);
  }
  async function type(text) { for (const char of text) await key(char); }
  return { editor, mode, session, cwd, commands, errors, submitted, inputs, builtin, key, type, requests: () => requests };
}

for (const text of ["/use", "/used", "  /used"]) test(`Enter accepts the first selected extension command for ${JSON.stringify(text)}`, async t => {
  const f = await fixture(t);
  await f.type(text);
  assert.equal(f.editor.autocompleteList.getSelectedItem().value, "used");
  assert.ok(f.editor.render(100).some(line => line.includes("used")));
  await f.key("\r");
  assert.deepEqual(f.submitted, ["/used"]);
  assert.deepEqual(f.commands, [{ name: "used", args: "" }]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests(), 0);
});

test("Enter executes the selected command after keyboard navigation", async t => {
  const f = await fixture(t);
  await f.type("/use");
  await f.key("\x1b[B");
  assert.equal(f.editor.autocompleteList.getSelectedItem().value, "user");
  await f.key("\r");
  assert.deepEqual(f.commands, [{ name: "user", args: "" }]);
  assert.equal(f.requests(), 0);
});

test("Tab accepts exact commands without submitting, then Enter preserves arguments", async t => {
  const f = await fixture(t);
  await f.type("/used");
  await f.key("\t");
  assert.equal(f.editor.getText(), "/used ");
  assert.deepEqual(f.submitted, []);
  await f.type("de");
  await f.key("\r");
  assert.equal(f.editor.getText(), "/used detail");
  assert.deepEqual(f.submitted, [], "argument acceptance edits without submitting");
  await f.key("\r");
  assert.deepEqual(f.commands, [{ name: "used", args: "detail" }]);
  assert.equal(f.requests(), 0);
});

test("builtin command acceptance reaches interactive dispatch without a model turn", async t => {
  const f = await fixture(t);
  for (const text of ["/sett", "/settings", "  /settings"]) {
    await f.type(text);
    assert.equal(f.editor.autocompleteList.getSelectedItem().value, "settings");
    await f.key("\r");
  }
  assert.deepEqual(f.builtin, Array.from({ length: 3 }, () => ({ name: "settings" })));
  assert.deepEqual(f.inputs, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.requests(), 0);
});

test("command arguments use whitespace boundaries and retain indentation", async t => {
  const f = await fixture(t);
  for (const separator of [" ", "  ", "\t", "\u00a0"]) {
    const input = `  /model${separator}au`;
    const provider = new CombinedAutocompleteProvider([{ name: "model", getArgumentCompletions: prefix => {
      assert.equal(prefix, "au");
      return [{ value: "audit/fixture", label: "fixture" }];
    } }], f.cwd);
    const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
    const result = provider.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix);
    assert.equal(result.lines[0], `  /model${separator}audit/fixture`);
  }
  await f.type("  /model\u00a0au");
  assert.equal(f.editor.autocompleteList.getSelectedItem().value, "audit/fixture");
  await f.key("\r");
  assert.deepEqual(f.submitted, []);
  await f.key("\r");
  assert.deepEqual(f.builtin, [{ name: "model", args: "audit/fixture" }]);
  assert.equal(f.requests(), 0);
});

test("slash-prefixed arguments are completed without submitting the command", async t => {
  const f = await fixture(t);
  await f.type("/used /ch");
  await f.key("\r");
  assert.equal(f.editor.getText(), "/used /chosen");
  assert.deepEqual(f.submitted, []);
  await f.key("\r");
  assert.deepEqual(f.commands, [{ name: "used", args: "/chosen" }]);
  assert.equal(f.requests(), 0);
});

test("completing a command before existing arguments preserves its separator", async t => {
  const f = await fixture(t);
  f.editor.setText("/used detail");
  await f.key("\x01"); // Ctrl+A to start; right to the command boundary.
  for (let n = 0; n < 5; n++) await f.key("\x1b[C");
  await f.key("\t");
  assert.equal(f.editor.autocompleteList.getSelectedItem().value, "used");
  await f.key("\r");
  assert.deepEqual(f.submitted, ["/used detail"]);
  assert.deepEqual(f.commands, [{ name: "used", args: "detail" }]);
  assert.equal(f.requests(), 0);
});

test("absolute path selection does not submit and ordinary prompts remain model inputs", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "one.txt"), "one");
  fs.writeFileSync(path.join(f.cwd, "other.txt"), "other");
  f.editor.setText(`${f.cwd}/o`);
  await f.key("\t");
  assert.equal(f.editor.isShowingAutocomplete(), true);
  await f.key("\r");
  assert.ok(f.editor.getText().startsWith(`${f.cwd}/o`));
  assert.deepEqual(f.submitted, []);
  f.editor.setText("");
  await f.type("use this ordinary prompt");
  await f.key("\r");
  assert.deepEqual(f.inputs, ["use this ordinary prompt"]);
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.commands, []);
});

test("every advertised builtin preserves its slash for exact provider acceptance", () => {
  const provider = new CombinedAutocompleteProvider(BUILTIN_SLASH_COMMANDS, process.cwd());
  for (const { name } of BUILTIN_SLASH_COMMANDS) {
    const input = `/${name}`;
    assert.equal(provider.applyCompletion([input], 0, input.length, { value: name, label: name }, input).lines[0], `${input} `);
  }
});
