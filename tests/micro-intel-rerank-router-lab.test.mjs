// Remote rerank and the model qualification lab. No
// network, no keys: transports and completions are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const rerankMod = await load("extensions/lib/micro-intelligence/rerank.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

test("remote rerank is available by default and degrades to local order when disabled or unconfigured", async () => {
  metricsMod.resetMicroMetrics();
  try {
    assert.equal(rerankMod.rerankEnabled({}), true);
    assert.equal(rerankMod.rerankEnabled({ PI_OFFLINE: '1' }), false);
    const ranker = rerankMod.remoteRanker({ env: { PI_RERANK: 'off' }, model: "voyage-rerank-3", transport: async () => ({ order: [1, 0] }) });
    const cands = [{ id: "a", text: "first" }, { id: "b", text: "second" }, { id: "c", text: "third" }];
    assert.equal(await ranker.rank("q", cands), undefined);
    assert.equal(metricsMod.microMetrics().snapshot().helpers.rerank.skipReasons.disabled, 1);

    const unconfigured = rerankMod.remoteRanker({ env: { PI_RERANK: "on" } });
    assert.equal(await unconfigured.rank("q", cands), undefined);

    const failing = rerankMod.remoteRanker({
      model: "m", env: { PI_RERANK: "on" },
      transport: async () => { throw Error("down"); },
    });
    assert.equal(await failing.rank("q", cands), undefined);

    const ok = rerankMod.remoteRanker({
      model: "m", env: { PI_RERANK: "on" },
      transport: async ({ documents }) => {
        assert.equal(documents.length, 3);
        return { order: [2, 0, 1] };
      },
    });
    assert.deepEqual(await ok.rank("q", cands), ["c", "a", "b"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test('remote rerank rejects malformed provider indices and scores', async () => {
  const request = { url: 'https://fixture.invalid/rerank', model: 'fixture', query: 'cache', documents: ['a', 'b', 'c'], topK: 3, timeoutMs: 100 };
  for (const data of [
    [{ index: 1, relevance_score: .8 }, { index: 1, relevance_score: .7 }],
    [{ index: 7, relevance_score: .8 }], [{ index: 0, relevance_score: 'high' }],
    [{ index: 0, relevance_score: Infinity }], [null],
  ]) {
    const transport = rerankMod.voyageRerankTransport({ key: () => 'synthetic', fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
    await assert.rejects(transport(request), /malformed answers/);
  }
});

test('remote rerank snapshots candidate IDs and rejects invalid or cancelled injected results', async () => {
  const candidates = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'third' }];
  const env = { PI_RERANK: 'on' };
  for (const order of [[0, 0], [0, 8], [0, 1.5], ['0', 1]]) {
    assert.equal(await rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => ({ order }) }).rank('cache', candidates), undefined);
  }
  let release;
  const mutable = structuredClone(candidates);
  const ranker = rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => new Promise(resolve => { release = () => resolve({ order: [1, 0] }); }) });
  const pending = ranker.rank('cache', mutable);
  mutable[1].id = 'changed'; release();
  assert.deepEqual(await pending, ['b', 'a']);
  const controller = new AbortController();
  const cancelled = rerankMod.remoteRanker({ model: 'fixture', env, transport: async () => { controller.abort(); return { order: [1, 0] }; } });
  assert.equal(await cancelled.rank('cache', candidates, controller.signal), undefined);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('remote rerank deadlines suppress late work even when the adapter ignores cancellation', { timeout: 2000 }, async () => {
  const rows = [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }, { id: 'c', text: 'third' }];
  for (const reason of ['timeout', 'aborted']) {
    metricsMod.resetMicroMetrics();
    const controller = new AbortController();
    let resolveLate, rejectLate, offered;
    const pending = rerankMod.remoteRanker({ model: 'fixture', env: {}, timeoutMs: reason === 'timeout' ? 10 : 1000,
      transport: ({ signal }) => { offered = signal; return new Promise((resolve, reject) => { resolveLate = resolve; rejectLate = reject; }); },
    }).rank('query', rows, controller.signal);
    if (reason === 'aborted') controller.abort();
    assert.equal(await pending, undefined); assert.equal(offered.aborted, true);
    assert.equal(metricsMod.microMetrics().snapshot().helpers.rerank.skipReasons[reason], 1);
    if (reason === 'timeout') resolveLate({ order: [1, 0] }); else rejectLate(Error('late adapter failure'));
    await tick();
    assert.equal(metricsMod.microMetrics().snapshot().helpers.rerank.accepted, 0);
  }
  let offered;
  assert.deepEqual(await rerankMod.remoteRanker({ model: 'fixture', env: {}, timeoutMs: 10,
    transport: async ({ signal }) => { offered = signal; return { order: [1, 0] }; },
  }).rank('query', rows), ['b', 'a']);
  await delay(20); assert.equal(offered.aborted, false, 'successful ranker clears its timer');
  await rerankMod.remoteRanker({ model: 'fixture', env: {}, timeoutMs: Infinity,
    transport: async ({ timeoutMs }) => { assert.equal(timeoutMs, rerankMod.RERANK_TIMEOUT_MS); return { order: [1, 0] }; },
  }).rank('query', rows);
  metricsMod.resetMicroMetrics();
});
