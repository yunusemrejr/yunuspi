import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../desktop/session-store.mjs';

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-desktop-store-'));
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(projectPath);
  const store = new SessionStore(path.join(root, 'desktop'), options);
  t.after(() => { clearTimeout(store.draftTimer); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.addProject(projectPath);
  const session = store.create(project.id);
  const transcript = path.join(store.transcriptDirectory(session.id), 'session.jsonl');
  fs.writeFileSync(transcript, 'retained session history\n');
  return { root, projectPath, store, project, session, transcript };
}

function failIndexSave(t, store) {
  const rename = fs.renameSync;
  return t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === store.file) throw Object.assign(Error('Disk write refused'), { code: 'EIO' });
    return rename(source, target);
  });
}

test('multiple projects and same-project sessions keep independent state across restarts', t => {
  const { root, projectPath, store, project, session } = fixture(t);
  const alias = path.join(root, 'project-alias');
  fs.symlinkSync(projectPath, alias);
  assert.equal(store.addProject(alias).id, project.id);
  const second = store.create(project.id);
  const anotherPath = path.join(root, 'other-project');
  fs.mkdirSync(anotherPath);
  const another = store.create(store.addProject(anotherPath).id);
  store.update(session.id, { title: 'First task', draft: 'First draft', model: { provider: 'example', id: 'model-a' }, thinkingLevel: 'high' });
  store.update(second.id, { draft: 'Second draft', state: 'archived' });
  assert.throws(() => store.activate(second.id), /Restore/);
  store.update(second.id, { state: 'closed' });
  store.activate(second.id);
  const reopened = new SessionStore(store.directory);
  assert.equal(reopened.data.activeId, second.id);
  assert.equal(reopened.session(session.id).draft, 'First draft');
  assert.deepEqual(reopened.session(session.id).model, { provider: 'example', id: 'model-a' });
  assert.equal(reopened.session(session.id).thinkingLevel, 'high');
  assert.equal(reopened.session(second.id).draft, 'Second draft');
  assert.notEqual(reopened.session(another.id).projectId, project.id);
  assert.notEqual(store.transcriptDirectory(session.id), store.transcriptDirectory(second.id));
  const snapshot = store.snapshot(); snapshot.sessions[0].title = 'external mutation';
  assert.equal(store.session(session.id).title, 'First task');
});

test('rejected mixed patches never apply earlier fields or alter the saved index', t => {
  const { store, session } = fixture(t);
  const before = store.snapshot(), disk = fs.readFileSync(store.file, 'utf8');
  for (const patch of [
    { title: 'Must not stick', draft: [] },
    { draft: 'Must not stick', model: { provider: '', id: 'example' } },
    { title: 'Must not stick', thinkingLevel: 'unsupported' },
    { draft: 'Must not stick', state: 'unsupported' },
    { title: 'Must not stick', unexpected: true },
  ]) {
    assert.throws(() => store.update(session.id, patch));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  }
});

test('failed create, project addition, activation and edits leave memory and disk consistent', async t => {
  for (const action of ['create', 'addProject', 'activate', 'update']) await t.test(action, t => {
    const { root, store, project, session } = fixture(t);
    store.update(session.id, { state: 'closed' });
    const nextPath = path.join(root, 'next-project'); fs.mkdirSync(nextPath);
    const before = store.snapshot(), disk = fs.readFileSync(store.file, 'utf8');
    failIndexSave(t, store);
    assert.throws(() => {
      if (action === 'create') store.create(project.id);
      if (action === 'addProject') store.addProject(nextPath);
      if (action === 'activate') store.activate(session.id);
      if (action === 'update') store.update(session.id, { title: 'Unsaved edit', draft: 'Unsaved draft' });
    }, /Disk write refused/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
    assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.tmp')), false);
  });
});

test('deleting a session rolls back its complete transcript when saving the index fails', t => {
  const { store, session, transcript } = fixture(t);
  const before = store.snapshot(), disk = fs.readFileSync(store.file, 'utf8');
  failIndexSave(t, store);
  assert.throws(() => store.delete(session.id), /Disk write refused/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  assert.equal(fs.readFileSync(transcript, 'utf8'), 'retained session history\n');
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(transcript))), [session.id]);
});

