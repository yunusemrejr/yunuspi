import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const lib = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/context-governor.ts')).href);
const extensionUrl = pathToFileURL(path.join(root, 'agent/extensions/cost-governor.ts')).href;
const { estimateMessagesTokens, estimateMessageTokens, messageKey, createFold, applyFold, buildDigest, capText, chooseCutoff } = lib;

let seq = 0;
const stamp = () => Date.UTC(2026, 9, 17, 12, 0, seq++);
const user = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: stamp(), ...extra });
const assistant = (text, calls = [], extra = {}) => ({
	role: 'assistant',
	content: [
		...(text ? [{ type: 'text', text }] : []),
		...(calls.length ? [{ type: 'toolCall', id: `call-${seq++}`, name: calls[0].name, arguments: calls[0].arguments }] : []),
	],
	timestamp: stamp(),
	...extra,
});
const toolResult = (id, text, extra = {}) => ({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], timestamp: stamp(), ...extra });

function syntheticConversation(cycles = 24) {
	const messages = [user('Build the feature, verify it, and do not regress the existing CLI.')];
	const earlyEdit = `early-edit-${seq++}`;
	messages.push({
		role: 'assistant',
		content: [{ type: 'toolCall', id: earlyEdit, name: 'write', arguments: { path: '/repo/src/early.py', content: 'print(1)\n' } }],
		timestamp: stamp(),
	});
	messages.push(toolResult(earlyEdit, 'Wrote /repo/src/early.py'));
	for (let i = 0; i < cycles; i++) {
		const callId = `tool-${i}`;
		const command = i % 5 === 0 ? `cd /repo && python3 -m pytest tests/test_${i}.py -q` : `cd /repo && sed -n '${i},${i + 80}p' src/module_${i}.py`;
		messages.push({
			role: 'assistant',
			content: [
				{ type: 'text', text: i % 3 === 0 ? `Inspect module ${i} before editing.` : '' },
				{ type: 'toolCall', id: callId, name: 'bash', arguments: { command } },
			].filter(Boolean),
			timestamp: stamp(),
		});
		const output = i % 7 === 0
			? `FAILED tests/test_${i}.py::test_case\nAssertionError: expected 3, got ${i}\n42 passed, 1 failed in 0.31s`
			: `def function_${i}():\n    return ${i}\n${'payload '.repeat(180)}`;
		messages.push(toolResult(callId, output));
	}
	messages.push(user('Now fix the failing test and run the focused suite.'));
	const editCall = `edit-${seq++}`;
	messages.push({
		role: 'assistant',
		content: [
			{ type: 'thinking', thinking: 'Need to adjust the expected value; keep the public API stable.' },
			{ type: 'toolCall', id: editCall, name: 'edit', arguments: { path: '/repo/src/module_0.py', edits: [{ oldText: 'return 0', newText: 'return 3' }] } },
		],
		timestamp: stamp(),
	});
	messages.push(toolResult(editCall, 'Successfully replaced 1 block(s) in /repo/src/module_0.py'));
	messages.push(user('Continue with the remaining verification, then report the exact commands and results.'));
	return messages;
}

test('fold keeps a recent tail, a current user message and a deterministic digest', () => {
	const messages = syntheticConversation();
	const before = estimateMessagesTokens(messages);
	const result = createFold(messages, { budgetTokens: 8000, keepRecentTokens: 1800, digestTokens: 500 });
	assert.ok(result, 'a conversation above budget must fold');
	assert.ok(result.messages.length < messages.length);
	assert.ok(estimateMessagesTokens(result.messages) < before);
	assert.equal(result.messages[0].customType, 'context-fold');
	assert.match(result.messages[0].content, /context-fold/);
	const lastUser = messages.filter((m) => m.role === 'user').at(-1);
	assert.ok(result.messages.some((m) => m.role === 'user' && JSON.stringify(m.content) === JSON.stringify(lastUser.content)), 'the latest user request is never folded away');
	const applied = applyFold(messages, result.fold);
	assert.ok(applied, 'the cutoff survives an unchanged history');
	assert.equal(applied[0].content, result.messages[0].content, 'digest is stable across projection');
	const again = createFold(messages, { budgetTokens: 8000, keepRecentTokens: 1800, digestTokens: 500 });
	assert.equal(again.fold.digest, result.fold.digest, 'same folded prefix produces the same digest');
	assert.equal(again.fold.cutoffKey, result.fold.cutoffKey);
});

