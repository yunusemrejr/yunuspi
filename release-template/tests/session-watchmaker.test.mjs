import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import watchmakerExtension from '../agent/extensions/session-watchmaker.ts';
import { buildWatchmakerPacket, createWatchmakerScratchpad, validateWatchmakerAdvice, WATCHMAKER_MEMO_TYPE } from '../agent/extensions/lib/session-watchmaker.ts';

const GUARDIAN_META = Symbol.for('yunuspi.guardian.request-meta.v1');
const model = { provider: 'deepseek', id: 'deepseek-flash', name: 'Synthetic watchmaker route', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, input: ['text'], cost: { input: .1, output: .2 } };
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

test('watchmaker tracks time, memos conclusions, and skips output bodies', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmaker-'));
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_WATCHMAKER', 'PI_OBSERVER_TOOLS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json') });
  for (const key of ['PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_WATCHMAKER', 'PI_OBSERVER_TOOLS']) delete process.env[key];
  fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });

  const time = clock();
  const handlers = new Map();
  const notices = [];
  const receipts = [];
  const packets = [];
  const notes = [
    'Ten reads and zero edits in six minutes: run the build once for the bug list instead of reading more files.',
    'Reads keep repeating the same targets: batch one fix now and verify it renders before further audit.',
    'A rewrite discussion is consuming the budget: timebox it to one reply, then return to the failing checks.',
  ];
  const memos = ['reads outnumber edits 10 to 0; build output is the cheaper bug list', '', ''];
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
  const sessionManager = { getSessionId: () => 'watchmaker-fixture', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] };
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false };
  watchmakerExtension(pi, { ...time,
    dispatch: async (_route, packet) => {
      packets.push(packet.text);
      const index = calls++;
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: notes[index], evidence: ['request'], tools: [], skills: [], memo: memos[index] }) }] };
    } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  const completedIds = () => notices.filter((n) => n.details?.status === 'completed').map((n) => n.details.adviceId);
  const waitForNotes = async (count) => {
    for (let i = 0; i < 100 && completedIds().length < count; i++) await tick();
    assert.equal(completedIds().length, count, `expected ${count} completed notes, got ${completedIds().length}`);
  };

  fire('session_start', {});
  fire('input', { source: 'interactive', requestId: 'req-1', originalText: 'Fix every bug in the fixture project.' });
  fire('before_agent_start', { systemPromptOptions: {} });
  fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId: 'req-1' } } });
  const marker = `MARKER-body-${'x'.repeat(5000)}`;
  for (let i = 0; i < 11; i++) {
    fire('tool_execution_start', { toolCallId: `read-${i}`, toolName: 'read', args: { path: `src/file-${i}.ts` } });
    await time.advance(1000);
    fire('tool_result', { toolCallId: `read-${i}`, toolName: 'read', input: { path: `src/file-${i}.ts` }, isError: false, content: [{ type: 'text', text: marker }], details: {} });
  }
  await time.advance(60000);
  await waitForNotes(1);
  assert.ok(packets[0].includes('STALL: 0 edits'), 'pace row names the stall from counts');
  assert.ok(!packets[0].includes(marker), 'tool output bodies never enter the packet');
  assert.ok(Buffer.byteLength(packets[0], 'utf8') < 7000, 'packet stays small');
  const memoEntry = receipts.find((r) => r.customType === WATCHMAKER_MEMO_TYPE);
  assert.ok(memoEntry, `memo is persisted, got ${JSON.stringify(receipts)}`);
  assert.equal(memoEntry.data.memo, memos[0]);

  const firstId = completedIds()[0];
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'still auditing fixtures' }] } });
  await time.advance(60000);
  await waitForNotes(2);
  assert.ok(packets[1].includes(memos[0]), 'later reviews read the scratchpad instead of re-deriving history');
  const drop = receipts.find((r) => r.customType === 'watchmaker-delivery-v1' && r.data.status === 'dropped:superseded');
  assert.ok(drop, `unprepared note is superseded loudly, got ${JSON.stringify(receipts)}`);
  assert.equal(drop.data.adviceId, firstId);

  const prepared = handlers.get('context')({ messages: [] }, ctx);
  const capsule = prepared.messages.find((m) => m.customType === 'session-watchmaker-context');
  assert.ok(capsule, 'note prepares a context capsule');
  assert.match(capsule.content, /^\[Watchmaker advice receipt=watchmaker-advice-[0-9a-f-]{36}/, 'receipt line starts the capsule for core matching');
  assert.ok(capsule.content.length <= 4096, 'capsule fits the core receipt window');

  process.env.PI_WATCHMAKER = 'off';
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'more auditing' }] } });
  await time.advance(120000);
  assert.equal(calls, 2, 'kill switch stops reviews without human init changes');
  delete process.env.PI_WATCHMAKER;
});

test('scratchpad reseeds from persisted memo entries and dedupes', () => {
  const pad = createWatchmakerScratchpad(3);
  pad.add('first conclusion', 10);
  pad.add('first conclusion', 11);
  assert.equal(pad.list().length, 1);
  pad.seed([
    { type: 'custom', customType: WATCHMAKER_MEMO_TYPE, data: { memo: 'second conclusion', at: 20 } },
    { type: 'custom', customType: WATCHMAKER_MEMO_TYPE, data: { memo: 'third conclusion', at: 30 } },
    { type: 'custom', customType: WATCHMAKER_MEMO_TYPE, data: { memo: 'fourth conclusion', at: 40 } },
    { type: 'custom', customType: 'other-type', data: { memo: 'ignored', at: 50 } },
  ]);
  assert.deepEqual(pad.list().map((memo) => memo.text), ['second conclusion', 'third conclusion', 'fourth conclusion']);
});

test('watchmaker packets stay within budget and validate memos', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `event-${i}`, kind: 'tool result', text: `read file-${i}.ts: completed in 1s · ${'padded '.repeat(40)}` }));
  const packet = buildWatchmakerPacket({ request: 'Fix everything', rows, tools: [], skills: [], memos: ['a durable conclusion'] });
  const body = packet.text.slice(packet.text.indexOf('\nTime packet:\n'));
  assert.ok(Buffer.byteLength(body, 'utf8') <= 5000 + 200, 'evidence section respects the packet bound');
  assert.ok(packet.evidence.some((row) => row.kind === 'watchmaker memo'), 'memos survive budgeting');
  const good = validateWatchmakerAdvice(JSON.stringify({ note: 'Run the build once.', evidence: ['request'], tools: [], skills: [], memo: 'build once beats reading twice' }), packet);
  assert.equal(good.advice?.memo, 'build once beats reading twice');
  const long = validateWatchmakerAdvice(JSON.stringify({ note: 'Run the build once.', evidence: ['request'], tools: [], skills: [], memo: 'x'.repeat(200) }), packet);
  assert.equal(long.advice?.memo, undefined);
  assert.match(long.advice?.memoRejected ?? '', /exceeds 140/);
  assert.ok(long.advice?.note, 'a rejected memo never voids the note');
});
