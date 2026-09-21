import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/hook-events.ts')),
);
assert.ok(agent, 'agent tree with hook-events.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { normalizeHookEvent, routeHookEvent, cachedPureComputation, hookCacheStats, clearHookCaches } = await import(lib + 'hook-events.ts');
const { envelopInjection, injectionFresh, splitLateBound, clearInjectionLedger } = await import(lib + 'context-provenance.ts');

test('hooks subscribe to narrow event classes with cheap prefilters', () => {
  const subscriptions = [
    { hook: 'fs-safety', classes: ['file-write', 'command-run'] },
    { hook: 'guidance', classes: ['tool-call'], prefilter: (e) => e.tool === 'bash' },
    { hook: 'telemetry', classes: ['tool-call', 'tool-result', 'tool-error', 'other'] },
  ];
  const read = normalizeHookEvent({ kind: 'tool_call', tool: 'read', path: '/a/b.ts' });
  assert.equal(read.class, 'tool-call');
  const runnable = routeHookEvent(read, subscriptions);
  assert.ok(!runnable.includes('fs-safety'), 'read does not wake write hooks');
  assert.ok(!runnable.includes('guidance'), 'prefilter skips non-bash calls');
  assert.ok(runnable.includes('telemetry'));

  const write = normalizeHookEvent({ kind: 'tool_call', tool: 'write', path: '/a/b.ts' });
  assert.equal(write.class, 'tool-call');
  const writeRunnable = routeHookEvent({ ...write, class: 'file-write' }, subscriptions);
  assert.ok(writeRunnable.includes('fs-safety'));
});

test('pure computations are shared by semantic event identity', () => {
  clearHookCaches();
  const event = normalizeHookEvent({ kind: 'tool_result', tool: 'read', path: '/x/y.ts', content: 'hello' });
  let calls = 0;
  const first = cachedPureComputation(event, 'parse', () => { calls++; return { tokens: 2 }; });
  const second = cachedPureComputation(event, 'parse', () => { calls++; return { tokens: 2 }; });
  assert.deepEqual(first, second);
  assert.equal(calls, 1, 'second hook reuses the first parse');
  const other = normalizeHookEvent({ kind: 'tool_result', tool: 'read', path: '/x/y.ts', content: 'different' });
  cachedPureComputation(other, 'parse', () => { calls++; return { tokens: 3 }; });
  assert.equal(calls, 2, 'different bytes are a different identity');
  assert.ok(hookCacheStats().entries >= 2);
});

test('injections carry owner, hash, revision, ttl, tokens, and newness', () => {
  clearInjectionLedger();
  const first = envelopInjection({ owner: 'project-intelligence', bytes: 'graph digest abc', sourceRevision: 'rev-1', ttlMs: 60000 });
  assert.equal(first.envelope.owner, 'project-intelligence');
  assert.ok(first.envelope.hash.length === 32);
  assert.equal(first.envelope.materiallyNew, true);
  assert.equal(first.envelope.estimatedTokens, Math.ceil('graph digest abc'.length / 4));
  assert.equal(injectionFresh(first.envelope, first.envelope.injectedAt + 1000), true);
  assert.equal(injectionFresh(first.envelope, first.envelope.injectedAt + 61000), false);

  const repeat = envelopInjection({ owner: 'project-intelligence', bytes: 'graph digest abc', sourceRevision: 'rev-1', ttlMs: 60000 });
  assert.equal(repeat.envelope.materiallyNew, false, 'repeated churn is flagged, not mistaken for new intel');
});

test('late-bound blocks keep stable prefixes byte-identical', () => {
  const { stable, lateBound } = splitLateBound('STABLE PREFIX', { turn: '42', model: 'q/m' });
  assert.equal(stable, 'STABLE PREFIX');
  assert.ok(lateBound.includes('turn: 42'));
  const again = splitLateBound('STABLE PREFIX', { turn: '43', model: 'q/m' });
  assert.equal(again.stable, stable, 'dynamic scalars never invalidate the stable prefix');
});
