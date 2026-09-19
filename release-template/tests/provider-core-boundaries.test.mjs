import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { retryProviderRequest } from '../core/ai/src/utils/provider-retry.js';
import { retryAssistantCall } from '../core/ai/src/utils/retry.js';
import { calculateContextTokens } from '../core/ai/src/utils/estimate.js';
import { clampMaxTokensToContext } from '../core/ai/src/api/simple-options.js';

const failed = () => ({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'network error' });
const policy = { enabled: true, maxRetries: 1, baseDelayMs: 1 };

test('provider retry never starts a request after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(retryProviderRequest(async () => { calls++; return 'unexpected'; }, {
    signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('provider retry preserves transient success and cancellation during backoff', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const request = retryProviderRequest(async () => {
      if (++calls === 2) return 'recovered';
      if (cancel) setImmediate(() => controller.abort());
      throw Object.assign(new Error('temporary outage'), {
        status: 503, headers: new Headers({ 'retry-after-ms': cancel ? '1000' : '1' }),
      });
    }, { maxRetries: 1, signal: controller.signal });
    if (cancel) await assert.rejects(request, { name: 'AbortError' });
    else assert.equal(await request, 'recovered');
    assert.equal(calls, cancel ? 1 : 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('assistant retry releases completed backoff abort listeners', async () => {
  const controller = new AbortController();
  for (const succeed of [false, true]) {
    let calls = 0;
    const result = await retryAssistantCall(async () => ++calls === 2 && succeed
      ? { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }
      : failed(), policy, controller.signal);
    assert.equal(result.stopReason, succeed ? 'stop' : 'error');
    assert.equal(calls, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('assistant retry cancellation during attempt callback prevents another provider call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const finished = [];
  const result = await retryAssistantCall(async () => { calls++; return failed(); }, policy, controller.signal, {
    onRetryAttemptStart: async () => { await Promise.resolve(); controller.abort(); },
    onRetryFinished: (...args) => finished.push(args),
  });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.errorMessage, undefined);
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('assistant retry reports a failing attempt callback exactly once', async () => {
  const controller = new AbortController();
  const callbackError = new Error('retry observer failed');
  let calls = 0;
  const finished = [];
  await assert.rejects(retryAssistantCall(async () => { calls++; return failed(); }, policy, controller.signal, {
    onRetryAttemptStart: () => { throw callbackError; },
    onRetryFinished: (...args) => finished.push(args),
  }), error => error === callbackError);
  assert.equal(calls, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('AI output budgets use valid usage components when provider totals are malformed', () => {
  for (const totalTokens of [NaN, Infinity, -1, 0, '30001', undefined]) {
    const usage = { input: 30000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens };
    assert.equal(calculateContextTokens(usage), 30001);
    const context = { messages: [{ role: 'assistant', timestamp: 1, stopReason: 'stop',
      content: [{ type: 'text', text: 'done' }], usage }] };
    assert.throws(() => clampMaxTokensToContext({ contextWindow: 32768, maxTokens: 8192 }, context, 8192),
      /Context length exceeded/);
  }
  assert.equal(calculateContextTokens({ input: 12, output: NaN, cacheRead: -1, cacheWrite: Infinity }), 12);
  assert.equal(calculateContextTokens({ totalTokens: 99, input: 12 }), 99);
});
