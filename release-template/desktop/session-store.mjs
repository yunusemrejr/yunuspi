import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATES = new Set(['open', 'closed', 'archived']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const DELETING = /^\.deleting-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const label = (value, fallback) => typeof value === 'string' ? value.trim().slice(0, 120) || fallback : fallback;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validModel = value => record(value) && typeof value.provider === 'string' && value.provider.length > 0 && value.provider.length <= 120
  && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 240;

function validWorkspace(saved) {
  if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.projects) || !Array.isArray(saved.sessions)) return false;
  const projectIds = new Set();
  for (const project of saved.projects) {
    if (!record(project) || typeof project.id !== 'string' || !UUID.test(project.id) || projectIds.has(project.id)
      || typeof project.path !== 'string' || !path.isAbsolute(project.path) || typeof project.name !== 'string'
      || typeof project.trusted !== 'boolean') return false;
    projectIds.add(project.id);
  }
  const sessionIds = new Set();
  for (const session of saved.sessions) {
    if (!record(session) || typeof session.id !== 'string' || !UUID.test(session.id) || sessionIds.has(session.id)
      || !STATES.has(session.state) || !projectIds.has(session.projectId)
      || typeof session.title !== 'string' || session.title.length > 120
      || typeof session.draft !== 'string' || session.draft.length > 100_000
      || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
      || session.model !== undefined && !validModel(session.model)
      || session.thinkingLevel !== undefined && !THINKING_LEVELS.has(session.thinkingLevel)) return false;
    sessionIds.add(session.id);
  }
  return (saved.activeId === null || saved.sessions.some(s => s.id === saved.activeId && s.state === 'open'))
    && (saved.window === undefined || record(saved.window));
}

