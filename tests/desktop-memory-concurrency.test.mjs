import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../agent/extensions/lib/project-vector-store.ts';

const module = pathToFileURL(path.resolve(import.meta.dirname, '../agent/extensions/lib/project-vector-store.ts')).href;
function writer(source, args, t) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env });
  let error = '';
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-3000); });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(error || `writer exit ${code}`)));
  });
  done.catch(() => {});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, done, ready: new Promise(resolve => child.once('message', resolve)) };
}

test('opening a project index waits for an existing lock before enabling WAL', { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'memory.sqlite'), lock = new DatabaseSync(database);
  lock.exec('CREATE TABLE existing (id INTEGER); BEGIN EXCLUSIVE');
  let held = true;
  t.after(() => { if (held) lock.exec('ROLLBACK'); lock.close(); });
  const run = writer(`import {openProjectStore} from ${JSON.stringify(module)};
    process.send('opening', () => {
      const store=openProjectStore(process.argv[1],{projectId:'locked-project'});
      store.setMeta('lock-test','committed');store.close();process.disconnect();
    });`, [database], t);
  await run.ready;
  const release = new Promise(resolve => setTimeout(() => { lock.exec('COMMIT'); held = false; resolve(); }, 150));
  const [outcome] = await Promise.allSettled([run.done, release]);
  if (outcome.status === 'rejected') throw outcome.reason;
  assert.equal(lock.prepare("SELECT value FROM meta WHERE key='lock-test'").get().value, 'committed');
});

test('independent session processes commit to one project vector index without losing each other’s records', { timeout: 20_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'shared/memory.sqlite');
  const source = `import {openProjectStore} from ${JSON.stringify(module)};
    process.send('ready');process.once('message',()=>{
      const [file,session]=process.argv.slice(1),store=openProjectStore(file,{projectId:'project-example'});
      for(let i=0;i<40;i++)store.upsertChunk({id:session+'-'+i,project_id:'project-example',session_id:session,source_type:'decision',title:'Concurrent decision',text:session+' independent memory '+i,content_hash:session+'-hash-'+i});
      store.close();process.disconnect();
    });`;
  const sessions = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f'];
  const runs = sessions.map(session => writer(source, [database, session], t));
  await Promise.all(runs.map(run => run.ready));
  for (const run of runs) run.child.send('open');
  const outcomes = await Promise.allSettled(runs.map(run => run.done));
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  const shared = openProjectStore(database, { projectId: 'project-example' });
  const other = openProjectStore(path.join(root, 'other/memory.sqlite'), { projectId: 'other-example' });
  try {
    assert.equal(shared.counts().chunks, 240);
    assert.equal(shared.getMeta('project_id'), 'project-example');
    assert.equal(shared.getMeta('schema_version'), '3');
    for (const session of sessions) assert.equal(shared.getChunk(`${session}-39`).session_id, session);
    assert.equal(other.counts().chunks, 0, 'a separate project never inherits another project index');
  } finally { shared.close(); other.close(); }
});

test('failed schema initialization rolls back new tables and releases its connection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'memory.sqlite');
  const original = new DatabaseSync(database);
  original.exec('CREATE TABLE chunks (id TEXT PRIMARY KEY)'); original.close();
  assert.throws(() => openProjectStore(database, { projectId: 'recovered' }), /no such column/);
  if (process.platform === 'linux') {
    const handles = fs.readdirSync('/proc/self/fd').flatMap(fd => {
      try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
    });
    assert.equal(handles.some(file => file === database || file.startsWith(database + '-')), false, 'failed open retains no database/WAL handle');
  }
  const repair = new DatabaseSync(database);
  assert.deepEqual(repair.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['chunks']);
  repair.exec('DROP TABLE chunks'); repair.close();
  const healthy = openProjectStore(database, { projectId: 'recovered' });
  try { assert.equal(healthy.getMeta('project_id'), 'recovered'); assert.equal(healthy.counts().chunks, 0); }
  finally { healthy.close(); }
});

