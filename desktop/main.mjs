import { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, nativeTheme, clipboard } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SessionStore } from './session-store.mjs';
import { AgentWorker } from './agent-worker.mjs';
import { readHistory, closeHistoryReaders, cancelPendingHistoryReads } from './history-reader.mjs';
import { getRecoveredInput, listRecoveredInput, validateDesktopImages } from './recovered-input.mjs';
import { applyTeamValue, readTeam } from './renderer/team-settings.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);
const productVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
const pageURL = pathToFileURL(path.join(directory, 'renderer/index.html')).href;
app.setName('YunusPi');
app.setVersion(productVersion);
if (process.platform === 'linux') app.setDesktopName('yunuspi.desktop');
if (process.env.YUNUSPI_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.YUNUSPI_DESKTOP_DATA));
const workers = new Map(), starting = new Map(), closing = new Map();
const pendingLaunches = [];
const launchContext = { project: process.env.YUNUSPI_OPEN_PROJECT || process.cwd(), prompt: process.env.YUNUSPI_INITIAL_PROMPT || '' };
let window, store, quitting = false, quitReady = false;
// A dock or menu launch inherits the desktop session's environment, which lacks what a
// login shell adds: PATH entries (nvm, bun, cargo, npm globals) and the API keys the
// user exports in ~/.bashrc or ~/.profile (an ElevenLabs key there never reached desktop
// sessions, so narration fell back to a local voice). Merge both once, bounded; values
// the app already has win.
export const SHELL_KEYS = /^(?:[A-Z][A-Z0-9_]*_API_KEY|ELEVENLABS_[A-Z0-9_]+)$/;
export function shellKeys(output, marker, env) {
  for (const entry of String(output).slice(String(output).lastIndexOf(marker) + marker.length).split('\0')) {
    const name = entry.slice(0, entry.indexOf('='));
    if (SHELL_KEYS.test(name) && !env[name]) env[name] = entry.slice(name.length + 1);
  }
}
const loginPath = process.platform === 'win32' ? Promise.resolve() : new Promise(resolve => {
  const marker = '__YUNUSPI_PATH__';
  execFile(process.env.SHELL || '/bin/bash', ['-ilc', `printf '${marker}%s${marker}' "$PATH"; env -0`], { timeout: 6000, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, TERM: 'dumb' } }, (_error, stdout) => {
    const output = String(stdout ?? '');
    const found = new RegExp(`${marker}(.*?)${marker}`).exec(output)?.[1];
    if (found) {
      process.env.PATH = [...new Set([...found.split(path.delimiter), ...(process.env.PATH ?? '').split(path.delimiter)].filter(Boolean))].join(path.delimiter);
      shellKeys(output, marker, process.env);
    }
    resolve();
  });
});
let creationTail = Promise.resolve();
let historyOpenVersion = 0;

