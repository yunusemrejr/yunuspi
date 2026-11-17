import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { AgentWorker, jsonLines } from '../desktop/agent-worker.mjs';
import { AgentSession } from '../core/coding-agent/src/core/agent-session.js';
import { validateDesktopImages } from '../desktop/recovered-input.mjs';
import { createConversation, stagePendingInput, settlePendingInput } from '../desktop/renderer/conversation.mjs';

const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const sections = [
  ['async function workerFor(', 'async function chooseProject('],
  ['async function sessionAction(', 'function createWindow('],
];
// Run the desktop handlers without creating a window or importing login-shell credentials.
const handlers = sections.map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end))).join('\n');

function startupRenderer() {
  const app = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
  const renderer = [['function clearHistoryReplay(', '// Under the transcript'], ['async function deliver(', '// The goal this session']]
    .map(([start, end]) => app.slice(app.indexOf(start), app.indexOf(end))).join('\n');
  const startup = Promise.withResolvers();
  const historyResponses = [];
  const input = { id: 'startup', draft: '' };
  const saved = Array.from({ length: 8 }, (_, index) => ({ id: `history-${index}`, draft: '' }));
  const conversations = new Map(), views = new Map(), attachments = new Map();
  const workspace = { sessions: [input, ...saved], runtime: [] };
  const noOp = () => {};
  let starting = false;
  const context = {
    workspace, conversations, views, attachments, activeId: null, switchVersion: 0, opening: false, lensText: '', lensReading: null,
    api: {
      openSession: id => id === input.id && starting ? historyResponses.shift() ?? startup.promise : { passive: true, messages: [], state: {} },
      prompt: () => { starting = true; return startup.promise; },
    },
    crypto: { randomUUID }, createConversation, stagePendingInput, settlePendingInput,
    current: () => workspace.sessions.find(s => s.id === context.activeId),
    conversationOf(id) {
      if (!conversations.has(id)) conversations.set(id, createConversation());
      return conversations.get(id);
    },
    viewOf(id) { if (!views.has(id)) views.set(id, { nodes: new Map() }); return views.get(id); },
    $: () => ({ replaceChildren: noOp, focus: noOp }), setEditorDraft: (_id, draft) => { input.draft = draft; }, safeError: error => error.message,
    saveView: noOp, closeCommandMenu: noOp, resizePrompt: noOp, scheduleLens: noOp, renderAttachments: noOp,
    renderSidebar: noOp, renderMessages: noOp, renderChrome: noOp, hideSidebarOnNarrow: noOp, renderActivity: noOp,
    renderContext: noOp, refreshRecoveredInput: async () => [], showNextExtension: noOp,
  };
  const api = runInNewContext(`${renderer}\n({ openSession, deliver });`, context);
  return { ...api, input, saved, conversations, views, attachments, startup, historyResponses };
}

test('browsing saved history during startup preserves a rejected prompt and its attachments', async () => {
  const { openSession, deliver, input, saved, conversations, attachments, startup } = startupRenderer();
  const images = [{ type: 'image', name: 'fixture.png', mimeType: 'image/png', data: 'AA==' }];
  await openSession(input.id);
  const pending = deliver(input.id, 'A draft awaiting startup', images, undefined, true);
  for (const history of saved) await openSession(history.id);
  const returning = openSession(input.id);
  startup.reject(Error('Fixture startup failed'));
  await Promise.all([pending, returning]);
  assert.equal(input.draft, 'A draft awaiting startup');
  assert.deepEqual(attachments.get(input.id), images);
  assert.equal(conversations.get(input.id).messages[0]?.failed, true);
});

