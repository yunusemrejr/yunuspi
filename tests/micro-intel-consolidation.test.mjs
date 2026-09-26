// Finding consolidation and semantic margin dedup: deterministic grouping,
// bounded Jev disambiguation, provenance. Rank/judge are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const reviewMod = await load("extensions/lib/micro-intelligence/review.ts");
const bookMod = await load("extensions/lib/observer-book.ts");
const metricsMod = await load("extensions/lib/micro-intelligence/metrics.ts");

const { consolidateFindings } = reviewMod;
const { findSemanticMarginDuplicate } = bookMod;

const finding = (id, text) => ({ id, text });

test("deterministic consolidation groups overlaps with provenance", async () => {
  metricsMod.resetMicroMetrics();
  try {
    const { groups, singletons } = await consolidateFindings([
      finding("a", "The login handler stores the session token in a cookie without the secure flag set on production domains."),
      finding("b", "The login handler stores the session token in a cookie without the secure flag set on production domains."),
      finding("c", "Unrelated: the invoice total ignores discount lines in the footer."),
    ], { sourceOf: (id) => (id === "c" ? "content" : "security") });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kept, "a");
    assert.deepEqual(groups[0].merged.map((m) => m.id), ["b"]);
    assert.equal(groups[0].merged[0].method, "exact");
    assert.deepEqual(groups[0].sources, ["security"]);
    assert.deepEqual(singletons, ["c"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("ambiguous pairs earn a bounded Jev judgment", async () => {
  metricsMod.resetMicroMetrics();
  try {
    let calls = 0;
    const ask = async (_site, _state, questions) => {
      calls++;
      return { ok: true, answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.9 }])), usage: { inputTokens: 5, cached: false } };
    };
    // Mid-overlap pair: same auth-cookie issue, different wording.
    const { groups } = await consolidateFindings([
      finding("a", "Session cookie for authentication lacks the HttpOnly attribute in the web login flow handler."),
      finding("b", "Web login flow handler sets an authentication session cookie missing HttpOnly protection flag."),
    ], { ask, maxJudgePairs: 2 });
    assert.equal(calls, 1, 'ambiguous pairs share one transport request');
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].merged.map((m) => m.method), ["jev"]);
  } finally {
    metricsMod.resetMicroMetrics();
  }
});

test("consolidation bounds input and never throws", async () => {
  const one = await consolidateFindings([finding("a", "solo finding here")]);
  assert.deepEqual(one, { groups: [], singletons: ["a"] });
  const many = await consolidateFindings(Array.from({ length: 100 }, (_, i) => finding(`f${i}`, `finding number ${i} with enough text to qualify`)));
  assert.equal(many.groups.length, 0);
  const failing = await consolidateFindings(
    [finding("a", "alpha beta gamma delta epsilon zeta"), finding("b", "alpha beta gamma delta epsilon eta")],
    { rank: async () => { throw Error("down"); }, ask: async () => { throw Error("down"); } },
  );
  assert.ok(Array.isArray(failing.singletons));
});

test("semantic margin probe confirms paraphrases above bar", async () => {
  const notes = [
    { id: "m1", text: "Always verify production bytes after a deploy, never trust the push receipt.", struckAt: undefined },
    { id: "m2", text: "Unrelated note about font pairing in marketing pages.", struckAt: undefined },
  ];
  const rank = async (query, candidates, topK) => ({
    ok: true, ms: 1, cached: false, shadow: false,
    value: { ranked: [{ id: "m1", score: 0.96 }, { id: "m2", score: 0.5 }].slice(0, topK), margin: 0.46 },
  });
  assert.equal(await findSemanticMarginDuplicate("Never trust a push receipt; always check production bytes after deploying.", notes, rank), "m1");

  const weak = async () => ({
    ok: true, ms: 1, cached: false, shadow: false,
    value: { ranked: [{ id: "m2", score: 0.6 }], margin: 0.1 },
  });
  assert.equal(await findSemanticMarginDuplicate("Something entirely different about databases.", notes, weak), undefined);
  assert.equal(await findSemanticMarginDuplicate("short", notes, rank), undefined);
  assert.equal(await findSemanticMarginDuplicate("A long enough candidate text here.", notes, undefined), undefined);
  assert.equal(await findSemanticMarginDuplicate("A long enough candidate text here.", notes, async () => { throw Error("down"); }), undefined);
});