const send = value => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('yunuspi:event', value); };
const snapshot = () => ({ ...store.snapshot(), runtime: [...workers].map(([id, worker]) => ({ id, busy: worker.busy, status: starting.has(id) ? 'connecting' : worker.dead ? 'error' : 'ready' })), version: productVersion });
const publish = () => send({ type: 'workspace', data: snapshot() });
const text = (value, max = 100_000) => {
  if (typeof value !== 'string' || value.length > max) throw Error('Invalid text.');
  return value;
};
const idle = worker => { if (worker.busy) throw Error('Stop the current turn before changing this session.'); };
const accountingEntries = new Set(['auxiliary-model-usage-v1', 'subagent-cost-v1', 'subagent-lifecycle-v1', 'jev-usage-v1', 'span-usage-v1']);
function refreshWorkerStats(id, worker) {
  worker.statsDirty = true;
  if (worker.statsPending || workers.get(id) !== worker || worker.stopping) return;
  worker.statsDirty = false;
  worker.statsPending = true;
  void worker.request('get_session_stats', {}, 10_000).then(data => {
    if (workers.get(id) === worker) send({ type: 'stats', sessionId: id, data });
  }).catch(() => {}).finally(() => {
    worker.statsPending = false;
    if (worker.statsDirty) refreshWorkerStats(id, worker);
  });
}
const coreModule = name => import(pathToFileURL(path.join(root, 'core/coding-agent/dist/core', name)).href);
// Team settings in Settings: which model takes each kind of delegated work. The
// harness's own settings owner writes the global file, so every other key — of
// "team" and of the file — is kept as the locked writer finds it on disk.
//
// The Team lists exactly what a session's model menu lists, so it asks a session
// runtime — with the same extensions that publish the live catalog — instead of
// composing a catalog of its own. Settings is often open with no session worker
// resident; then a temporary one is started for the answer and stopped again.
const TEAM_MODELS_TTL = 60_000;
let teamModelsCache = null, teamModelsRequest = null;
function teamModelsSignature() {
  const parts = [];
  for (const file of ['models.json', 'live-model-catalog.json']) {
    try { const stat = fs.statSync(path.join(agentDir, file)); parts.push(`${file}:${stat.mtimeMs}:${stat.size}`); }
    catch { parts.push(`${file}:absent`); }
  }
  return parts.join('|');
}
async function tempWorkerModels() {
  const entry = path.join(root, 'core/coding-agent/dist/rpc-entry.js');
  if (!fs.existsSync(entry)) throw Error('Build the owned core with npm run build:core first.');
  await loginPath;
  const node = process.env.YUNUSPI_NODE_BINARY || 'node';
  const launcher = path.join(agentDir, 'scripts/pi-launch.sh');
  const args = [entry, '--no-session', '--no-approve'];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_SESSION: '1', PI_SUBAGENT_PI_BINARY: path.join(agentDir, 'bin/yunuspi') };
  delete env.ELECTRON_RUN_AS_NODE;
  const worker = new AgentWorker({ command: fs.existsSync(launcher) ? '/bin/bash' : node, args: fs.existsSync(launcher) ? [launcher, node, ...args] : args, cwd: agentDir, env });
  try {
    const { models } = await worker.request('get_available_models', {}, 90_000);
    return models;
  } finally { await worker.stop(); }
}
async function liveModels() {
  const kept = [...workers.values()].filter(worker => !worker.dead);
  const resident = kept.find(worker => !worker.busy) ?? kept[0];
  if (resident) return (await resident.request('get_available_models')).models;
  return tempWorkerModels();
}
async function availableForTeam() {
  const signature = teamModelsSignature();
  if (teamModelsCache && teamModelsCache.signature === signature && Date.now() - teamModelsCache.at < TEAM_MODELS_TTL) return teamModelsCache.models;
  if (!teamModelsRequest) {
    // A save or a catalog change while a request is in flight must not leave its
    // older answer cached for the next minute.
    const started = signature;
    teamModelsRequest = liveModels()
      .then(models => {
        const answer = models.map(model => ({ provider: model.provider, id: model.id, ...(typeof model.name === 'string' && model.name ? { name: model.name } : {}) }));
        if (teamModelsSignature() === started) teamModelsCache = { signature: started, at: Date.now(), models: answer };
        return answer;
      })
      .finally(() => { teamModelsRequest = null; });
  }
  return teamModelsRequest;
}
async function teamSettingsManager() {
  const { SettingsManager } = await coreModule('settings-manager.js');
  // Only the global file is read and written here; the project scope stays untouched.
  return SettingsManager.create(agentDir, agentDir);
}
// Commands the renderer answers itself; they never reach the core.
const DESKTOP_COMMANDS = ['model', 'models', 'metrics', 'cost', 'self', 'session', 'skills', 'tools', 'help', 'new', 'name'];

// A typed command is checked against the session's real command list before it
// is sent, so a near miss is offered as a correction instead of being dropped
// from a boost chain or sent to the model as a paid prompt.
// The composer also calls this while typing: `tokens` mark each command where it stands, so
// the user sees what is a command, what chains and what would be sent as plain words.
async function checkCommand(id, message) {
  const [{ correctSlashCommands, commandTokens }, { BUILTIN_SLASH_COMMANDS }] = await Promise.all([coreModule('command-correction.js'), coreModule('slash-commands.js')]);
  const { commands } = await (await workerFor(id)).request('get_commands');
  const terminal = [...BUILTIN_SLASH_COMMANDS.map(c => c.name).filter(name => !DESKTOP_COMMANDS.includes(name)), ...commands.filter(c => c.interactiveOnly).map(c => c.name)];
  const names = { commands: [...commands.filter(c => c.source !== 'skill').map(c => c.name), ...DESKTOP_COMMANDS, ...terminal], chainable: commands.filter(c => c.chainable).map(c => c.name) };
  const result = correctSlashCommands(message, names);
  const tokens = commandTokens(message, names);
  const head = /^\s*\/([\w-]+)(?=\s|$)/.exec(result?.text ?? message)?.[1];
  // Never offer a correction that would then be sent: a terminal-only command is only explained.
  if (head && terminal.includes(head)) return { text: message, fixes: [], terminalOnly: `/${head}`, tokens };
  return { text: message, fixes: [], ...result, tokens };
}