test('switching sessions releases event replay for a superseded history read', async () => {
  const { openSession, deliver, input, saved, views, startup, historyResponses } = startupRenderer();
  const stale = Promise.withResolvers();
  historyResponses.push(stale.promise);
  const prompt = deliver(input.id, 'A draft awaiting startup', [], undefined, true);
  const firstRead = openSession(input.id);
  const abandoned = views.get(input.id).replay;
  abandoned.push({ sequence: 1, event: { type: 'agent_start' } });
  try {
    await openSession(saved[0].id);
    assert.equal(views.get(input.id).replay, undefined, 'background events must stop accumulating immediately');
    assert.equal(abandoned.length, 0);
    const reopened = openSession(input.id);
    const replay = views.get(input.id).replay;
    assert.ok(Array.isArray(replay));
    stale.reject(Error('Stale read failed'));
    await firstRead;
    assert.equal(views.get(input.id).replay, replay, 'the old request cannot clear a new replay');
    startup.reject(Error('Fixture startup failed'));
    await reopened;
    assert.equal(views.get(input.id).replay, undefined, 'the active read also releases replay after failure');
  } finally {
    stale.reject(Error('Fixture test finished'));
    startup.reject(Error('Fixture test finished'));
    await Promise.all([prompt, firstRead]);
  }
});

function fixture({ holdPrompt = false } = {}) {
  const trust = Promise.withResolvers(), trustStarted = Promise.withResolvers(), queueRead = Promise.withResolvers();
  const promptRead = Promise.withResolvers();
  const workers = new Map(), starting = new Map(), closing = new Map();
  const session = { projectId: 'project', state: 'open', title: 'Fixture', draft: 'existing' };
  const project = { id: 'project', path: '/fixture' };
  const queued = ['earlier accepted'], recovered = [], commands = [], spawned = [];
  const reply = (child, command, data) => child.stdout.write(JSON.stringify({ id: command.id, type: 'response', success: true, data }) + '\n');
  let respondToQueueRead;
  function spawnWorker() {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', () => child.emit('close', 0, null));
    const worker = new AgentWorker({ command: 'fixture', args: [], timeout: 1000, spawnProcess: () => child });
    child.stdin.on('data', jsonLines(command => {
      commands.push(command);
      if (command.type === 'get_state') queueMicrotask(() => reply(child, command, { isStreaming: false }));
      else if (command.type === 'clear_queue') {
        respondToQueueRead = refusal => {
          if (refusal) child.stdout.write(JSON.stringify({ id: command.id, type: 'response', success: false, error: refusal }) + '\n');
          else {
            const accepted = queued.splice(0); recovered.push(...accepted);
            reply(child, command, { recovery: { id: command.recoveryId, count: accepted.length } });
          }
        };
        queueRead.resolve(command);
      } else if (command.type === 'prompt') {
        queued.push(command.message);
        if (holdPrompt) promptRead.resolve(() => reply(child, command));
        else reply(child, command);
      }
    }, error => { throw error; }));
    spawned.push(worker);
    return worker;
  }
  const context = {
    workers, starting, closing, quitting: false, creationTail: Promise.resolve(), loginPath: Promise.resolve(),
    store: {
      session: () => session, project: () => project, transcriptDirectory: () => '/fixture/transcript',
      data: { sessions: [{ id: 'fixture', projectId: 'project' }] },
      setDraft: (_id, draft) => { session.draft = draft; }, update: (_id, patch) => Object.assign(session, patch),
      setProjectArchived: (_id, archived) => { project.archived = archived; if (archived) session.state = 'closed'; },
    },
    path, fs: { realpathSync: value => value, existsSync: () => true }, root: '/fixture', agentDir: '/fixture', process: { env: {} },
    randomUUID, validateDesktopImages,
    projectTrustStore: () => { trustStarted.resolve(); return trust.promise; },
    AgentWorker: function () { return spawnWorker(); },
    send() {}, publish() {}, text: value => value, window: {}, dialog: { showMessageBox: async () => ({ response: 1 }) },
  };
  const api = runInNewContext(`${handlers}\n({ workerFor, sessionAction, projectAction, dispatch });`, context);
  return { api, session, workers, closing, commands, spawned, trust, trustStarted, promptRead, queueRead, spawnWorker,
    recovered, releaseQueue: refusal => respondToQueueRead(refusal) };
}

