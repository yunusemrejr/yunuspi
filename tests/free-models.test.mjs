import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-free-models-'));
const agentDir = path.join(root, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_CHILD = '0';
after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.dirname);
const free = await jiti.import('../agent/extensions/lib/free-models.ts');
const team = await jiti.import('../agent/extensions/lib/team.ts');
const health = await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/provider-health.ts');
const sessionModel = await jiti.import('../agent/extensions/pi-subagents/src/runs/shared/session-model.ts');
const extension = await jiti.import('../agent/extensions/free-models.ts');

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const route = (id) => `openrouter/${id}`;

beforeEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });
});

/** A model row as /api/v1/models returns it. */
const row = (id, over = {}) => ({
  id,
  context_length: 131072,
  architecture: { output_modalities: ['text'] },
  supported_parameters: ['tools', 'temperature'],
  expiration_date: null,
  ...over,
});

/** A measured model: probe of five, its children's runs and its speed samples. */
const measured = ({ passed = 5, gate = true, runs = 0, successes = 0, speeds = [40], cooldownUntil = 0 } = {}) => ({
  probe: { at: NOW, passed, items: 5, gate },
  runs, successes, speeds, cooldownUntil, consecutiveFailures: 0, probingUntil: 0,
});

function seed({ models = {}, remaining = 900, leases = [], now = NOW } = {}) {
  free.mutateState((state) => {
    state.catalog = { at: now, models: Object.keys(models).map((id) => ({ id: id.replace(/^openrouter\//, ''), context: 131072 })) };
    state.quota = { used: 1000 - remaining, limit: 1000, remaining, at: now };
    state.models = models;
    state.leases = leases;
  });
}

test('the pool keeps free text models with tools and a long context, and drops aliases, retiring models and the rest', () => {
  const rows = [
    row('good/model-a:free'),
    row('good/model-b:free', { expiration_date: '2027-06-01' }),
    row('openrouter/free'),
    row('openrouter/router:free'),
    row('vendor/claude-like:free'),
    row('vendor/no-tools:free', { supported_parameters: ['temperature'] }),
    row('vendor/short:free', { context_length: 32000 }),
    row('vendor/image-out:free', { architecture: { output_modalities: ['image'] } }),
    row('vendor/retired:free', { expiration_date: '2026-10-01' }),
    row('vendor/paid-model'),
  ];
  assert.deepEqual(free.poolFromCatalog(rows, NOW).map((m) => m.id), ['good/model-a:free', 'good/model-b:free']);
  assert.deepEqual(free.poolFromCatalog(undefined, NOW), []);
});

test('an empty pool is read again after two minutes, a filled one after an hour', () => {
  const at = (models) => ({ catalog: { at: NOW, models } });
  assert.equal(free.catalogStale(at([]), NOW + free.QUOTA_TTL_MS - 1), false);
  assert.equal(free.catalogStale(at([]), NOW + free.QUOTA_TTL_MS), true, 'models may not have been registered yet');
  const filled = at([{ id: 'a/one:free', context: 131072 }]);
  assert.equal(free.catalogStale(filled, NOW + free.QUOTA_TTL_MS), false);
  assert.equal(free.catalogStale(filled, NOW + free.CATALOG_TTL_MS), true);
});

test('IQ is the share of probe checks and child runs that went well; speed is the median', () => {
  const stats = measured({ passed: 4, runs: 5, successes: 3, speeds: [10, 90, 30, 50] });
  assert.equal(free.iqOf(stats), (100 * (4 + 3)) / (5 + 5));
  assert.equal(free.iqOf({ ...stats, probe: undefined }), undefined, 'unmeasured has no IQ');
  assert.equal(free.speedOf(stats), 40, 'median of an even count is the mean of the middle two');
  assert.equal(free.speedOf({ speeds: [] }), 0);
});

test('free models are usable only with a quota read today and a reserve of 30 per running free child', () => {
  const lease = (n) => Array.from({ length: n }, () => ({ route: route('a/one:free'), pid: process.pid, until: NOW + 60_000 }));
  seed({ remaining: 100, leases: lease(2) });
  assert.equal(free.quotaUsable(free.readState(), NOW), true, '100 - 60 = 40 is enough');
  seed({ remaining: 99, leases: lease(2) });
  assert.equal(free.quotaUsable(free.readState(), NOW), false, '99 - 60 = 39 is not');
  seed({ remaining: 39 });
  assert.equal(free.quotaUsable(free.readState(), NOW), false);
  seed({ remaining: 900 });
  assert.equal(free.quotaUsable(free.readState(), NOW), true);
  assert.equal(free.quotaUsable(free.readState(), NOW + 24 * 60 * 60_000), false, 'yesterday\'s counter says nothing about today');
  fs.rmSync(path.join(agentDir, 'free-models.json'));
  assert.equal(free.quotaUsable(free.readState(), NOW), false, 'no snapshot, no free models');
});

test('no more than two free children run at once, and a finished child frees its place', () => {
  const id = 'a/one:free';
  seed({ models: { [route(id)]: measured() }, now: Date.now() });
  const first = free.beginFreeRun([route(id), 'openai/gpt-x']);
  const second = free.beginFreeRun([route(id), 'openai/gpt-x']);
  assert.ok(first && second);
  assert.deepEqual(free.pickFreeRoutes({ writes: false }), [], 'two leases: the cap is reached');
  assert.equal(free.beginFreeRun(['openai/gpt-x', route(id)]), undefined, 'a child that starts on a paid model takes no lease');
  first.finish({ model: route(id), ok: true });
  assert.equal(free.pickFreeRoutes({ writes: false })[0].route, route(id));
  second.finish({ model: route(id), ok: true });
  assert.equal(free.readState().leases.length, 0);
  assert.equal(free.readState().models[route(id)].runs, 2);
  assert.equal(free.readState().models[route(id)].successes, 2);
});

test('a failing free model rests 10, 20, 40 minutes up to 2 hours, and one success clears it', () => {
  const id = route('a/one:free');
  const rest = () => free.readState().models[id].cooldownUntil - NOW;
  const minutes = (n) => n * 60_000;
  free.noteFreeFailure(id, NOW);
  assert.equal(rest(), minutes(10));
  free.noteFreeFailure(id, NOW);
  assert.equal(rest(), minutes(20));
  free.noteFreeFailure(id, NOW);
  assert.equal(rest(), minutes(40));
  for (let i = 0; i < 6; i++) free.noteFreeFailure(id, NOW);
  assert.equal(rest(), minutes(120), 'capped at two hours');
  assert.equal(free.isCoolingDown(id, NOW + 1), true);
  assert.equal(free.isCoolingDown('openai/gpt-x', NOW + 1), false, 'only free routes rest');
  free.beginFreeRun([id, 'openai/gpt-x']).finish({ model: id, ok: true });
  assert.equal(free.readState().models[id].cooldownUntil, 0);
  assert.equal(free.readState().models[id].consecutiveFailures, 0);
  free.noteFreeFailure(id, NOW);
  assert.equal(rest(), minutes(10), 'the count starts again after a success');
});

test('a child that ends on a rate limit rests its model; an ordinary task failure only counts as a run', () => {
  const id = route('a/one:free');
  free.beginFreeRun([id, 'openai/gpt-x']).finish({ model: id, ok: false, error: '429 Too Many Requests' });
  assert.ok(free.readState().models[id].cooldownUntil > Date.now());
  assert.equal(free.readState().models[id].runs, 0, 'a limit says nothing about the model\'s skill');
  fs.rmSync(path.join(agentDir, 'free-models.json'));
  free.beginFreeRun([id, 'openai/gpt-x']).finish({ model: id, ok: false, error: 'The task asked for a file that does not exist.' });
  assert.equal(free.readState().models[id].cooldownUntil, 0);
  assert.equal(free.readState().models[id].runs, 1);
  assert.equal(free.readState().models[id].successes, 0);
});

test('the pick orders by 60% IQ and 40% speed, keeps three, and applies the IQ floors', () => {
  const models = {
    [route('fast/low:free')]: measured({ passed: 3, speeds: [100] }), // IQ 60, the fastest
    [route('slow/high:free')]: measured({ passed: 5, speeds: [20] }), // IQ 100
    [route('mid/mid:free')]: measured({ passed: 4, speeds: [60] }), // IQ 80
    [route('also/mid:free')]: measured({ passed: 4, speeds: [50] }), // IQ 80
    [route('weak/weak:free')]: measured({ passed: 2, speeds: [100] }), // IQ 40, below both floors
    [route('gated/out:free')]: measured({ passed: 5, gate: false, speeds: [500] }),
    [route('resting/now:free')]: measured({ passed: 5, speeds: [500], cooldownUntil: NOW + 60_000 }),
  };
  seed({ models });
  const writes = free.pickFreeRoutes({ writes: true, now: NOW });
  assert.deepEqual(writes.map((p) => p.route), [route('mid/mid:free'), route('also/mid:free'), route('slow/high:free')]);
  // speed is relative to the fastest usable model, which runs at 100
  assert.ok(Math.abs(writes[0].score - (0.6 * 0.8 + 0.4 * 0.6)) < 1e-9);
  const reads = free.pickFreeRoutes({ writes: false, now: NOW });
  assert.equal(reads.length, 3, 'never more than three');
  assert.equal(reads[0].route, route('fast/low:free'), 'IQ 60 clears the read-only floor of 50, and its speed wins');
  assert.ok(!writes.map((p) => p.route).includes(route('fast/low:free')), 'IQ 60 misses the floor of 70 for agents that write');
  for (const pick of [...writes, ...reads]) {
    assert.ok(!/weak|gated|resting/.test(pick.route));
  }
  assert.equal(free.pickFreeRoutes({ writes: true, now: NOW + 61_000 })[0].route, route('resting/now:free'), 'a model that finished resting is back');
});

test('with no state, no quota or a low quota nothing is picked', () => {
  assert.deepEqual(free.pickFreeRoutes({ writes: false }), []);
  seed({ models: { [route('a/one:free')]: measured() }, remaining: 10 });
  assert.deepEqual(free.pickFreeRoutes({ writes: false, now: NOW }), []);
  fs.writeFileSync(path.join(agentDir, 'free-models.json'), '{ not json');
  assert.deepEqual(free.pickFreeRoutes({ writes: false }), [], 'a damaged file reads as no data');
});

test('the state file is private to the user', () => {
  seed({ models: { [route('a/one:free')]: measured() } });
  assert.equal(fs.statSync(path.join(agentDir, 'free-models.json')).mode & 0o777, 0o600);
});

test('team.free is on by default, accepts on and off, merges per key and refuses anything else', () => {
  assert.equal(team.DEFAULT_TEAM_CONFIG.team.free, 'on');
  const file = '/tmp/settings.json';
  assert.equal(team.parseTeamPatch({ team: { free: 'off' } }, file).team.free, 'off');
  assert.equal(team.mergeTeamPatches(team.parseTeamPatch({ team: { free: 'off' } }, file), team.parseTeamPatch({ team: {} }, file)).team.free, 'off');
  assert.equal(team.mergeTeamPatches(team.parseTeamPatch({ team: { free: 'off' } }, file), team.parseTeamPatch({ team: { free: 'on' } }, file)).team.free, 'on');
  assert.throws(() => team.parseTeamPatch({ team: { free: 'sometimes' } }, file), /invalid 'team\.free'; expected "on" or "off"/);
  assert.throws(() => team.parseTeamPatch({ team: { free: true } }, file), /team\.free/);
});

test('a 429 on a free OpenRouter model rests that model, never the provider', () => {
  const limited = '429 Provider returned error: rate limit exceeded';
  const freeFailure = health.recordFailure({ provider: 'openrouter', model: 'a/one:free', errorMessage: limited, now: NOW });
  assert.equal(freeFailure.scope, 'route');
  const entry = health.readHealth().providers.openrouter;
  assert.equal(entry.cooldownUntil ?? 0, 0, 'the provider is not cooling');
  assert.ok(entry.models['a/one:free'].cooldownUntil > NOW);
  const paidFailure = health.recordFailure({ provider: 'openrouter', model: 'a/paid', errorMessage: limited, now: NOW });
  assert.equal(paidFailure.scope, 'provider', 'a model that is not free keeps the provider-wide cooldown');
});

test('a switch to one of the child\'s recovery routes is not a model mismatch', () => {
  const available = [
    { provider: 'openrouter', id: 'a/one:free', fullId: 'openrouter/a/one:free' },
    { provider: 'openrouter', id: 'b/two:free', fullId: 'openrouter/b/two:free' },
    { provider: 'openai', id: 'gpt-x', fullId: 'openai/gpt-x' },
  ];
  const routes = ['openrouter/a/one:free', 'openrouter/b/two:free', 'openai/gpt-x'];
  const verify = sessionModel.formatSubagentModelVerificationError;
  assert.match(verify(routes[0], routes[1], available), /model_verification_failed/);
  assert.equal(verify(routes[0], routes[1], available, routes), undefined);
  assert.equal(verify(`${routes[0]}:high`, 'openai/gpt-x', available, routes), undefined);
  assert.match(verify(routes[0], 'openai/other', available, routes), /model_verification_failed/);
});

test('the recovery routes of a child exist only when a free model leads and there is somewhere to go', () => {
  const paid = 'openai/gpt-x';
  assert.equal(free.recoveryRoutesEnv(['openrouter/a/one:free:high', 'openrouter/b/two:free:high', paid]), JSON.stringify(['openrouter/a/one:free', 'openrouter/b/two:free', paid]));
  assert.equal(free.recoveryRoutesEnv(['openrouter/a/one:free']), '[]');
  assert.equal(free.recoveryRoutesEnv([paid, 'openrouter/a/one:free']), '[]');
  assert.equal(free.recoveryRoutesEnv(['openrouter/free', paid]), '[]', 'the router alias is never a free route');
  assert.equal(free.recoveryRoutesEnv(undefined), '[]');
});

test('a legwork child launches on the best free model with the role\'s model last; other roles and team.free off are unchanged', () => {
  seed({
    models: { [route('a/one:free')]: measured({ speeds: [80] }), [route('b/two:free')]: measured({ passed: 3, speeds: [30] }) },
    now: Date.now(),
  });
  const parentModel = { provider: 'openai', id: 'gpt-x' };
  const base = { agent: { name: 'scout', tools: ['read', 'grep'] }, forked: false, parentModel, cwd: root };
  const on = { ...team.DEFAULT_TEAM_CONFIG.team };
  const reader = sessionModel.resolveChildRoute({ ...base, team: on });
  assert.equal(reader.model, route('a/one:free'));
  assert.deepEqual(reader.routes, [route('a/one:free'), route('b/two:free'), 'openai/gpt-x'], 'IQ 60 clears the read-only floor');
  assert.equal(reader.shownRole, 'legwork', 'the line about the child names the role because it runs elsewhere');
  const writer = sessionModel.resolveChildRoute({ ...base, agent: { name: 'delegate', tools: ['read', 'edit'] }, team: on });
  assert.deepEqual(writer.routes, [route('a/one:free'), 'openai/gpt-x'], 'IQ 60 misses the floor of 70 for a child that edits');
  const helper = sessionModel.resolveChildRoute({ ...base, agent: { name: 'worker', tools: ['edit'] }, team: on });
  assert.deepEqual(helper, { model: 'openai/gpt-x', maxThinking: 'xhigh' });
  const off = sessionModel.resolveChildRoute({ ...base, team: { ...on, free: 'off' } });
  assert.deepEqual(off, { model: 'openai/gpt-x', maxThinking: 'high' });
  const forked = sessionModel.resolveChildRoute({ ...base, forked: true, team: on });
  assert.deepEqual(forked, { model: 'openai/gpt-x' });
});

test('the line for /team says what is missing, then what is available', () => {
  assert.equal(free.freeSummary('off', NOW), 'off');
  assert.equal(free.freeSummary('on', NOW), 'on · quota not read yet · no model measured yet');
  seed({ models: { [route('a/one:free')]: measured({ passed: 4, speeds: [54.4] }) }, remaining: 973 });
  assert.equal(free.freeSummary('on', NOW), 'on · 973 of 1000 left today · 1 usable · next: a/one:free (IQ 80, 54 tok/s)');
});

// ---------------------------------------------------------------------------
// OpenRouter: quota, catalog, probe (a scripted fetch, no network)
// ---------------------------------------------------------------------------

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('the quota is read from the account\'s own counter and a failure is refused loudly', async () => {
  const seen = [];
  await free.refreshQuota({
    key: 'sk-test', now: NOW,
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.authorization]);
      return json({ data: { free_model_daily_requests: { used: 27, limit: 1000, remaining: 973 } } });
    },
  });
  assert.deepEqual(seen, [['https://openrouter.ai/api/v1/key', 'Bearer sk-test']]);
  assert.deepEqual(free.readState().quota, { used: 27, limit: 1000, remaining: 973, at: NOW });
  await assert.rejects(free.refreshQuota({ key: 'k', fetchImpl: async () => json({ data: {} }) }), /free_model_daily_requests/);
  await assert.rejects(free.refreshQuota({ key: 'k', fetchImpl: async () => json({}, 500) }), /answered 500/);
  assert.equal(fs.readFileSync(path.join(agentDir, 'free-models.json'), 'utf8').includes('sk-test'), false, 'the key is never stored');
});

test('the catalog keeps the pool models that the session also has', async () => {
  await free.refreshCatalog({
    registered: new Set(['good/a:free']), now: NOW,
    fetchImpl: async () => json({ data: [row('good/a:free'), row('good/b:free'), row('openrouter/free')] }),
  });
  assert.deepEqual(free.readState().catalog, { at: NOW, models: [{ id: 'good/a:free', context: 131072 }] });
});

/** A model that answers the five probe items correctly, wrongly at `failAt`, or with an HTTP `status`. */
function scriptedModel({ failAt, status } = {}) {
  const needle = free.needleLog().timestamp;
  return async (_url, init) => {
    if (status) return json({}, status);
    const body = JSON.parse(init.body);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 3000);
    const text = body.messages.map((m) => m.content ?? '').join('\n');
    const index = body.tools ? (body.messages.length === 1 ? 0 : 1) : text.includes('alpha') ? 2 : text.includes('a.sort') ? 3 : 4;
    let message;
    if (index === failAt) message = { content: 'I am not sure.' };
    else if (index === 0) message = { content: null, tool_calls: [{ function: { name: 'read_file', arguments: JSON.stringify({ path: 'config/service-7.yaml' }) } }] };
    else if (index === 1) message = { content: '3' };
    else if (index === 2) message = { content: '```json\n{"name":"alpha","port":8080,"tags":["a","b"]}\n```' };
    else if (index === 3) message = { content: '1,10,100,9\n333' };
    else message = { content: `The line is at ${needle}.` };
    return json({ choices: [{ message }], usage: { completion_tokens: 60 } });
  };
}

test('the probe scores five checks and measures speed', async () => {
  const outcome = await free.probeModel({ id: 'a/one:free', key: 'k', fetchImpl: scriptedModel() });
  assert.equal(outcome.passed, 5);
  assert.equal(outcome.items, 5);
  assert.equal(outcome.gate, true);
  assert.equal(outcome.requests, 5);
  assert.equal(outcome.speeds.length, 5);
});

test('failing a gate check stops the probe and bars the model; failing a later check only lowers its score', async () => {
  const gated = await free.probeModel({ id: 'a/one:free', key: 'k', fetchImpl: scriptedModel({ failAt: 1 }) });
  assert.equal(gated.gate, false);
  assert.equal(gated.passed, 1);
  assert.equal(gated.requests, 2, 'no more requests are spent on a model that cannot be used');
  const lower = await free.probeModel({ id: 'a/one:free', key: 'k', fetchImpl: scriptedModel({ failAt: 4 }) });
  assert.equal(lower.gate, true);
  assert.equal(lower.passed, 4);
});

test('a rate limit during the probe rests the model and is not a failed check', async () => {
  const id = 'a/one:free';
  seed({ models: {}, remaining: 900, now: Date.now() });
  free.mutateState((state) => { state.catalog = { at: Date.now(), models: [{ id, context: 131072 }] }; });
  const probed = await free.runProbes({ key: 'k', fetchImpl: scriptedModel({ status: 429 }) });
  assert.deepEqual(probed, []);
  const stats = free.readState().models[route(id)];
  assert.equal(stats.probe, undefined, 'no score was recorded');
  assert.ok(stats.cooldownUntil > Date.now());
  assert.equal(stats.probingUntil, 0);
});

test('probes run for unmeasured models only, at most as many as asked, within the day\'s allowance', async () => {
  const now = Date.now();
  const ids = ['a/one:free', 'b/two:free', 'c/three:free'];
  seed({ models: {}, remaining: 900, now });
  free.mutateState((state) => { state.catalog = { at: now, models: ids.map((id) => ({ id, context: 131072 })) }; });
  assert.deepEqual(await free.runProbes({ key: 'k', fetchImpl: scriptedModel(), max: 2 }), [route(ids[0]), route(ids[1])]);
  const state = free.readState();
  assert.equal(state.models[route(ids[0])].probe.passed, 5);
  assert.equal(state.probes.count, 10);
  assert.deepEqual(await free.runProbes({ key: 'k', fetchImpl: scriptedModel() }), [route(ids[2])], 'measured models are not probed again');
  free.mutateState((s) => { s.probes.count = 58; delete s.models[route(ids[2])].probe; });
  assert.deepEqual(await free.runProbes({ key: 'k', fetchImpl: scriptedModel() }), [], '60 requests a day, and a probe needs 5');
});

test('a low account quota stops the probes before they spend it', async () => {
  const now = Date.now();
  seed({ models: {}, remaining: 44, now });
  free.mutateState((state) => { state.catalog = { at: now, models: [{ id: 'a/one:free', context: 131072 }] }; });
  assert.deepEqual(await free.runProbes({ key: 'k', fetchImpl: scriptedModel() }), []);
});

// ---------------------------------------------------------------------------
// The child's recovery handler
// ---------------------------------------------------------------------------

function recoveryHandler(routes, { available } = {}) {
  process.env.PI_SUBAGENT_CHILD = '1';
  process.env.PI_SUBAGENT_RECOVERY_ROUTES = JSON.stringify(routes);
  const handlers = new Map();
  const switched = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    setModel: async (model) => {
      if (available && !available.includes(`${model.provider}/${model.id}`)) return false;
      switched.push(`${model.provider}/${model.id}`);
      return true;
    },
  };
  extension.default(pi);
  process.env.PI_SUBAGENT_CHILD = '0';
  const ctx = { modelRegistry: { find: (provider, id) => ({ provider, id }) } };
  const recover = async (message) => {
    const event = { type: 'pi_provider_recovery', message, decision: undefined };
    await handlers.get('pi_provider_recovery')(event, ctx);
    return event.decision;
  };
  return { recover, switched, handlers };
}

