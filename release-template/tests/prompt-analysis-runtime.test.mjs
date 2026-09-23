import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
	fs.existsSync(path.join(p, 'extensions/lib/prompt-analysis-runtime.ts')),
);
if (!agent) throw new Error('agent extension tree is missing');
const runtime = await import(pathToFileURL(path.join(agent, 'extensions/lib/prompt-analysis-runtime.ts')));
const interpretation = await import(pathToFileURL(path.join(agent, 'extensions/lib/prompt-interpretation.ts')));

function reply(prompt, extra = {}) {
	return JSON.stringify({
		intent: 'Implement a bounded prompt analysis',
		taskLabel: 'Bounded prompt analysis',
		confidence: 0.82,
		deliverables: ['typed advisory'],
		explicitConstraints: [prompt],
		inferredConstraints: [{ text: 'Use a compact response', confidence: 0.75 }],
		subtasks: ['parse the response'],
		...extra,
	});
}

test('routes advance after fast failures and malformed attempts keep their measured usage', async () => {
	const prompt = 'Preserve the existing return shape.';
	const outcomes = [];
	let calls = 0;
	const result = await runtime.runPromptAnalysis({
		prompt,
		kind: 'initial',
		candidates: [
			{ route: 'provider/one', complete: async () => { calls++; return { text: '{malformed', inputTokens: 5, outputTokens: 2 }; } },
			{ route: 'provider/two', complete: async () => { calls++; throw new Error('transport down'); } },
			{ route: 'provider/three', complete: async (request) => { calls++; assert.equal(request.maxTokens, 768); return { text: reply(prompt), inputTokens: 7, outputTokens: 3 }; } },
		],
		onAttempt: (attempt) => outcomes.push(attempt),
	});
	assert.equal(calls, 3);
	assert.equal(result.status, 'model');
	assert.equal(result.route, 'provider/three');
	assert.equal(result.attempts, 3);
	assert.equal(result.inputTokens, 12);
	assert.equal(result.outputTokens, 5);
	assert.deepEqual(outcomes.map(({ outcome }) => outcome), ['malformed', 'failed', 'complete']);
	assert.equal(result.analysis.explicitConstraints[0].text, prompt);
});

test('follow-up uses the compact output budget and emits a gated relation', async () => {
	const prompt = 'Also add a validation test.';
	let maxTokens;
	const result = await runtime.runPromptAnalysis({
		prompt,
		kind: 'followup',
		previous: { taskLabel: 'Existing endpoint', explicitConstraints: [], subtasks: ['earlier suggested test'] },
		candidates: [{ route: 'provider/cheap', complete: async (request) => {
			maxTokens = request.maxTokens;
			assert.match(request.prompt, /priorSuggestedSubtasks/);
			return { text: reply(prompt, { relation: 'expand' }), inputTokens: 11, outputTokens: 4 };
		} }],
	});
	assert.equal(maxTokens, 320);
	assert.equal(result.analysis.relation, 'expand');
	assert.equal(result.analysis.source, 'model');
});

