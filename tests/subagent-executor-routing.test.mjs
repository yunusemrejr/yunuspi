import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "executor-routing-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runs");
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, "llm_preferences.json");
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, "{}");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const repo = path.resolve(import.meta.dirname, "..");
const base = path.join(repo, "agent/extensions/pi-subagents/src");
const { createSubagentExecutor } = await import(pathToFileURL(path.join(base, "runs/foreground/subagent-executor.ts")).href);
const { clearExclusions } = await import(pathToFileURL(path.join(base, "runs/shared/model-exclusions.ts")).href);
const { SessionManager } = await import("../core/coding-agent/src/core/session-manager.js");
const { createEventBus } = await import("../core/coding-agent/src/core/event-bus.js");
const { failureOf, projectRunEvidence } = await import(pathToFileURL(path.join(base, "runs/shared/run-history.ts")).href);
const { resultFilePath } = await import(pathToFileURL(path.join(base, "runs/background/result-files.ts")).href);
const { DIRS } = await import(pathToFileURL(path.join(base, "shared/types.ts")).href);

const route = "openrouter/org/executor-fixture";
const model = { provider: "openrouter", id: "org/executor-fixture", name: "Executor fixture", fullId: route,
  api: "openai-completions", baseUrl: "https://invalid.example", input: ["text"], reasoning: false,
  contextWindow: 65536, maxTokens: 8192, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 } };
const pins = ["together", "friendli"].map(provider => ({ route, providerRouting: {
  only: [provider], order: [provider], allow_fallbacks: false,
} }));

