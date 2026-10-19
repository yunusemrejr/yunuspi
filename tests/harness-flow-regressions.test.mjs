import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Regressions from the 2026-09-25 sessions: a scope council that held the first
// turn for minutes and then discarded its finished work, and background
// reviewers that billed notes about harness-owned runs and repeated themselves.
const release = path.resolve(import.meta.dirname, '..');
const agent = fs.existsSync(path.join(release, 'agent')) ? path.join(release, 'agent') : path.resolve(release, '..');
const lib = (name) => pathToFileURL(path.join(agent, 'extensions/lib', name)).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-flow-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(root, 'economy.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(root, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(root, 'exclusions.json');
process.env.PI_LLM_PREFERENCES_FILE = path.join(root, 'preferences.json');
process.env.PI_SCOPE_COUNCIL = 'on';
process.env.PI_AUTONOMOUS_FREE_ASSIST = 'on';
delete process.env.PI_SUBAGENT_CHILD;
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const { createSessionObserver, buildObserverPacket } = await import(lib('session-observer.ts'));
const { displayText } = await import(lib('harness-notice.ts'));
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { isHarnessOwnedChild, reduceChildEvents, projectTranscriptChildren } = await import(shared + 'child-ledger.ts');
const { publishFreeEvidence, FREE_BASE_URL, FREE_CATALOG_URL } = await import(shared + 'free-route-evidence.ts');
const { resetSharedControl } = await import(lib('intervention-shared.ts'));

const complete = { status: 'complete', proposals: [{ role: 'preservation', text: 'Keep the typography.' }, { role: 'change', text: 'Rework the motion.' }], discussion: 'Rework the motion substantially and verify the rendered result.', gap: '' };

test('harness-owned automatic runs are not the agent\'s children', () => {
  const branch = [
    { type: 'custom', customType: 'subagent-lifecycle-v1', data: { runId: 'native-1', mode: 'single', state: 'running', results: [{ index: 0, status: 'running', agent: 'automatic-free-assistant' }] } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'scope-council-preservation-x', results: [{ index: 0, status: 'running', label: 'Scope council: preserve requirements', agent: 'automatic-free-assistant' }] } },
    { type: 'custom', customType: 'subagent-cost-v1', data: { runId: 'agent-run', results: [{ index: 0, status: 'running', label: 'Worker', agent: 'worker' }] } },
  ];
  const tasks = reduceChildEvents(projectTranscriptChildren(branch)).tasks;
  assert.deepEqual(tasks.filter(task => !isHarnessOwnedChild(task)).map(task => task.label), ['Worker']);
});

test('a paraphrase re-pushing already-named tools is suppressed; a new move is delivered', async () => {
  const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
  let now = 0, id = 0; const jobs = new Map();
  const time = { now: () => now, setTimeout(fn, delay) { jobs.set(++id, { at: now + delay, fn }); return id; }, clearTimeout(key) { jobs.delete(key); },
    async advance(ms) { const until = now + ms; while (true) { const next = [...jobs.entries()].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; jobs.delete(next[0]); next[1].fn(); await flush(); } now = until; await flush(); } };
  const model = { provider: 'deepseek', id: 'deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .1 }, input: ['text'] };
  const notes = [
    { note: 'One minute in with zero edits while two children run: harvest results with bg_wait, then batch the concrete edits.', tools: ['bg_wait'] },
    { note: 'Main thread idle two minutes with zero edits while two children run: use bg_wait to collect their results, then edit.', tools: ['bg_wait'] },
    { note: 'Serial shell probing dominates; run the project tests once to ground the next edit instead.', tools: ['project_tests'] },
  ];
  let n = 0; const seen = [];
  const tools = [{ name: 'bg_wait', description: 'Wait for background work' }, { name: 'project_tests', description: 'Run project tests' }];
  const runtime = createSessionObserver({ ...time, label: 'Watchmaker',
    snapshot: () => ({ packet: buildObserverPacket(`Improve the app ${n}`, [{ id: 'event-1', kind: 'tool result', text: 'bash completed' }], tools, []), route: { route: 'deepseek/deepseek-flash', model, thinking: 'low' }, reviewKey: String(n) }),
    notice: (status, detail) => seen.push([status, detail]), receipt: () => {},
    dispatch: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ ...notes[n++ % notes.length], evidence: ['event-1'], skills: [] }) }] }) });
  runtime.begin('owner'); runtime.start();
  await time.advance(200_000);
  const completed = seen.filter(([status]) => status === 'completed');
  assert.equal(completed.length, 2, JSON.stringify(seen));
  assert.ok(seen.some(([status, detail]) => status === 'reviewed' && /repeated advice suppressed/.test(detail)));
  runtime.close();
});

