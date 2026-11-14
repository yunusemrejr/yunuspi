import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager, sessionEntryToContextMessages } from '../core/coding-agent/dist/core/session-manager.js';

const root = path.resolve(import.meta.dirname, '..');
const extensionUrl = pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href;
const { default: registerSessionFacts } = await import(extensionUrl);

const METHOD = 'For this message, the working notes apply: act on what the user means and meet every demand in it, sized to the ask; read the guide that fits before choosing an approach; see and verify with the tools instead of guessing; nothing a person looks at ships unseen or with a template look; hand legwork to subagents.';

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
	return { pi, hooks, emit, ctx, humanMessage, store, stored, manager, notifications, entries, toolResult };
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
	assert.ok(first.message.content.endsWith(`\n${METHOD}`));
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
	assert.equal(plain.message.content, `${plain.message.content.split('\n')[0]}\n${METHOD}`);
	assert.doesNotMatch(plain.message.content, /Session:/, 'nothing is invented when no figure is known');

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
	await f.emit('input', { type: 'input', text: 'Also keep the old name.', source: 'interactive' });
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
	assert.match(await f.toolResult('c1'), /^\[run budget\] This run has worked for \d+ min and spent \$0\.002 since the user's last message \(budget: \$0\.0015\)\./);
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

	clock.at += 60_000;
	assert.equal(await call('c2'), '[run budget] This run has worked for 2 min and spent $0.002 since the user\'s last message (budget: 2 min or $0.50). Finish the item in hand, complete and verify every demand of the user that is still open, start nothing new that was not asked for, and report what is done, what is not and the next step.');

	clock.at += 60_000;
	assert.equal(await call('c3'), undefined, 'the first note is sent once');

	clock.at += 60_000;
	assert.equal(await call('c4'), '[run budget] 4 min and $0.002 since the user\'s last message, twice the budget. End the run now: stop background work nobody needs, and report the state as it is, naming what is unverified.');

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
	assert.equal(await usdOnly.toolResult('c1'), '[run budget] This run has worked for 1 min and spent $0.50 since the user\'s last message (budget: $0.40). Finish the item in hand, complete and verify every demand of the user that is still open, start nothing new that was not asked for, and report what is done, what is not and the next step.');

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
	assert.match(await f.toolResult('c2'), /^\[run budget\] This run has worked for 2 min /);
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
