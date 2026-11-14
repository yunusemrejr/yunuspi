import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "executor-routing-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runs");
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "health.json");
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "exclusions.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const repo = path.resolve(import.meta.dirname, "..");
const base = path.join(repo, "agent/extensions/pi-subagents/src");
const { createSubagentExecutor } = await import(pathToFileURL(path.join(base, "runs/foreground/subagent-executor.ts")).href);
const { SessionManager } = await import("../core/coding-agent/src/core/session-manager.js");
const { createEventBus } = await import("../core/coding-agent/src/core/event-bus.js");
const { failureOf, projectRunEvidence } = await import(pathToFileURL(path.join(base, "runs/shared/run-history.ts")).href);
const { resultFilePath } = await import(pathToFileURL(path.join(base, "runs/background/result-files.ts")).href);
const { DIRS, SUBAGENT_ASYNC_STARTED_EVENT } = await import(pathToFileURL(path.join(base, "shared/types.ts")).href);

const route = "openrouter/org/executor-fixture";
const model = { provider: "openrouter", id: "org/executor-fixture", name: "Executor fixture", fullId: route,
  api: "openai-completions", baseUrl: "https://invalid.example", input: ["text"], reasoning: false,
  contextWindow: 65536, maxTokens: 8192, cost: { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 } };
const pins = ["together", "friendli"].map(provider => ({ route, providerRouting: {
  only: [provider], order: [provider], allow_fallbacks: false,
} }));

