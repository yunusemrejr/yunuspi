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
const keys = ['PI_CODING_AGENT_DIR', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_AUTONOMOUS_FREE_ASSIST', 'PI_SUBAGENT_CHILD', 'PI_SUBAGENT_CHILD_AGENT', 'PI_OFFLINE'];
const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
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
    launch: async (...args) => { calls.push(args); return options.launch ? options.launch(...args) : result('{"skills":[]}'); },
  });
  return { calls, entries, ctx, runner: globalThis[SKILL_DISCOVERY_RUNNER], stale: () => { current = false; } };
}

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

test('dedicated agent omits inherited context and native request caps discovery output to 1024', () => {
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(source, 'agents/automatic-skill-discovery.md'), 'utf8'));
  assert.deepEqual(parseFrontmatterList(frontmatter.tools), []);
  for (const key of ['inheritProjectContext', 'inheritGlobalContext', 'inheritSkills']) assert.equal(frontmatter[key], 'false');
  assert.equal(frontmatter.systemPromptMode, 'replace'); assert.equal(frontmatter.subagentOnlyExtensions, undefined); assert.ok(body.length < 600);
  const runtime = fs.readFileSync(path.join(source, 'src/runs/shared/subagent-prompt-runtime.ts'), 'utf8');
  const start = runtime.indexOf('export function capAutomaticHelperRequest');
  const end = runtime.indexOf('\nconst SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV', start);
  const cap = vm.runInNewContext(stripTypeScriptTypes(runtime.slice(start, end)).replace('export function', 'function') + '\ncapAutomaticHelperRequest', {
    process, SUBAGENT_CHILD_AGENT_ENV: 'PI_SUBAGENT_CHILD_AGENT', AUTOMATIC_HELPER_LIMITS: { outputTokens: 4096 },
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
});

after(() => { delete globalThis[SKILL_DISCOVERY_RUNNER]; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); });
