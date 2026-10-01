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

test('identical queued judgments share inference, expire, and retain caller cancellation',async()=>{
  let calls=0,now=0,finish,started;
  const entering=new Promise(resolve=>{started=resolve;});
  const lm=L.createLocalLm({runtime,now:()=>now,fetch:async()=>{
    calls++;started();await new Promise(resolve=>{finish=resolve;});return probs(.9,.1);
  }});
  const first=lm.judge('A stable relevance question','skill');await entering;
  const queued=lm.judge('A stable relevance question','tool');
  const controller=new AbortController();
  const cancelled=lm.judge('A stable relevance question','cancelled',{signal:controller.signal});controller.abort();
  finish();const [a,b,c]=await Promise.all([first,queued,cancelled]);
  assert.equal(calls,1);assert.equal(a.cached,false);assert.equal(b.cached,true);assert.equal(a.p,b.p);
  assert.equal(c.reason,'cancelled');
  assert.equal((await lm.judge('A stable relevance question','review')).cached,true);assert.equal(calls,1);
  now=300000;
  const expired=lm.judge('A stable relevance question','skill');
  for(let i=0;i<20&&calls<2;i++)await new Promise(resolve=>setTimeout(resolve,0));
  finish();assert.equal((await expired).cached,false);assert.equal(calls,2);
});

test('a cached judgment respects cancellation during runtime readiness',async()=>{
  let calls=0;
  const lm=L.createLocalLm({runtime,fetch:async()=>{calls++;return probs(.9,.1);}});
  assert.equal((await lm.judge('Stable question','unit')).ok,true);
  const controller=new AbortController();
  const pending=lm.judge('Stable question','unit',{signal:controller.signal});
  controller.abort();
  assert.equal((await pending).reason,'cancelled');assert.equal(calls,1);
  assert.equal(lm.stats().cached,0,'cancelled callers do not consume cached evidence');
});

