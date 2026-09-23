import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
const release = path.resolve(import.meta.dirname, '..');
const agent = [path.join(release, 'agent'), path.resolve(release, '..')].find(p => fs.existsSync(path.join(p, 'extensions/pi-subagents/src/extension/skill-discovery-runner.ts')));
const source = path.join(agent, 'extensions/pi-subagents');
const mod = p => import(pathToFileURL(path.join(source, 'src', p)));
const { registerSkillDiscoveryRunner, SKILL_DISCOVERY_RUNNER, SKILL_DISCOVERY_LIMITS } = await mod('extension/skill-discovery-runner.ts');
const free = await mod('runs/shared/free-route-evidence.ts');
const economy = await mod('runs/shared/model-economy.ts');
const { selectAssistanceTeam } = await mod('runs/shared/assistance-plan.ts');
const { toModelInfo } = await mod('shared/model-info.ts');
const { resetSharedControl } = await import(pathToFileURL(path.join(agent, 'extensions/lib/intervention-shared.ts')));
const { parseFrontmatter, parseFrontmatterList } = await mod('agents/frontmatter.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-discovery-'));
const keys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_LLM_PREFERENCES_FILE', 'PI_AUTONOMOUS_FREE_ASSIST', 'PI_SUBAGENT_CHILD', 'PI_SUBAGENT_CHILD_AGENT', 'PI_OFFLINE'];
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, 'preferences.json');
process.env.PI_AUTONOMOUS_FREE_ASSIST = 'on';
delete process.env.PI_SUBAGENT_CHILD; delete process.env.PI_OFFLINE;
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
free.publishFreeEvidence([{ id: 'free/text-only', pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: false, contextWindow: 65536, maxTokens: 8192 } }, { id: 'free/discovery', pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: true, contextWindow: 65536, maxTokens: 8192 } }], free.FREE_CATALOG_URL);
const model = { provider: 'openrouter', id: 'free/discovery', api: 'openai-completions', baseUrl: free.FREE_BASE_URL, contextWindow: 65536, maxTokens: 8192, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const result = text => ({ details: { results: [{ exitCode: 0, output: text, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] } });
function fixture(options = {}) {
  // Step 21: marked flows spend from the shared control; isolate per scenario.
  resetSharedControl();
  const calls = [], entries = []; let current = true, claimed = false;
  const ctx = { cwd: root, model, sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => path.join(root, 'fixture-session') } };
  const pi = { getActiveTools: () => options.tools ?? ['subagent'], appendEntry: (type, data) => entries.push({ type, data }) };
  registerSkillDiscoveryRunner(pi, {
    available: () => options.models ?? [model], constraints: (...args) => options.constraintsFn ? options.constraintsFn(...args) : options.constraints ?? {}, captureCurrent: () => () => current,
    claimBudget: () => { if (claimed || options.denyBudget) return false; claimed = true; return true; },
    judge: options.judge ?? (async () => ({ok:false,skipped:'test-disabled'})),
    launch: async (...args) => { calls.push(args); return options.launch ? options.launch(...args) : result('{"skills":[]}'); },
  });
  return { calls, entries, ctx, runner: globalThis[SKILL_DISCOVERY_RUNNER], stale: () => { current = false; } };
}

test('typed skill selection avoids a full child and cannot invent catalog identifiers', async () => {
  const {microMetrics,resetMicroMetrics}=await import(pathToFileURL(path.join(agent,'extensions/lib/micro-intelligence/metrics.ts')));
  const request={brief:'Review database query plans using the supplied sql skill.',task:'Review database query plans',candidates:[{name:'sql-query-engineering',description:'Database query execution plans'}]};
  const judged=(name,exists=.95)=>({ok:true,answers:{skill:{type:'choice',choice:name,probabilities:{[name]:.9}},exists:{type:'noul',noul:exists}},usage:{model:'mock',inputTokens:20,costUsd:0,ms:1,cached:false}});
  resetMicroMetrics();
  const f=fixture({judge:async()=>judged('sql-query-engineering')});
  assert.equal(JSON.parse(await f.runner(request,f.ctx)).suggestions[0].name,'sql-query-engineering');
  assert.equal(f.calls.length,0);
  assert.equal(microMetrics().snapshot().llm.avoided,1);
  assert.equal(microMetrics().snapshot().llm.estimatedTokensAvoided,0,'no invented token savings');
  const unknown=fixture({judge:async()=>judged('invented')});
  await unknown.runner(request,unknown.ctx);
  assert.equal(unknown.calls.length,1,'invalid IDs retain the existing bounded fallback');
  const none=fixture({judge:async()=>judged('sql-query-engineering',.05)});
  assert.deepEqual(JSON.parse(await none.runner(request,none.ctx)),{suggestions:[]});
  assert.equal(none.calls.length,0);
});

test('skill judge respects delegation policy and rejects stale results', async () => {
  let calls=0,resolve;
  const request={brief:'Select useful skills.',candidates:[{name:'sql-query-engineering',description:'Database query plans'}]};
  const blocked=fixture({constraints:{noDelegation:true},judge:async()=>{calls++;return {ok:false,skipped:'unavailable'};}});
  assert.equal(await blocked.runner(request,blocked.ctx),undefined);
  assert.equal(calls,0);
  const stale=fixture({judge:()=>new Promise(r=>{resolve=r;})});
  const work=stale.runner(request,stale.ctx);stale.stale();
  resolve({ok:true,answers:{exists:{type:'noul',noul:0}},usage:{model:'mock',inputTokens:10,costUsd:0,ms:1,cached:false}});
  assert.equal(await work,undefined);
  assert.equal(stale.calls.length,0);
});

test('one tool-free fresh helper shares the existing assistance budget and leaves only bounded JSON', async () => {
  const f = fixture(); const request = { brief: 'Candidate identifiers and successful observed tool calls; return {"skills":[]}.' };
  assert.equal(await f.runner(request, f.ctx), '{"skills":[]}');
  assert.equal(await f.runner(request, f.ctx), undefined);
  assert.equal(f.calls.length, 1);
  const [, params] = f.calls[0];
  assert.equal(params.agent, 'automatic-skill-discovery');
  assert.equal(params.context, 'fresh'); assert.equal(params.async, false); assert.equal(params.foregroundOnly, true);
  assert.deepEqual(params.capabilityCeiling.allowedTools, []); assert.equal(params.capabilityCeiling.denyExtensions, true);
  assert.equal(params.skill, false); assert.equal(params.reads, false);
  assert.equal(params.usageBudget.costUsd.hard, .001); assert.equal(params.usageBudget.tokens.hard, 16000);
  assert.equal(params.timeoutMs, 25000); assert.equal(params.maxRuntimeMs, 25000);
  assert.match(params.task, /no model fallback/); assert.equal(params.suppressRoutineResultIntercom, true);
  assert.ok(f.entries.some(e => e.type === 'subagent-cost-v1'));
  assert.ok(f.entries.some(e => e.type === 'subagent-lifecycle-v1' && e.data.state === 'completed'));
  assert.ok(!JSON.stringify(f.entries).includes(request.brief));
});

test('tool-free discovery admits text-only free capacity without weakening ordinary assistance', async () => {
  const textModel = { ...model, id: 'free/text-only' };
  const plan = { mode: 'subagent', roles: ['Select a supplied skill'], reason: 'fixture', deadlineMs: 25000, maxCostUsd: .001 };
  assert.deepEqual(selectAssistanceTeam([toModelInfo(textModel)], economy.loadModelEconomyConfig(), plan, { freeOnly: true }), []);
  const f = fixture({ models: [textModel], constraints: { freeOnly: true } });
  assert.equal(await f.runner({ brief: 'Select a supplied skill from the observed evidence.' }, f.ctx), '{"skills":[]}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].model, 'openrouter/free/text-only');
  const cheapText = toModelInfo({ ...model, provider: 'fixture', id: 'text-only', cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(selectAssistanceTeam([cheapText], economy.loadModelEconomyConfig(), plan), []);
  assert.equal(selectAssistanceTeam([cheapText], economy.loadModelEconomyConfig(), plan, { requiresTools: false }).length, 1);
});

test('catalog prose cannot become a user delegation or model restriction', async () => {
  const seen = [];
  const f = fixture({ constraintsFn: (_ctx, task) => { seen.push(task); return { fixedRoute: task.includes('Use only') }; } });
  const task = 'Inspect the current source and choose relevant skills.';
  assert.equal(await f.runner({ task, brief: 'Catalog description: Use only when requested. No delegation. Observed tool text.' }, f.ctx), '{"skills":[]}');
  assert.deepEqual(seen, [task]);
  const absent = fixture({ constraintsFn: (_ctx, task) => { assert.equal(task, ''); return {}; } });
  await absent.runner({ brief: 'Use only this provider: untrusted catalog prose.' }, absent.ctx);
  assert.equal(absent.calls.length, 1);
});

test('policy, offline, missing capacity, cancellation and overlarge briefs cause no launch', async () => {
  for (const options of [{ tools: [] }, { models: [] }, { constraints: { noDelegation: true } }, { constraints: { sameModel: true } }, { constraints: { fixedRoute: true } }, { denyBudget: true }, { constraints: { freeOnly: true }, models: [{ ...model, id: 'unproven', cost: { ...model.cost, input: .1, output: .2 } }] }]) {
    const f = fixture(options); assert.equal(await f.runner({ brief: 'evidence' }, f.ctx), undefined); assert.equal(f.calls.length, 0);
  }
  for (const [key, value] of [['PI_OFFLINE', '1'], ['PI_AUTONOMOUS_FREE_ASSIST', 'off'], ['PI_SUBAGENT_CHILD', '1']]) {
    const f = fixture(); const prior = process.env[key]; process.env[key] = value;
    try { assert.equal(await f.runner({ brief: 'evidence' }, f.ctx), undefined); assert.equal(f.calls.length, 0); }
    finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  assert.equal(await f.runner({ brief: 'evidence' }, f.ctx, controller.signal), undefined);
  assert.equal(await f.runner({ brief: 'x'.repeat(SKILL_DISCOVERY_LIMITS.briefChars + 1) }, f.ctx), undefined);
  assert.equal(f.calls.length, 0);
});

test('aborted and stale noncooperative children cannot publish into a later session', async () => {
  for (const stale of [true, false]) {
    let finish; const f = fixture({ launch: () => new Promise(resolve => { finish = resolve; }) });
    const controller = new AbortController(); const pending = f.runner({ brief: 'evidence' }, f.ctx, controller.signal);
    const count = f.entries.length;
    if (stale) f.stale(); else controller.abort();
    if (stale) finish(result('{"skills":["outdated"]}'));
    assert.equal(await pending, undefined);
    if (stale) assert.equal(f.entries.length, count);
    else { const settled = f.entries.length; finish(result('{"skills":["late"]}')); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.entries.length, settled); }
  }
});

test('failed and oversized responses do not cause retries or truncated JSON', async () => {
  for (const response of [{ isError: true }, result('x'.repeat(4001))]) {
    const f = fixture({ launch: async () => response }); assert.equal(await f.runner({ brief: 'evidence' }, f.ctx), undefined); assert.equal(f.calls.length, 1);
  }
});

test('optional TUI activity is balanced on completion, failure and cancellation without prompt text', async () => {
  const key = Symbol.for('yunus-pi.activity.v1'), prior = globalThis[key], events = [];
  globalThis[key] = event => { events.push(event); return () => events.push({ action: 'finish', id: event.id }); };
  try {
    for (const launch of [async () => result('{"skills":[]}'), async () => { throw Error('unavailable'); }]) {
      const f = fixture({ launch }); await f.runner({ brief: 'PRIVATE_SYNTHETIC_BRIEF' }, f.ctx);
    }
    const f = fixture({ launch: () => new Promise(() => {}) }), controller = new AbortController();
    const pending = f.runner({ brief: 'PRIVATE_SYNTHETIC_BRIEF' }, f.ctx, controller.signal); controller.abort(); await pending;
    assert.equal(events.length, 6);
    for (let i = 0; i < events.length; i += 2) { assert.equal(events[i].label, 'skills'); assert.equal(events[i + 1].id, events[i].id); }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SYNTHETIC_BRIEF/);
  } finally { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; }
});

test('dedicated discovery bounds answers without starving configured reasoning or exceeding provider limits', () => {
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(source, 'agents/automatic-skill-discovery.md'), 'utf8'));
  assert.deepEqual(parseFrontmatterList(frontmatter.tools), []);
  for (const key of ['inheritProjectContext', 'inheritGlobalContext', 'inheritSkills']) assert.equal(frontmatter[key], 'false');
  assert.equal(frontmatter.systemPromptMode, 'replace'); assert.equal(frontmatter.subagentOnlyExtensions, undefined); assert.ok(body.length < 600);
  const runtime = fs.readFileSync(path.join(source, 'src/runs/shared/subagent-prompt-runtime.ts'), 'utf8');
  const start = runtime.indexOf('export function capAutomaticHelperRequest');
  const end = runtime.indexOf('\nconst SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV', start);
  const cap = vm.runInNewContext(stripTypeScriptTypes(runtime.slice(start, end)).replace('export function', 'function') + '\ncapAutomaticHelperRequest', {
    process, SUBAGENT_CHILD_AGENT_ENV: 'PI_SUBAGENT_CHILD_AGENT', AUTOMATIC_HELPER_LIMITS: { outputTokens: 4096, reasoningOutputTokens: 8192 },
    loadModelEconomyConfig: economy.loadModelEconomyConfig, isAutonomousMeteredEligible: economy.isAutonomousMeteredEligible,
    operationalEconomyQualification: economy.operationalEconomyQualification, toModelInfo,
    isProvenFreeRoute: free.isProvenFreeRoute, capFreeRequest: free.capFreeRequest,
  });
  for (const identity of ['automatic-free-assistant', 'automatic-skill-discovery']) {
    process.env.PI_SUBAGENT_CHILD_AGENT = identity;
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      assert.equal(cap({ model: model.id, [key]: 8192 }, model)[key], identity === 'automatic-skill-discovery' ? 1024 : 4096);
      assert.equal(cap({ model: model.id, [key]: 256 }, model)[key], 256);
    }
  }
  const reasoningModel = { ...model, reasoning: true, api: 'openai-responses', cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0 } };
  const request = { model: model.id, max_output_tokens: 8192, reasoning: { effort: 'high' } };
  const capped = cap(request, reasoningModel);
  assert.equal(capped.max_output_tokens, 8192, 'the caller ceiling still wins');
  assert.equal(cap({ ...request, max_output_tokens: 32000 }, { ...reasoningModel, maxTokens: 64000 }).max_output_tokens, 12288, 'enabled reasoning receives its own allowance beside the final JSON');
  assert.equal(capped.reasoning.effort, 'high', 'configured thinking remains authoritative');
  assert.equal(request.max_output_tokens, 8192, 'source request is not mutated');
  assert.equal(cap({ model: model.id }, reasoningModel).max_output_tokens, 4096, 'reasoning-capable route without enabled reasoning keeps the answer ceiling');
  assert.equal(cap({ model: model.id, reasoning: { effort: 'none' } }, reasoningModel).max_output_tokens, 4096);
  assert.equal(cap({ ...request, reasoning: { effort: 'high' } }, { ...model, reasoning: false }).max_output_tokens, 1024, 'non-reasoning discovery routes never widen');
  assert.equal(cap(request, { ...reasoningModel, maxTokens: 2048 }).max_output_tokens, 2048);
  assert.equal(cap({ ...request, max_output_tokens: 512 }, reasoningModel).max_output_tokens, 512, 'caller may impose a smaller ceiling');
  const anthropic = { model: model.id, max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 7000 } };
  const thinking = cap(anthropic, { ...reasoningModel, api: 'anthropic-messages' });
  assert.equal(thinking.max_tokens, 8192, 'enabled thinking keeps the caller ceiling inside the reasoning allowance');
  assert.equal(thinking.thinking.budget_tokens, 7000);
  assert.equal(cap({ ...anthropic, max_tokens: 4096 }, { ...reasoningModel, api: 'anthropic-messages' }).thinking.budget_tokens, 3072, 'explicit reasoning leaves 1024 answer tokens');
  assert.equal(anthropic.thinking.budget_tokens, 7000);
  assert.throws(() => cap({ ...anthropic, max_tokens: 1024 }, reasoningModel), /cannot fit enabled thinking/);
});

