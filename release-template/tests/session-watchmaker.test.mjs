import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import watchmakerExtension from '../agent/extensions/session-watchmaker.ts';
import { buildWatchmakerPacket, createWatchmakerScratchpad, formatWatchmakerPace, validateWatchmakerAdvice, WATCHMAKER_MEMO_TYPE } from '../agent/extensions/lib/session-watchmaker.ts';

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

test('watchmaker tracks time and keeps bounded latest receipts for progress judgments', async (t) => {
  const memoryKey = Symbol.for('yunus-pi.project-memory-recall.v1'), oldMemory = globalThis[memoryKey], memoryRoles = [];
  globalThis[memoryKey] = async (_cwd, _query, role) => { memoryRoles.push(role); return '[mem_fixture] Historical stall: repeated source reads delayed the last fix.'; };
  t.after(() => { if (oldMemory === undefined) delete globalThis[memoryKey]; else globalThis[memoryKey] = oldMemory; });
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
  const statuses = [];
  const ctx = { cwd, sessionManager, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false, ui: { setStatus: (key, text) => statuses.push([key, text]) } };
  watchmakerExtension(pi, { ...time, judge: async () => ({ ok: false, skipped: 'fixture' }),
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
  for (const [command, output] of [['git push origin fixture', 'Fixture branch pushed successfully.'], ['git status --porcelain && git rev-parse HEAD origin/fixture', 'fixture-sha\nfixture-sha']]) {
    fire('tool_execution_start', { toolCallId: command, toolName: 'bash', args: { command } });
    await time.advance(1000);
    fire('tool_result', { toolCallId: command, toolName: 'bash', input: { command }, isError: false, content: [{ type: 'text', text: output }] });
  }
  fire('message_end', { message: { role: 'custom', customType: 'guardian_intervention', content: 'Check the latest tool failure before retrying.' } });
  await time.advance(60000);
  await waitForNotes(1);
  assert.match(packets[0], /Guardian already told/);
  assert.match(packets[0], /Historical stall/); assert.deepEqual(memoryRoles, ['watchmaker']);
  assert.doesNotMatch(packets[0], /STALL:|0 edits/, 'tool names cannot establish that no work happened');
  assert.match(packets[0], /Fixture branch pushed successfully/);
  assert.match(packets[0], /fixture-sha/);
  assert.ok(!packets[0].includes(marker), 'full tool bodies do not enter the bounded packet');
  assert.ok(Buffer.byteLength(packets[0], 'utf8') < 7000, 'packet stays small');
  const memoEntry = receipts.find((r) => r.customType === WATCHMAKER_MEMO_TYPE);
  assert.ok(memoEntry, `memo is persisted, got ${JSON.stringify(receipts)}`);
  assert.equal(memoEntry.data.memo, memos[0]);

  const firstId = completedIds()[0];
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'still auditing fixtures' }] } });
  await time.advance(60000);
  await waitForNotes(2);
  assert.ok(packets[1].includes(memos[0]), 'later reviews read the scratchpad instead of re-deriving history');
  const drop = receipts.find((r) => r.customType === 'watchmaker-delivery-v1' && r.data.status === 'carried');
  assert.ok(drop, `unprepared note is carried loudly, got ${JSON.stringify(receipts)}`);
  assert.equal(drop.data.adviceId, firstId);
  assert.equal(drop.data.via, 'supersede');
  assert.equal(notices.filter((n) => n.details?.status === 'started').length, 1, 'an unchanged route and setting persists one start line, not one per review');
  assert.equal(statuses.filter(([, text]) => /^Watchmaker reviewing/.test(text ?? '')).length, 2, 'every in-flight review is visible in the footer');
  assert.equal(statuses.at(-1)[1], undefined, 'the footer status clears when the review settles');

  const prepared = handlers.get('context')({ messages: [] }, ctx);
  const watchmakerCapsules = prepared.messages.filter((m) => m.customType === 'session-watchmaker-context');
  assert.equal(watchmakerCapsules.length, 2, 'current + carried capsules');
  const capsule = watchmakerCapsules[0];
  assert.ok(capsule, 'note prepares a context capsule');
  assert.ok(watchmakerCapsules[1].content.includes(notes[0].slice(0, 60)), 'second capsule carries the superseded note');
  assert.match(capsule.content, /^\[Watchmaker advice receipt=watchmaker-advice-[0-9a-f-]{36}/, 'receipt line starts the capsule for core matching');
  assert.ok(capsule.content.length <= 4096, 'capsule fits the core receipt window');

  process.env.PI_WATCHMAKER = 'off';
  fire('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'more auditing' }] } });
  await time.advance(120000);
  assert.equal(calls, 2, 'kill switch stops reviews without human init changes');
  delete process.env.PI_WATCHMAKER;
});

