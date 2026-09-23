import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
	fs.existsSync(path.join(p, 'extensions/micro-intelligence.ts')),
);
if (!agent) throw new Error('agent extension tree is missing');
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-analysis-lifecycle-'));
const preferencesFile = path.join(configDir, 'llm_preferences.json');
process.env.PI_CODING_AGENT_DIR = configDir;
process.env.PI_PROVIDER_STATE_FILE = path.join(configDir, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(configDir, 'exclusions.json');
process.env.PI_LLM_PREFERENCES_FILE = preferencesFile;
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(configDir, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
delete process.env.PI_SUBAGENT_CHILD;

const { default: register, lastMicroRequest, microRequestAdvice } = await import(pathToFileURL(path.join(agent, 'extensions/micro-intelligence.ts')));
const { clearLlmPreferencesCache } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/llm-preferences.ts')));
const { searchCapabilityMetadata } = await import(pathToFileURL(path.join(agent, 'extensions/lib/capability-groups.ts')));
const { collectSessionMetrics } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-metrics.ts')));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const routeInside = { provider: 'openrouter', id: 'test/inside', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', input: ['text'], contextWindow: 65_536, maxTokens: 4096, reasoning: true, cost: { input: 0.1, output: 0.1 } };
const routeOutside = { ...routeInside, id: 'test/outside' };
const promptA = 'Implement the endpoint. Preserve the existing error shape.';
const promptB = 'Also add a validation test. Do not change the return code.';

function writePreferences({ promptAnalysis = ['outside', 'inside'], subagents = ['inside'] } = {}) {
	const models = { inside: { provider: routeInside.provider, model: routeInside.id }, outside: { provider: routeOutside.provider, model: routeOutside.id } };
	const preferences = {};
	if (promptAnalysis) preferences.prompt_analysis = { models: promptAnalysis };
	if (subagents) preferences.subagents = { models: subagents };
	fs.writeFileSync(preferencesFile, JSON.stringify({ version: 1, models, preferences }));
	clearLlmPreferencesCache();
}

function analysisAnswer(requestPrompt, taskLabel = 'Parsed task') {
	const jsonLine = requestPrompt.slice(requestPrompt.lastIndexOf('\n') + 1);
	let current = '';
	try { current = JSON.parse(jsonLine).currentPrompt ?? ''; } catch { /* malformed test input stays unstructured */ }
	const candidates = [
		'Preserve the existing error shape',
		'Do not change the return code',
		'Implement the endpoint',
		'Also add a validation test',
	];
	const explicit = candidates.find((item) => current.includes(item));
	return JSON.stringify({
		intent: 'Implement the requested change',
		secondaryIntents: ['keep existing behavior'],
		deliverables: ['validated implementation', 'focused tests'],
		explicitConstraints: explicit ? [explicit] : [],
		inferredConstraints: [{ text: 'Avoid unrelated changes', confidence: 0.8 }],
		subtasks: ['inspect owner', 'implement behavior'],
		dependencies: ['existing model registry'],
		references: ['the named API'],
		suggestedCapabilities: ['read', 'edit'],
		expectedTools: ['read', 'test'],
		expectedSkills: ['typescript-contract-engineering'],
		completionConditions: ['focused tests pass'],
		ambiguities: ['none'],
		relation: 'expand',
		taskLabel,
		confidence: 0.91,
		needsExternalVerification: true,
		needsMemory: true,
		needsProjectGraph: true,
		reviewWorthy: true,
		multiPerspective: true,
	});
}

function fixture({
	ownerId = 'owner-1',
	sessionId = 'session-1',
	models = [routeOutside, routeInside],
	scopedModels = [{ model: { provider: routeInside.provider, id: routeInside.id }, thinkingLevel: 'low' }],
	taskLabel = 'Parsed task',
	complete,
	sessionEntries = [],
	branchEntries = sessionEntries,
} = {}) {
	let currentSession = sessionId;
	const hooks = new Map();
	const completions = [];
	const typedEvents = [];
	const uiNotices = [];
	const customMessages = [];
	const modelRegistry = {
		getAvailable: () => models,
		find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		getApiKeyAndHeaders: async () => ({ apiKey: 'test-api-key', headers: {} }),
	};
	const ctx = {
		cwd: configDir,
		scopedModels,
		signal: new AbortController().signal,
		modelRegistry,
		sessionManager: {
			getSessionId: () => currentSession,
			getEntries: () => sessionEntries,
			getBranch: () => branchEntries,
		},
		ui: { notify: (text, level) => uiNotices.push({ text, level }) },
	};
	const pi = {
		on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
		registerTool() {},
		events: { emit: (name, event) => typedEvents.push({ name, event }) },
		sendMessage: async (message, options) => { customMessages.push({ message, options }); },
	};
	const completePromptAnalysis = async (model, context, options) => {
		const requestPrompt = context.messages[0].content[0].text;
		completions.push({ model: `${model.provider}/${model.id}`, requestPrompt, maxTokens: options.maxTokens, signal: options.signal });
		if (complete) return complete(model, context, options);
		return {
			content: [{ type: 'text', text: analysisAnswer(requestPrompt, taskLabel) }],
			usage: { input: 123, output: 37 },
			stopReason: 'stop',
		};
	};
	register(pi, { classify: () => undefined, warmup() {}, completePromptAnalysis });
	const emit = async (name, event = {}, context = ctx) => {
		let last;
		for (const handler of hooks.get(name) ?? []) {
			const result = await handler(event, context);
			if (result !== undefined) last = result;
		}
		return last;
	};
	return {
		ctx, hooks, completions, typedEvents, uiNotices, customMessages, emit,
		setSession: (value) => { currentSession = value; },
	};
}

function input({ prompt, requestId, ownerId = 'owner-1', sessionId = 'session-1', source = 'interactive', signal = new AbortController().signal }) {
	return { text: prompt, originalText: prompt, source, requestId, turnId: `turn-${requestId}`, processId: 'process-test', sessionId, guardianOwnerId: ownerId, signal };
}

test('only core-provenanced interactive and RPC inputs receive one structured advisory per request', async (t) => {
	writePreferences();
	const f = fixture();
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'request-a' }));
	await f.emit('input', input({ prompt: promptB, requestId: 'request-b', source: 'rpc' }));
	assert.equal(f.completions.length, 2);
	assert.deepEqual(f.completions.map((call) => call.maxTokens), [768, 320]);
	assert.deepEqual(f.completions.map((call) => call.model), ['openrouter/test/inside', 'openrouter/test/inside']);
	assert.match(f.completions[0].requestPrompt, /completionConditions/);
	assert.doesNotMatch(f.completions[1].requestPrompt, /needsMemory/);
	assert.equal(lastMicroRequest('owner-1').promptAnalysis.kind, 'followup');
	assert.equal(microRequestAdvice(promptB, 'owner-1').needsVerification, true);

	const batch = {
		messages: [
			{ role: 'user', content: [{ type: 'text', text: promptA }] },
			{ role: 'user', content: [{ type: 'text', text: promptB }] },
		],
		requestMessages: [
			{ requestId: 'request-a', turnId: 'turn-request-a', messageIndex: 0 },
			{ requestId: 'request-b', turnId: 'turn-request-b', messageIndex: 1 },
		],
	};
	const rewritten = await f.emit('context', batch);
	assert.deepEqual(rewritten.messages.filter((message) => message.customType === 'prompt-analysis-context').map((message) => message.details.requestId), ['request-a', 'request-b']);
	assert.equal(rewritten.messages[1].role, 'custom');
	assert.equal(rewritten.messages[3].role, 'custom');
	const firstContext = rewritten.messages[1].content[0].text;
	const full = JSON.parse(firstContext.split('\n')[1]);
	for (const key of ['deliverables', 'dependencies', 'references', 'suggestedCapabilities', 'expectedTools', 'expectedSkills', 'completionConditions', 'ambiguities']) assert.ok(key in full, key);
	assert.equal(full.needsMemory, true);
	assert.equal(f.typedEvents.length, 2);
	assert.deepEqual(f.typedEvents.map(({ event }) => event.requestId), ['request-a', 'request-b']);
	assert.equal(f.typedEvents[0].event.promptHash, createHash('sha256').update(promptA).digest('hex'));
	assert.equal(f.customMessages.length, 2);
	assert.ok(f.customMessages.every(({ options, message }) => options.triggerTurn === false && message.excludeFromContext === true));
	assert.equal(f.uiNotices.length, 0, 'persistent analysis rows replace duplicate transient notifications');
	assert.deepEqual(f.customMessages.map(({ message }) => message.details.kind), ['initial', 'followup']);
	for (const { message } of f.customMessages) {
		const injected = rewritten.messages.find(row => row.customType === 'prompt-analysis-context' && row.details.requestId === message.details.requestId);
		assert.ok(injected.content[0].text.startsWith(message.details.advisory), 'visible expandable advice matches the model advisory');
		assert.match(message.content, /Original user prompt preserved/);
	}


	const replay = await f.emit('context', { ...batch, messages: rewritten.messages });
	assert.equal(replay, undefined, 'replaying the same request IDs does not insert duplicate context');
	assert.equal(f.typedEvents.length, 2, 'typed Guardian facts emit once per request');
});