// Exercise the real executor and both actual child process launchers. Substitute
// only the terminal model process, recording its applied provider request hook.
function fixture(t, { stopReason = "stop", lingerAfterStop = false } = {}) {
  clearExclusions();
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  const recordPath = path.join(cwd, "requests.jsonl");
  const fakePi = path.join(cwd, "fixture-pi.mjs");
  const hookPath = path.join(base, "runs/shared/subagent-prompt-runtime.ts");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { registerSubagentModelRouteOverride } = await import(pathToFileURL(${JSON.stringify(hookPath)}).href);
const handlers = new Map();
registerSubagentModelRouteOverride({ on: (name, handler) => handlers.set(name, handler) });
const candidate = JSON.parse(process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE || "null");
const model = { provider: "openrouter", id: "org/executor-fixture" };
const payload = { model: model.id, messages: [] };
const request = handlers.get("before_provider_request")?.({ type: "before_provider_request", payload }, { model }) ?? payload;
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ candidate, provider: request.provider }) + "\\n");
if (candidate?.providerRouting?.only?.[0] === "together") { process.stderr.write("429 rate limit"); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: model.provider, model: model.id,
  api: "openai-completions", timestamp: Date.now(), content: [{ type: "text", text: "Child completed" }], stopReason: ${JSON.stringify(stopReason)},
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }) + "\\n");
process.exitCode = ${stopReason === "length" ? 1 : 0};
${lingerAfterStop ? 'setInterval(() => {}, 1000);' : ''}
`, { mode: 0o700 });
  process.env.PI_SUBAGENT_PI_BINARY = fakePi;
  const agent = { name: "route-fixture", description: "Read-only route fixture", source: "runtime",
    filePath: path.join(cwd, "agent.md"), systemPrompt: "Return the observation.", systemPromptMode: "replace",
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, extensions: [], tools: [], model: route };
  const state = { baseCwd: cwd, currentSessionId: null, subagentInProgress: false,
    subagentSpawns: { sessionId: null, count: 0 }, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(),
    cleanupTimers: new Map(), completionSeen: new Map(), resultFileCoalescer: { schedule: () => false, clear() {} } };
  const pi = { events: createEventBus(), appendEntry() {}, getActiveTools: () => [], getModel: () => model, getSessionName: () => "Executor fixture" };
  const executor = createSubagentExecutor({ state, pi, config: {}, asyncByDefault: false,
    tempArtifactsDir: path.join(cwd, "artifacts"), getSubagentSessionRoot: () => path.join(cwd, "sessions"),
    expandTilde: value => value, discoverAgents: () => ({ agents: [agent] }) });
  const sessionManager = SessionManager.inMemory(cwd);
  const ctx = { cwd, hasUI: false, model, sessionManager, modelRegistry: { getAvailable: () => [model] }, getSystemPrompt: () => "", isIdle: () => true };
  t.after(() => { for (const timer of state.cleanupTimers.values()) clearTimeout(timer); });
  return { cwd, agent, executor, ctx, hasLaunched: () => fs.existsSync(recordPath), records: () => fs.readFileSync(recordPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

for (const background of [false, true]) test(`successful ${background ? 'background' : 'foreground'} post-final cleanup is not a process failure`, {timeout:30_000}, async t => {
  const f=fixture(t,{lingerAfterStop:true});
  const result=await f.executor.executeDelegated('cleanup-request',{
    agent:'route-fixture',task:'Read the source and return a concise observation',context:'fresh',async:background,
    artifacts:false,model:route,modelOrigin:'inherited',modelRouteCandidates:[pins[1]],timeoutMs:15_000,
    acceptance:{level:'none',reason:'Read-only cleanup fixture; no implementation deliverable.'},
  },new AbortController().signal,undefined,f.ctx);
  let row=result.details.results?.[0];
  if(background){
    let status;
    for(const deadline=Date.now()+20_000;Date.now()<deadline;){
      status=JSON.parse(fs.readFileSync(path.join(result.details.asyncDir,'status.json'),'utf8'));
      if(['complete','completed','failed'].includes(status.state)&&status.processTerminal?.state==='observed')break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(['complete','completed'].includes(status?.state),JSON.stringify(status));
    row=JSON.parse(fs.readFileSync(resultFilePath(DIRS.results,result.details.runId),'utf8')).results[0];
  }
  if(!background)assert.equal(row.exitCode,0);
  assert.equal(row.processSignal,undefined);
  assert.equal(failureOf(row).cause.category,'none');
  assert.equal(f.records().length,1);
});

for (const background of [false, true]) test(`real ${background ? "background" : "foreground"} executor preserves delegated upstream retry pins`, { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const result = await f.executor.executeDelegated("fixture-request", {
    agent: "route-fixture", task: "Read the source and return a concise observation", context: "fresh", async: background,
    artifacts: false, model: route, modelOrigin: "inherited", modelRouteCandidates: pins, timeoutMs: 15_000,
  }, new AbortController().signal, undefined, f.ctx);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (background) {
    assert.ok(result.details.asyncDir, "the real background runner must start");
    const statusPath = path.join(result.details.asyncDir, "status.json");
    let status;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      if (["complete", "completed", "failed", "stopped"].includes(status.state) && status.processTerminal?.state !== "pending") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(["complete", "completed"].includes(status?.state), JSON.stringify(status));
    assert.equal(status.processTerminal?.state, "observed", "the runner and child processes must exit before fixture cleanup");
  } else {
    assert.equal(result.details.results[0]?.exitCode, 0);
    assert.match(result.content[0].text, /Child completed/);
  }
  const attempts = f.records();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(attempt => attempt.candidate), pins);
  assert.deepEqual(attempts.map(attempt => attempt.provider), pins.map(pin => pin.providerRouting));
});

for (const background of [false, true]) test(`native ${background ? "background" : "foreground"} child length stops retain their typed cause in terminal receipts`, { timeout: 30_000 }, async t => {
  const f = fixture(t, { stopReason: "length" });
  const result = await f.executor.executeDelegated("length-request", {
    agent: "route-fixture", task: "Read the source and return a concise observation", context: "fresh", async: background,
    artifacts: false, model: route, modelOrigin: "inherited", modelRouteCandidates: [pins[1]], timeoutMs: 10_000,
  }, new AbortController().signal, undefined, f.ctx);
  let row;
  if (background) {
    assert.notEqual(result.isError, true, "background admission is not terminal success");
    let status;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      status = JSON.parse(fs.readFileSync(path.join(result.details.asyncDir, "status.json"), "utf8"));
      if (status.state === "failed" && status.processTerminal?.state === "observed") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status?.state, "failed");
    assert.equal(status?.processTerminal?.state, "observed");
    row = JSON.parse(fs.readFileSync(resultFilePath(DIRS.results, result.details.runId), "utf8")).results[0];
  } else {
    assert.equal(result.isError, true);
    row = result.details.results[0];
  }
  assert.equal(row.messages, undefined, "actual executor returns a compact transcript receipt");
  assert.equal(row.stopReason, "length");
  assert.equal(row.modelAttempts.length, 1);
  assert.equal(row.modelAttempts[0].stopReason, "length");
  assert.equal(failureOf(row).cause.category, "output-truncated");
  assert.equal(failureOf(row).cause.truncation, "length-stop");
  assert.equal(projectRunEvidence(row).attempts[0].outcomeReason, "truncated");
  assert.deepEqual(failureOf(row).cause.healthScopes, {});
  assert.equal(f.records().length, 1, "diagnostic preservation does not add a launch");
});

test("ordinary public execution still launches and ignores caller-supplied private route candidates", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const result = await f.executor.execute("public-request", {
    agent: "route-fixture", task: "Inspect the source", context: "fresh", async: false, artifacts: false,
    model: route, modelRouteCandidates: pins,
  }, new AbortController().signal, undefined, f.ctx);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.results[0]?.exitCode, 0);
  assert.deepEqual(f.records(), [{ candidate: { route } }]);
});

test("executor returns typed private-safe runtime diagnostics before launch without trying providers", async t => {
  for (const background of [false, true]) for (const ErrorType of [ReferenceError, TypeError, SyntaxError]) {
    const f = fixture(t);
    f.ctx.modelRegistry.getAvailable = () => { throw new ErrorType(ErrorType === ReferenceError ? "missingFixture is not defined" : "Private arbitrary failure details"); };
    const result = await f.executor.executeDelegated("fault-request", {
      agent: "route-fixture", task: "Inspect the source", context: "fresh", async: background, artifacts: false,
      modelRouteCandidates: pins,
    }, new AbortController().signal, undefined, f.ctx);
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.results, []);
    const failure = result.details.launchFailure;
    assert.equal(failure?.stage, "launch");
    assert.equal(failure?.childProcessStarted, false);
    assert.equal(failure?.runtimeError, ErrorType.name);
    assert.equal(failure?.diagnosticCode, ErrorType === ReferenceError ? "ReferenceError:missingFixture" : ErrorType.name);
    assert.equal(typeof failure?.diagnosticRef, "string");
    assert.doesNotMatch(JSON.stringify(failure), /Private arbitrary|stack|\.ts:/);
    assert.equal(f.hasLaunched(), false, "an internal runtime failure never starts a child or advances provider fallback");
  }
});

test("multi-child dispatch does not infer prelaunch failure from single-child tracking", async t => {
  const f = fixture(t);
  f.ctx.modelRegistry.getAvailable = () => { throw new TypeError("Synthetic registry failure"); };
  const result = await f.executor.executeDelegated("parallel-fault", {
    tasks: [{ agent: "route-fixture", task: "Inspect first source" }, { agent: "route-fixture", task: "Inspect second source" }],
    context: "fresh", async: true, artifacts: false,
  }, new AbortController().signal, undefined, f.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Synthetic registry failure/);
  assert.equal(result.details.launchFailure, undefined);
});

test("external runner errors cannot assert native no-process evidence", async t => {
  const f = fixture(t);
  f.agent.runner = { type: "external-cli", command: "unused-fixture" };
  f.ctx.modelRegistry.getAvailable = () => { throw new TypeError("Synthetic external dispatch failure"); };
  const result = await f.executor.executeDelegated("external-fault", {
    agent: "route-fixture", task: "Inspect the source", context: "fresh", async: true, artifacts: false,
  }, new AbortController().signal, undefined, f.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Synthetic external dispatch failure/);
  assert.equal(result.details.launchFailure, undefined);
});
