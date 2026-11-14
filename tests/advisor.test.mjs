import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import advisorExtension from '../agent/extensions/advisor.ts';
import { collectSessionCost } from '../core/coding-agent/src/core/session-accounting.js';
import { configureJevClient, resetJevClient } from '../agent/extensions/lib/jev-client.ts';

// No test here may reach the decision model over the network.
process.env.PI_JEV = 'off';

const SYSTEM = 'You advise another model that is in the middle of a task. Answer in at most 120 words: the recommendation first, then the reason, then the one risk to watch.';
const DESCRIPTION = 'Put one question (at most 1,500 characters) to a stronger model and get a few lines back. It sees only the question: state the goal, what is known, the options and the one thing to decide. Ask when its judgment can change the outcome: before committing to an approach on a hard or costly task, after two failed attempts at the same problem, before reporting a large piece of work as done. Never for a fact a lookup answers. 3 per run, 12 per session.';
const ROUTE = 'example/advisor-1';

const model = { provider: 'example', id: 'advisor-1', reasoning: true, maxTokens: 64_000 };

/** A temp agent dir whose settings.json names the advisor; the caller cleans it up. */
function agentDirWith(advisor) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-agent-'));
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(advisor === undefined ? {} : { team: { advisor } }));
	return dir;
}

function harness({ entries = [], available = [model], complete, child = false } = {}) {
	const tools = new Map();
	const handlers = new Map();
	const appended = [];
	const pi = {
		tools,
		handlers,
		appended,
		registerTool: (tool) => void tools.set(tool.name, tool),
		on: (name, handler) => void handlers.set(name, handler),
		appendEntry: (customType, data) => void appended.push({ type: 'custom', customType, data }),
	};
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-cwd-')),
		hasUI: false,
		sessionManager: { getSessionId: () => 'sess_advisor', getEntries: () => [...entries, ...appended] },
		modelRegistry: {
			getAvailable: () => available,
			completeSimple: complete ?? (async () => ({
				content: [{ type: 'text', text: 'Recommendation: keep the plan. Reason: it is verified. Risk: the cache.' }],
				stopReason: 'stop',
				usage: { input: 200, output: 40, cost: { total: 0.002, source: 'provider-estimate' } },
			})),
		},
	};
	const previous = process.env.PI_SUBAGENT_CHILD;
	if (child) process.env.PI_SUBAGENT_CHILD = '1'; else delete process.env.PI_SUBAGENT_CHILD;
	advisorExtension(pi);
	pi.handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
	if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previous;
	return { pi, ctx, run: (params, signal) => tools.get('ask_advisor').execute('c1', params, signal, undefined, ctx) };
}

function withAgentDir(t, advisor, body) {
	const dir = agentDirWith(advisor);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return body();
}

test('no advisor setting means no tool', async (t) => {
	for (const advisor of [undefined, 'off']) {
		await withAgentDir(t, advisor, () => {
			const { pi } = harness();
			assert.deepEqual([...pi.tools.keys()], [], `team.advisor ${advisor ?? 'unset'} registers nothing`);
		});
	}
});

test('a child process never gets the tool', (t) => withAgentDir(t, 'example/advisor-1', () => {
	const { pi } = harness({ child: true });
	assert.deepEqual([...pi.tools.keys()], []);
}));

test('a configured advisor registers one tool with the exact description', (t) => withAgentDir(t, 'example/advisor-1', () => {
	const { pi } = harness();
	assert.deepEqual([...pi.tools.keys()], ['ask_advisor']);
	assert.equal(pi.tools.get('ask_advisor').description, DESCRIPTION);
}));

test('the tool list does not change after the first session start', (t) => withAgentDir(t, 'example/advisor-1', () => {
	const { pi, ctx } = harness();
	assert.deepEqual([...pi.tools.keys()], ['ask_advisor']);
	pi.handlers.get('session_start')({ type: 'session_start', reason: 'reload' }, ctx);
	assert.deepEqual([...pi.tools.keys()], ['ask_advisor']);
}));

