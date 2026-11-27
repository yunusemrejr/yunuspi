import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	codexCredentialOf, codexQuotaText, codexSessionDelta, codexSessionOverBudget, noteSessionBaseline,
	parseCodexUsage, readCodexUsage, usesCodex,
} from '../agent/extensions/lib/codex-usage.ts';

const WEEK = 604_800;
const DAY = 86_400_000;
/** The payload shape the endpoint returns today for a plan with one weekly window. */
const payload = (used = 18, extra = {}) => ({
	plan_type: 'prolite',
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: used, limit_window_seconds: WEEK, reset_after_seconds: 494_207, reset_at: 1_796_281_813 },
		secondary_window: null,
		...extra,
	},
});

function agentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return path.join(dir, 'codex-usage.json');
}

/** A fetch that answers with the next payload and records each request. */
function fakeFetch(...bodies) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
		if (body instanceof Error) throw body;
		return { ok: body !== null, status: body === null ? 500 : 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
	};
	return { impl, calls };
}
const credential = async () => ({ access: 'access-token', accountId: 'acct-1' });

test('the weekly window is found whichever slot holds it, and the other is the short window', () => {
	const real = parseCodexUsage(payload(18), 1_000);
	assert.deepEqual(real, { weeklyPercent: 18, weeklyResetAt: 1_796_281_813_000, limitReached: false, at: 1_000 });

	const both = parseCodexUsage({ rate_limit: {
		primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_after_seconds: 60 },
		secondary_window: { used_percent: 7.5, limit_window_seconds: WEEK, reset_after_seconds: 3_600 },
	} }, 10_000);
	assert.deepEqual(both, { weeklyPercent: 7.5, weeklyResetAt: 10_000 + 3_600_000, shortPercent: 40, limitReached: false, at: 10_000 });
	assert.equal(parseCodexUsage(payload(5, { limit_reached: true }), 1)?.limitReached, true);
});

test('a payload without a usable weekly window, or with junk, is no reading', () => {
	for (const junk of [undefined, null, 'x', 7, [], {}, { rate_limit: null }, { rate_limit: {} },
		{ rate_limit: { primary_window: { used_percent: 'high', limit_window_seconds: WEEK } } },
		{ rate_limit: { primary_window: { used_percent: NaN, limit_window_seconds: WEEK } } },
		{ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 }, secondary_window: null } },
		{ rate_limit: { primary_window: { used_percent: 10 } } }]) {
		assert.equal(parseCodexUsage(junk, 1), undefined, JSON.stringify(junk));
	}
});

test('percentages are clamped to 0..100 and an unusable reset is left out', () => {
	assert.equal(parseCodexUsage(payload(250), 1)?.weeklyPercent, 100);
	assert.equal(parseCodexUsage(payload(-3), 1)?.weeklyPercent, 0);
	const noReset = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: WEEK } } }, 1);
	assert.equal('weeklyResetAt' in noReset, false);
});

test('a reading is fetched once with the identity headers, stored 0600, and shared for a minute', async (t) => {
	const file = agentDir(t);
	const { impl, calls } = fakeFetch(payload(18), payload(30));
	let clock = Date.now();
	const options = { credential, fetchImpl: impl, now: () => clock, sessionId: 's1' };
	const first = await readCodexUsage(options);
	assert.equal(first.weeklyPercent, 18);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
	assert.equal(calls[0].init.headers.authorization, 'Bearer access-token');
	assert.equal(calls[0].init.headers['chatgpt-account-id'], 'acct-1');
	assert.equal(calls[0].init.headers.originator, 'yunuspi');
	assert.equal(calls[0].init.headers.accept, 'application/json');
	assert.match(calls[0].init.headers['User-Agent'], /^pi\//);
	assert.ok(calls[0].init.signal, 'the request is bounded by a deadline');
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ['codex-usage.json'], 'no temporary file is left');

	clock += 59_000;
	assert.equal((await readCodexUsage(options)).weeklyPercent, 18, 'inside a minute the shared reading answers');
	assert.equal(calls.length, 1);
	clock += 2_000;
	assert.equal((await readCodexUsage(options)).weeklyPercent, 30, 'after a minute the endpoint is asked again');
	assert.equal(calls.length, 2);
});

