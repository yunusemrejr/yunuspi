import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager, sessionEntryToContextMessages } from '../core/coding-agent/dist/core/session-manager.js';

// No test here may reach the decision model over the network.
process.env.PI_JEV = 'off';

const root = path.resolve(import.meta.dirname, '..');
const extensionUrl = pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href;
const { default: registerSessionFacts, hurryRequested, HURRY_NOTE } = await import(extensionUrl);

/** An assistant message entry with usage, as the session file stores it. */
const assistantEntry = ({ input = 4000, output = 200, cacheRead = 96000, total = 0.012 } = {}) => ({
	type: 'message',
	message: {
		role: 'assistant', provider: 'fixture', model: 'fixture-model', timestamp: Date.now(),
		usage: { input, output, cacheRead, cacheWrite: 0, ...(total === null ? {} : { cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } }) },
	},
});

/** The event shapes the core emits, plus the session state each handler reads. */
function fixture(t, { settings, entries = [] } = {}) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-facts-'));
	const saved = { ...process.env };
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-facts-cwd-'));
	process.env.PI_CODING_AGENT_DIR = temp;
	if (settings) fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify(settings));
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	const hooks = new Map();
	const notifications = [];
	const sent = [];
	const manager = SessionManager.inMemory(cwd);
	const branch = () => manager.getBranch();
	const ctx = {
		cwd,
		model: { provider: 'fixture', id: 'fixture-model', contextWindow: 128000 },
		getContextUsage: () => ({ tokens: 41000, contextWindow: 128000 }),
		hasUI: true,
		ui: { notify: (text, kind) => notifications.push({ text, kind }) },
		sessionManager: {
			getSessionId: () => 'session-facts-fixture',
			getEntries: () => (entries.length ? entries : branch()),
			getBranch: () => (entries.length ? entries : branch()),
		},
	};
	const pi = {
		on(name, handler) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		registerTool() {},
		appendEntry() {},
		sendMessage(message, options) { sent.push({ message, options }); },
		getThinkingLevel: () => 'off',
		setThinkingLevel() {},
	};
	const emit = async (name, event = {}, context = ctx) => {
		const responses = [];
		for (const handler of hooks.get(name) ?? []) {
			const response = await handler(event, context);
			if (response !== undefined) responses.push(response);
		}
		return responses;
	};
	/** A human message: the input event, then the run's first request. */
	const humanMessage = async (text) => {
		await emit('input', { type: 'input', text, source: 'interactive' });
		return emit('before_agent_start', { type: 'before_agent_start', prompt: text, systemPrompt: 'BASE' });
	};
	const store = (message) => manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
	const stored = () => manager.getEntries().filter((entry) => entry.type === 'custom_message');
	/**
	 * One tool result of the run. Returns the budget note it caused, or
	 * undefined. The note is a message of its own, queued behind the tool
	 * results in hand and shown; the tool result itself is never changed.
	 */
	const toolResult = async (id) => {
		const before = sent.length;
		const responses = await emit('tool_result', { type: 'tool_result', toolName: 'bash', toolCallId: id, content: [{ type: 'text', text: 'ok' }], isError: false, details: {} });
		assert.equal(responses.length, 0, 'the tool result is left as the tool returned it');
		assert.ok(sent.length - before <= 1, 'at most one note per tool result');
		if (sent.length === before) return undefined;
		const { message, options } = sent.at(-1);
		assert.deepEqual({ customType: message.customType, display: message.display, options }, { customType: 'run-budget', display: true, options: { deliverAs: 'steer' } });
		return message.content;
	};
	return { pi, hooks, emit, ctx, humanMessage, store, stored, manager, notifications, entries, toolResult, sent };
}

const NOW_SHAPE = /^Now: [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} \([A-Za-z/_+0-9]+\)\./;

