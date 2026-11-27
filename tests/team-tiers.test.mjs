// Model tiers of the team: `provider/latest-<tier>` selectors, the vendor policy, the nested
// legwork model, the ChatGPT-subscription fallback, fast mode and the subagent depth.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-tiers-'));
const agentDir = path.join(root, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_CHILD = '0';
delete process.env.PI_SUBAGENT_ROLE;
delete process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
delete process.env.PI_SUBAGENT_MAX_DEPTH;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.dirname);
const team = await jiti.import('../agent/extensions/lib/team.ts');
const policy = await jiti.import('../agent/extensions/lib/vendor-policy.ts');
const free = await jiti.import('../agent/extensions/lib/free-models.ts');
const sessionModel = await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/session-model.ts');
const piArgs = await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/pi-args.ts');
const types = await jiti.import('../agent/extensions/pi-subagents/src/shared/types.ts');
const agents = await jiti.import('../agent/extensions/pi-subagents/src/agents/agents.ts');

const ref = (route) => ({ provider: route.slice(0, route.indexOf('/')), id: route.slice(route.indexOf('/') + 1) });
const models = (...routes) => routes.map(ref);
const withEnv = (name, value, run) => {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return run(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
};

test('latest-<tier> picks the highest numeric version of that tier, never a pro or ultra id', () => {
  const list = models(
    'openai-codex/gpt-5.6-terra', 'openai-codex/gpt-6-terra', 'openai-codex/gpt-6.1-terra', 'openai-codex/gpt-6.1-terra-pro',
    'openai-codex/gpt-7-pro-terra', 'openai-codex/gpt-5.9-sol', 'openai-codex/gpt-5.10-sol', 'openai-codex/gpt-6-astra',
    'openai/gpt-9-terra', 'other/gpt-8-terra',
  );
  assert.equal(team.resolveModelSetting('openai-codex/latest-terra', list), 'openai-codex/gpt-6.1-terra');
  assert.equal(team.resolveModelSetting('openai-codex/latest-sol', list), 'openai-codex/gpt-5.10-sol', '5.10 is above 5.9');
  assert.equal(team.resolveModelSetting('openai-codex/latest-astra', list), 'openai-codex/gpt-6-astra');
  assert.equal(team.resolveModelSetting('openai/latest-terra', list), 'openai/gpt-9-terra', 'only the named provider is read');
  assert.equal(team.resolveModelSetting('openai-codex/latest-luna', list), undefined, 'a tier the provider does not list');
  assert.equal(team.resolveModelSetting('openai-codex/latest-pro', list), undefined, 'a pro id is never a tier pick');
  assert.equal(team.resolveModelSetting('nowhere/latest-terra', list), undefined);
  assert.equal(team.resolveModelSetting('openai-codex/latest-terra', []), undefined);
  assert.equal(team.resolveModelSetting('openai-codex/latest-terra', models('openai-codex/gpt-6-terra', 'openai-codex/gpt-6.0.1-terra')), 'openai-codex/gpt-6.0.1-terra');
});

test('an exact setting resolves to itself when listed, a retired id to the id the vendor lists now, anything else to nothing', () => {
  const list = models('deepseek/deepseek-flash', 'test/small');
  assert.equal(team.resolveModelSetting('test/small', list), 'test/small');
  assert.equal(team.resolveModelSetting('deepseek/deepseek-v4-flash', list), 'deepseek/deepseek-flash');
  assert.equal(team.resolveModelSetting('test/gone', list), undefined);
  assert.equal(team.resolveModelSetting('no-slash', list), undefined);
});

test('a role route reads a tier selector from the model list, refuses one it cannot read, and passes an exact setting through with no list', () => {
  const settings = { helper: 'openai-codex/latest-terra', legwork: 'inherit' };
  const session = { provider: 'test', id: 'main' };
  const list = models('openai-codex/gpt-5.6-terra', 'openai-codex/gpt-6-terra');
  assert.equal(team.resolveRoleRoute('helper', settings, session, list), 'openai-codex/gpt-6-terra');
  assert.equal(team.resolveRoleRoute('helper', settings, session, () => list), 'openai-codex/gpt-6-terra');
  assert.throws(() => team.resolveRoleRoute('helper', settings, session, models('openai-codex/gpt-6-sol')), { message: "team.helper is set to 'openai-codex/latest-terra', which is not among the available models. Pick another with /team." });
  assert.throws(() => team.resolveRoleRoute('helper', settings, session), /team\.helper is set to 'openai-codex\/latest-terra', a latest- selector/);
  assert.throws(() => team.resolveRoleRoute('helper', settings, session, []), /team\.helper is set to 'openai-codex\/latest-terra', a latest- selector/);
  assert.equal(team.resolveRoleRoute('helper', { helper: 'test/mid', legwork: 'inherit' }, session), 'test/mid');
  assert.equal(team.resolveRoleRoute('helper', { helper: 'test/mid', legwork: 'inherit' }, session, []), 'test/mid');
});

test('a role route to Claude, GPT or Gemini that is not a subscription is refused with the setting and the reason', () => {
  const session = { provider: 'test', id: 'main' };
  const list = models('openrouter/anthropic/claude-x', 'openrouter/qwen/qwen3.8-flash', 'openai-codex/gpt-6-terra');
  assert.throws(() => team.resolveRoleRoute('legwork', { helper: 'inherit', legwork: 'openrouter/anthropic/claude-x' }, session, list),
    /team\.legwork is set to 'openrouter\/anthropic\/claude-x', which reaches Claude through openrouter, which is not a subscription login.*Pick another with \/team\./);
  assert.throws(() => team.resolveRoleRoute('legwork', { helper: 'inherit', legwork: 'openrouter/anthropic/claude-x' }, session), /team\.legwork .* reaches Claude/, 'refused with no model list too');
  assert.equal(team.resolveRoleRoute('legwork', { helper: 'inherit', legwork: 'openrouter/qwen/qwen3.8-flash' }, session, list), 'openrouter/qwen/qwen3.8-flash');
  assert.equal(team.resolveRoleRoute('helper', { helper: 'openai-codex/gpt-6-terra', legwork: 'inherit' }, session, list), 'openai-codex/gpt-6-terra');
  assert.equal(team.resolveRoleRoute('helper', { helper: 'inherit', legwork: 'inherit' }, { provider: 'anthropic', id: 'claude-x' }), 'anthropic/claude-x', 'the session model is the owner\'s own choice');
});

test('a side call resolves the legwork setting through the tier selector and never runs on a paid Claude, GPT or Gemini route', () => {
  const session = ref('test/main');
  const flash = ref('deepseek/deepseek-flash');
  const claude = ref('openrouter/anthropic/claude-x');
  const registry = { getAvailable: () => [session, flash, claude, ref('openai-codex/gpt-6-luna')] };
  const config = (legwork) => team.mergeTeamPatches({ team: { legwork }, run: {} });
  assert.equal(team.sideCallModel({ model: session, modelRegistry: registry }, config('deepseek/latest-flash')), flash, 'flash is a tier of deepseek-flash');
  assert.equal(team.sideCallModel({ model: session, modelRegistry: registry }, config('deepseek/latest-pro')), session, 'a tier the provider does not list falls back to the session model');
  assert.deepEqual(team.sideCallModel({ model: session, modelRegistry: registry }, config('openai-codex/latest-luna')), ref('openai-codex/gpt-6-luna'));
  assert.equal(team.sideCallModel({ model: session, modelRegistry: registry }, config('deepseek/deepseek-v4-flash')), flash, 'a retired id runs on the id listed now');
  assert.equal(team.sideCallModel({ model: session, modelRegistry: registry }, config('openrouter/anthropic/claude-x')), session);
});

test('the new team keys merge key by key and default to off, inherit and 3 points', () => {
  const merged = team.mergeTeamPatches(
    { team: { consultant: 'openai-codex/latest-astra', sublegwork: 'openrouter/qwen/qwen3.8-flash', subscriptionPoints: 5 }, run: {} },
    { team: { subscriptionPoints: 0 }, run: {} },
  );
  assert.equal(merged.team.consultant, 'openai-codex/latest-astra');
  assert.equal(merged.team.sublegwork, 'openrouter/qwen/qwen3.8-flash');
  assert.equal(merged.team.subscriptionPoints, 0, '0 is a value: never fall back');
  assert.deepEqual([team.DEFAULT_TEAM_CONFIG.team.consultant, team.DEFAULT_TEAM_CONFIG.team.sublegwork, team.DEFAULT_TEAM_CONFIG.team.subscriptionPoints], ['off', 'inherit', 3]);
  const parsed = team.parseTeamPatch({ team: { consultant: 'a/b', sublegwork: 'inherit', subscriptionPoints: 2.5 } }, 'settings.json');
  assert.deepEqual(parsed.team, { consultant: 'a/b', sublegwork: 'inherit', subscriptionPoints: 2.5 });
});

const NESTED_TEAM = { ...team.DEFAULT_TEAM_CONFIG.team, helper: 'openai-codex/latest-terra', legwork: 'deepseek/deepseek-flash', sublegwork: 'openrouter/qwen/qwen3.8-flash', free: 'off', subscriptionPoints: 3 };
const SESSION = { provider: 'openai-codex', id: 'gpt-6-sol' };
const AVAILABLE = ['openai-codex/gpt-6-sol', 'openai-codex/gpt-6-terra', 'deepseek/deepseek-flash', 'openrouter/qwen/qwen3.8-flash'].map((route) => ({ ...ref(route), fullId: route }));
const childRoute = (extra = {}) => sessionModel.resolveChildRoute({ agent: { name: 'delegate', tools: ['read'] }, forked: false, parentModel: SESSION, availableModels: AVAILABLE, cwd: root, team: NESTED_TEAM, ...extra });

test('a legwork child launched by a legwork child runs on team.sublegwork; any other launch keeps its role model', () => {
  assert.equal(childRoute().model, 'deepseek/deepseek-flash', 'launched by the main session');
  assert.equal(withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute().model), 'openrouter/qwen/qwen3.8-flash');
  assert.equal(withEnv('PI_SUBAGENT_ROLE', 'helper', () => childRoute().model), 'deepseek/deepseek-flash', 'a helper launching legwork gives the normal legwork model');
  assert.equal(withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ agent: { name: 'worker' } }).model), 'openai-codex/gpt-6-terra', 'a helper child of a legwork child is not nested legwork');
  assert.equal(withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ team: { ...NESTED_TEAM, sublegwork: 'inherit' } }).model), 'deepseek/deepseek-flash', 'inherit keeps the legwork model');
  assert.equal(withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ forked: true }).model), 'openai-codex/gpt-6-sol', 'a fork stays on the session model');
  assert.throws(() => withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ team: { ...NESTED_TEAM, sublegwork: 'openrouter/qwen/gone' } })), /team\.sublegwork is set to 'openrouter\/qwen\/gone', which is not among the available models/);
  assert.throws(() => withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ team: { ...NESTED_TEAM, sublegwork: 'openrouter/anthropic/claude-x' }, availableModels: [...AVAILABLE, { ...ref('openrouter/anthropic/claude-x'), fullId: 'openrouter/anthropic/claude-x' }] })), /team\.sublegwork .* reaches Claude/);
});