test('fold boundary never orphans a tool result from its assistant call', () => {
	const messages = syntheticConversation();
	for (const keep of [200, 500, 900, 1400, 2200]) {
		const result = createFold(messages, { budgetTokens: 7000, keepRecentTokens: keep, digestTokens: 500 });
		if (!result) continue;
		const kept = applyFold(messages, result.fold);
		assert.ok(kept);
		// The first substantive kept message may be the current user; after that
		// no tool result may appear without the assistant call immediately before it.
		const tail = kept.slice(1).filter((m) => m.role !== 'custom');
		for (let i = 0; i < tail.length; i++) {
			if (tail[i].role !== 'toolResult') continue;
			const previous = tail[i - 1];
			const hasCallBefore = previous && (
				previous.role === 'assistant' ||
				(previous.role === 'toolResult' && tail.slice(0, i).some((m) => m.role === 'assistant'))
			);
			assert.ok(hasCallBefore, `tool result at ${i} has no assistant/tool carrier`);
		}
	}
});

test('digest carries files, commands, verification and errors without dumping payloads', () => {
	const messages = syntheticConversation();
	const result = createFold(messages, { budgetTokens: 4000, keepRecentTokens: 800, digestTokens: 500 });
	assert.ok(result);
	const digest = result.fold.digest;
	assert.match(digest, /src\/early\.py/);
	assert.match(digest, /src\/module_\d+\.py/);
	assert.match(digest, /pytest/);
	assert.match(digest, /AssertionError|failed/i);
	assert.ok(digest.length <= 3200, 'digest stays bounded');
	assert.doesNotMatch(digest, /payload payload payload payload payload/, 'raw tool payloads are not copied into the digest');
});

test('fold accounting excludes the verbatim current user message', () => {
	const messages = syntheticConversation();
	const result = createFold(messages, { budgetTokens: 6000, keepRecentTokens: 1600, digestTokens: 500 });
	assert.ok(result);
	const viewTokens = estimateMessagesTokens(result.messages);
	const digestTokens = estimateMessageTokens(result.messages[0]);
	assert.ok(result.fold.keptTokens >= viewTokens - 1 && result.fold.keptTokens <= viewTokens + digestTokens, 'kept token accounting is a bound, not a double count');
});

test('capText keeps both ends, names the spill and leaves short text alone', () => {
	const text = `${'HEAD '.repeat(400)}MIDDLE${' TAIL'.repeat(400)}`;
	const marker = '\n[full output: /tmp/full.txt]\n';
	const capped = capText(text, 1200, marker);
	assert.equal(capped.capped, true);
	assert.ok(capped.text.length <= 1200 + marker.length);
	assert.ok(capped.text.startsWith('HEAD'));
	assert.ok(capped.text.trimEnd().endsWith('TAIL'));
	assert.match(capped.text, /full output/);
	const short = capText('small', 1200, marker);
	assert.equal(short.capped, false);
	assert.equal(short.text, 'small');
});

function fakePi() {
	const hooks = new Map();
	const commands = new Map();
	const entries = [];
	const tools = new Map();
	let thinking = 'max';
	const pi = {
		on(event, handler) {
			if (!hooks.has(event)) hooks.set(event, []);
			hooks.get(event).push(handler);
		},
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand(name, options) { commands.set(name, options); },
		appendEntry(type, data) { entries.push({ type, data }); },
		getThinkingLevel() { return thinking; },
		setThinkingLevel(level) {
			const previous = thinking;
			thinking = level;
			for (const handler of hooks.get('thinking_level_select') ?? []) handler({ type: 'thinking_level_select', level, previousLevel: previous });
		},
	};
	return { pi, hooks, commands, entries, tools, thinking: () => thinking };
}

