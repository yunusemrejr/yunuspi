import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResultWatcher } from '../agent/extensions/pi-subagents/src/runs/background/result-watcher.ts';

function fixture(t, rootSession, childSession) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-result-owner-'));
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({ sessionId: rootSession, completionOwnerId: rootSession,
    runId: 'run', state: 'completed', success: true, summary: 'test passed', timestamp: Date.now(),
    results: [{ agent: 'worker', success: true, output: 'test passed',
      structuredOutput: { sessionId: childSession, completionOwnerId: childSession, asyncDir: dir } }],
  }));
  const state = { currentSessionId: 'owner', completionOwnerId: 'owner', asyncJobs: new Map([['run', {}]]),
    completionSeen: new Map(), watcher: null, watcherRestartTimer: null };
  let parses = 0, delivered = 0;
  const watcher = createResultWatcher({ events: { emit() {} } }, state, dir, 60_000, {
    coalesceDelayMs: 0, platform: 'win32', deliverIntercomResults: false,
    parseResult: raw => { parses++; return JSON.parse(raw); },
    notifier: { deliver: async () => { delivered++; return true; } },
  });
  t.after(() => { watcher.stopResultWatcher(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { watcher, file, parses: () => parses, delivered: () => delivered };
}

test('nested result metadata cannot hide its owning root session', async t => {
  const f = fixture(t, 'owner', 'foreign');
  f.watcher.startResultWatcher(); f.watcher.primeExistingResults();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.delivered(), 1);
  assert.equal(fs.existsSync(f.file), false);
});

test('nested ownership metadata cannot cause full parsing of a foreign result', async t => {
  const f = fixture(t, 'foreign', 'owner');
  f.watcher.startResultWatcher(); f.watcher.primeExistingResults();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.parses(), 0);
  assert.equal(f.delivered(), 0);
  assert.equal(fs.existsSync(f.file), true);
});