test('visible notice summaries keep their beginning', () => {
  const detail = 'Returned advice in 84s · cited child-state changed meanwhile · book: ui-ux.verify-rendered · kept margin note m81 · removed unknown evidence ids and much more text here';
  assert.match(displayText(detail, 60), /^Returned advice in 84s/);
  assert.ok(displayText(detail, 60).endsWith('…'));
});

test('a reviewer does not restate the other reviewer\'s delivered note', async () => {
  const { publishReviewerNote, peerReviewerNotes } = await import(lib('session-observer.ts'));
  publishReviewerNote('session-a', 'watchmaker', 'Run the project tests once now to ground the next edit instead of more shell probing.', ['project_tests'], 1000);
  assert.equal(peerReviewerNotes('session-a', 'watchmaker', 1000).length, 0, 'own notes are not peers');
  assert.equal(peerReviewerNotes('session-a', 'observer', 1000).length, 1);
  assert.equal(peerReviewerNotes('session-b', 'observer', 1000).length, 0, 'sessions never share notes');
  let now = 0, id = 0; const jobs = new Map();
  const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
  const time = { now: () => now, setTimeout(fn, delay) { jobs.set(++id, { at: now + delay, fn }); return id; }, clearTimeout(key) { jobs.delete(key); },
    async advance(ms) { const until = now + ms; while (true) { const next = [...jobs.entries()].filter(([, j]) => j.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; jobs.delete(next[0]); next[1].fn(); await flush(); } now = until; await flush(); } };
  const model = { provider: 'deepseek', id: 'deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .1 }, input: ['text'] };
  const seen = [];
  const runtime = createSessionObserver({ ...time,
    peerNotes: () => peerReviewerNotes('session-a', 'observer', 1000),
    snapshot: () => ({ packet: buildObserverPacket('Improve the app', [{ id: 'event-1', kind: 'tool result', text: 'bash completed' }], [{ name: 'project_tests', description: 'Run project tests' }], []), route: { route: 'deepseek/deepseek-flash', model, thinking: 'high' }, reviewKey: String(now) }),
    notice: (status, detail) => seen.push([status, detail]), receipt: () => {},
    dispatch: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: 'Stop the shell probing and run the project tests now so the next edit is grounded.', evidence: ['event-1'], tools: ['project_tests'], skills: [] }) }] }) });
  runtime.begin('owner'); runtime.start(); await time.advance(40_000);
  assert.ok(!seen.some(([status]) => status === 'completed'), JSON.stringify(seen));
  assert.ok(seen.some(([, detail]) => /repeated advice suppressed/.test(detail)));
  runtime.close();
});

test('project self-tests, compilers and the native test tool count as verification', async () => {
  const { VERIFY_COMMAND } = await import(lib('observer-book.ts'));
  for (const command of ['timeout 900 ./run.sh --self-test 2>&1 | tail -60', 'javac -encoding UTF-8 -d build/classes $(find src -name "*.java")', 'bash tests/check.sh', 'npm test'])
    assert.ok(VERIFY_COMMAND.test(command), command);
  for (const command of ['cat README.md', 'grep -n test src/app.js', 'git diff --check', 'ls tests/'])
    assert.ok(!VERIFY_COMMAND.test(command), command);
});

test('a deliberate harness gate is not counted as a tool failure', async () => {
  const { collectSessionMetrics } = await import(lib('session-metrics.ts'));
  const gate = { type: 'message', message: { role: 'toolResult', toolName: 'edit', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '[harness gate] Not an error: the automatic change-scope council finished.' }] } };
  const failure = { type: 'message', message: { role: 'toolResult', toolName: 'edit', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'Edit target not found' }] } };
  assert.equal(collectSessionMetrics([gate]).errors, 0);
  assert.equal(collectSessionMetrics([gate, failure]).errors, 1);
});

test('reviewer note scope follows live manager identity, not an identical reopened transcript', async () => {
  const { reviewerSessionKey, publishReviewerNote, peerReviewerNotes } = await import(lib('session-observer.ts'));
  const manager = () => ({ getSessionId: () => 'same-transcript', getSessionFile: () => '/fixture/same.jsonl' });
  const a = { cwd: '/fixture', sessionManager: manager() }, b = { ...a, sessionManager: manager() };
  const key = reviewerSessionKey(a);
  assert.equal(reviewerSessionKey({ ...a }), key, 'observer and Watchmaker on one manager share a board');
  assert.notEqual(reviewerSessionKey(b), key);
  publishReviewerNote(key, 'guardian', 'Inspect the failed edit before another attempt.', [], 1000);
  assert.equal(peerReviewerNotes(reviewerSessionKey(a), 'watchmaker', 1000).length, 1);
  assert.equal(peerReviewerNotes(reviewerSessionKey(b), 'watchmaker', 1000).length, 0);
  a.sessionManager.getSessionId = () => 'new-transcript';
  assert.notEqual(reviewerSessionKey(a), key);
});
