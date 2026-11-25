import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';

// 25 Nov 2026: a long job of the sister harness spent 60% of its hours waiting on workers that ran fewer than two at a
// time, and nothing told the main model. The pace note measures the wait from the end of a run to the next wakeup.

process.env.PI_JEV = 'off';

const root = path.resolve(import.meta.dirname, '..');
const { Pace, averageOut, paceNote } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/pace.ts')).href);
const { default: registerSessionFacts } = await import(pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href);

const MIN = 60_000;
const W = (start, end) => ({ start: start * MIN, ...(end === undefined ? {} : { end: end * MIN }) });
const NOTE = 'Pace: 50m on this demand, 92% of it spent waiting on subagents with 1.0 out at a time. Before you wait again: launch every open piece that does not need a running subagent\'s result, in one call (a tasks list runs them side by side); a piece queued behind a file is built in a new file of its own and joined later; commit what is verified. Then tell the user in one line what is left and how long it will take. If nothing is queued, carry on.';

function withEnv(env, fn) {
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	try { return fn(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

/** A session that waited 18 min once and 28 min again: 46 of 50 minutes, two subagents out in turn. */
function rig() {
	let t = 0;
	const pace = new Pace({ now: () => t });
	const at = (min) => { t = min * MIN; };
	return { pace, at, now: () => t };
}

test('average out is each subagent\'s overlap with the window over its length, a running subagent ending now', () => {
	assert.equal(averageOut([W(-10, 10), W(5)], 0, 20 * MIN), 1.25);
	assert.equal(averageOut([W(0, 10), W(10, 20)], 0, 20 * MIN), 1);
	assert.equal(averageOut([W(0), W(0), W(0)], 0, 10 * MIN), 3);
	assert.equal(averageOut([], 0, 10 * MIN), 0);
	assert.equal(averageOut([W(0)], 5 * MIN, 5 * MIN), 0, 'no window, no average');
});

test('no note before 40 minutes, however much of it was spent waiting', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(2); pace.stopped('s');
	at(20); assert.equal(pace.machine('s', [W(0), W(0)]), '');
	at(22); pace.stopped('s');
	at(39); assert.equal(pace.machine('s', [W(0), W(0)]), '', '39 minutes of wall is still short');
});

test('the note states the measured numbers: wall, waiting share in whole percent, average subagents out', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(2); pace.stopped('s');
	at(20); assert.equal(pace.machine('s', [W(0, 20), W(20)]), '');
	at(22); pace.stopped('s');
	at(50);
	assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), NOTE);
	assert.equal(paceNote(50 * MIN, 92, 1), NOTE);
});

test('no note when the waiting share is under 40%', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(1); pace.stopped('s');
	at(20); assert.equal(pace.machine('s', [W(0, 20), W(2, 40)]), '');
	at(50); assert.equal(pace.machine('s', [W(0, 20), W(2, 40)]), '', '19 of 50 minutes is 38%');
});

test('no note when three or more subagents were out on average', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(2); pace.stopped('s');
	at(20); assert.equal(pace.machine('s', [W(0), W(0), W(0)]), '');
	at(22); pace.stopped('s');
	at(50); assert.equal(pace.machine('s', [W(0), W(0), W(0)]), '', 'three out the whole window is not below three');
});

test('no note with fewer than two subagents launched inside the window', () => {
	const one = rig();
	one.at(0); one.pace.human('s', false);
	one.at(2); one.pace.stopped('s');
	one.at(20); assert.equal(one.pace.machine('s', [W(0)]), '');
	one.at(22); one.pace.stopped('s');
	one.at(50); assert.equal(one.pace.machine('s', [W(0, 50)]), '', 'a single subagent');

	const early = rig();
	early.at(0); early.pace.human('s', false);
	early.at(2); early.pace.stopped('s');
	early.at(20); assert.equal(early.pace.machine('s', [W(0), W(-20)]), '');
	early.at(22); early.pace.stopped('s');
	early.at(50); assert.equal(early.pace.machine('s', [W(0, 50), W(-20, 50)]), '', 'a subagent started before the window does not count');
});