test('one stored model-only facts message per human message, byte-stable on later requests', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const [first] = await f.humanMessage('Add a retry to the uploader.');
	assert.ok(first?.message, 'the first human message carries a facts message');
	assert.equal(first.message.customType, 'session-facts');
	assert.equal(first.message.display, false, 'the message is model-only');
	assert.match(first.message.content, NOW_SHAPE);
	assert.match(first.message.content, /Session: \$0\.012, context 41k of 128k tokens, cache hits 96%\./);
	assert.doesNotMatch(first.message.content, /Last run/, 'the first message has no finished run to report');
	f.store(first.message);

	// Later turns of the same run add nothing: the line is stored, not
	// regenerated, so the prompt prefix keeps its bytes.
	await f.emit('turn_end', { type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });
	assert.equal((await f.emit('before_agent_start', { type: 'before_agent_start', prompt: 'x' })).length, 0);

	const [second] = await f.humanMessage('Also update the README.');
	f.store(second.message);
	assert.equal(f.stored().length, 2, 'exactly one stored message per human message');
	const replayed = f.stored().map((entry) => sessionEntryToContextMessages(entry)[0].content);
	assert.equal(replayed[0], first.message.content, 'the stored message replays byte-identically on the next request');
	assert.equal(replayed[1], second.message.content);
	assert.match(replayed[1], /Last run: \d+ min\.$/m, 'a run that cost nothing reports its minutes only');
});

test('run budgets read the accounting projection once per revision and omit an incomplete starting balance', async t => {
	const f = fixture(t, { entries: [assistantEntry({ total: 10 })] });
	let revision = 1, reads = 0, incomplete = false;
	let accounting = [assistantEntry({ total: 0.02 })];
	Object.assign(f.ctx.sessionManager, {
		getAccountingEntries: () => { reads++; return accounting; },
		getAccountingEntriesRevision: () => revision,
		isAccountingIncomplete: () => incomplete,
	});
	registerSessionFacts(f.pi);
	const [start] = await f.humanMessage('Check the invoice.');
	assert.match(start.message.content, /Session: \$0\.02/);
	for (let i = 0; i < 20; i++) await f.emit('turn_end');
	assert.equal(reads, 1, 'unchanged billing is not rescanned on repeated budget reads');
	accounting = [assistantEntry({ total: 0.12 })];
	revision++;
	await f.emit('turn_end');
	assert.equal(reads, 2);
	incomplete = true;
	revision++;
	const [damaged] = await f.humanMessage('Continue.');
	assert.doesNotMatch(damaged.message.content, /\$/);
	incomplete = false;
	revision++;
	await f.emit('turn_end');
	const [recovered] = await f.humanMessage('Check again.');
	assert.match(recovered.message.content, /Session: \$0\.12/);
	assert.match(recovered.message.content, /Last run: \d+ min\./, 'a lost starting balance cannot measure run cost');
});

test('unknown figures are left out: no price, no cache data, no context usage', async (t) => {
	const unpriced = fixture(t, { entries: [assistantEntry({ total: null })] });
	registerSessionFacts(unpriced.pi);
	const [message] = await unpriced.humanMessage('Check the build.');
	assert.match(message.message.content, NOW_SHAPE);
	assert.doesNotMatch(message.message.content, /\$/, 'no price is known for the model');
	assert.match(message.message.content, /cache hits 96%/, 'cache data is still measured without pricing');
	assert.doesNotMatch(message.message.content, /Last run/);

	const bare = fixture(t, {});
	bare.ctx.getContextUsage = () => undefined;
	bare.ctx.model = { provider: 'fixture', id: 'fixture-model' };
	registerSessionFacts(bare.pi);
	const [plain] = await bare.humanMessage('Say hello.');
	assert.doesNotMatch(plain.message.content, /Session:|Last run|Guides that match/, 'nothing is invented when no figure is known');
	assert.match(plain.message.content, /\nWhere: .+ is a plain folder with no repository\.$/);

	const unpricedRun = fixture(t, { entries: [assistantEntry({ total: null })] });
	registerSessionFacts(unpricedRun.pi);
	const [firstTurn] = await unpricedRun.humanMessage('First.');
	unpricedRun.store(firstTurn.message);
	const [secondTurn] = await unpricedRun.humanMessage('Second.');
	assert.match(secondTurn.message.content, /Last run: \d+ min\./);
	assert.doesNotMatch(secondTurn.message.content, /\$/, 'an unpriced run reports its minutes only');
});