const failed = (model, errorMessage, provider = 'openrouter') => ({ provider, model, errorMessage, stopReason: 'error', content: [] });
const ROUTES = ['openrouter/a/one:free', 'openrouter/b/two:free', 'openrouter/c/three:free', 'openai/gpt-x'];

test('a free model\'s rate limit moves the child to the next route that is not resting, and rests the failed one', async () => {
  const { recover, switched } = recoveryHandler(ROUTES);
  free.noteFreeFailure(ROUTES[1]);
  assert.equal(await recover(failed('a/one:free', '429 Rate limit exceeded: free-models-per-day')), 'retry');
  assert.deepEqual(switched, [ROUTES[2]], 'b rests, so the child goes to c');
  assert.ok(free.isCoolingDown(ROUTES[0]), 'a is resting now');
  assert.equal(await recover(failed('c/three:free', 'Provider returned error: upstream unavailable (503)')), 'retry');
  assert.deepEqual(switched, [ROUTES[2], 'openai/gpt-x'], 'the role\'s own model comes last');
});

test('an empty answer is handled; an ordinary failure, a paid route and a route outside the list are left alone', async () => {
  const { recover, switched } = recoveryHandler(ROUTES);
  assert.equal(await recover(failed('a/one:free', 'Provider returned an empty response')), 'retry');
  assert.equal(await recover(failed('b/two:free', 'Invalid request: messages must alternate roles')), undefined);
  assert.equal(await recover(failed('gpt-x', '429 Too Many Requests', 'openai')), undefined, 'the paid route is the last stop');
  assert.equal(await recover(failed('z/other:free', '429 Too Many Requests')), undefined, 'not one of this child\'s routes');
  assert.equal(await recover({ provider: 'openrouter', errorMessage: '429' }), undefined);
  assert.deepEqual(switched, [ROUTES[1]]);
  assert.equal(free.isCoolingDown(ROUTES[1]), false, 'a failure that is not the endpoint\'s rests nothing');
});

test('when a route cannot be set the next one is tried, and with none left the failure is left to the normal retry', async () => {
  const { recover, switched } = recoveryHandler(ROUTES, { available: ['openai/gpt-x'] });
  assert.equal(await recover(failed('a/one:free', '429 Too Many Requests')), 'retry');
  assert.deepEqual(switched, ['openai/gpt-x']);
  const none = recoveryHandler(ROUTES, { available: [] });
  assert.equal(await none.recover(failed('a/one:free', '429 Too Many Requests')), undefined);
});

test('the extension registers the recovery handler only in a child, and acts only on routes it was given', async () => {
  const events = [];
  process.env.PI_SUBAGENT_CHILD = '0';
  extension.default({ on: (event) => events.push(event) });
  assert.deepEqual(events, ['session_start', 'turn_start']);
  const { recover } = recoveryHandler([]);
  assert.equal(await recover(failed('a/one:free', '429 Too Many Requests')), undefined);
});
