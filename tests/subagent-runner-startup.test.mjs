import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import * as fs from 'node:fs';

const source = readFileSync(new URL('../agent/extensions/pi-subagents/src/runs/background/async-execution.ts', import.meta.url), 'utf8');
const startup = source.slice(source.indexOf('const RUNNER_STARTUP_TIMEOUT_MS'), source.indexOf('const writePrivateStartupControlJson'));
const waitForRunnerStartup = runInNewContext(`${stripTypeScriptTypes(startup)}\nwaitForRunnerStartup`, { fs, delay, Error });

function startupPath(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yunuspi-runner-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'runner-startup.json');
}

test('a pending runner handshake leaves the parent event loop free to deliver ready', async t => {
  const file = startupPath(t);
  setImmediate(() => writeFileSync(file, JSON.stringify({ state: 'ready', token: 'fixture-token' })));
  const result = await waitForRunnerStartup(file, 'ready', 1000);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.token, 'fixture-token');
});

test('Stop interrupts runner startup before a late handshake can authorize work', async t => {
  const file = startupPath(t);
  const controller = new AbortController();
  const interrupted = new Error('Async runner startup was stopped.');
  setImmediate(() => {
    controller.abort(interrupted);
    writeFileSync(file, JSON.stringify({ state: 'acknowledged', token: 'fixture-token' }));
  });
  const result = await waitForRunnerStartup(file, 'acknowledged', 1000, 'fixture-token', controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.error, interrupted.message);
  assert.equal(result.startupDidNotProceed, true);
});

test('a ready handshake cannot commit a run that has hit its absolute deadline', async t => {
  const file = startupPath(t);
  writeFileSync(file, JSON.stringify({ state: 'ready', token: 'fixture-token' }));
  const result = await waitForRunnerStartup(file, 'ready', 1000, undefined, undefined, Date.now());
  assert.equal(result.ok, false);
  assert.match(result.error, /run timed out/i);
});

test('a real async revival stops before allowing its inference writer to start', { timeout: 15_000 }, async t => {
  const cwd = path.dirname(startupPath(t));
  const runs = path.join(cwd, 'runs');
  const nativeWriter = path.join(cwd, 'fixture-pi.mjs');
  const dispatched = path.join(cwd, 'writer-started');
  process.env.PI_CODING_AGENT_DIR = cwd;
  process.env.PI_SUBAGENTS_TEMP_ROOT = runs;
  process.env.PI_SUBAGENT_ADMISSION_DIR = path.join(cwd, 'slots');
  process.env.PI_SUBAGENT_PI_BINARY = nativeWriter;
  writeFileSync(nativeWriter, `#!/usr/bin/env node\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(dispatched)}, 'unexpected');\n`, { mode: 0o700 });

  const { executeAsyncSingle } = await import('../agent/extensions/pi-subagents/src/runs/background/async-execution.ts');
  const { DIRS } = await import('../agent/extensions/pi-subagents/src/shared/types.ts');
  const { createEventBus } = await import('../core/coding-agent/src/core/event-bus.js');
  const { SessionManager } = await import('../core/coding-agent/src/core/session-manager.js');
  const sessions = path.join(cwd, 'sessions');
  const previous = SessionManager.create(cwd, sessions);
  previous.appendMessage({ role: 'user', content: 'Fixture previous prompt', timestamp: 1 });
  const sessionFile = previous.getSessionFile();
  const controller = new AbortController();
  const runId = 'startup-cancel-fixture';
  const runDir = path.join(DIRS.async, runId);
  const model = { provider: 'openrouter', id: 'org/fixture', name: 'Fixture', fullId: 'openrouter/org/fixture',
    api: 'openai-completions', baseUrl: 'https://invalid.example', input: ['text'], reasoning: false,
    contextWindow: 65_536, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const agent = { name: 'fixture', description: 'Read-only fixture', source: 'runtime', filePath: path.join(cwd, 'agent.md'),
    systemPrompt: 'Fixture.', systemPromptMode: 'replace', inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, extensions: [], tools: [] };
  const pending = executeAsyncSingle(runId, {
    agent: agent.name, agentConfig: agent, task: 'Fixture continuation', availableModels: [model],
    ctx: { pi: { events: createEventBus() }, cwd, interactive: false, currentModelProvider: model.provider, currentModel: model },
    cwd, sessionFile, sessionRoot: sessions, revivalLease: { sessionFile, runId, sourceRunId: 'fixture-source' },
    context: 'fresh', artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1,
    launchSignal: controller.signal,
  });
  setImmediate(() => controller.abort(new Error('Fixture Stop during runner startup.')));
  const result = await pending;
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /Fixture Stop during runner startup/);
  const status = JSON.parse(readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'stopped');
  assert.equal(status.stopped, true);
  assert.equal(status.processTerminal.state, 'observed');
  assert.deepEqual(status.processTerminal.instances.map(instance => instance.kind), ['runner']);
  assert.equal(status.steps[0].processTerminal.state, 'not-started');
  assert.equal(fs.existsSync(path.join(runDir, 'runner-startup-proceed.json')), false);
  assert.equal(fs.existsSync(dispatched), false);
});
