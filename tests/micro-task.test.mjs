import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/micro-intelligence/micro-task.ts')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-micro-task-'));
const oldAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = temp;
after(() => { if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent; fs.rmSync(temp, { recursive: true, force: true }); });
const { registerMicroTask } = await import(pathToFileURL(path.join(agent, 'extensions/lib/micro-intelligence/micro-task.ts')));
const { clearMicroWorkerCache } = await import(pathToFileURL(path.join(agent, 'extensions/lib/micro-intelligence/micro-worker.ts')));
const { collectAuxiliaryModelUsage } = await import(pathToFileURL(path.join(agent, 'extensions/lib/cost-evidence.ts')));
const model = () => ({ provider: 'fixture', id: 'small', baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions',
  input: ['text'], contextWindow: 32768, maxTokens: 4096, reasoning: false,
  cost: { input: .1, output: .2, cacheRead: .05, cacheWrite: .1 } });
const answers = {
  'error-hypothesis': { hypotheses: [{ cause: 'cache alias', check: 'mutate returned object', confidence: .8 }] },
  'finding-consolidation': { groups: [], singletons: ['one'] },
  'handoff-brief': { goal: 'fix cache', done: [], open: ['regression'], next: 'run regression' },
  'structured-extraction': { fields: { owner: 'cache' } },
  'inspection-targets': { targets: [{ target: 'cache.ts', why: 'cache owner' }] },
  'patch-compare': { verdict: 'changed', decisive: 'cache clone', notes: 'returns isolated data' },
  'source-glance': { summary: 'Cache ownership', flags: [] },
};
function fixture(t, { candidate = model(), current = true, complete } = {}) {
  clearMicroWorkerCache();
  let tool, kind = 'source-glance';
  const calls = [], entries = [], hooks = new Map(), session = new AbortController();
  const eligibilityFile = path.join(temp, `${Math.random().toString(16).slice(2)}.json`);
  registerMicroTask({ registerTool(value) { tool = value; }, on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); }, appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); } }, { env: {}, eligibilityFile, sessionSignal: () => session.signal });
  const ctx = { model: current ? candidate : undefined, modelRegistry: {
    getAvailable: () => [candidate], find: () => candidate,
    async completeSimple(offered, context, options) {
      const prompt = context.messages[0].content[0].text;
      calls.push({ offered, context, options, prompt });
      assert.equal(context.tools, undefined); assert.equal(options.maxRetries, 0); assert.ok(options.maxTokens <= 1000);
      const payload = options.onPayload({ model: offered.id, max_tokens: options.maxTokens }, offered);
      assert.ok(payload.max_tokens <= options.maxTokens);
      if (complete) return complete({ prompt, options, offered });
      const text = prompt.includes('"ports"') ? '{"name":"ada","ports":[80,443],"enabled":true}'
        : prompt.includes('three colors') ? 'red\ngreen\nblue'
        : prompt.includes('Request: "Add dark mode') ? '{"items":["dark mode","login redirect","never log passwords"]}'
        : JSON.stringify(answers[kind]);
      return { content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 30, output: 20, cost: { total: .00001 } } };
    },
  } };
  t.after(() => { session.abort(); clearMicroWorkerCache(); });
  return { tool, ctx, calls, entries, session, candidate, eligibilityFile, emit: event => { for (const handler of hooks.get(event) ?? []) handler(); },
    run: (args, signal) => { kind = args.kind ?? 'source-glance'; return tool.execute('fixture', args, signal, undefined, ctx).then(result => result.details); } };
}

test('micro_task measures an unknown current route then runs all seven bounded roles through native dispatch', async t => {
  const f = fixture(t);
  assert.equal(f.tool.name, 'micro_task');
  const status = await f.run({ action: 'status' });
  assert.equal(status.routes.length, 1); assert.equal(status.routes[0].qualification, null); assert.equal(f.calls.length, 0);
  for (const kind of Object.keys(answers)) {
    const result = await f.run({ kind, input: 'Inspect this bounded source example' });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.advisory, true);
    assert.deepEqual(result.output, answers[kind]); assert.equal(result.qualification.eligible, true);
  }
  assert.equal(f.calls.length, 10, 'three synthetic checks plus seven operations');
  assert.ok(f.calls.slice(0, 3).every(call => !call.prompt.includes('Inspect this bounded source example')));
  assert.equal((fs.statSync(f.eligibilityFile).mode & 0o777), 0o600);
  assert.equal((await f.run({ kind: 'source-glance', input: 'Inspect this bounded source example' })).cached, true);
  assert.equal(f.calls.length, 10);
  const usage = collectAuxiliaryModelUsage(f.entries);
  assert.equal(usage.rows.length, 10); assert.equal(usage.truncated, false);
  assert.ok(usage.rows.every(row => row.owner === 'micro-task' && row.status === 'completed' && row.tokens === 50));
  assert.ok(!JSON.stringify(f.entries).includes('Inspect this bounded source example'));
});

