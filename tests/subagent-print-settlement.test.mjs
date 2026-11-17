import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const model = { provider: 'openrouter', id: 'org/print-settlement-fixture', fullId: 'openrouter/org/print-settlement-fixture',
  name: 'Offline fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', contextWindow: 64000,
  maxTokens: 1024, input: ['text'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const answer = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, stopReason: 'stop',
  content: [{ type: 'text', text: 'Synthetic answer' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, source: 'provider-reported' } } };

function ownedPrintScript({ hookMs, shutdownMs, linger }) {
  const core = new URL('../core/coding-agent/src/', import.meta.url).href;
  return `import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession } from '${core}core/sdk.js';
import { AgentSessionRuntime } from '${core}core/agent-session-runtime.js';
import { DefaultResourceLoader } from '${core}core/resource-loader.js';
import { SessionManager } from '${core}core/session-manager.js';
import { SettingsManager } from '${core}core/settings-manager.js';
import { runPrintMode } from '${core}modes/print-mode.js';
const cwd = process.cwd();
const append = line => fs.appendFileSync('lifecycle', line + '\\n');
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
  noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [api => {
    api.on('agent_end', async (_event, ctx) => {
      append('hook entered');
      try { await delay(${hookMs}, undefined, { signal: ctx.signal }); }
      catch { append('hook stopped'); return; }
      append('hook completed');
    });
    api.on('session_shutdown', async () => {
      await delay(${shutdownMs});
      append('shutdown completed');
    });
  }] });
await resourceLoader.reload();
const model = ${JSON.stringify(model)};
const answer = { ...${JSON.stringify(answer)}, timestamp: Date.now() };
const modelRuntime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
  getAuth: async () => ({ auth: { apiKey: 'synthetic-offline' } }), streamSimple() {
    return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...answer, content: [] } };
      yield { type: 'done', reason: 'stop', message: answer }; }, result: async () => answer };
  } };
const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: 'off' });
const runtime = new AgentSessionRuntime(session, { cwd }, async () => { throw Error('Unexpected session replacement'); });
process.exitCode = await runPrintMode(runtime, { mode: 'json', initialMessage: 'Offline fixture task' });
${linger ? "append('linger'); setInterval(() => {}, 1000);" : ''}`;
}

async function fixture(t, { hookMs = 0, shutdownMs = 0, linger = false, legacy = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-print-settlement-'));
  const binary = path.join(cwd, 'pi-fixture.mjs');
  const env = { PI_SUBAGENT_PI_BINARY: binary, PI_SUBAGENT_ADMISSION_DIR: path.join(cwd, 'admission'), PI_SUBAGENT_MAX_CONCURRENT: '1',
    PI_CODING_AGENT_DIR: cwd, PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'),
    PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.writeFileSync(env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const oldPrint = `console.log(${JSON.stringify(JSON.stringify({ type: 'message_end', message: answer }))});setInterval(() => {}, 1000);`;
  fs.writeFileSync(binary, `#!/usr/bin/env node\n${legacy ? oldPrint : ownedPrintScript({ hookMs, shutdownMs, linger })}\n`, { mode: 0o700 });
  const { runSync } = await import('../agent/extensions/pi-subagents/src/runs/foreground/execution.ts');
  const agent = { name: 'fixture', description: 'Offline fixture', source: 'runtime', filePath: path.join(cwd, 'fixture.md'),
    systemPrompt: '', systemPromptMode: 'replace', completionGuard: false,
    inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false };
  const readLifecycle = () => {
    const file = path.join(cwd, 'lifecycle');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };
  return { run: opts => runSync(cwd, [agent], agent.name, 'Offline task.', {
    availableModels: [model], modelOverride: model.fullId, timeoutMs: 17_000, acceptance: { level: 'none', reason: 'Local fixture.' }, ...opts,
  }), readLifecycle };
}

test('owned JSON print drains only after both terminal and shutdown hooks finish', { timeout: 25_000 }, async t => {
  const f = await fixture(t, { hookMs: 1_350, shutdownMs: 4_300, linger: true });
  const out = await f.run();
  assert.deepEqual(f.readLifecycle(), ['hook entered', 'hook completed', 'shutdown completed', 'linger']);
  assert.equal(out.exitCode, 0);
  assert.equal(out.finalOutput, 'Synthetic answer');
  assert.equal(out.usage.cost, 0.03);
  assert.equal(out.modelAttempts.length, 1);
});

test('Stop during an owned terminal hook stays a Stop even with an earlier assistant answer', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { hookMs: 6_000 });
  const controller = new AbortController();
  const pending = f.run({ signal: controller.signal });
  t.after(() => controller.abort());
  for (const deadline = Date.now() + 10_000; !f.readLifecycle().includes('hook entered') && Date.now() < deadline;) await delay(15);
  assert.ok(f.readLifecycle().includes('hook entered'));
  controller.abort();
  const out = await pending;
  assert.equal(out.stopped, true);
  assert.notEqual(out.exitCode, 0);
  assert.ok(f.readLifecycle().includes('hook stopped'));
  assert.equal(out.usage.cost, 0.03);
});

test('the child deadline remains active while an owned terminal hook is pending', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { hookMs: 6_000 });
  const schedule = setTimeout, controller = new AbortController();
  let fireDeadline;
  const timers = t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms >= 14_000 && ms <= 15_000 && !fireDeadline) {
      const timer = schedule(() => {}, ms);
      fireDeadline = () => { clearTimeout(timer); callback(...args); };
      return timer;
    }
    return schedule(callback, ms, ...args);
  });
  const pending = f.run({ timeoutMs: 15_000, signal: controller.signal });
  t.after(() => controller.abort());
  for (const deadline = Date.now() + 10_000; !f.readLifecycle().includes('hook entered') && Date.now() < deadline;) await delay(15);
  assert.ok(f.readLifecycle().includes('hook entered'));
  assert.ok(fireDeadline);
  timers.mock.restore();
  fireDeadline();
  const out = await pending;
  assert.equal(out.timedOut, true);
  assert.notEqual(out.exitCode, 0);
  assert.ok(!f.readLifecycle().includes('hook completed'));
  assert.equal(out.usage.cost, 0.03);
});

test('an unnegotiated legacy writer retains the bounded drain after its clean assistant output', { timeout: 8_000 }, async t => {
  const f = await fixture(t, { legacy: true });
  const out = await f.run({ timeoutMs: 4_000 });
  assert.equal(out.exitCode, 0);
  assert.equal(out.finalOutput, 'Synthetic answer');
  assert.equal(out.usage.cost, 0.03);
});