test('an advisor set mid-session is added once at the next message; turning it off keeps the tool and refuses', (t) => withAgentDir(t, undefined, async () => {
	const { pi, ctx, run } = harness();
	const settings = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
	let registrations = 0;
	const register = pi.registerTool;
	pi.registerTool = (tool) => { registrations++; register(tool); };
	const message = () => pi.handlers.get('before_agent_start')({ type: 'before_agent_start', prompt: 'next' }, ctx);
	message();
	assert.deepEqual([...pi.tools.keys()], [], 'an advisor that is still off adds nothing');
	fs.writeFileSync(settings, JSON.stringify({ team: { advisor: ROUTE } }));
	message();
	message();
	assert.deepEqual([...pi.tools.keys()], ['ask_advisor']);
	assert.equal(registrations, 1, 'the tool is registered once');
	fs.writeFileSync(settings, JSON.stringify({ team: { advisor: 'off' } }));
	message();
	assert.deepEqual([...pi.tools.keys()], ['ask_advisor'], 'turning the advisor off does not change the tool list');
	const refused = await run({ question: 'Which plan?' });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /team\.advisor is off/);
}));

test('a child process is not offered the tool at the next message either', (t) => withAgentDir(t, undefined, () => {
	const { pi, ctx } = harness();
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ team: { advisor: ROUTE } }));
	process.env.PI_SUBAGENT_CHILD = '1';
	try { pi.handlers.get('before_agent_start')({ type: 'before_agent_start', prompt: 'next' }, ctx); } finally { delete process.env.PI_SUBAGENT_CHILD; }
	assert.deepEqual([...pi.tools.keys()], []);
}));

test('a question over 1,500 characters is refused naming the limit', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const { run } = harness();
	const result = await run({ question: 'x'.repeat(1_501) });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /1,500 characters/);
	assert.equal((await run({ question: 'y'.repeat(1_500) })).isError, undefined, 'exactly 1,500 is accepted');
}));

test('the request carries only the question and the exact system text', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	let seen;
	const { run } = harness({ complete: async (chosen, context, options) => {
		seen = { chosen, context, options };
		return { content: [{ type: 'text', text: 'Do the simpler thing.' }], stopReason: 'stop', usage: { input: 10, output: 5 } };
	} });
	const result = await run({ question: 'Should I refactor the loader or patch the bug?' });
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, 'Do the simpler thing.');
	assert.equal(seen.chosen, model);
	assert.equal(seen.context.systemPrompt, SYSTEM);
	assert.equal(seen.context.tools, undefined, 'no tools are sent');
	assert.equal(seen.context.messages.length, 1, 'no conversation is sent');
	assert.deepEqual(seen.context.messages[0].content, [{ type: 'text', text: 'Should I refactor the loader or patch the bug?' }]);
	assert.equal(seen.options.reasoning, 'medium');
	assert.ok(seen.options.maxTokens >= 1_200);
}));

test('3 per run, then a new human message starts a fresh run', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const { pi, ctx, run } = harness();
	for (let i = 0; i < 3; i++) assert.equal((await run({ question: `Question ${i}` })).isError, undefined);
	const refused = await run({ question: 'One more?' });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /3 per run reached/);
	pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'go on' }, ctx);
	assert.equal((await run({ question: 'After the human message' })).isError, undefined);
	pi.handlers.get('input')({ type: 'input', source: 'extension', text: 'injected' }, ctx);
	assert.equal((await run({ question: 'Still in the run' })).isError, undefined, 'extension text does not reset the run');
}));

test('12 per session, then refused', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const { pi, ctx, run } = harness();
	let answered = 0;
	for (let round = 0; round < 5; round++) {
		for (let i = 0; i < 3; i++) {
			const result = await run({ question: `Question ${round}-${i}` });
			if (!result.isError) answered++;
		}
		pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, ctx);
	}
	assert.equal(answered, 12);
	const refused = await run({ question: 'Past the session limit' });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /12 per session reached/);
}));

test('the session count survives a reload of the same session', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const first = harness();
	for (let i = 0; i < 3; i++) await first.run({ question: `Before reload ${i}` });
	const entries = first.pi.appended;
	const { pi, ctx, run } = harness({ entries });
	const result = await run({ question: 'After reload' });
	assert.equal(result.isError, undefined, 'a reload of those entries leaves 9 of 12');
	const later = [];
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 3; i++) if (round > 0 || i > 0) later.push((await run({ question: `More ${round}-${i}` })).isError);
		pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, ctx);
	}
	assert.deepEqual(later, Array(8).fill(undefined), 'the remaining 8 are still allowed');
	const refused = await run({ question: 'One too many' });
	assert.match(refused.content[0].text, /12 per session reached/);
}));

test('a second call is refused while one is in flight', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const { run } = harness({ complete: async () => {
		await gate;
		return { content: [{ type: 'text', text: 'Answer.' }], stopReason: 'stop', usage: { input: 1, output: 1 } };
	} });
	const first = run({ question: 'First' });
	const second = await run({ question: 'Second' });
	assert.equal(second.isError, true);
	assert.match(second.content[0].text, /one at a time/);
	release();
	assert.equal((await first).content[0].text, 'Answer.');
	assert.equal((await run({ question: 'Third' })).isError, undefined, 'the slot is free again');
}));