test('margin comparisons use one judge batch and preserve distinct or uncertain notes', async () => {
  const notes = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, text: `The durable project lesson number ${i} has an independent condition and action.` }));
  let asks = 0, ranks = 0, matched;
  const rank = async () => { ranks++; throw Error('the judge already compared these notes'); };
  const ask = async (site, state, questions, options) => {
    asks++; assert.equal(site, 'finding-duplicate'); assert.equal(Object.keys(questions).length, 24);
    assert.ok(options.signal); assert.ok(JSON.stringify(questions).includes(notes[23].text));
    assert.ok(Object.values(questions).every(question => question.instructions.includes('Different causes, negations or obligations are distinct')));
    return { ok: true, answers: Object.fromEntries(Object.keys(questions).map((id, i) => [id, { noul: i === 23 ? .95 : .1 }])), usage: { inputTokens: 300, cached: false } };
  };
  assert.equal(await findSemanticMarginDuplicate('A paraphrased durable lesson about a specific project condition.', notes, rank, .93, { ask, onMatch: helper => { matched = helper; } }), 'm23');
  assert.equal(matched, 'jev'); assert.equal(asks, 1); assert.equal(ranks, 0);
  for (const score of [.1, .5]) {
    const answered = async (_site, _state, questions) => ({ ok: true, answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: score }])), usage: { inputTokens: 100, cached: false } });
    assert.equal(await findSemanticMarginDuplicate('A distinct durable condition must remain independently recorded.', notes, rank, .93, { ask: answered }), undefined);
  }
  assert.equal(ranks, 0, 'cosine similarity cannot override a negative or uncertain semantic comparison');
});

test('unavailable margin judge falls back to bounded local batches without dropping later notes', async () => {
  const text = 'A durable project observation about bounded scheduling and independent evidence. '.repeat(3).slice(0, 240);
  const notes = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, text: `${String(i).padStart(2, '0')} ${text}`.slice(0, 240) }));
  const seen = [], calls = [];
  const rank = async (query, candidates) => {
    calls.push(query.length + candidates.reduce((n, row) => n + row.text.length, 0));
    if (calls.at(-1) > 1200) return { ok: false, reason: 'timeout' };
    seen.push(...candidates.map(row => row.id));
    const found = candidates.find(row => row.id === 'm23') ?? candidates[0];
    return { ok: true, cached: false, shadow: false, ms: 1, value: { ranked: [{ id: found.id, score: found.id === 'm23' ? .98 : .4 }], margin: .1 } };
  };
  assert.equal(await findSemanticMarginDuplicate(text, notes, rank, .93, { ask: async () => ({ ok: false, skipped: 'unavailable' }) }), 'm23');
  assert.deepEqual(seen, notes.map(note => note.id)); assert.ok(calls.length > 1); assert.ok(calls.every(chars => chars <= 1200));
});

test('margin comparison cancellation stops local chaining and ignores late judge matches', async () => {
  const controller = new AbortController();
  const notes = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, text: 'Independent durable lesson with enough detail to fill a candidate batch. '.repeat(4).slice(0, 240) }));
  let calls = 0, release;
  const pending = findSemanticMarginDuplicate(notes[0].text, notes, async () => { calls++; return new Promise(resolve => { release = resolve; }); }, .93, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, undefined); assert.equal(calls, 1);
  release({ ok: true, shadow: false, value: { ranked: [{ id: 'm0', score: .99 }] } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const next = new AbortController(); let judged;
  const judgeWork = findSemanticMarginDuplicate(notes[0].text, notes, undefined, .93, { signal: next.signal, ask: async () => new Promise(resolve => { judged = resolve; }) });
  next.abort(); assert.equal(await judgeWork, undefined);
  judged({ ok: true, answers: { duplicate_0: { noul: .99 } }, usage: { inputTokens: 1, cached: false } });
});


