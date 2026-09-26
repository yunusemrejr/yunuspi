import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import watchmakerExtension from '../agent/extensions/session-watchmaker.ts';
import { peerReviewerNotes, reviewerSessionKey } from '../agent/extensions/lib/session-observer.ts';

const GUARDIAN_META = Symbol.for('yunuspi.guardian.request-meta.v1');
const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'Synthetic watchmaker route', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, input: ['text'], cost: { input: 0.1, output: 0.2 } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let now = 0; let id = 0; const jobs = new Map();
  return { now: () => now,
    setTimeout(fn, ms) { jobs.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]); next[1].fn(); await tick();
      }
      now = end; await tick();
    } };
}

function harness(t, notes) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmaker-carryover-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_WATCHMAKER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json') });
  for (const key of ['PI_OFFLINE', 'PI_WATCHMAKER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS']) delete process.env[key];
  fs.writeFileSync(path.join(cwd, 'economy.json'), '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });

  const time = clock();
  const handlers = new Map();
  const notices = [];
  const receipts = [];
  const packets = [];
  let calls = 0;
  const pi = {
    on: (event, fn) => { handlers.set(event, fn); },
    events: { on: () => () => {} },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: (message) => { notices.push(message); },
    appendEntry: (customType, data) => { receipts.push({ customType, data }); },
  };
  const sessionManager = { getSessionId: () => 'watchmaker-carryover-fixture', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] };
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false };
  watchmakerExtension(pi, { ...time, judge: async () => ({ ok: false, skipped: 'fixture' }),
    dispatch: async (_route, packet) => {
      packets.push(packet);
      const result = notes[calls++];
      const { note, memo = '' } = typeof result === 'string' ? { note: result } : result;
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note, evidence: ['request'], tools: [], skills: [], memo }) }] };
    } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  const completedIds = () => notices.filter((n) => n.details?.status === 'completed').map((n) => n.details.adviceId);
  const waitForNotes = async (count) => {
    for (let i = 0; i < 200 && completedIds().length < count; i++) await tick();
    assert.equal(completedIds().length, count, `expected ${count} completed notes, got ${completedIds().length}`);
  };
  const beginTask = async (requestId, text) => {
    fire('input', { source: 'interactive', requestId, originalText: text });
    fire('before_agent_start', { systemPromptOptions: {} });
    fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId } } });
    // The fake clock starts at 0 and the extension treats 0 as "no response
    // yet"; move past it before the agent's first response (real clocks never
    // return 0).
    await time.advance(1000);
    fire('message_start', { message: { role: 'assistant', content: [] } });
  };
  return { time, handlers, notices, receipts, packets, ctx, fire, completedIds, waitForNotes, beginTask };
}

test('watchmaker switches scratchpad ownership and records its own usage owner', async (t) => {
  const memo = 'The initial fixture repeatedly rebuilt unchanged dependencies';
  const h = harness(t, [
    { note: 'Measure the slow dependency rebuild before repeating it.', memo },
    'Inspect the remaining parser failure and make the targeted fix.',
  ]);
  h.fire('session_start', {});
  await h.beginTask('first', 'Fix the initial fixture.');
  await h.time.advance(60000);
  await h.waitForNotes(1);
  assert.ok(h.receipts.some(row => row.customType === 'watchmaker-memo-v1' && row.data.memo === memo));
  const usage = h.receipts.filter(row => row.customType === 'auxiliary-model-usage-v1');
  assert.ok(usage.length);
  assert.ok(usage.every(row => row.data.owner === 'session-watchmaker'));
  h.ctx.sessionManager = { ...h.ctx.sessionManager, getSessionId: () => 'another-session' };
  h.fire('session_switch', {});
  await h.beginTask('second', 'Repair the parser in a different fixture.');
  await h.time.advance(60000);
  await h.waitForNotes(2);
  assert.ok(!h.packets[1].text.includes(memo), 'the replacement session cannot inherit another session scratchpad');
});

for (const carried of [false, true]) test(`watchmaker peers wait for the ${carried ? 'carried' : 'current'} note receipt`, async (t) => {
  const note = 'Repeated dependency builds dominate time: inspect the slow stage before rebuilding.';
  const h = harness(t, [note]);
  h.fire('session_start', {});
  await h.beginTask('first', 'Fix the fixture.');
  await h.time.advance(60000);
  await h.waitForNotes(1);
  const key = reviewerSessionKey(h.ctx);
  assert.deepEqual(peerReviewerNotes(key, 'observer', h.time.now()), []);
  if (carried) await h.beginTask('second', 'Continue that repair.');
  const capsule = h.fire('context', { messages: [] }).messages.find(message => message.customType === 'session-watchmaker-context');
  assert.deepEqual(peerReviewerNotes(key, 'observer', h.time.now()), []);
  h.fire('after_provider_response', { status: 200, provider: model.provider, model: model.id,
    observerAdviceReceipts: [{ id: h.completedIds()[0], sha256: createHash('sha256').update(capsule.content).digest('hex') }] });
  assert.equal(peerReviewerNotes(key, 'observer', h.time.now())[0]?.note, note);
});

test('undelivered watchmaker notes survive new user input into the next task', async (t) => {
  const h = harness(t, ['Eight minutes without edits while reads repeat: batch one fix and verify it renders.']);
  h.fire('session_start', {});
  await h.beginTask('req-1', 'Fix every bug in the fixture project.');
  await h.time.advance(60000);
  await h.waitForNotes(1);
  const firstId = h.completedIds()[0];

  await h.beginTask('req-2', 'come on');
  const carried = h.receipts.find((r) => r.customType === 'watchmaker-delivery-v1' && r.data.status === 'carried');
  assert.ok(carried, `input carry is receipted, got ${JSON.stringify(h.receipts)}`);
  assert.equal(carried.data.adviceId, firstId);
  assert.equal(carried.data.via, 'input');

  const built = h.handlers.get('context')({ messages: [] }, h.ctx);
  const capsules = built.messages.filter((m) => m.customType === 'session-watchmaker-context');
  assert.equal(capsules.length, 1, 'carried-only delivery when no current note exists');
  assert.ok(capsules[0].content.includes('Eight minutes without edits'), 'carried capsule holds the unseen note text');
  assert.match(capsules[0].content, /^\[Watchmaker advice receipt=watchmaker-advice-[0-9a-f-]{36}\b/);
  assert.match(capsules[0].content, /before your latest message/);
});

test('undelivered watchmaker notes do not expire on a wall clock', async (t) => {
  const h = harness(t, ['Reads keep repeating the same targets: run the build once for the bug list instead.']);
  h.fire('session_start', {});
  await h.beginTask('req-1', 'Fix every bug in the fixture project.');
  await h.time.advance(60000);
  await h.waitForNotes(1);

  await h.time.advance(150000);
  const built = h.handlers.get('context')({ messages: [] }, h.ctx);
  const capsules = built.messages.filter((m) => m.customType === 'session-watchmaker-context');
  assert.equal(capsules.length, 1, 'aged note still delivers on the next context build');
  assert.ok(capsules[0].content.includes('Reads keep repeating'), 'aged capsule holds the note text');
});
