import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 27 Nov 2026: the needed check kept the last typed message as the request, so "ok" or "continue" became the request
// Jev was asked about; its text cleaner dropped code like Map<string, number>; and the subagent extension's exit hooks
// were guarded by module state that a reload resets, so a second SIGINT handler made Ctrl+C a no-op.

process.env.PI_JEV = 'off';

const root = path.resolve(import.meta.dirname, '..');
const load = (file) => import(pathToFileURL(path.join(root, 'agent/extensions', file)).href);
const { Needed, plain, neededNote } = await load('lib/needed.ts');
const { installLeavingHooks } = await load('pi-subagents/src/extension/index.ts');

const read = (file) => ({ toolName: 'read', input: { path: file }, isError: false });
const LONG_MAIN = Array.from({ length: 20 }, (_, i) => read(`src/mod${i % 4}/file${i}.ts`));

function rig() {
	const asked = [];
	const needed = new Needed({ worker: false, now: () => 1_000_000, ask: async (state) => { asked.push(state); return 0.9; } });
	return { needed, asked, feed: async (events) => { let note = ''; for (const event of events) note = (await needed.observe(event, '/work/app')) || note; return note; } };
}

test('an acknowledgement or continue keeps the request and the check running', async () => {
	for (const reply of ['ok', 'Continue.', 'yes', 'go on', 'ok, thanks', 'tamam', 'Devam', 'devam et', 'evet', 'Tamam, devam']) {
		const { needed, asked, feed } = rig();
		needed.request('Fix the failing login test in src/auth');
		await feed(LONG_MAIN.slice(0, 10));
		needed.request(reply);
		const note = await feed(LONG_MAIN.slice(10));
		assert.equal(asked.length, 1, `${reply}: steps were not reset`);
		assert.equal(asked[0].request, 'Fix the failing login test in src/auth', reply);
		assert.match(note, /The request: «Fix the failing login test in src\/auth»/, reply);
	}
});

test('a message that carries a task replaces the request, short or long', async () => {
	for (const next of ['Now add a flag', 'use vitest instead', 'Also update the README and the changelog for this release', 'ok now fix the login page']) {
		const { needed, asked, feed } = rig();
		needed.request('Fix the failing login test in src/auth');
		needed.request(next);
		await feed(LONG_MAIN);
		assert.equal(asked[0].request, next);
	}
});

test('an acknowledgement as the very first message sets no request', async () => {
	const { needed, asked, feed } = rig();
	needed.request('ok');
	assert.equal(await feed(LONG_MAIN), '');
	assert.equal(asked.length, 0);
});

test('plain strips harness frame tags and leaves code-like angle brackets alone', () => {
	assert.equal(plain('use Map<string, number> and a<b && c>d'), 'use Map<string, number> and a<b && c>d');
	assert.equal(plain('x <system-reminder>do it</system-reminder> y <goal id="1">z</goal> <task-notification>n</task-notification>'), 'x do it y z n');
	assert.equal(plain('<harness-note>a</harness-note> «b» <Promise<void>>'), 'a b <Promise<void>>');
	assert.match(neededNote(false, 'type Pair<A, B> = [A, B]', [], { sign: 'long', n: 40 }), /«type Pair<A, B> = \[A, B\]»/);
});

test('reloading the subagent extension leaves one own SIGINT and exit hook and Ctrl+C still ends the process', async () => {
	const realExit = process.exit;
	const before = { sigint: process.listeners('SIGINT'), exit: process.listeners('exit') };
	const own = (event) => process.listeners(event).filter((listener) => !before[event === 'SIGINT' ? 'sigint' : 'exit'].includes(listener));
	let exited;
	const exit = new Promise((resolve) => { process.exit = (code) => resolve(code); });
	let foreign;
	// the runner may hold SIGINT listeners of its own: they are foreign to the extension, so set them aside
	for (const listener of before.sigint) process.off('SIGINT', listener);
	try {
		installLeavingHooks();
		const second = await import(`${pathToFileURL(path.join(root, 'agent/extensions/pi-subagents/src/extension/index.ts')).href}?reload`);
		second.installLeavingHooks();
		installLeavingHooks();
		assert.equal(own('SIGINT').length, 1, 'one SIGINT handler after reloads');
		assert.equal(own('exit').length, 1, 'one exit hook after reloads');
		own('SIGINT')[0]();
		exited = await exit;
		assert.equal(exited, 130);

		// a listener that is not ours still owns the decision
		let again = false;
		process.exit = () => { again = true; };
		foreign = () => {};
		process.on('SIGINT', foreign);
		own('SIGINT').find((listener) => listener !== foreign)();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(again, false, 'a foreign SIGINT listener suppresses the exit');
	} finally {
		process.exit = realExit;
		for (const listener of before.sigint) process.on('SIGINT', listener);
		if (foreign) process.off('SIGINT', foreign);
		for (const listener of own('SIGINT')) process.off('SIGINT', listener);
		for (const listener of own('exit')) process.off('exit', listener);
	}
});
