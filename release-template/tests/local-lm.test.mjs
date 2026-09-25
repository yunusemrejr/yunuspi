// The shared local language model (Qwen3.5-0.8B on llama.cpp) replaces the
// SmolLM2 selector. These tests drive the client with synthetic responses;
// no model runs and nothing listens on the loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/local-lm.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const L = await load('extensions/lib/local-lm.ts');
const assets = await load('extensions/lib/local-lm-assets.mjs');
const { cheapMutationScreen } = await load('extensions/lib/micro-intelligence/intent.ts');
const { createRelevantGuidance } = await load('extensions/lib/relevant-guidance.ts');

const runtime = { version: 2, enabled: true, model: 'Qwen3.5-0.8B', endpoint: 'http://127.0.0.1:18735/completion', apiKey: 'TEST_LOCAL_KEY_1234567890', execution: 'background', timeoutMs: 2000 };
const probs = (yes, no) => new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: [{ token: ' yes', logprob: Math.log(yes) }, { token: ' no', logprob: Math.log(no) }] }] }));

test('the runtime descriptor names only the pinned model and loopback endpoint', () => {
  assert.equal(L.validLocalLmRuntime(runtime), true);
  for (const patch of [{ model: 'SmolLM2-135M-Instruct' }, { endpoint: 'http://127.0.0.1:18799/completion' }, { timeoutMs: 9000 }, { apiKey: 'bad-synthetic' }]) assert.equal(L.validLocalLmRuntime({ ...runtime, ...patch }), false, JSON.stringify(patch));
});

test('judgements return a calibrated P(yes) from the first token and report each inference', async () => {
  const seen = [], key = Symbol.for('yunus-pi.health.v1'), prior = globalThis[key];
  globalThis[key] = (kind, data) => seen.push([kind, data]);
  try {
    let body;
    const lm = L.createLocalLm({ runtime, fetch: async (_url, init) => { body = JSON.parse(init.body); return probs(0.3, 0.1); } });
    const result = await lm.judge('Question?\nAnswer:', 'unit');
    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.p - 0.75) < 1e-9);
    assert.equal(body.n_predict, 1); assert.equal(body.n_probs, 10); assert.equal(body.cache_prompt, true);
    assert.ok(seen.some(([kind, data]) => kind === 'ml.local.inference' && data.decision === 'answered' && data.purpose === 'unit'));
  } finally { if (prior === undefined) delete globalThis[key]; else globalThis[key] = prior; }
});

test('a constant few-shot prefix is processed once and again only after the server loses it', async () => {
  const prefix = `Unique few-shot examples ${Date.now()} ${'example '.repeat(12)}\n`;
  const bodies = [];
  let reused = 40;
  const lm = L.createLocalLm({ runtime, fetch: async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.n_predict === 0) return new Response(JSON.stringify({ tokens_evaluated: 40 }));
    const response = JSON.parse(await probs(0.8, 0.2).text());
    return new Response(JSON.stringify({ ...response, timings: { cache_n: reused } }));
  } });
  for (const task of ['a', 'b']) assert.equal((await lm.judge(`${prefix}Task: ${task}\nAnswer:`, 'unit', { prefix })).ok, true);
  assert.deepEqual(bodies.map(body => body.n_predict), [0, 1, 1], 'warmed once, then reused');
  assert.equal(bodies[0].prompt, prefix);
  reused = 0;
  await lm.judge(`${prefix}Task: c\nAnswer:`, 'unit', { prefix });
  await lm.judge(`${prefix}Task: d\nAnswer:`, 'unit', { prefix });
  assert.deepEqual(bodies.slice(3).map(body => body.n_predict), [1, 0, 1], 'a lost checkpoint is warmed again');
  bodies.length = 0;
  await lm.judge('Short unrelated prompt\nAnswer:', 'unit', { prefix });
  assert.deepEqual(bodies.map(body => body.n_predict), [1], 'a prompt without the prefix is never warmed');
});

test('one inference runs at a time, bursts beyond the queue are refused and repeated failures pause use', async () => {
  let active = 0, peak = 0;
  const slow = L.createLocalLm({ runtime, queueLimit: 2, fetch: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return probs(0.5, 0.5); } });
  const results = await Promise.all(Array.from({ length: 5 }, () => slow.judge('q', 'burst')));
  assert.equal(peak, 1);
  assert.ok(results.some(r => !r.ok && r.reason === 'busy'));
  let now = 0;
  const failing = L.createLocalLm({ runtime, now: () => now, fetch: async () => { throw new Error('connection refused'); } });
  for (let i = 0; i < 3; i++) assert.equal((await failing.judge('q', 'x')).reason, 'failed');
  assert.equal((await failing.judge('q', 'x')).reason, 'paused');
  now = 61_000;
  assert.equal((await failing.judge('q', 'x')).reason, 'failed', 'the pause ends after a minute');
  assert.equal((await L.createLocalLm({ runtime: undefined, fetch: async () => probs(1, 0) }).judge('q', 'x')).ok, false);
});

