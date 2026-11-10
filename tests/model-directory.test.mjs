import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogRowFacts, directoryCovers, directoryFacts, directoryProvider, distillDirectory, parseDirectory, scopedDirectory,
} from '../agent/extensions/lib/model-directory.ts';

const RAW = {
  deepseek: { id: 'deepseek', api: 'https://api.deepseek.com', models: {
    'deepseek-flash': { name: 'DeepSeek Flash', reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_048_576, output: 393_216 }, cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
    'deepseek-embed': { name: 'Embed', reasoning: false, modalities: { input: ['text'], output: ['embedding'] }, limit: { context: 8192, output: 0 } },
  } },
  minimax: { api: 'https://api.minimax.io/anthropic/v1', models: { 'MiniMax-M3': { limit: { context: 1_048_576, output: 512_000 }, cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 } } } },
  'minimax-coding-plan': { api: 'https://api.minimax.io/v1', models: { 'MiniMax-M3': { limit: { context: 204_800, output: 131_072 } } } },
  cerebras: { models: { 'gpt-oss-120b': { limit: { context: 131_072, output: 40_960 }, cost: { input: 0.25, output: 0.69 } } } },
  togetherai: { models: { 'Org/Model-X': { limit: { context: 64_000, output: 80_000 } } } },
  'ollama-cloud': { api: 'https://ollama.com/v1', models: { 'glm-5': { reasoning: true, limit: { context: 200_000, output: 32_000 } } } },
  broken: { models: 'nope' },
  empty: { models: {} },
  'bad\u0000id': { models: { a: { limit: { context: 1, output: 1 } } } },
};

