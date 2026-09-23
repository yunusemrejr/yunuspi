#!/usr/bin/env node
import {resolveOwnedCore} from '../lib/owned-core.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-recovery-"));
const agent = path.join(root, "agent");
fs.mkdirSync(agent, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_SUBAGENT_CHILD;
// Model exclusions persist to a GLOBAL per-UID temp store by default; point it
// into the test root so runs are hermetic — a stale exclusion recorded by an
// earlier run (e.g. a leaked 401) must not refuse this run's synthetic routes.
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, "model-exclusions.json");
process.env.PI_PROVIDER_STATE_FILE = path.join(root, "provider-health.json");
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, "llm-preferences.json");
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, "economy.json");
fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE, "{}");
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, "{}");
// The offline guard below forbids non-loopback sockets. Proxy variables would
// tunnel those requests through the proxy host instead, so the suite that
// asserts hermetic offline behavior must not inherit them.
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) delete process.env[key];
delete process.env.PI_SUBAGENT_CHILD;
// Proactive free assistance is opt-in since 2026-09-07; the default-off check
// below runs first, then the fixtures opt in.
process.env.PI_AUTONOMOUS_FREE_ASSIST = "0";
// This suite exercises the existing generic helper and recovery contracts.
// Scope-council routing/suppression has its own public regression fixture.
process.env.PI_SCOPE_COUNCIL = "off";
const shared = "../../extensions/pi-subagents/src/runs/shared/";
const { READ_ONLY_REASONING_TOOLS } = await import(shared + "tool-budget.ts");
const evidence = await import(shared + "free-route-evidence.ts");
const { registerAutonomousRecovery, assistanceWidth, automaticHelperBody } = await import(
 "../../extensions/pi-subagents/src/extension/autonomous-recovery.ts"
);
const { routeSkills: routeSkillsLite } = await import("../../extensions/lib/skill-routing.ts");
// Step 21: marked flows spend from the shared control; each scenario below
// models a separate request, so isolate the singleton per fixture.
const { resetSharedControl } = await import("../../extensions/lib/intervention-shared.ts");
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const free = (id) => ({
 provider: "openrouter",
 id,
 api: "openai-completions",
 baseUrl: evidence.FREE_BASE_URL,
 cost,
 input: ["text"],
 reasoning: false,
 contextWindow: id.startsWith("free/") ? 131072 : 32768,
 maxTokens: id.startsWith("free/") ? 8192 : 1024,
});
const pricing = {
 prompt: "0",
 completion: "0",
 image: "0",
 request: "0",
 input_cache_read: "0",
 input_cache_write: "0",
};
evidence.publishFreeEvidence(
 ["free/a", "free/b"].map((id) => ({ id, pricing, capabilities: { toolCalling: true } })),
 evidence.FREE_CATALOG_URL,
);
let checks = 0;
function check(name, test) {
 assert.ok(test, name);
 console.log("PASS", name);
 checks++;
}
check(
 "exact raw official free route",
 evidence.isProvenFreeRoute(free("free/a")),
);
// v2 evidence carries per-provider sections; staleness/row patches must be
// applied to the PROVIDER SECTION (top-level rows/fetchedAt are legacy mirrors).
const v2 = (patch) => {
 const r = evidence.readFreeEvidence();
 return {
  ...r,
  providers: {
   ...r.providers,
   openrouter: { ...r.providers.openrouter, ...patch },
  },
 };
};
for (const [name, model, ev] of [
 [
  "wrong endpoint",
  { ...free("free/a"), baseUrl: "http://127.0.0.1" },
  undefined,
 ],
 [
  "orca unknown billing",
  { ...free("free/a"), provider: "orcarouter" },
  undefined,
 ],
 ["store alias", free("free/latest"), undefined],
 ["expired", free("free/a"), v2({ fetchedAt: 0 })],
 [
  "missing pricing",
  free("free/a"),
  v2({ rows: [{ id: "free/a", pricing: { completion: "0" } }] }),
 ],
 [
  "malformed pricing",
  free("free/a"),
  v2({ rows: [{ id: "free/a", pricing: { ...pricing, request: "" } }] }),
 ],
])
 check(name, !evidence.isProvenFreeRoute(model, ev));
