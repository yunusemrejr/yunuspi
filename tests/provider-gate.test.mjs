import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = [path.join(root, 'agent'), path.resolve(root, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'extensions/provider-gate.ts')),
);
assert.ok(agentRoot, 'provider gate ships with the distribution');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-gate-contract-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_PROVIDER_STATE_FILE = path.join(dir, 'health.json');
process.env.PI_PROVIDER_GATE_MAX_WAIT_MS = '0';
delete process.env.PI_PROVIDER_GATE;

const health = await import(pathToFileURL(path.join(agentRoot, 'extensions/pi-subagents/src/runs/shared/provider-health.ts')));
const { default: registerGate } = await import(pathToFileURL(path.join(agentRoot, 'extensions/provider-gate.ts')));

const handlers = new Map();
const pi = {
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerCommand() {},
};
registerGate(pi);
const before = handlers.get('before_provider_request')[0];
const messageEnd = handlers.get('message_end')[0];
const model = (provider, id) => ({
  provider,
  id,
  baseUrl: `https://${provider}.invalid/v1`,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
});
const context = (current, available, session = 'session.jsonl') => ({
  model: current,
  modelRegistry: { getAvailable: () => available },
  sessionManager: { getSessionFile: () => path.join(dir, session) },
  ui: { setStatus() {} },
});

try {
  const first = model('first-provider', 'shared-id');
  const second = model('second-provider', 'shared-id');
  const available = [first, second];
  health.recordFailure({ provider: first.provider, model: first.id, errorMessage: '429 too many requests' });
  await assert.rejects(
    () => before({ payload: { model: 'shared-id' } }, context(model('primary', 'primary-id'), available)),
    (error) => error?.code === 'PI_AUTONOMOUS_REQUEST_DENIED',
  );

  fs.rmSync(process.env.PI_PROVIDER_STATE_FILE, { force: true });
  assert.equal(
    await before({ payload: { modelID: 'shared-id' } }, context(model('primary', 'primary-id'), available)),
    undefined,
    'ambiguous model ids remain usable while every candidate is healthy',
  );

  health.recordFailure({ provider: first.provider, model: first.id, errorMessage: '429 too many requests' });
  await assert.rejects(
    () => before({ payload: { model: 'shared-id' } }, context(second, available)),
    (error) => error?.code === 'PI_AUTONOMOUS_REQUEST_DENIED',
    'an active model context cannot hide a cooling duplicate provider',
  );

  fs.rmSync(process.env.PI_PROVIDER_STATE_FILE, { force: true });
  const routeA = model('overlap-provider', 'route-a');
  const routeB = model('overlap-provider', 'route-b');
  await Promise.all([
    before({ payload: { model: 'route-a' } }, context(routeA, [routeA])),
    before({ payload: { model: 'route-b' } }, context(routeB, [routeB])),
  ]);
  for (const route of [routeA, routeB]) {
    await messageEnd({
      message: {
        role: 'assistant',
        provider: route.provider,
        model: route.id,
        stopReason: 'stop',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: Date.now(),
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    }, context(route, [route]));
  }
  const state = health.readHealth();
  assert.equal(
    ['route-a', 'route-b'].every((id) => Number.isFinite(state.providers['overlap-provider']?.models[id]?.recoveryHistory?.at(-1)?.elapsedMs)),
    true,
    'overlapping routes keep independent completion timing',
  );

  const crossOpenRouter = {
    ...model('openrouter', 'cross-key'),
    baseUrl: 'https://openrouter.ai/api/v1',
    compat: { openRouterRouting: { only: ['tag-b'], allow_fallbacks: false }, recoveryEndpointName: 'Host B' },
  };
  const crossDirect = model('direct', 'cross-key');
  await before({ payload: { model: crossOpenRouter.id } }, context(crossOpenRouter, [crossOpenRouter]));
  await before(
    { payload: { model: crossOpenRouter.id, provider: crossOpenRouter.compat.openRouterRouting } },
    context(crossOpenRouter, [crossOpenRouter, crossDirect]),
  );
  for (let i = 0; i < 2; i++) {
    await messageEnd({
      message: {
        role: 'assistant', provider: 'openrouter', model: 'cross-key', stopReason: 'stop',
        content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(),
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    }, context(crossOpenRouter, [crossOpenRouter]));
  }
  const crossState = health.readHealth();
  const crossHistory = crossState.providers.openrouter?.models['cross-key']?.recoveryHistory ?? [];
  assert.equal(
    crossHistory.length >= 2 && crossHistory.slice(-2).every((sample) => !Object.hasOwn(sample, 'elapsedMs')),
    true,
    'neutral and concrete overlapping candidates suppress completion timing',
  );

  const sessionRoute = model('session-provider', 'session-route');
  await before({ payload: { model: sessionRoute.id } }, context(sessionRoute, [sessionRoute], 'session-a.jsonl'));
  const completion = {
    message: {
      role: 'assistant', provider: sessionRoute.provider, model: sessionRoute.id,
      stopReason: 'stop', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(),
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    },
  };
  await messageEnd(completion, context(sessionRoute, [sessionRoute], 'session-b.jsonl'));
  const mismatched = health.readHealth();
  assert.equal(
    Object.hasOwn(mismatched.providers['session-provider']?.models['session-route']?.recoveryHistory?.at(-1) ?? {}, 'elapsedMs'),
    false,
    'known mismatched sessions cannot consume timing attribution',
  );
  await messageEnd(completion, context(sessionRoute, [sessionRoute], 'session-a.jsonl'));
  const matched = health.readHealth();
  assert.equal(
    Number.isFinite(matched.providers['session-provider']?.models['session-route']?.recoveryHistory?.at(-1)?.elapsedMs),
    true,
    'matching session completion keeps timing attribution',
  );

  for (let i = 0; i < 129; i++) {
    const bound = model('bound-provider', `bound-${i}`);
    await before({ payload: { model: bound.id } }, context(bound, [bound], 'bound.jsonl'));
  }
  const oldest = model('bound-provider', 'bound-0');
  await messageEnd({
    message: {
      role: 'assistant', provider: oldest.provider, model: oldest.id, stopReason: 'stop',
      content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(),
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    },
  }, context(oldest, [oldest], 'bound.jsonl'));
  const bounded = health.readHealth();
  assert.equal(
    Object.hasOwn(bounded.providers['bound-provider']?.models['bound-0']?.recoveryHistory?.at(-1) ?? {}, 'elapsedMs'),
    false,
    'orphaned pending attempts are bounded',
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