test('micro_task blocks unknown private recipients and unknown/expensive pricing before inference', async t => {
  const privateRoute = fixture(t, { current: false });
  const blocked = await privateRoute.run({ kind: 'source-glance', input: 'Inspect private source code' });
  assert.equal(blocked.skipped, 'no-eligible-route');
  assert.equal(blocked.rejected[0].reason, 'private-input-unsafe-route'); assert.equal(privateRoute.calls.length, 0);
  assert.equal((await privateRoute.run({ kind: 'source-glance', input: 'Inspect a public example', privateInput: false })).ok, true);
  for (const cost of [undefined, { input: .6, output: .2, cacheRead: .1, cacheWrite: .1 }, { input: .1, output: 10, cacheRead: .1, cacheWrite: .1 }]) {
    const f = fixture(t, { candidate: { ...model(), cost } });
    assert.equal((await f.run({ kind: 'source-glance', input: 'Inspect source code here' })).skipped, 'no-eligible-route');
    assert.equal(f.calls.length, 0);
  }
});

test('micro_task does not use incomplete qualification and binds evidence/cache to the endpoint', async t => {
  const failing = fixture(t, { complete: async () => ({ content: [{ type: 'text', text: '{}' }], stopReason: 'stop' }) });
  const args = { kind: 'source-glance', input: 'Inspect this source after qualification' };
  assert.equal((await failing.run(args)).skipped, 'qualification-failed');
  assert.equal(failing.calls.length, 3);
  assert.equal((await failing.run(args)).skipped, 'qualification-failed'); assert.equal(failing.calls.length, 3);
  const f = fixture(t);
  assert.equal((await f.run(args)).ok, true); assert.equal(f.calls.length, 4);
  f.candidate.baseUrl = 'https://replacement.invalid/v1';
  assert.equal((await f.run(args)).ok, true); assert.equal(f.calls.length, 8, 'new endpoint needs new evidence and inference');
});

test('micro_task cancellation ends calibration without persisting partial approval', async t => {
  let offered;
  const f = fixture(t, { complete: async ({ options }) => { offered = options.signal; return new Promise(() => {}); } });
  const pending = f.run({ kind: 'source-glance', input: 'Inspect bounded source code' });
  for (let i = 0; i < 10 && !offered; i++) await new Promise(resolve => setImmediate(resolve));
  f.session.abort();
  assert.equal((await pending).skipped, 'aborted'); assert.equal(offered.aborted, true);
  assert.equal(fs.existsSync(f.eligibilityFile), false);
});

test('micro_task refuses changed wire endpoints even when the model name remains current', async t => {
  const f = fixture(t);
  f.ctx.modelRegistry.completeSimple = async (offered, _context, options) => {
    options.onPayload({ model: offered.id, max_tokens: options.maxTokens }, { ...offered, baseUrl: 'https://different-recipient.invalid/v1' });
    throw Error('must not reach provider');
  };
  const result = await f.run({ kind: 'source-glance', input: 'Inspect private source code' });
  assert.equal(result.skipped, 'qualification-failed');
});

test('micro_task strips unsafe model defaults and enforces route/tools/output on the wire payload', async t => {
  const candidate = model();
  candidate.samplingParams = { temperature: .1, model: 'other', max_tokens: 90000, tools: [{ type: 'function' }], plugins: [{ id: 'web' }] };
  const f = fixture(t, { candidate, complete: async ({ offered, options }) => {
    assert.deepEqual(offered.samplingParams, { temperature: .1 });
    const base = { model: offered.id, max_tokens: options.maxTokens };
    for (const patch of [{ model: 'other' }, { models: ['other'] }, { tools: [{}] }, { tools: {} }, { plugins: [{}] }, { max_tokens: -1 }])
      assert.throws(() => options.onPayload({ ...base, ...patch }, offered));
    assert.equal(options.onPayload({ ...base, max_tokens: 90000 }, offered).max_tokens, options.maxTokens);
    assert.equal(options.onPayload({ model: offered.id, generationConfig: { maxOutputTokens: 90000 } }, offered).generationConfig.maxOutputTokens, options.maxTokens);
    assert.throws(() => options.onPayload({ model: offered.id }, offered), /missing output budget/);
    return { content: [{ type: 'text', text: '{}' }], stopReason: 'stop' };
  } });
  assert.equal((await f.run({ action: 'qualify' })).ok, false, 'wire guards ran on all synthetic checks');
  assert.equal(f.calls.length, 3);
});