test('a second note comes only after 30 minutes without one', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(2); pace.stopped('s');
	at(20); assert.equal(pace.machine('s', [W(0, 20), W(20)]), '');
	at(22); pace.stopped('s');
	at(50); assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), NOTE);
	at(79); assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), '', '29 minutes after the first note');
	at(80); assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), paceNote(80 * MIN, 57, 0.625), '30 minutes after it');
});

test('a person\'s prompt with no subagent out restarts the window; with one out it does not', () => {
	const fresh = rig();
	fresh.at(0); fresh.pace.human('s', false);
	fresh.at(5); fresh.pace.stopped('s');
	fresh.at(10); fresh.pace.human('s', false);
	fresh.at(60); assert.equal(fresh.pace.machine('s', [W(10, 40), W(20)]), '', 'the window began again at 10, so nothing was waited');

	const ongoing = rig();
	ongoing.at(0); ongoing.pace.human('s', false);
	ongoing.at(3); ongoing.pace.stopped('s');
	ongoing.at(10); ongoing.pace.human('s', true);
	ongoing.at(12); ongoing.pace.stopped('s');
	ongoing.at(50);
	// The window kept its start at 0 and the person's own 7 minutes were not counted: 38 of 50 (the stop mark is cleared).
	assert.equal(ongoing.pace.machine('s', [W(0, 20), W(20, 50)]), paceNote(50 * MIN, 76, 1));
});

test('a turn that was work turns the wait into work: working() clears the mark without counting', () => {
	const { pace, at } = rig();
	at(0); pace.human('s', false);
	at(2); pace.stopped('s');
	at(3); pace.working('s');
	at(20); assert.equal(pace.machine('s', [W(0), W(0)]), '', 'nothing was waited between 2 and 3, and 3 to 20 was work');
	at(22); pace.stopped('s');
	at(50); assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), paceNote(50 * MIN, 56, 1), 'only the 28 minutes from 22 count');
});

test('PI_PACE=0 turns every method off', () => {
	withEnv({ PI_PACE: '0' }, () => {
		const { pace, at } = rig();
		at(0); pace.human('s', false);
		at(2); pace.stopped('s');
		at(22); pace.stopped('s');
		at(50);
		assert.equal(pace.machine('s', [W(0, 20), W(20, 50)]), '');
	});
});