test('timeout returns fallback with pending usage and reconciles late completion by attempt id', async () => {
	const prompt = 'Implement an API endpoint.';
	let finish;
	const outcomes = [];
	const result = await runtime.runPromptAnalysis({
		prompt,
		kind: 'followup',
		candidates: [{ route: 'provider/slow', complete: () => new Promise((resolve) => { finish = resolve; }) }],
		budget: { totalMs: 20, perAttemptMs: 5, maxAttempts: 1 },
		onAttempt: (attempt) => outcomes.push(attempt),
	});
	assert.equal(result.status, 'fallback');
	assert.equal(result.usagePendingAttempts, 1);
	assert.equal(result.usageUnknownAttempts, 0);
	assert.deepEqual(outcomes.map(({ outcome }) => outcome), ['timeout']);
	finish({ text: reply(prompt), inputTokens: 13, outputTokens: 8 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(outcomes.map(({ outcome }) => outcome), ['timeout', 'late-complete']);
	assert.equal(outcomes[1].attempt, outcomes[0].attempt);
	assert.equal(outcomes[1].inputTokens, 13);
});

test('abort cancels preflight and late provider failure is one pending-attempt reconciliation', async () => {
	const controller = new AbortController();
	let fail;
	const outcomes = [];
	const running = runtime.runPromptAnalysis({
		prompt: 'Review this request.',
		kind: 'initial',
		candidates: [{ route: 'provider/cancellable', complete: () => new Promise((_resolve, reject) => { fail = reject; }) }],
		signal: controller.signal,
		onAttempt: (attempt) => outcomes.push(attempt),
	});
	while (!fail) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const result = await running;
	assert.equal(result.status, 'cancelled');
	assert.equal(result.usagePendingAttempts, 1);
	assert.equal(result.usageUnknownAttempts, 0);
	fail(new Error('late transport failure'));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(outcomes.map(({ outcome }) => outcome), ['late-failed']);
	assert.equal(outcomes[0].usage, 'unknown');
});

test('literal constraints keep exact offsets and abstain on quoted, example, conditional, or negated spans', () => {
	const prompt = 'Never deploy. Preserve the existing error shape. If enabled, delete cached records. Example: use "fast mode". `skip tests`';
	const parsed = interpretation.parsePromptAnalysis(JSON.stringify({
		intent: 'Update endpoint', confidence: 0.9,
		explicitConstraints: [
			'deploy',
			'Preserve the existing error shape',
			'delete cached records',
			'fast mode',
			'skip tests',
		],
		inferredConstraints: [{ text: 'delete cached records only if enabled', confidence: 0.62 }],
	}), prompt, 'initial');
	assert.deepEqual(parsed.explicitConstraints.map(({ text, quoted }) => ({ text, quoted })), [
		{ text: 'Preserve the existing error shape', quoted: false },
		{ text: 'fast mode', quoted: true },
		{ text: 'skip tests', quoted: true },
	]);
	assert.deepEqual(parsed.inferredConstraints, [{ text: 'delete cached records only if enabled', confidence: 0.62 }]);
	const span = parsed.explicitConstraints[0];
	assert.equal(prompt.slice(span.start, span.end), span.text);
	const event = interpretation.promptAnalysisEvent({ processId: 'p', sessionId: 's', turnId: 't', requestId: 'r', prompt, analysis: parsed });
	assert.equal(event.promptHash, interpretation.promptAnalysisHash(prompt));
});

test('later priorities run when earlier attempt allowances leave time', async () => {
	const calls = [];
	const result = await runtime.runPromptAnalysis({
		prompt: 'Keep the endpoint behavior.', kind: 'initial',
		budget: { totalMs: 250, perAttemptMs: 75 },
		candidates: ['one', 'two', 'three'].map((route) => ({ route, complete: async () => {
			calls.push(route);
			if (route !== 'three') return new Promise(() => {});
			return { text: reply('Keep the endpoint behavior.') };
		} })),
	});
	assert.deepEqual(calls, ['one', 'two', 'three']);
	assert.equal(result.status, 'model');
	assert.equal(result.route, 'three');
});

test('throwing observability callbacks cannot discard a valid analysis or break fallback', async () => {
	const result = await runtime.runPromptAnalysis({
		prompt: 'Keep the endpoint behavior.', kind: 'initial',
		candidates: [
			{ route: 'invalid', complete: async () => ({ text: '{' }) },
			{ route: 'valid', complete: async () => ({ text: reply('Keep the endpoint behavior.') }) },
		],
		onAttempt: () => { throw new Error('unavailable observer'); },
	});
	assert.equal(result.status, 'model');
	assert.equal(result.route, 'valid');
});

test('a sole configured route gets the available total budget before falling back', async () => {
	const result = await runtime.runPromptAnalysis({
		prompt: 'Keep the endpoint behavior.', kind: 'initial',
		budget: { totalMs: 250, perAttemptMs: 10 },
		candidates: [{ route: 'single', complete: async () => {
			await new Promise(resolve => setTimeout(resolve, 30));
			return { text: reply('Keep the endpoint behavior.') };
		} }],
	});
	assert.equal(result.status, 'model');
});

test('mindset scaffolding does not become the task, and original literal spans stay exact', () => {
	const raw = '<mindset>Work carefully. Preserve existing behavior.</mindset>\nImplement keyboard navigation in the menu. Keep the title unchanged.';
	assert.match(interpretation.fallbackPromptAnalysis(raw, 'initial').intent, /^Implement keyboard navigation/);
	const request = JSON.parse(interpretation.buildPromptAnalysisRequest(raw, 'initial').split('\n').at(-1));
	assert.equal(request.currentPrompt, raw);
	assert.equal(request.requestFocus, 'Implement keyboard navigation in the menu. Keep the title unchanged.');
	const analysis = interpretation.parsePromptAnalysis(reply('Keep the title unchanged.'), raw, 'initial');
	assert.equal(raw.slice(analysis.explicitConstraints[0].start, analysis.explicitConstraints[0].end), 'Keep the title unchanged.');
	assert.equal(interpretation.promptRequestFocus('<instructions>Implement the requested parser.</instructions>'), '<instructions>Implement the requested parser.</instructions>');
	assert.match(interpretation.promptRequestFocus('<mindset>Unclosed guidance. Implement the parser.'), /Implement the parser/);
});

test('oversized input keeps the tail objective and verifiable constraints without a silent size rejection', () => {
	const raw = '<mindset>' + 'General guidance. '.repeat(60_000) + '</mindset>\nImplement a bounded parser. Preserve exact offsets.';
	const request = JSON.parse(interpretation.buildPromptAnalysisRequest(raw, 'initial').split('\n').at(-1));
	assert.ok(request.currentPrompt.length <= 24_000);
	assert.match(request.currentPrompt, /middle omitted/);
	assert.match(request.requestFocus, /^Implement a bounded parser/);
	assert.match(interpretation.fallbackPromptAnalysis(raw, 'initial').intent, /^Implement a bounded parser/);
	const parsed = interpretation.parsePromptAnalysis(reply('Preserve exact offsets.'), raw, 'initial');
	assert.equal(parsed.explicitConstraints.length, 1);
	assert.equal(raw.slice(parsed.explicitConstraints[0].start, parsed.explicitConstraints[0].end), 'Preserve exact offsets.');
});

test('route errors preserve a safe category without copying provider response bodies', async () => {
	const outcomes = [];
	const result = await runtime.runPromptAnalysis({ prompt: 'Inspect the endpoint.', kind: 'initial',
		candidates: [{ route: 'fixture/model', complete: async () => { throw new Error('HTTP 400 invalid_request_error: private response body'); } }],
		onAttempt: attempt => outcomes.push(attempt),
	});
	assert.equal(result.status, 'fallback');
	assert.equal(outcomes[0].failureCategory, 'invalid-request');
	assert.doesNotMatch(JSON.stringify(outcomes), /private response body/);
});