test('the interval counts from the last attempt: a failure and a forced read do not bypass it', async (t) => {
	agentDir(t);
	let clock = Date.now();
	const failing = fakeFetch(null);
	const options = { credential, fetchImpl: failing.impl, now: () => clock };
	assert.equal(await readCodexUsage(options), undefined);
	clock += 5_000;
	assert.equal(await readCodexUsage({ ...options, force: true }), undefined);
	clock += 25_000;
	assert.equal(await readCodexUsage(options), undefined);
	assert.equal(failing.calls.length, 1, 'a failed try is not retried inside the minute, and a forced one waits 10 s');

	const answering = fakeFetch(payload(5), payload(6));
	clock += 31_000;
	assert.equal((await readCodexUsage({ ...options, fetchImpl: answering.impl })).weeklyPercent, 5);
	clock += 5_000;
	assert.equal((await readCodexUsage({ ...options, fetchImpl: answering.impl, force: true }))?.weeklyPercent, 5, 'forced inside 10 s: the shared reading');
	assert.equal(answering.calls.length, 1);
	clock += 6_000;
	assert.equal((await readCodexUsage({ ...options, fetchImpl: answering.impl, force: true })).weeklyPercent, 6, 'forced after 10 s reads again');
	assert.equal(answering.calls.length, 2);
});

test('the attempt is recorded before the request goes out, so a second process waits', async (t) => {
	const file = agentDir(t);
	let seenDuringRequest;
	const impl = async () => {
		seenDuringRequest = JSON.parse(fs.readFileSync(file, 'utf8')).lastAttemptAt;
		return { ok: true, text: async () => JSON.stringify(payload(1)) };
	};
	await readCodexUsage({ credential, fetchImpl: impl, now: () => 123_456_789 });
	assert.equal(seenDuringRequest, 123_456_789);
});

test('credential, request and body share one deadline and the caller signal', async (t) => {
	agentDir(t);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 30);
	const started = Date.now();
	const stuckCredential = () => new Promise(() => {});
	assert.equal(await readCodexUsage({ credential: stuckCredential, signal: controller.signal }), undefined);
	assert.ok(Date.now() - started < 1_000, 'a credential that never resolves is cut by the caller signal');

	const refusedSignal = new AbortController();
	refusedSignal.abort();
	const quiet = fakeFetch(payload(1));
	assert.equal(await readCodexUsage({ credential, fetchImpl: quiet.impl, signal: refusedSignal.signal, now: () => Date.now() + 120_000 }), undefined);
	assert.equal(quiet.calls.length, 0, 'an aborted caller sends nothing');
});

test('no credential, a failed request or an unreadable answer is silent and gives no reading', async (t) => {
	agentDir(t);
	let clock = Date.now();
	const { impl, calls } = fakeFetch(payload(1));
	assert.equal(await readCodexUsage({ credential: async () => undefined, fetchImpl: impl, now: () => clock }), undefined);
	assert.equal(calls.length, 0, 'no credential, no request');
	for (const answer of [null, new Error('offline'), 'not json', JSON.stringify({ rate_limit: {} })]) {
		clock += 61_000;
		const failing = fakeFetch(answer);
		assert.equal(await readCodexUsage({ credential, fetchImpl: failing.impl, sessionId: 's', now: () => clock }), undefined);
		assert.equal(codexSessionDelta('s', clock), undefined);
	}
	clock += 61_000;
	assert.equal(await readCodexUsage({ credential: async () => { throw new Error('boom'); }, fetchImpl: impl, now: () => clock }), undefined);
});

test('an answer over 64 KiB is cut off as it streams and never read in full', async (t) => {
	agentDir(t);
	let pulled = 0;
	let cancelled = false;
	const chunk = new Uint8Array(16_384).fill(32);
	const body = new ReadableStream({
		pull(controller) { pulled++; controller.enqueue(chunk); },
		cancel() { cancelled = true; },
	});
	assert.equal(await readCodexUsage({ credential, fetchImpl: async () => new Response(body, { status: 200 }) }), undefined);
	assert.equal(cancelled, true, 'the body was cancelled');
	assert.ok(pulled <= 8, `read ${pulled} chunks, not the whole stream`);

	const small = new Response(JSON.stringify(payload(21)), { status: 200 });
	assert.equal((await readCodexUsage({ credential, fetchImpl: async () => small, now: () => Date.now() + 120_000 }))?.weeklyPercent, 21, 'a normal body streams through');
});