test('unusable explicit analysis routes inherit configured subagent order', async (t) => {
	writePreferences({ promptAnalysis: ['outside'], subagents: ['inside'] });
	const f = fixture();
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'inherited' }));
	assert.equal(f.completions[0].model, 'openrouter/test/inside');
	await f.emit('context', {
		messages: [{ role: 'user', content: [{ type: 'text', text: promptA }] }],
		requestMessages: [{ requestId: 'inherited', turnId: 'turn-inherited', messageIndex: 0 }],
	});
	assert.equal(f.customMessages[0].message.details.source, 'subagents');
});

test('autonomous route selection enforces the request spend bound and does not inherit the primary model', async (t) => {
	writePreferences({ promptAnalysis: null, subagents: null });
	const cheap = { ...routeInside, id: 'test/cheap', cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.1 } };
	const expensivePrimary = { ...routeOutside, id: 'test/primary', cost: { input: 100, output: 100, cacheRead: 50, cacheWrite: 100 } };
	const f = fixture({ models: [expensivePrimary, cheap], scopedModels: [] });
	f.ctx.model = expensivePrimary;
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'economy' }));
	assert.equal(f.completions[0].model, 'openrouter/test/cheap');
});

test('extension-generated API messages and missing provenance are excluded even when text looks like a prompt', async (t) => {
	writePreferences();
	const f = fixture();
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'synthetic', source: 'extension' }));
	await f.emit('input', { ...input({ prompt: promptA, requestId: 'missing' }), guardianOwnerId: undefined });
	assert.equal(f.completions.length, 0);
	assert.equal(lastMicroRequest('owner-1'), undefined);
});