test('spend is recorded as auxiliary usage under the advisor route and counted', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const { pi, run } = harness();
	await run({ question: 'Cost this one' });
	const usageEntry = pi.appended.find((entry) => entry.customType === 'auxiliary-model-usage-v1' && entry.data.status === 'completed');
	assert.ok(usageEntry, 'a completed receipt exists');
	assert.equal(usageEntry.data.provider, 'example');
	assert.equal(usageEntry.data.model, 'advisor-1');
	assert.equal(usageEntry.data.owner, 'advisor');
	const cost = collectSessionCost(pi.appended);
	const row = cost.rows.find((entry) => entry.scope === 'auxiliary' && entry.route === ROUTE);
	assert.ok(row, `an auxiliary row for ${ROUTE}`);
	assert.equal(row.estimated, 0.002);
	assert.equal(cost.pending, 0, 'the pending receipt is settled by the completion');
}));

test('an unavailable advisor model gives the one-line settings error', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	const { run } = harness({ available: [{ provider: 'example', id: 'other-model' }] });
	const result = await run({ question: 'Any advice?' });
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, `team.advisor is set to 'example/advisor-1', which is not among the available models. Pick another with /team.`);
}));

/** Jev answers every question with these two scores; the calls are returned. */
function mockJev(simple, deep) {
	const calls = [];
	resetJevClient();
	configureJevClient({
		fetchImpl: async (url, options) => {
			if (String(url).includes('/api/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
			calls.push(JSON.parse(options.body));
			return { ok: true, status: 200, json: async () => ({ model: 'typesafe/jev-1.14-20261014', answers: { simple: { type: 'noul', noul: simple }, deep: { type: 'noul', noul: deep } }, usage: { input_tokens: 10, cost: 0 } }) };
		},
		now: () => Date.now(),
		schedule: () => ({}),
		openMs: 50,
		requestTimeoutMs: 5_000,
	});
	return calls;
}

/** Ask one question with the decision model on; returns the reasoning level the advisor call used. */
async function reasoningFor(t, { simple, deep, sessionLevel }) {
	const saved = { jev: process.env.PI_JEV, key: process.env.OPENROUTER_API_KEY };
	process.env.PI_JEV = 'on';
	process.env.OPENROUTER_API_KEY = 'sk-or-test';
	t.after(() => {
		for (const [name, value] of [['PI_JEV', saved.jev], ['OPENROUTER_API_KEY', saved.key]]) if (value === undefined) delete process.env[name]; else process.env[name] = value;
		resetJevClient();
	});
	const calls = mockJev(simple, deep);
	let seen;
	const h = harness({ complete: async (_model, _context, options) => { seen = options; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: {} }; } });
	h.pi.getThinkingLevel = () => sessionLevel;
	await h.run({ question: 'Which of these two names is clearer?' });
	return { reasoning: seen.reasoning, asked: calls.length };
}

test('the decision model sets the advisor thinking level per question and never above the session level', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	assert.deepEqual(await reasoningFor(t, { simple: 0.94, deep: 0.04, sessionLevel: 'high' }), { reasoning: 'low', asked: 1 }, 'an easy question thinks less');
	assert.deepEqual(await reasoningFor(t, { simple: 0.65, deep: 0.28, sessionLevel: 'high' }), { reasoning: 'medium', asked: 1 });
	assert.deepEqual(await reasoningFor(t, { simple: 0.6, deep: 0.55, sessionLevel: 'high' }), { reasoning: 'medium', asked: 1 }, 'an unclear answer keeps the fixed level');
	assert.deepEqual(await reasoningFor(t, { simple: 0.6, deep: 0.55, sessionLevel: 'low' }), { reasoning: 'low', asked: 1 }, 'a session set to low caps the advisor at low');
	assert.equal((await reasoningFor(t, { simple: 0.6, deep: 0.55, sessionLevel: 'off' })).reasoning, undefined, 'a session with thinking off sends no reasoning level');
}));

test('with the decision model off the advisor keeps its fixed level and no judge call is made', (t) => withAgentDir(t, 'example/advisor-1', async () => {
	let seen;
	const { run } = harness({ complete: async (_model, _context, options) => { seen = options; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: {} }; } });
	await run({ question: 'Which name is clearer?' });
	assert.equal(seen.reasoning, 'medium');
}));