for (const sharedId of [false, true]) test(`concurrent ${sharedId ? 'same-ID' : 'same-content'} memory writes reconcile inside the write transaction`, { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-upsert-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'memory.sqlite');
  openProjectStore(database, { projectId: 'shared-project' }).close();
  const source = `import {openProjectStore} from ${JSON.stringify(module)};
    const store=openProjectStore(process.argv[1],{projectId:'shared-project'});
    process.send('ready');process.once('message',()=>{
      const result=store.upsertChunk({id:${sharedId ? "'shared-chunk'" : "process.argv[2]"},project_id:'shared-project',session_id:process.argv[2],source_type:'decision',text:'The same shared decision',content_hash:'one-semantic-record'});
      process.send({result});store.close();process.disconnect();
    });`;
  const runs = ['a', 'b', 'c', 'd'].map(session => writer(source, [database, session], t));
  const results = [];
  for (const run of runs) run.child.on('message', message => { if (message?.result) results.push(message.result); });
  await Promise.all(runs.map(run => run.ready));
  const lock = new DatabaseSync(database); lock.exec('BEGIN IMMEDIATE'); let held = true;
  t.after(() => { if (held) lock.exec('ROLLBACK'); lock.close(); });
  for (const run of runs) run.child.send('write');
  const release = new Promise(resolve => setTimeout(() => { lock.exec('COMMIT'); held = false; resolve(); }, 150));
  const outcomes = await Promise.allSettled([...runs.map(run => run.done), release]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  assert.equal(results.filter(result => result === 'inserted').length, 1);
  assert.equal(results.filter(result => result === (sharedId ? 'replaced' : 'duplicate')).length, 3);
  const store = openProjectStore(database, { projectId: 'shared-project' });
  try { assert.equal(store.counts().chunks, 1); assert.equal(store.lexicalSearch('shared decision').length, 1); }
  finally { store.close(); }
});

for (const operation of ['source refresh', 'supersession merge']) test(`concurrent ${operation} preserves the latest memory metadata`, { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-memory-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'memory.sqlite'), seed = openProjectStore(database, { projectId: 'shared-project' });
  seed.upsertChunk({ id: 'shared', project_id: 'shared-project', source_type: 'code', source_path: 'code.js', source_start: 10, source_end: 11, text: 'Shared source memory', content_hash: 'shared-hash' });
  seed.setAtoms('shared', [{ id: 'atom', text: 'Shared source memory', content_hash: 'atom-hash', source_start: 10, source_end: 11 }]); seed.close();
  const source = `import {openProjectStore} from ${JSON.stringify(module)};
    const store=openProjectStore(process.argv[1],{projectId:'shared-project'});
    process.send('ready');process.once('message',()=>{
      ${operation === 'source refresh' ? "store.refreshSource('shared',{start:20,end:21});" : "store.addSupersedes('shared',[process.argv[2]]);"}
      store.close();process.disconnect();
    });`;
  const sessions = ['a', 'b', 'c', 'd'], runs = sessions.map(session => writer(source, [database, session], t));
  await Promise.all(runs.map(run => run.ready));
  const lock = new DatabaseSync(database); lock.exec('BEGIN IMMEDIATE'); let held = true;
  t.after(() => { if (held) lock.exec('ROLLBACK'); lock.close(); });
  for (const run of runs) run.child.send('write');
  const release = new Promise(resolve => setTimeout(() => { lock.exec('COMMIT'); held = false; resolve(); }, 150));
  const outcomes = await Promise.allSettled([...runs.map(run => run.done), release]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  const store = openProjectStore(database, { projectId: 'shared-project' });
  try {
    if (operation === 'source refresh') { assert.equal(store.getChunk('shared').source_start, 20); assert.equal(store.getAtom('atom').source_start, 20); }
    else assert.deepEqual(store.getChunk('shared').supersedes.sort(), sessions);
  } finally { store.close(); }
});
