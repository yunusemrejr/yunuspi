import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsLib = path.join(root, 'agent', 'extensions', 'lib', 'task-state');

// Isolated harness env (mirrors the observer/watchmaker fixtures).
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-state-int-'));
process.env.PI_CODING_AGENT_DIR = fixtureRoot;
process.env.PI_LLM_PREFERENCES_FILE = path.join(fixtureRoot, 'preferences.json');
process.env.PI_PROVIDER_STATE_FILE = path.join(fixtureRoot, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(fixtureRoot, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(fixtureRoot, 'economy.json');
process.env.PI_TASK_STATE_DIR = path.join(fixtureRoot, 'task-state');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
process.env.PI_OBSERVER_BOOK_DIR = 'off';
for (const key of ['PI_OFFLINE', 'PI_SESSION_OBSERVER', 'PI_SUBAGENT_CHILD', 'PI_WATCHMAKER']) delete process.env[key];

const { getTaskStateService, clearTaskStateServices, currentTaskStateService } = await import(path.join(tsLib, 'service.ts'));
const ingest = await import(path.join(tsLib, 'ingest.ts'));
const { buildObserverPacket } = await import(path.join(root, 'agent', 'extensions', 'lib', 'session-observer.ts'));
const { buildWatchmakerPacket } = await import(path.join(root, 'agent', 'extensions', 'lib', 'session-watchmaker.ts'));
const { buildSessionReport } = await import(path.join(root, 'agent', 'extensions', 'lib', 'session-report.ts'));
const { completionGate } = await import(path.join(root, 'agent', 'extensions', 'lib', 'completion-gate.ts'));
const { attachTaskStateSlice, attachTaskStateSliceDeep, taskSliceFocus } = await import(path.join(root, 'agent', 'extensions', 'pi-subagents', 'src', 'runs', 'shared', 'common-task.ts'));
const { default: taskStateExtension } = await import(path.join(root, 'agent', 'extensions', 'task-state.ts'));
const { tagGuardianRequestMessage } = await import(path.join(root, 'core', 'coding-agent', 'src', 'core', 'guardian', 'guardian-supervisor.js'));
const { default: observerExtension } = await import(path.join(root, 'agent', 'extensions', 'session-observer.ts'));
const { default: watchmakerExtension } = await import(path.join(root, 'agent', 'extensions', 'session-watchmaker.ts'));

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
const model = { provider: 'deepseek', id: 'deepseek-flash', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', maxTokens: 8192, contextWindow: 65536, reasoning: true, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .1 }, input: ['text'] };

function seedGraph(sid) {
  clearTaskStateServices();
  const service = getTaskStateService(sid);
  service.userInput('Add a search box. Keep existing text unchanged.');
  service.syncRequirements([
    { id: 'R1', text: 'Add a search box' },
    { id: 'R2', text: 'Keep existing text unchanged' },
  ]);
  const graph = service.graph();
  const c = { sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now() };
  const req1 = `req-${graph.taskId}-R1`;
  service.apply([
    ingest.upsertEvent(c, { id: 'chg-1', kind: 'tool-exec', status: 'implemented', title: 'edit search.ts', provenance: 'tool-output' }, 'seed-c1'),
    ingest.linkEvent(c, 'chg-1', req1, 'implemented-by'),
    ingest.statusEvent(c, req1, 'implemented', 'change landed'),
  ]);
  return service;
}

// ── service lifecycle ────────────────────────────────────────────────────

test('service: follow-up continues the task; unrelated input rotates with history preserved', () => {
  clearTaskStateServices();
  const service = getTaskStateService('sid-lifecycle');
  const first = service.userInput('Build the widget.');
  assert.equal(first.mode, 'followup');
  const taskA = service.taskId;
  assert.match(service.graph().label, /widget/);
  const cont = service.userInput('Also make it blue.', 'expand');
  assert.equal(cont.mode, 'followup');
  assert.equal(service.taskId, taskA, 'follow-up keeps the task');
  const rotated = service.userInput('Unrelated: what is the capital of France?', 'unrelated');
  assert.equal(rotated.mode, 'new-task');
  assert.notEqual(service.taskId, taskA, 'genuinely new task rotates');
  assert.equal(service.graph().rotations.length, 1);
  assert.match(service.graph().rotations[0].priorLabel, /widget/);
});

test('service: session resume and compaction restore the graph from disk', () => {
  clearTaskStateServices();
  const before = getTaskStateService('sid-resume');
  before.userInput('Build the widget.');
  before.syncRequirements([{ id: 'R1', text: 'Build the widget well' }]);
  before.checkpoint(); // compaction / shutdown flush
  const taskId = before.taskId;
  clearTaskStateServices(); // process turnover: drop in-memory state only
  const after = getTaskStateService('sid-resume');
  assert.equal(after.taskId, taskId);
  assert.match(after.graph().label, /widget/);
  assert.ok(after.entity(`req-${taskId}-R1`), 'requirement survived resume');
  assert.equal(after.stats().requirements, 1);
});

test('concurrent sessions keep separate task graphs', () => {
  clearTaskStateServices();
  const a = getTaskStateService('sid-A');
  const b = getTaskStateService('sid-B');
  a.userInput('Task alpha work.');
  b.userInput('Task beta work.');
  assert.notEqual(a.taskId, b.taskId);
  assert.match(a.graph().label, /alpha/);
  assert.match(b.graph().label, /beta/);
  a.syncRequirements([{ id: 'R1', text: 'Alpha requirement' }]);
  assert.equal(b.stats().requirements, 0, 'sibling requirements never leak across sessions');
});

test('corrupted snapshot quarantines and rebuilds from the event log', () => {
  clearTaskStateServices();
  const service = getTaskStateService('sid-corrupt');
  service.userInput('Build the widget.');
  service.syncRequirements([{ id: 'R1', text: 'Build the widget well' }]);
  service.checkpoint();
  const dir = path.join(process.env.PI_TASK_STATE_DIR, 'sid-corrupt', service.taskId);
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{not valid json!!!');
  clearTaskStateServices();
  const recovered = getTaskStateService('sid-corrupt');
  assert.equal(recovered.graph().health.quarantined, true);
  assert.ok(recovered.entity(`req-${recovered.taskId}-R1`), 'event log rebuilt the requirement');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('snapshot.json.quarantine-')), 'bad snapshot quarantined aside');
});

test('graph failure degrades openly and never throws into the session', () => {
  clearTaskStateServices();
  const service = getTaskStateService('sid-degraded', path.join(fixtureRoot, 'no-such-dir', 'x'.repeat(200)));
  assert.doesNotThrow(() => {
    service.userInput('Do work.');
    service.syncRequirements([{ id: 'R1', text: 'Work well' }]);
    service.record({ id: 'e1', kind: 'decision', title: 'D', provenance: 'main-agent' });
    service.link('e1', 'missing', 'relates-to');
    service.updateStatus('e1', 'verified');
    service.invalidate('e1', 'reason');
    service.supersede('e1', 'e2');
    service.query(() => { throw new Error('bad predicate'); });
    service.entity('e1');
    service.project('observer');
    service.subagentSlice(['x']);
    service.completionBlockers();
    service.diagnostics();
    service.stats();
    service.checkpoint();
  });
});

// ── main-agent tool + extension wiring ───────────────────────────────────

function taskHarness(sid) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const branch = [];
  const ctx = {
    cwd: fixtureRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => sid, getBranch: () => branch },
    ui: { notify: () => {} },
  };
  const pi = {
    on: (event, fn) => { handlers.set(event, fn); },
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    appendEntry: () => {},
    getActiveTools: () => [...tools.keys()],
  };
  taskStateExtension(pi);
  const emit = async (event, data = {}) => handlers.get(event)?.(data, ctx);
  return { pi, ctx, branch, tools, commands, emit };
}