const cap = evidence.capFreeRequest(
 { model: "free/a", provider: { only: ["safe"], max_price: { prompt: 1 } } },
 free("free/a"),
);
check(
 "zero caps retain provider restrictions",
 cap.provider.only[0] === "safe" && cap.provider.max_price.prompt === 0,
);
const fixtureDisposals = [];
function fixture({
 models = [free("free/a"), free("free/b")],
 launchResult,
 waitImpl,
 sessionFile,
 appendThrows = false,
 branch = [],
} = {}) {
 resetSharedControl();
 const handlers = new Map();
 const notices = [];
 const statuses = [];
 const calls = [];
 const selected = [];
 const entries = [];
 let clock = Date.now(); // must track real time: evidence staleness uses absolute timestamps
 const primary = {
  ...free("primary"),
  provider: "paid",
  baseUrl: "http://localhost",
  cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 },
 };
 const ctx = {
  model: primary,
  scopedModels: [],
  ui: { setStatus: (key, value) => statuses.push({key,value}) },
  modelRegistry: { getAvailable: () => models },
  sessionManager: {
   getSessionFile: () => sessionFile,
   getLeafId: () => undefined,
   getBranch: () => branch,
  },
 };
 const pi = {
  on: (n, fn) => {
   handlers.set(n, [...(handlers.get(n) || []), fn]);
  },
  sendMessage: (m) => notices.push(m.content),
  appendEntry: (customType, data) => {if(appendThrows&&customType.startsWith('subagent-'))throw Error('fixture accounting unavailable');entries.push({type:'custom',customType,data});if(typeof data.text === "string")notices.push(data.text);},
  setModel: async (m) => {
   ctx.model = m;
   selected.push(m);
   return true;
  },
 };
 registerAutonomousRecovery(
  pi,
  async (id, params, signal) => {
   calls.push({ id, params, signal });
   return launchResult
    ? launchResult(signal)
    : {
       details: {
        results: [{ exitCode: 0, output: "Evidence " + params.model }],
       },
      };
  },
  {
   now: () => clock,
   wait:
    waitImpl ??
    (async (ms) => {
     clock += ms;
    }),
  },
 );
 const emit = async (n, e = {}) => {
  const result = [];
  for (const fn of handlers.get(n) || []) result.push(await fn(e, ctx));
  return result;
 };
 fixtureDisposals.push(() => emit('session_shutdown'));
 return { ctx, emit, notices, statuses, calls, selected, primary, entries };
}
check("routine requests avoid automatic delegation", ['Fix this typo','What is a cache?','Use a swarm to review this project thoroughly','Do not delegate; investigate the concurrency failure deeply'].every(p=>assistanceWidth(p)===0));
check("focused work uses one helper", assistanceWidth('Investigate the parser failure and identify a reproducible cause')===1);
check("independent correctness work uses two complementary helpers", assistanceWidth('Review correctness and concurrency of this implementation before changing it')===2);
const prompt =
 "Implement a bounded change with independent review of correctness and test coverage. Preserve the existing behavior and identify concrete risks before editing.";
