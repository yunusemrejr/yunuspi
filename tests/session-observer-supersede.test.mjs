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

test('superseded observer notes are carried, ledgered, and never pose as delivered', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-supersede-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json') });
  for (const key of ['PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_OBSERVER_TOOLS']) delete process.env[key];
  fs.writeFileSync(path.join(cwd, 'economy.json'), '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });

  const time = clock();
  const handlers = new Map();
  const notices = [];
  const receipts = [];
  const packets = [];
  const notes = [
    'Stop reading files and ship one bounded CSS edit, then verify it renders.',
    'Batch the failing checks into fixes now instead of auditing further.',
    'Retry or drop the failed child immediately; do not spawn more agents.',
    'Record the app-down baseline and start the server via background task.',
    'Stop spawning agents and close the fixture with one verified edit.',
  ];
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
  const sessionManager = { getSessionId: () => 'supersede-fixture', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] };
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false };
  observerExtension(pi, { ...time, loadBook: () => undefined,
    dispatch: async (_route, packet) => {
      packets.push(packet.text);
      const note = notes[calls++];
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note, evidence: ['request'], tools: [], skills: [] }) }] };
    } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  const completedIds = () => notices.filter((n) => n.details?.status === 'completed').map((n) => n.details.adviceId);
  const waitForNotes = async (count) => {
    for (let i = 0; i < 100 && completedIds().length < count; i++) await tick();
    assert.equal(completedIds().length, count, `expected ${count} completed notes, got ${completedIds().length}`);
  };

  fire('session_start', {});
  fire('input', { source: 'interactive', requestId: 'req-1', originalText: 'Complete the synthetic fixture now.' });
  fire('before_agent_start', { systemPromptOptions: {} });
  fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId: 'req-1' } } });
  fire('message_start', { message: { role: 'assistant', content: [] } });

  await time.advance(30000);
  await waitForNotes(1);
  const firstId = completedIds()[0];
  // No provider request runs between the reviews, so the first note is still
  // unprepared when the second review completes: it is carried (not dropped)
  // for the next context build.
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'fixture progress marker' }] } });
  await time.advance(30000);
  await waitForNotes(2);
  const carried = receipts.find((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'carried');
  assert.ok(carried, `superseded carry is receipted, got ${JSON.stringify(receipts)}`);
  assert.equal(carried.data.adviceId, firstId);
  assert.equal(carried.data.via, 'supersede');
  assert.ok(!receipts.some((r) => r.data.status === 'dropped:superseded'), 'carried notes are not ledgered as dropped');
  assert.ok(!packets[1].includes(notes[0]), 'unconfirmed note text never enters the next packet as history');
  assert.ok(!packets[1].includes('previous advice already delivered'), 'history label is reserved for confirmed delivery');

  // The next context build delivers both: the current note first, then the
  // carried note as its own receipted capsule.
  const dual = handlers.get('context')({ messages: [] }, ctx);
  const capsules = dual.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(capsules.length, 2, `current + carried capsules, got ${dual.messages.length}`);
  assert.ok(capsules[0].content.includes(notes[1]), 'first capsule carries the current note');
  assert.match(capsules[0].content, /^\[Observer advice receipt=observer-advice-[0-9a-f-]{36}\b/);
  assert.ok(capsules[1].content.includes(notes[0]), 'second capsule carries the superseded note text');
  assert.match(capsules[1].content, /^\[Observer advice receipt=observer-advice-[0-9a-f-]{36}\b/);
  assert.match(capsules[1].content, /before your latest message/);

  // Provider confirmation joins both capsules to advice history, like any
  // delivered note; nothing is delivered twice.
  const { createHash } = await import('node:crypto');
  ctx.signal = new AbortController().signal;
  const dualConfirmed = handlers.get('context')({ messages: [] }, ctx);
  const both = dualConfirmed.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(both.length, 2);
  const observerAdviceReceipts = both.map((capsule) => ({
    id: /^\[Observer advice receipt=(observer-advice-[0-9a-f-]{36})\b/.exec(capsule.content)[1],
    sha256: createHash('sha256').update(capsule.content).digest('hex'),
  }));
  fire('after_provider_response', { status: 200, provider: model.provider, model: model.id, observerAdviceReceipts });
  const received = receipts.filter((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'provider-received');
  assert.equal(received.length, 2, `both capsules confirmed, got ${JSON.stringify(receipts)}`);
  const quiet = handlers.get('context')({ messages: [] }, ctx);
  assert.ok(!(quiet?.messages ?? []).some((m) => m.customType === 'session-observer-context'), 'confirmed notes are not re-delivered');

  // Third note, then settle: the unprepared note is carried (the slot is free
  // after the confirmation above) instead of dropped.
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'still reading fixtures' }] } });
  await time.advance(30000);
  await waitForNotes(3);
  const thirdId = completedIds()[2];
  fire('agent_settled', {});
  const settledCarry = receipts.find((r) => r.customType === 'session-observer-delivery-v1' && r.data.status === 'carried' && r.data.adviceId === thirdId);
  assert.ok(settledCarry, `settled carry is receipted, got ${JSON.stringify(receipts)}`);
  assert.equal(settledCarry.data.via, 'settle');
  assert.ok(!receipts.some((r) => String(r.data.status).startsWith('dropped:settled')), 'settled notes are carried, not dropped');

  // Fourth note with zero parent edits is restated as required reading, next
  // to the carried third note.
  fire('agent_start', {});
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'still reading fixtures' }] } });
  await time.advance(30000);
  await waitForNotes(4);
  assert.ok(!receipts.some((r) => r.data.status === 'dropped:superseded' && r.data.adviceId === thirdId), 'carried notes are not dropped twice');
  const prepared = handlers.get('context')({ messages: [] }, ctx);
  const found = prepared.messages.filter((m) => m.customType === 'session-observer-context');
  assert.equal(found.length, 2, 'current + carried capsules');
  const capsule = found[0];
  assert.ok(capsule, 'fourth note prepares a context capsule');
  assert.match(capsule.content, /note #4 this task with 0 parent edits recorded/);
  assert.ok(capsule.content.includes(notes[3]), 'first capsule is still the current note');
  assert.ok(found[1].content.includes(notes[2]), 'second capsule is the carried settled note');

  // One recorded parent edit lifts the escalation; prepared notes are never
  // marked dropped when the next review supersedes them.
  const fourthId = completedIds()[3];
  fire('tool_result', { toolName: 'edit', input: { path: 'fixture.ts' }, isError: false, content: [{ type: 'text', text: 'edited' }], toolCallId: 'edit-1' });
  await time.advance(30000);
  await waitForNotes(5);
  assert.ok(!receipts.some((r) => r.data.adviceId === fourthId && String(r.data.status).startsWith('dropped:')), 'prepared notes keep prepared-context as their signal');
  const calm = handlers.get('context')({ messages: [] }, ctx);
  assert.doesNotMatch(calm.messages.find((m) => m.customType === 'session-observer-context').content, /0 parent edits recorded/);
});
