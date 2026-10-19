import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-route-propagation-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, "settings", "llm_preferences.json");
process.env.HOME = root;
delete process.env.PI_AUTONOMOUS_MODEL_FALLBACK;
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
fs.mkdirSync(path.dirname(process.env.PI_LLM_PREFERENCES_FILE), { recursive: true });

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find(p =>
  fs.existsSync(path.join(p, "extensions/pi-subagents/src/runs/shared/session-model.ts")),
);
assert.ok(agent, "pi-subagents source must exist");
const shared = pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/")).href;
const prefs = await import(shared + "llm-preferences.ts");
const piArgs = await import(shared + "pi-args.ts");
const promptRuntime = await import(shared + "subagent-prompt-runtime.ts");
const modelRoute = await import(shared + "../../shared/model-route.ts");
const { runSync } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/foreground/execution.ts")).href);

after(() => fs.rmSync(root, { recursive: true, force: true }));

const route = "openrouter/org/model-a";
const model = { provider: "openrouter", id: "org/model-a", fullId: route, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoning: true, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 } };
const registry = [model];
const together = { only: ["together"], order: ["together"], allow_fallbacks: false };
const friendli = { only: ["friendli"], order: ["friendli"], allow_fallbacks: false };

test("the session route candidate keeps its provider pin through launch encoding", () => {
  for (const candidate of [{ route }, { route, providerRouting: friendli }]) {
    const launch = piArgs.buildPiArgs({
      baseArgs: [], task: "Inspect the source", sessionEnabled: false,
      inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
      extensions: [], model: candidate.route, modelCandidates: [candidate.route],
      modelRouteCandidate: candidate,
    });
    try {
      assert.ok(launch.args.includes("--no-extensions"));
      assert.ok(launch.args.some(value => value.endsWith("subagent-prompt-runtime.ts")), "the managed route hook stays loaded");
      const decoded = modelRoute.decodeSubagentModelRouteCandidate(launch.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV]);
      assert.equal(decoded?.route, route);
      assert.deepEqual(decoded?.providerRouting, candidate.providerRouting);
    } finally { piArgs.cleanupTempDir(launch.tempDir); }
  }
});

test("provider hook writes each exact upstream pin into payload without mutating a shared model", () => {
  const handlers = [];
  const sharedModel = Object.freeze({ provider: "openrouter", id: "org/model-a", compat: Object.freeze({ supportsReasoningEffort: true }) });
  const request = Object.freeze({ model: "org/model-a", messages: [{ role: "user", content: "hello" }], temperature: 0.2, metadata: { keep: true } });
  const registerFor = routing => {
    process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV] = modelRoute.encodeSubagentModelRouteCandidate({ route, providerRouting: routing });
    let handler;
    promptRuntime.registerSubagentModelRouteOverride({ on: (_event, callback) => { handler = callback; } });
    handlers.push(handler);
  };
  registerFor(together);
  registerFor(friendli);
  delete process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV];

  const first = handlers[0]({ type: "before_provider_request", payload: request }, { model: sharedModel });
  const second = handlers[1]({ type: "before_provider_request", payload: request }, { model: sharedModel });
  assert.deepEqual(first, { ...request, provider: together });
  assert.deepEqual(second, { ...request, provider: friendli });
  assert.deepEqual(request, { model: "org/model-a", messages: [{ role: "user", content: "hello" }], temperature: 0.2, metadata: { keep: true } });
  assert.deepEqual(sharedModel.compat, { supportsReasoningEffort: true }, "the provider registry model remains untouched");

  const otherRoute = handlers[0]({ type: "before_provider_request", payload: request }, { model: { provider: "openrouter", id: "org/other" } });
  assert.equal(otherRoute, request, "the initial route pin cannot leak into a later admitted recovery route");
});

