import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const template = path.resolve(import.meta.dirname, "..");
const agent = [
  path.join(template, "agent"),
  path.resolve(template, ".."),
].find((candidate) =>
  fs.existsSync(path.join(candidate, "extensions/lib/session-signals.ts")),
);
assert.ok(agent, "public template resolves the session signal extension");

// CI installs the pinned SDK in this checkout. Only private live installs
// need the global fallback; pi-ai may be hoisted or nested under that SDK.
let coreUrl;
try { coreUrl = import.meta.resolve("@yunuspi/coding-agent"); }
catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  coreUrl = pathToFileURL(path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@yunuspi/coding-agent/dist/index.js",
  )).href;
}
register(
  `data:text/javascript,${encodeURIComponent(
    `const core=${JSON.stringify(coreUrl)};export function resolve(name,context,next){if(name==="@yunuspi/coding-agent")return {url:core,shortCircuit:true};return next(name,name==="@yunuspi/ai"?{...context,parentURL:core}:context);}`,
  )}`,
  import.meta.url,
);

const {
  payloadPressureWarning,
  pressureFacts,
} = await import(pathToFileURL(path.join(agent, "extensions/lib/session-signals.ts")));
const { default: registerSignals } = await import(
  pathToFileURL(path.join(agent, "extensions/session-signals.ts")),
);

function contextFixture({
  window = 1_000_000,
  tokens = 95_138,
  compactionSettings,
} = {}) {
  return {
    model: {
      provider: "fixture",
      id: "full-window",
      contextWindow: window,
      maxTokens: 4096,
    },
    getContextUsage: () => ({ tokens, compactionSettings }),
  };
}

function signalFixture({ window = 1_000_000, tokens = 900_000 } = {}) {
  const hooks = new Map();
  const tools = new Map();
  const sent = [];
  const pi = {
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    sendMessage(...args) {
      sent.push(args);
    },
  };
  registerSignals(pi);
  const ctx = {
    ...contextFixture({ window, tokens }),
    cwd: "/fixture",
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "signal-diagnostics",
      getHeader: () => undefined,
    },
  };
  return {
    ctx,
    hooks,
    sent,
    tools,
    emit(name, event = {}, context = ctx) {
      return hooks.get(name)?.(event, context);
    },
  };
}

test("context diagnostics use the selected model full window and ignore legacy caps", () => {
  const facts = pressureFacts(
    contextFixture(),
    { enabled: true, maxContextTokens: 96_000, reserveTokens: 16_384 },
  );
  assert.equal(facts.available, true);
  assert.equal(facts.contextWindow, 1_000_000);
  assert.equal(facts.contextWindowPercent, 9.5138);
  assert.equal(facts.percent, 9.5138);
  assert.equal(facts.compactionTrigger, 800_000);
  assert.equal(facts.compaction, 800_000);
  assert.equal(facts.compactionSettings.maxContextTokens, undefined);
  assert.ok(facts.usablePercent > facts.contextWindowPercent);
  assert.equal(payloadPressureWarning(89.9), undefined);
  assert.match(payloadPressureWarning(90), /selected model context window/);
});

test("legacy 96k pressure no longer warns on a one-million-token model window", () => {
  const fixture = signalFixture({ tokens: 95_138 });
  fixture.emit("session_start");
  const result = fixture.emit("before_agent_start", { systemPrompt: "fixture" });
  assert.equal(result.message, undefined);
  assert.equal(pressureFacts(fixture.ctx, {}).contextWindowPercent, 9.5138);
});

test("diagnostics mark invalid model windows and usage unavailable", () => {
  for (const window of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const facts = pressureFacts(contextFixture({ window }), {});
    assert.equal(facts.available, false);
    assert.match(facts.reason, /context window unavailable/);
  }
  const undefinedWindow = contextFixture();
  undefinedWindow.model.contextWindow = undefined;
  const unavailable = pressureFacts(undefinedWindow, {});
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /context window unavailable/);
  for (const tokens of [Number.NaN, Number.POSITIVE_INFINITY, -1, "100"]) {
    const facts = pressureFacts(contextFixture({ tokens }), {});
    assert.equal(facts.available, false);
    assert.equal(facts.contextWindowPercent, null);
    assert.equal(facts.percent, null);
    assert.equal(facts.usablePercent, null);
  }
});

test("context projection removes owned pressure lines across repeated projections and lifecycle resets", () => {
  const fixture = signalFixture();
  fixture.emit("session_start");
  const first = fixture.emit("before_agent_start", { systemPrompt: "fixture" });
  assert.ok(first?.message?.details?.tag, "pressure message carries an internal generation tag");

  const current = { role: "custom", ...first.message };
  assert.equal(
    fixture.emit("context", { messages: [current] }),
    undefined,
    "current-generation pressure remains available to the model",
  );

  const legacy = {
    role: "custom",
    customType: "runtime-signals",
    content: "[context pressure] legacy reminder\nkeep this diagnostic line",
  };
  const persisted = { messages: [legacy] };
  const projected = fixture.emit("context", persisted);
  assert.equal(projected.messages[0].content, "keep this diagnostic line");
  const projectedAgain = fixture.emit("context", persisted);
  assert.equal(projectedAgain.messages[0].content, "keep this diagnostic line");

  fixture.emit("session_compact");
  const afterCompaction = fixture.emit("context", { messages: [current] });
  assert.deepEqual(afterCompaction.messages, []);

  fixture.emit("model_select");
  const next = fixture.emit("before_agent_start", { systemPrompt: "fixture" });
  assert.ok(next?.message?.details?.tag);
  assert.equal(
    fixture.emit("context", { messages: [{ role: "custom", ...next.message }] }),
    undefined,
    "a new model generation keeps its own pressure notice",
  );
});
