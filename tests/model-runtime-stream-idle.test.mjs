import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '../core/coding-agent/src/core/model-runtime.js';
import { InMemoryCodingAgentModelsStore } from '../core/coding-agent/src/core/models-store.js';
import { InMemoryCredentialStore } from '../core/ai/src/auth/credential-store.js';
import { AssistantMessageEventStream } from '../core/ai/src/utils/event-stream.js';

// The main agent reaches providers through ModelRuntime, not ModelsImpl, so its
// streams must carry the same idle budget. Repro: a provider emits a start
// event plus a fragment of thinking, then goes silent — observed as a 14-minute
// turn with 218 chars of thinking, no error and no retry until the user aborted.
const model = { provider: 'synthetic-idle', id: 'synthetic-idle-1', api: 'openai-completions', maxTokens: 4096 };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'model-runtime-idle-'));
test.after(() => fs.rm(temporary, { recursive: true, force: true }));

function partialMessage(thinking) {
  return {
    role: 'assistant',
    content: thinking === undefined ? [] : [{ type: 'thinking', thinking }],
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
}

function hangingProvider() {
  const factory = () => {
    const stream = new AssistantMessageEventStream();
    const partial = partialMessage('partial');
    stream.push({ type: 'start', partial });
    stream.push({ type: 'thinking_delta', delta: 'partial', partial });
    return stream; // never completes: the observed stall shape
  };
  return { stream: factory, streamSimple: factory };
}

function healthyProvider() {
  const factory = () => {
    const stream = new AssistantMessageEventStream();
    const partial = partialMessage(undefined);
    stream.push({ type: 'start', partial });
    const done = { ...partialMessage(undefined), content: [{ type: 'text', text: 'Synthetic answer.' }], stopReason: 'stop' };
    stream.push({ type: 'done', reason: 'stop', message: done });
    return stream;
  };
  return { stream: factory, streamSimple: factory };
}

async function runtimeWith(provider) {
  const configPath = path.join(temporary, `models-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(configPath, JSON.stringify({ providers: {} }));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: configPath,
    modelsStore: new InMemoryCodingAgentModelsStore(),
    allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined);
  runtime.prepareRequest = async (selected, options) => ({ provider, model: selected, options });
  return runtime;
}

async function resultWithin(stream, ms) {
  let timer;
  try {
    return await Promise.race([
      stream.result(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`stream did not settle within ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const method of ['stream', 'streamSimple']) {
  test(`ModelRuntime.${method} surfaces a stalled provider stream as an idle error`, async () => {
    const runtime = await runtimeWith(hangingProvider());
    const started = Date.now();
    const message = await resultWithin(runtime[method](model, { messages: [] }, { timeoutMs: 120 }), 10000);
    assert.equal(message.stopReason, 'error');
    assert.match(message.errorMessage ?? '', /idle timeout after 120ms/);
    assert.ok(Date.now() - started < 10000, 'idle budget bounds the stall instead of hanging the turn');
  });

  test(`ModelRuntime.${method} still completes a healthy provider stream`, async () => {
    const runtime = await runtimeWith(healthyProvider());
    const message = await resultWithin(runtime[method](model, { messages: [] }, { timeoutMs: 5000 }), 10000);
    assert.equal(message.stopReason, 'stop');
  });
}