test('an unusable route degrades to labelled deterministic analysis without fabricating model usage', async (t) => {
	writePreferences({ promptAnalysis: null, subagents: null });
	const f = fixture({ models: [], scopedModels: [] });
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'fallback' , source: 'rpc' }));
	assert.equal(f.completions.length, 0);
	assert.equal(lastMicroRequest('owner-1').promptAnalysis.source, 'fallback');
	assert.equal(lastMicroRequest('owner-1').advisoryPending, false);
	await f.emit('context', {
		messages: [{ role: 'user', content: [{ type: 'text', text: promptA }] }],
		requestMessages: [{ requestId: 'fallback', turnId: 'turn-fallback', messageIndex: 0 }],
	});
	assert.equal(f.typedEvents[0].event.analysisSource, 'fallback');
	assert.equal(f.typedEvents[0].event.confidence, 0);
	assert.equal(f.customMessages[0].message.details.source, 'autonomous');
});

test('explicit abort prevents stale analysis from reaching context or Guardian', async (t) => {
	writePreferences();
	let began;
	let finish;
	const started = new Promise((resolve) => { began = resolve; });
	const f = fixture({ complete: (_model, context, options) => {
		began();
		return new Promise((resolve) => { finish = resolve; });
	} });
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	const controller = new AbortController();
	const pending = f.emit('input', input({ prompt: promptA, requestId: 'aborted', signal: controller.signal }));
	await started;
	controller.abort();
	await pending;
	assert.equal(lastMicroRequest('owner-1').advisoryPending, false);
	assert.equal(f.typedEvents.length, 0);
	assert.equal(f.uiNotices.length, 0);
	finish({ content: [{ type: 'text', text: analysisAnswer(f.completions[0].requestPrompt) }], usage: { input: 4, output: 2 }, stopReason: 'stop' });
	await tick();
	assert.equal(f.typedEvents.length, 0);
});

