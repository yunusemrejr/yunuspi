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

/** A temp agent dir whose settings.json holds the team block; the caller cleans it up. */
function agentDirWith(team) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-agent-'));
	fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(team === undefined ? {} : { team }));
	return dir;
}

function harness({ entries = [], available = [model], complete, child = false, apiKey, oauth = true } = {}) {
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
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
			isUsingOAuth: () => oauth,
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
	return withTeam(t, advisor === undefined ? undefined : { advisor }, body);
}

function withTeam(t, team, body) {
	const dir = agentDirWith(team);
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
	const entries = [...first.pi.appended, { type: 'message', message: { role: 'user', content: 'a later human message' } }];
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

// --- the consultant -------------------------------------------------------

const humanMessage = { type: 'message', message: { role: 'user', content: 'the next human message' } };
const consultantModel = { provider: 'example', id: 'consult-1', reasoning: false, maxTokens: 32_000 };
const both = { advisor: ROUTE, consultant: 'example/consult-1' };
const answering = (calls) => async (chosen) => {
	calls.push(`${chosen.provider}/${chosen.id}`);
	return { content: [{ type: 'text', text: `Answer from ${chosen.id}.` }], stopReason: 'stop', usage: { input: 5, output: 5 } };
};

test('with a consultant the tool takes `to`; without one it does not', async (t) => {
	await withTeam(t, both, () => {
		const { pi } = harness({ available: [model, consultantModel] });
		const tool = pi.tools.get('ask_advisor');
		assert.deepEqual(tool.parameters.properties.to.enum, ['advisor', 'consultant']);
		assert.deepEqual(tool.parameters.required, ['question'], '`to` is optional');
		assert.match(tool.description, /`to` picks who answers: the advisor \(3 per run, 12 per session\) or the consultant, a second opinion from another model \(2 per run, 6 per session\)\./);
		assert.match(tool.description, /never hand it work/);
	});
	await withTeam(t, { advisor: ROUTE }, () => {
		const { pi } = harness();
		assert.equal(pi.tools.get('ask_advisor').parameters.properties.to, undefined);
		assert.equal(pi.tools.get('ask_advisor').description, DESCRIPTION);
	});
	await withTeam(t, { consultant: 'example/consult-1' }, () => {
		const { pi } = harness({ available: [consultantModel] });
		const tool = pi.tools.get('ask_advisor');
		assert.ok(tool.parameters.properties.to, 'a consultant alone registers the tool');
		assert.match(tool.description, /second-opinion model/);
		assert.match(tool.description, /2 per run, 6 per session\.$/);
	});
});

test('`to` picks the model; left out it is the advisor, or the consultant when no advisor is set', (t) => withTeam(t, both, async () => {
	const calls = [];
	const { pi, run } = harness({ available: [model, consultantModel], complete: answering(calls) });
	assert.equal((await run({ question: 'Default?' })).content[0].text, 'Answer from advisor-1.');
	assert.equal((await run({ question: 'Consultant?', to: 'consultant' })).content[0].text, 'Answer from consult-1.');
	assert.equal((await run({ question: 'Advisor?', to: 'advisor' })).content[0].text, 'Answer from advisor-1.');
	assert.deepEqual(calls, ['example/advisor-1', 'example/consult-1', 'example/advisor-1']);
	const owners = pi.appended.filter((entry) => entry.customType === 'auxiliary-model-usage-v1' && entry.data.status === 'completed' && entry.data.owner !== 'jev').map((entry) => `${entry.data.owner}:${entry.data.model}`);
	assert.deepEqual(owners, ['advisor:advisor-1', 'consultant:consult-1', 'advisor:advisor-1']);
	const recorded = pi.appended.filter((entry) => entry.customType === 'advisor-v1' && entry.data.status !== 'pending').map((entry) => `${entry.data.target}:${entry.data.route}`);
	assert.deepEqual(recorded, ['advisor:example/advisor-1', 'consultant:example/consult-1', 'advisor:example/advisor-1']);
	const refused = await run({ question: 'Who?', to: 'oracle' });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /to must be "advisor" or "consultant"/);
}));

