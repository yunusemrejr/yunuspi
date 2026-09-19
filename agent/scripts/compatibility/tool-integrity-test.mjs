import {resolveOwnedCore} from '../lib/owned-core.mjs';
// Offline: real SDK/tool execution with scripted assistant messages, plus boundaries.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
const core = resolveOwnedCore();
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export function resolve(n,c,next){const base=${JSON.stringify(core)};if(n==='@yunuspi/coding-agent')return {url:'file://'+base+'/dist/index.js',shortCircuit:true};if(n==='@yunuspi/ai')return {url:'file://'+base+'/../ai/dist/index.js',shortCircuit:true};return next(n,c);}`,
    ),
  import.meta.url,
);
const {
  default: safety,
  invalidMutationPath,
  invalidShellPath,
  writeDegeneration,
} = await import("../../extensions/filesystem-safety.ts");
const { pressureFacts, payloadPressureWarning, truncationDiagnostic } =
  await import("../../extensions/lib/session-signals.ts");
const { default: signals } = await import(
  "../../extensions/session-signals.ts"
);

for (const control of [
  "\n",
  "\r",
  "\t",
  "\0",
  "\x1b",
  "\x7f",
  "\x85",
  "\u2028",
]) {
  assert.match(
    invalidMutationPath(`file${control}.md`),
    /invalid filesystem path/,
  );
  assert.ok(
    !invalidMutationPath(`file${control}.md`).includes(control),
    "error escapes control bytes",
  );
}
assert.equal(invalidMutationPath("ordinary file 🦄.md"), undefined);
for (const command of [
  "touch 'bad\nfile'",
  'printf ok > "bad\nfile"',
  "mkdir $'bad\\nfile'",
  "cp good $'bad\\x0afile'",
  "mv good $'bad\\012file'",
  "touch $'bad\\u000afile'",
  "P=$'bad\\rfile'; touch \"$P\"",
  "touch bad\\\tfile",
  'touch "\\$(literal\n)"',
  "cat < $'bad\\nfile'",
])
  assert.match(invalidShellPath(command), /invalid filesystem path/, command);
for (const command of [
  "printf 'hello\nworld'",
  "echo hi\nprintf bye",
  "touch 'normal file.md'",
  "cat <<<'hello\nworld'",
  "stat --printf 'name=%n\n' file",
  "stat --printf='name=%n\n' file",
  "stat -c 'name=%n\n' file",
  "touch \"$(printf 'safe\n')\"",
  "touch \"`printf 'safe\n'`\"",
  "printf '%s\\n' hello > output.md",
  "touch escaped\\\ncontinuation",
  "P=$'bad\\nfile'; touch '$P'",
  "P=$'bad\\nfile'; touch \"\\$P\"",
  "echo 🦄; cat <<'EOF' > output.md\ntouch 'bad\nfile'\nEOF\n",
  "cat <<'EOF' > output.md\ntouch 'bad\nfile'\nEOF\n",
  "python3 - <<'PY'\nprint('not a path\\n')\nPY\n",
])
  assert.equal(invalidShellPath(command), undefined, command);
const repeated = "This is a substantive line repeated accidentally.";
assert.equal(writeDegeneration((repeated + "\n").repeat(3)), undefined);
const prefix = "A distinct substantive repeated line prefix. "
  .repeat(3)
  .slice(0, 100);
assert.equal(
  writeDegeneration(`${prefix}one\nx\n${prefix}two\ny\n${prefix}three`),
  undefined,
  "distinct lines sharing a long prefix are not degeneration",
);
assert.equal(writeDegeneration(`${prefix}\nx\n${prefix}\ny\n${prefix}`), undefined);
assert.match(writeDegeneration((prefix + "\n").repeat(200)), /85%/);
for (const text of [
  "- [ ]\n".repeat(40),
  "\n".repeat(8),
  "}\n".repeat(8),
  "box-shadow: " + "0 0 ".repeat(300),
  "— the/→ the ".repeat(500),
])
  assert.equal(writeDegeneration(text), undefined);

const hooks = {},
  tools = {},
  pressureMessages = [];
signals({
  on: (name, fn) => (hooks[name] = fn),
  registerCommand() {},
  registerTool: (tool) => (tools[tool.name] = tool),
  getActiveTools: () => Object.keys(tools),
  sendMessage: (message, options) => pressureMessages.push({ message, options }),
});
let tokens = 9000;
const ctx = {
  cwd: process.cwd(),
  sessionManager: {
    getSessionId: () => "integrity-test",
    getHeader: () => undefined,
  },
  model: {
    provider: "cerebras",
    id: "qwen-3.8-27b",
    contextWindow: 100000,
    maxTokens: 65536,
  },
  getContextUsage: () => ({
    tokens,
    compactionSettings: {
      enabled: true,
      reserveTokens: 1000,
      maxContextTokens: 10000,
    },
  }),
};
assert.equal(pressureFacts(ctx, {}).percent, 9);
tokens = 11190;
assert.equal(pressureFacts(ctx, {}).percent, 11.19);
assert.equal(pressureFacts(ctx, {}).remaining, 55618);
assert.equal(pressureFacts(ctx, {}).overBudgetTokens, 0);
assert.equal(payloadPressureWarning(89.9), undefined);
assert.match(payloadPressureWarning(90), /malformed JSON, corrupted paths/);
// Pressure guidance is delivered by the turn owner; the context hook removes
// legacy injected messages to preserve the reusable prompt prefix.
assert.equal(hooks.context({messages:[]},ctx),undefined);
const context=hooks.context({messages:[{role:"custom",customType:"tool-payload-risk",content:"old warning"}]},ctx);
assert.deepEqual(context.messages,[]);
assert.equal(hooks.context(context,ctx),undefined);
tokens = 5000;
const payloadAtHook = { max_tokens: 32768 };
hooks.before_provider_request({ payload: payloadAtHook }, ctx);
payloadAtHook.max_tokens = 8192; // A later hook can change what is actually sent.
const ended = hooks.message_end({
  message: {
    role: "assistant",
    provider: "cerebras",
    model: ctx.model.id,
    stopReason: "length",
    content: [],
  },
});
assert.match(ended.message.errorMessage, /request-hook maxTokens=32768/);
assert.match(
  ended.message.errorMessage,
  /not attested from the final wire payload/,
);
assert.match(ended.message.errorMessage, /later payload hooks/);
assert.match(ended.message.errorMessage, /configured model maxTokens=65536/);
assert.match(
  truncationDiagnostic(
    { provider: "another", model: "same" },
    { provider: "cerebras", model: "same", cap: 8192 },
  ),
  /maxTokens=unavailable/,
);

// Auxiliary requests share the hook runner, whose ctx still names the primary
// model. Their small output caps must not replace primary request evidence.
hooks.before_provider_request({ payload: { model: ctx.model.id, max_tokens: 16384 } }, ctx);
hooks.before_provider_request({ payload: { model: "auxiliary-reviewer", max_tokens: 32 } }, ctx);
let observedContext = await tools.session_self.execute("cap", { view: "context" }, null, null, ctx);
assert.equal(observedContext.details.outputReservation, 16384);
assert.match(hooks.message_end({ message: {
  role: "assistant", provider: ctx.model.provider, model: ctx.model.id,
  stopReason: "length", content: [],
} }).message.errorMessage, /request-hook maxTokens=16384/);
const configuredReservation = pressureFacts(ctx, {}).outputReservation;
for (const invalidCap of [-1, 0, 1.5, NaN, Infinity, "4096"]) {
  hooks.before_provider_request({ payload: { model: ctx.model.id, max_tokens: invalidCap } }, ctx);
  observedContext = await tools.session_self.execute("cap", { view: "context" }, null, null, ctx);
  assert.equal(observedContext.details.outputReservation, configuredReservation,
    `invalid output cap ${String(invalidCap)} uses the configured reservation`);
  assert.match(hooks.message_end({ message: {
    role: "assistant", provider: ctx.model.provider, model: ctx.model.id,
    stopReason: "length", content: [],
  } }).message.errorMessage, /request-hook maxTokens=unavailable/);
}

// High context cannot wake canceled, failed or intentionally terminated work.
// A skipped notice must remain available for the next continuing tool turn.
tokens = 90000;
const continuingTurn = {
  message: { role: "assistant", stopReason: "toolUse" },
  toolResults: [{ toolCallId: "pressure-tool" }],
};
for (const stopReason of ["stop", "error", "aborted", "length"]) {
  hooks.model_select({}, ctx);
  hooks.turn_start({}, ctx);
  const before = pressureMessages.length;
  hooks.turn_end({ ...continuingTurn, message: { role: "assistant", stopReason } }, ctx);
  assert.equal(pressureMessages.length, before, `${stopReason} must not queue a pressure steer`);
  hooks.turn_end(continuingTurn, ctx);
  assert.equal(pressureMessages.length, before + 1);
}
hooks.model_select({}, ctx);
hooks.turn_start({}, ctx);
let pressureBefore = pressureMessages.length;
hooks.turn_end(continuingTurn, { ...ctx, signal: { aborted: true } });
assert.equal(pressureMessages.length, pressureBefore, "aborted signal stays quiet");
hooks.turn_end(continuingTurn, ctx);
assert.equal(pressureMessages.length, pressureBefore + 1);
hooks.model_select({}, ctx);
hooks.turn_start({}, ctx);
hooks.tool_execution_end({ toolCallId: "pressure-tool", result: { terminate: true } }, ctx);
pressureBefore = pressureMessages.length;
hooks.turn_end(continuingTurn, ctx);
assert.equal(pressureMessages.length, pressureBefore, "terminating tool stays quiet");
hooks.turn_start({}, ctx);
hooks.turn_end(continuingTurn, ctx);
assert.equal(pressureMessages.length, pressureBefore + 1,
  "termination is turn-local; next continuing turn can receive pressure notice");
assert.deepEqual(pressureMessages.at(-1).options, { deliverAs: "steer" });
assert.match(pressureMessages.at(-1).message.content, /context pressure/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-integrity-"));
process.env.PI_OFFLINE = "1";
const sdk = await import(pathToFileURL(path.join(core, "dist/index.js")));
const ai = await import(
  pathToFileURL(
    path.join(core, "../ai/dist/index.js"),
  )
);
let session;
try {
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: path.join(root, "models.json"),
    modelsStorePath: path.join(root, "store.json"),
  });
  await modelRuntime.setRuntimeApiKey("openai", "offline-test-only");
  const model = {
    id: "integrity-test",
    name: "Test",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/never",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const settings = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      safety,
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.input.path === "rewritten-by-hook.md")
            event.input.path = "bad\nlate-hook";
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(root),
    resourceLoader: loader,
    tools: ["read", "write", "edit", "bash"],
  }));
  await session.bindExtensions({});
  const call = (id, name, args) => [
    { type: "toolCall", id, name, arguments: args },
  ];
  const payloads = [
    call("bad-path", "write", { path: "bad\nparameter>", content: "no" }),
    call("bad-edit", "edit", {
      path: "bad\nparameter>",
      edits: [{ oldText: "no", newText: "yes" }],
    }),
    call("repeat", "write", {
      path: "repeated.md",
      content: (prefix + "\n").repeat(200),
    }),
    call("bad-bash", "bash", { command: "touch $'bad\\nvia-shell'" }),
    call("late-path", "write", {
      path: "rewritten-by-hook.md",
      content: "must not land",
    }),
    call("late-edit", "edit", {
      path: "rewritten-by-hook.md",
      edits: [{ oldText: "old", newText: "new" }],
    }),
    call("good", "write", { path: "normal name.md", content: "hello 🦄\n" }),
    call("edit", "edit", {
      path: "normal name.md",
      edits: [{ oldText: "hello", newText: "goodbye" }],
    }),
    [{ type: "text", text: "done" }],
  ];
  let step = 0;
  session.agent.streamFunction = () => {
    const content = payloads[step++];
    assert.ok(content, "unexpected inference");
    const message = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: content.some((p) => p.type === "toolCall")
        ? "toolUse"
        : "stop",
      timestamp: Date.now(),
    };
    const stream = new ai.AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  await session.prompt("Exercise offline tool boundaries.");
  const results = session.sessionManager
    .getBranch()
    .filter((e) => e.type === "message" && e.message.role === "toolResult")
    .map((e) => e.message);
  assert.equal(results.length, 8);
  assert.ok(
    results.slice(0, 6).every((r) => r.isError),
    "late hook mutations must be rechecked at the write/edit execution boundary",
  );
  assert.match(
    results[5].content.map((p) => p.text).join("\n"),
    /invalid filesystem path/,
    "late edit fails on path validation, not merely missing file",
  );
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name !== "store.json"),
    ["normal name.md"],
  );
  assert.equal(
    fs.readFileSync(path.join(root, "normal name.md"), "utf8"),
    "goodbye 🦄\n",
  );
  for (const result of results.slice(6)) {
    assert.equal(result.isError, false);
    assert.match(
      result.content.map((p) => p.text).join("\n"),
      /path="normal name.md"/,
    );
    assert.equal(typeof result.details.fileMutation.bytes, "number");
  }
  console.log(
    "PASS real SDK rejects corrupted write/edit/bash paths and degeneration without mutations; receipts, pressure and cap attribution",
  );
} finally {
  session?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