async function projectTrustStore() {
  const { ProjectTrustStore } = await import(pathToFileURL(path.join(root, 'core/coding-agent/dist/core/trust-manager.js')).href);
  return new ProjectTrustStore(agentDir);
}
function receiveLaunch(context) {
  if (!context || typeof context.prompt !== 'string' || !context.prompt.trim() || context.prompt.length > 100_000 || typeof context.project !== 'string' || context.project.length > 4096) return;
  if (!store) { pendingLaunches.push(context); return; }
  const project = store.addProject(context.project), session = store.create(project.id);
  store.update(session.id, { draft: context.prompt }); publish();
  send({ type: 'open-session', sessionId: session.id });
}

async function savedHistory(id, { before, revision, statsOnly } = {}) {
  const session = store.session(id), project = store.project(session.projectId), transcriptRoot = store.transcriptDirectory(id, false);
  if (revision === undefined && before === undefined && !statsOnly) {
    const files = await fs.promises.readdir(transcriptRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!files.some(file => file.endsWith('.jsonl'))) return { messages: [], before: 0, hasMore: false, total: 0, isStreaming: false, streamingMessage: null };
  }
  return readHistory({ directory: transcriptRoot, sessionId: id, cwd: project.path, before, revision, statsOnly, limit: 80, coreRoot: path.join(root, 'core/coding-agent') });
}

const isWorkerHistory = revision => typeof revision === 'string' && revision.startsWith('worker:');