test('a consultant alone answers when `to` is left out; a call to the one that is off is refused', async (t) => {
	await withTeam(t, { consultant: 'example/consult-1' }, async () => {
		const calls = [];
		const { run } = harness({ available: [consultantModel], complete: answering(calls) });
		assert.equal((await run({ question: 'Only me?' })).content[0].text, 'Answer from consult-1.');
		const refused = await run({ question: 'Advisor?', to: 'advisor' });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /team\.advisor is off/);
	});
	await withTeam(t, { advisor: ROUTE }, async () => {
		const calls = [];
		const { run } = harness({ complete: answering(calls) });
		const refused = await run({ question: 'Consultant?', to: 'consultant' });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /team\.consultant is off/);
		assert.deepEqual(calls, []);
	});
});

test('a latest- selector picks the newest model of the tier', (t) => withTeam(t, { consultant: 'example/latest-astra' }, async () => {
	const calls = [];
	const astras = ['astra-5', 'astra-6', 'astra-5.9'].map((id) => ({ provider: 'example', id: `gpt-${id.slice(6)}-astra`, reasoning: false }));
	const { run } = harness({ available: astras, complete: answering(calls) });
	await run({ question: 'Which?' });
	assert.deepEqual(calls, ['example/gpt-6-astra']);
}));

test('the consultant has its own limits: 2 per run, 6 per session, apart from the advisor', (t) => withTeam(t, both, async () => {
	const { pi, ctx, run } = harness({ available: [model, consultantModel] });
	const ask = (to) => run({ question: `to ${to}`, to });
	assert.equal((await ask('consultant')).isError, undefined);
	assert.equal((await ask('consultant')).isError, undefined);
	const third = await ask('consultant');
	assert.equal(third.isError, true);
	assert.match(third.content[0].text, /Consultant: 2 per run reached/);
	for (let i = 0; i < 3; i++) assert.equal((await ask('advisor')).isError, undefined, 'the advisor still has its 3');
	assert.match((await ask('advisor')).content[0].text, /^3 per run reached/);

	for (let round = 0; round < 2; round++) {
		pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, ctx);
		assert.equal((await ask('consultant')).isError, undefined);
		assert.equal((await ask('consultant')).isError, undefined);
	}
	pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, ctx);
	const past = await ask('consultant');
	assert.equal(past.isError, true);
	assert.match(past.content[0].text, /Consultant: 6 per session reached/);
	assert.equal((await ask('advisor')).isError, undefined, 'the consultant limit does not touch the advisor');
}));

test('a reload counts each target back on its own', (t) => withTeam(t, both, async () => {
	const first = harness({ available: [model, consultantModel] });
	for (let round = 0; round < 3; round++) {
		await first.run({ question: 'c1', to: 'consultant' });
		await first.run({ question: 'c2', to: 'consultant' });
		first.pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, first.ctx);
	}
	const { run } = harness({ available: [model, consultantModel], entries: [...first.pi.appended, humanMessage] });
	const refused = await run({ question: 'Past six', to: 'consultant' });
	assert.match(refused.content[0].text, /Consultant: 6 per session reached/);
	assert.equal((await run({ question: 'The advisor is untouched', to: 'advisor' })).isError, undefined);
}));

// --- the consultant on the ChatGPT subscription ---------------------------