test('terminal discovery outcomes emit health telemetry; gate refusals stay silent', async () => {
  const key = Symbol.for('yunus-pi.health.v1');
  const prior = globalThis[key]; const seen = [];
  globalThis[key] = (kind, data) => seen.push({ kind, data });
  try {
    const f = fixture({ launch: async () => ({ isError: true, message: 'provider timeout after 900ms', details: { results: [{ exitCode: 1, error: 'child-error' }] } }) });
    assert.equal(await f.runner({ brief: 'Select a supplied skill from the observed evidence.' }, f.ctx), undefined);
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'failed'), 'failed child reports');
    assert.equal(seen.find(e => e.kind === 'skill.discovery' && e.data.decision === 'failed').data.error, 'provider timeout after 900ms', 'launch message preserved');
    const g = fixture();
    assert.equal(await g.runner({ brief: 'Select a supplied skill from the observed evidence.' }, g.ctx), '{"skills":[]}');
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'completed'), 'completed child reports');
    const refused = fixture({ denyBudget: true });
    assert.equal(await refused.runner({ brief: 'Select a supplied skill from the observed evidence.' }, refused.ctx), undefined);
    assert.equal(seen.filter(e => e.kind === 'skill.discovery').length, 2, 'budget refusal stays silent');
  } finally { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; }
});

