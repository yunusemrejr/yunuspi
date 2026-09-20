import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
const agent = [path.join(release, 'agent'), path.resolve(release, '..'), path.resolve(release, '../..')]
 .find(dir => fs.existsSync(path.join(dir, 'extensions/reminders.ts')));
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reminder-retention-'));
const previousHome = process.env.HOME;
process.env.HOME = temporaryHome;
const {default: reminders} = await import(pathToFileURL(path.join(agent, 'extensions/reminders.ts')));
const {defaultRemindersState, remindersStateFile, writeRemindersState, readRemindersRestore} = await import(pathToFileURL(path.join(agent, 'extensions/lib/reminders-state.ts')));

test('state cleanup preserves active manual reminders across long idle periods', async t => {
 t.after(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(temporaryHome, {recursive: true, force: true});
 });
 const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
 const age = file => fs.utimesSync(file, new Date(old), new Date(old));
 const makeState = (sid, manual = []) => {
  const state = defaultRemindersState();
  state.manual = manual;
  assert.equal(writeRemindersState(sid, state), true);
  return remindersStateFile(sid);
 };
 const active = makeState('old-active', [{id: 'manual', text: 'Preserve the archived project constraint', active: true, createdAt: old, nextFireAt: old + 300000, delivered: 1}]);
 const cleared = makeState('old-cleared', [{id: 'cleared', text: 'Already cleared', active: false, createdAt: old, nextFireAt: old + 300000, delivered: 1}]);
 const empty = makeState('old-z-empty');
 const current = makeState('current');
 const recent = makeState('recent');
 const malformed = remindersStateFile('old-malformed');
 fs.writeFileSync(malformed, '{unfinished-state');
 const invalidSchema = remindersStateFile('old-invalid-schema');
 const invalidText = JSON.stringify({manual: [{id: 'missing-dates', text: 'Keep this constraint', active: true}]});
 fs.writeFileSync(invalidSchema, invalidText);
 for (const file of [active, cleared, empty, current, malformed, invalidSchema]) age(file);
 const symlink = remindersStateFile('old-symlink');
 fs.symlinkSync(active, symlink);
 const hooks = new Map();
 reminders({
  on(name, hook) { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); },
  registerCommand() {}, getActiveTools: () => [], sendMessage() {},
 });
 const ctx = sid => ({cwd: temporaryHome, sessionManager: {getSessionId: () => sid, getBranch: () => []}, ui: {notify() {}}});
 const emit = async (name, event, context) => {
  let result;
  for (const hook of hooks.get(name) ?? []) result = await hook(event, context) ?? result;
  return result;
 };
 await emit('session_start', {reason: 'new'}, ctx('current'));
 assert.equal(fs.existsSync(active), true, 'unrelated startup must not delete an active user reminder');
 assert.equal(fs.existsSync(cleared), false, 'completed reminder state is still eligible for retention cleanup');
 assert.equal(fs.existsSync(empty), false, 'a malformed neighbor does not prevent empty state cleanup');
 assert.equal(fs.existsSync(current), true);
 assert.equal(fs.existsSync(recent), true);
 assert.equal(fs.readFileSync(malformed, 'utf8'), '{unfinished-state', 'unreadable state has no proof that its reminders were cleared');
 assert.equal(fs.readFileSync(invalidSchema, 'utf8'), invalidText, 'invalid scheduling fields do not cancel active instructions');
 assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
 assert.deepEqual(readRemindersRestore('old-active').custom, ['Preserve the archived project constraint']);
 await emit('session_start', {reason: 'resume'}, ctx('old-active'));
 const restored = await emit('before_agent_start', {prompt: 'Continue'}, ctx('old-active'));
 assert.match(restored.message.content, /Preserve the archived project constraint/);
});

test('reentrant reminder writers never rename another writer\'s temporary bytes',()=>{
 const sid='concurrent-writers',first=defaultRemindersState(),second=defaultRemindersState();
 first.promptCount=1;second.promptCount=2;
 const originalRename=fs.renameSync;let nested=false,nestedResult;
 fs.renameSync=(from,to)=>{
  if(!nested){nested=true;nestedResult=writeRemindersState(sid,second);}
  return originalRename(from,to);
 };
 syncBuiltinESMExports();
 try{
  const firstResult=writeRemindersState(sid,first);
  assert.equal(nestedResult,true);assert.equal(firstResult,true);
  assert.equal(JSON.parse(fs.readFileSync(remindersStateFile(sid),'utf8')).promptCount,1,'the last renaming writer persists its own bytes');
 }finally{fs.renameSync=originalRename;syncBuiltinESMExports();}
});