test('the best free OpenRouter model leads a legwork child but never a nested legwork child', () => {
  const route = (id) => `openrouter/${id}`;
  free.mutateState((state) => {
    state.catalog = { at: Date.now(), models: [{ id: 'a/one:free', context: 131072 }] };
    state.quota = { used: 100, limit: 1000, remaining: 900, at: Date.now() };
    state.models = { [route('a/one:free')]: { probe: { at: Date.now(), passed: 5, items: 5, gate: true }, runs: 0, successes: 0, speeds: [80], cooldownUntil: 0, consecutiveFailures: 0, probingUntil: 0 } };
    state.leases = [];
  });
  const on = { ...NESTED_TEAM, free: 'on' };
  const plain = childRoute({ team: on });
  assert.equal(plain.model, route('a/one:free'), 'the free model leads a first-level legwork child');
  const nested = withEnv('PI_SUBAGENT_ROLE', 'legwork', () => childRoute({ team: on }));
  assert.equal(nested.model, 'openrouter/qwen/qwen3.8-flash');
  assert.equal(nested.routes, undefined, 'no free routes lead or follow it');
});

test('a helper on the ChatGPT subscription falls back to the legwork model once the root session is over its points', () => {
  const seen = [];
  const over = (answer) => (sessionId, points) => { seen.push([sessionId, points]); return answer; };
  assert.equal(childRoute({ agent: { name: 'worker' }, sessionId: 's1', overBudget: over(false) }).model, 'openai-codex/gpt-6-terra');
  assert.equal(childRoute({ agent: { name: 'worker' }, sessionId: 's1', overBudget: over(true) }).model, 'deepseek/deepseek-flash');
  assert.deepEqual(seen, [['s1', 3], ['s1', 3]]);
  assert.equal(withEnv('PI_SUBAGENT_ORCHESTRATOR_SESSION_ID', 'root', () => childRoute({ agent: { name: 'worker' }, sessionId: 's1', overBudget: over(true) }).model), 'deepseek/deepseek-flash');
  assert.deepEqual(seen.at(-1), ['root', 3], 'the orchestrator session of a nested launch is the one that counts');
  assert.equal(childRoute({ agent: { name: 'worker' }, overBudget: over(true), team: { ...NESTED_TEAM, subscriptionPoints: 0 } }).model, 'openai-codex/gpt-6-terra', '0 never falls back');
  assert.equal(childRoute({ agent: { name: 'worker' }, overBudget: over(true), team: { ...NESTED_TEAM, helper: 'deepseek/deepseek-flash' } }).model, 'deepseek/deepseek-flash', 'only openai-codex helper routes are checked');
  assert.equal(childRoute({ agent: { name: 'worker' }, overBudget: over(true), team: { ...NESTED_TEAM, legwork: 'inherit' } }).model, 'openai-codex/gpt-6-sol', 'inherit falls back to the session model');
  assert.equal(childRoute({ agent: { name: 'delegate' }, overBudget: () => assert.fail('legwork is never checked'), team: { ...NESTED_TEAM, legwork: 'openai-codex/gpt-6-terra' } }).model, 'openai-codex/gpt-6-terra');
  assert.equal(childRoute({ agent: { name: 'worker' }, forked: true, overBudget: () => assert.fail('a fork stays on the session model') }).model, 'openai-codex/gpt-6-sol');
});