test('micro_task retains native dispatch admission until an ignored cancellation settles', async t => {
  const f = fixture(t);
  await f.run({ action: 'qualify' });
  let release, active = 0;
  f.ctx.modelRegistry.completeSimple = async () => {
    active++; return new Promise(resolve => { release = () => { active--; resolve({ content: [{ type: 'text', text: JSON.stringify(answers['source-glance']) }], stopReason: 'stop', usage: { input: 20, output: 10 } }); }; });
  };
  const controller = new AbortController();
  const pending = f.run({ kind: 'source-glance', input: 'Read this unique ownership example' }, controller.signal);
  for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).skipped, 'aborted'); assert.equal(active, 1);
  assert.equal((await f.run({ kind: 'source-glance', input: 'Read another unique ownership example' })).skipped, 'busy');
  assert.equal(active, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.run({ action: 'status' })).running, false);
  assert.ok(collectAuxiliaryModelUsage(f.entries).rows.some(row => row.status === 'cancelled' && row.tokens === 30));
});

test('micro_task routing compares a native model suggestion without changing the current route', async t => {
  const f = fixture(t), alternative = { ...model(), id: 'other' };
  f.ctx.modelRegistry.getAvailable = () => [f.candidate, alternative];
  await f.run({ action: 'qualify' });
  f.ctx.modelRegistry.completeSimple = async (offered, _context, options) => {
    options.onPayload({ model: offered.id, max_tokens: 9000 }, offered);
    return { content: [{ type: 'text', text: '{"model":"fixture/other","effort":"low"}' }], stopReason: 'stop' };
  };
  const result = await f.run({ action: 'route', input: 'Choose a model for source review', candidates: ['fixture/small', 'fixture/other'] });
  assert.equal(result.ok, true); assert.equal(result.comparison.router, 'fixture/other');
  assert.equal(result.comparison.yunuspi, 'fixture/small'); assert.equal(f.ctx.model.id, 'small');
  assert.equal((await f.run({ action: 'status' })).router.comparisons, 1);
});


test('micro_task rechecks authoritative unit pricing immediately before native dispatch', async t => {
  for (const price of [undefined, 1]) {
    const f = fixture(t);
    f.ctx.modelRegistry.find = () => ({ ...f.candidate, cost: { ...f.candidate.cost, input: price } });
    assert.equal((await f.run({ action: 'qualify' })).ok, false);
    assert.equal(f.calls.length, 0, 'stale catalog pricing cannot admit the refreshed expensive route');
    assert.equal(f.entries.length, 0, 'no physical request was admitted');
  }
});

test('micro_task lifecycle invalidates route receipts before clearing the router flight', async t => {
  for (const event of ['session_start', 'session_tree', 'session_shutdown']) {
    const f = fixture(t), alternative = { ...model(), id: 'other' };
    f.ctx.modelRegistry.getAvailable = () => [f.candidate, alternative];
    await f.run({ action: 'qualify' });
    let release;
    f.ctx.modelRegistry.completeSimple = async () => new Promise(resolve => {
      release = () => resolve({ content: [{ type: 'text', text: '{"model":"fixture/other","effort":"low"}' }], stopReason: 'stop', usage: { input: 20, output: 10 } });
    });
    const pending = f.run({ action: 'route', input: 'Choose a model for source review', candidates: ['fixture/small', 'fixture/other'] });
    for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    const receipts = f.entries.length;
    // The app has changed sessions before this first lifecycle listener runs;
    // the extension's later listener has not yet aborted the old shared signal.
    f.emit(event);
    assert.equal(f.session.signal.aborted, false);
    assert.equal((await pending).ok, false);
    assert.equal(f.entries.length, receipts, 'synchronous router abort cannot append into the replacement session');
    f.session.abort();
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.entries.length, receipts, 'late transport usage belongs to the discarded session');
  }
});