// Exercise the real executor and both actual child process launchers. Substitute
// only the terminal model process, recording its applied provider request hook.
function fixture(t, { stopReason = "stop", lingerAfterStop = false, captureNative = false, childDelayMs = 0, startBarrier = 0, config = {}, reasoning = false, sessionThinking, asyncByDefault = false, agentFields = {}, models = [] } = {}) {
  const cwd = fs.mkdtempSync(path.join(root, "case-"));
  const recordPath = path.join(cwd, "requests.jsonl");
  const fakePi = path.join(cwd, "fixture-pi.mjs");
  const hookPath = path.join(base, "runs/shared/subagent-prompt-runtime.ts");
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { registerSubagentModelRouteOverride } = await import(pathToFileURL(${JSON.stringify(hookPath)}).href);
const handlers = new Map();
registerSubagentModelRouteOverride({ on: (name, handler) => handlers.set(name, handler) });
const candidate = JSON.parse(process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE || "null");
const launched = (process.argv[process.argv.indexOf("--model") + 1] ?? "openrouter/org/executor-fixture").replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
const model = { provider: launched.split("/")[0], id: launched.split("/").slice(1).join("/") };
const payload = { model: model.id, messages: [] };
const request = handlers.get("before_provider_request")?.({ type: "before_provider_request", payload }, { model }) ?? payload;
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ candidate, provider: request.provider${captureNative ? ', argv:process.argv.slice(2), phase:"start", pid:process.pid, timestamp:Date.now()' : ''} }) + "\\n");
if (candidate?.providerRouting?.only?.[0] === "together") { process.stderr.write("429 rate limit"); process.exit(1); }
${startBarrier ? `// Keep the first admitted wave alive until every native slot has started.
// This proves capacity despite uneven local import/bootstrap times under CI.
const barrierDeadline = Date.now() + 30_000;
while (readFileSync(${JSON.stringify(recordPath)}, "utf8").trim().split("\\n").map(line => JSON.parse(line)).filter(row => row.phase === "start").length < ${startBarrier}) {
  if (Date.now() >= barrierDeadline) throw new Error("Native scheduler start barrier timed out");
  await new Promise(resolve => setTimeout(resolve, 10));
}` : ''}
${childDelayMs ? `await new Promise(resolve => setTimeout(resolve, ${childDelayMs}));` : ''}
${captureNative ? `appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({phase:"end",pid:process.pid,timestamp:Date.now()}) + "\\n");` : ''}
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", provider: model.provider, model: model.id,
  api: "openai-completions", timestamp: Date.now(), content: [{ type: "text", text: "Child completed" }], stopReason: ${JSON.stringify(stopReason)},
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }) + "\\n");
process.exitCode = ${stopReason === "length" ? 1 : 0};
${lingerAfterStop ? 'setInterval(() => {}, 1000);' : ''}
`, { mode: 0o700 });
  process.env.PI_SUBAGENT_PI_BINARY = fakePi;
  const agent = { name: "route-fixture", description: "Read-only route fixture", source: "runtime",
    filePath: path.join(cwd, "agent.md"), systemPrompt: "Return the observation.", systemPromptMode: "replace",
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, extensions: [], tools: [], model: route, ...agentFields };
  const state = { baseCwd: cwd, currentSessionId: null, subagentInProgress: false,
    subagentSpawns: { sessionId: null, count: 0 }, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(),
    cleanupTimers: new Map(), completionSeen: new Map(), resultFileCoalescer: { schedule: () => false, clear() {} } };
  const runtimeModel = { ...model, reasoning }, entries = [];
  const pi = { events: createEventBus(), appendEntry(type, data) { entries.push({type,data}); }, getActiveTools: () => [], getModel: () => runtimeModel, getThinkingLevel: () => sessionThinking, getSessionName: () => "Executor fixture" };
  const executor = createSubagentExecutor({ state, pi, config, asyncByDefault,
    tempArtifactsDir: path.join(cwd, "artifacts"), getSubagentSessionRoot: () => path.join(cwd, "sessions"),
    expandTilde: value => value, discoverAgents: () => ({ agents: [agent] }) });
  const sessionManager = SessionManager.inMemory(cwd);
  const ctx = { cwd, hasUI: false, model: runtimeModel, sessionManager, modelRegistry: { getAvailable: () => [runtimeModel, ...models] }, getSystemPrompt: () => "", isIdle: () => true };
  t.after(() => { for (const timer of state.cleanupTimers.values()) clearTimeout(timer); });
  return { cwd, agent, executor, ctx, entries, state, pi, hasLaunched: () => fs.existsSync(recordPath), records: () => fs.readFileSync(recordPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

async function awaitNativeBackground(f, result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const statusPath=path.join(result.details.asyncDir,'status.json');
  let status;
  for(const deadline=Date.now()+60_000;Date.now()<deadline;){
    status=JSON.parse(fs.readFileSync(statusPath,'utf8'));
    if(['complete','completed','failed','stopped'].includes(status.state)&&status.processTerminal?.state==='observed'){
      assert.ok(['complete','completed'].includes(status.state),JSON.stringify(status));
      return status;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail(`native background child processes did not finish: ${JSON.stringify(status)}`);
}
function launchThinking(row) {
  const explicit=row.argv.indexOf('--thinking');
  if(explicit>=0)return row.argv[explicit+1];
  const modelArg=row.argv[row.argv.indexOf('--model')+1];
  return /:(off|minimal|low|medium|high|xhigh|max)$/.exec(modelArg ?? '')?.[1];
}

test('native child thinking is the session ceiling for every brief and ignores agent and requested thinking',{timeout:30_000},async t=>{
  const f=fixture(t,{reasoning:true,captureNative:true,sessionThinking:'high'});
  const briefs=['Fix a one-line README comment typo','Investigate an intermittent parser failure','Redesign authentication across multiple services'];
  for(const task of briefs){
    const result=await f.executor.execute('session-thinking',{agent:'route-fixture',commonTask:'Parent context: redesign authentication across multiple services',task,context:'fresh',async:false,artifacts:false,acceptance:{level:'none',reason:'Read-only launch-contract fixture'}},new AbortController().signal,undefined,f.ctx);
    assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.equal(launchThinking(f.records().filter(row=>row.phase==='start').at(-1)),'high');
  }
  f.agent.thinking='low';
  await f.executor.execute('session-agent-config',{agent:'route-fixture',task:briefs[0],context:'fresh',async:false,artifacts:false},new AbortController().signal,undefined,f.ctx);
  assert.equal(launchThinking(f.records().filter(row=>row.phase==='start').at(-1)),'high');
  await f.executor.execute('session-requested-model',{agent:'route-fixture',task:briefs[0],model:`${route}:low`,context:'fresh',async:false,artifacts:false},new AbortController().signal,undefined,f.ctx);
  assert.equal(launchThinking(f.records().filter(row=>row.phase==='start').at(-1)),'high');
});

test('native background arrays use the session ceiling with default scheduler width without dropping work',{timeout:75_000},async t=>{
  const f=fixture(t,{reasoning:true,captureNative:true,childDelayMs:600,startBarrier:2,sessionThinking:'high'});
  const result=await f.executor.execute('adaptive-parallel',{tasks:[
    {agent:'route-fixture',task:'Fix a one-line README comment typo'},
    {agent:'route-fixture',task:'Investigate an intermittent parser failure'},
    {agent:'route-fixture',task:'Fix another one-line README comment typo'},
    {agent:'route-fixture',task:'Fix the last one-line README comment typo'},
  ],context:'fresh',async:true,artifacts:false,acceptance:{level:'none',reason:'Read-only launch-contract fixture'}},new AbortController().signal,undefined,f.ctx);
  const status=await awaitNativeBackground(f,result);
  const records=f.records(),starts=records.filter(row=>row.phase==='start');
  assert.equal(starts.length,4,'every requested child must execute');
  assert.deepEqual(starts.map(launchThinking),['high','high','high','high']);
  let active=0,peak=0;for(const row of records){active+=row.phase==='start'?1:-1;peak=Math.max(peak,active);}
  assert.equal(peak,2,'the actual native process scheduler consumes width 2');
  assert.equal(active,0);
  assert.equal(status.steps.length,4);
  assert.ok(f.entries.some(row=>row.type==='adaptive-subagent-dispatch-v1'&&row.data.defaults[0].concurrency===2));
});

test('adaptive native arrays retain explicit configured parallel capacity',{timeout:75_000},async t=>{
  const f=fixture(t,{captureNative:true,childDelayMs:600,startBarrier:3,config:{parallel:{concurrency:3}}});
  const result=await f.executor.execute('adaptive-configured-parallel',{tasks:Array.from({length:4},()=>({agent:'route-fixture',task:'Read a single README line'})),context:'fresh',async:true,artifacts:false,acceptance:{level:'none',reason:'Read-only launch-contract fixture'}},new AbortController().signal,undefined,f.ctx);
  const status=await awaitNativeBackground(f,result);
  let active=0,peak=0;for(const row of f.records()){active+=row.phase==='start'?1:-1;peak=Math.max(peak,active);}
  assert.equal(peak,3);
  assert.equal(f.records().filter(row=>row.phase==='start').length,4);
  assert.equal(active,0,'every configured-capacity child reaches its end');
  assert.equal(status.steps.length,4);
});

test('a call that names no mode runs in the agent\'s own: blocking returns the answer, background returns a run',{timeout:60_000},async t=>{
  const call={agent:'route-fixture',task:'Read the source and return a concise observation',context:'fresh',artifacts:false,
    acceptance:{level:'none',reason:'Read-only fixture; no implementation deliverable.'}};
  const run=(f,extra={})=>f.executor.execute('mode-'+Math.random().toString(36).slice(2),{...call,...extra},new AbortController().signal,undefined,f.ctx);
  const text=result=>result.content.map(part=>part.text??'').join('\n');
  // The harness default is background; an agent that declares async:false answers in the call.
  const blocking=fixture(t,{asyncByDefault:true,agentFields:{defaultAsync:false}});
  const answered=await run(blocking);
  assert.notEqual(answered.isError,true,JSON.stringify(answered));
  assert.equal(answered.details.asyncId,undefined);
  assert.match(text(answered),/Child completed/);
  // The call can still ask for the background, and an agent with no mode of its own gets the default.
  for(const [f,extra] of [[blocking,{async:true}],[fixture(t,{asyncByDefault:true}),{}]]){
    const launched=await run(f,extra);
    assert.ok(launched.details.asyncId,JSON.stringify(launched.details));
    assert.match(text(launched),/Running in the background/);
    assert.doesNotMatch(text(launched),/Child completed/);
    await awaitNativeBackground(f,launched);
  }
});

test('adaptive native rollback restores unconfigured child launch defaults',{timeout:15_000},async t=>{
  const f=fixture(t,{reasoning:true,captureNative:true});
  process.env.PI_ADAPTIVE_EXECUTION='off';
  try{
    const result=await f.executor.execute('adaptive-off',{agent:'route-fixture',task:'Fix a one-line comment typo',context:'fresh',async:false,artifacts:false},new AbortController().signal,undefined,f.ctx);
    assert.notEqual(result.isError,true,JSON.stringify(result));
    assert.equal(launchThinking(f.records().find(row=>row.phase==='start')),undefined);
  }finally{delete process.env.PI_ADAPTIVE_EXECUTION;}
});

for (const background of [false, true]) test(`successful ${background ? 'background' : 'foreground'} post-final cleanup is not a process failure`, {timeout:30_000}, async t => {
  const f=fixture(t,{lingerAfterStop:true});
  const result=await f.executor.executeDelegated('cleanup-request',{
    agent:'route-fixture',task:'Read the source and return a concise observation',context:'fresh',async:background,
    artifacts:false,modelRouteCandidates:[pins[1]],timeoutMs:15_000,
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

for (const background of [false, true]) test(`real ${background ? "background" : "foreground"} executor launches only the delegated session route`, { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const result = await f.executor.executeDelegated("fixture-request", {
    agent: "route-fixture", task: "Read the source and return a concise observation", context: "fresh", async: background,
    artifacts: false, modelRouteCandidates: [pins[1]], timeoutMs: 15_000,
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
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts.map(attempt => attempt.candidate), [pins[1]]);
  assert.deepEqual(attempts.map(attempt => attempt.provider), [pins[1].providerRouting]);
});

test("a failed delegated session route is not retried on another upstream pin", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const result = await f.executor.executeDelegated("failed-route-request", {
    agent: "route-fixture", task: "Read the source and return a concise observation", context: "fresh", async: false,
    artifacts: false, modelRouteCandidates: [pins[0]], timeoutMs: 15_000,
  }, new AbortController().signal, undefined, f.ctx);
  assert.equal(result.isError, true);
  const attempts = f.records();
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every(attempt => attempt.candidate.providerRouting?.only?.[0] === "together"), JSON.stringify(attempts));
});

for (const background of [false, true]) test(`native ${background ? "background" : "foreground"} child length stops retain their typed cause in terminal receipts`, { timeout: 30_000 }, async t => {
  const f = fixture(t, { stopReason: "length" });
  const result = await f.executor.executeDelegated("length-request", {
    agent: "route-fixture", task: "Read the source and return a concise observation", context: "fresh", async: background,
    artifacts: false, modelRouteCandidates: [pins[1]], timeoutMs: 10_000,
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

// A child runs on the model of its role. The fixture agent takes the name of a built-in agent so the
// built-in role table applies; the real launcher records the model and thinking it was started with.
const legworkRoute = "openrouter/org/legwork-fixture";
const legworkModel = { ...model, id: "org/legwork-fixture", name: "Legwork fixture", fullId: legworkRoute, reasoning: true };
function useTeam(t, settings) {
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, JSON.stringify(settings));
  t.after(() => fs.rmSync(file, { force: true }));
}
const launchModel = row => row.argv[row.argv.indexOf("--model") + 1].replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
const lastStart = f => f.records().filter(row => row.phase === "start").at(-1);
const scoutCall = (extra = {}) => ({ agent: "scout", task: "Read the source and return a concise observation", context: "fresh", async: false, artifacts: false,
  acceptance: { level: "none", reason: "Read-only fixture; no implementation deliverable." }, ...extra });
const runCall = (f, call) => f.executor.execute("role-" + Math.random().toString(36).slice(2), call, new AbortController().signal, undefined, f.ctx);

test("with no team settings a child runs on the session model at the session ceiling", { timeout: 30_000 }, async t => {
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout" } });
  const result = await runCall(f, scoutCall());
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(launchModel(lastStart(f)), route);
  assert.equal(launchThinking(lastStart(f)), "high");
});

test("a legwork child runs on the legwork model under the legwork thinking ceiling, and the call's role can override it", { timeout: 60_000 }, async t => {
  useTeam(t, { team: { legwork: legworkRoute, maxThinking: { legwork: "low" } } });
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout" } });
  const first = await runCall(f, scoutCall());
  assert.notEqual(first.isError, true, JSON.stringify(first.content));
  assert.equal(launchModel(lastStart(f)), legworkRoute, "scout is a legwork agent");
  assert.equal(launchThinking(lastStart(f)), "low", "the legwork ceiling is below the session's");
  const second = await runCall(f, scoutCall({ role: "main" }));
  assert.notEqual(second.isError, true, JSON.stringify(second.content));
  assert.equal(launchModel(lastStart(f)), route, "role:main on the call keeps the child on the session model");
  assert.equal(launchThinking(lastStart(f)), "high");
  const refused = await runCall(f, scoutCall({ role: "boss" }));
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /role must be main, helper, legwork\./);
});

test("a legwork model that is not available stops the launch with one line naming the setting", { timeout: 30_000 }, async t => {
  useTeam(t, { team: { legwork: "openrouter/org/not-installed" } });
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout" } });
  const result = await runCall(f, scoutCall());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /team\.legwork is set to 'openrouter\/org\/not-installed', which is not among the available models/);
  assert.equal(f.hasLaunched(), false, "no child was started");
});

// A fork replays a persisted parent session.
function persistParentSession(f) {
  f.ctx.sessionManager = SessionManager.create(f.cwd, path.join(f.cwd, "parent-sessions"));
  f.ctx.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier conversation" }], timestamp: Date.now() });
  f.ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], api: "openai-completions", provider: "openrouter", model: "org/executor-fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
}

test("a forked child keeps the session model; an agent that only forks by default starts fresh on its role's model", { timeout: 60_000 }, async t => {
  useTeam(t, { team: { legwork: legworkRoute, maxThinking: { legwork: "low" } } });
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout", defaultContext: "fork" } });
  persistParentSession(f);
  const implicit = await runCall(f, scoutCall({ context: undefined }));
  assert.notEqual(implicit.isError, true, JSON.stringify(implicit.content));
  assert.equal(launchModel(lastStart(f)), legworkRoute, "the agent's own fork default gives way to its role's model");
  const forked = await runCall(f, scoutCall({ context: "fork" }));
  assert.notEqual(forked.isError, true, JSON.stringify(forked.content));
  assert.equal(launchModel(lastStart(f)), route, "context:fork on the call keeps the session model");
  assert.equal(launchThinking(lastStart(f)), "high", "and the role's thinking ceiling does not apply to it");
});

test("an identical launch is refused once while its twin runs, and a child's brief names the others at work", { timeout: 90_000 }, async t => {
  const f = fixture(t, { captureNative: true, childDelayMs: 4000, agentFields: { name: "scout" } });
  // The job tracker lists a run as soon as the launcher announces it; the fixture has no tracker.
  f.pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, info => f.state.asyncJobs.set(info.id, { asyncId: info.id, status: "running" }));
  // Only the tool a model calls (executePublic) refuses a twin or adds the block.
  const send = task => f.executor.executePublic("public-" + Math.random().toString(36).slice(2), scoutCall({ async: true, task }), new AbortController().signal, undefined, f.ctx);
  const first = await send("Find where the loader\n reads its settings");
  assert.notEqual(first.isError, true, JSON.stringify(first.content));
  const refused = await send("Find where the loader reads   its settings");
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, `already running as ${first.details.asyncId} since 1 min; its report will arrive; send the call again to run a second one`);
  const second = await send("Find where the loader reads its settings");
  assert.notEqual(second.isError, true, "the same call sent again runs");
  assert.notEqual(second.details.asyncId, first.details.asyncId);
  await awaitNativeBackground(f, first);
  await awaitNativeBackground(f, second);
  const briefs = f.records().filter(row => row.phase === "start").map(row => row.argv.join("\n"));
  assert.equal(briefs.length, 2);
  // The two processes start together, so which record comes first is not fixed.
  const told = briefs.filter(brief => /Also at work in this session:\n- scout: Find where the loader reads its settings/.test(brief));
  assert.equal(told.length, 1, "the second child is told about the first, and the first had no one beside it");
});

test("the call's role is the default of every tasks item and chain step; an item's own role wins", { timeout: 60_000 }, async t => {
  useTeam(t, { team: { legwork: legworkRoute } });
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "oracle" } });
  const { agent: _agent, task: _task, ...base } = scoutCall();
  const tasks = await runCall(f, { ...base, async: true, role: "legwork", tasks: [{ agent: "oracle", task: "one" }, { agent: "oracle", task: "two", role: "main" }] });
  await awaitNativeBackground(f, tasks);
  const starts = () => f.records().filter(row => row.phase === "start").map(launchModel);
  assert.deepEqual(starts().sort(), [legworkRoute, route].sort(), "oracle is a main agent: the item without a role takes the call's, the other keeps its own");
  const chain = await runCall(f, { ...base, async: true, role: "legwork", chain: [{ agent: "oracle", task: "first" }, { parallel: [{ agent: "oracle", task: "second" }] }] });
  await awaitNativeBackground(f, chain);
  assert.deepEqual(starts().slice(2), [legworkRoute, legworkRoute], "every chain step, parallel members included, takes the call's role");
});

test("an explicit fork launches on the session model whatever its role's model or role line says", { timeout: 60_000 }, async t => {
  useTeam(t, { team: { legwork: "openrouter/org/not-installed" } });
  for (const agentFields of [{ name: "scout" }, { name: "oracle", extraFields: { role: "boss" } }]) {
    const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields });
    persistParentSession(f);
    const forked = await runCall(f, scoutCall({ agent: agentFields.name, context: "fork" }));
    assert.notEqual(forked.isError, true, JSON.stringify(forked.content));
    assert.equal(launchModel(lastStart(f)), route);
    const fresh = await runCall(f, scoutCall({ agent: agentFields.name, context: "fresh" }));
    assert.equal(fresh.isError, true, "a child that does not fork still needs a usable role");
  }
});

test("one launch reads the team settings of its own directory", { timeout: 60_000 }, async t => {
  const f = fixture(t, { reasoning: true, captureNative: true, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout" } });
  const project = path.join(f.cwd, "elsewhere");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ team: { legwork: legworkRoute } }));
  const { agent: _agent, task: _task, ...base } = scoutCall();
  const launched = await runCall(f, { ...base, cwd: project, async: true, chain: [{ agent: "scout", task: "look" }] });
  await awaitNativeBackground(f, launched);
  assert.equal(launchModel(lastStart(f)), legworkRoute, "the chain child runs on the model the launch's own directory sets");
});

test("a step appended to a running chain is capped like any other child", { timeout: 90_000 }, async t => {
  useTeam(t, { team: { legwork: legworkRoute, maxThinking: { legwork: "low" } } });
  const f = fixture(t, { reasoning: true, captureNative: true, childDelayMs: 3000, sessionThinking: "high", models: [legworkModel], agentFields: { name: "scout" } });
  const { agent: _agent, task: _task, ...base } = scoutCall();
  const launched = await runCall(f, { ...base, async: true, chain: [{ agent: "scout", task: "first" }] });
  assert.notEqual(launched.isError, true, JSON.stringify(launched.content));
  const appended = await runCall(f, { action: "append-step", id: launched.details.asyncId, step: { agent: "scout", task: "second", acceptance: { level: "none", reason: "Read-only fixture; no implementation deliverable." } } });
  assert.notEqual(appended.isError, true, JSON.stringify(appended.content));
  const status = await awaitNativeBackground(f, launched);
  assert.deepEqual(status.steps.map(step => step.role), ["legwork", "legwork"], "the appended step's row carries its role, as the first one does");
  const starts = f.records().filter(row => row.phase === "start");
  assert.equal(starts.length, 2);
  assert.equal(launchModel(starts[1]), legworkRoute);
  assert.equal(launchThinking(starts[1]), "low", "the legwork ceiling applies to the appended step");
});
