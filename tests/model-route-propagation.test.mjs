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
  fs.existsSync(path.join(p, "extensions/pi-subagents/src/runs/shared/model-fallback.ts")),
);
assert.ok(agent, "pi-subagents source must exist");
const shared = pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/")).href;
const { buildModelRouteCandidates } = await import(shared + "model-fallback.ts");
const prefs = await import(shared + "llm-preferences.ts");
const piArgs = await import(shared + "pi-args.ts");
const promptRuntime = await import(shared + "subagent-prompt-runtime.ts");
const modelRoute = await import(shared + "../../shared/model-route.ts");
const metrics = await import(pathToFileURL(path.join(agent, "extensions/lib/model-routing-metrics.ts")).href);
const { runSync } = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/foreground/execution.ts")).href);

after(() => fs.rmSync(root, { recursive: true, force: true }));

const route = "openrouter/org/model-a";
const model = { provider: "openrouter", id: "org/model-a", fullId: route, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoning: true, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 } };
const registry = [model];
const together = { only: ["together"], order: ["together"], allow_fallbacks: false };
const friendli = { only: ["friendli"], order: ["friendli"], allow_fallbacks: false };

function writeOrderedPinPreferences() {
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({
    version: 1,
    models: {},
    preferences: { subagents: { models: [
      { provider: "openrouter", model: "org/model-a", provider_options: { routing: "pinned", order: ["together"] } },
      { provider: "openrouter", model: "org/model-a", provider_options: { routing: "pinned", order: ["friendli"] } },
    ] } },
  }));
  prefs.clearLlmPreferencesCache();
}

test("ordered same-model upstream pins survive resolver priority and launch encoding", t => {
  writeOrderedPinPreferences();
  t.after(() => {
    prefs.clearLlmPreferencesCache();
  });

  const candidates = buildModelRouteCandidates(route, undefined, registry, undefined, {
    origin: "inherited",
    task: "Inspect the source and return a short observation",
  });
  assert.deepEqual(candidates.map(candidate => candidate.route), [route, route, route]);
  assert.deepEqual(candidates.map(candidate => candidate.providerRouting), [together, friendli, undefined]);

  const explicit = buildModelRouteCandidates(route, undefined, registry, undefined, {
    origin: "explicit",
    task: "Inspect the source and return a short observation",
  });
  assert.deepEqual(explicit, [{ route }], "an explicit child model override takes precedence over role fallbacks");

  // The retry index selects an exact route candidate, and buildPiArgs carries
  // it into the managed child even when ambient extensions are disabled.
  for (let retry = 0; retry < candidates.length; retry++) {
    const candidate = modelRoute.modelRouteCandidateAt(candidates, retry);
    const launch = piArgs.buildPiArgs({
      baseArgs: [], task: "Inspect the source", sessionEnabled: false,
      inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
      extensions: [], model: candidate.route, modelCandidates: candidates.map(value => value.route),
      modelRouteCandidate: candidate,
    });
    try {
      assert.ok(launch.args.includes("--no-extensions"));
      assert.ok(launch.args.some(value => value.endsWith("subagent-prompt-runtime.ts")), "the managed route hook stays loaded for a child retry");
      assert.equal(modelRoute.decodeSubagentModelRouteCandidate(launch.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV])?.route, route);
      assert.deepEqual(modelRoute.decodeSubagentModelRouteCandidate(launch.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV])?.providerRouting, candidate.providerRouting);
    } finally { piArgs.cleanupTempDir(launch.tempDir); }
  }
});