test('a failed flush before atomic rename leaves the existing index untouched', t => {
  const { store, session } = fixture(t), before = store.snapshot(), disk = fs.readFileSync(store.file, 'utf8');
  t.mock.method(fs, 'fsyncSync', () => { throw Error('Flush refused'); });
  assert.throws(() => store.update(session.id, { title: 'Unsaved title' }), /Flush refused/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  assert.equal(fs.readdirSync(store.directory).some(name => name.endsWith('.tmp')), false);
});

test('a deletion rollback failure still retains recoverable history and metadata', t => {
  const { store, session, transcript } = fixture(t), before = store.snapshot(), rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === store.file || path.basename(source).startsWith('.deleting-')) throw Error('Rename refused');
    return rename(source, target);
  });
  assert.throws(() => store.delete(session.id), /transcript will be restored/);
  assert.deepEqual(store.snapshot(), before);
  fault.mock.restore();
  const reopened = new SessionStore(store.directory);
  assert.equal(reopened.session(session.id).id, session.id);
  assert.equal(fs.readFileSync(transcript, 'utf8'), 'retained session history\n');
});

test('deleting one session retains other transcripts and shared project memory', t => {
  const { projectPath, store, project, session, transcript } = fixture(t);
  const other = store.create(project.id);
  const otherTranscript = path.join(store.transcriptDirectory(other.id), 'session.jsonl');
  fs.writeFileSync(otherTranscript, 'other history');
  const memory = path.join(projectPath, 'memory-fixture.txt'); fs.writeFileSync(memory, 'shared memory');
  store.activate(session.id);
  store.delete(session.id);
  assert.equal(fs.existsSync(transcript), false);
  assert.equal(store.data.activeId, null);
  assert.throws(() => store.session(session.id), /no longer exists/);
  assert.equal(fs.readFileSync(otherTranscript, 'utf8'), 'other history');
  assert.equal(fs.readFileSync(memory, 'utf8'), 'shared memory');
  assert.deepEqual(new SessionStore(store.directory).snapshot(), store.snapshot());
});

test('restart restores a transcript if deletion was interrupted before the index commit', t => {
  const { store, session, transcript } = fixture(t);
  const directory = path.dirname(transcript);
  const pending = path.join(path.dirname(directory), `.deleting-${session.id}-${randomUUID()}`);
  fs.renameSync(directory, pending);
  const reopened = new SessionStore(store.directory);
  assert.equal(reopened.session(session.id).state, 'open');
  assert.equal(fs.readFileSync(transcript, 'utf8'), 'retained session history\n');
  assert.equal(fs.existsSync(pending), false);
});

test('restart finishes an indexed deletion and leaves unrelated folders alone', t => {
  const { store, session, transcript } = fixture(t);
  const directory = path.dirname(transcript), transcripts = path.dirname(directory);
  const pending = path.join(transcripts, `.deleting-${session.id}-${randomUUID()}`);
  fs.renameSync(directory, pending);
  const unrelated = path.join(transcripts, '.deleting-unrelated'); fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'unrelated data');
  store.data.sessions = []; store.data.activeId = null; store.save();
  new SessionStore(store.directory);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'unrelated data');
});

test('cleanup failure retains a recoverable transcript until the next restart', t => {
  const { store, session, transcript } = fixture(t);
  const remove = fs.rmSync;
  const fault = t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.basename(target).startsWith('.deleting-')) throw Error('Cleanup refused');
    return remove(target, options);
  });
  assert.throws(() => store.delete(session.id), /Restart YunusPi/);
  assert.throws(() => store.session(session.id), /no longer exists/);
  const transcripts = path.dirname(path.dirname(transcript));
  const [pending] = fs.readdirSync(transcripts);
  assert.equal(fs.readFileSync(path.join(transcripts, pending, 'session.jsonl'), 'utf8'), 'retained session history\n');
  fault.mock.restore();
  new SessionStore(store.directory);
  assert.deepEqual(fs.readdirSync(transcripts), []);
});

test('missing or malformed metadata never destroys pending histories', t => {
  const { store, session, transcript } = fixture(t);
  const directory = path.dirname(transcript);
  const pending = path.join(path.dirname(directory), `.deleting-${session.id}-${randomUUID()}`);
  fs.renameSync(directory, pending);
  fs.writeFileSync(store.file, '{invalid');
  assert.throws(() => new SessionStore(store.directory), /index is invalid.*transcripts were retained/);
  fs.rmSync(store.file);
  assert.throws(() => new SessionStore(store.directory), /index is missing.*transcripts were retained/);
  assert.equal(fs.readFileSync(path.join(pending, 'session.jsonl'), 'utf8'), 'retained session history\n');
});