test('forbiddenPaidRoute refuses Claude, GPT and Gemini outside a subscription and nothing else', () => {
  const forbidden = [
    'openrouter/anthropic/claude-sonnet-4.5', 'openrouter/anthropic/claude-x:thinking', 'openrouter/openai/gpt-5', 'openrouter/openai/o3-mini', 'openrouter/openai/chatgpt-4o-latest',
    'openrouter/google/gemini-2.5-pro', 'openrouter/openrouter/auto', 'orcarouter/anthropic/claude-x', 'opencode-go/gpt-5', 'vercel-ai-gateway/google/gemini-3',
    'azure-openai-responses/gpt-5', 'github-copilot/claude-x', 'huggingface/anthropic/claude-x',
    'anthropic/claude-x', 'openai/gpt-6', 'google/gemini-3', 'google-vertex/gemini-3', 'openai/o4',
    // OpenRouter's "latest" aliases and router aliases.
    'openrouter/~openai/gpt-latest', 'openrouter/~anthropic/claude-sonnet-latest', 'openrouter/~google/gemini-pro-latest', 'openrouter/~openai/o3',
    'openrouter/openrouter/free', 'openrouter/openrouter/auto', 'openrouter/~openrouter/auto', 'openrouter/openrouter/bodybuilder', 'openrouter/~openai/gpt-mini-latest', 'openrouter/~google/gemini-flash-latest',
    // Providers outside every list carry the same models.
    'amazon-bedrock/anthropic.claude-3-5-sonnet', 'amazon-bedrock/us.anthropic.claude-sonnet-4', 'vertex-anthropic/claude-x', 'groq/openai/gpt-5', 'together/google/gemini-3',
    'azure/gpt-5', 'azure/o3', 'fireworks/models/gemini-3', 'deepinfra/anthropic/claude-x', 'nvidia/openai/o4-mini', 'custom/chatgpt-4o', 'custom/gpt-5.6',
    'amazon-bedrock/anthropic.claude-sonnet-4-5-v1:0', 'bedrock/eu.anthropic.claude-3', 'vertex/claude-x', 'mistral/claude-x',
  ];
  for (const route of forbidden) assert.match(policy.forbiddenPaidRoute(route) ?? '', /\S/, `${route} must be refused`);
  const allowed = [
    'openrouter/qwen/qwen3.8-flash', 'openrouter/openai/gpt-oss-120b', 'openrouter/google/gemma-3-27b-it:free', 'openrouter/deepseek/deepseek-v4-flash',
    'openrouter/meta-llama/llama-4', 'openrouter/z-ai/glm-5', 'amazon-bedrock/openai.gpt-oss-120b', 'amazon-bedrock/meta.llama4', 'groq/openai/gpt-oss-20b', 'together/google/gemma-3-27b-it', 'ollama/gemma3:27b', 'custom/o-large', 'custom/oss-o3-like', 'openai-codex/gpt-6.1-sol', 'openai-codex/gpt-6-terra', 'google-gemini-cli/gemini-3-pro', 'google-antigravity/gemini-3-pro',
    'deepseek/deepseek-flash', 'google/gemma-3', 'no-provider',
  ];
  for (const route of allowed) assert.equal(policy.forbiddenPaidRoute(route), undefined, `${route} must be allowed`);
  for (const route of ['openrouter/openrouter/free', 'openrouter/openrouter/bodybuilder', 'openrouter/~openrouter/auto']) assert.match(policy.forbiddenPaidRoute(route), /whichever model openrouter picks/, route);
  assert.match(policy.forbiddenPaidRoute('openrouter/~openai/gpt-latest'), /^reaches GPT through openrouter/, 'a tilde alias names its vendor');
  assert.match(policy.forbiddenPaidRoute('amazon-bedrock/anthropic.claude-3', { subscription: true }), /Claude/, 'an unknown provider is never a subscription');
  assert.equal(policy.forbiddenPaidRoute('anthropic/claude-x', { subscription: true }), undefined);
  assert.equal(policy.forbiddenPaidRoute('github-copilot/claude-x', { subscription: true }), undefined);
  assert.match(policy.forbiddenPaidRoute('openrouter/anthropic/claude-x', { subscription: true }) ?? '', /Claude/, 'an aggregator is never a subscription');
  assert.match(policy.forbiddenPaidRoute('openrouter/anthropic/claude-x'), /^reaches Claude through openrouter/);
  for (const set of [policy.SUBSCRIPTION_PROVIDERS, policy.SUBSCRIPTION_AGGREGATOR_PROVIDERS, policy.FIRST_PARTY_PROVIDERS]) assert.ok(set instanceof Set && set.size > 0);
});