test('main agent tool consumes the live graph: input, edits, tests, todos flow in; queries flow out', async () => {
  clearTaskStateServices();
  const h = taskHarness('sid-tool');
  assert.ok(h.tools.has('task_state'), 'one compact main-agent tool is registered');
  assert.ok(h.commands.has('task-state'), '/task-state command is registered');
  await h.emit('session_start');
  // Ledger render already on the branch so the graph adopts ledger R-ids.
  h.branch.push({ type: 'message', message: { role: 'custom', customType: 'requirement-ledger', content: 'Requirement ledger:\nR1: Add a search box\nR2: Keep existing text unchanged' } });
  await h.emit('input', { source: 'interactive', text: 'Add a search box. Keep existing text unchanged.' });
  await h.emit('tool_result', { toolName: 'edit', toolCallId: 'call-1', input: { path: 'src/search.ts' }, content: [{ type: 'text', text: 'edited' }], isError: false });
  await h.emit('tool_result', { toolName: 'bash', toolCallId: 'call-2', input: { command: 'npm test' }, content: [{ type: 'text', text: 'all 12 tests passed' }], isError: false });
  await h.emit('tool_result', { toolName: 'todo', toolCallId: 'call-3', input: { action: 'list' }, content: [], details: { tasks: [{ id: 1, title: 'Search box', status: 'completed' }] }, isError: false });
  const tool = h.tools.get('task_state');
  const run = async (params) => (await tool.execute('x', params, undefined, undefined, h.ctx)).details.text;
  const status = await run({ action: 'status' });
  assert.match(status, /search box/i);
  assert.match(status, /R1/);
  const blockers = await run({ action: 'blockers' });
  assert.match(blockers, /R1|R2/, 'unverified requirements surface as blockers');
  const failures = await run({ action: 'failures' });
  assert.match(failures, /none recorded/, 'no failures were observed');
});