test('prefix checkpoints are scoped to the actual transport, not shared globally by text',async()=>{
  const prefix='Shared examples for two separate servers. '.repeat(4)+'\n';
  const recorded=[];
  for(let transport=0;transport<2;transport++){
    const lm=L.createLocalLm({runtime,fetch:async(_url,init)=>{
      const body=JSON.parse(init.body);recorded.push([transport,body.n_predict]);
      if(body.n_predict===0)return new Response(JSON.stringify({tokens_evaluated:40}));
      return probs(.9,.1);
    }});
    await lm.judge(prefix+'Question: one','unit',{prefix});
    await lm.judge(prefix+'Question: two','unit',{prefix});
  }
  assert.deepEqual(recorded,[[0,0],[0,1],[0,1],[1,0],[1,1],[1,1]]);
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

test('local service retains prefix reuse inside its process memory budget',()=>{
  const unit=assets.localLmServiceUnit('/fixture/model');
  const args=unit.split('\n').find(line=>line.startsWith('ExecStart=')).split(' ');
  const value=flag=>Number(args[args.indexOf(flag)+1]);
  assert.ok(value('--cache-ram')>0 && value('--cache-ram')<=256,'cache remains enabled and bounded');
  assert.ok(value('--ctx-checkpoints')>0 && value('--ctx-checkpoints')<=4,'recurrent checkpoints remain enabled and bounded');
  assert.equal(value('--checkpoint-min-step'),0,'short reusable prefixes remain supported');
  assert.equal(value('--ctx-size'),4096);
  assert.match(unit,/^MemoryMax=2G$/m);
});

const choiceCandidates = [{ id: 'read', text: 'Read file contents' }, { id: 'browser', text: 'Browse websites and take screenshots' }, { id: 'sql', text: 'Run database queries' }];
const choiceResponse = (pairs) => new Response(JSON.stringify({ tokens_evaluated: 100, completion_probabilities: [{ top_probs: pairs.map(([token, prob]) => ({ token, prob })) }] }));

test('choices use the configured shared deadline instead of a shorter hidden timeout', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const prev=process.env.PI_LOCAL_LM;delete process.env.PI_LOCAL_LM;
  let entered,resolveResponse,requestSignal;
  const started=new Promise(resolve=>{entered=resolve;});
  const lm=L.createLocalLm({runtime:{...runtime,timeoutMs:5000},fetch:async(_url,init)=>{
    if(JSON.parse(init.body).n_predict===0)return new Response('{}');
    requestSignal=init.signal;entered();return new Promise(resolve=>{resolveResponse=resolve;});
  }});
  try{
    const result=lm.choose('Capture a screenshot of the website',choiceCandidates,'configured-deadline');
    await started;t.mock.timers.tick(2600);
    assert.equal(requestSignal.aborted,false,'the configured five-second budget still has time');
    resolveResponse(choiceResponse([[' B',.95],[' A',.03]]));
    assert.equal((await result).id,'browser');
  }finally{if(prev===undefined)delete process.env.PI_LOCAL_LM;else process.env.PI_LOCAL_LM=prev;t.mock.timers.reset();}
});

test('local choice accepts only confident exact option tokens and memoizes bounded decisions', async () => {
  const prev = process.env.PI_LOCAL_LM; delete process.env.PI_LOCAL_LM;
  try {
    let calls = 0, now = 0;
    const lm = L.createLocalLm({ runtime, now: () => now, fetch: async (_url, { body }) => { if (JSON.parse(body).n_predict === 0) return new Response('{}'); calls++; return choiceResponse([[' B', .93], [' A', .03], [' N', .02]]); } });
    const task = 'Take a screenshot of this website';
    assert.equal((await lm.choose(task, choiceCandidates, 'tool-discover')).id, 'browser');
    assert.equal((await lm.choose(task, choiceCandidates, 'tool-discover')).cached, true); assert.equal(calls, 1);
    await lm.choose(task, [...choiceCandidates].reverse(), 'tool-discover'); assert.equal(calls, 2, 'candidate identity/order is part of the cache key');
    now = 300_001; await lm.choose(task, choiceCandidates, 'tool-discover'); assert.equal(calls, 3);
  } finally { if (prev === undefined) delete process.env.PI_LOCAL_LM; else process.env.PI_LOCAL_LM = prev; }
});

test('local choice keeps the candidate IDs represented by its submitted prompt', async () => {
  const prev = process.env.PI_LOCAL_LM; delete process.env.PI_LOCAL_LM;
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  try {
    const candidates = structuredClone(choiceCandidates);
    const lm = L.createLocalLm({ runtime, fetch: async (_url, { body }) => {
      if (JSON.parse(body).n_predict === 0) return new Response('{}');
      started(); await new Promise(resolve => { release = resolve; });
      return choiceResponse([[' B', .95], [' A', .03]]);
    } });
    const pending = lm.choose('Take a screenshot of this website', candidates, 'tool-discover');
    await begun;
    candidates[1].id = 'different-tool'; candidates.reverse();
    release();
    assert.equal((await pending).id, 'browser');
    assert.equal((await lm.choose('Take a screenshot of this website', choiceCandidates, 'tool-discover')).id, 'browser');
  } finally { if (prev === undefined) delete process.env.PI_LOCAL_LM; else process.env.PI_LOCAL_LM = prev; }
});

test('local HTTP response limits stop streaming before an oversized body is buffered', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32768)); },
    cancel() { cancelled = true; },
  });
  const post = L.localLmPost(runtime, async () => new Response(stream), new AbortController().signal);
  await assert.rejects(post({ prompt: 'bounded response', n_predict: 1 }), /oversized response/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, `stop pulling after crossing the byte budget; got ${pulls}`);
});