test('a session baseline is its first reading and the delta counts from it', async (t) => {
	agentDir(t);
	let clock = Date.now();
	const { impl } = fakeFetch(payload(18), payload(20), payload(21));
	const read = (sessionId) => { clock += 61_000; return readCodexUsage({ credential, fetchImpl: impl, now: () => clock, sessionId }); };
	assert.equal(codexSessionDelta('a', clock), undefined, 'unknown before any reading');
	assert.equal(codexSessionOverBudget('a', 1, clock), false);
	await read('a');
	assert.equal(codexSessionDelta('a', clock), 0);
	await read('a');
	assert.equal(codexSessionDelta('a', clock), 2, 'the baseline stays at the first reading');
	await read('b');
	assert.equal(codexSessionDelta('b', clock), 0, 'another session starts from the reading it first saw');
	assert.equal(codexSessionDelta('a', clock), 3);
	assert.equal(codexSessionOverBudget('a', 3, clock), true);
	assert.equal(codexSessionOverBudget('a', 4, clock), false);
	assert.equal(codexSessionOverBudget('a', 0, clock), false, 'points of 0 or less switch the check off');
	assert.equal(codexSessionOverBudget('b', 1, clock), false);
	assert.equal(codexSessionOverBudget(undefined, 1, clock), false);
	assert.equal(codexSessionOverBudget('never-read', 1, clock), false, 'an unknown session is not over budget');
});

test('the checks never wait for the network and an exhausted quota stops every session', async (t) => {
	const file = agentDir(t);
	fs.writeFileSync(file, JSON.stringify({
		last: { weeklyPercent: 50, limitReached: true, at: Date.now() },
		sessions: { quiet: { baseline: 50, at: Date.now() } },
	}));
	assert.equal(codexSessionOverBudget('quiet', 1), true);
	assert.equal(codexSessionOverBudget('unknown', 1), true);
	assert.equal(codexSessionOverBudget('quiet', 0), true, 'switching the points check off does not hide an exhausted quota');
	assert.equal(codexSessionOverBudget(undefined, 3), true);
});

test('a reading older than 6 hours or from before its reset is unknown and denies nothing', async (t) => {
	const file = agentDir(t);
	const now = Date.now();
	const write = (last, baseline = 10) => fs.writeFileSync(file, JSON.stringify({ last, sessions: { s: { baseline, at: now } } }));
	write({ weeklyPercent: 90, limitReached: true, at: now - 7 * 3_600_000 });
	assert.equal(codexSessionOverBudget('s', 1, now), false);
	assert.equal(codexSessionDelta('s', now), undefined);
	assert.equal(codexQuotaText('s', now), undefined);
	write({ weeklyPercent: 90, limitReached: true, at: now - 60_000, weeklyResetAt: now - 1_000 });
	assert.equal(codexSessionOverBudget('s', 1, now), false, 'the window has reset since the reading');
	assert.equal(codexQuotaText('s', now), undefined);
	write({ weeklyPercent: 90, limitReached: true, at: now - 60_000, weeklyResetAt: now + 1_000 });
	assert.equal(codexSessionOverBudget('s', 1, now), true, 'a recent reading inside its window counts');
});

test('a new window rebases the session baseline; a baseline from an earlier window is unknown', async (t) => {
	const file = agentDir(t);
	let clock = Date.now();
	const week = 7 * 24 * 3_600;
	const inWindow = (used, resetInSeconds) => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: week, reset_at: Math.floor(clock / 1000) + resetInSeconds } } });
	const read = (body) => { clock += 61_000; return readCodexUsage({ credential, fetchImpl: fakeFetch(body).impl, now: () => clock, sessionId: 'w' }); };
	await read(inWindow(40, 3_600));
	await read(inWindow(43, 3_600));
	assert.equal(codexSessionDelta('w', clock), 3);
	// The week turns over: usage is back near 0 and the reset time moved by a week. Counting continues from the new reading.
	await read(inWindow(45, 3_600 + week));
	assert.equal(codexSessionDelta('w', clock), 0, 'the session counts from the new window');
	await read(inWindow(47, 3_600 + week));
	assert.equal(codexSessionDelta('w', clock), 2);
	// Another process wrote a newer window's reading; this session's baseline is still from the old one.
	const written = JSON.parse(fs.readFileSync(file, 'utf8'));
	written.last.weeklyResetAt += week * 1000;
	fs.writeFileSync(file, JSON.stringify(written));
	assert.equal(codexSessionDelta('w', clock), undefined);
	assert.equal(codexSessionOverBudget('w', 1, clock), false);
});

test('a reading below the baseline with no reset time to compare means the week restarted', async (t) => {
	agentDir(t);
	let clock = Date.now();
	const bare = (used) => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: WEEK } } });
	const read = (body) => { clock += 61_000; return readCodexUsage({ credential, fetchImpl: fakeFetch(body).impl, now: () => clock, sessionId: 'w' }); };
	await read(bare(80));
	await read(bare(2));
	assert.equal(codexSessionDelta('w', clock), 0);
	await read(bare(3));
	assert.equal(codexSessionDelta('w', clock), 1);
});