async function workerFor(id) {
  if (quitting) throw Error('YunusPi is shutting down.');
  if (closing.has(id)) throw Error('Session is closing.');
  if (store.session(id).state !== 'open') throw Error('Open this session first.');
  if (starting.has(id)) return starting.get(id);
  if (workers.has(id) && !workers.get(id).dead) return workers.get(id);
  const priorCreation = creationTail;
  let releaseCreation;
  creationTail = new Promise(resolve => { releaseCreation = resolve; });
  const requireAdmission = () => {
    if (starting.get(id) !== ready || closing.has(id) || quitting) throw Error('Session is no longer open.');
    const session = store.session(id);
    if (session.state !== 'open') throw Error('Session is no longer open.');
    return session;
  };
  const ready = (async () => {
    await priorCreation;
    try {
      await loginPath;
      const project = store.project(requireAdmission().projectId);
      // Even a fresh extension lifecycle can arm project schedules. A quiet model
      // is not an inactivity lease; only an explicit close may stop that runtime.
      // History browsing itself does not start a runtime or consume these slots.
      if (workers.size >= 8) throw Error('Eight session workers are resident. Close a session to free a worker; its history will be retained.');
      const node = process.env.YUNUSPI_NODE_BINARY || 'node';
      const entry = path.join(root, 'core/coding-agent/dist/rpc-entry.js');
      if (!fs.existsSync(entry)) throw Error('Build the owned core with npm run build:core first.');
      const launcher = path.join(agentDir, 'scripts/pi-launch.sh');
      const trusted = (await projectTrustStore()).get(project.path) === true;
      // A close can complete while the import is pending, even if the same tab
      // is opened again. The startup must still hold its original reservation.
      const session = requireAdmission();
      if (fs.realpathSync(project.path) !== project.path) throw Error('Project path changed. Reopen its folder.');
      const args = [entry, '--session-id', id, '--session-dir', store.transcriptDirectory(id), trusted ? '--approve' : '--no-approve'];
      if (session.model) args.push('--provider', session.model.provider, '--model', session.model.id);
      if (session.thinkingLevel) args.push('--thinking', session.thinkingLevel);
      const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DESKTOP_SESSION: '1', YUNUSPI_CORE_ROOT: path.dirname(path.dirname(entry)), PI_SUBAGENT_PI_BINARY: path.join(agentDir, 'bin/yunuspi') };
      delete env.ELECTRON_RUN_AS_NODE;
      const worker = new AgentWorker({ command: fs.existsSync(launcher) ? '/bin/bash' : node, args: fs.existsSync(launcher) ? [launcher, node, ...args] : args, cwd: project.path, env });
      worker.uiRequests = new Set();
      workers.set(id, worker);
      worker.on('event', (event, sequence) => {
        if (workers.get(id) !== worker) return;
        if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) worker.uiRequests.add(event.id);
        if (event.type === 'extension_ui_closed') worker.uiRequests.delete(event.id);
        // Keep workspace.json in step with the session's real effort level: automatic
        // changes (economy/adaptive, model-switch remap) only reach the transcript.
        // workerFor() re-passes the cached level as `--thinking` on the next start
        // (line 114), which would otherwise reopen the session at a stale level.
        if (event.type === 'thinking_level_changed' && typeof event.level === 'string') {
          try { store.update(id, { thinkingLevel: event.level }); } catch { /* a stale cache is recoverable next start */ }
        }
        send({ type: 'agent', sessionId: id, event, sequence });
        if (event.type === 'agent_start' || event.type === 'agent_end') publish();
        // Detached work and helpers can settle after the final turn, while the
        // session is idle. Coalesce bursts and guarantee a follow-up for changes
        // made while an earlier request was in flight.
        if (event.type === 'turn_end' || event.type === 'agent_end' ||
          event.type === 'entry_appended' && accountingEntries.has(event.entry?.customType)) refreshWorkerStats(id, worker);
      });
      worker.on('stopped', result => {
        if (workers.get(id) !== worker) return;
        workers.delete(id);
        if (!result.expected) send({ type: 'failure', sessionId: id, message: result.message || 'Agent stopped unexpectedly. Reopen the session to reconnect.' });
        publish();
      });
      publish();
      return worker.request('get_state').then(state => {
        requireAdmission();
        if (workers.get(id) !== worker) throw Error('Session worker stopped during startup.');
        worker.busy = state.isStreaming;
        if (state.model) store.update(id, { model: { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel });
        send({ type: 'state', sessionId: id, data: state });
        return worker;
      }).catch(async error => {
        if (workers.get(id) === worker && !closing.has(id)) await worker.stop();
        throw error;
      });
    } finally { releaseCreation(); }
  })().finally(() => {
    if (starting.get(id) === ready) starting.delete(id);
    publish();
  });
  starting.set(id, ready);
  return ready;
}

function stop(id, finish, { preserveQueue = true } = {}) {
  if (closing.has(id)) return closing.get(id);
  const worker = workers.get(id);
  // Mark closure before the drain starts. A cancelled reservation may still
  // resolve an import or ready response, but it can no longer admit a worker.
  const pending = Promise.resolve().then(async () => {
    if (worker) {
      if (preserveQueue && !worker.dead) {
        const recoveryId = randomUUID();
        const result = await worker.request('clear_queue', { abortPendingInput: true, recoveryId }, 20_000)
          .catch(error => { throw Error(`Queued messages could not be saved. The session stays open. ${error.message}`); });
        if (result?.recovery?.id !== recoveryId || !Number.isSafeInteger(result.recovery.count) || result.recovery.count < 0) {
          throw Error('The worker did not confirm queue recovery. The session stays open.');
        }
      }
      await worker.stop();
    }
    finish?.();
  }).finally(() => {
    if (worker?.dead && workers.get(id) === worker) workers.delete(id);
    if (closing.get(id) === pending) closing.delete(id);
    publish();
  });
  closing.set(id, pending);
  starting.delete(id);
  return pending;
}

async function chooseProject() {
  const result = await dialog.showOpenDialog(window, { title: 'Open a project', properties: ['openDirectory'] });
  if (result.canceled) return null;
  const project = store.addProject(result.filePaths[0]);
  const trust = await projectTrustStore(), known = trust.get(project.path);
  // Choosing a folder alone does not execute its local extensions or hooks.
  if (typeof known === 'boolean') store.commit(() => { store.project(project.id).trusted = known; });
  else if (fs.existsSync(path.join(project.path, '.pi'))) {
    const consent = await dialog.showMessageBox(window, { type: 'question', title: 'Project extensions', message: `Trust ${project.name}?`, detail: 'Trusted projects can load their local .pi extensions, hooks and settings. Open safely to use only your global harness.', buttons: ['Open safely', 'Trust project'], defaultId: 0, cancelId: 0 });
    trust.set(project.path, consent.response === 1);
    store.commit(() => { store.project(project.id).trusted = consent.response === 1; });
  }
  publish();
  return project;
}

