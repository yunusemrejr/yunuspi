import assert from 'node:assert/strict';
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