test('pace counts neither declare a stall nor mislabel subagent status calls as dispatches', () => {
  const pace = formatWatchmakerPace({ elapsed: 120000, calls: 15, edits: 0, reads: 0, delegated: 3, activeChildren: 1 });
  assert.match(pace, /15 completed calls/);
  assert.match(pace, /3 subagent calls/);
  assert.match(pace, /Bash, scripts and children/);
  assert.doesNotMatch(pace, /STALL|0 edits|0 reads|dispatches/);
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

test('scratchpad restores retained memos beyond recent tool traffic and can reset ownership', () => {
  const pad = createWatchmakerScratchpad(3);
  const entry = { type: 'custom', customType: WATCHMAKER_MEMO_TYPE, data: { memo: 'A retained branch conclusion', at: 20 } };
  pad.seed([entry, ...Array.from({ length: 100 }, () => ({ type: 'message', message: { role: 'assistant' } }))]);
  assert.equal(pad.list().length, 1, 'non-memo entries cannot age a retained memo out of reload');
  pad.clear();
  assert.deepEqual(pad.list(), [], 'changing sessions clears the previous scratchpad');
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
  assert.equal(long.advice?.memo, `${'x'.repeat(139)}…`, 'an overlong memo is clipped, not discarded');
  assert.equal(long.advice?.memoRejected, undefined);
  const words = validateWatchmakerAdvice(JSON.stringify({ note: 'Run the build once.', evidence: ['request'], tools: [], skills: [], memo: 'build once then verify '.repeat(10) }), packet);
  assert.ok(words.advice?.memo.length <= 140 && words.advice.memo.endsWith('verify…'), 'clipping ends on a word boundary');
  assert.ok(long.advice?.note, 'a clipped memo never voids the note');
});

test('a long unread run folds into a digest so quiet reviews back off instead of paying every minute', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmaker-fold-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_LLM_PREFERENCES_FILE', 'PI_SUBAGENTS_ECONOMY_CONFIG', 'PI_PROVIDER_STATE_FILE', 'PI_MODEL_EXCLUSIONS_PATH', 'PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_WATCHMAKER', 'PI_OBSERVER_TOOLS'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: cwd, PI_LLM_PREFERENCES_FILE: path.join(cwd, 'prefs.json'), PI_SUBAGENTS_ECONOMY_CONFIG: path.join(cwd, 'economy.json'), PI_PROVIDER_STATE_FILE: path.join(cwd, 'health.json'), PI_MODEL_EXCLUSIONS_PATH: path.join(cwd, 'exclusions.json') });
  for (const key of keys.slice(5)) delete process.env[key];
  fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(cwd, { recursive: true, force: true }); });
  const time = clock(), handlers = new Map(), packets = [];
  const pi = { on: (event, fn) => { handlers.set(event, fn); }, events: { on: () => () => {} }, registerMessageRenderer: () => {}, registerCommand: () => {},
    getActiveTools: () => [], getAllTools: () => [], sendMessage: () => {}, appendEntry: () => {} };
  const ctx = { cwd, sessionManager: { getSessionId: () => 'watchmaker-fold', getSessionFile: () => path.join(cwd, 'session.jsonl'), getBranch: () => [] }, modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false, ui: { setStatus: () => {} } };
  watchmakerExtension(pi, { ...time, judge: async () => ({ ok: false, skipped: 'fixture' }),
    dispatch: async (_route, packet) => { packets.push(packet.text); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: '', evidence: [], tools: [], skills: [] }) }] }; } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  fire('session_start', {});
  fire('input', { source: 'interactive', requestId: 'req-fold', originalText: 'Refactor the fixture modules.' });
  fire('before_agent_start', { systemPromptOptions: {} });
  fire('message_start', { message: { role: 'user', [GUARDIAN_META]: { requestId: 'req-fold' } } });
  const run = async (from, count, failAt) => {
    for (let i = from; i < from + count; i++) {
      fire('tool_execution_start', { toolCallId: `edit-${i}`, toolName: 'edit', args: { path: `src/module-${i}.ts` } });
      await time.advance(500);
      fire('tool_result', { toolCallId: `edit-${i}`, toolName: 'edit', input: { path: `src/module-${i}.ts` }, isError: i === failAt, content: [{ type: 'text', text: i === failAt ? 'EARLY-FAILURE old text not found' : 'edited' }] });
    }
  };
  await run(0, 30, 2);
  await time.advance(60000);
  for (let i = 0; i < 100 && packets.length < 1; i++) await tick();
  assert.equal(packets.length, 1);
  assert.match(packets[0], /earlier events summarized/, 'older routine rows fold into one digest');
  assert.match(packets[0], /EARLY-FAILURE/, 'an older failure stays verbatim');
  assert.match(packets[0], /module-29/, 'the review keeps pace with the newest work');
  const settle = async (count) => { for (let i = 0; i < 100 && packets.length < count; i++) await tick(); };
  // Routine progress after quiet reviews no longer counts as a backlog, so
  // the quiet backoff grows instead of paying for a review every minute.
  await run(30, 20);
  await time.advance(60000); await settle(2);
  assert.equal(packets.length, 2, 'one quiet review holds only one interval');
  await run(50, 20);
  await time.advance(60000); await settle(3);
  assert.equal(packets.length, 2, 'two quiet reviews in a row double the wait despite routine progress');
  await time.advance(60000); await settle(3);
  assert.equal(packets.length, 3, 'the hold is bounded; the next review still arrives');
});