test('first dispatch requires the exact parent candidate and a refusal never opens the guard', () => {
  for (const candidate of [{ route }, { route, providerRouting: together }]) {
    process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV] = modelRoute.encodeSubagentModelRouteCandidate(candidate);
    let handler;
    promptRuntime.registerSubagentModelRouteOverride({ on: (_name, fn) => { handler = fn; } });
    delete process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV];
    const event = { payload: { model: model.id } };
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => handler(event, { model: { ...model, id: `${model.id}-v2` } }),
      error => error.code === 'PI_AUTONOMOUS_REQUEST_DENIED' && /does not match its selected route/.test(error.message));
    assert.deepEqual(handler(event, { model }), candidate.providerRouting ? { ...event.payload, provider: together } : event.payload);
    const recovered = { payload: { model: 'org/recovery', provider: friendli } };
    assert.equal(handler(recovered, { model: { ...model, id: 'org/recovery' } }), recovered.payload, 'a later authorized recovery retains its own provider metadata');
    assert.deepEqual(handler(event, { model }), candidate.providerRouting ? { ...event.payload, provider: together } : event.payload, 'restoring the original route restores its original pin');
  }
});

test("valid large provider constraints survive child transport and oversized values fail before launch", () => {
  const slugs = Array.from({ length: 32 }, (_, index) => `provider-${index}-` + "x".repeat(108));
  const providerOptions = { routing: "custom", order: slugs, only: slugs, ignore: slugs.map(slug => slug + "-old"), allow_fallbacks: false };
  const longModel = "vendor/" + "m".repeat(400);
  const doc = { models: {}, preferences: { subagents: { models: [{ provider: "openrouter", model: longModel, provider_options: providerOptions }] } } };
  assert.equal(prefs.validateLlmPreferencesDocumentForWrite(doc).ok, true);
  const candidate = { route: `openrouter/${longModel}`, providerRouting: prefs.providerOptionsToRouting(providerOptions, "openrouter").routing };
  const encoded = modelRoute.encodeSubagentModelRouteCandidate(candidate);
  assert.ok(encoded, "a schema-valid preference must be transportable");
  assert.deepEqual(modelRoute.decodeSubagentModelRouteCandidate(encoded), candidate);
  assert.deepEqual(promptRuntime.rewriteSubagentModelRouteRequest({ payload: {} }, { model: { provider: "openrouter", id: longModel } }, candidate).provider, candidate.providerRouting);
  assert.throws(() => piArgs.buildPiArgs({
    baseArgs: [], task: "Inspect the source", sessionEnabled: false, extensions: [],
    model: route, modelRouteCandidate: { route, providerRouting: { only: ["x".repeat(24_000)] } },
  }), /cannot be encoded safely/);
});

