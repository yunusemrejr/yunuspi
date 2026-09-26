import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/micro-intelligence/router-shadow.ts')));
const { createRouterShadow } = await import(pathToFileURL(path.join(agent, 'extensions/lib/micro-intelligence/router-shadow.ts')));
const candidates = ['fixture/first', 'fixture/second'];
const suggestion = { model: candidates[1], effort: 'high' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('router comparison validates exact candidates and isolates returned and offered records', async () => {
  const shadow = createRouterShadow(16, { env: {} });
  for (const invalid of [undefined, null, {}, { model: 1 }, { model: 'unknown/route' }, { model: candidates[0], effort: [] }, { model: candidates[0], effort: 'high\nnew instruction' }]) {
    const row = await shadow.compare('select a model', candidates[0], async () => ({ suggestion: invalid }), candidates);
    assert.equal(row.router, null); assert.equal(row.skipped, 'invalid-suggestion');
  }
  let release;
  const mutable = [...candidates];
  const pending = shadow.compare('select a model', candidates[0], async (_task, request) => {
    request.candidates[1] = 'mutated/adapter';
    return new Promise(resolve => { release = resolve; });
  }, mutable);
  mutable[1] = 'mutated/caller';
  release({ suggestion });
  const row = await pending;
  assert.equal(row.router, candidates[1]);
  row.router = 'forged'; row.success = true;
  assert.equal(shadow.report().yunuspiDecided, 0);
  shadow.recordOutcome(row.id, { success: true, latencyMs: 8, costUsd: .001, retries: 0 });
  shadow.recordOutcome(row.id, { success: 'false', latencyMs: -1, costUsd: Infinity, retries: NaN });
  const report = shadow.report();
  assert.equal(report.yunuspiSuccess, 1); assert.equal(report.meanLatencyMs, 8); assert.equal(report.meanCostUsd, .001);
  assert.equal(report.withSuggestion, 1);
  const second = await shadow.compare('select a model', candidates[0], async () => ({ suggestion }), candidates);
  assert.notEqual(second.id, row.id, 'identical concurrent decisions must not share identity');
});

test('router deadline and caller cancellation bound uncooperative adapters and observe late rejection', { timeout: 2000 }, async () => {
  for (const mode of ['timeout', 'caller', 'clear']) {
    const shadow = createRouterShadow(16, { timeoutMs: mode === 'timeout' ? 10 : 1000, env: {} });
    const caller = new AbortController();
    let reject, offered;
    const pending = shadow.compare('select a model', candidates[0], async (_task, request) => {
      offered = request.signal;
      return new Promise((_resolve, fail) => { reject = fail; });
    }, candidates, caller.signal);
    if (mode === 'caller') caller.abort();
    if (mode === 'clear') shadow.clear();
    const row = await pending;
    assert.equal(row.router, null);
    assert.equal(row.skipped, mode === 'timeout' ? 'timeout' : 'aborted');
    assert.equal(offered.aborted, true);
    assert.equal(shadow.report().comparisons, mode === 'timeout' ? 1 : 0);
    reject(new Error('late adapter failure')); await tick();
  }
});

test('clearing session comparisons cancels old work without clearing a fresh comparison', { timeout: 2000 }, async () => {
  const shadow = createRouterShadow(16, { env: {} });
  let release;
  const old = shadow.compare('old session', candidates[0], async () => new Promise(resolve => { release = resolve; }), candidates);
  shadow.clear();
  const current = await shadow.compare('new session', candidates[0], async () => ({ suggestion }), candidates);
  assert.equal((await old).skipped, 'aborted');
  release({ suggestion: { model: candidates[0] } }); await tick();
  assert.equal(shadow.report().comparisons, 1);
  shadow.recordOutcome(current.id, { success: true });
  assert.equal(shadow.report().yunuspiSuccess, 1);
});

test('disabled and invalid requests never invoke an adapter and successful timers are cleaned up', { timeout: 2000 }, async () => {
  let called = 0, offered;
  const suggest = async (_task, request) => { called++; offered = request.signal; return { suggestion }; };
  const disabled = createRouterShadow(16, { env: { PI_ROUTER_SHADOW: 'off' } });
  assert.equal((await disabled.compare('select model', candidates[0], suggest, candidates)).skipped, 'disabled');
  const shadow = createRouterShadow(16, { timeoutMs: 10, env: {} });
  assert.equal((await shadow.compare('select model', 'missing/choice', suggest, candidates)).skipped, 'invalid-input');
  const controller = new AbortController(); controller.abort();
  assert.equal((await shadow.compare('select model', candidates[0], suggest, candidates, controller.signal)).skipped, 'aborted');
  assert.equal(called, 0);
  assert.equal((await shadow.compare('select model', candidates[0], suggest, candidates)).router, candidates[1]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(offered.aborted, false, 'settled invocation leaves no armed timeout');
});
