import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-child-catalog-'));
process.env.PI_CODING_AGENT_DIR = root;
const shared = path.join(repo, 'agent/extensions/pi-subagents/src/runs/shared');
const { buildPiArgs, cleanupTempDir } = await import(pathToFileURL(path.join(shared, 'pi-args.ts')));
const runtime = await import(pathToFileURL(path.join(shared, 'subagent-prompt-runtime.ts')));
const { registerCachedChildModelProvider } = await import(pathToFileURL(path.join(repo, 'agent/extensions/live-models.ts')));
const route = 'orcarouter/fixture/advisor';
const model = { id: 'fixture/advisor', name: 'Synthetic advisor', api: 'openai-completions',
  baseUrl: 'https://provider.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 65536, maxTokens: 8192, cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0 } };
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { orcarouter: {
  baseUrl: model.baseUrl, api: model.api, compat: { supportsDeveloperRole: false },
} } }));
fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ orcarouter: { type: 'api_key', key: 'synthetic-key' } }));
fs.writeFileSync(path.join(root, 'live-model-catalog.json'), JSON.stringify({ version: 1, providers: {
  orcarouter: { ts: 1, rawCompat: true, models: [model, { ...model, id: 'fixture/other' }] },
  friendli: { ts: 1, rawCompat: true, models: [model] },
} }));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function launch() {
  return buildPiArgs({ baseArgs: [], task: 'Choose from the supplied synthetic identifiers.',
    model: route, modelRouteCandidate: { route }, sessionEnabled: false, tools: [],
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
    capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: true, sources: ['fixture-advisor'] },
  });
}

test('isolated provider restoration reads only the selected cached route without network or capability registration', async () => {
  const originalFetch = globalThis.fetch;
  const providers = new Map();
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('Synthetic network must not be used'); };
  try {
    // The API deliberately exposes no tool, command or event-hook registration.
    const pi = { registerProvider: (id, config) => providers.set(id, config) };
    assert.equal(registerCachedChildModelProvider(pi, route), true);
    assert.deepEqual([...providers.keys()], ['orcarouter']);
    const provider = providers.get('orcarouter');
    assert.equal(provider.baseUrl, model.baseUrl);
    const rows = await provider.refreshModels({ allowNetwork: true, force: true, signal: new AbortController().signal });
    assert.deepEqual(rows.map(row => row.id), [model.id]);
    assert.equal(rows[0].compat.supportsDeveloperRole, false, 'current configured wire compatibility survives');
    assert.equal(fetched, 0, 'even explicit force/network options cannot refresh in an isolated child');
    assert.equal(registerCachedChildModelProvider(pi, 'unknown/fixture'), false);
    assert.equal(registerCachedChildModelProvider(pi, 'orcarouter/fixture/missing'), true);
    assert.deepEqual(await providers.get('orcarouter').refreshModels({ allowNetwork: true, signal: new AbortController().signal }), [], 'no near-match model substitution');
  } finally { globalThis.fetch = originalFetch; }
});

