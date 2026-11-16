import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { AgentWorker, jsonLines } from '../desktop/agent-worker.mjs';
import { AgentSession } from '../core/coding-agent/src/core/agent-session.js';

const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const sections = [
  ['async function workerFor(', 'async function chooseProject('],
  ['async function sessionAction(', 'function createWindow('],
];
// Run the desktop handlers without creating a window or importing login-shell credentials.
const handlers = sections.map(([start, end]) => source.slice(source.indexOf(start), source.indexOf(end))).join('\n');

function fixture({ holdPrompt = false } = {}) {
  const trust = Promise.withResolvers(), trustStarted = Promise.withResolvers(), queueRead = Promise.withResolvers();
  const promptRead = Promise.withResolvers();
  const workers = new Map(), starting = new Map(), closing = new Map();
  const session = { projectId: 'project', state: 'open', title: 'Fixture', draft: 'existing' };
  const project = { id: 'project', path: '/fixture' };
  const queued = ['earlier accepted'], commands = [], spawned = [];
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
        const steering = queued.splice(0);
        respondToQueueRead = () => reply(child, command, { steering, followUp: [] });
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
    projectTrustStore: () => { trustStarted.resolve(); return trust.promise; },
    AgentWorker: function () { return spawnWorker(); },
    send() {}, publish() {}, text: value => value, window: {}, dialog: { showMessageBox: async () => ({ response: 1 }) },
  };
  const api = runInNewContext(`${handlers}\n({ workerFor, sessionAction, projectAction, dispatch });`, context);
  return { api, session, workers, closing, commands, spawned, trust, trustStarted, promptRead, queueRead, spawnWorker, releaseQueue: () => respondToQueueRead() };
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
  assert.equal(f.session.draft, 'earlier accepted\n\nexisting');
  assert.equal(f.session.state, 'closed');
  assert.equal(worker.dead, true);
});

test('a matching draft acknowledged during close is restored from the queue only once', async () => {
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
  assert.equal(f.session.draft, 'earlier accepted\n\nexisting');
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