test("a failed foreground provider attempt launches the next configured upstream pin", async t => {
  writeOrderedPinPreferences();
  const candidates = buildModelRouteCandidates(route, undefined, registry, undefined, {
    origin: "inherited",
    task: "Inspect the source and return a short observation",
  }).slice(0, 2);
  assert.deepEqual(candidates.map(candidate => candidate.providerRouting), [together, friendli]);

  const recordPath = path.join(root, "launched-attempts.jsonl");
  const fakePiPath = path.join(root, "fake-pi.mjs");
  const runtimePath = path.join(agent, "extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts");
  fs.writeFileSync(fakePiPath, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { registerSubagentModelRouteOverride } = await import(pathToFileURL(${JSON.stringify(runtimePath)}).href);
const handlers = new Map();
registerSubagentModelRouteOverride({ on: (name, handler) => handlers.set(name, handler) });
const candidate = JSON.parse(process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE);
const model = { provider: "openrouter", id: "org/model-a", compat: { retained: true } };
const payload = handlers.get("before_provider_request")({ type: "before_provider_request", payload: { model: "org/model-a", messages: [{ role: "user", content: "hello" }] } }, { model });
appendFileSync(process.env.PI_TEST_ROUTE_LAUNCH_LOG, JSON.stringify({ candidate, provider: payload.provider }) + "\\n");
const prior = existsSync(process.env.PI_TEST_ROUTE_LAUNCH_LOG) ? readFileSync(process.env.PI_TEST_ROUTE_LAUNCH_LOG, "utf8").trim().split("\\n").length : 0;
if (prior === 1) { process.stderr.write("429 rate limit"); process.exit(1); }
process.exit(0);
`, { mode: 0o700 });
  fs.chmodSync(fakePiPath, 0o700);
  const priorBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const priorLog = process.env.PI_TEST_ROUTE_LAUNCH_LOG;
  process.env.PI_SUBAGENT_PI_BINARY = fakePiPath;
  process.env.PI_TEST_ROUTE_LAUNCH_LOG = recordPath;
  t.after(() => {
    if (priorBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = priorBinary;
    if (priorLog === undefined) delete process.env.PI_TEST_ROUTE_LAUNCH_LOG; else process.env.PI_TEST_ROUTE_LAUNCH_LOG = priorLog;
    prefs.clearLlmPreferencesCache();
  });

  const agentConfig = {
    name: "route-retry-fixture", description: "Test route retry", source: "runtime",
    filePath: path.join(root, "route-retry-fixture.md"), systemPrompt: "",
    systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false,
    inheritSkills: false, model: route,
  };
  const beforeMetrics = metrics.getModelRoutingMetrics();
  const result = await runSync(process.cwd(), [agentConfig], agentConfig.name, "Inspect the source", {
    runId: "route-pin-retry-test",
    availableModels: registry,
    modelRouteCandidates: candidates,
    modelOrigin: "inherited",
    modelOverride: route,
    timeoutMs: 10_000,
  });
  const attempts = fs.readFileSync(recordPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(attempts.length, 2, "the first rate-limit failure reaches the next fallback attempt");
  assert.deepEqual(attempts.map(item => item.candidate.providerRouting), [together, friendli]);
  assert.deepEqual(attempts.map(item => item.provider), [together, friendli], "the request payload on each launched retry carries its own exact upstream pin");
  assert.deepEqual(result.attemptedModels, [route, route]);
  const afterMetrics = metrics.getModelRoutingMetrics();
  assert.equal(afterMetrics.routes.attempts - beforeMetrics.routes.attempts, 2);
  assert.equal(afterMetrics.routes.fallbacks - beforeMetrics.routes.fallbacks, 1);
  assert.equal(afterMetrics.routes.lastFallback.to, route);
});

test("provider hook writes exact retry routing into payload without mutating a shared model", () => {
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

test('an exact initial child dispatch keeps the existing owned recovery transition usable', async () => {
  const { registerAutonomousRecovery } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
  const health = await import(shared + 'provider-health.ts');
  const initial = { ...model, reasoning: false }, alternate = { ...initial, provider: 'recovery-fixture', fullId: `recovery-fixture/${model.id}`, baseUrl: 'https://recovery.invalid/v1' };
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = '1';
  process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV] = modelRoute.encodeSubagentModelRouteCandidate({ route });
  fs.rmSync(process.env.PI_PROVIDER_STATE_FILE, { force: true });
  const handlers = new Map(), selected = [];
  const ctx = { model: initial, scopedModels: [], getContextUsage: () => ({ tokens: 1000 }),
    modelRegistry: { getAvailable: () => [initial, alternate] }, ui: { setStatus() {} }, abort() {},
    sessionManager: { getSessionFile: () => path.join(root, 'recovery-fixture.jsonl'), getBranch: () => [] } };
  const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    getActiveTools: () => [], registerCommand() {}, appendEntry() {}, sendMessage() {},
    setModel: async next => { ctx.model = next; selected.push(next); return true; } };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  try {
    promptRuntime.registerSubagentModelRouteOverride(pi);
    registerAutonomousRecovery(pi, async () => { throw new Error('No child fanout'); }, { childRoutes: [route, alternate.fullId], endpoints: async () => [], wait: async () => {} });
    await emit('input', { source: 'user', text: 'Continue the existing bounded task and retain observed tool evidence.' });
    await emit('before_provider_request', { payload: { model: initial.id, max_tokens: 1024 } });
    for (let attempt = 0; attempt < 3; attempt++) {
      health.recordFailure({ provider: initial.provider, model: initial.id, errorMessage: '503 unavailable' });
      await emit('pi_provider_recovery', { message: { role: 'assistant', provider: initial.provider, model: initial.id, stopReason: 'error', content: [], errorMessage: '503 unavailable' }, signal: new AbortController().signal });
    }
    assert.equal(ctx.model.provider, alternate.provider, 'the real recovery owner selects the admitted alternative after repeated failure');
    assert.equal(selected.length, 1);
    await emit('before_provider_request', { payload: { model: alternate.id, max_tokens: 1024 } });
    await emit('agent_settled', {});
    assert.equal(ctx.model.provider, initial.provider);
    await emit('before_provider_request', { payload: { model: initial.id, max_tokens: 1024 } });
  } finally {
    await emit('session_shutdown', {});
    delete process.env[modelRoute.SUBAGENT_MODEL_ROUTE_CANDIDATE_ENV];
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous;
    fs.rmSync(process.env.PI_PROVIDER_STATE_FILE, { force: true });
  }
});

test("interleaved model and upstream fallback priorities remain in exact JSON order", () => {
  const route = "openrouter/org/priority-a";
  const modelA = { ...model, id: "org/priority-a", fullId: route };
  const modelB = { ...model, id: "org/model-b", fullId: "openrouter/org/model-b" };
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({
    version: 1, models: {}, preferences: { subagents: { models: [
      { provider: "openrouter", model: modelA.id, thinking: "low", provider_options: { routing: "pinned", order: ["together"] } },
      { provider: "openrouter", model: modelB.id },
      { provider: "openrouter", model: modelA.id, thinking: "high", provider_options: { routing: "pinned", order: ["friendli"] } },
    ] } },
  }));
  const candidates = buildModelRouteCandidates(route, undefined, [modelA, modelB], undefined, {
    origin: "inherited", task: "Inspect the source and return a short observation",
  });
  assert.deepEqual(candidates.slice(0, 3), [
    { route: `${route}:low`, providerRouting: together },
    { route: modelB.fullId },
    { route: `${route}:high`, providerRouting: friendli },
  ]);
  const activeTurn = structuredClone(candidates);
  const doc = JSON.parse(fs.readFileSync(process.env.PI_LLM_PREFERENCES_FILE, "utf8"));
  doc.preferences.subagents.models.reverse();
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify(doc));
  const newest = buildModelRouteCandidates(route, undefined, [modelA, modelB], undefined, {
    origin: "inherited", task: "Inspect the source and return a short observation",
  });
  assert.deepEqual(newest.slice(0, 3), activeTurn.slice(0, 3).reverse(), "a newly resolved child sees the latest file without cache clearing");
  assert.deepEqual(candidates, activeTurn, "the already resolved turn does not change after a config edit");
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

test("new child routing recovers from an excluded inherited model through configured preferences", async () => {
  const { recordModelFailure } = await import(shared + "model-exclusions.ts");
  const route = "openrouter/org/excluded-inherited";
  const inherited = { ...model, id: "org/excluded-inherited", fullId: route };
  recordModelFailure({ provider: inherited.provider, modelId: inherited.id, reason: "fixture provider failure", ttlMs: 60_000 });
  const alternate = { ...model, id: "org/fallback-live", fullId: "openrouter/org/fallback-live" };
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ models: {}, preferences: { subagents: { models: [
    { provider: "openrouter", model: alternate.id, provider_options: { routing: "pinned", order: ["together"] } },
  ] } } }));
  const candidates = buildModelRouteCandidates(route, undefined, [inherited, alternate], undefined, {
    origin: "inherited", task: "Inspect the source and return a short observation",
  });
  assert.equal(candidates[0]?.route, alternate.fullId);
  assert.deepEqual(candidates[0]?.providerRouting, together);
});

test("same-length briefs with different middle requirements cannot share routing bounds", () => {
  const textModel = { ...model, id: "org/text-route", fullId: "openrouter/org/text-route" };
  const visionModel = { ...model, id: "org/vision-route", fullId: "openrouter/org/vision-route", input: ["text", "image"] };
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, JSON.stringify({ models: {}, preferences: { subagents: { models: [
    { provider: "openrouter", model: textModel.id }, { provider: "openrouter", model: visionModel.id },
  ] } } }));
  const head = "Inspect the material. " + "Context is available. ".repeat(35);
  const tail = "Return observations. ".repeat(10);
  const brief = middle => head + middle.padEnd(100, " ") + tail;
  const textTask = brief("Inspect the supplied log entries.");
  const visionTask = brief("Inspect the supplied screenshots.");
  assert.equal(textTask.length, visionTask.length);
  const choose = task => buildModelRouteCandidates(textModel.fullId, undefined, [textModel, visionModel], undefined, { origin: "inherited", task })[0].route;
  assert.equal(choose(textTask), textModel.fullId);
  assert.equal(choose(visionTask), visionModel.fullId);
});

test("automatic helpers finalize before crossing the parent's reported-token budget", () => {
  const handlers = {}; const steers = []; let active;
  const pi = { on: (event, handler) => { handlers[event] = handler; }, setActiveTools: (tools) => { active = tools; }, sendUserMessage: (text) => steers.push(text) };
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "automatic-free-assistant";
  try {
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
    process.env.PI_SUBAGENT_CHILD_AGENT = "worker";
    const writer = {}; promptRuntime.registerTokenBudget({ on: (event, handler) => { writer[event] = handler; }, setActiveTools: () => { throw new Error("writers keep tools"); } }, 10);
    assert.equal(writer.message_end, undefined, "explicit writer budgets stay parent-accounted");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT; else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
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
    inheritSkills: false, model: route,
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
