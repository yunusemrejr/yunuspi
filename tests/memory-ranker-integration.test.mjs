import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRanker } from '../agent/extensions/lib/project-memory-retrieve.ts';
import { remoteRanker } from '../agent/extensions/lib/micro-intelligence/rerank.ts';

const candidates = [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }, { id: 'c', text: 'Gamma' }];

test('memory refinement calls a configured remote ranker with the locally ordered head', async () => {
  let calls = 0;
  const remote = remoteRanker({ env: { PI_RERANK_MODEL: 'fixture-rerank' }, transport: async request => {
    calls++;
    assert.deepEqual(request.documents, ['Beta', 'Alpha', 'Gamma']);
    return { order: [2, 1] };
  } });
  const ranker = memoryRanker({ rank: async () => ['b', 'a'] }, remote);
  assert.deepEqual(await ranker.rank('meaningful query', candidates), ['c', 'a', 'b']);
  assert.equal(calls, 1);
  assert.deepEqual(candidates.map(c => c.id), ['a', 'b', 'c']);
});

test('unconfigured, failed, and malformed remote ranks preserve local order', async () => {
  const local = { rank: async () => ['b', 'a', 'c'] };
  for (const remote of [remoteRanker({ env: {} }), { rank: async () => { throw Error('offline'); } }, { rank: async () => ['b', 'b'] }, { rank: async () => ['unknown', 'a'] }]) {
    assert.deepEqual(await memoryRanker(local, remote).rank('meaningful query', candidates), ['b', 'a', 'c']);
  }
  assert.deepEqual(await memoryRanker({ rank: async () => undefined }, { rank: async () => ['c', 'b'] }).rank('query', candidates), ['c', 'b', 'a']);
});

test('cancellation never launches the next refinement stage or publishes late ranks', async () => {
  for (const during of ['before', 'local', 'remote']) {
    const controller = new AbortController();
    let localCalls = 0, remoteCalls = 0;
    if (during === 'before') controller.abort();
    const ranker = memoryRanker({ rank: async (_q, _c, signal) => {
      localCalls++; assert.equal(signal, controller.signal);
      if (during === 'local') controller.abort();
      return ['b', 'a'];
    } }, { rank: async (_q, _c, signal) => {
      remoteCalls++; assert.equal(signal, controller.signal); controller.abort(); return ['c', 'a'];
    } });
    assert.equal(await ranker.rank('query', candidates, controller.signal), undefined);
    assert.equal(localCalls, during === 'before' ? 0 : 1);
    assert.equal(remoteCalls, during === 'remote' ? 1 : 0);
  }
});

test('cancellation stops waiting for a ranker that cannot observe its signal', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let rejectLate, calls = 0;
  const ranker = memoryRanker({ rank: () => new Promise((_, reject) => { rejectLate = reject; }) }, { rank: async () => { calls++; return ['a', 'b']; } });
  const pending = ranker.rank('query', candidates, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(calls, 0);
  rejectLate(Error('late worker rejection is still observed'));
  await new Promise(resolve => setImmediate(resolve));
});