test('the line goes with a human message that starts a run, never with one the harness sent', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const harnessMessage = async () => {
		await f.emit('input', { type: 'input', text: 'Continue the goal.', source: 'extension' });
		return f.emit('before_agent_start', { type: 'before_agent_start', prompt: 'Continue the goal.', systemPrompt: 'BASE' });
	};
	assert.equal((await f.humanMessage('Start.')).length, 1);

	// A steering message joins the running agent: the core emits its input
	// event, but no new before_agent_start. Its line must not wait for the
	// next message the harness sends.
	await f.emit('input', { type: 'input', text: 'Also keep the old name.', source: 'interactive', streamingBehavior: 'steer' });
	await f.emit('agent_end', { type: 'agent_end', messages: [] });
	assert.equal((await harnessMessage()).length, 0, 'a steered run leaves no line behind');

	// A human message refused before its run started leaves none either.
	await f.emit('input', { type: 'input', text: 'Refused before the first request.', source: 'interactive' });
	assert.equal((await harnessMessage()).length, 0, 'a message that never ran leaves no line behind');

	assert.equal((await f.humanMessage('Next.')).length, 1, 'the next human message has its line');
});

test('the first run of a session is measured from zero, and small amounts stay readable', async (t) => {
	const f = fixture(t, { settings: { run: { softMinutes: 0, softUsd: 0.0015 } } });
	registerSessionFacts(f.pi);
	const [first] = await f.humanMessage('Count the lines.');
	assert.doesNotMatch(first.message.content, /\$/, 'nothing is spent yet, so no amount is shown');

	// The first priced request arrives after the run began: the run has a cost
	// from then on, so its budget can be passed and the next line can report it.
	f.entries.push(assistantEntry({ total: 0.002 }));
	assert.match(await f.toolResult('c1'), /^\[run budget\] You do not have much time left: this run has worked for \d+ min and spent \$0\.002 since the user's last message \(budget: \$0\.0015\)\./);
	const [second] = await f.humanMessage('Thanks.');
	assert.match(second.message.content, /Session: \$0\.002, .*Last run: \d+ min, \$0\.002\./);

	const { sessionFactsText } = await import(extensionUrl);
	const line = (input) => sessionFactsText({ now: new Date(0), zone: 'UTC', ...input }).split('\n')[0];
	assert.doesNotMatch(line({ usd: 0.0000006 }), /\$|Session/, 'an amount that rounds to nothing is left out');
	assert.match(line({ usd: 0.00038781 }), /Session: \$0\.0004\./);
	assert.match(line({ usd: 1.239 }), /Session: \$1\.24\./);
});

test('unreadable team settings give the run the default budget', async (t) => {
	const f = fixture(t, { settings: { run: { softMinutes: 2, softUsd: 0.5 } }, entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const liveRun = () => globalThis[Symbol.for('yunus-pi.run.v1')]();
	await f.humanMessage('First.');
	assert.deepEqual(liveRun().limits, { softMinutes: 2, softUsd: 0.5 });
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ team: { helper: 'no-provider' } }));
	const [second] = await f.humanMessage('Second.');
	assert.ok(second?.message, 'the message still gets its line');
	assert.deepEqual(liveRun().limits, { softMinutes: 60, softUsd: 1 }, 'a new run starts, on the default budget');
});