test('the relevance prompt is few-shot, bounded and ends where the answer begins', () => {
  const prompt = L.skillRelevancePrompt('Build a music blog in PHP.\u0007 '.repeat(100), { name: 'all-about-odoo', description: 'Odoo ERP reference' });
  assert.match(prompt, /Helps: no\n/);
  assert.ok(prompt.endsWith('Helps:'));
  assert.ok(!prompt.includes('\u0007'));
  assert.ok(prompt.length < 2200);
});

function guidance() {
  const hooks = new Map(), entries = [];
  const g = createRelevantGuidance({ on: (name, fn) => hooks.set(name, fn), getActiveTools: () => ['read', 'skill_review'], registerTool() {}, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
  const ctx = { cwd: '/fixture/project', sessionManager: { getBranch: () => entries } };
  const names = ['music-theory', 'ledger-inventory', 'orbital-mechanics', 'stellar-navigation', 'tax-filing', 'garden-planning', 'kernel-tuning', 'poetry-meter'];
  const catalog = `<available_skills>${names.map(name => `<skill><name>${name}</name><description>Applicable workflow</description><location>/fixture/skills/${name}/SKILL.md</location></skill>`).join('')}</available_skills>`;
  g.restore(ctx);
  return { g, start: prompt => { g.userInput(); g.start({ prompt, systemPrompt: catalog }, ctx); } };
}

test('session-context skill hints pass through the local judge: off-topic matches are filtered, relevant ones delivered', async () => {
  const prior = process.env.PI_SKILL_REVIEW; process.env.PI_SKILL_REVIEW = 'advisory';
  const offeredWith = async (yes) => {
    const asked = [];
    L.resetLocalLmForTests(L.createLocalLm({ runtime, fetch: async (_url, init) => { asked.push(JSON.parse(init.body).prompt); return yes ? probs(0.9, 0.1) : probs(0.1, 0.9); } }));
    const f = guidance();
    f.start('Review music theory and ledger inventory notes');
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise(r => setTimeout(r, 2));
    await new Promise(r => setTimeout(r, 10));
    const offers = [];
    for (let i = 0; i < 3; i++) { const hints = f.g.candidates(); offers.push(...hints.filter(h => h.skill).map(h => h.skill)); f.g.commit(hints); }
    return { asked, offers };
  };
  try {
    const filtered = await offeredWith(false);
    assert.ok(filtered.asked.length >= 1, 'the local judge was consulted');
    assert.ok(filtered.asked.some(prompt => /Skill ledger-inventory: Applicable workflow\nHelps:$/.test(prompt)));
    assert.ok(!filtered.offers.some(file => file.includes('ledger-inventory')), 'an off-topic hint is not delivered');
    const kept = await offeredWith(true);
    assert.ok(kept.offers.some(file => file.includes('ledger-inventory')), 'a relevant hint is delivered after judgement');
  } finally {
    L.resetLocalLmForTests(undefined);
    if (prior === undefined) delete process.env.PI_SKILL_REVIEW; else process.env.PI_SKILL_REVIEW = prior;
  }
});

test('the mutation pre-screen lets the local model decide only the fail-safe direction', async () => {
  const unavailable = async () => ({ ok: false, skipped: 'unavailable' });
  const classify = async () => ({ ok: false, reason: 'unavailable' });
  let asked = 0;
  const ask = async () => { asked++; return { ok: false, skipped: 'unavailable' }; };
  assert.equal(await cheapMutationScreen('Add input validation to the signup form please', { classify, ask, judge: async () => ({ ok: true, p: 0.62 }) }), 'implementation');
  assert.equal(asked, 0, 'no paid judge was needed');
  assert.equal(await cheapMutationScreen('Explain how the cache invalidation works here', { classify, ask, judge: async () => ({ ok: true, p: 0.02 }) }), 'defer', 'a low score never rescues read-only by itself');
  assert.equal(asked, 1);
  assert.equal(await cheapMutationScreen('Explain how the cache invalidation works here', { classify, ask: unavailable, judge: async () => ({ ok: false }) }), 'defer');
});

test('asset verification reports what is missing without touching the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-lm-assets-'));
  try {
    const result = await assets.verifyLocalLm(dir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(p => /Qwen3\.5-0\.8B-Q4_0\.gguf missing/.test(p)));
    assert.ok(assets.LOCAL_LM_PINNED_FILES.every(file => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0 && /^https:\/\//.test(file.url)));
    assert.match(assets.LOCAL_LM_PINNED_FILES[1].url, /resolve\/[0-9a-f]{40}\//, 'the model is pinned to an immutable revision');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