const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.sig`;
const codexModel = { provider: 'openai-codex', id: 'gpt-6-astra', reasoning: false, maxTokens: 32_000 };
const codexTeam = { consultant: 'openai-codex/latest-astra', subscriptionPoints: 2 };
const stateFile = () => path.join(process.env.PI_CODING_AGENT_DIR, 'codex-usage.json');
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const writeUsage = (weeklyPercent, { baseline, limitReached = false, resetAt, ageMs = 0, baselineResetAt = resetAt } = {}) => fs.writeFileSync(stateFile(), JSON.stringify({
	last: { weeklyPercent, limitReached, at: Date.now() - ageMs, ...(resetAt === undefined ? {} : { weeklyResetAt: resetAt }) },
	lastAttemptAt: ageMs ? Date.now() - ageMs : undefined,
	sessions: baseline === undefined ? {} : { sess_advisor: { baseline, at: Date.now(), ...(baselineResetAt === undefined ? {} : { resetAt: baselineResetAt }) } },
}));
const usagePayload = (used) => ({ rate_limit: { limit_reached: false, primary_window: { used_percent: used, limit_window_seconds: 604_800, reset_after_seconds: 1_000 }, secondary_window: null } });

/** Replaces the global fetch with answers for the usage endpoint; returns the request count. */
function usageFetch(t, ...used) {
	const saved = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, init) => {
		requests.push({ url: String(url), init });
		return { ok: true, status: 200, text: async () => JSON.stringify(usagePayload(used[Math.min(requests.length - 1, used.length - 1)])) };
	};
	t.after(() => { globalThis.fetch = saved; });
	return requests;
}

test('a consultant on the subscription stops once the week has moved subscriptionPoints since the session began', (t) => withTeam(t, codexTeam, async () => {
	const requests = usageFetch(t, 99);
	const calls = [];
	const { run } = harness({ available: [codexModel], apiKey: token, complete: answering(calls) });
	writeUsage(20, { baseline: 18 });
	const refused = await run({ question: 'May I?', to: 'consultant' });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /ChatGPT subscription.*weekly quota has moved 2 or more points/);
	assert.deepEqual(calls, [], 'the model was not called');
	assert.equal(requests.length, 0, 'the breaker reads the file, not the network');

	writeUsage(19.5, { baseline: 18 });
	assert.equal((await run({ question: 'Under the points', to: 'consultant' })).isError, undefined);
	await settle();
	assert.equal(requests.length, 1, 'the call is followed by one reading in the background');
	assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/wham/usage');
	assert.equal(requests[0].init.headers['chatgpt-account-id'], 'acct-test');
	assert.match((await run({ question: 'After the reading', to: 'consultant' })).content[0].text, /weekly quota/, 'the reading after the call (99) closes the session');
}));

test('the default is 3 points, and 0 switches the points check off', async (t) => {
	await withTeam(t, { consultant: 'openai-codex/latest-astra' }, async () => {
		usageFetch(t, 50);
		const { run } = harness({ available: [codexModel], apiKey: token });
		writeUsage(20.9, { baseline: 18 });
		assert.equal((await run({ question: 'Under 3', to: 'consultant' })).isError, undefined);
		await settle();
		writeUsage(21, { baseline: 18 });
		assert.equal((await run({ question: 'At 3', to: 'consultant' })).isError, true);
	});
	await withTeam(t, { consultant: 'openai-codex/latest-astra', subscriptionPoints: 0 }, async () => {
		usageFetch(t, 50);
		const { run } = harness({ available: [codexModel], apiKey: token });
		writeUsage(60, { baseline: 18 });
		assert.equal((await run({ question: 'No breaker', to: 'consultant' })).isError, undefined);
		await settle();
		writeUsage(60, { baseline: 18, limitReached: true });
		assert.equal((await run({ question: 'Spent', to: 'consultant' })).isError, true, 'a spent quota still stops it');
	});
});

test('an account with no quota left stops the consultant whatever the session added', (t) => withTeam(t, codexTeam, async () => {
	usageFetch(t, 50);
	const calls = [];
	const { run } = harness({ available: [codexModel], apiKey: token, complete: answering(calls) });
	writeUsage(100, { baseline: 100, limitReached: true });
	assert.equal((await run({ question: 'Quota?', to: 'consultant' })).isError, true);
	assert.deepEqual(calls, []);
}));

test('a reading that is old or from a window that has reset denies nothing', (t) => withTeam(t, codexTeam, async () => {
	const saved = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error('offline'); };
	t.after(() => { globalThis.fetch = saved; });
	const calls = [];
	const { pi, ctx, run } = harness({ available: [codexModel], apiKey: token, complete: answering(calls) });
	const hours = (n) => n * 3_600_000;
	writeUsage(100, { baseline: 10, limitReached: true, ageMs: hours(7) });
	assert.equal((await run({ question: 'Seven hours old', to: 'consultant' })).isError, undefined, 'older than 6 hours is unknown');
	await settle();
	writeUsage(100, { baseline: 10, limitReached: true, resetAt: Date.now() - 1_000, ageMs: 5_000 });
	assert.equal((await run({ question: 'Reset since', to: 'consultant' })).isError, undefined, 'a reading from before its reset is unknown');
	await settle();
	pi.handlers.get('input')({ type: 'input', source: 'interactive', text: 'next' }, ctx);
	writeUsage(90, { baseline: 10, resetAt: Date.now() + hours(48), baselineResetAt: Date.now() - hours(120), ageMs: 5_000 });
	assert.equal((await run({ question: 'Baseline from last week', to: 'consultant' })).isError, undefined, 'a baseline from an earlier window is unknown');
	assert.equal(calls.length, 3);
}));

test('a session with no baseline reads one before the first call and counts the call after it', (t) => withTeam(t, codexTeam, async () => {
	const requests = usageFetch(t, 12);
	const calls = [];
	const { run } = harness({ available: [codexModel], apiKey: token, complete: answering(calls) });
	// The last reading is 11 s old: shared for the baseline, and old enough for a forced reading after the call.
	fs.writeFileSync(stateFile(), JSON.stringify({ last: { weeklyPercent: 10, limitReached: false, at: Date.now() - 11_000 }, lastAttemptAt: Date.now() - 11_000, sessions: {} }));
	assert.equal((await run({ question: 'First', to: 'consultant' })).isError, undefined);
	await settle();
	assert.equal(requests.length, 1, 'the shared reading was the baseline; one reading follows the call');
	const refused = await run({ question: 'Second', to: 'consultant' });
	assert.equal(refused.isError, true, 'the quota moved 2 points');
	assert.equal(calls.length, 1);
}));

test('the answer is not held back by a stuck reading, and the slot is free at once', (t) => withTeam(t, { consultant: 'openai-codex/latest-astra', subscriptionPoints: 0 }, async () => {
	const saved = globalThis.fetch;
	globalThis.fetch = () => new Promise(() => {});
	t.after(() => { globalThis.fetch = saved; });
	const { run } = harness({ available: [codexModel], apiKey: token });
	writeUsage(10, { baseline: 10 });
	const first = await Promise.race([run({ question: 'Stuck?', to: 'consultant' }), new Promise((resolve) => setTimeout(() => resolve('held'), 1_500))]);
	assert.notEqual(first, 'held', 'the answer came back while the reading was still pending');
	assert.equal(first.isError, undefined);
	assert.equal((await run({ question: 'Again', to: 'consultant' })).isError, undefined, 'no one-at-a-time refusal');
}));

test('a stuck credential or request is cut at the deadline and does not hold the first call', (t) => withTeam(t, codexTeam, async () => {
	const { run } = harness({ available: [codexModel], apiKey: token });
	const controller = new AbortController();
	const stuck = run({ question: 'Waiting for the baseline', to: 'consultant' }, controller.signal);
	setTimeout(() => controller.abort(), 50);
	await assert.doesNotReject(Promise.race([stuck, new Promise((_, reject) => setTimeout(() => reject(new Error('held')), 2_000))]));
}));

test('only an OAuth login is sent to the usage endpoint', async (t) => {
	await withTeam(t, codexTeam, async () => {
		const requests = usageFetch(t, 10);
		const calls = [];
		const { run } = harness({ available: [codexModel], apiKey: token, oauth: false, complete: answering(calls) });
		assert.equal((await run({ question: 'A JWT-shaped API key', to: 'consultant' })).isError, undefined);
		await settle();
		assert.equal(requests.length, 0, 'an API key that looks like a ChatGPT token is not sent');
		assert.equal(calls.length, 1);
	});
});

test('without a ChatGPT login nothing is read and the call goes ahead; other models never meet the breaker', async (t) => {
	await withTeam(t, codexTeam, async () => {
		const requests = usageFetch(t, 10);
		const calls = [];
		const { run } = harness({ available: [codexModel], apiKey: ['plain', 'key', 'no', 'jwt'].join('-'), complete: answering(calls) });
		assert.equal((await run({ question: 'No login', to: 'consultant' })).isError, undefined);
		await settle();
		assert.equal(requests.length, 0);
	});
	await withTeam(t, both, async () => {
		const requests = usageFetch(t, 10);
		const { run } = harness({ available: [model, consultantModel], apiKey: token });
		writeUsage(90, { baseline: 10, limitReached: true });
		assert.equal((await run({ question: 'Other vendor', to: 'consultant' })).isError, undefined);
		await settle();
		assert.equal(requests.length, 0);
	});
});

test('a call is entered before it is sent, and a reload counts the entry whatever became of the call', (t) => withTeam(t, both, async () => {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const first = harness({ available: [model, consultantModel], complete: async () => { await gate; return { content: [{ type: 'text', text: 'late' }], stopReason: 'stop', usage: {} }; } });
	const pending = first.run({ question: 'Lost midway', to: 'consultant' });
	await settle();
	const entered = first.pi.appended.filter((entry) => entry.customType === 'advisor-v1');
	assert.deepEqual(entered.map((entry) => [entry.data.target, entry.data.status]), [['consultant', 'pending']], 'the entry exists while the call is out');
	const snapshot = [humanMessage, ...entered];

	// The process dies here: a reload sees only the pending entry, and the run has one consultant call used.
	const reloaded = harness({ available: [model, consultantModel], entries: snapshot });
	assert.equal((await reloaded.run({ question: 'Second', to: 'consultant' })).isError, undefined);
	assert.match((await reloaded.run({ question: 'Third', to: 'consultant' })).content[0].text, /Consultant: 2 per run reached/, 'the lost call and the second use the 2 of the run');
	release();
	await pending;
	const outcome = first.pi.appended.filter((entry) => entry.customType === 'advisor-v1').map((entry) => entry.data.status);
	assert.deepEqual(outcome, ['pending', 'answered']);
	const ids = new Set(first.pi.appended.filter((entry) => entry.customType === 'advisor-v1').map((entry) => entry.data.id));
	assert.equal(ids.size, 1, 'the two entries of one call share an id and count once');
	const again = harness({ available: [model, consultantModel], entries: [humanMessage, ...first.pi.appended] });
	assert.equal((await again.run({ question: 'One more', to: 'consultant' })).isError, undefined, 'one call counts once, not twice');
}));

test('a reload keeps the run count of the calls after the latest human message and drops earlier runs', (t) => withTeam(t, both, async () => {
	const call = (id, target) => ({ type: 'custom', customType: 'advisor-v1', data: { id, target, status: 'answered' } });
	const entries = [call('a', 'advisor'), call('b', 'advisor'), call('c', 'advisor'), humanMessage, call('d', 'advisor'), call('e', 'advisor')];
	const { run } = harness({ entries });
	assert.equal((await run({ question: 'Third of this run' })).isError, undefined);
	assert.match((await run({ question: 'Fourth' })).content[0].text, /3 per run reached/);
}));