test('a child process registers nothing', async () => {
	const saved = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = '1';
	try {
		const hooks = new Map();
		registerSessionFacts({ on: (name) => hooks.set(name, true), appendEntry() {} });
		assert.equal(hooks.size, 0, 'no handler is registered in a child process');
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = saved;
	}
});

test('the run budget notes, active minutes and run reset', async (t) => {
	const clock = { at: Date.UTC(2026, 10, 14, 13, 0, 0) };
	const realNow = Date.now;
	Date.now = () => clock.at;
	t.after(() => { Date.now = realNow; });
	const f = fixture(t, { settings: { run: { softMinutes: 2, softUsd: 0.5 } }, entries: [assistantEntry({ total: 0.01 })] });
	registerSessionFacts(f.pi);

	await f.humanMessage('Fix the failing test.');
	f.entries.push(assistantEntry({ total: 0.002 }));
	const call = f.toolResult;

	clock.at += 60_000;
	assert.equal(await call('c1'), undefined, 'nothing is sent before the budget is reached');
	await f.emit('input', { source: 'interactive', text: 'Also check Unicode.', streamingBehavior: 'steer' });

	clock.at += 60_000;
	assert.match(await call('c2'), /2 min and spent \$0\.002/, 'steering preserves the current run time, cost and budget');

	clock.at += 60_000;
	assert.equal(await call('c3'), undefined, 'the first note is sent once');

	clock.at += 60_000;
	assert.equal(await call('c4'), '[run budget] 4 min and $0.002 since the user\'s last message, twice the soft budget. Focus on the remaining requested work and the checks it needs. Reuse current evidence and report any genuine blocker.');

	clock.at += 60_000;
	assert.equal(await call('c5'), undefined, 'twice-the-budget is sent once too');

	// A new human message starts a new run: the finished one becomes "Last run"
	// and the note budget starts over.
	// A message sent while the agent still works closes that minute too.
	clock.at += 60_000;
	const [next] = await f.humanMessage('Now update the changelog.');
	assert.match(next.message.content, /Last run: 6 min, \$0\.002\./);
	clock.at += 30_000;
	assert.equal(await call('c6'), undefined, 'the new run has no note yet');
});

test('a limit of 0 is off and is not mentioned', async (t) => {
	const clock = { at: Date.UTC(2026, 10, 14, 13, 0, 0) };
	const realNow = Date.now;
	Date.now = () => clock.at;
	t.after(() => { Date.now = realNow; });

	const usdOnly = fixture(t, { settings: { run: { softMinutes: 0, softUsd: 0.4 } }, entries: [assistantEntry({ total: 0.01 })] });
	registerSessionFacts(usdOnly.pi);
	await usdOnly.humanMessage('Ship it.');
	usdOnly.entries.push(assistantEntry({ total: 0.5 }));
	clock.at += 60_000;
	assert.equal(await usdOnly.toolResult('c1'), '[run budget] You do not have much time left: this run has worked for 1 min and spent $0.50 since the user\'s last message (budget: $0.40). Finish the item in hand, complete and verify every demand of the user that is still open, start nothing new that was not asked for, and report what is done, what is not and the next step.');

	const off = fixture(t, { settings: { run: { softMinutes: 0, softUsd: 0 } }, entries: [assistantEntry({ total: 0.01 })] });
	registerSessionFacts(off.pi);
	await off.humanMessage('Work long.');
	off.entries.push(assistantEntry({ total: 9 }));
	for (let i = 0; i < 4; i++) {
		clock.at += 5 * 60_000;
		assert.equal(await off.toolResult(`off-${i}`), undefined, 'with both limits off no note is ever sent, however long the run works');
	}
});