test('untrusted saved records fail clearly without overwriting the index or histories', t => {
  const { store, transcript } = fixture(t), valid = store.snapshot();
  const malformed = [
    data => { data.projects[0] = null; },
    data => { data.projects[0].trusted = 'false'; },
    data => { data.projects[0].path = '../relative-project'; },
    data => { data.sessions[0] = null; },
    data => { data.sessions[0].draft = {}; },
    data => { data.sessions[0].id = '../../elsewhere'; },
    data => { data.sessions[0].state = 'archived'; },
    data => { data.sessions.push({ ...data.sessions[0] }); },
    data => { data.activeId = randomUUID(); },
  ];
  for (const change of malformed) {
    const data = structuredClone(valid); change(data);
    const bytes = JSON.stringify(data); fs.writeFileSync(store.file, bytes);
    assert.throws(() => new SessionStore(store.directory), /index is invalid.*transcripts were retained/);
    assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
    assert.equal(fs.readFileSync(transcript, 'utf8'), 'retained session history\n');
  }
});

test('draft typing coalesces writes while explicit flush retains the newest text', t => {
  const { store, session } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = t.mock.method(fs, 'fsyncSync');
  for (let i = 0; i < 30; i++) { store.setDraft(session.id, `draft ${i}`); t.mock.timers.tick(10); }
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(store.session(session.id).draft, 'draft 29');
  assert.equal(new SessionStore(store.directory).session(session.id).draft, '');
  t.mock.timers.tick(300);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(new SessionStore(store.directory).session(session.id).draft, 'draft 29');
  store.setDraft(session.id, 'last keystroke'); store.flush();
  assert.equal(writes.mock.callCount(), 2);
  assert.equal(new SessionStore(store.directory).session(session.id).draft, 'last keystroke');
  t.mock.timers.tick(1000);
  assert.equal(writes.mock.callCount(), 2);
});

test('failed delayed draft save reports the error and preserves text for retry', t => {
  const errors = [];
  const { store, session } = fixture(t, { onSaveError: error => errors.push(error.message) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fault = failIndexSave(t, store);
  store.setDraft(session.id, 'keep my draft'); t.mock.timers.tick(300);
  assert.deepEqual(errors, ['Disk write refused']);
  assert.equal(store.session(session.id).draft, 'keep my draft');
  assert.equal(new SessionStore(store.directory).session(session.id).draft, '');
  assert.throws(() => store.flush(), /Disk write refused/);
  fault.mock.restore(); store.flush();
  assert.equal(new SessionStore(store.directory).session(session.id).draft, 'keep my draft');
});

test('other metadata commits save staged drafts and unchanged updates avoid disk writes', t => {
  const { store, session } = fixture(t);
  store.setDraft(session.id, 'staged text');
  store.update(session.id, { title: 'Renamed session' });
  assert.equal(new SessionStore(store.directory).session(session.id).draft, 'staged text');
  const before = store.snapshot(), writes = t.mock.method(fs, 'fsyncSync');
  store.update(session.id, { title: 'Renamed session', draft: 'staged text' });
  store.activate(session.id); store.flush();
  assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(store.snapshot(), before);
});

test('session deletion refuses paths through a symlink and retains external data', t => {
  const { root, store, session, transcript } = fixture(t);
  fs.rmSync(path.dirname(transcript), { recursive: true });
  const outside = path.join(root, 'external'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside data');
  fs.symlinkSync(outside, path.dirname(transcript));
  assert.throws(() => store.delete(session.id), /Unsafe transcript directory/);
  assert.equal(store.session(session.id).id, session.id);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside data');
});

test('archiving a project hides it with its sessions, closes open ones, and restoring brings back each session state', t => {
  const { store, project, session, projectPath } = fixture(t);
  const second = store.create(project.id);
  store.update(second.id, { state: 'archived' });
  store.activate(session.id);
  store.setProjectArchived(project.id, true);
  assert.equal(store.project(project.id).archived, true);
  assert.equal(store.session(session.id).state, 'closed', 'an open session closes with its project');
  assert.equal(store.session(second.id).state, 'archived', 'a session archived on its own keeps that state');
  assert.equal(store.snapshot().activeId, null);
  assert.throws(() => store.activate(session.id), /Restore this project/);
  assert.throws(() => store.create(project.id), /Restore this project/);
  const reloaded = new SessionStore(store.directory);
  assert.equal(reloaded.project(project.id).archived, true, 'the archive survives a restart');
  store.setProjectArchived(project.id, false);
  assert.equal('archived' in store.project(project.id), false);
  assert.equal(store.session(second.id).state, 'archived');
  store.setProjectArchived(project.id, true);
  assert.equal(store.addProject(projectPath).archived, undefined, 'opening the folder again restores the project');
  assert.equal(store.create(project.id).projectId, project.id);
});