async function sessionAction(id, action) {
  const session = store.session(id);
  if (!['close', 'archive', 'restore', 'delete'].includes(action)) throw Error('Unknown session action.');
  const worker = workers.get(id);
  if (action === 'delete' || worker?.busy && action !== 'restore') {
    const result = await dialog.showMessageBox(window, { type: action === 'delete' ? 'warning' : 'question', message: action === 'delete' ? `Delete “${session.title}”?` : `Stop “${session.title}”?`, detail: action === 'delete' ? 'This permanently deletes this desktop session’s transcript, draft, and saved queued messages. Shared project memories and project files are kept.' : 'The current turn will stop. Your conversation and queued messages are saved and can be resumed.', buttons: ['Cancel', action === 'delete' ? 'Delete session' : 'Stop and continue'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response === 0) return { cancelled: true };
  }
  if (closing.has(id)) throw Error('Session is closing.');
  if (action === 'restore') store.update(id, { state: 'closed' });
  else await stop(id, () => {
    if (action === 'delete') store.delete(id);
    else store.update(id, { state: action === 'archive' ? 'archived' : 'closed' });
  }, { preserveQueue: action !== 'delete' });
  publish();
  return { cancelled: false };
}

async function projectAction(id, action) {
  const project = store.project(text(id, 40));
  if (!['archive', 'restore'].includes(action)) throw Error('Unknown project action.');
  if (action === 'archive') {
    const running = store.data.sessions.filter(s => s.projectId === project.id && (workers.has(s.id) || starting.has(s.id)));
    if (running.some(s => workers.get(s.id)?.busy)) {
      const result = await dialog.showMessageBox(window, { type: 'question', message: `Stop running sessions in “${project.name}”?`, detail: 'Archiving the project stops its sessions. Conversations are saved; restore the project from Archive to continue them.', buttons: ['Cancel', 'Stop and archive'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 0) return { cancelled: true };
    }
    const results = await Promise.allSettled(running.map(s => stop(s.id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  store.setProjectArchived(project.id, action === 'archive');
  publish();
  return { cancelled: false };
}

async function dispatch(action, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid action.');
  switch (action) {
    case 'snapshot': return snapshot();
    case 'chooseProject': return chooseProject();
    case 'createSession': { const session = store.create(text(input.projectId, 40)); publish(); return session; }
    case 'openSession': {
      const version = ++historyOpenVersion;
      await cancelPendingHistoryReads();
      if (version !== historyOpenVersion) throw Error('A newer session open superseded this request.');
      store.activate(input.id); publish();
      if (!workers.has(input.id) && !starting.has(input.id)) {
        const session = store.session(input.id);
        const revision = isWorkerHistory(input.revision) ? undefined : input.revision;
        return { state: { model: session.model, thinkingLevel: session.thinkingLevel, isStreaming: false }, ...await savedHistory(input.id, { revision }), sequence: 0, passive: true };
      }
      const worker = await workerFor(input.id);
      const reuse = input.revision === worker.historyRevision;
      const [state, history] = await Promise.all([worker.request('get_state'), reuse ? Promise.resolve({ data: {}, sequence: worker.sequence }) : worker.requestWithBoundary('get_messages', { projection: 'desktop', limit: 80 })]);
      return { state: { ...state, isStreaming: history.data.isStreaming ?? worker.busy }, ...history.data, sequence: history.sequence, revision: worker.historyRevision };
    }
    case 'warm': await workerFor(input.id); return;
    case 'history': {
      const { id, revision, before, anchor } = input;
      // A numeric index addresses the source that supplied it. Warming a
      // session does not transfer saved cursors to the live process.
      if (!isWorkerHistory(revision)) return savedHistory(id, { before, revision });
      if (workers.get(id)?.historyRevision !== revision) return { reset: true };
      const worker = await workerFor(id);
      if (worker.historyRevision !== revision) return { reset: true };
      return worker.request('get_messages', { projection: 'desktop', limit: 80, before, anchor });
    }
    case 'recoveredInput': return listRecoveredInput(store.transcriptDirectory(input.id, false), input.id);
    case 'reviewRecoveredInput': return getRecoveredInput(store.transcriptDirectory(input.id, false), input.id, input.batchId, input.messageId);
    case 'sendRecoveredInput': {
      const { id, batchId, messageId, digest } = input;
      const item = await getRecoveredInput(store.transcriptDirectory(id, false), id, batchId, messageId);
      if (item.digest !== digest) throw Error('The saved message changed. Review it again before sending.');
      const worker = await workerFor(id);
      if (closing.has(id) || quitting || workers.get(id) !== worker || worker.stopping) throw Error('Session is closing.');
      return worker.request('prompt', { message: item.text, images: item.images, streamingBehavior: item.kind, recoveryMessageId: item.id });
    }
    case 'updateSession': {
      if (!input.patch || Object.keys(input.patch).some(k => !['title', 'draft'].includes(k))) throw Error('Invalid session update.');
      if (Object.keys(input.patch).length === 1 && input.patch.draft !== undefined) { store.setDraft(input.id, text(input.patch.draft)); return; }
      const result = store.update(input.id, input.patch); publish(); return result;
    }
    case 'sessionAction': return sessionAction(input.id, input.action);
    case 'projectAction': return projectAction(input.id, input.action);
    case 'prompt': {
      const message = text(input.message);
      const images = validateDesktopImages(input.images ?? []);
      if (!message.trim() && !images.length) throw Error('Write a message or attach an image.');
      const worker = await workerFor(input.id);
      if (closing.has(input.id) || quitting || workers.get(input.id) !== worker || worker.stopping) throw Error('Session is closing.');
      const { draft, updatedAt } = store.session(input.id);
      // During a run, Enter steers: the agent reads the message at its next step. Every message used to
      // wait for the whole run, so "you don't have to use Blender" arrived 49 minutes and a finished render
      // later. Alt+Enter still queues a message for after the run.
      const result = await worker.request('prompt', { message, images, streamingBehavior: input.delivery === 'followUp' ? 'followUp' : 'steer',
        desktopInputId: input.desktopInputId });
      if (workers.get(input.id) === worker) {
        const session = store.session(input.id);
        if (draft.trim() === message.trim() && session.draft === draft && session.updatedAt === updatedAt) store.setDraft(input.id, '');
        if (!closing.has(input.id) && session.title === 'New session') store.update(input.id, { title: message.slice(0, 72) });
      }
      publish(); return result;
    }
    case 'abort': return (await workerFor(input.id)).request('abort', {}, 20_000);
    case 'models': {
      const worker = await workerFor(input.id);
      const [models, thinking] = await Promise.all([worker.request('get_available_models'), worker.request('get_available_thinking_levels')]);
      return { ...models, ...thinking };
    }
    case 'setModel': {
      const worker = await workerFor(input.id); idle(worker);
      const model = await worker.request('set_model', { provider: text(input.provider, 120), modelId: text(input.modelId, 240) });
      store.update(input.id, { model: { provider: model.provider, id: model.id } });
      const state = await worker.request('get_state'); send({ type: 'state', sessionId: input.id, data: state }); publish(); return state;
    }
    case 'setThinking': {
      const worker = await workerFor(input.id); idle(worker);
      const { levels } = await worker.request('get_available_thinking_levels');
      if (!levels.includes(input.level)) throw Error('Thinking level is unavailable for this model.');
      await worker.request('set_thinking_level', { level: input.level });
      store.update(input.id, { thinkingLevel: input.level }); publish(); return input.level;
    }
    // A passive /cost refresh only reads transcript accounting.
    case 'stats': return workers.has(input.id) ? (await workerFor(input.id)).request('get_session_stats') : (await savedHistory(input.id, { statsOnly: true })).stats;
    case 'commands': return (await workerFor(input.id)).request('get_commands');
    case 'checkCommand': return checkCommand(input.id, text(input.message));
    case 'extensionResponse': {
      const worker = workers.get(input.id);
      if (!worker) return;
      const response = input.response;
      if (!response || typeof response.id !== 'string' || Object.keys(response).some(k => !['id', 'cancelled', 'value', 'confirmed'].includes(k))
        || response.value !== undefined && (typeof response.value !== 'string' || response.value.length > 100_000)
        || response.confirmed !== undefined && typeof response.confirmed !== 'boolean'
        || response.cancelled !== undefined && typeof response.cancelled !== 'boolean') throw Error('Invalid dialog response.');
      worker.uiRequests.delete(response.id);
      worker.write({ ...response, type: 'extension_ui_response' }); return;
    }
    case 'chooseImages': {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      if (result.canceled) return [];
      if (result.filePaths.length > 6) throw Error('Choose at most six images.');
      if (result.filePaths.reduce((sum, file) => sum + fs.statSync(file).size, 0) > 10 * 1024 * 1024) throw Error('Attachments together must be smaller than 10 MiB.');
      return result.filePaths.map(file => {
        if (fs.statSync(file).size > 10 * 1024 * 1024) throw Error('Each image must be smaller than 10 MiB.');
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()];
        if (!mime) throw Error('Unsupported image.');
        return { type: 'image', mimeType: mime, data: fs.readFileSync(file).toString('base64'), name: path.basename(file) };
      });
    }
    case 'openExternal': {
      const url = new URL(text(input.url, 4000));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Unsupported link.');
      await shell.openExternal(url.href); return;
    }
    case 'copyText': clipboard.writeText(text(input.value, 1_000_000)); return;
    case 'openData': await shell.openPath(store.directory); return;
    case 'exportSession': {
      const worker = await workerFor(input.id);
      const result = await dialog.showSaveDialog(window, { defaultPath: 'YunusPi-session.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (!result.canceled) await worker.request('export_html', { outputPath: result.filePath });
      return;
    }
    case 'importSession': {
      const result = await dialog.showOpenDialog(window, { title: 'Resume an existing YunusPi session', defaultPath: path.join(agentDir, 'sessions'), filters: [{ name: 'Session transcript', extensions: ['jsonl'] }], properties: ['openFile'] });
      if (result.canceled) return null;
      const source = result.filePaths[0];
      if (fs.statSync(source).size > 64 * 1024 * 1024) throw Error('This transcript is larger than the 64 MiB import limit.');
      const transcript = fs.readFileSync(source, 'utf8');
      const header = JSON.parse(transcript.slice(0, transcript.indexOf('\n')));
      if (header.type !== 'session' || typeof header.cwd !== 'string') throw Error('Not a YunusPi session transcript.');
      const project = store.addProject(header.cwd), session = store.create(project.id);
      // Import under a new session identity; retain all branch entry IDs and the
      // original file. Never overwrite or later delete the imported source.
      const imported = JSON.stringify({ ...header, id: session.id }) + transcript.slice(transcript.indexOf('\n'));
      fs.writeFileSync(path.join(store.transcriptDirectory(session.id), `import_${session.id}.jsonl`), imported, { flag: 'wx', mode: 0o600 });
      session.title = 'Imported session'; store.save(); publish(); return session;
    }
    case 'saveCredential': {
      const provider = text(input.provider, 120), key = text(input.key, 8192).trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !key) throw Error('Enter a provider ID and API key.');
      const { AuthStorage } = await import(pathToFileURL(path.join(root, 'core/coding-agent/dist/core/auth-storage.js')).href);
      await AuthStorage.create(path.join(agentDir, 'auth.json')).modify(provider, () => ({ type: 'api_key', key }));
      teamModelsCache = null;
      return;
    }
    case 'teamSettings': {
      const manager = await teamSettingsManager();
      return { team: readTeam(manager.getGlobalSettings().team), models: await availableForTeam() };
    }
    case 'setTeam': {
      const role = text(input.role, 20), value = text(input.value, 300);
      applyTeamValue(await teamSettingsManager(), role, value);
      // The writer reports storage failures instead of throwing; read the file
      // back so a change that did not land is never shown as saved.
      const saved = readTeam((await teamSettingsManager()).getGlobalSettings().team);
      if (saved[role] !== value) throw Error('The team setting could not be saved. Check that the harness settings file is writable.');
      return saved;
    }
    default: throw Error('Unknown desktop action.');
  }
}

function createWindow() {
  const saved = store.data.window || {}, display = screen.getPrimaryDisplay().workArea;
  const bounds = { width: Math.min(Math.max(Number(saved.width) || 1320, 560), display.width), height: Math.min(Math.max(Number(saved.height) || 860, 420), display.height) };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some(d => saved.x >= d.workArea.x && saved.y >= d.workArea.y && saved.x + 160 < d.workArea.x + d.workArea.width && saved.y + 80 < d.workArea.y + d.workArea.height)) Object.assign(bounds, { x: saved.x, y: saved.y });
  window = new BrowserWindow({ ...bounds, minWidth: 560, minHeight: 420, title: 'YunusPi', icon: path.join(directory, 'renderer/assets/app-icon.png'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191f' : '#f8f9fc', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (window && !window.isDestroyed()) {
      try { store.commit(() => { store.data.window = { ...window.getNormalBounds(), maximized: window.isMaximized() }; }); }
      catch (error) { send({ type: 'failure', message: `Window state could not be saved: ${error.message}` }); }
    } }, 300);
  };
  window.on('resize', saveBounds); window.on('move', saveBounds);
  window.on('closed', () => { clearTimeout(saveTimer); window = null; });
  window.once('ready-to-show', () => { if (saved.maximized) window.maximize(); window.show(); });
  void window.loadURL(pageURL);
}

if (!app.requestSingleInstanceLock(launchContext)) app.quit();
else {
  app.on('second-instance', (_event, _argv, _cwd, context) => {
    try { receiveLaunch(context); }
    catch (error) { send({ type: 'failure', message: error.message }); }
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  void app.whenReady().then(async () => {
  try {
    store = new SessionStore(app.getPath('userData'), { onSaveError: error => send({ type: 'failure', message: `Draft could not be saved: ${error.message}` }) });
    if (process.env.YUNUSPI_INITIAL_PROMPT) {
      const project = store.addProject(process.env.YUNUSPI_OPEN_PROJECT || os.homedir());
      const session = store.create(project.id); store.update(session.id, { draft: process.env.YUNUSPI_INITIAL_PROMPT.slice(0, 100_000) });
    }
    for (const context of pendingLaunches.splice(0)) receiveLaunch(context);
  }
  catch (error) { dialog.showErrorBox('YunusPi workspace', error.message); app.exit(1); }
  ipcMain.handle('yunuspi:action', async (event, action, input) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageURL) throw Error('Untrusted desktop sender.');
    return dispatch(action, input);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => send({ type: 'shortcut', action: 'newSession' }) },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send({ type: 'shortcut', action: 'openProject' }) },
      { label: 'Import Session…', click: () => send({ type: 'shortcut', action: 'importSession' }) },
      { type: 'separator' },
      { label: 'Close Session', accelerator: 'CmdOrCtrl+W', click: () => send({ type: 'shortcut', action: 'closeSession' }) },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send({ type: 'shortcut', action: 'settings' }) },
      { type: 'separator' }, { role: 'quit', accelerator: 'CmdOrCtrl+Q' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Find Sessions', accelerator: 'CmdOrCtrl+K', click: () => send({ type: 'shortcut', action: 'search' }) },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send({ type: 'shortcut', action: 'sidebar' }) },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Keyboard Shortcuts', click: () => send({ type: 'shortcut', action: 'help' }) }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    void (async () => {
      if ([...workers.values()].some(w => w.busy) && window) {
        const result = await dialog.showMessageBox(window, { type: 'question', message: 'Stop running sessions and quit?', detail: 'Conversations are saved. Running turns will be interrupted.', buttons: ['Keep working', 'Stop and quit'], defaultId: 0, cancelId: 0 });
        if (result.response === 0) return;
      }
      quitting = true;
      const stops = await Promise.allSettled([...new Set([...workers.keys(), ...starting.keys()])].map(id => stop(id)));
      const failed = stops.find(result => result.status === 'rejected');
      if (failed) {
        quitting = false;
        if (window && !window.isDestroyed()) send({ type: 'failure', message: failed.reason.message });
        else { createWindow(); dialog.showErrorBox('YunusPi remains open', failed.reason.message); }
        return;
      }
      await closeHistoryReaders();
      try { store.flush(); }
      catch (error) {
        quitting = false;
        send({ type: 'failure', message: `Your draft could not be saved. YunusPi remains open: ${error.message}` });
        return;
      }
      quitReady = true; app.quit();
    })();
  });
  }).catch(error => { dialog.showErrorBox('YunusPi', error.message); app.exit(1); });
}
