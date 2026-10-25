import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
const agent = path.join(release, 'agent');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reminder-goal-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
const {default: reminders} = await import(pathToFileURL(path.join(agent, 'extensions/reminders.ts')));
const {defaultRemindersState, writeRemindersState} = await import(pathToFileURL(path.join(agent, 'extensions/lib/reminders-state.ts')));

test('a plan left untouched since its goal was achieved does not nag the next request', async t => {
 t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; fs.rmSync(home, {recursive: true, force: true}); });
 const hooks = new Map();
 reminders({ on(name, hook) { const list = hooks.get(name) ?? []; list.push(hook); hooks.set(name, list); }, registerCommand() {}, getActiveTools: () => [], sendMessage() {} });
 const emit = async (name, event, context) => { let result; for (const hook of hooks.get(name) ?? []) result = await hook(event, context) ?? result; return result; };
 const lastTodo = Date.now() - 40 * 60_000;
 const run = async (sid, branch) => {
  const state = defaultRemindersState();
  Object.assign(state, {hasPending: true, pendingCount: 4, lastTodoActionAt: lastTodo, promptCount: 3, startedAt: lastTodo - 60_000});
  assert.equal(writeRemindersState(sid, state), true);
  const ctx = {cwd: home, sessionManager: {getSessionId: () => sid, getBranch: () => branch}, ui: {notify() {}}};
  return JSON.stringify(await emit('before_agent_start', {prompt: 'Add the latest Jev version to the classifier.'}, ctx) ?? {});
 };
 assert.match(await run('no-goal', []), /Open todos: 4 pending/, 'without a goal the stale plan is still named');
 const achieved = [{type: 'custom', customType: 'goal-state-v1', data: {status: 'achieved', updatedAt: lastTodo + 10 * 60_000}}];
 assert.doesNotMatch(await run('after-goal', achieved), /Open todos|Stay within the user's requested scope/, 'the achieved goal settled its plan');
 const active = [{type: 'custom', customType: 'goal-state-v1', data: {status: 'active', updatedAt: lastTodo + 10 * 60_000}}];
 assert.match(await run('goal-open', active), /Open todos: 4 pending/, 'a live goal keeps its plan reminder');
});