test('review findings and failed checks flow into the graph through tool results', async () => {
  clearTaskStateServices();
  const h = taskHarness('sid-review');
  await h.emit('session_start');
  await h.emit('input', { source: 'interactive', text: 'Fix the layout.' });
  await h.emit('tool_result', { toolName: 'bash', toolCallId: 'fail-1', input: { command: 'npm test' }, content: [{ type: 'text', text: 'FAIL layout renders blank' }], isError: true });
  await h.emit('tool_result', { toolName: 'quality_review', toolCallId: 'qr-1', input: { action: 'assess' }, content: [{ type: 'text', text: 'Blocked: missing render evidence for the layout' }], isError: false });
  const service = currentTaskStateService();
  assert.ok(service);
  const findings = service.query((e) => e.kind === 'finding');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].provenance, 'review-council');
  assert.equal(findings[0].status, 'blocked');
  const failures = service.query((e) => e.kind === 'failure');
  assert.equal(failures.length, 1);
  assert.ok(failures[0].family?.startsWith('fam-'));
});

// ── completion gate composition ──────────────────────────────────────────

test('completion gate refuses on graph blockers and allows verified completion', () => {
  clearTaskStateServices();
  const service = getTaskStateService('sid-gate');
  service.userInput('Add a search box.');
  service.syncRequirements([{ id: 'R1', text: 'Add a search box' }]);
  const refused = new Set();
  const lines = [...service.completionBlockers().map((b) => `task state: ${b}`)];
  assert.ok(lines.length > 0, 'unverified requirement produces a blocker line');
  const first = completionGate('plan-complete', lines, refused);
  assert.equal(first.block, true);
  refused.add(first.key);
  assert.equal(completionGate('plan-complete', lines, refused).waived, true, 'identical retry is a recorded waiver');
  // Verify the requirement: implemented + current evidence.
  const graph = service.graph();
  const c = { sessionId: graph.sessionId, taskId: graph.taskId, ts: Date.now() };
  const req = `req-${graph.taskId}-R1`;
  service.apply([
    ingest.upsertEvent(c, { id: 'ev-g', kind: 'evidence', status: 'active', title: 'tests pass', provenance: 'test-result' }, 'g1'),
    ingest.linkEvent(c, 'ev-g', req, 'verified-by'),
    ingest.statusEvent(c, req, 'implemented', 'done'),
    ingest.statusEvent(c, req, 'verified', 'checked'),
  ]);
  assert.deepEqual(service.completionBlockers(), []);
  assert.equal(completionGate('plan-complete', [], new Set()).block, false);
});

// ── observer consumes the graph ──────────────────────────────────────────