test('queued prompt from a replaced session cannot reset or contaminate the new owner', async (t) => {
	writePreferences();
	let began;
	let finish;
	const started = new Promise((resolve) => { began = resolve; });
	const f = fixture({ complete: (_model, context, options) => {
		if (context.messages[0].content[0].text.includes('Implement the endpoint')) {
			began();
			return new Promise((resolve) => { finish = resolve; });
		}
		return Promise.resolve({ content: [{ type: 'text', text: analysisAnswer(context.messages[0].content[0].text, 'New session') }], usage: { input: 5, output: 3 }, stopReason: 'stop' });
	} });
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	const aController = new AbortController();
	const a = f.emit('input', input({ prompt: promptA, requestId: 'old-a', signal: aController.signal }));
	await started;
	const bController = new AbortController();
	const b = f.emit('input', input({ prompt: promptB, requestId: 'old-b', signal: bController.signal }));
	f.setSession('session-2');
	await f.emit('session_start', { reason: 'new' });
	bController.abort();
	await Promise.all([a, b]);
	finish({ content: [{ type: 'text', text: analysisAnswer(f.completions[0].requestPrompt) }], usage: { input: 6, output: 3 }, stopReason: 'stop' });
	await tick();
	assert.deepEqual(f.completions.map((call) => call.requestPrompt.includes('Classify this new user prompt')), [false]);
	assert.equal(lastMicroRequest('owner-1'), undefined);
	await f.emit('input', input({ prompt: 'Start a new task. Keep the original response body.', requestId: 'new-c', ownerId: 'owner-2', sessionId: 'session-2' }));
	assert.equal(f.completions.length, 2);
	assert.equal(f.completions[1].maxTokens, 768, 'the replacement session starts with an initial analysis');
	assert.equal(lastMicroRequest('owner-2').promptAnalysis.taskLabel, 'New session');
});

test('two live extension instances with identical prompt text keep request state isolated by Guardian owner', async (t) => {
	writePreferences();
	const a = fixture({ ownerId: 'owner-a', taskLabel: 'First session request' });
	const b = fixture({ ownerId: 'owner-b', taskLabel: 'Second session request' });
	t.after(async () => { await a.emit('session_shutdown'); await b.emit('session_shutdown'); });
	await Promise.all([a.emit('session_start', { reason: 'new' }), b.emit('session_start', { reason: 'new' })]);
	await Promise.all([
		a.emit('input', input({ prompt: promptA, requestId: 'same-text-a', ownerId: 'owner-a' })),
		b.emit('input', input({ prompt: promptA, requestId: 'same-text-b', ownerId: 'owner-b' })),
	]);
	assert.equal(lastMicroRequest('owner-a').promptAnalysis.taskLabel, 'First session request');
	assert.equal(lastMicroRequest('owner-b').promptAnalysis.taskLabel, 'Second session request');
	assert.equal(microRequestAdvice(promptA), undefined, 'ambiguous unscoped lookup abstains with multiple live owners');
});

test('large user prompts are hashed, bounded for analysis, and not retained in replay metadata', async (t) => {
	writePreferences({ promptAnalysis: null, subagents: null });
	const f = fixture({ models: [], scopedModels: [] });
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	const marker = 'PRIVATE-RAW-PROMPT-';
	const prompt = `Analyze this request. ${marker}${'x'.repeat(1_100_000)}`;
	await f.emit('input', input({ prompt, requestId: 'large' }));
	assert.equal(f.completions.length, 0);
	const context = await f.emit('context', {
		messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
		requestMessages: [{ requestId: 'large', turnId: 'turn-large', messageIndex: 0 }],
	});
	assert.equal(context.messages[1].details.promptHash, createHash('sha256').update(prompt).digest('hex'));
	assert.ok(JSON.stringify(context.messages[1]).length < 20_000);
	assert.doesNotMatch(JSON.stringify(context.messages[1]), /PRIVATE-RAW-PROMPT/);
	assert.ok(f.completions.length === 0);
});

