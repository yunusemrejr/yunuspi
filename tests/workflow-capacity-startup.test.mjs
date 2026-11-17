import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('an initial workflow status that loses its write fence never starts the controller or occupies capacity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-capacity-start-'));
  const previousCwd = process.cwd();
  t.after(() => { process.chdir(previousCwd); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'runtime');
  delete process.env.PI_HARNESS_MUTATION_DENIED;
  delete process.env.PI_SUBAGENT_CHILD;
  const { createSubagentExecutor } = await import('../agent/extensions/pi-subagents/src/runs/foreground/subagent-executor.ts');
  const { DIRS } = await import('../agent/extensions/pi-subagents/src/shared/types.ts');
  const { getActiveAsyncCapacitySnapshot } = await import('../agent/extensions/pi-subagents/src/runs/background/active-async-capacity.ts');
  const { SessionManager } = await import('../core/coding-agent/src/core/session-manager.js');
  const { createEventBus } = await import('../core/coding-agent/src/core/event-bus.js');
  const sessionManager = SessionManager.inMemory(root);
  const state = { currentSessionId: null, asyncJobs: new Map(), fleetJobs: new Map(), subagentSpawns: { sessionId: null, count: 0 } };
  const executor = createSubagentExecutor({
    state, pi: { events: createEventBus(), appendEntry() {} }, config: { maxActiveAsyncRunsPerSession: 1 },
    expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
    tempArtifactsDir: path.join(root, 'artifacts'), getSubagentSessionRoot: () => path.join(root, 'sessions'),
  });
  const originalMkdir = fs.mkdirSync;
  let newerStatusPath;
  const newer = { state: 'stopped', revision: 2 };
  const mkdir = t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    const directory = String(target);
    if (!newerStatusPath && directory.startsWith(DIRS.async + path.sep) && directory.endsWith('/status.json.write-lock')) {
      newerStatusPath = path.join(path.dirname(directory), 'status.json');
      fs.writeFileSync(newerStatusPath, JSON.stringify(newer));
    }
    return originalMkdir(target, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await executor.execute('workflow-start-fixture', { workflowScript: 'return 42;', async: true, mission: false },
      new AbortController().signal, undefined, { cwd: root, hasUI: false, sessionManager });
  } finally {
    mkdir.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(newerStatusPath, JSON.stringify(result));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Initial workflow status was superseded/);
  assert.deepEqual(JSON.parse(fs.readFileSync(newerStatusPath, 'utf8')), newer);
  assert.equal(state.workflowControllers.size, 0);
  assert.equal(state.asyncJobs.size, 0);
  assert.equal(state.fleetJobs.size, 0);
  assert.equal(getActiveAsyncCapacitySnapshot(sessionManager.getSessionId(), 1).used, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(newerStatusPath), 'events.jsonl')), false);
});

test('a workflow killed after preparation but before scheduling releases its verified capacity', { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workflow-prepared-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const runtime = path.join(root, 'runtime');
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { createSubagentExecutor } from './agent/extensions/pi-subagents/src/runs/foreground/subagent-executor.ts';
    import { SessionManager } from './core/coding-agent/src/core/session-manager.js';
    import { createEventBus } from './core/coding-agent/src/core/event-bus.js';
    const root = ${JSON.stringify(root)};
    const manager = SessionManager.inMemory(root);
    const append = fs.appendFileSync;
    fs.appendFileSync = (target, data, ...args) => {
      if (typeof data === 'string' && data.includes('"type":"subagent.workflow.started"')) {
        process.send(manager.getSessionId());
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
      }
      return append(target, data, ...args);
    };
    syncBuiltinESMExports();
    const executor = createSubagentExecutor({
      state: { currentSessionId: null, asyncJobs: new Map(), fleetJobs: new Map(), subagentSpawns: { sessionId: null, count: 0 } },
      pi: { events: createEventBus(), appendEntry() {} }, config: { maxActiveAsyncRunsPerSession: 1 },
      expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
      tempArtifactsDir: path.join(root, 'artifacts'), getSubagentSessionRoot: () => path.join(root, 'sessions'),
    });
    await executor.execute('fixture', { workflowScript: 'return runs.run("one", { agent: "fixture", task: "Synthetic" });', async: true, mission: false },
      new AbortController().signal, undefined, { cwd: root, hasUI: false, sessionManager: manager });
  `;
  const env = { ...process.env, PI_CODING_AGENT_DIR: root, PI_SUBAGENTS_TEMP_ROOT: runtime };
  delete env.PI_HARNESS_MUTATION_DENIED;
  delete env.PI_SUBAGENT_CHILD;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const sessionId = await Promise.race([once(child, 'message').then(([id]) => id), closed.then(() => undefined)]);
  assert.ok(sessionId);
  const { acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey, getActiveAsyncCapacitySnapshot } = await import('../agent/extensions/pi-subagents/src/runs/background/active-async-capacity.ts');
  const rootDir = path.join(runtime, 'session-active-async-capacity');
  const owner = JSON.parse(fs.readFileSync(path.join(rootDir, activeAsyncCapacitySessionKey(sessionId), 'slot-0', 'owner.json'), 'utf8'));
  assert.ok(owner.runnerStartedAt);
  assert.equal(owner.workflowDispatchPending, true);
  assert.equal(getActiveAsyncCapacitySnapshot(sessionId, 1, { rootDir }).used, 1);
  child.kill('SIGKILL');
  assert.deepEqual(await closed, [null, 'SIGKILL']);
  assert.equal(getActiveAsyncCapacitySnapshot(sessionId, 1, { rootDir }).used, 0);
  const replacement = acquireActiveAsyncCapacity({ sessionId, limit: 1, runId: 'replacement', kind: 'workflow', asyncDir: path.join(root, 'replacement') }, { rootDir });
  assert.equal(replacement.rollback(), true);
  assert.equal(fs.existsSync(path.join(owner.asyncDir, 'events.jsonl')), false);
});