test('the directory is distilled to limits, capabilities and prices, and survives a round trip to disk', () => {
  const directory = distillDirectory(RAW, 1_800_000_000_000);
  assert.deepEqual(Object.keys(directory.providers).sort(), ['cerebras', 'deepseek', 'minimax', 'minimax-coding-plan', 'ollama-cloud', 'togetherai']);
  assert.deepEqual(directory.providers.deepseek.models['deepseek-flash'], {
    contextWindow: 1_048_576, maxTokens: 393_216, name: 'DeepSeek Flash', reasoning: true, input: ['text', 'image'],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
  });
  assert.equal(directory.providers.deepseek.models['deepseek-embed'].chat, false, 'a model that writes no text is marked');
  assert.equal(directory.providers.deepseek.models['deepseek-embed'].maxTokens, undefined, 'a zero limit is no limit');
  assert.equal(directory.providers.togetherai.models['Org/Model-X'].maxTokens, 64_000, 'output never exceeds context');
  assert.equal(directory.providers.cerebras.models['gpt-oss-120b'].cost.cacheRead, 0.25, 'no cache price means ordinary input price');
  assert.equal(JSON.stringify(parseDirectory(JSON.parse(JSON.stringify(directory)))), JSON.stringify(directory));
  const damaged = parseDirectory({ fetchedAt: 5, providers: { p: { url: 'javascript:alert(1)', models: { m: { contextWindow: 'huge', maxTokens: 4096, reasoning: 'yes', cost: { input: -1, output: 2 }, extra: 1 } } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(damaged)), { fetchedAt: 5, providers: { p: { models: { m: { maxTokens: 4096 } } } } }, 'a damaged file loses facts, it cannot plant them');
  assert.equal(parseDirectory({ providers: {} }), undefined);
  assert.equal(parseDirectory(null), undefined);
  assert.throws(() => distillDirectory([], 1), /keyed by provider/);
  assert.throws(() => distillDirectory({ a: { models: {} } }, 1), /no usable provider/);
});

test('a provider is matched by the host it is configured for, whatever it is called locally', () => {
  const directory = distillDirectory(RAW, 1);
  const at = (id, url) => directoryProvider(directory, id, url);
  assert.equal(at('my-ollama', 'https://ollama.com/v1'), directory.providers['ollama-cloud'], 'a custom name resolves by host');
  assert.equal(at('deepseek', 'https://api.deepseek.com/v1'), directory.providers.deepseek);
  assert.equal(at('deepseek', 'https://proxy.example/v1'), undefined, 'a proxy under a known name has its own limits and prices');
  assert.equal(at('cerebras', 'https://api.cerebras.ai/v1'), directory.providers.cerebras, 'an entry with no published URL is matched by id');
  assert.equal(at('together', 'https://api.together.xyz/v1'), directory.providers.togetherai, 'the one id that differs');
  assert.equal(at('minimax', 'https://api.minimax.io/anthropic'), directory.providers.minimax, 'same host, the local id decides');
  assert.equal(at('mm', 'https://api.minimax.io/anthropic'), directory.providers.minimax, 'same host, the nested path decides');
  assert.equal(at('mm', 'https://api.minimax.io/v1'), directory.providers['minimax-coding-plan']);
  assert.equal(at('unknown', 'https://nowhere.example/v1'), undefined);
  assert.equal(at('constructor', undefined), undefined);
  assert.equal(directoryProvider(undefined, 'deepseek', 'https://api.deepseek.com'), undefined);
  assert.equal(at('deepseek', 'not a url'), directory.providers.deepseek, 'with no usable URL the id is all there is');
});

test('the saved copy keeps only the configured providers and knows which addresses it was cut for', () => {
  const full = distillDirectory(RAW, 7);
  const wanted = [['my-ollama', 'https://ollama.com/v1'], ['deepseek', 'https://api.deepseek.com/v1'], ['acme', 'https://acme.example/v1'], ['mm', 'https://api.minimax.io/v1']];
  const cut = scopedDirectory(full, wanted);
  assert.deepEqual(Object.keys(cut.providers).sort(), ['deepseek', 'minimax-coding-plan', 'ollama-cloud']);
  const restored = parseDirectory(JSON.parse(JSON.stringify(cut)));
  for (const [id, url] of wanted) assert.equal(JSON.stringify(directoryProvider(restored, id, url)), JSON.stringify(directoryProvider(full, id, url)), `${id} resolves as it did in the full copy`);
  assert.equal(directoryCovers(restored, wanted), true);
  assert.equal(directoryCovers(restored, [...wanted, ['new-one', 'https://new.example/v1']]), false, 'a provider configured later is not covered');
  assert.equal(directoryCovers(restored, [['deepseek', 'https://elsewhere.example/v1']]), false, 'nor is a changed address');
  assert.equal(directoryCovers(full, [['anything', undefined]]), true, 'an uncut copy covers everything');
  const none = parseDirectory(JSON.parse(JSON.stringify(scopedDirectory(full, [['acme', 'https://acme.example/v1']]))));
  assert.deepEqual(Object.keys(none.providers), [], 'a copy with no match is still a valid, fresh answer');
});

test('model facts come only from the matched provider; ids compare without case', () => {
  const directory = distillDirectory(RAW, 1);
  const together = directoryProvider(directory, 'together', 'https://api.together.xyz/v1');
  assert.equal(directoryFacts(together, 'org/model-x').contextWindow, 64_000);
  assert.equal(directoryFacts(together, 'deepseek-flash'), undefined, 'another provider\'s entry is not borrowed');
  assert.equal(directoryFacts(undefined, 'deepseek-flash'), undefined);
  assert.equal(directoryFacts(together, 'hasOwnProperty'), undefined);
});

test('a /models row contributes exactly what it states', () => {
  assert.deepEqual(catalogRowFacts({ id: 'plain' }), {}, 'the standard row states nothing');
  assert.deepEqual(catalogRowFacts({ id: 'a', context_length: 200_000, max_completion_tokens: 32_000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], pricing: { prompt: '0.000001', completion: '0.000002' }, name: ' Model A ' }), {
    contextWindow: 200_000, maxTokens: 32_000, name: 'Model A', input: ['text', 'image'], reasoning: true,
    cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
  });
  assert.deepEqual(catalogRowFacts({ id: 'b', metadata: { context_length: 65_536, max_tokens: 100_000, pricing: { input_tokens: 0.5, output_tokens: 1.5 } } }), {
    contextWindow: 65_536, maxTokens: 65_536, cost: { input: 0.5, output: 1.5, cacheRead: 0.5, cacheWrite: 0.5 },
  });
  assert.equal(catalogRowFacts({ id: 'c', type: 'embedding' }).chat, false);
  assert.equal(catalogRowFacts({ id: 'd', architecture: { output_modalities: ['image'] } }).chat, false);
  assert.equal(catalogRowFacts({ id: 'e', type: 'chat' }).chat, undefined);
  assert.deepEqual(catalogRowFacts({ id: 'f', capabilities: { vision: false, reasoning: true }, context_window: -5, pricing: { prompt: 'free' } }), { input: ['text'], reasoning: true });
  assert.deepEqual(catalogRowFacts('nope'), {});
});

test('several entries on one host: the longest shared path decides, and a host with no clear match gives none', () => {
  const directory = distillDirectory({
    alpha: { api: 'https://gateway.example/v1', models: { m: { limit: { context: 1000, output: 100 } } } },
    zeta: { api: 'https://gateway.example/v1/beta', models: { m: { limit: { context: 2000, output: 200 } } } },
    twin: { api: 'https://tied.example/v1', models: { m: { limit: { context: 3000, output: 300 } } } },
    twin2: { api: 'https://tied.example/v1', models: { m: { limit: { context: 4000, output: 400 } } } },
    solo: { api: 'https://single.example/other', models: { m: { limit: { context: 5000, output: 500 } } } },
  }, 1);
  const at = (id, url) => directoryProvider(directory, id, url);
  assert.equal(at('mystery', 'https://gateway.example/v1/beta/chat'), directory.providers.zeta, 'the longer shared path beats the alphabetically first entry');
  assert.equal(at('mystery', 'https://gateway.example/v1/other'), directory.providers.alpha, 'a single nested entry matches');
  assert.equal(at('mystery', 'https://gateway.example/v2/x'), undefined, 'no path in common with several entries is no match');
  assert.equal(at('mystery', 'https://tied.example/v1'), undefined, 'two entries with the same path are no match');
  assert.equal(at('mystery', 'https://single.example/v1'), directory.providers.solo, 'a lone entry on the host still matches as before');
});

test('the saved scope keeps no userinfo, query or fragment from a base URL', () => {
  const full = distillDirectory(RAW, 7);
  const withCredentials = new URL('https://api.deepseek.com/v1');
  Object.assign(withCredentials, { username: 'synthetic-user', password: 'synthetic-pass', search: '?token=synthetic-token', hash: 'synthetic-fragment' });
  const secretive = [['deepseek', withCredentials.href], ['cerebras', 'https://api.cerebras.ai/v1']];
  const cut = scopedDirectory(full, secretive);
  const saved = JSON.stringify(cut);
  for (const word of ['synthetic-user', 'synthetic-pass', 'synthetic-token', 'synthetic-fragment', '?', '#']) assert.equal(saved.includes(word), false, `${word} is not saved`);
  assert.deepEqual(cut.scope, ['cerebras https://api.cerebras.ai/v1', 'deepseek https://api.deepseek.com/v1']);
  const restored = parseDirectory(JSON.parse(saved));
  assert.equal(directoryCovers(restored, [['deepseek', 'https://api.deepseek.com/v1'], ['cerebras', 'https://api.cerebras.ai/v1/']]), true, 'the same origin and path still fit');
  const otherPath = new URL('https://api.deepseek.com/v2');
  Object.assign(otherPath, { username: 'synthetic-other', password: 'synthetic-other-pass' });
  assert.equal(directoryCovers(restored, [['deepseek', otherPath.href]]), false, 'a different path is not covered, whatever the credentials');
});
