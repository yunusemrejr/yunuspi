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
const previousHome = os.homedir;
os.homedir = () => temporaryHome;
syncBuiltinESMExports();
const {default: reminders} = await import(pathToFileURL(path.join(agent, 'extensions/reminders.ts')));
const {defaultRemindersState, remindersStateFile, writeRemindersState, readRemindersRestore} = await import(pathToFileURL(path.join(agent, 'extensions/lib/reminders-state.ts')));

test.after(() => {
 os.homedir = previousHome;
 syncBuiltinESMExports();
 fs.rmSync(temporaryHome, {recursive: true, force: true});
});

test('state cleanup preserves active manual reminders across long idle periods', async () => {
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
 const originalWrite=fs.writeFileSync;let nested=false,nestedResult;
 fs.writeFileSync=(file,...args)=>{
  if(!nested && String(file).endsWith('.tmp')){nested=true;nestedResult=writeRemindersState(sid,second);}
  return originalWrite(file,...args);
 };
 syncBuiltinESMExports();
 try{
  const firstResult=writeRemindersState(sid,first);
  assert.equal(nestedResult,true);assert.equal(firstResult,true);
  assert.equal(JSON.parse(fs.readFileSync(remindersStateFile(sid),'utf8')).promptCount,1,'the last renaming writer persists its own bytes');
 }finally{fs.writeFileSync=originalWrite;syncBuiltinESMExports();}
});

test('startup pruning and reminder publication serialize across the read-to-unlink boundary', async () => {
 const sid = 'prune-publish-race';
 const file = remindersStateFile(sid);
 assert.equal(writeRemindersState(sid, defaultRemindersState()), true);
 const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
 fs.utimesSync(file, aged, aged);
 const next = defaultRemindersState();
 next.manual = [{id: 'kept', text: 'A freshly registered reminder', active: true,
  createdAt: Date.now(), nextFireAt: Date.now(), delivered: 0}];
 const hooks = [];
 reminders({on(name, handler) { if (name === 'session_start') hooks.push(handler); },
  registerCommand() {}, getActiveTools: () => [], sendMessage() {}});

 const originalRead = fs.readFileSync;
 let publishDuringPrune;
 fs.readFileSync = (candidate, ...args) => {
  const bytes = originalRead(candidate, ...args);
  if (candidate === file && publishDuringPrune === undefined) publishDuringPrune = writeRemindersState(sid, next);
  return bytes;
 };
 syncBuiltinESMExports();
 try {
  for (const hook of hooks) await hook({reason: 'new'}, {cwd: temporaryHome,
   sessionManager: {getSessionId: () => 'prune-caller', getBranch: () => []}, ui: {notify() {}}});
 } finally {
  fs.readFileSync = originalRead;
  syncBuiltinESMExports();
 }
 assert.equal(publishDuringPrune, false, 'even a reentrant writer cannot replace the proved-empty inode');
 assert.equal(writeRemindersState(sid, next), true, 'a later attempt can acquire the released lock');
 assert.deepEqual(readRemindersRestore(sid).custom, ['A freshly registered reminder']);
});
