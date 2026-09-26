import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import observerExtension from '../agent/extensions/session-observer.ts';

const GUARDIAN_META = Symbol.for('yunuspi.guardian.request-meta.v1');
const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'Synthetic observer route', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, input: ['text'], cost: { input: 0.1, output: 0.2 } };
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-carryover-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json') });
  for (const key of ['PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS']) delete process.env[key];
  fs.writeFileSync(path.join(cwd, 'economy.json'), '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });

  const time = clock();
  const handlers = new Map();
  const notices = [];
  const receipts = [];
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
  const sessionManager = { getSessionId: () => 'carryover-fixture', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] };
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false };
  observerExtension(pi, { ...time, judge: async () => ({ ok: false, skipped: 'fixture' }), loadBook: () => undefined,
    dispatch: async () => {
      const note = notes[calls++];
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note, evidence: ['request'], tools: [], skills: [] }) }] };
    } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  const completedIds = () => notices.filter((n) => n.details?.status === 'completed').map((n) => n.details.adviceId);
  const waitForNotes = async (count) => {
    for (let i = 0; i < 100 && completedIds().length < count; i++) await tick();
    assert.equal(completedIds().length, count, `expected ${count} completed notes, got ${completedIds().length}`);
  };
  const beginTask = (requestId, text) => {
    fire('input', { source: 'interactive', requestId, originalText: text });
    fire('before_agent_start', { systemPromptOptions: {} });
    fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId } } });
    fire('message_start', { message: { role: 'assistant', content: [] } });
  };
  return { time, handlers, notices, receipts, ctx, fire, completedIds, waitForNotes, beginTask };
}

test('undelivered observer notes survive new user input into the next task', async (t) => {
  const h = harness(t, ['Reproduce the search coverage symptom end to end before styling anything.']);
  h.fire('session_start', {});
  h.beginTask('req-1', 'Complete the synthetic fixture now.');
  await h.time.advance(30000);
  await h.waitForNotes(1);
  const firstId = h.completedIds()[0];

  // New input arrives before any provider request: the scheduler note is
  // cleared, but its text must be carried, not lost (the main agent never
  // saw 14 minutes of reviewer notes this way).
  h.beginTask('req-2', 'come on');
  const carried = h.receipts.find((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'carried');
  assert.ok(carried, `input carry is receipted, got ${JSON.stringify(h.receipts)}`);
  assert.equal(carried.data.adviceId, firstId);
  assert.equal(carried.data.via, 'input');

  const built = h.handlers.get('context')({ messages: [] }, h.ctx);
  const capsules = built.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(capsules.length, 1, 'carried-only delivery when no current note exists');
  assert.ok(capsules[0].content.includes('Reproduce the search coverage symptom'), 'carried capsule holds the unseen note text');
  assert.match(capsules[0].content, /^\[Observer advice receipt=observer-advice-[0-9a-f-]{36}\b/);
  assert.match(capsules[0].content, /before your latest message/);
});

test('undelivered observer notes do not expire on a wall clock', async (t) => {
  const h = harness(t, ['Batch the failing checks into fixes now instead of auditing further.']);
  h.fire('session_start', {});
  h.beginTask('req-1', 'Complete the synthetic fixture now.');
  await h.time.advance(30000);
  await h.waitForNotes(1);

  // No new evidence and no provider request for over two minutes: past the
  // old 120s cutoff, the note must still deliver (staleness is re-validated
  // at delivery, with the snapshot age named).
  await h.time.advance(150000);
  const built = h.handlers.get('context')({ messages: [] }, h.ctx);
  const capsules = built.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(capsules.length, 1, 'aged note still delivers on the next context build');
  assert.ok(capsules[0].content.includes('Batch the failing checks into fixes'), 'aged capsule holds the note text');
});

test('carry slot is one deep and replacements are loud', async (t) => {
  const h = harness(t, [
    'First unseen note about fixture scope.',
    'Second unseen note about fixture scope.',
    'Third unseen note about fixture scope.',
  ]);
  h.fire('session_start', {});
  h.beginTask('req-1', 'Complete the synthetic fixture now.');
  await h.time.advance(30000);
  await h.waitForNotes(1);
  h.fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'marker one' }] } });
  await h.time.advance(30000);
  await h.waitForNotes(2);
  h.fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'marker two' }] } });
  await h.time.advance(30000);
  await h.waitForNotes(3);
  const ids = h.completedIds();

  const carries = h.receipts.filter((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'carried');
  assert.deepEqual(carries.map((r) => r.data.adviceId), [ids[0], ids[1]], 'each superseded note is carried in turn');
  const replaced = h.receipts.find((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'dropped:replaced');
  assert.ok(replaced, `carry replacement is receipted, got ${JSON.stringify(h.receipts)}`);
  assert.equal(replaced.data.adviceId, ids[0]);
  assert.ok(!h.receipts.some((r) => r.data.status === 'dropped:superseded'), 'nothing is silently superseded');

  const built = h.handlers.get('context')({ messages: [] }, h.ctx);
  const capsules = built.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(capsules.length, 2, 'current + newest carried');
  assert.ok(capsules[0].content.includes('Third unseen note'), 'current note first');
  assert.ok(capsules[1].content.includes('Second unseen note'), 'newest carried note second');
  assert.ok(!capsules.some((c) => c.content.includes('First unseen note')), 'replaced note is gone, loudly');
});