test('a gap longer than 10 minutes is idle time, not run time', async (t) => {
	const clock = { at: Date.UTC(2026, 10, 14, 13, 0, 0) };
	const realNow = Date.now;
	Date.now = () => clock.at;
	t.after(() => { Date.now = realNow; });
	const f = fixture(t, { settings: { run: { softMinutes: 2, softUsd: 0 } }, entries: [assistantEntry({ total: 0.01 })] });
	registerSessionFacts(f.pi);
	await f.humanMessage('Start the long job.');
	clock.at += 11 * 60_000;
	assert.equal(await f.toolResult('c1'), undefined, 'the 11-minute gap counts as zero active minutes');

	clock.at += 119_000;
	assert.equal(await f.toolResult('early'), undefined, 'rounded display minutes do not trigger a budget early');
	clock.at += 1000;
	assert.match(await f.toolResult('c2'), /^\[run budget\] You do not have much time left: this run has worked for 2 min /);
});

test('waiting for the user after the agent stopped is not run time', async (t) => {
	const clock = { at: Date.UTC(2026, 10, 14, 13, 0, 0) };
	const realNow = Date.now;
	Date.now = () => clock.at;
	t.after(() => { Date.now = realNow; });
	const f = fixture(t, { settings: { run: { softMinutes: 0, softUsd: 0 } }, entries: [assistantEntry({ total: 0.01 })] });
	registerSessionFacts(f.pi);
	const liveRun = () => globalThis[Symbol.for('yunus-pi.run.v1')]();
	await f.humanMessage('Count the lines.');
	clock.at += 60_000;
	await f.toolResult('c1');
	await f.emit('agent_end', { type: 'agent_end', messages: [] });

	// Five minutes pass before the next message. A command typed meanwhile
	// (/budget) reads the run as it ended.
	clock.at += 5 * 60_000;
	assert.equal(liveRun().minutes, 1);
	const [next] = await f.humanMessage('Which is the longest?');
	assert.match(next.message.content, /Last run: 1 min\./, 'the five minutes of waiting are not in the run');

	// Work the harness restarts by itself (a goal continuing) counts again from its start.
	clock.at += 60_000;
	await f.toolResult('c2');
	await f.emit('agent_end', { type: 'agent_end', messages: [] });
	clock.at += 3 * 60_000;
	await f.emit('before_agent_start', { type: 'before_agent_start', prompt: 'Continue.', systemPrompt: 'BASE' });
	clock.at += 60_000;
	await f.toolResult('c3');
	assert.equal(liveRun().minutes, 2, 'the pause between two stretches of the same run is left out');
});

test('a message that asks for speed carries one speed note with it', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const [plain] = await f.humanMessage('Add a retry to the uploader.');
	assert.doesNotMatch(plain.message.content, /The user wants speed now/, 'a plain message carries no speed note');

	const [hurry] = await f.humanMessage('Hurry up, this is taking too long.');
	assert.ok(hurry.message.content.endsWith(`\n${HURRY_NOTE}`), 'the speed note goes with the message that asked for speed');

	const [next] = await f.humanMessage('Now update the changelog.');
	assert.doesNotMatch(next.message.content, /The user wants speed now/, 'the note is granted once, with its own message');
});

test('speed detection reads prose in both languages and not a technical term', async () => {
	for (const text of [
		'Please rush, the build is waiting.',
		'Hurry, we ship at noon.',
		'be quick about it',
		'Do this quickly.',
		'Can you go faster?',
		'asap please',
		'This is taking too long.',
		"we don't have all day",
		'there is no time for a survey',
		'acele et',
		'çabuk ol',
		'lütfen hızlı ol',
		'hemen yap',
		'çok uzun sürdü',
		'vakit yok',
		'ACELE ET, HIZLI OL',
		'Please be quicker about the rest.',
		'Do it faster please.',
		'work faster, we are late',
		'finish quickly',
		'quickly please',
		'faster please',
		'Do it as fast as you can.',
		'Hemen hemen bitti ama şimdi hemen yap.',
		"We're in a rush.",
		'We have no time, wrap up.',
		'no time to lose',
	]) assert.equal(hurryRequested(text), true, text);
	for (const text of [
		'Implement a quick sort for the numbers.',
		'Use fast mode for this run.',
		'/fast',
		'Install faster-whisper and use it.',
		'Sort the list and update the README.',
		'```\nmake it faster\n```',
		'Call `faster()` in the loop.',
		// a product described as fast is not a request for the agent to hurry
		'The goal is a fully autonomous terminal tool that does amazing off-site SEO work very quickly and smartly, and checks every claim.',
		'make the engine faster',
		'Make the engine work faster and add a cache.',
		'let users search quickly',
		'Users find the results quickly and the page loads faster.',
		'hemen hemen bitti',
		// a feature that mentions rush or time is not a request for speed
		'add a rush order status to the shop',
		'There is no time zone handling in the scheduler yet.',
		'Users have no time zone setting.',
	]) assert.equal(hurryRequested(text), false, text);
});