test('managed launches enable cached provider restoration only when ambient extensions are disabled', async () => {
  const isolated = launch();
  const ordinary = buildPiArgs({ baseArgs: [], task: 'Fixture', model: route, modelRouteCandidate: { route }, sessionEnabled: false });
  const explicit = buildPiArgs({ baseArgs: [], task: 'Fixture', extensions: [], model: route, modelRouteCandidate: { route }, sessionEnabled: false });
  try {
    assert.ok(isolated.args.includes('--no-tools'));
    assert.ok(isolated.args.includes('--no-extensions'));
    assert.equal(isolated.args[isolated.args.indexOf('--provider') + 1], 'orcarouter');
    assert.equal(isolated.env.PI_SUBAGENT_CACHED_MODEL_PROVIDER, '1');
    assert.equal(explicit.env.PI_SUBAGENT_CACHED_MODEL_PROVIDER, '1');
    assert.equal(ordinary.env.PI_SUBAGENT_CACHED_MODEL_PROVIDER, undefined);
    assert.throws(() => buildPiArgs({ baseArgs: [], task: 'Fixture', model: 'friendli/fixture/advisor', modelRouteCandidate: { route }, sessionEnabled: false }), /does not match its selected route/);
    const publicLaunch = buildPiArgs({ baseArgs: [], task: 'Fixture', model: 'fixture/advisor', sessionEnabled: false });
    try { assert.ok(!publicLaunch.args.includes('--provider'), 'public loose model selectors retain their existing behavior'); }
    finally { cleanupTempDir(publicLaunch.tempDir); }
    const previous = { child: process.env.PI_SUBAGENT_CHILD, flag: process.env.PI_SUBAGENT_CACHED_MODEL_PROVIDER, route: process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE };
    let registered = 0;
    try {
      const pi = { registerProvider: () => { registered++; } };
      process.env.PI_SUBAGENT_CACHED_MODEL_PROVIDER = '1';
      process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE = isolated.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE;
      delete process.env.PI_SUBAGENT_CHILD;
      await runtime.registerSubagentCachedModelProvider(pi);
      assert.equal(registered, 0, 'parent registries remain untouched');
      process.env.PI_SUBAGENT_CHILD = '1';
      await runtime.registerSubagentCachedModelProvider(pi);
      assert.equal(registered, 1);
      delete process.env.PI_SUBAGENT_MODEL_ROUTE_CANDIDATE;
      await assert.rejects(runtime.registerSubagentCachedModelProvider(pi), /missing its selected model route/);
    } finally {
      for (const [key, value] of [['PI_SUBAGENT_CHILD', previous.child], ['PI_SUBAGENT_CACHED_MODEL_PROVIDER', previous.flag], ['PI_SUBAGENT_MODEL_ROUTE_CANDIDATE', previous.route]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally { for (const item of [isolated, ordinary, explicit]) cleanupTempDir(item.tempDir); }
});

test('real CLI resolves a cached dynamic advisor with the no-tools and no-extensions ceiling intact', { timeout: 30000 }, () => {
  const request = launch();
  const guard = path.join(root, 'network-guard.mjs'), calls = path.join(root, 'network-calls');
  fs.writeFileSync(guard, `import fs from 'node:fs';globalThis.fetch=async()=>{fs.appendFileSync(${JSON.stringify(calls)},'fetch\\n');throw new Error('Fixture network forbidden');};`);
  try {
    const env = { ...process.env, ...request.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: root };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const args = ['--import', guard, path.join(repo, 'core/coding-agent/dist/cli.js'), ...request.args.slice(0, -1), '--mode', 'rpc'];
    const input = '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n';
    const broken = spawnSync(process.execPath, args, { cwd: root, env: { ...env, PI_SUBAGENT_CACHED_MODEL_PROVIDER: '' }, input, encoding: 'utf8', timeout: 12000 });
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /Unknown provider "orcarouter"|Model "orcarouter\/fixture\/advisor" not found/, 'minimal reproduction: removing provider registration loses a parent-selected route');
    const fixed = spawnSync(process.execPath, args, { cwd: root, env, input, encoding: 'utf8', timeout: 12000 });
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    const responses = fixed.stdout.trim().split('\n').map(line => JSON.parse(line));
    const state = responses.find(row => row.id === 'state');
    assert.equal(state?.success, true, fixed.stdout);
    assert.equal(state.data.model.provider, 'orcarouter');
    assert.equal(state.data.model.id, model.id);
    assert.equal(state.data.model.baseUrl, model.baseUrl);
    assert.equal(state.data.messageCount, 0, 'startup performs no model inference');
    assert.ok(!responses.find(row => row.id === 'commands')?.data.commands.some(command => command.name === 'catalog-status'));
    assert.doesNotMatch(fixed.stdout + fixed.stderr, /Failed to load extension|not found|fixture\/other/);
    assert.equal(fs.existsSync(calls), false, 'native startup and listing make no provider request');
    // A different provider advertises the exact qualified route as its vendor
    // ID. Missing selected data must not turn that collision into substitution.
    const config = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
    config.providers.collision = { api: model.api, baseUrl: model.baseUrl, models: [{ ...model, id: route }] };
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(root, 'live-model-catalog.json'), JSON.stringify({ version: 1, providers: {} }));
    const missing = spawnSync(process.execPath, args, { cwd: root, env, input, encoding: 'utf8', timeout: 12000 });
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.doesNotMatch(missing.stdout, /"id":"state"/, 'an unavailable pinned route cannot start on another provider');
    config.providers.orcarouter.models = [{ ...model, id: 'fixture/advisor-v2' }];
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(config));
    const near = spawnSync(process.execPath, ['--import', guard, path.join(repo, 'core/coding-agent/dist/cli.js'), ...request.args, '--mode', 'json', '--print'],
      { cwd: root, env: { ...env, PI_SUBAGENT_CACHED_MODEL_PROVIDER: '' }, input: '', encoding: 'utf8', timeout: 12000 });
    assert.match(near.stdout + near.stderr, /Blocked: child model does not match its selected route/,
      'a same-provider fuzzy match is denied by the native request gate');
    assert.equal(fs.existsSync(calls), false, 'the rejected substitute never reaches the provider transport');
  } finally { cleanupTempDir(request.tempDir); }
});