test('uncertain, irrelevant, malformed and oversized local choices abstain without deleting options', async () => {
  const prev = process.env.PI_LOCAL_LM; delete process.env.PI_LOCAL_LM;
  try {
    for (const pairs of [[[' B', .2], [' A', .1]], [[' N', .95], [' B', .01]], [[' Browser', .95]], [[' Z', .96]], [[' B', .9], [' A', .9]], [[' B', NaN]]]) {
      const lm = L.createLocalLm({ runtime, fetch: async () => choiceResponse(pairs) });
      assert.equal((await lm.choose('Find useful tools for the current task', choiceCandidates, 'tool-discover')).ok, false, JSON.stringify(pairs));
    }
    const lm = L.createLocalLm({ runtime, fetch: async () => { throw Error('must not run'); } });
    for (const [task, candidates] of [['x', choiceCandidates], ['a'.repeat(801), choiceCandidates], ['valid long task', [choiceCandidates[0]]], ['valid long task', [choiceCandidates[0], choiceCandidates[0]]]]) assert.equal((await lm.choose(task, candidates, 'test')).reason, 'input-budget');
    assert.equal(L.yesProbability({ completion_probabilities: [{ top_probs: [{ token: ' yesterday', prob: 1 }] }] }), undefined);
    assert.equal(L.yesProbability({ completion_probabilities: [{ top_probs: [{ token: ' yes', prob: Infinity }] }] }), undefined);
  } finally { if (prev === undefined) delete process.env.PI_LOCAL_LM; else process.env.PI_LOCAL_LM = prev; }
});

test('disabling line preprocessing does not disable unrelated local-LM consumers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-local-lm-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(runtime));
  const prev = { PI_LOCAL_LM: process.env.PI_LOCAL_LM, PI_SMOL_PREPROCESSOR: process.env.PI_SMOL_PREPROCESSOR, PI_LOCAL_LM_ASSETS: process.env.PI_LOCAL_LM_ASSETS };
  delete process.env.PI_LOCAL_LM;
  process.env.PI_SMOL_PREPROCESSOR = 'off';
  process.env.PI_LOCAL_LM_ASSETS = dir;
  try {
    assert.deepEqual(await L.loadLocalLmRuntime(), runtime);
    const lm = L.createLocalLm({ fetch: async () => probs(0.9, 0.1) });
    assert.equal((await lm.judge('Does this task help the agent?', 'skill-relevance')).ok, true);
    assert.equal(lm.ready(), true);
    process.env.PI_LOCAL_LM = 'off';
    assert.equal(await L.loadLocalLmRuntime(), undefined);
    assert.equal((await L.createLocalLm({ fetch: async () => probs(0.9, 0.1) }).judge('Does this task help?', 'skill-relevance')).reason, 'unavailable');
  } finally {
    for (const [key, value] of Object.entries(prev)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Smol preprocessor still honors its own disable flag without the runtime coupling', async () => {
  const smol = await load('extensions/lib/smol-preprocessor.ts');
  const prev = process.env.PI_SMOL_PREPROCESSOR;
  process.env.PI_SMOL_PREPROCESSOR = 'off';
  try {
    const api = smol.createSmolPreprocessor({ runtime });
    assert.equal(api.inspect().status, 'disabled');
    api.offer('key', 'line one\nline two\nline three', 0, 'some task', 'bash');
    assert.equal(api.inspect().cached, 0);
  } finally { if (prev === undefined) delete process.env.PI_SMOL_PREPROCESSOR; else process.env.PI_SMOL_PREPROCESSOR = prev; }
});

test('queued local requests cancel promptly and pending work respects newly opened breaker', async () => {
  let release, calls = 0;
  const lm = L.createLocalLm({ runtime, fetch: async () => { calls++; return new Promise(resolve => { release = () => resolve(probs(.9, .1)); }); } });
  const active = lm.judge('active', 'test');
  for (let i = 0; i < 20 && !release; i++) await new Promise(r => setImmediate(r));
  const c = new AbortController(), queued = lm.judge('queued', 'test', { signal: c.signal });
  await new Promise(r => setImmediate(r)); c.abort();
  assert.equal((await queued).reason, 'cancelled'); assert.equal(calls, 1); release(); assert.equal((await active).ok, true);
  let failures = 0;
  const failing = L.createLocalLm({ runtime, fetch: async () => { failures++; await new Promise(r => setTimeout(r, 1)); throw Error('down'); } });
  const results = await Promise.all(Array.from({ length: 7 }, () => failing.judge('queued before outage', 'test')));
  assert.equal(failures, 3); assert.equal(results.filter(r => r.reason === 'paused').length, 4);
});

const selectionFixture = () => ['listing header', ...Array.from({ length: 80 }, (_, i) =>
  `entry-${String(i).padStart(3, '0')}.log bytes=${10000 + i * 137}`.padEnd(42, '.')), 'listing complete'].join('\n');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Smol prefix warmup and selection share the local judgement FIFO', async () => {
  const { createSmolPreprocessor } = await load('extensions/lib/smol-preprocessor.ts');
  const calls = []; let release, active = 0, peak = 0;
  const request = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.n_predict); active++; peak = Math.max(peak, active);
    if (body.n_predict === 1) { await new Promise(resolve => { release = resolve; }); active--; return probs(.9, .1); }
    active--; return new Response(JSON.stringify({ content: '{"status":"UNKNOWN","lineIds":[]}' }));
  };
  const lm = L.createLocalLm({ runtime, fetch: request });
  const judge = lm.judge('active judgement', 'unit');
  while (!release) await settle();
  const selector = createSmolPreprocessor({ runtime, fetch: request, acquireLease: async () => true });
  const raw = selectionFixture(); selector.offer('selection', raw, 1);
  await settle();
  assert.deepEqual(calls, [1], 'Smol cannot prefill over an active judgement');
  release(); assert.equal((await judge).ok, true);
  await selector.takeAsync('selection', raw, 1000);
  assert.ok(calls.includes(64), 'line selection still executes after the judge');
  assert.equal(peak, 1);
});