test('fast mode is the openai-codex luna and sol models of any version', () => {
  for (const route of ['openai-codex/gpt-5.6-luna', 'openai-codex/gpt-5.6-sol', 'openai-codex/gpt-7.2-sol', 'openai-codex/gpt-6-luna']) assert.equal(piArgs.supportsFastMode(route), true, route);
  for (const route of ['openai-codex/gpt-6-terra', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-6-sol-pro', 'openai/gpt-6-sol', 'openrouter/openai-codex/gpt-6-sol', 'gpt-6-sol', 'openai-codex/sol-x']) assert.equal(piArgs.supportsFastMode(route), false, route);
  const launch = (model) => piArgs.buildPiArgs({ baseArgs: [], task: 'Fixture', model, fast: true, sessionEnabled: false });
  const cleanups = [];
  try {
    const sol = launch('openai-codex/gpt-7.2-sol:high');
    cleanups.push(sol.tempDir);
    assert.ok(sol.args.some((arg) => arg.endsWith('fast-mode-extension.ts')));
    assert.throws(() => launch('openai-codex/gpt-6-terra'), /fast mode supports only openai-codex models ending in -luna or -sol; unsupported model: openai-codex\/gpt-6-terra\./);
  } finally {
    for (const dir of cleanups) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each child gets its role in PI_SUBAGENT_ROLE, and a child with none does not inherit its parent\'s', () => {
  const launch = (role) => piArgs.buildPiArgs({ baseArgs: [], task: 'Fixture', model: 'test/x', sessionEnabled: false, ...(role ? { role } : {}) });
  const legwork = launch('legwork');
  const helper = launch('helper');
  const none = launch();
  try {
    assert.equal(legwork.env.PI_SUBAGENT_ROLE, 'legwork');
    assert.equal(helper.env.PI_SUBAGENT_ROLE, 'helper');
    assert.ok('PI_SUBAGENT_ROLE' in none.env && none.env.PI_SUBAGENT_ROLE === undefined, 'an explicit undefined clears the variable the spawn would inherit');
  } finally {
    for (const launched of [legwork, helper, none]) if (launched.tempDir) fs.rmSync(launched.tempDir, { recursive: true, force: true });
  }
});

test('subagents nest to depth 3: main, helper, legwork, sublegwork; a child at the limit cannot launch', () => {
  assert.equal(types.DEFAULT_SUBAGENT_MAX_DEPTH, 3);
  const blockedAt = (depth) => withEnv('PI_SUBAGENT_DEPTH', String(depth), () => types.checkSubagentDepth().blocked);
  assert.deepEqual([0, 1, 2, 3].map(blockedAt), [false, false, false, true]);
  assert.equal(withEnv('PI_SUBAGENT_DEPTH', '2', () => types.checkSubagentDepth(1).blocked), true, 'a configured limit still wins over the default');
});

test('the built-in worker (helper) and delegate (legwork) may launch children; the other built-ins may not', () => {
  const found = agents.discoverAgents(root, 'user').agents;
  const nested = Object.fromEntries(found.filter((agent) => agent.source === 'builtin').map((agent) => [agent.name, agent.allowNestedSubagents === true]));
  assert.deepEqual(nested, { delegate: true, worker: true, scout: false, researcher: false, reviewer: false, oracle: false });
});