test("a child with a hard token budget finalizes before crossing it", () => {
  const handlers = {}; const steers = []; let active;
  const pi = { on: (event, handler) => { handlers[event] = handler; }, setActiveTools: (tools) => { active = tools; }, sendUserMessage: (text) => steers.push(text) };
  {
    promptRuntime.registerTokenBudget(pi, 96000);
    const turn = (input, output, tools = true) => handlers.message_end({ message: { role: "assistant", usage: { input, output }, content: tools ? [{ type: "toolCall" }] : [{ type: "text", text: "done" }] } });
    turn(25000, 1000); turn(25000, 1000);
    assert.equal(active, undefined, "52k used plus a 25k next turn and answer stays within budget");
    turn(25000, 1000);
    assert.deepEqual(active, [], "tools are removed once the next turn would cross the hard budget");
    assert.match(steers[0], /Token budget nearly used \(78000 of 96000/);
    turn(30000, 1000); assert.equal(steers.length, 1, "finalization happens once");
    const quiet = {}; let quietActive;
    promptRuntime.registerTokenBudget({ on: (event, handler) => { quiet[event] = handler; }, setActiveTools: (tools) => { quietActive = tools; } }, 1000);
    quiet.message_end({ message: { role: "assistant", usage: { input: 5000, output: 10 }, content: [{ type: "text", text: "final" }] } });
    assert.equal(quietActive, undefined, "a terminal answer is never interrupted");
  }
});

test("a caller abort after a clean final answer is owned drain cleanup, not a process-signal failure", async t => {
  const fakePiPath = path.join(root, "fake-pi-lingering.mjs");
  const envLog = path.join(root, "lingering-env.json");
  fs.writeFileSync(fakePiPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_TEST_LINGER_ENV, JSON.stringify({ tokenBudget: process.env.PI_SUBAGENT_TOKEN_BUDGET ?? null }));
const message = { role: "assistant", provider: "openrouter", model: "org/model-a", stopReason: "stop", content: [{ type: "text", text: "Final advisory answer." }], usage: { input: 10, output: 5 } };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  // Isolate route health: the earlier 429 fixture legitimately cools this route.
  const prior = Object.fromEntries(["PI_SUBAGENT_PI_BINARY", "PI_PROVIDER_STATE_FILE", "PI_MODEL_EXCLUSIONS_PATH"].map(key => [key, process.env[key]]));
  process.env.PI_SUBAGENT_PI_BINARY = fakePiPath;
  process.env.PI_PROVIDER_STATE_FILE = path.join(root, "lingering-health.json");
  process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "lingering-exclusions.json");
  process.env.PI_TEST_LINGER_ENV = envLog;
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete process.env.PI_TEST_LINGER_ENV;
  });
  const agentConfig = {
    name: "lingering-fixture", description: "Lingering child", source: "runtime",
    filePath: path.join(root, "lingering-fixture.md"), systemPrompt: "",
    systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false,
    inheritSkills: false,
  };
  const controller = new AbortController();
  const pending = runSync(process.cwd(), [agentConfig], agentConfig.name, "Advise", {
    runId: "lingering-abort-test", availableModels: registry, modelOverride: route, timeoutMs: 10_000,
    signal: controller.signal, usageBudget: { tokens: { hard: 48000 } },
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(envLog) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.processSignal, undefined, "the completed answer keeps its success classification");
  assert.equal(JSON.parse(fs.readFileSync(envLog, "utf8")).tokenBudget, "48000", "the parent's hard token budget reaches the child");
});

test("a cancelled active child that ignores SIGTERM is killed after the grace period", async t => {
  const fakePiPath = path.join(root, "fake-pi-ignore-term.mjs");
  const pidPath = path.join(root, "ignore-term-pid.json");
  fs.writeFileSync(fakePiPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: process.pid }));
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const keys = ["PI_SUBAGENT_PI_BINARY", "PI_PROVIDER_STATE_FILE", "PI_MODEL_EXCLUSIONS_PATH"];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_SUBAGENT_PI_BINARY = fakePiPath;
  process.env.PI_PROVIDER_STATE_FILE = path.join(root, "ignore-term-health.json");
  process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "ignore-term-exclusions.json");
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const agentConfig = {
    name: "ignore-term-fixture", description: "Synthetic active child", source: "runtime",
    filePath: path.join(root, "ignore-term-fixture.md"), systemPrompt: "", systemPromptMode: "replace",
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
  };
  const controller = new AbortController();
  const pending = runSync(process.cwd(), [agentConfig], agentConfig.name, "Inspect the synthetic task", {
    runId: "ignore-term-abort-test", availableModels: registry, modelOverride: route,
    timeoutMs: 30_000, signal: controller.signal,
  });
  let deadlineTimer;
  try {
    const startupDeadline = Date.now() + 5000;
    while (!fs.existsSync(pidPath) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(pidPath), 'synthetic child started');
    controller.abort();
    const result = await Promise.race([pending, new Promise(resolve => { deadlineTimer = setTimeout(() => resolve(undefined), 5000); })]);
    assert.ok(result, 'sending SIGTERM must not be mistaken for child exit; escalate after the 3s grace period');
    assert.equal(result.processSignal, 'SIGKILL');
    assert.notEqual(result.exitCode, 0, 'an aborted active task is not successful final-answer cleanup');
    assert.equal(result.stopped, true, 'a parent-signal abort is an owned stop, never an unknown failure');
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
    if (fs.existsSync(pidPath)) {
      const { pid } = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await pending;
  }
});