test('sessions older than 8 days are pruned when the file is next written, and a damaged file reads as unknown', async (t) => {
	const file = agentDir(t);
	const now = Date.now();
	fs.writeFileSync(file, JSON.stringify({
		last: { weeklyPercent: 10, limitReached: false, at: now - 3_600_000 },
		sessions: { old: { baseline: 1, at: now - 9 * DAY }, recent: { baseline: 1, at: now - 7 * DAY } },
	}));
	assert.equal(codexSessionDelta('old', now), 9, 'readable until the next write');
	noteSessionBaseline('fresh', { weeklyPercent: 10, limitReached: false, at: now });
	const written = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(Object.keys(written.sessions).sort(), ['fresh', 'recent']);

	fs.writeFileSync(file, '{ not json');
	assert.equal(codexSessionDelta('fresh', now), undefined);
	assert.equal(codexSessionOverBudget('fresh', 1, now), false);
	assert.equal(codexQuotaText('fresh'), undefined);
	fs.writeFileSync(file, JSON.stringify({ last: { weeklyPercent: 'x' }, sessions: { s: { baseline: 'y' }, ok: { baseline: 4, at: 1 } } }));
	assert.equal(codexSessionDelta('s'), undefined);
});

test('the facts text states the week, adds the session only from a whole point, and drops a stale reading', async (t) => {
	const file = agentDir(t);
	const now = Date.now();
	const write = (last, sessions = {}) => fs.writeFileSync(file, JSON.stringify({ last, sessions }));
	write({ weeklyPercent: 18, limitReached: false, at: now }, { s: { baseline: 18, at: now } });
	assert.equal(codexQuotaText('s', now), 'GPT quota: 18% of the week used');
	write({ weeklyPercent: 18.4, limitReached: false, at: now }, { s: { baseline: 16, at: now } });
	assert.equal(codexQuotaText('s', now), 'GPT quota: 18% of the week used, this session +2');
	write({ weeklyPercent: 18.4, limitReached: false, at: now }, { s: { baseline: 17.6, at: now } });
	assert.equal(codexQuotaText('s', now), 'GPT quota: 18% of the week used', 'under a whole point stays out');
	assert.equal(codexQuotaText(undefined, now), 'GPT quota: 18% of the week used');
	assert.equal(codexQuotaText('s', now + 7 * 3_600_000), undefined, 'an old reading is not stated as current');
});

const jwt = (claims) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('the credential comes through the registry, only with a ChatGPT login', async () => {
	const codex = { provider: 'openai-codex', id: 'gpt-x' };
	const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } });
	const registry = (models, apiKey, oauth = true) => ({ getAvailable: () => models, getApiKeyAndHeaders: async () => ({ ok: true, apiKey }), isUsingOAuth: () => oauth });
	assert.deepEqual(await codexCredentialOf(registry([codex], token)), { access: token, accountId: 'acct-9' });
	assert.equal(await codexCredentialOf(registry([{ provider: 'example', id: 'm' }], token)), undefined, 'no ChatGPT model, no credential');
	assert.equal(await codexCredentialOf(registry([codex], 'sk-plain-api-key')), undefined, 'an API key is no ChatGPT login');
	assert.equal(await codexCredentialOf(registry([codex], jwt({}))), undefined, 'no account id in the token');
	assert.equal(await codexCredentialOf(registry([codex], token, false)), undefined, 'an API key shaped like a ChatGPT token is not a login');
	assert.equal(await codexCredentialOf({ getAvailable: () => [codex], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) }), undefined, 'a registry that cannot say is not trusted');
	assert.equal(await codexCredentialOf({ getAvailable: () => [codex], getApiKeyAndHeaders: async () => ({ ok: false, error: 'x' }) }), undefined);
	assert.equal(await codexCredentialOf({ getAvailable: () => { throw new Error('x'); } }), undefined);
	assert.equal(await codexCredentialOf(undefined), undefined);
});

test('a session counts as using the subscription from its model or any team model', () => {
	assert.equal(usesCodex({}, { provider: 'openai-codex' }), true);
	assert.equal(usesCodex({ advisor: 'openai-codex/latest-astra' }, { provider: 'deepseek' }), true);
	assert.equal(usesCodex({ consultant: 'openai-codex/gpt-x' }), true);
	assert.equal(usesCodex({ sublegwork: 'openai-codex/gpt-x' }), true);
	assert.equal(usesCodex({ helper: 'inherit', legwork: 'deepseek/x', advisor: 'off', consultant: 'off' }, { provider: 'deepseek' }), false);
	assert.equal(usesCodex({}), false);
});