const off = fixture();
await off.emit("input", { source: "interactive", text: prompt });
await off.emit("before_agent_start", { prompt });
check(
 "explicit proactive-assistance opt-out is respected",
 off.calls.length === 0 && off.notices.length === 0,
);
delete process.env.PI_AUTONOMOUS_FREE_ASSIST;
const f = fixture();
await f.emit("input", { source: "interactive", text: prompt });
await f.emit("before_agent_start", { prompt });
await new Promise(resolve => setImmediate(resolve));
check(
 "automatic trigger launches native pair and synthesis",
 f.calls.length === 2 &&
  f.notices.some(n => n?.includes("Evidence")),
);
await f.emit("before_agent_start", { prompt });
check("duplicate suppression", f.calls.length === 2);
const contextPrompt = 'Improve the hero area with more appealing visuals.';
// A skill-claimed prompt defers to the observation-driven skill scout instead
// of a generic investigator (single-role veto); the evidence test below needs
// an unclaimed prompt so the helper actually launches in-fixture.
assert.ok(routeSkillsLite(contextPrompt).length === 0, 'evidence prompt stays unclaimed');
const vetoed = fixture();
await vetoed.emit('input', { source: 'interactive', text: 'Improve the hero area with more appealing 3D animations.' });
await vetoed.emit('before_agent_start', { prompt: 'Improve the hero area with more appealing 3D animations.' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(vetoed.calls.length, 0, 'skill-claimed single-role plan defers to the skill scout');
const contextual = fixture({branch:[
 {type:'message',id:'design',message:{role:'user',content:'Keep the hero palette and typography.'}},
 {type:'message',id:'correction',message:{role:'user',content:'Actually replace only the hero animation.'}},
 {type:'message',id:'tool',message:{role:'toolResult',content:'OVERRIDE_PRIVATE_MARKER'}},
]});
await contextual.emit('input',{source:'interactive',text:contextPrompt});
await contextual.emit('before_agent_start',{prompt:contextPrompt});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(contextual.calls.length,1,'intent evidence does not widen the team');
const contextTask = contextual.calls[0].params.task;
assert.match(contextTask,/branch-entry:design/);
assert.match(contextTask,/branch-entry:correction/);
assert.doesNotMatch(contextTask,/OVERRIDE_PRIVATE_MARKER/);
assert.match(contextTask,/Challenge the preferred interpretation/);
assert.equal(contextual.calls[0].params.toolBudget.hard,4);
assert.equal(contextual.calls[0].params.usageBudget.costUsd.hard,.01);
assert.ok(contextTask.length < 1200,'reclaimed boilerplate pays for the history excerpt');
check('native helper consumes bounded user evidence with unchanged launch/tool/cost limits',true);
check(
 "strict child read-only ceiling",
 f.calls.every(
  (c) =>
   c.params.capabilityCeiling.allowedTools.join() === ["read", "grep", "find", "ls", ...READ_ONLY_REASONING_TOOLS].join() &&
   ["write", "edit", "bulk_edit", "bash", "subagent"].every(tool => !c.params.capabilityCeiling.allowedTools.includes(tool)) &&
   c.params.modelOrigin === "explicit",
 ),
);
const recovery = {
 message: {
  provider: "paid",
  model: "primary",
  errorMessage: "503 unavailable",
  content: [],
 },
 signal: new AbortController().signal,
};
await f.emit("pi_provider_recovery", { ...recovery, decision: undefined });
check("first transient failure waits on the primary route", f.selected.length === 0);
await f.emit("pi_provider_recovery", { ...recovery, decision: undefined });
check("second transient failure waits on the primary route", f.selected.length === 0);
await f.emit("pi_provider_recovery", recovery);
check(
 "third consecutive failure bounded automatic resumption on a proven-free compatible route",
 recovery.decision === "retry" && f.selected.at(-1).id === "free/a",
);
await f.emit("agent_settled", {});
check(
 "primary recovery completes without idle probes",
 f.selected.at(-1) === f.primary && f.calls.length === 2,
);
const no = fixture({ models: [] });
await no.emit("input", { source: "interactive", text: prompt });
await no.emit("before_agent_start", { prompt });
check(
 "no-free fail closed",
 no.calls.length === 0 &&
  no.notices.length === 0,
);
evidence.publishFreeEvidence([
 ...['free/a','free/b'].map(id=>({id,pricing,capabilities:{toolCalling:true}})),
 {id:'paid/helper',pricing:{...pricing,prompt:'0.0000001',completion:'0.0000003'},capabilities:{toolCalling:true}},
],evidence.FREE_CATALOG_URL);
const cheapModel={...free('paid/helper'),cost:{input:.1,output:.3,cacheRead:0,cacheWrite:0}};
const cheapAssist=fixture({models:[cheapModel]});
await cheapAssist.emit('input',{source:'interactive',text:prompt});await cheapAssist.emit('before_agent_start',{prompt});await new Promise(resolve=>setImmediate(resolve));
assert.doesNotMatch(cheapAssist.calls[0].params.task,/Parent session evidence is in|Read the relevant sections/);
assert.match(cheapAssist.calls[0].params.task,/Do not browse session logs/);
check('no free capacity uses one proven-capable cheap helper with bounded budget',cheapAssist.calls.length===1 && cheapAssist.calls[0].params.usageBudget.costUsd.hard===.01 && cheapAssist.calls[0].params.toolBudget.hard===4);
// A failed recovery can observe no admissible free route while the shared
// catalog/cooldown state is temporarily stale. That miss must not consume the
// one-group budget: once fresh proof arrives, a later failure may still use the
// newly available cheap helper. Keep the route below the continuation output
// budget so direct model replacement cannot mask the group retry.
const lateRoute = { ...free('late/cheap'), maxTokens: 1024 };
const lateCapacity = fixture({ models: [lateRoute] });
lateCapacity.primary.maxTokens = 8192; // helper fits, continuation does not
await lateCapacity.emit('input', { source: 'interactive', text: prompt });
await lateCapacity.emit('pi_provider_recovery', { ...recovery });
await lateCapacity.emit('pi_provider_recovery', { ...recovery });
check('temporary lack of free proof does not consume helper-group budget', lateCapacity.calls.length === 0);
evidence.publishFreeEvidence([{ id: lateRoute.id, pricing, capabilities: { toolCalling: true } }], evidence.FREE_CATALOG_URL);
await lateCapacity.emit('pi_provider_recovery', { ...recovery });
await new Promise(resolve => setImmediate(resolve));
check('fresh free proof re-enables one bounded helper group', lateCapacity.calls.length === 1);
evidence.publishFreeEvidence(
 [
  ...['free/a', 'free/b'].map(id => ({ id, pricing, capabilities: { toolCalling: true } })),
  { id: 'paid/helper', pricing: { ...pricing, prompt: '0.0000001', completion: '0.0000003' }, capabilities: { toolCalling: true } },
 ],
 evidence.FREE_CATALOG_URL,
);
const {resolveEffectiveAcceptance, formatAcceptancePrompt} = await import(shared+'acceptance.ts');
const helperContract=resolveEffectiveAcceptance({explicit:cheapAssist.calls[0].params.acceptance,agentName:'automatic-free-assistant',task:cheapAssist.calls[0].params.task});
check('advisory helpers do not spend budget producing work-acceptance reports',helperContract.level==='none' && formatAcceptancePrompt(helperContract)==='');
assert.match(cheapAssist.calls[0].params.task,/At most four tool calls and one listing/);
assert.match(cheapAssist.calls[0].params.task,/No acceptance report or formatting tools/);
assert.equal(automaticHelperBody({finalOutput:'acceptance-report\n```acceptance-report\n{"reviewFindings":["no blockers"]}\n```'}),'');
for(const heading of ['## Acceptance report','**Acceptance-report**','**Acceptance report:**','__Acceptance_report__','Acceptance report:'])assert.equal(automaticHelperBody({finalOutput:heading+'\n```acceptance-report\n{}\n```'}),'','standalone report heading is not advisory evidence');
assert.equal(automaticHelperBody({finalOutput:'The acceptance report omitted the failing cancellation case.'}),'The acceptance report omitted the failing cancellation case.','actual prose mentioning a report is preserved');
assert.equal(automaticHelperBody({finalOutput:'NO_USEFUL_FINDINGS',messages:[{role:'assistant',content:[{type:'text',text:'Preliminary thought'}]}]}),'');
assert.equal(automaticHelperBody({finalOutput:'```acceptance-report\n{}\n```',messages:[{role:'assistant',content:[{type:'text',text:'src/request.ts:14 lacks a cancellation check.'}]}]}),'src/request.ts:14 lacks a cancellation check.');
const metricEvents=[];const metricSymbol=Symbol.for('yunus-pi.metrics.v1');
globalThis[metricSymbol]=(kind)=>metricEvents.push(kind);
try {
 const single=fixture({models:[cheapModel]}); await single.emit('input',{source:'interactive',text:prompt});await single.emit('before_agent_start',{prompt});await new Promise(resolve=>setImmediate(resolve));
 check('forwarding one helper is not a fusion or swarm',metricEvents.length===0);
 const pair=fixture(); await pair.emit('input',{source:'interactive',text:prompt});await pair.emit('before_agent_start',{prompt});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(metricEvents,['swarms','fusions']);metricEvents.length=0;
 const empty=fixture({launchResult:async()=>({details:{results:[{exitCode:0,finalOutput:'```acceptance-report\n{}\n```'}]}})});
 await empty.emit('input',{source:'interactive',text:prompt});await empty.emit('before_agent_start',{prompt});await new Promise(resolve=>setImmediate(resolve));
 check('report-only helpers never synthesize or count a fusion',metricEvents.join()==='swarms' && !empty.notices.some(n=>n?.includes('supplied advisory output')));
} finally {delete globalThis[metricSymbol];}
const {recordSuccess}=await import(shared+'provider-health.ts');
const {collectSessionMetrics}=await import('../../extensions/lib/session-metrics.ts');
const helperSessionFile=path.join(root,'helper-parent-session.jsonl');fs.writeFileSync(helperSessionFile,'');
const resetHelperHealth=()=>recordSuccess({provider:cheapModel.provider,model:cheapModel.id});
const startHelper=async fixture=>{await fixture.emit('input',{source:'interactive',text:prompt});await fixture.emit('before_agent_start',{prompt});await new Promise(resolve=>setImmediate(resolve));};
for(const [name,launchResult,status] of [
 ['empty resolved error',async()=>({isError:true,details:{results:[]}}),'failed'],
 ['malformed resolved results',async()=>({details:{results:[null]}}),'failed'],
 ['missing resolved result',async()=>undefined,'failed'],
 ['thrown launch',async()=>{throw Error('fixture launch failed');},'failed'],
 ['stopped resolved child',async()=>({details:{results:[{exitCode:0,stopped:true}]}}),'stopped'],
]){
 resetHelperHealth();const f=fixture({models:[cheapModel],sessionFile:helperSessionFile,launchResult});await startHelper(f);
 assert.equal(f.calls.length,1,name+' launches exactly once');assert.equal(f.entries.filter(e=>e.customType==='subagent-lifecycle-v1').at(-1)?.data.state,status,name+' settles');
 const m=collectSessionMetrics(f.entries);assert.equal(m.agents,1);assert.equal(m.agentsActive,0,name+' does not strand active counter');
}
resetHelperHealth();
let finishAborted;const aborted=fixture({models:[cheapModel],sessionFile:helperSessionFile,launchResult:()=>new Promise(resolve=>finishAborted=resolve)});
await startHelper(aborted);await aborted.emit('agent_end');finishAborted({details:{results:[]}});await new Promise(resolve=>setImmediate(resolve));
assert.equal(aborted.entries.filter(e=>e.customType==='subagent-lifecycle-v1').at(-1)?.data.state,'stopped','abort with empty resolved payload settles original session');
resetHelperHealth();
let finishOld;const switched=fixture({models:[cheapModel],sessionFile:helperSessionFile,launchResult:()=>new Promise(resolve=>finishOld=resolve)});
await startHelper(switched);const originalCount=switched.entries.length;switched.ctx.sessionManager.getSessionFile=()=>path.join(root,'different-parent.jsonl');finishOld({details:{results:[]}});await new Promise(resolve=>setImmediate(resolve));
assert.equal(switched.entries.length,originalCount,'late completion cannot append accounting to a different current session');
resetHelperHealth();
let finishEpoch;const newEpoch=fixture({models:[cheapModel],sessionFile:helperSessionFile,launchResult:()=>new Promise(resolve=>finishEpoch=resolve)});
await startHelper(newEpoch);const epochCount=newEpoch.entries.length;await newEpoch.emit('session_before_switch');finishEpoch({details:{results:[]}});await new Promise(resolve=>setImmediate(resolve));
assert.equal(newEpoch.entries.length,epochCount,'cancelled old generation cannot append lifecycle during a session switch');
resetHelperHealth();const brokenAccounting=fixture({models:[cheapModel],sessionFile:helperSessionFile,appendThrows:true});await startHelper(brokenAccounting);
assert.equal(brokenAccounting.calls.length,1,'accounting failure does not suppress launch');assert.ok(brokenAccounting.notices.some(n=>n?.includes('supplied advisory output')),'accounting failure does not replace successful advisory outcome');
resetHelperHealth();const brokenFailure=fixture({models:[cheapModel],sessionFile:helperSessionFile,appendThrows:true,launchResult:async()=>{throw Error('original launch failure');}});await startHelper(brokenFailure);
assert.equal(brokenFailure.calls.length,1);assert.ok(brokenFailure.notices.some(n=>n?.includes('no usable evidence')),'lifecycle sink failure does not escape the primary launch failure path');
resetHelperHealth();
check('automatic child failures, malformed outputs, aborts, session ownership and accounting failures settle safely',true);
const onlyFree=fixture({models:[cheapModel]});const freePrompt=prompt+' Free-only assistance.';
await onlyFree.emit('input',{source:'interactive',text:freePrompt});await onlyFree.emit('before_agent_start',{prompt:freePrompt});await new Promise(resolve=>setImmediate(resolve));
check('free-only request prevents paid helper substitution',onlyFree.calls.length===0);
const paid = fixture({
 models: [
  {
   ...free("primary"),
   provider: "other",
   cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
  },
 ],
});
await paid.emit("input", { source: "interactive", text: "continue" });
await paid.emit("pi_provider_recovery", { ...recovery, decision: undefined });
check(
 "paid escalation rejected",
 paid.selected.every((m) => m.provider === "paid"),
);
const quota = fixture({
 launchResult: async () => ({ isError: true, details: { results: [] } }),
});
await quota.emit("input", { source: "interactive", text: prompt });
await quota.emit("before_agent_start", { prompt });
await new Promise(resolve => setImmediate(resolve));
await quota.emit("pi_provider_recovery", { ...recovery, decision: undefined });
check(
 "quota failure no respawn loop",
 quota.calls.length === 2 &&
  quota.notices.some((n) => n.includes("no unvisited compatible route")),
);
const cancel = fixture({
 models: [],
 waitImpl: async (_ms, signal) => {
  await new Promise((resolve) =>
   signal.addEventListener("abort", resolve, { once: true }),
  );
  throw new Error("aborted");
 },
});
await cancel.emit("input", { source: "interactive", text: "continue" });
const abort = new AbortController();
const pending = cancel.emit("pi_provider_recovery", {
 ...recovery,
 signal: abort.signal,
});
setTimeout(() => abort.abort(), 10);
await pending;
check(
 "abort cancels recovery without continuation",
 cancel.selected.length === 0,
);
const bound = fixture({ models: [] });
await bound.emit("input", { source: "interactive", text: "continue" });
for (let i = 0; i < 5; i++) {
 const e = { ...recovery, decision: undefined };
 await bound.emit("pi_provider_recovery", e);
 if (i === 4) check("maximum attempts pause", e.decision === "pause");
}
for (const errorMessage of ["500 internal server error", "ECONNRESET", "request timed out", "429 too many requests"]) {
 const transient = fixture({ models: [] });
 await transient.emit("input", { source: "interactive", text: "continue" });
 const e = { ...recovery, decision: undefined, message: { ...recovery.message, errorMessage } };
 await transient.emit("pi_provider_recovery", e);
 check(`shared classification resumes ${errorMessage}`, e.decision === "retry");
 await transient.emit("agent_settled");
}
const rejected = fixture();
await rejected.emit("input", { source: "interactive", text: "continue" });
const rejectedEvent = { ...recovery, decision: undefined, message: { ...recovery.message, errorMessage: "content moderation: upstream unavailable" } };
await rejected.emit("pi_provider_recovery", rejectedEvent);
check("deterministic rejection never reroutes", rejectedEvent.decision === "pause" && rejected.selected.length === 0);
await f.emit("message_end", {message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"Recovered"}]}});
check("successful response clears stale recovery badge", f.statuses.at(-1)?.key === "autonomous-recovery" && f.statuses.at(-1)?.value === undefined);
for (const dispose of fixtureDisposals) await dispose();
// Real Pi + native child executor. A preload redirects only the official mock route;
// every other non-loopback fetch is rejected. No external inference or catalog probes.
const source = path.resolve(import.meta.dirname, "../../extensions");
fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
fs.cpSync(
 path.join(source, "pi-subagents"),
 path.join(agent, "extensions/pi-subagents"),
 { recursive: true },
);
fs.mkdirSync(path.join(agent, "extensions/lib"), {recursive:true});
fs.cpSync(path.join(source, "lib"), path.join(agent, "extensions/lib"), {recursive:true});
// scope-council-runner.ts imports the micro-intelligence owner directly.
fs.copyFileSync(path.join(source, "micro-intelligence.ts"), path.join(agent, "extensions/micro-intelligence.ts"));
fs.symlinkSync(
 path.resolve(resolveOwnedCore(), "../../node_modules"),
 path.join(agent, "extensions/node_modules"),
 "dir",
);
const requests = [];
let parentRequests = 0;
const workerMarker="CONTINUATION-WORKER-FIXTURE";
const workerDataPath=path.join(root,"worker-evidence.txt");fs.writeFileSync(workerDataPath,"EXACT-WORKER-EVIDENCE-429");
// The live leg advertises real tool support through the existing official
// catalog evidence owner. Root failure may then select a free alternative.
evidence.publishFreeEvidence(
 ["free/a", "free/b"].map((id) => ({ id, pricing, capabilities: { toolCalling: true } })),
 evidence.FREE_CATALOG_URL,
);
const isParent = (body) => body.tools?.some((t) => t.function?.name === "subagent");
const server = http.createServer((req, res) => {
 let text = "";
 req.on("data", (b) => (text += b));
 req.on("end", () => {
  let b;
  try {
   b = JSON.parse(text);
  } catch {
   return; // malformed probe body, never a harness request
  }
  requests.push(b);
  if(JSON.stringify(b.messages??[]).includes(workerMarker)) {
   const hasEvidence=(b.messages??[]).some(m=>m.role==="tool"&&JSON.stringify(m).includes("EXACT-WORKER-EVIDENCE-429"));
   if(b.model==="free/a"&&hasEvidence){res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"503 worker route unavailable"}}));return;}
   const delta=hasEvidence?{role:"assistant",content:"WORKER-RESUMED"}:{role:"assistant",tool_calls:[{index:0,id:"read-fixture",type:"function",function:{name:"read",arguments:JSON.stringify({path:workerDataPath})}}]};
   res.writeHead(200,{"Content-Type":"text/event-stream"});
   res.end("data: "+JSON.stringify({id:"worker",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta,finish_reason:null}]})+"\n\ndata: "+JSON.stringify({id:"worker",object:"chat.completion.chunk",model:b.model,choices:[{index:0,delta:{},finish_reason:hasEvidence?"stop":"tool_calls"}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+"\n\ndata: [DONE]\n\n");return;
  }
  // The session model changes only after three consecutive failures: the
  // first two parent attempts fail and wait on the primary route, the third
  // failure authorizes the switch, and the rerouted fourth attempt succeeds.
  if (
   isParent(b) &&
   parentRequests++ < 3
  ) {
   res.writeHead(503, { "Content-Type": "application/json" });
   res.end(JSON.stringify({ error: { message: "503 unavailable" } }));
   return;
  }
  const answer =
   isParent(b) ? "PARENT-RESUMED" : "FREE-EVIDENCE-" + b.model;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
   "data: " +
    JSON.stringify({
     id: "mock",
     object: "chat.completion.chunk",
     model: b.model,
     choices: [
      {
       index: 0,
       delta: { role: "assistant", content: answer },
       finish_reason: null,
      },
     ],
    }) +
    "\n\ndata: " +
    JSON.stringify({
     id: "mock",
     object: "chat.completion.chunk",
     model: b.model,
     choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
     usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }) +
    "\n\ndata: [DONE]\n\n",
  );
 });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const loopbackBase = `http://127.0.0.1:${port}/v1`;
