import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(path.join(root, 'agent/extensions/pi-subagents/src/runs/shared/run-awareness.ts')).href;
const { registerRunAwareness, runAwarenessNote } = await import(moduleUrl);

const TAIL = 'Checks and tests that this task does not need, or that cannot fail because of your change, are waste: skip them and report when the task is done.';

/** A child process fixture: the events the core emits, and the steers it sent. */
function fixture(clock) {
	const hooks = new Map();
	const sent = [];
	const pi = {
		on(name, handler) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		sendUserMessage(content, options) { sent.push({ content, options }); },
	};
	const emit = (name, event = {}) => {
		for (const handler of hooks.get(name) ?? []) handler(event);
	};
	registerRunAwareness(pi, { now: () => clock.at });
	/** Tool calls, each followed by its result, as a child runs them. */
	const calls = (count) => {
		for (let i = 0; i < count; i++) {
			emit('tool_call', { toolName: 'read', input: {} });
			emit('tool_result', { toolName: 'read', toolCallId: `c${i}`, content: [] });
		}
	};
	return { sent, emit, calls };
}

test('the note reports the child time, calls and spend it has, and leaves out an unknown price', () => {
	assert.equal(runAwarenessNote({ minutes: 18, toolCalls: 64, usd: 0.31 }), `This assignment so far: 18 min, 64 tool calls, $0.31. ${TAIL}`);
	assert.equal(runAwarenessNote({ minutes: 18, toolCalls: 64 }), `This assignment so far: 18 min, 64 tool calls. ${TAIL}`);
	assert.equal(runAwarenessNote({ minutes: 18, toolCalls: 1, usd: 0.0024 }), `This assignment so far: 18 min, 1 tool call, $0.002. ${TAIL}`);
	assert.equal(runAwarenessNote({ minutes: 0, toolCalls: 40 }), `This assignment so far: under 1 min, 40 tool calls. ${TAIL}`);
});

test('a child hears its figures once past ten minutes or another forty calls, never every call', () => {
	const clock = { at: 0 };
	const f = fixture(clock);
	f.calls(5);
	assert.equal(f.sent.length, 0, 'nothing is sent in the first minutes');

	clock.at += 9 * 60_000;
	f.calls(5);
	assert.equal(f.sent.length, 0, 'nine minutes and ten calls are still quiet');

	clock.at += 60_000;
	f.calls(1);
	assert.equal(f.sent.length, 1, 'the first tool result past ten minutes gets one note');
	assert.equal(f.sent[0].content, `This assignment so far: 10 min, 11 tool calls. ${TAIL}`);
	assert.deepEqual(f.sent[0].options, { deliverAs: 'steer' });

	f.calls(39);
	assert.equal(f.sent.length, 1, 'thirty-nine more calls are not a new note');
	f.calls(1);
	assert.equal(f.sent.length, 2, 'the fortieth call since the note brings the next one');
	assert.match(f.sent[1].content, /^This assignment so far: 10 min, 51 tool calls\./);

	clock.at += 10 * 60_000;
	f.calls(1);
	assert.equal(f.sent.length, 3, 'ten minutes later the note returns with the totals');
	assert.match(f.sent[2].content, /^This assignment so far: 20 min, 52 tool calls\./);
});

test('a priced child sees its spend in the note; an unpriced one sees time and calls only', () => {
	const priced = { at: 0 };
	const withCost = fixture(priced);
	withCost.emit('message_end', { message: { role: 'assistant', usage: { input: 4000, output: 300, cost: { total: 0.12 } } } });
	withCost.emit('message_end', { message: { role: 'assistant', usage: { input: 4000, output: 300, cost: { total: 0.19 } } } });
	priced.at += 18 * 60_000;
	withCost.calls(1);
	assert.equal(withCost.sent[0].content, `This assignment so far: 18 min, 1 tool call, $0.31. ${TAIL}`);

	const unpriced = { at: 0 };
	const withoutCost = fixture(unpriced);
	withoutCost.emit('message_end', { message: { role: 'assistant', usage: { input: 4000, output: 300 } } });
	unpriced.at += 18 * 60_000;
	withoutCost.calls(1);
	assert.equal(withoutCost.sent[0].content, `This assignment so far: 18 min, 1 tool call. ${TAIL}`, 'a plan that reports no price leaves the amount out');
});