test('observer packet builder preserves a bounded task-state row', () => {
  const p = buildObserverPacket('Fix it.', [{ id: 'task-state', kind: 'task state graph', text: 'R1 implemented ✓ verified ✗ · search box'.padEnd(1400, '.') }], [], []);
  const row = p.evidence.find((r) => r.id === 'task-state');
  assert.ok(row, 'task-state row survives packet assembly');
  assert.ok(row.text.length > 1000, 'task-state row keeps its 1500-char budget, not the 260 default');
  assert.ok(p.text.length <= 10000, 'packet stays within its byte ceiling');
});

test('observer review consumes the live graph projection (extension-driven)', async () => {
  seedGraph('synthetic-session');
  const time = clock();
  const handlers = new Map();
  const packets = [];
  const branch = [];
  const ctx = {
    cwd: fixtureRoot,
    sessionManager: { getSessionId: () => 'synthetic-session', getSessionFile: () => '/synthetic/session.jsonl', getBranch: () => branch },
    isIdle: () => false, model, modelRegistry: { getAvailable: () => [model] },
  };
  const pi = {
    events: { on: () => () => {} },
    on: (name, fn) => handlers.set(name, fn),
    registerMessageRenderer: () => {},
    getActiveTools: () => ['read'],
    getAllTools: () => [{ name: 'read', description: 'Read parser source' }],
    sendMessage: () => {},
    appendEntry: (...args) => branch.push({ type: 'custom', customType: args[0], data: args[1] }),
  };
  observerExtension(pi, { ...time, dispatch: async (_r, p) => { packets.push(p); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: 'Graph shows R1 implemented but unverified; verify before claiming done.', evidence: ['task-state'], tools: [], skills: [] }) }], usage: { input: 10, output: 5 } }; } });
  const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
  emit('session_start');
  emit('input', { source: 'interactive', text: 'Add a search box.', originalText: 'Add a search box.', requestId: 'r1', signal: new AbortController().signal });
  const umsg = tagGuardianRequestMessage({ role: 'user', content: [{ type: 'text', text: 'Add a search box.' }] }, { requestId: 'r1', sessionId: 'synthetic-session' });
  branch.push({ type: 'message', message: umsg });
  emit('message_start', { message: umsg });
  emit('message_start', { message: { role: 'assistant', content: [] } });
  emit('before_agent_start', { systemPromptOptions: { skills: [{ name: 'validation', description: 'Parser validation' }] } });
  emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } });
  emit('tool_result', { toolName: 'read', content: [{ type: 'text', text: 'source seen' }] });
  await time.advance(30000);
  assert.equal(packets.length, 1, 'review dispatched');
  const row = packets[0].evidence.find((r) => r.id === 'task-state');
  assert.ok(row, 'observer packet carries the shared task-state projection');
  assert.match(row.text, /R1/, 'projection names the live requirement');
  assert.match(row.text, /implemented/, 'projection carries implementation state');
  emit('session_shutdown');
});

// ── watchmaker consumes the graph ────────────────────────────────────────

test('watchmaker packet builder preserves a bounded task-progress row', () => {
  const p = buildWatchmakerPacket({ request: 'Fix it.', rows: [{ id: 'task-progress', kind: 'task progress graph', text: 'Active work: search box [active]'.padEnd(400, '.') }], tools: [], skills: [], memos: [] });
  const row = p.evidence.find((r) => r.id === 'task-progress');
  assert.ok(row, 'task-progress row survives packet assembly');
  assert.ok(row.text.length > 300, 'task-progress row keeps time-kind budget, not the 220 default');
});

