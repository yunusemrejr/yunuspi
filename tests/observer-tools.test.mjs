// The observer keeps full text behind every excerpt and may investigate with
// bounded read-only tools during a review; nothing it can call writes,
// executes, delegates or leaves the working directory.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/observer-journal.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const J = await load('extensions/lib/observer-journal.ts');
const O = await load('extensions/lib/session-observer.ts');

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-tools-'));
after(() => fs.rmSync(project, { recursive: true, force: true }));
fs.mkdirSync(path.join(project, 'src'));
fs.writeFileSync(path.join(project, 'src/parser.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}${i === 11 ? ' requiredField check' : ''}`).join('\n'));
fs.writeFileSync(path.join(project, '.env'), 'SECRET=value');

test('the journal keeps full text, protects user intent from eviction and bounds itself', () => {
  const journal = J.createObserverJournal({ maxChars: 5000 });
  journal.add({ id: 'prompt-1', kind: 'user prompt', at: 1, text: 'Build the site and keep SEO perfect. '.repeat(20) });
  for (let i = 0; i < 20; i++) journal.add({ id: `event-${i}`, kind: 'tool result', at: i, text: `output ${i} `.repeat(60) });
  assert.ok(journal.has('prompt-1'), 'user prompts outlive ordinary events');
  assert.ok(!journal.has('event-0'), 'oldest ordinary events are evicted first');
  assert.ok(journal.size <= 5000);
  journal.add({ id: 'event-x', kind: 'tool result', at: 1, text: 'a\u0007b' });
  assert.equal(journal.get('event-x').text, 'ab', 'control characters are removed');
});

test('read-only tools expand excerpts, search the session and read project files but never secrets or outside paths', () => {
  const journal = J.createObserverJournal();
  journal.add({ id: 'event-7', kind: 'tool result', tool: 'bash', at: 1, text: `${'noise '.repeat(400)}FAILED test_required_field at src/parser.ts:12` });
  journal.add({ id: 'prompt-2', kind: 'user prompt', at: 2, text: 'Also add llms.txt and a public JSON API.' });
  const host = { journal, cwd: project, book: { read: id => id === 'craft.claims' ? 'Completion claims require fresh evidence.' : undefined } };
  const detail = J.runObserverTool(host, 'session_detail', { ids: ['event-7'], offset: 2300 });
  assert.match(detail.text, /FAILED test_required_field/);
  assert.match(detail.text, /1970-01-01T00:00:00.001Z/);
  assert.deepEqual(detail.ids, ['event-7']);
  const search = J.runObserverTool(host, 'session_search', { query: 'llms.txt' });
  assert.deepEqual(search.ids, ['prompt-2']);
  assert.match(search.text, /1970-01-01T00:00:00.002Z/);
  assert.match(J.runObserverTool(host, 'session_search', { query: 'kubernetes' }).text, /Absence here does not prove/);
  const read = J.runObserverTool(host, 'read_file', { path: 'src/parser.ts', offset: 10, limit: 5 });
  assert.match(read.text, /12: line 12 requiredField check/);
  assert.equal(J.runObserverTool(host, 'read_file', { path: '.env' }).isError, true, 'secret-like files are refused');
  assert.equal(J.runObserverTool(host, 'read_file', { path: '../../etc/passwd' }).isError, true, 'paths outside the project are refused');
  const grep = J.runObserverTool(host, 'grep_files', { pattern: 'requiredField' });
  if (!/ripgrep is unavailable/.test(grep.text)) assert.match(grep.text, /src\/parser\.ts:12/);
  assert.match(J.runObserverTool(host, 'book_read', { id: 'craft.claims' }).text, /fresh evidence/);
  assert.equal(J.runObserverTool(host, 'write_file', { path: 'x' }).isError, true, 'unknown tools do nothing');
});

const model = { provider: 'fixture', id: 'observer', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1', maxTokens: 16384, contextWindow: 65536, reasoning: true, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .1 }, input: ['text'] };
const route = { route: 'fixture/observer', model, thinking: 'high' };
const packet = () => O.buildObserverPacket('Fix parser validation.', [{ id: 'event-7', kind: 'tool result', text: 'FAILED … src/parser.ts:12', tool: 'bash' }], [], []);

test('a review may investigate in bounded rounds, sums usage and cites what it read', async () => {
  const journal = J.createObserverJournal();
  journal.add({ id: 'event-7', kind: 'tool result', at: 1, text: 'full failing output with requiredField' });
  const contexts = [], payloads = [];
  let call = 0;
  const registry = { completeSimple: async (actual, context, options) => {
    contexts.push(context);
    payloads.push(options.onPayload({ model: actual.id, max_tokens: 99999, tools: (context.tools ?? []).map(t => ({ type: 'function', function: { name: t.name } })) }, actual));
    call++;
    if (call === 1) return { role: 'assistant', stopReason: 'toolUse', usage: { input: 100, output: 10, cost: { total: .001 } }, content: [{ type: 'toolCall', id: 'c1', name: 'session_detail', arguments: { ids: ['event-7'] } }] };
    return { role: 'assistant', stopReason: 'stop', usage: { input: 120, output: 30, cost: { total: .002 } }, content: [{ type: 'text', text: JSON.stringify({ note: 'The failing check names requiredField; verify the parser validates it before claiming done.', evidence: ['event-7'] }) }] };
  } };
  const response = await O.observerDispatch(route, packet(), new AbortController().signal, registry, { journal, cwd: project });
  assert.equal(response.stopReason, 'stop');
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].messages.at(-1).role, 'toolResult');
  assert.match(contexts[1].messages.at(-1).content[0].text, /requiredField/);
  assert.equal(response.usage.input, 220, 'usage sums across rounds');
  assert.equal(response.usage.cost.total, .003);
  assert.deepEqual(response.fetched, ['event-7']);
  assert.deepEqual(response.investigated, ['session_detail event-7']);
  assert.equal(payloads[0].max_tokens, 8192, 'output ceiling is 8192');
  const advice = O.validateObserverAdvice(response.content[0].text, packet(), new Set(response.fetched)).advice;
  assert.deepEqual(advice.evidence, ['event-7']);
});

test('only the observer tools may reach a payload, and never without a tool host', async () => {
  const registry = tools => ({ completeSimple: async (actual, _context, options) => options.onPayload({ model: actual.id, max_tokens: 100, tools }, actual) });
  await assert.rejects(O.observerDispatch(route, packet(), new AbortController().signal, registry([{ type: 'function', function: { name: 'bash' } }]), { journal: J.createObserverJournal(), cwd: project }), /permitted route/);
  await assert.rejects(O.observerDispatch(route, packet(), new AbortController().signal, registry([{ type: 'function', function: { name: 'session_detail' } }])), /permitted route/);
});

test('a model that keeps calling tools is closed out with one final plain request', async () => {
  let calls = 0;
  const registry = { completeSimple: async () => {
    calls++;
    if (calls <= J.OBSERVER_TOOL_ROUNDS + 1) return { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: `c${calls}`, name: 'session_search', arguments: { query: 'parser' } }] };
    return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"note":""}' }] };
  } };
  const response = await O.observerDispatch(route, packet(), new AbortController().signal, registry, { journal: J.createObserverJournal(), cwd: project });
  assert.equal(calls, J.OBSERVER_TOOL_ROUNDS + 2);
  assert.equal(response.stopReason, 'stop');
});