test('the Where line goes with the first prompt, then only when it changed', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const where = /\nWhere: /;
	assert.match((await f.humanMessage('One.'))[0].message.content, where, 'the first prompt carries it');
	assert.doesNotMatch((await f.humanMessage('Two.'))[0].message.content, where, 'unchanged: not sent again');
	const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-facts-moved-'));
	t.after(() => fs.rmSync(other, { recursive: true, force: true }));
	f.ctx.cwd = other;
	assert.match((await f.humanMessage('Three.'))[0].message.content, where, 'a new folder changes the text');
	assert.doesNotMatch((await f.humanMessage('Four.'))[0].message.content, where);
	await f.emit('session_compact', {});
	assert.match((await f.humanMessage('Five.'))[0].message.content, where, 'a compacted history may have dropped it');
	await f.emit('session_start', {});
	assert.match((await f.humanMessage('Six.'))[0].message.content, where, 'a new session starts over');
});

test('a hurry steer into a running run sends the speed note once', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);

	// The run started with a plain message; the user then steers speed into it.
	const [first] = await f.humanMessage('Add a retry to the uploader.');
	assert.doesNotMatch(first.message.content, /The user wants speed now/);
	const steer = async (text) => {
		const before = f.sent.length;
		const responses = await f.emit('input', { type: 'input', text, source: 'interactive', streamingBehavior: 'steer' });
		assert.equal(responses.length, 0, 'the input handler alters nothing');
		const made = f.sent.length - before;
		if (made > 0) {
			assert.equal(made, 1, 'one note, as its own message');
			const { message, options } = f.sent.at(-1);
			assert.deepEqual({ customType: message.customType, display: message.display, options }, { customType: 'session-hurry', display: false, options: { deliverAs: 'steer' } });
			return message.content;
		}
		return undefined;
	};
	assert.equal(await steer('be quick'), HURRY_NOTE);
	assert.equal(await steer('also be quick'), undefined, 'a second hurry steer in the same run sends nothing more');
	assert.equal(await steer('also fix the footer'), undefined, 'a plain steer sends nothing');

	// An input with no streamingBehavior starts a run of its own: the run path
	// carries the note, and the steer path does not send it again.
	const beforeNewRun = f.sent.length;
	const [replies] = await f.humanMessage('hurry, one more thing');
	assert.ok(replies.message.content.endsWith(`\n${HURRY_NOTE}`), 'a run-starting hurry still carries the note');
	assert.equal(f.sent.length, beforeNewRun, 'no steer note for a run that started with hurry');
	assert.equal(await steer('be quick'), undefined, 'the note already went with this run');

	// Once the run ends, a new one may be hurried by a steer again.
	await f.emit('agent_end', { type: 'agent_end', messages: [] });
	await f.emit('input', { type: 'input', text: 'Next thing.', source: 'interactive' });
	assert.equal(await steer('hurry up'), HURRY_NOTE, 'a later run can be steered into speed again');
});