test('discovery recovers a long typo without confusing short domain words or exact names', () => {
	const tools = [
		{ name: 'browser_session', description: 'Browser screenshot navigation' },
		{ name: 'keyboard', description: 'keyboard input' },
		{ name: 'capital', description: 'capital markets' },
		{ name: 'api_probe', description: 'API requests' },
	];
	assert.equal(searchCapabilityMetadata(tools, 'screenshto')[0]?.name, 'browser_session');
	assert.deepEqual(searchCapabilityMetadata(tools, 'api').map((tool) => tool.name), ['api_probe']);
	assert.deepEqual(searchCapabilityMetadata(tools, 'board'), []);
	assert.equal(searchCapabilityMetadata(tools, 'browser_session')[0].name, 'browser_session');
});

test('session metrics include readable tool names and counts', () => {
	const metrics = collectSessionMetrics([{ type: 'message', message: { role: 'toolResult', toolCallId: 'one', toolName: 'tool_search', content: [] } }]);
	assert.ok(metrics.footer.some((line) => line.includes('🧰 Tools 1')));
});

test('a resumed session classifies the first prompt as a follow-up with restored prior context', async (t) => {
	writePreferences();
	// The session manager persists the analysis display message as a
	// `custom_message` entry; resume must read that real shape.
	const persisted = {
		type: 'custom_message',
		customType: 'prompt-analysis',
		content: 'Intent analysis · initial · model · prompt_analysis · openrouter/test/inside',
		display: true,
		excludeFromContext: true,
		details: {
			version: 1,
			kind: 'initial',
			source: 'prompt_analysis',
			status: 'model',
			taskLabel: 'Earlier task',
			intent: 'Implement the endpoint',
			explicitConstraints: [{ text: 'Preserve the existing error shape', source: 'literal-user', start: 0, end: 33, quoted: false }],
			subtasks: ['inspect owner', 'implement behavior'],
		},
	};
	const f = fixture({ sessionId: 'session-resume', sessionEntries: [persisted] });
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'resume' });
	const followUp = 'Continue and also handle the timeout case.';
	await f.emit('input', input({ prompt: followUp, requestId: 'resume-1', sessionId: 'session-resume' }));
	assert.equal(f.completions.length, 1);
	assert.equal(f.completions[0].maxTokens, 320, 'a resumed session must use the lighter follow-up budget');
	assert.equal(lastMicroRequest('owner-1').promptAnalysis.kind, 'followup');
	assert.match(f.completions[0].requestPrompt, /priorTask/, 'prior task context must be restored from the transcript');
	assert.match(f.completions[0].requestPrompt, /Earlier task/);
	assert.match(f.completions[0].requestPrompt, /Preserve the existing error shape/);
	assert.match(f.completions[0].requestPrompt, /relation/, 'follow-up requests classify the relation');

	const fresh = fixture({ sessionId: 'session-fresh' });
	t.after(() => fresh.emit('session_shutdown'));
	await fresh.emit('session_start', { reason: 'new' });
	await fresh.emit('input', input({ prompt: followUp, requestId: 'fresh-1', sessionId: 'session-fresh' }));
	assert.equal(fresh.completions[0].maxTokens, 768, 'a new session still receives the full initial analysis');
});