test('instant failure retries once on a different member; genuine attempts and lone members do not retry', async () => {
  const key = Symbol.for('yunus-pi.health.v1');
  const prior = globalThis[key]; const seen = [];
  globalThis[key] = (kind, data) => seen.push({ kind, data });
  try {
    const modelB = { ...model, id: 'free/text-only' };
    let n = 0;
    const f = fixture({ models: [model, modelB], launch: async () => (++n === 1 ? { isError: true, message: 'provider hiccup' } : result('{"skills":["x"]}')) });
    assert.equal(await f.runner({ brief: 'Select a supplied skill from the observed evidence.' }, f.ctx), '{"skills":["x"]}');
    assert.equal(f.calls.length, 2);
    assert.notEqual(f.calls[0][1].model, f.calls[1][1].model, 'retry uses a different member');
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'retried' && e.data.error === 'provider hiccup'), 'superseded attempt journaled');
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'completed'), 'final outcome reported');
    const g = fixture({ models: [model, modelB], launch: async () => ({ details: { results: [{ exitCode: 1, output: 'partial {broken' }] } }) });
    assert.equal(await g.runner({ brief: 'Select a supplied skill from the observed evidence.' }, g.ctx), undefined);
    assert.equal(g.calls.length, 1, 'no retry after a genuine attempt');
    const h = fixture({ launch: async () => ({ isError: true }) });
    assert.equal(await h.runner({ brief: 'Select a supplied skill from the observed evidence.' }, h.ctx), undefined);
    assert.equal(h.calls.length, 1, 'no retry without a backup member');
  } finally { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; }
});