test('rpc is the user’s own message; other sources are not steered into speed', async (t) => {
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	await f.humanMessage('Fix the failing test.');
	const rpc = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(rpc.pi);
	await rpc.humanMessage('Fix the failing test.');
	await rpc.emit('input', { type: 'input', text: 'be quick', source: 'rpc', streamingBehavior: 'steer' });
	assert.equal(rpc.sent.length, 1);
	assert.equal(rpc.sent[0].message.content, HURRY_NOTE);
	assert.deepEqual(rpc.sent[0].options, { deliverAs: 'steer' });

	await f.emit('input', { type: 'input', text: 'be quick', source: 'extension', streamingBehavior: 'steer' });
	assert.equal(f.sent.length, 0, 'a harness message is not the user asking for speed');

	await f.emit('input', { type: 'input', text: 'be quick', source: 'interactive' });
	assert.equal(f.sent.length, 0, 'without streamingBehavior the run path carries it, not the steer path');
});

test('/budget prints the live run line', async (t) => {
	const clock = { at: Date.UTC(2026, 10, 14, 13, 0, 0) };
	const realNow = Date.now;
	Date.now = () => clock.at;
	t.after(() => { Date.now = realNow; });
	const { default: registerCostGovernor } = await import(pathToFileURL(path.join(root, 'agent/extensions/cost-governor.ts')).href);
	const budgetLine = async (settings) => {
		clock.at = Date.UTC(2026, 10, 14, 13, 0, 0);
		const f = fixture(t, { settings, entries: [assistantEntry({ total: 0.01 })] });
		registerSessionFacts(f.pi);
		const commands = new Map();
		f.pi.registerCommand = (name, options) => commands.set(name, options);
		registerCostGovernor(f.pi);
		for (const handler of f.hooks.get('session_start') ?? []) await handler({ type: 'session_start' }, f.ctx);
		await f.humanMessage('Fix it.');
		f.entries.push(assistantEntry({ total: 0.001 }));
		clock.at += 60_000;
		await f.toolResult('c1');
		await commands.get('budget').handler('', f.ctx);
		const report = f.notifications.at(-1)?.text ?? '';
		assert.match(report, /Cost governor/, '/budget still reports the session');
		return report;
	};
	assert.match(await budgetLine({ run: { softMinutes: 2, softUsd: 0.5 } }), /Run: 1 min, \$0\.001 of 2 min \/ \$0\.50/);
	assert.match(await budgetLine({ run: { softMinutes: 2, softUsd: 0 } }), /Run: 1 min, \$0\.001 of 2 min\n/);
	assert.match(await budgetLine({ run: { softMinutes: 0, softUsd: 0 } }), /Run: 1 min, \$0\.001\n/, 'the run line drops the budget part when both limits are off');
	assert.match(await budgetLine({ run: { softMinutes: 0, softUsd: 0.0015 } }), /Run: 1 min, \$0\.001 of \$0\.0015\n/, 'a limit below one cent is shown as it was set');
});

test('a flat-plan response neither hides metered spend nor consumes the dollar budget', async (t) => {
	const billed = assistantEntry({ total: 0.002 });
	const flat = assistantEntry({ total: 1000 });
	flat.message.usage.cost.billing = 'subscription';
	const f = fixture(t, { entries: [billed, flat] });
	registerSessionFacts(f.pi);
	const commands = new Map();
	f.pi.registerCommand = (name, options) => commands.set(name, options);
	const { default: registerCostGovernor } = await import(pathToFileURL(path.join(root, 'agent/extensions/cost-governor.ts')).href);
	registerCostGovernor(f.pi);
	await f.emit('session_start', { type: 'session_start' });
	const [facts] = await f.humanMessage('Check the build.');
	assert.match(facts.message.content, /Session: \$0\.002,/);
	await commands.get('budget').handler('', f.ctx);
	assert.match(f.notifications.at(-1).text, /Cost split:.* · total \$0\.0020/);
	assert.doesNotMatch(f.notifications.at(-1).text, /economy mode.*\nRun:/);
});