function fakeCtx(overrides = {}) {
	const notifications = [];
	return {
		hasUI: true,
		ui: { notify: (text, kind) => notifications.push({ text, kind }) },
		model: { provider: 'deepseek', id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] },
		sessionManager: { getSessionId: () => 'synthetic-session', getBranch: () => [] },
		cwd: process.cwd(),
		notifications,
		...overrides,
	};
}

test('extension folds on context, caps large bash results, reports spend and restores it', async () => {
	const saved = { ...process.env };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-'));
	process.env.PI_CONTEXT_BUDGET = '8000';
	process.env.PI_CONTEXT_KEEP = '2000';
	process.env.PI_TOOL_RESULT_MAX = '1000';
	process.env.PI_COST_BUDGET_USD = 'off';
	process.env.PI_CODING_AGENT_DIR = temp;
	try {
		const { default: register } = await import(extensionUrl);
		const { pi, hooks, commands, entries } = fakePi();
		register(pi);
		const ctx = fakeCtx();
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, ctx));
		assert.ok(commands.has('budget'));

		const messages = syntheticConversation();
		const folded = hooks.get('context')[0]({ type: 'context', messages }, ctx);
		assert.ok(folded?.messages);
		assert.equal(folded.messages[0].customType, 'context-fold');
		assert.ok(estimateMessagesTokens(folded.messages) < estimateMessagesTokens(messages));
		assert.ok(entries.some((entry) => entry.type === 'context-fold-v1'));
		const stable = hooks.get('context')[0]({ type: 'context', messages }, ctx);
		assert.equal(stable.messages[0].content, folded.messages[0].content);
		// Append enough material to force a second fold; the hook must wrap the
		// array in {messages} on that path too, not return a bare array.
		const extra = [];
		for (let i = 0; i < 48; i++) {
			const callId = `late-${i}`;
			extra.push({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: `echo ${i} && sed -n '1,100p' src/late_${i}.py` } }], timestamp: 1_800_000 + i * 3 });
			extra.push({ role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: `late payload ${i} ${'z'.repeat(900)}` }], timestamp: 1_800_001 + i * 3 });
		}
		const refolded = hooks.get('context')[0]({ type: 'context', messages: [...messages, ...extra] }, ctx);
		assert.ok(refolded?.messages, 'a second fold returns the wrapped message array');
		assert.equal(refolded.messages[0].customType, 'context-fold');
		assert.ok(entries.filter((entry) => entry.type === 'context-fold-v1').length >= 2, 'the second fold is persisted');

		const long = `line ${'x'.repeat(40)}\n`.repeat(300);
		const capResult = await hooks.get('tool_result')[0]({
			type: 'tool_result', toolName: 'bash', toolCallId: 'c1', input: { command: 'cat huge.log' },
			content: [{ type: 'text', text: long }], isError: false, details: {},
		}, ctx);
		assert.ok(capResult?.content?.[0]?.text.length < long.length);
		assert.match(capResult.content[0].text, /context governor/);
		const spillRoot = path.join(temp, 'context-spill', 'synthetic-session');
		assert.ok(fs.existsSync(spillRoot), 'a spill directory is created');
		assert.ok(fs.readdirSync(spillRoot).length >= 1, 'the full result is retained');
		const short = await hooks.get('tool_result')[0]({
			type: 'tool_result', toolName: 'bash', toolCallId: 'c2', input: { command: 'true' },
			content: [{ type: 'text', text: 'ok' }], isError: false, details: {},
		}, ctx);
		assert.equal(short, undefined);

		hooks.get('message_end')[0]({ message: { role: 'assistant', usage: { input: 5000, output: 700, cacheRead: 120_000, cacheWrite: 0, reasoning: 80, cost: { input: 0.001, output: 0.0004, cacheRead: 0.0003, total: 0.0017 } } } }, ctx);
		await commands.get('budget').handler('', ctx);
		const report = ctx.notifications.at(-1)?.text ?? '';
		assert.match(report, /Cost governor/);
		assert.match(report, /cache read/);
		assert.match(report, /folds [12]/);
		assert.match(report, /\$0\.0017/);

		// A fresh process-like restore sees the same spend from the branch.
		const branch = [{ type: 'message', message: { role: 'assistant', usage: { input: 5000, output: 700, cacheRead: 120_000, cacheWrite: 0, reasoning: 80, cost: { input: 0.001, output: 0.0004, cacheRead: 0.0003, total: 0.0017 } } } }];
		const restoredCtx = fakeCtx({ sessionManager: { getSessionId: () => 'synthetic-session', getBranch: () => branch } });
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, restoredCtx));
		await commands.get('budget').handler('', restoredCtx);
		assert.match(restoredCtx.notifications.at(-1)?.text ?? '', /\$0\.0017/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('soft budget turns on economy mode, adds one concise notice and tightens caps', async () => {
	const saved = { ...process.env };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-'));
	process.env.PI_COST_BUDGET_USD = '0.001';
	process.env.PI_CONTEXT_BUDGET = '8000';
	process.env.PI_CONTEXT_KEEP = '2000';
	process.env.PI_TOOL_RESULT_MAX = '4000';
	process.env.PI_CODING_AGENT_DIR = temp;
	try {
		const { default: register } = await import(extensionUrl);
		const { pi, hooks } = fakePi();
		register(pi);
		const ctx = fakeCtx();
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, ctx));
		hooks.get('message_end')[0]({ message: { role: 'assistant', usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.002 } } } }, ctx);
		assert.match(ctx.notifications.at(-1)?.text ?? '', /Economy mode is on/);
		const messages = syntheticConversation();
		const folded = hooks.get('context')[0]({ type: 'context', messages }, ctx);
		assert.ok(folded?.messages);
		const notices = folded.messages.filter((m) => m.customType === 'cost-governor-notice');
		assert.equal(notices.length, 1);
		assert.match(notices[0].content, /Continue the task/);
		const long = `line ${'y'.repeat(30)}\n`.repeat(500);
		const cap = await hooks.get('tool_result')[0]({
			type: 'tool_result', toolName: 'bash', toolCallId: 'c3', input: { command: 'cat huge.log' },
			content: [{ type: 'text', text: long }], isError: false, details: {},
		}, ctx);
		assert.ok(cap.content[0].text.length < long.length, 'economy tool cap is lower than the result length');
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('kill switch leaves the host untouched', async () => {
	const saved = { ...process.env };
	process.env.PI_CONTEXT_GOVERNOR = 'off';
	try {
		const { default: register } = await import(extensionUrl);
		const { pi, hooks, commands } = fakePi();
		register(pi);
		assert.equal(hooks.size, 0);
		assert.equal(commands.size, 0);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
});

test('resume uses the lower first-call budget so a retained prefix is not re-billed whole', async () => {
	const saved = { ...process.env };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-'));
	process.env.PI_CONTEXT_BUDGET = '100000';
	process.env.PI_CONTEXT_KEEP = '20000';
	process.env.PI_COST_BUDGET_USD = 'off';
	process.env.PI_CODING_AGENT_DIR = temp;
	try {
		const { default: register } = await import(extensionUrl);
		const { pi, hooks, entries } = fakePi();
		register(pi);
		const messages = syntheticConversation(220);
		const branch = [{ type: 'message', message: { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.0001 } } } }];
		const ctx = fakeCtx({ sessionManager: { getSessionId: () => 'resume-session', getBranch: () => branch } });
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, ctx));
		const first = hooks.get('context')[0]({ type: 'context', messages }, ctx);
		assert.ok(first?.messages, 'a large retained prefix folds on the first call after resume');
		assert.ok(estimateMessagesTokens(first.messages) < 70_000, 'the resume view uses the 60k budget');
		assert.ok(entries.some((entry) => entry.type === 'context-fold-v1'));
		const again = hooks.get('context')[0]({ type: 'context', messages }, ctx);
		assert.equal(again.messages[0].content, first.messages[0].content, 'the resumed fold is stable');
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('read_many batches independent files, caps one file and reports per-file failures', async () => {
	const saved = { ...process.env };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-'));
	process.env.PI_COST_BUDGET_USD = 'off';
	process.env.PI_CODING_AGENT_DIR = temp;
	try {
		fs.writeFileSync(path.join(temp, 'alpha.txt'), 'alpha first\nalpha second\n');
		fs.writeFileSync(path.join(temp, 'beta.txt'), 'beta first\nbeta second\n');
		fs.writeFileSync(path.join(temp, 'large.txt'), `${'large line payload\n'.repeat(2200)}`);
		const { default: register } = await import(extensionUrl);
		const { pi, hooks, tools } = fakePi();
		register(pi);
		const ctx = fakeCtx({ cwd: temp });
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, ctx));
		const tool = tools.get('read_many');
		assert.ok(tool, 'read_many is registered');
		const result = await tool.execute('read-many-1', { files: [{ path: 'alpha.txt' }, { path: 'beta.txt' }, { path: 'large.txt' }, { path: 'missing.txt' }] }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /alpha first/);
		assert.match(result.content[0].text, /beta second/);
		assert.match(result.content[0].text, /read_many capped/);
		assert.match(result.content[0].text, /ERROR: .*missing\.txt|ERROR: ENOENT/);
		assert.equal(result.isError, undefined, 'one failed file does not fail the batch');
		assert.ok(result.details.files.some((file) => file.truncated === true));
		assert.ok(result.details.files.some((file) => file.error));
		assert.ok(fs.readdirSync(temp).length >= 3);
		const one = await tool.execute('read-many-2', { files: [{ path: 'alpha.txt' }] }, undefined, undefined, ctx);
		assert.equal(one.isError, true);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('economy mode lowers routine tool-continuation thinking, restores on errors and yields to a manual level', async () => {
	const saved = { ...process.env };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-'));
	process.env.PI_COST_BUDGET_USD = '0.001';
	process.env.PI_CONTEXT_BUDGET = '8000';
	process.env.PI_CONTEXT_KEEP = '2000';
	process.env.PI_CODING_AGENT_DIR = temp;
	try {
		const { default: register } = await import(extensionUrl);
		const { pi, hooks, thinking } = fakePi();
		register(pi);
		const ctx = fakeCtx();
		hooks.get('session_start').forEach((handler) => handler({ type: 'session_start' }, ctx));
		assert.equal(thinking(), 'max');
		hooks.get('message_end')[0]({ message: { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.002 } } } }, ctx);
		const turn = (tool, isError = false) => ({
			type: 'turn_end',
			message: { role: 'assistant', content: [{ type: 'toolCall', name: tool, arguments: { command: 'ls' } }] },
			toolResults: [{ isError }],
		});
		hooks.get('turn_end')[0](turn('bash'), ctx);
		assert.equal(thinking(), 'high', 'routine mechanical work steps down from max');
		hooks.get('turn_end')[0](turn('bash', true), ctx);
		assert.equal(thinking(), 'max', 'a failed tool keeps the configured ceiling');
		hooks.get('turn_end')[0](turn('write'), ctx);
		assert.equal(thinking(), 'max', 'judgment tools keep the configured ceiling');
		hooks.get('turn_end')[0](turn('bash'), ctx);
		assert.equal(thinking(), 'high', 'a later routine turn can step down again');
		// A shutdown must not persist an automatic level as the user's choice.
		hooks.get('session_shutdown')[0]({ type: 'session_shutdown' }, ctx);
		assert.equal(thinking(), 'max', 'shutdown restores the configured ceiling after an auto step-down');
		pi.setThinkingLevel('medium');
		hooks.get('turn_end')[0](turn('bash'), ctx);
		assert.equal(thinking(), 'medium', 'a manual selection disables automatic effort');
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