test('watchmaker review consumes the live graph projection (extension-driven)', async () => {
  seedGraph('watchmaker-fixture');
  const time = clock();
  const handlers = new Map();
  const packets = [];
  const ctx = {
    cwd: fixtureRoot,
    sessionManager: { getSessionId: () => 'watchmaker-fixture', getSessionFile: () => path.join(fixtureRoot, 's.jsonl'), getBranch: () => [] },
    modelRegistry: { getAvailable: () => [model] }, model, isIdle: () => false, ui: { setStatus: () => {} },
  };
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    events: { on: () => () => {} },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    sendMessage: () => {},
    appendEntry: () => {},
  };
  watchmakerExtension(pi, { ...time, dispatch: async (_r, p) => { packets.push(p); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ note: 'Graph shows one active item; keep going.', evidence: ['request'], tools: [], skills: [] }) }] }; } });
  const fire = (event, payload) => handlers.get(event)?.(payload, ctx);
  fire('session_start', {});
  fire('input', { source: 'interactive', requestId: 'req-1', originalText: 'Add a search box.' });
  fire('before_agent_start', { systemPromptOptions: {} });
  fire('message_start', { message: tagGuardianRequestMessage({ role: 'user', content: 'Add a search box.' }, { requestId: 'req-1', sessionId: 'watchmaker-fixture' }) });
  fire('message_start', { message: { role: 'assistant', content: [] } });
  fire('tool_execution_start', { toolCallId: 'read-0', toolName: 'read', args: { path: 'src/a.ts' } });
  await time.advance(1000);
  fire('tool_result', { toolCallId: 'read-0', toolName: 'read', input: { path: 'src/a.ts' }, isError: false, content: [{ type: 'text', text: 'seen' }], details: {} });
  await time.advance(120000);
  assert.ok(packets.length >= 1, 'watchmaker dispatched');
  const row = packets[0].evidence.find((r) => r.id === 'task-progress');
  assert.ok(row, 'watchmaker packet carries the shared task-progress projection');
  assert.match(row.text, /Active work/, 'projection names active work');
  fire('session_shutdown', {});
});

// ── subagents consume slices ─────────────────────────────────────────────

test('subagent dispatch attaches a bounded relevant slice (exact call-site shape)', () => {
  const service = seedGraph('sid-slice');
  const resolve = (brief) => currentTaskStateService()?.subagentSlice(taskSliceFocus(brief)) ?? '';
  assert.deepEqual(taskSliceFocus('Verify R1 in src/search.ts'), ['R1', 'src/search.ts']);
  const single = attachTaskStateSlice({ task: 'Verify R1 in src/search.ts.' }, () => resolve('Verify R1 in src/search.ts.'));
  assert.match(single.task, /Task context \(shared Task State Graph/, 'slice appended to child brief');
  assert.match(single.task, /R1/, 'slice carries the relevant requirement');
  assert.ok(single.task.length < 48_000);
  // Idempotent: never double-append.
  const again = attachTaskStateSlice(single, () => resolve(single.task));
  assert.equal(again.task, single.task);
  // Fan-out shapes get per-child slices.
  const fanout = attachTaskStateSliceDeep(
    { tasks: [{ task: 'Check R1.' }, { task: 'Check R2.' }], chain: [{ task: 'Summarize.' }] },
    (brief) => resolve(brief),
  );
  assert.match(fanout.tasks[0].task, /Task context/);
  assert.match(fanout.tasks[1].task, /Task context/);
  assert.match(fanout.chain[0].task, /Task context/);
  assert.ok(service, 'service reachable at dispatch time');
});

test('slice attach fails open when the graph is unavailable', () => {
  const input = { task: 'Do the thing.' };
  assert.deepEqual(attachTaskStateSlice(input), input, 'no resolver leaves the brief untouched');
  assert.deepEqual(attachTaskStateSlice(input, () => { throw new Error('graph down'); }), input);
  assert.deepEqual(attachTaskStateSlice(input, () => '(task state unavailable)'), input);
  assert.deepEqual(attachTaskStateSlice({}), {});
});

// ── metrics visibility ───────────────────────────────────────────────────

test('/metrics report exposes task-state usage', () => {
  seedGraph('sid-metrics');
  const report = buildSessionReport([], [], undefined, [], undefined);
  const line = report.lines.find((l) => l.startsWith('Task State Graph:'));
  assert.ok(line, 'metrics report carries a task-state line');
  assert.match(line, /2 requirements \(0 verified\)/);
  clearTaskStateServices();
  const empty = buildSessionReport([], [], undefined, [], undefined);
  const missing = empty.lines.find((l) => l.startsWith('Task State Graph:'));
  assert.ok(missing, 'metrics still reports when no graph exists');
  assert.match(missing, /no graph state|unavailable/);
});