test('Smol cancellation keeps its transport slot until ignored abort settles', async () => {
  const { createSmolPreprocessor } = await load('extensions/lib/smol-preprocessor.ts');
  const calls = []; let finishSelection;
  const request = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.n_predict);
    if (body.n_predict === 64) await new Promise(resolve => { finishSelection = resolve; });
    return body.n_predict === 1 ? probs(.9, .1) : new Response('{"content":"{\\"status\\":\\"UNKNOWN\\",\\"lineIds\\":[]}"}');
  };
  const selector = createSmolPreprocessor({ runtime, fetch: request, acquireLease: async () => true });
  selector.offer('selection', selectionFixture(), 1);
  while (!finishSelection) await settle();
  selector.reset(); await settle();
  const lm = L.createLocalLm({ runtime, fetch: request });
  const cancelled = new AbortController(), waiting = lm.judge('cancelled queued judge', 'unit', { signal: cancelled.signal });
  await settle(); cancelled.abort();
  assert.equal((await waiting).reason, 'cancelled');
  const next = lm.judge('next judgement', 'unit'); await settle();
  assert.ok(!calls.includes(1), 'abort cannot permit overlap while the old HTTP request remains active');
  finishSelection(); assert.equal((await next).ok, true);
  assert.equal(calls.filter(value => value === 1).length, 1, 'cancelled queue entries never execute');
});

test('resetting a Smol selection while queued launches no local request', async () => {
  const { createSmolPreprocessor } = await load('extensions/lib/smol-preprocessor.ts');
  let release, calls = 0;
  const request = async () => { calls++; await new Promise(resolve => { release = resolve; }); return probs(.9, .1); };
  const lm = L.createLocalLm({ runtime, fetch: request }), judge = lm.judge('active', 'unit');
  while (!release) await settle();
  const selector = createSmolPreprocessor({ runtime, fetch: request, acquireLease: async () => true });
  selector.offer('queued', selectionFixture(), 1); await settle(); selector.reset(); await settle();
  assert.equal(selector.inspect().requests, 0);
  release(); assert.equal((await judge).ok, true); await settle();
  assert.equal(calls, 1);
});