test('consecutive instant failures walk distinct routes up to the attempt bound', async () => {
  const key = Symbol.for('yunus-pi.health.v1');
  const prior = globalThis[key]; const seen = [];
  globalThis[key] = (kind, data) => seen.push({ kind, data });
  try {
    free.publishFreeEvidence([{ id: 'free/text-only', pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: false, contextWindow: 65536, maxTokens: 8192 } }, { id: 'free/discovery', pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: true, contextWindow: 65536, maxTokens: 8192 } }, { id: 'free/third', pricing: { prompt: '0', completion: '0' }, capabilities: { toolCalling: false, contextWindow: 65536, maxTokens: 8192 } }], free.FREE_CATALOG_URL);
    const modelB = { ...model, id: 'free/text-only' };
    const modelC = { ...model, id: 'free/third' };
    let n = 0;
    const f = fixture({ models: [model, modelB, modelC], launch: async () => (++n <= 2 ? { isError: true, message: `instant failure ${n}` } : result('{"skills":["x"]}')) });
    assert.equal(await f.runner({ brief: 'Select a supplied skill from the observed evidence.' }, f.ctx), '{"skills":["x"]}');
    assert.equal(f.calls.length, 3, 'two instant failures then success on the third route');
    assert.equal(new Set(f.calls.map(c => c[1].model)).size, 3, 'every attempt uses a distinct route');
    assert.equal(seen.filter(e => e.kind === 'skill.discovery' && e.data.decision === 'retried').length, 2);
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'completed'));
    let m = 0;
    const g = fixture({ models: [model, modelB, modelC], launch: async () => ({ isError: true, message: `dead ${++m}` }) });
    assert.equal(await g.runner({ brief: 'Select a supplied skill from the observed evidence.' }, g.ctx), undefined);
    assert.equal(g.calls.length, 3, 'bounded by the attempt limit when every route fails');
    assert.equal(seen.filter(e => e.kind === 'skill.discovery' && e.data.decision === 'failed').at(-1).data.error, 'dead 3', 'final failure names the last cause');
    let t = 0;
    const h = fixture({ models: [model, modelB], launch: async () => { if (++t === 1) throw new Error('route unresolvable at dispatch'); return result('{"skills":[]}'); } });
    assert.equal(await h.runner({ brief: 'Select a supplied skill from the observed evidence.' }, h.ctx), '{"skills":[]}');
    assert.equal(h.calls.length, 2, 'a launch throw retries instead of abandoning discovery');
    assert.ok(seen.some(e => e.kind === 'skill.discovery' && e.data.decision === 'retried' && e.data.error === 'route unresolvable at dispatch'));
  } finally { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; }
});