// Test-only clone aliases the canonical wire origin to its explicit loopback
// config. Pricing/catalog proofs are otherwise unchanged; production origin
// checks are exercised above. No model in this native leg has a remote baseUrl.
const clonedEvidence = path.join(agent, "extensions/pi-subagents/src/runs/shared/free-route-evidence.ts");
fs.writeFileSync(clonedEvidence, fs.readFileSync(clonedEvidence, "utf8").replace(`export const FREE_BASE_URL = ${JSON.stringify(evidence.FREE_BASE_URL)};`, `export const FREE_BASE_URL = ${JSON.stringify(loopbackBase)};`));
const preload = path.join(root, "wire.mjs");
const deniedFetches = path.join(root, "denied-fetches.log");
const guardedProcesses = path.join(root, "guarded-processes.log");
fs.writeFileSync(
 preload,
 `import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
appendFileSync(${JSON.stringify(guardedProcesses)}, process.pid + String.fromCharCode(10));
function deny(where) {
 appendFileSync(${JSON.stringify(deniedFetches)}, where + String.fromCharCode(10));
 throw Error("External network forbidden: " + where);
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
 const a = Array.isArray(args[0]) ? args[0] : args;
 const host = typeof a[0] === "object" ? a[0].host : typeof a[1] === "string" ? a[1] : "localhost";
 if (host !== "127.0.0.1") return deny("socket:" + host);
 return connect.apply(this, args);
};
tls.connect = () => deny("tls");
const original = globalThis.fetch;
function guardedFetch(input, init) {
 const url = typeof input === "string" ? input : input.url ?? String(input);
 const parsed = new URL(url);
 if (parsed.origin !== "http://127.0.0.1:${port}") return deny(parsed.href);
 return original(url, init);
}
Object.defineProperty(globalThis, "fetch", { configurable: false, get: () => guardedFetch, set: () => {} });
`,
);
// Child launch deliberately strips NODE_OPTIONS. Use its existing executable
// override so the guard loads before SDK modules capture fetch; extension-load
// shims are too late and can accidentally contact the official endpoint.
const wrapper = path.join(root, "offline-pi.mjs");
const packageRoot=resolveOwnedCore();
const piCli=path.join(packageRoot,JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).bin.yunuspi);
const coreDist=path.join(packageRoot,'dist');
fs.writeFileSync(
 wrapper,
 `#!${process.execPath}\nawait import(${JSON.stringify("file://" + preload)});\nprocess.argv[1]=${JSON.stringify(piCli)};\nawait import(${JSON.stringify("file://" + piCli)});\n`,
 { mode: 0o700 },
);
// Reproduce Pi's dispatcher reinstall BEFORE launching any inference. The guard
// must survive undici.install(), and its denied fetch must never open a socket.
execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify("file://" + preload)});const {configureHttpDispatcher}=await import(${JSON.stringify("file://" + path.join(coreDist, "core/http-dispatcher.js"))});configureHttpDispatcher();for(const request of [()=>fetch('https://offline-guard.invalid/'),()=>import(${JSON.stringify("file://" + path.join(coreDist, "../../../node_modules/undici/index.js"))}).then(m=>m.request('https://offline-guard.invalid/')),()=>import('node:net').then(m=>m.connect({host:'offline-guard.invalid',port:443}))]){try{await request();process.exit(2)}catch(e){if(!String(e).includes('External network forbidden'))throw e}}`], { env: process.env, stdio: "pipe", timeout: 10_000 });
assert.match(fs.readFileSync(deniedFetches, "utf8"), /offline-guard\.invalid/);
fs.rmSync(deniedFetches);
fs.rmSync(guardedProcesses);
const def = (id, rates) => ({
 id,
 name: id,
 reasoning: false,
 contextWindow: id.startsWith("free/") ? 131072 : 32768,
 maxTokens: id.startsWith("free/") ? 8192 : 1024,
 input: ["text"],
 cost: rates,
});
fs.writeFileSync(
 path.join(agent, "models.json"),
 JSON.stringify({
  providers: {
   mock: {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    models: [
     def("primary", { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 }),
    ],
   },
   openrouter: {
    api: "openai-completions",
    baseUrl: loopbackBase,
    apiKey: "test",
    models: [def("free/a", cost), def("free/b", cost)],
   },
  },
 }),
);
fs.writeFileSync(
 path.join(agent, "settings.json"),
 JSON.stringify({
  subagents: { defaultModel: "inherit" },
  retry: { enabled: true, maxRetries: 0 },
  compaction: { enabled: false },
 }),
);
const env = {
 ...process.env,
 PI_CODING_AGENT_DIR: agent,
 NODE_OPTIONS: `--import=${preload}`,
};
for (const key of Object.keys(env))
 if (key.startsWith("PI_SUBAGENT") || key.startsWith("PI_FORK"))
  delete env[key];
env.PI_SUBAGENT_PI_BINARY = wrapper;
const child = spawn(
 wrapper,
 [
  "-p",
  "--offline",
  "--mode",
  "json",
  "--provider",
  "mock",
  "--model",
  "primary",
  "--thinking",
  "off",
  "-e",
  path.join(agent, "extensions/pi-subagents/index.ts"),
  "--session",
  path.join(root, "session.jsonl"),
  prompt,
 ],
 { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let stdout = "",
 stderr = "";
child.stdout.on("data", (b) => (stdout += b));
child.stderr.on("data", (b) => {
 stderr += b;
 if (process.env.AUTO_RECOVERY_DEBUG) process.stderr.write(b);
});
const timer = setTimeout(() => {
 try {
  process.kill(-child.pid, "SIGKILL");
 } catch {}
}, 150000);
try {
 const exit = await new Promise((r) => child.on("close", r));
 clearTimeout(timer);
 if (
  exit !== 0 ||
  requests.filter((r) => r.model.startsWith("free/") && !isParent(r)).length > 2
 )
  console.log(
   "WIRE DIAGNOSTIC",
   exit,
   stderr.slice(-5000),
   stdout.slice(-10000),
  );
 check(
  `REAL root and any started helpers use the guard and attempt no external fetch${fs.existsSync(deniedFetches) ? ` (blocked: ${fs.readFileSync(deniedFetches, "utf8").trim()})` : ""}`,
  !fs.existsSync(deniedFetches) && new Set(fs.readFileSync(guardedProcesses, "utf8").trim().split("\n")).size >= 1,
 );
 check(
  "REAL async helpers stay bounded while provider recovery cancels pending work",
  exit === 0 && requests.filter((r) => r.model.startsWith("free/") && !isParent(r)).length <= 2,
 );
 if(requests.some(r=>r.model.startsWith("free/")&&(r.provider?.max_price?.prompt!==0||r.provider?.max_price?.completion!==0)))
  console.log("FREE CAP DIAGNOSTIC",JSON.stringify(requests.map(r=>({model:r.model,parent:isParent(r),provider:r.provider,max_tokens:r.max_tokens,max_completion_tokens:r.max_completion_tokens}))));
 check(
  "REAL free wire zero caps",
  requests
   .filter((r) => r.model.startsWith("free/"))
   .every(
    (r) =>
     r.provider?.max_price?.prompt === 0 &&
     r.provider?.max_price?.completion === 0,
   ),
 );
 if (!(stdout.includes("PARENT-RESUMED") && parentRequests === 4 && requests.some(r => isParent(r) && r.model === "free/a"))) console.log("RECOVERY DIAGNOSTIC", JSON.stringify(requests.map(r => ({ model: r.model, parent: isParent(r), max_tokens: r.max_tokens, max_completion_tokens: r.max_completion_tokens }))), stdout.split("\n").filter(line => line.includes("provider-recovery") || line.includes("PARENT-RESUMED")).join("\n").slice(0, 8000));
 check(
  "REAL failed parent resumes on a compatible affordable alternative without waiting for helpers",
  stdout.includes("PARENT-RESUMED") &&
   parentRequests === 4 && requests.some(r => isParent(r) && r.model === "free/a"),
 );
 check(
  "REAL failed assistant evidence retained",
  fs
   .readFileSync(path.join(root, "session.jsonl"), "utf8")
   .includes("503 unavailable"),
 );
 const workerEnv={...env,PI_SUBAGENT_CHILD:"1",PI_AUTONOMOUS_FREE_ASSIST:"0",PI_SUBAGENT_MODEL_ROUTE_CANDIDATE:JSON.stringify({route:"openrouter/free/a"}),PI_SUBAGENT_RECOVERY_ROUTES:JSON.stringify(["openrouter/free/a","openrouter/free/b"]),PI_PROVIDER_STATE_FILE:path.join(root,"worker-health.json")};
 const worker=spawn(wrapper,["-p","--offline","--mode","json","--provider","openrouter","--model","free/a","--thinking","off","--tools","read","--no-extensions","-e",path.join(agent,"extensions/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts"),"--session",path.join(root,"worker-session.jsonl"),`${workerMarker}: Read ${workerDataPath} once, then report its evidence.`],{cwd:root,env:workerEnv,stdio:["ignore","pipe","pipe"],detached:true});
 let workerOut="",workerErr="";worker.stdout.on("data",b=>workerOut+=b);worker.stderr.on("data",b=>workerErr+=b);
 const workerTimer=setTimeout(()=>{try{process.kill(-worker.pid,"SIGKILL");}catch{}},120000);
 const workerExit=await new Promise(resolve=>worker.on("close",resolve));clearTimeout(workerTimer);
 if(workerExit!==0||!workerOut.includes("WORKER-RESUMED"))console.log("WORKER DIAGNOSTIC",workerExit,workerErr.slice(-3000),workerOut.slice(-5000));
 const workerRequests=requests.filter(b=>JSON.stringify(b.messages??[]).includes(workerMarker));
 check("REAL explicit worker bootstrap is guarded even when proactive helpers are cancelled before spawn", !fs.existsSync(deniedFetches) && new Set(fs.readFileSync(guardedProcesses,"utf8").trim().split("\n")).size >= 2);
 check("REAL worker switches admitted routes inside its existing session",workerExit===0&&workerOut.includes("WORKER-RESUMED")&&workerRequests.some(b=>b.model==="free/b"));
 check("REAL worker retains completed tool evidence without replay",workerRequests.filter(b=>!b.messages.some(m=>m.role==="tool")).length===1&&workerRequests.filter(b=>b.model==="free/b").every(b=>b.messages.some(m=>m.role==="tool"&&JSON.stringify(m).includes("EXACT-WORKER-EVIDENCE-429"))));
 check("REAL worker retains free request price caps after switching",workerRequests.every(b=>b.provider?.max_price?.prompt===0&&b.provider?.max_price?.completion===0));
 console.log(`${checks}/${checks} passed`);
} finally {
 clearTimeout(timer);
 server.closeAllConnections();
 await new Promise((r) => server.close(r));
 fs.rmSync(root, { recursive: true, force: true });
}