test('only the newest user request keeps its advisory in later provider payloads', async (t) => {
	writePreferences();
	const f = fixture();
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'turn-a' }));
	// Turn A's own provider payload annotates its request.
	const turnA = await f.emit('context', {
		messages: [{ role: 'user', content: [{ type: 'text', text: promptA }] }],
		requestMessages: [{ requestId: 'turn-a', turnId: 'turn-turn-a', messageIndex: 0 }],
	});
	assert.deepEqual(
		turnA.messages.filter((message) => message.customType === 'prompt-analysis-context').map((message) => message.details.requestId),
		['turn-a'],
	);
	await f.emit('input', input({ prompt: promptB, requestId: 'turn-b' }));
	const messages = [
		{ role: 'user', content: [{ type: 'text', text: promptA }] },
		{ role: 'user', content: [{ type: 'text', text: promptB }] },
	];
	const requestMessages = [
		{ requestId: 'turn-a', turnId: 'turn-turn-a', messageIndex: 0 },
		{ requestId: 'turn-b', turnId: 'turn-turn-b', messageIndex: 1 },
	];
	// The next payload carries turn A's message as history. Re-injecting every
	// pending request would add one stale interpretation per turn, so only the
	// newly arrived request is annotated.
	const first = await f.emit('context', { messages, requestMessages });
	assert.deepEqual(
		first.messages.filter((message) => message.customType === 'prompt-analysis-context').map((message) => message.details.requestId),
		['turn-b'],
	);
	// A second provider payload in the same turn keeps the current advisory.
	const second = await f.emit('context', { messages, requestMessages });
	assert.deepEqual(
		second.messages.filter((message) => message.customType === 'prompt-analysis-context').map((message) => message.details.requestId),
		['turn-b'],
	);
	// A newer request without an analysis must not resurrect an older advisory.
	const later = await f.emit('context', {
		messages: [...messages, { role: 'assistant', content: [] }, { role: 'user', content: [{ type: 'text', text: 'third request' }] }],
		requestMessages: [...requestMessages, { requestId: 'turn-c', turnId: 'turn-turn-c', messageIndex: 3 }],
	});
	assert.equal(later, undefined, 'an older advisory is never re-inserted once a newer request exists');
});

test('startup and reload restore only the active branch, never an abandoned task', async (t) => {
	writePreferences();
	const active = { type: 'custom_message', customType: 'prompt-analysis', details: { taskLabel: 'Active task', subtasks: [], explicitConstraints: [] } };
	const abandoned = { ...active, details: { ...active.details, taskLabel: 'Abandoned task' } };
	for (const reason of ['startup', 'reload', 'resume', 'fork', 'tree']) {
		const f = fixture({ sessionEntries: [active, abandoned], branchEntries: [active] });
		t.after(() => f.emit('session_shutdown'));
		await f.emit('session_start', { reason: reason === 'tree' ? 'new' : reason });
		if (reason === 'tree') await f.emit('session_tree');
		await f.emit('input', input({ prompt: promptB, requestId: `restored-${reason}` }));
		assert.equal(f.completions[0].maxTokens, 320);
		assert.match(f.completions[0].requestPrompt, /Active task/);
		assert.doesNotMatch(f.completions[0].requestPrompt, /Abandoned task/);
	}
});

test('vetoed navigation and rejected analysed requests do not replace the accepted task', async (t) => {
	writePreferences();
	const f = fixture();
	t.after(() => f.emit('session_shutdown'));
	await f.emit('session_start', { reason: 'new' });
	const rejected = new AbortController();
	await f.emit('input', input({ prompt: 'Rejected task.', requestId: 'rejected', signal: rejected.signal }));
	rejected.abort();
	await f.emit('input', input({ prompt: promptA, requestId: 'accepted' }));
	assert.equal(f.completions[1].maxTokens, 768, 'rejected preflight is not an initial task');
	for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) await f.emit(event);
	await f.emit('input', input({ prompt: promptB, requestId: 'followup' }));
	assert.equal(f.completions[2].maxTokens, 320);
	assert.match(f.completions[2].requestPrompt, /Preserve the existing error shape/);
});

test('legacy completion observes auth URL overrides', async (t) => {
	writePreferences();
	let observedUrl;
	const f = fixture({ complete: async (model) => {
		observedUrl = model.baseUrl;
		return { content: [{ type: 'text', text: analysisAnswer('') }], usage: { input: 3, output: 4 }, stopReason: 'stop' };
	} });
	t.after(() => f.emit('session_shutdown'));
	f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'synthetic', baseUrl: 'http://localhost:43210/v1' });
	await f.emit('session_start', { reason: 'new' });
	await f.emit('input', input({ prompt: promptA, requestId: 'url' }));
	assert.equal(observedUrl, 'http://localhost:43210/v1');
});