// One desktop instance owns this small index. Core JSONL remains the transcript
// authority; project memories and their vector index stay owned by the harness.
export class SessionStore {
  constructor(directory, { onSaveError = () => {} } = {}) {
    this.onSaveError = onSaveError;
    this.dirtyDrafts = new Set();
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw Error('Unsafe desktop workspace directory.');
    this.file = path.join(this.directory, 'workspace.json');
    this.data = { version: 1, projects: [], sessions: [], activeId: null, window: {} };
    if (fs.existsSync(this.file)) {
      try {
        if (!fs.lstatSync(this.file).isFile() || fs.lstatSync(this.file).isSymbolicLink()) throw Error('Unsafe workspace index.');
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!validWorkspace(saved)) throw Error('Invalid workspace records.');
        this.data = saved;
      } catch (cause) { throw Error('The desktop workspace index is invalid. Your transcripts were retained.', { cause }); }
    }
    this.recoverDeletions();
  }

  // Build changes in a candidate snapshot. A rejected patch or failed save must
  // never become visible in the running app while the disk still has old data.
  commit(change) {
    const previous = this.data;
    this.data = structuredClone(previous);
    try { const result = change(); this.save(); return result; }
    catch (error) { this.data = previous; throw error; }
  }

  save() {
    if (!validWorkspace(this.data)) throw Error('Invalid desktop workspace data.');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let descriptor, temporaryExists = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      temporaryExists = true;
      fs.writeFileSync(descriptor, JSON.stringify(this.data, null, 2) + '\n');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.file);
      temporaryExists = false;
      clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
      this.dirtyDrafts.clear();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (temporaryExists) fs.rmSync(temporary, { force: true });
    }
  }

  // Typing updates the live draft immediately, but coalesces disk writes. Other
  // successful mutations save staged drafts too; quit must flush before closing.
  setDraft(id, draft) {
    if (typeof draft !== 'string' || draft.length > 100_000) throw Error('Draft is too large.');
    const session = this.session(id);
    if (session.draft !== draft) {
      session.draft = draft;
      session.updatedAt = Date.now();
      this.dirtyDrafts.add(id);
    }
    if (this.dirtyDrafts.size) {
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => {
        this.draftTimer = undefined;
        try { this.flush(); } catch (error) { this.onSaveError(error); }
      }, 300);
      this.draftTimer.unref();
    }
    return session;
  }

  flush() { if (this.dirtyDrafts.size) this.save(); }

  snapshot() { return structuredClone(this.data); }
  project(id) {
    const project = this.data.projects.find(p => p.id === id);
    if (!project) throw Error('Project no longer exists.');
    return project;
  }
  session(id) {
    if (!UUID.test(id ?? '')) throw Error('Invalid session.');
    const session = this.data.sessions.find(s => s.id === id);
    if (!session) throw Error('Session no longer exists.');
    return session;
  }
  addProject(directory) {
    const canonical = fs.realpathSync(directory);
    if (!fs.statSync(canonical).isDirectory()) throw Error('Choose a project folder.');
    const existing = this.data.projects.find(p => p.path === canonical);
    if (existing) return existing;
    const project = { id: randomUUID(), path: canonical, name: path.basename(canonical) || canonical, trusted: false };
    return this.commit(() => { this.data.projects.push(project); return project; });
  }
  create(projectId) {
    this.project(projectId);
    if (this.data.sessions.length >= 2000) throw Error('The workspace contains 2,000 sessions. Delete unneeded sessions first.');
    const now = Date.now();
    const session = { id: randomUUID(), projectId, title: 'New session', state: 'open', createdAt: now, updatedAt: now, draft: '' };
    return this.commit(() => { this.data.sessions.push(session); this.data.activeId = session.id; return session; });
  }
  update(id, patch) {
    if (!record(patch) || Object.keys(patch).some(k => !['title', 'draft', 'model', 'thinkingLevel', 'state'].includes(k))) throw Error('Invalid session update.');
    const current = this.session(id), changes = {};
    if (patch.title !== undefined) changes.title = label(patch.title, 'New session');
    if (patch.draft !== undefined) {
      if (typeof patch.draft !== 'string' || patch.draft.length > 100_000) throw Error('Draft is too large.');
      changes.draft = patch.draft;
    }
    if (patch.model !== undefined) {
      if (!validModel(patch.model)) throw Error('Invalid model.');
      changes.model = { provider: patch.model.provider, id: patch.model.id };
    }
    if (patch.thinkingLevel !== undefined) {
      if (!THINKING_LEVELS.has(patch.thinkingLevel)) throw Error('Invalid thinking level.');
      changes.thinkingLevel = patch.thinkingLevel;
    }
    if (patch.state !== undefined) {
      if (!STATES.has(patch.state)) throw Error('Invalid session state.');
      changes.state = patch.state;
    }
    if (Object.entries(changes).every(([k, v]) => k === 'model' ? v.provider === current.model?.provider && v.id === current.model?.id : v === current[k])) return current;
    return this.commit(() => {
      const session = this.session(id);
      Object.assign(session, changes, { updatedAt: Date.now() });
      if (session.state !== 'open' && this.data.activeId === id) this.data.activeId = null;
      return session;
    });
  }
  activate(id) {
    const session = this.session(id);
    if (session.state === 'archived') throw Error('Restore this session before opening it.');
    if (session.state === 'open' && this.data.activeId === id) return session;
    return this.commit(() => { const opened = this.session(id); opened.state = 'open'; this.data.activeId = id; return opened; });
  }
  transcriptDirectory(id, create = true) {
    this.session(id);
    const directory = path.join(this.directory, 'transcripts', id);
    // Paths are derived from validated IDs, never from renderer-supplied paths.
    for (const part of [this.directory, path.join(this.directory, 'transcripts'), directory]) {
      if (fs.existsSync(part) && (fs.lstatSync(part).isSymbolicLink() || !fs.lstatSync(part).isDirectory())) throw Error('Unsafe transcript directory.');
    }
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  delete(id) {
    const directory = this.transcriptDirectory(id, false);
    const pending = fs.existsSync(directory) ? path.join(path.dirname(directory), `.deleting-${id}-${randomUUID()}`) : null;
    // Rename first so a failed index save can restore the entire transcript.
    // Startup finishes or rolls back this same operation after a process crash.
    if (pending) fs.renameSync(directory, pending);
    try {
      this.commit(() => {
        this.data.sessions = this.data.sessions.filter(s => s.id !== id);
        if (this.data.activeId === id) this.data.activeId = null;
      });
    } catch (error) {
      if (pending) {
        try { fs.renameSync(pending, directory); }
        catch (cause) { throw new AggregateError([error, cause], `Session was retained. Its transcript will be restored when YunusPi restarts: ${pending}`); }
      }
      throw error;
    }
    if (pending) {
      try { fs.rmSync(pending, { recursive: true, force: true }); }
      catch (cause) { throw Error('Session removed, but transcript cleanup failed. Restart YunusPi to retry cleanup.', { cause }); }
    }
  }

  recoverDeletions() {
    const transcripts = path.join(this.directory, 'transcripts');
    if (!fs.existsSync(transcripts)) return;
    if (fs.lstatSync(transcripts).isSymbolicLink() || !fs.lstatSync(transcripts).isDirectory()) throw Error('Unsafe transcript directory.');
    for (const name of fs.readdirSync(transcripts)) {
      const match = DELETING.exec(name);
      if (!match) continue;
      if (!fs.existsSync(this.file)) throw Error('The workspace index is missing. Pending transcripts were retained.');
      const pending = path.join(transcripts, name);
      if (fs.lstatSync(pending).isSymbolicLink() || !fs.lstatSync(pending).isDirectory()) throw Error('Unsafe pending transcript directory.');
      if (this.data.sessions.some(s => s.id === match[1])) {
        const directory = this.transcriptDirectory(match[1], false);
        if (fs.existsSync(directory)) throw Error('Conflicting transcript recovery folders. Both histories were retained.');
        fs.renameSync(pending, directory);
      } else fs.rmSync(pending, { recursive: true, force: true });
    }
  }
}