test('review grouping batches paraphrases, preserves file boundaries and avoids duplicate ranking work', async () => {
  let calls = 0, questionsSeen = 0;
  const findings = [
    { id: 'a', file: 'src/cache.ts', text: 'Obsolete callback overwrites the replacement session with its outdated value.' },
    { id: 'b', file: 'src/cache.ts', text: 'After switching contexts the earlier asynchronous response poisons fresh state.' },
    { id: 'c', file: 'src/cache.ts', text: 'An unbounded map retains every closed connection and exhausts memory.' },
    { id: 'd', file: 'src/other.ts', text: 'Obsolete callback overwrites the replacement session with its outdated value.' },
  ];
  const result = await consolidateFindings(findings, {
    ask: async (site, state, questions) => {
      calls++; assert.equal(site, 'finding-consolidation'); assert.ok(Object.values(questions).every(question => !question.instructions.includes('src/other.ts')));
      questionsSeen = Object.keys(questions).length;
      return { ok: true, answers: Object.fromEntries(Object.entries(questions).map(([key, value]) => [key, { noul: value.instructions.includes('"id":"a"') && value.instructions.includes('"id":"b"') ? .95 : .1 }])), usage: { inputTokens: 150, costUsd: .00001, cached: false } };
    }, sourceOf: id => id === 'a' ? 'correctness' : 'runtime',
  });
  assert.equal(calls, 1); assert.equal(questionsSeen, 3);
  assert.deepEqual(result.groups, [{ kept: 'a', merged: [{ id: 'b', method: 'jev' }], sources: ['correctness', 'runtime'] }]);
  assert.deepEqual(result.singletons, ['c', 'd']);
});

test('consolidation aborts one batch without publishing late duplicate judgments', async () => {
  const controller = new AbortController(); let release, offered;
  const pending = consolidateFindings([
    { id: 'a', file: 'src/owner.ts', text: 'Prior callbacks overwrite the replacement session.' },
    { id: 'b', file: 'src/owner.ts', text: 'A stale asynchronous response contaminates fresh state.' },
  ], { signal: controller.signal, ask: async (_site, _state, _questions, options) => { offered = options.signal; return new Promise(resolve => { release = resolve; }); } });
  for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.deepEqual((await pending).groups, []); assert.equal(offered.aborted, true);
  release({ ok: true, answers: { pair_0: { noul: .99 } }, usage: { inputTokens: 10, cached: false } });
});


test('similarity cannot erase opposite repairs, bridge file scopes or judge clipped evidence', async () => {
  let calls = 0;
  const a = { id: 'a', file: 'src/cache.ts', text: 'The callback writes the cache when the request is cancelled. Add a cancellation check before writing the cache.' };
  const b = { id: 'b', file: a.file, text: 'The callback does not write the cache when the request is not cancelled. Remove the cancellation check before writing the cache.' };
  const ask = async (_site, state, questions) => { calls++; assert.ok(Object.values(questions).some(question => question.instructions.includes(b.text))); return { ok: true, answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: .02 }])), usage: { inputTokens: 80, cached: false } }; };
  assert.deepEqual((await consolidateFindings([a,b], { ask })).groups, []);
  assert.equal(calls, 1, 'high lexical similarity requires a semantic decision');
  assert.deepEqual((await consolidateFindings([a,b])).groups, [], 'absence of a judge preserves distinct repair obligations');
  assert.deepEqual((await consolidateFindings([a, { ...a, id: 'bridge', file: undefined }, { ...a, id: 'other', file: 'src/other.ts' }])).groups, []);
  const full = 'Observed source evidence. '.repeat(30) + 'The final condition reverses the proposed repair.';
  await consolidateFindings([{ ...a, text: full }, { ...b, text: full + ' Different condition.' }], { ask: async (_site,state,questions) => {
    assert.ok(Object.values(questions).some(question => question.instructions.includes(full))); assert.ok(Object.values(questions).some(question => question.instructions.includes('Different condition.')));
    return { ok: true, answers: Object.fromEntries(Object.keys(questions).map(key => [key,{noul:.01}])),usage:{inputTokens:10,cached:false} };
  } });
});