test('reasoning-only or billed attempts without visible text cannot trigger another provider', async () => {
  for (const evidence of [
    { stopReason: 'length' },
    { usage: { input: 10, output: 1024, turns: 1 } },
    { usage: { cacheRead: 20, output: 0 } },
    { usage: { reasoning: 1024, input: 0, output: 0 } },
    { messages: [{ role: 'assistant', stopReason: 'length', content: [] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Synthetic reasoning without a visible answer.' }] }] },
  ]) {
    const f = fixture({ models: [model, { ...model, id: 'free/text-only' }], launch: async () => ({
      isError: true, details: { results: [{ exitCode: 1, output: '', ...evidence }] },
    }) });
    assert.equal(await f.runner({ brief: 'Select a supplied skill.' }, f.ctx), undefined);
    assert.equal(f.calls.length, 1, JSON.stringify(evidence));
    assert.equal(f.entries.filter(entry => entry.type === 'subagent-lifecycle-v1' && entry.data.state === 'failed').length, 1);
  }
});

test('skill discovery preserves configured Friendli routes through dispatch admission', async () => {
  const prefs = await mod('runs/shared/llm-preferences.ts');
  const fallback = await mod('runs/shared/model-fallback.ts');
  const chosen = {...model, provider:'friendli',id:'vendor/preferred',baseUrl:'https://api.friendli.ai/serverless/v1'};
  const available = [toModelInfo(chosen)];
  fs.writeFileSync(process.env.PI_LLM_PREFERENCES_FILE,JSON.stringify({preferences:{subagents:[{provider:chosen.provider,model:chosen.id}]}}));
  prefs.clearLlmPreferencesCache();
  try {
    const f=fixture({models:[chosen],launch:async(_id,params)=>{
      assert.equal(params.modelOrigin,'configured');
      const route=fallback.resolveEffectiveSubagentModel(params.model,undefined,undefined,available,undefined,{source:params.modelOrigin==='explicit'?'explicit':'inherited',task:params.task});
      assert.deepEqual(fallback.buildModelCandidates(route,undefined,available,undefined,{origin:params.modelOrigin,task:params.task}),[params.model]);
      return result('{"skills":[]}');
    }});
    assert.equal(await f.runner({brief:'Select a useful installed skill from the supplied evidence.'},f.ctx),'{"skills":[]}');
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0][1].model,`friendli/${chosen.id}`);
  } finally { fs.rmSync(process.env.PI_LLM_PREFERENCES_FILE,{force:true});prefs.clearLlmPreferencesCache(); }
});

test('startup runtime failures retain identity and cause and do not retry providers', async () => {
  const {reduceChildEvents,projectTranscriptChildren}=await mod('runs/shared/child-ledger.ts');
  const f=fixture({models:[model,{...model,id:'free/text-only'}],launch:async()=>{throw new ReferenceError('fixtureBinding is not defined');}});
  await f.runner({brief:'Private synthetic task text must not enter accounting.'},f.ctx);
  assert.equal(f.calls.length,1,'provider changes cannot fix a harness ReferenceError');
  const entries=f.entries.map(e=>({type:'custom',customType:e.type,data:e.data}));
  const ledger=reduceChildEvents(projectTranscriptChildren(entries));
  assert.equal(ledger.tasks.length,1);
  const task=ledger.tasks[0];
  assert.equal(task.agent,'automatic-skill-discovery');
  assert.equal(task.label,'Installed skill discovery');
  assert.equal(task.scopeId,'supplied-skill-candidates');
  assert.equal(task.execution.cause.category,'internal');
  assert.equal(task.execution.cause.stage,'launch');
  assert.match(task.execution.cause.diagnosticRef,/ReferenceError:fixtureBinding$/);
  assert.equal(task.attempts[0].route,'openrouter/free/discovery');
  assert.equal(task.attempts[0].usage,undefined,'missing provider evidence is not invented zero');
  assert.doesNotMatch(JSON.stringify(entries),/Private synthetic task/);
});

test('provider retries remain separate attributable attempts under one logical scope', async () => {
  const {reduceChildEvents,projectTranscriptChildren}=await mod('runs/shared/child-ledger.ts');
  let calls=0;
  const f=fixture({models:[model,{...model,id:'free/text-only'}],launch:async()=>++calls===1?{isError:true}:result('{"skills":[]}')});
  await f.runner({brief:'Select a supplied skill.'},f.ctx);
  const ledger=reduceChildEvents(projectTranscriptChildren(f.entries.map(e=>({type:'custom',customType:e.type,data:e.data}))));
  assert.equal(ledger.tasks.length,1);
  assert.equal(ledger.tasks[0].attempts.length,2);
  assert.deepEqual(ledger.tasks[0].attempts.map(a=>a.state),['failed','completed']);
  assert.equal(new Set(ledger.tasks[0].attempts.map(a=>a.route)).size,2);
});

test('native helper launches coalesce with wrapper receipts while retry usage stays per attempt', async () => {
 const {reduceChildEvents,projectTranscriptChildren}=await mod('runs/shared/child-ledger.ts');
 const {collectSessionCost}=await import(pathToFileURL(path.join(agent,'extensions/lib/session-cost.ts')));
 const {collectSessionMetrics}=await import(pathToFileURL(path.join(agent,'extensions/lib/session-metrics.ts')));
 const {buildUsedSummary}=await import(pathToFileURL(path.join(agent,'extensions/session-signals.ts')));
 let calls=0;
 const f=fixture({models:[model,{...model,id:'free/text-only'}],launch:async()=>{
  const attempt=++calls, runId=`native-fixture-${attempt}`, status=attempt===1?'failed':'completed';
  f.entries.push({type:'subagent-lifecycle-v1',data:{runId,mode:'single',state:status,results:[{index:0,status}]}});
  const row={exitCode:attempt===1?1:0,...(attempt===1?{error:'provider unavailable'}:{output:'{"skills":[]}'}),usage:{input:attempt===1?0:20,output:attempt===1?0:2,cacheRead:0,cacheWrite:0,cost:attempt===1?0:.02,turns:attempt===1?0:1}};
  // Native accounting can also arrive independently of its wrapper.
  f.entries.push({type:'subagent-cost-v1',data:{runId,mode:'single',results:[row]}});
  return {isError:attempt===1,details:{runId,results:[row]}};
 }});
 await f.runner({brief:'Select a supplied skill.'},f.ctx);
 const entries=f.entries.map(e=>({type:'custom',customType:e.type,data:e.data}));
 const ledger=reduceChildEvents(projectTranscriptChildren(entries));
 assert.equal(ledger.tasks.length,1,'native and wrapper rows describe one logical task');
 assert.equal(ledger.tasks[0].attempts.length,2);
 assert.deepEqual(ledger.tasks[0].attempts.map(a=>a.runId),['native-fixture-1','native-fixture-2']);
 assert.deepEqual(ledger.tasks[0].attempts.map(a=>a.usage?.input),[undefined,20], 'a startup failure does not invent provider usage');
 const metrics=collectSessionMetrics(entries);assert.equal(metrics.childTokens,22,'startup retry and completed attempt count exactly once');
 const costs=collectSessionCost(entries);assert.equal(costs.total,.02);assert.equal(costs.pending,0);assert.equal(costs.unknown,true,'provider usage absent from the failed startup remains unknown');
 const report=buildUsedSummary(entries);
 assert.equal(report.agents.total,1);
 assert.equal(report.runs.length,2,'forensic rows also coalesce native and wrapper accounting');
 const rows=report.runs.filter(r=>r.runId.startsWith('skill-discovery-'));
 assert.deepEqual(rows.map(r=>r.tokens),[0,22]);assert.deepEqual(rows.map(r=>r.attempt),[1,2]);
});

test('host spawn failures do not change provider routes',async()=>{
 for(const code of ['EACCES','EPERM','ENOENT']){
  const error=Object.assign(new Error(`spawn /fixture/cli.js ${code}`),{code,syscall:'spawn /fixture/cli.js'});
  const f=fixture({models:[model,{...model,id:'free/text-only'}],launch:async()=>{throw error;}});
  await f.runner({brief:'Select a supplied skill.'},f.ctx);assert.equal(f.calls.length,1,code);
  const cost=f.entries.filter(e=>e.type==='subagent-cost-v1').at(-1).data.results[0];
  assert.equal(cost.cause.category,code==='ENOENT'?'dependency':'permission');assert.equal(cost.usage,undefined);
 }
 const f=fixture({models:[model,{...model,id:'free/text-only'}],launch:async()=>({isError:true,details:{results:[{exitCode:1,error:'spawn /fixture/cli.js EACCES'}]}})});
 await f.runner({brief:'Select a supplied skill.'},f.ctx);assert.equal(f.calls.length,1,'native error row follows the same policy');
});

after(() => { delete globalThis[SKILL_DISCOVERY_RUNNER]; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); });
