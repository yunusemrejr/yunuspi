// Adversarial synthetic session evidence. Inference transport is mocked;
// eligibility, source selection, protection and accounting are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/mini-preprocessor.ts')));
const load = rel => import(pathToFileURL(path.join(agent, 'extensions', rel)));
const mini = await load('lib/mini-preprocessor.ts');
const jev = await load('lib/jev-client.ts');
const intent = await load('lib/micro-intelligence/intent.ts');
const advisory = await load('lib/micro-intelligence/advisory.ts');
const metrics = await load('lib/micro-intelligence/metrics.ts');
const usage = { model: 'mock', inputTokens: 10, costUsd: 0, ms: 1, cached: false };
const chunks = labels => labels.map(label => `${label} ${'background '.repeat(125)}`).join('\n');
const rejectMiddle = async () => ({ ok: true, answers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`chunk_${i}`, { type: 'noul', noul: 0 }])), usage });

test('Jev cannot discard protected middle facts even with a low keep judgment', async () => {
  const text = chunks(['HEAD', 'ordinary prose', 'Deployment remains blocked until tests pass.', 'irrelevant prose', 'TAIL']);
  const selected = await jev.selectDistillChunks('read', text, rejectMiddle);
  assert.ok(selected);
  assert.ok(selected.includes('Deployment remains blocked until tests pass.'));
  assert.ok(!selected.includes('irrelevant prose'));
});

test('Jev abstains on missing or malformed judgments and oversized sources without paying', async () => {
  const text = chunks(['HEAD', 'ordinary prose', 'unrelated prose', 'TAIL']);
  for (const value of [undefined, -1, 2, NaN, '0']) {
    assert.equal(await jev.selectDistillChunks('read', text, async () => ({ ok: true, answers: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`chunk_${i}`, { type: 'noul', noul: value }])), usage })), undefined);
  }
  let calls = 0;
  assert.equal(await jev.selectDistillChunks('read', chunks(Array(16).fill('ordinary prose')), async () => { calls++; return rejectMiddle(); }), undefined);
  assert.equal(calls, 0);
});

test('a read-only prefix cannot rescue a mutation requested after the embedding limit', async () => {
  const task = `${'Read and explain the implementation. '.repeat(40)}Then modify the implementation to fix the bug.`;
  const classify = async () => ({ ok: true, shadow: false, cached: false, ms: 1, value: { label: 'read-only', score: 0.999, margin: 0.1, accepted: true } });
  let seen;
  const result = await intent.cheapMutationScreen(task, { classify, ask: async (_site, state) => { seen = state.task; return { ok: false, skipped: 'unavailable' }; } });
  assert.equal(seen, task, 'Jev sees the entire bounded task, including the mutation suffix');
  assert.equal(result, 'defer');
});

test('soft-wrapped prose retains exact paragraphs through mini selection', async () => {
  const filler = 'General background prose describes an ordinary workspace with assorted familiar concepts\nand broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.';
  const raw = ['Deployment remains blocked until verification.', ...Array(9).fill(filler)].join('\n\n');
  const source = mini.miniSource(raw);
  assert.ok(source);
  const helper = mini.createMiniPreprocessor({ runtime: { version: 1, enabled: true, endpoint: 'http://127.0.0.1:18736/select', apiKey: 'TEST_MINI_PREPROCESSOR_KEY_1234567890' }, fetch: async () => new Response(JSON.stringify({ version: 1, status: 'SELECT', sourceHash: source.hash, keep: [0] })) });
  const selection = await helper.select(raw, undefined);
  assert.ok(selection);
  assert.ok(mini.miniProjection(raw, selection).includes('blocked until verification'));
  assert.equal(helper.inspect().requests, 1);
});