/** Session facts registered on a fake runtime, with the clock moved by hand. */
function wired(t) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pace-'));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pace-cwd-'));
	const saved = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = temp;
	const realNow = Date.now;
	let now = 0;
	t.after(() => {
		Date.now = realNow;
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	Date.now = () => now;

	const hooks = new Map();
	const bus = new Map();
	const manager = SessionManager.inMemory(cwd);
	const ctx = {
		cwd,
		model: { provider: 'fixture', id: 'fixture-model', contextWindow: 128000 },
		getContextUsage: () => undefined,
		hasUI: false,
		sessionManager: { getSessionId: () => 'pace-fixture', getEntries: () => manager.getBranch(), getBranch: () => manager.getBranch() },
	};
	const pi = {
		on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
		events: { on(name, handler) { const list = bus.get(name) ?? []; list.push(handler); bus.set(name, list); return () => {}; }, emit() {} },
		registerTool() {}, appendEntry() {},
		sendMessage() {},
		getThinkingLevel: () => 'off', setThinkingLevel() {},
	};
	const emit = async (name, event = {}) => {
		const responses = [];
		for (const handler of hooks.get(name) ?? []) {
			const response = await handler(event, ctx);
			if (response !== undefined) responses.push(response);
		}
		return responses;
	};
	const signal = (name, event) => { for (const handler of bus.get(name) ?? []) handler(event); };
	const at = (min) => { now = min * MIN; };
	registerSessionFacts(pi);
	return { emit, signal, at };
}

test('a run the person did not type wakes the agent with the note, measured from the events session facts sees', async (t) => {
	const { emit, signal, at } = wired(t);
	at(0);
	await emit('input', { type: 'input', text: 'Start the job.', source: 'interactive' });
	// The payload fields of async-execution.ts:1436: the run id, one run per launch.
	signal('subagent:async-started', { id: 'a', mode: 'single', agent: 'general' });
	signal('subagent:async-started', { id: 'b', mode: 'single', agent: 'general' });
	const [facts] = await emit('before_agent_start', { type: 'before_agent_start', prompt: 'Start the job.' });
	assert.ok(facts?.message, 'the person\'s run still gets the facts line');
	assert.doesNotMatch(facts.message.content, /Pace:/, 'a person\'s prompt opens the window, it does not report it');

	at(2);
	await emit('agent_end', { type: 'agent_end', messages: [] });
	at(20);
	signal('subagent:async-complete', { runId: 'a', triggerTurn: true });
	signal('subagent:async-started', { id: 'c', mode: 'single', agent: 'general' });
	const [early] = await emit('before_agent_start', { type: 'before_agent_start', prompt: 'subagent result' });
	assert.equal(early, undefined, 'the first wakeup is 20 minutes in: too short for the note');
	at(22);
	await emit('agent_end', { type: 'agent_end', messages: [] });
	at(50);
	const [woken] = await emit('before_agent_start', { type: 'before_agent_start', prompt: 'subagent result' });
	assert.equal(woken?.message?.customType, 'pace-note');
	assert.equal(woken?.message?.display, false);
	assert.equal(woken.message.content, 'Pace: 50m on this demand, 92% of it spent waiting on subagents with 2.0 out at a time. Before you wait again: launch every open piece that does not need a running subagent\'s result, in one call (a tasks list runs them side by side); a piece queued behind a file is built in a new file of its own and joined later; commit what is verified. Then tell the user in one line what is left and how long it will take. If nothing is queued, carry on.');
});

test('a tasks launch counts its children: the parallel group width sets how many are out', async (t) => {
	const { emit, signal, at } = wired(t);
	at(0);
	await emit('input', { type: 'input', text: 'Start the job.', source: 'interactive' });
	// A `tasks` list is one run whose start event carries the group widths: two children at once, then one more run.
	signal('subagent:async-started', { id: 'pair', mode: 'chain', agent: 'general', agents: ['general', 'general'], parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }] });
	await emit('before_agent_start', { type: 'before_agent_start', prompt: 'Start the job.' });
	at(2);
	await emit('agent_end', { type: 'agent_end', messages: [] });
	at(20);
	signal('subagent:async-complete', { runId: 'pair', triggerTurn: true, results: [{ agent: 'general' }, { agent: 'general' }] });
	signal('subagent:async-started', { id: 'solo', mode: 'single', agent: 'general' });
	const [early] = await emit('before_agent_start', { type: 'before_agent_start', prompt: 'subagent result' });
	assert.equal(early, undefined);
	at(22);
	await emit('agent_end', { type: 'agent_end', messages: [] });
	at(50);
	const [woken] = await emit('before_agent_start', { type: 'before_agent_start', prompt: 'subagent result' });
	// 46 of 50 minutes waited, 92%; the pair's two children overlap 0 to 20 and the solo run 20 to 50: (40 + 30) / 50.
	assert.equal(woken?.message?.content, 'Pace: 50m on this demand, 92% of it spent waiting on subagents with 1.4 out at a time. Before you wait again: launch every open piece that does not need a running subagent\'s result, in one call (a tasks list runs them side by side); a piece queued behind a file is built in a new file of its own and joined later; commit what is verified. Then tell the user in one line what is left and how long it will take. If nothing is queued, carry on.');
});

