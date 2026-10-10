import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/context-provenance.ts')),
);
assert.ok(agent, 'agent tree with context-provenance.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { envelopInjection, injectionFresh, splitLateBound, clearInjectionLedger } = await import(lib + 'context-provenance.ts');

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

test('injection envelopes reach diagnostic exports through the bridge', async () => {
  const { buildSessionJsonExport } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-export-json.ts')));
  const key = Symbol.for('yunus-pi.context-injection.v1');
  const prior = globalThis[key];
  const { envelope } = envelopInjection({ owner: 'project-intelligence:capsule', bytes: 'capsule bytes here', sourceRevision: 'generation:7' });
  globalThis[key] = { last: [envelope] };
  try {
    const report = buildSessionJsonExport({ header: {}, scope: 'branch', branch: [], retained: [] });
    assert.equal(report.normalized.context.injections.length, 1);
    assert.equal(report.normalized.context.injections[0].owner, 'project-intelligence:capsule');
    assert.equal(report.normalized.context.injections[0].hash, envelope.hash);
    assert.equal(report.normalized.context.injections[0].materiallyNew, true);
  } finally {
    if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior;
  }
});

test('late-bound blocks keep stable prefixes byte-identical', () => {
  const { stable, lateBound } = splitLateBound('STABLE PREFIX', { turn: '42', model: 'q/m' });
  assert.equal(stable, 'STABLE PREFIX');
  assert.ok(lateBound.includes('turn: 42'));
  const again = splitLateBound('STABLE PREFIX', { turn: '43', model: 'q/m' });
  assert.equal(again.stable, stable, 'dynamic scalars never invalidate the stable prefix');
});
