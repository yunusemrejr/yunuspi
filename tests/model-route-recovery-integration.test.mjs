import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');

test('the session model launches in a native child with its exact catalog spelling', { timeout: 40000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-route-recovery-'));
  const envNames = ['PI_CODING_AGENT_DIR', 'PI_PROVIDER_STATE_FILE'];
  const previousEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
  const base = { name: 'Synthetic catalog fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
    contextWindow: 65536, maxTokens: 8192, reasoning: true, input: ['text'],
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 } };
  const models = [
    { ...base, provider: 'friendli', id: 'zai-org/GLM-5.3-Flash' },
    { ...base, provider: 'orcarouter', id: 'qwen/qwen3.8-flash' },
  ];
  const providers = Object.fromEntries(models.map(model => [model.provider, { baseUrl: base.baseUrl, api: base.api }]));
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers }));
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(Object.fromEntries(models.map(model =>
    [model.provider, { type: 'api_key', key: 'synthetic-fixture-key' }]))));
  fs.writeFileSync(path.join(root, 'live-model-catalog.json'), JSON.stringify({ version: 1, providers: Object.fromEntries(models.map(model =>
    [model.provider, { ts: Date.now(), rawCompat: true, models: [model] }])) }));
  const guard = path.join(root, 'no-network.mjs'), calls = path.join(root, 'network-calls');
  fs.writeFileSync(guard, `import fs from 'node:fs'; globalThis.fetch=async()=>{fs.appendFileSync(${JSON.stringify(calls)},'fetch\\n');throw Error('Fixture forbids network');};`);
  try {
    const { sessionChildModel } = await import('../agent/extensions/pi-subagents/src/runs/shared/session-model.ts');
    const { buildPiArgs, cleanupTempDir } = await import('../agent/extensions/pi-subagents/src/runs/shared/pi-args.ts');
    for (const model of models) {
      const candidate = { route: sessionChildModel({ provider: model.provider, id: model.id }) };
      const launch = buildPiArgs({ baseArgs: [], task: 'Synthetic startup check.', model: candidate.route,
        modelRouteCandidate: candidate, sessionEnabled: false, tools: [],
        inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
        capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: true, sources: ['startup-regression'] } });
      try {
        const env = { ...process.env, ...launch.env, PI_OFFLINE: '1' };
        for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
        const child = spawnSync(process.execPath, ['--import', guard, path.join(repo, 'core/coding-agent/dist/cli.js'),
          ...launch.args.slice(0, -1), '--mode', 'rpc'], { cwd: root, env,
          input: '{"type":"get_state","id":"state"}\n', encoding: 'utf8', timeout: 45000 });
        assert.equal(child.status, 0, child.stdout + child.stderr);
        const state = child.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 'state');
        assert.equal(state?.success, true, child.stdout);
        assert.equal(state.data.model.provider, model.provider);
        assert.equal(state.data.model.id, model.id, 'dispatch uses the exact catalog spelling');
        assert.equal(state.data.model.baseUrl, base.baseUrl);
        assert.equal(state.data.messageCount, 0, 'registry verification spends no inference tokens');
      } finally { cleanupTempDir(launch.tempDir); }
    }
    assert.equal(fs.existsSync(calls), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
