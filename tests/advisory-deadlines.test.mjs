import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteRanker, RERANK_TIMEOUT_MS } from '../agent/extensions/lib/micro-intelligence/rerank.ts';
import { clearSpanCache, scoreSpanTrace, createSpanTrace, SPAN_CATALOG, SPAN_REQUEST_TIMEOUT_MS } from '../agent/extensions/lib/micro-intelligence/span-sensor.ts';
import { microMetrics, resetMicroMetrics } from '../agent/extensions/lib/micro-intelligence/metrics.ts';

const candidates = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'third' }];
const trace = () => {
  const collector = createSpanTrace();
  for (let index = 0; index < 3; index++) collector.record('note', `fixture note ${index}`, index + 1);
  return collector.trace;
};
const spanAnswer = () => ({ text: JSON.stringify(Object.fromEntries(SPAN_CATALOG.map(({ id }) => [id, { present: .9, absent: .05, notObservable: .05 }]))), model: 'fixture', inputTokens: 1, costUsd: .001, ms: 1 });

for (const kind of ['rerank', 'span']) {
  test(`${kind} owns its deadline and cancellation even when an adapter ignores both`, { timeout: 2000 }, async () => {
    for (const reason of ['timeout', 'aborted']) {
      clearSpanCache(); resetMicroMetrics();
      const controller = new AbortController();
      let resolveLate, rejectLate, adapterSignal;
      const timeoutMs = reason === 'timeout' ? 10 : 1000;
      const adapter = (_request, options) => {
        adapterSignal = (options ?? _request).signal;
        return new Promise((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
      };
      const pending = kind === 'rerank'
        ? remoteRanker({ model: 'fixture', env: {}, timeoutMs, transport: adapter }).rank('query', candidates, controller.signal)
        : scoreSpanTrace(trace(), adapter, { env: {}, timeoutMs, signal: controller.signal });
      if (reason === 'aborted') controller.abort();
      const result = await pending;
      assert.equal(adapterSignal.aborted, true);
      if (kind === 'rerank') assert.equal(result, undefined);
      else { assert.equal(result.ok, false); assert.equal(result.skipped, reason); }
      assert.equal(microMetrics().snapshot().helpers[kind].skipReasons[reason], 1);
      if (reason === 'timeout') resolveLate(kind === 'rerank' ? { order: [1, 0] } : spanAnswer());
      else rejectLate(Error('late rejected adapter work'));
      await delay(0);
      assert.equal(microMetrics().snapshot().helpers[kind].accepted, 0, 'late work cannot publish accepted advice');
      if (kind === 'span') {
        let calls = 0;
        const retry = await scoreSpanTrace(trace(), async () => { calls++; return spanAnswer(); }, { env: {} });
        assert.equal(calls, 1, 'a late score was not cached');
        assert.equal(retry.cached, false);
      }
    }
    clearSpanCache(); resetMicroMetrics();
  });
}

test('successful advisories clear owned timers and normalize invalid deadline inputs', async () => {
  clearSpanCache();
  let rerankSignal, spanSignal;
  const ranked = await remoteRanker({ model: 'fixture', env: {}, timeoutMs: 10, transport: async ({ signal }) => { rerankSignal = signal; return { order: [1, 0] }; } }).rank('query', candidates);
  assert.deepEqual(ranked, ['b', 'a']);
  const scored = await scoreSpanTrace(trace(), async (_prompt, { signal }) => { spanSignal = signal; return spanAnswer(); }, { env: {}, timeoutMs: 10 });
  assert.equal(scored.ok, true);
  await delay(20);
  assert.equal(rerankSignal.aborted, false, 'settled ranker timer was cleared');
  assert.equal(spanSignal.aborted, false, 'settled scorer timer was cleared');
  clearSpanCache();
  await remoteRanker({ model: 'fixture', env: {}, timeoutMs: Infinity, transport: async ({ timeoutMs }) => { assert.equal(timeoutMs, RERANK_TIMEOUT_MS); return { order: [1, 0] }; } }).rank('query', candidates);
  await scoreSpanTrace(trace(), async (_prompt, { timeoutMs }) => { assert.equal(timeoutMs, SPAN_REQUEST_TIMEOUT_MS); return spanAnswer(); }, { env: {}, timeoutMs: NaN });
  clearSpanCache();
});