test('a request that names a subject gets the installed guides that match it, once and stored', async (t) => {
	const skills = [
		{ name: 'motion-graphics-production', description: 'Produce timed motion graphics for video, including title sequences, kinetic typography, lower thirds, explainers and audio-reactive visuals.', filePath: '/fixture/skills/motion-graphics-production/SKILL.md' },
		{ name: 'video-captions', description: 'Burn captions into video and check their timing.', filePath: '/fixture/skills/video-captions/SKILL.md' },
		{ name: 'database-migration', description: 'Plan schema migrations for a relational database.', filePath: '/fixture/skills/database-migration/SKILL.md' },
		{ name: 'git-github', description: 'Commit discipline, push rules and pull requests.', filePath: '/fixture/skills/git-github/SKILL.md' },
	];
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const ask = async (text) => {
		await f.emit('input', { type: 'input', text, source: 'interactive' });
		const [reply] = await f.emit('before_agent_start', { type: 'before_agent_start', prompt: text, systemPrompt: 'BASE', systemPromptOptions: { skills } });
		return reply.message.content;
	};
	const withLine = await ask('Make a motion graphics video with kinetic typography and captions for the launch.');
	const lines = withLine.split('\n');
	assert.match(lines[1], /^Where: /, 'the Where line follows the time');
	assert.equal(lines[2], 'Guides that match this request (read the ones that bear on it before choosing the approach): motion-graphics-production: Produce timed motion graphics for video, including title sequences, kinetic typography, lower thirds,… (/fixture/skills/motion-graphics-production/SKILL.md); video-captions: Burn captions into video and check their timing. (/fixture/skills/video-captions/SKILL.md)', 'a long description is clipped at a word, a short one kept whole');
	assert.doesNotMatch(withLine, /database-migration|git-github/, 'only skills that bear on the request');

	for (const plain of ['be quick', 'commit and push', 'why did that test fail?', 'thanks', 'continue']) {
		assert.doesNotMatch(await ask(plain), /Guides that match/, plain);
	}
});

test('a goal kickoff is matched on the goal sentence, not its criteria and standards', async (t) => {
	const skills = [
		{ name: 'motion-graphics-production', description: 'Produce timed motion graphics for video, including kinetic typography.', filePath: '/fixture/skills/motion-graphics-production/SKILL.md' },
		{ name: 'database-migration', description: 'Plan schema migrations for a relational database with rollback checks.', filePath: '/fixture/skills/database-migration/SKILL.md' },
	];
	const f = fixture(t, { entries: [assistantEntry()] });
	registerSessionFacts(f.pi);
	const kickoff = (sentence, criteria) => `[goal-tracked gmx1] Goal: ${sentence}\n\nAcceptance criteria (refine with goal({action:"criteria", items:[…]}) if they miss something; keep it to what the user asked):\n- C1: ${criteria}\n- V: Result checked end to end.\n\nWork autonomously until all are verified with evidence.\n\nStandards: before starting, adopt each one this goal's work calls for.\n- video: a finished video with motion graphics and kinetic typography`;
	const ask = async (text) => {
		await f.emit('input', { type: 'input', text, source: 'interactive' });
		const [reply] = await f.emit('before_agent_start', { type: 'before_agent_start', prompt: text, systemPrompt: 'BASE', systemPromptOptions: { skills } });
		return reply.message.content;
	};
	const sentence = 'Plan the database migration with a rollback';
	const matched = await ask(kickoff(sentence, sentence));
	assert.match(matched, /Guides that match this request .*: database-migration: /);
	assert.doesNotMatch(matched, /motion-graphics-production/, 'the standards text about video does not pick a video guide');
	const other = 'rename the uploader retry settings';
	assert.doesNotMatch(await ask(kickoff(other, `${other}; a motion graphics video with kinetic typography`)), /Guides that match/, 'a criterion that mentions video is not the request');
});