test('closing or archiving invalidates a startup waiting for project trust, even after reopening', async () => {
  for (const archiveProject of [false, true]) {
    const f = fixture();
    const stale = assert.rejects(f.api.workerFor('fixture'), /no longer open/);
    await f.trustStarted.promise;
    if (archiveProject) {
      await f.api.projectAction('project', 'archive');
      await f.api.projectAction('project', 'restore');
    } else await f.api.sessionAction('fixture', 'close');
    assert.equal(f.session.state, 'closed');
    f.session.state = 'open';
    const fresh = f.api.workerFor('fixture');
    f.trust.resolve(new Map());
    await stale;
    const worker = await fresh;
    assert.equal(f.spawned.length, 1);
    assert.equal(f.workers.get('fixture'), worker);
    await worker.stop();
  }
});

test('close fences prompt admission before the queue snapshot and keeps both queued text and the draft', async () => {
  const f = fixture(), worker = f.spawnWorker();
  worker.busy = true;
  f.workers.set('fixture', worker);
  const closing = f.api.sessionAction('fixture', 'close');
  const command = await f.queueRead.promise;
  assert.equal(command.abortPendingInput, true);
  assert.ok(f.closing.has('fixture'));
  await assert.rejects(f.api.dispatch('prompt', { id: 'fixture', message: 'existing' }), /Session is closing/);
  await assert.rejects(f.api.workerFor('fixture'), /Session is closing/);
  assert.equal(f.session.draft, 'existing');
  f.releaseQueue();
  await closing;
  assert.deepEqual(f.commands.map(command => command.type), ['clear_queue']);
  assert.deepEqual(f.recovered, ['earlier accepted']);
  assert.equal(f.session.draft, 'existing');
  assert.equal(f.session.state, 'closed');
  assert.equal(worker.dead, true);
});

test('a matching draft acknowledged during close is captured only once', async () => {
  const f = fixture({ holdPrompt: true }), worker = f.spawnWorker();
  worker.busy = true;
  f.workers.set('fixture', worker);
  const sending = f.api.dispatch('prompt', { id: 'fixture', message: 'existing' });
  const acknowledge = await f.promptRead.promise;
  const closing = f.api.sessionAction('fixture', 'close');
  await f.queueRead.promise;
  acknowledge();
  await sending;
  assert.equal(f.session.draft, '');
  f.releaseQueue();
  await closing;
  assert.deepEqual(f.recovered, ['earlier accepted', 'existing']);
  assert.equal(f.session.draft, '');
});

test('a recovery refusal leaves the worker connected and the unsent draft alone', async () => {
  const f = fixture(), worker = f.spawnWorker();
  f.workers.set('fixture', worker);
  const closing = assert.rejects(f.api.sessionAction('fixture', 'close'), /Queued messages could not be saved.*Write failed/);
  await f.queueRead.promise;
  f.releaseQueue('Write failed');
  await closing;
  assert.equal(f.workers.get('fixture'), worker);
  assert.equal(f.closing.has('fixture'), false);
  assert.equal(f.session.state, 'open');
  assert.equal(f.session.draft, 'existing');
  assert.equal(worker.dead, false);
  await worker.stop();
});

test('close-only queue drain cancels unfinished preflight and preserves previously admitted input', async () => {
  for (const abortPendingInput of [false, true]) {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const admitted = [], preflight = [];
    const session = Object.assign(Object.create(AgentSession.prototype), {
      sessionManager: { getSessionId: () => 'fixture' }, _pendingInputControllers: new Set(), _inputQueueTail: Promise.resolve(),
      _extensionRunner: { hasHandlers: () => false }, _resourceLoader: { getPrompts: () => ({ prompts: [] }) },
      _isAgentRunActive: true, _steeringMessages: ['earlier accepted'], _followUpMessages: [], _emitQueueUpdate() {},
      agent: { clearAllQueues() {}, steer: message => admitted.push(message) },
      async _tryExecuteExtensionCommand() { started.resolve(); await release.promise; return false; },
    });
    const prompt = session.prompt('/unclaimed input', { streamingBehavior: 'steer', preflightResult: result => preflight.push(result) });
    await started.promise;
    assert.deepEqual(session.clearQueue({ abortPendingInput }), { steering: ['earlier accepted'], followUp: [] });
    release.resolve();
    if (abortPendingInput) await assert.rejects(prompt, /aborted/i);
    else await prompt;
    assert.deepEqual(preflight, [!abortPendingInput]);
    assert.equal(admitted.length, abortPendingInput ? 0 : 1);
  }
});