test('truncation lowers the next review thinking level and clean reviews restore it', async () => {
  const time = { now: 0 };
  const jobs = new Map(); let id = 0;
  const clock = { now: () => time.now, setTimeout(fn, delay) { jobs.set(++id, { at: time.now + delay, fn }); return id; }, clearTimeout(k) { jobs.delete(k); } };
  const advance = async ms => { const until = time.now + ms; for (;;) { const next = [...jobs.entries()].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time.now = next[1].at; jobs.delete(next[0]); next[1].fn(); for (let i = 0; i < 20; i++) await Promise.resolve(); } time.now = until; for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const thinking = [], notices = [];
  let n = 0;
  const observer = O.createSessionObserver({ ...clock, snapshot: () => ({ packet: packet(), route, reviewKey: `k${n}` }), notice: (...args) => notices.push(args), receipt() {},
    dispatch: async (r) => { thinking.push(r.thinking); n++; return n === 1 ? { stopReason: 'length', content: [] } : { stopReason: 'stop', content: [{ type: 'text', text: '{"note":""}' }] }; } });
  observer.begin('owner'); observer.start();
  await advance(30_000);
  assert.match(notices.at(-1)[1], /next review uses medium thinking/);
  for (let i = 0; i < 4; i++) await advance(240_000);
  assert.equal(thinking[0], 'high');
  assert.equal(thinking[1], 'medium');
  assert.equal(thinking.at(-1), 'high', 'three clean reviews restore the configured level');
  observer.close();
});

test('a provider that rejects tool definitions is reviewed packet-only, now and later', async () => {
  const contexts = [];
  const registry = { completeSimple: async (_actual, context) => {
    contexts.push(context);
    if (context.tools) return { role: 'assistant', stopReason: 'error', errorMessage: '400 tools are not supported for this model', content: [] };
    return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"note":""}' }] };
  } };
  const toolless = { ...route, route: 'fixture/no-tools' };
  const first = await O.observerDispatch(toolless, packet(), new AbortController().signal, registry, { journal: J.createObserverJournal(), cwd: project });
  assert.equal(first.stopReason, 'stop');
  assert.deepEqual(contexts.map(context => Boolean(context.tools)), [true, false]);
  await O.observerDispatch(toolless, packet(), new AbortController().signal, registry, { journal: J.createObserverJournal(), cwd: project });
  assert.equal(contexts.length, 3); assert.equal(contexts[2].tools, undefined, 'the route is remembered as tool-less');
  // A transient error is not mistaken for tool rejection.
  const flaky = { completeSimple: async (_a, context) => { contexts.push(context); return { role: 'assistant', stopReason: 'error', errorMessage: 'socket hang up', content: [] }; } };
  const before = contexts.length;
  await O.observerDispatch({ ...route, route: 'fixture/flaky' }, packet(), new AbortController().signal, flaky, { journal: J.createObserverJournal(), cwd: project });
  assert.equal(contexts.length - before, 1);
});
