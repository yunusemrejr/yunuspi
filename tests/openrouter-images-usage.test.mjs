import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImages } from '../core/ai/src/api/openrouter-images.js';
const model = { id: 'fixture-image', provider: 'openrouter', api: 'openrouter-images', baseUrl: 'https://openrouter.ai/api/v1', input: ['text'], output: ['image'], cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1.25 } };
const valid = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } };
async function generate(rawUsage, overrides = {}) {
  let requests = 0;
  const result = await generateImages({ ...model, ...overrides }, { input: [{ type: 'text', text: 'fixture' }] }, {
    apiKey: 'TEST_fixture-only', maxRetries: 0,
    fetch: async () => { requests++; return new Response('{"id":"fixture","choices":[{"message":{"role":"assistant","content":""},"finish_reason":"stop"}],"usage":' + (typeof rawUsage === 'string' ? rawUsage : JSON.stringify(rawUsage)) + '}', { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests, 1, 'accounting never makes extra model or billing requests');
  return result.usage;
}
function bounded(usage, prompt, output) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) assert.ok(Number.isSafeInteger(usage[key]) && usage[key] >= 0, key);
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite, prompt);
  assert.equal(usage.totalTokens, prompt + output);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) assert.ok(Number.isFinite(usage.cost[key]) && usage.cost[key] >= 0, key);
}
test('native image usage preserves independent cache buckets and shared cost evidence', async () => {
  const usage = await generate(valid);
  assert.deepEqual([usage.input, usage.cacheRead, usage.cacheWrite], [10, 80, 10]);
  bounded(usage, 100, 1);
  assert.ok(Math.abs(usage.cost.total - .0000325) < 1e-12);
  assert.equal(usage.cost.source, 'estimate');
  assert.equal(usage.cost.complete, true);
  assert.equal(usage.cacheReadReported, true);
  assert.equal(usage.cost.provider, model.provider);
  assert.equal(usage.cost.model, model.id);
});
test('malformed image counters never coerce strings or emit negative/nonfinite totals', async () => {
  for (const value of ['80', -5, 1.5, null]) {
    const usage = await generate({ ...valid, prompt_tokens_details: { cached_tokens: value, cache_write_tokens: 10 } });
    bounded(usage, 100, 1);
    assert.deepEqual([usage.input, usage.cacheRead, usage.cacheWrite], [90, 0, 10]);
    assert.equal(usage.cacheReadReported, false);
    assert.equal(usage.cost.complete, false);
    const badWrite = await generate({ ...valid, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: value } });
    bounded(badWrite, 100, 1);
    assert.deepEqual([badWrite.input, badWrite.cacheRead, badWrite.cacheWrite], [20, 80, 0]);
    assert.equal(badWrite.cost.complete, false);
  }
  const nonfinite = await generate('{"prompt_tokens":1e309,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":1e309,"cache_write_tokens":-1}}');
  bounded(nonfinite, 0, 1);
  assert.equal(nonfinite.cost.complete, false);
  const missing = await generate({ completion_tokens: 1 });
  bounded(missing, 0, 1);
  assert.equal(missing.cost.complete, false);
  const badOutput = await generate({ prompt_tokens: 100, completion_tokens: '1' });
  bounded(badOutput, 100, 0);
  assert.equal(badOutput.cost.complete, false);
});
test('inconsistent cache counts are bounded by prompt tokens and remain partial estimates', async () => {
  for (const [reads, writes, expected] of [[80, 40, [0, 80, 20]], [120, 10, [0, 100, 0]]]) {
    const usage = await generate({ ...valid, prompt_tokens_details: { cached_tokens: reads, cache_write_tokens: writes } });
    assert.deepEqual([usage.input, usage.cacheRead, usage.cacheWrite], expected);
    bounded(usage, 100, 1);
    assert.equal(usage.cost.complete, false);
  }
  const overflow = await generate({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 10 });
  bounded(overflow, Number.MAX_SAFE_INTEGER, 0);
  assert.equal(overflow.cost.complete, false);
});
test('official returned charges including zero take precedence without adding upstream cost', async () => {
  for (const cost of [.0042, 0]) {
    const usage = await generate({ ...valid, cost, cost_details: { upstream_inference_cost: .02 }, is_byok: true });
    assert.equal(usage.cost.total, cost);
    assert.equal(usage.cost.source, 'provider-reported');
    assert.equal(usage.cost.complete, true);
    assert.ok(Math.abs(usage.cost.estimatedTotal - .0000325) < 1e-12);
    assert.equal(usage.cost.upstreamInferenceCost, .02);
    assert.equal(usage.cost.byok, true);
  }
  for (const overrides of [{ provider: 'gateway' }, { baseUrl: 'https://proxy.invalid/v1' }, { baseUrl: 'http://openrouter.ai/api/v1' }]) {
    const usage = await generate({ ...valid, cost: .0042 }, overrides);
    assert.equal(usage.cost.source, 'estimate');
    assert.ok(Math.abs(usage.cost.total - .0000325) < 1e-12);
  }
});
test('image estimates reuse context tiers and partial/missing rate semantics', async () => {
  const tiered = await generate(valid, { cost: { ...model.cost, tiers: [{ inputTokensAbove: 50, input: 2, output: 4, cacheRead: .2, cacheWrite: 2.5 }] } });
  assert.ok(Math.abs(tiered.cost.total - .000065) < 1e-12);
  assert.equal(tiered.cost.inputTokensAbove, 50);
  assert.equal(tiered.cost.complete, true);
  const partial = await generate(valid, { cost: { input: 1, output: 2, cacheRead: .1 } });
  bounded(partial, 100, 1);
  assert.equal(partial.cost.complete, false);
  assert.equal(partial.cost.cacheWrite, 0);
  const unknown = await generate(valid, { cost: undefined });
  bounded(unknown, 100, 1);
  assert.equal(unknown.cost.complete, false);
});
