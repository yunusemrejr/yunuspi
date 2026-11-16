import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssistantMessageEventStream } from '@yunuspi/ai';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { DefaultResourceLoader } from '../core/coding-agent/src/core/resource-loader.js';
import { createAgentSession } from '../core/coding-agent/src/core/sdk.js';
import { SessionManager } from '../core/coding-agent/src/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/src/core/settings-manager.js';

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
  await before({ payload: { model: 'shared-id' }, model: second }, context(first, available));
  assert.equal(health.readHealth().providers[second.provider].requests.length, 1,
    'the actual request route is admitted even with a cooling duplicate model id');
  await assert.rejects(
    () => before({ payload: { model: 'shared-id' }, model: first }, context(second, available)),
    (error) => error?.code === 'PI_AUTONOMOUS_REQUEST_DENIED',
    'the actual cooling route stays blocked regardless of the session model',
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

test('a provider request timeout cancels its pending admission in the real SDK', { timeout: 10_000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-gate-timeout-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  process.env.PI_PROVIDER_STATE_FILE = path.join(cwd, 'health.json');
  process.env.PI_PROVIDER_GATE_MAX_WAIT_MS = '5000';
  const originalIdleOverride = process.env.PI_STREAM_IDLE_MS;
  delete process.env.PI_STREAM_IDLE_MS;
  t.after(() => {
    if (originalIdleOverride !== undefined) process.env.PI_STREAM_IDLE_MS = originalIdleOverride;
  });
  const selected = {
    ...model('gated-fixture', 'fixture'),
    name: 'Fixture',
    api: 'openai-completions',
    input: ['text'],
    reasoning: false,
    contextWindow: 65_536,
    maxTokens: 4096,
  };
  let dispatched = false;
  let gateSignal;
  let gateFinished;
  const gateSettled = new Promise(resolve => { gateFinished = resolve; });
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const stream = (actual, _context, options) => {
    const result = new AssistantMessageEventStream();
    const message = {
      role: 'assistant', api: actual.api, provider: actual.provider, model: actual.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    };
    void (async () => {
      try {
        await options.onPayload({ model: actual.id }, actual);
        options.signal.throwIfAborted();
        dispatched = true;
        result.push({
          type: 'done', reason: 'stop',
          message: { ...message, stopReason: 'stop', content: [{ type: 'text', text: 'Fixture answer.' }] },
        });
      } catch (error) {
        result.push({
          type: 'error', reason: 'error',
          error: { ...message, content: [], stopReason: 'error', errorMessage: error.message },
        });
      } finally {
        gateFinished();
      }
    })();
    return result;
  };
  runtime.registerNativeProvider({
    id: selected.provider, name: selected.name, getModels: () => [selected],
    auth: { apiKey: { name: 'Fixture', resolve: async () => ({ source: 'fixture', auth: { apiKey: 'synthetic-fixture' } }) } },
    stream, streamSimple: stream,
  });
  await runtime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.inMemory({
    httpIdleTimeoutMs: 120, retry: { enabled: false }, compaction: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on('before_provider_request', event => { gateSignal = event.signal; });
      registerGate(pi);
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model: selected,
    sessionManager: SessionManager.inMemory(cwd), noTools: 'all',
  });
  t.after(() => session.dispose());
  health.recordFailure({ provider: selected.provider, model: selected.id, errorMessage: '429 too many requests; Retry-After: 2' });
  await session.prompt('Make a synthetic provider request.');
  assert.ok(gateSignal?.aborted, 'the provider deadline reaches the hook signal');
  await gateSettled;
  assert.equal(dispatched, false);
  assert.match(session.messages.at(-1).errorMessage, /idle timeout after 120ms/);
  const state = health.readHealth();
  assert.equal(state.providers[selected.provider].requests.length, 0);
  assert.equal(state.providers[selected.provider].models[selected.id]?.failure, undefined,
    'a request cancelled in admission supplies no upstream failure evidence');
  assert.equal(state.pending.length, 0);
});
