import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 25 Nov 2026: "when everything is done in a session, no stale or unattended subagent process is left active".
// Children a session starts are recorded by pid and kernel start time; leaving the session ends them, and the next
// session ends the ones whose owner is gone. Every process below is a real `sleep` this test started.

const root = path.resolve(import.meta.dirname, '..');
const sub = path.join(root, 'agent/extensions/pi-subagents/src');
const { recordChild, endOwnChildren, endOrphans, signalOwnChildrenAtExit, stillRunningNote, keepStillRunningNote } = await import(pathToFileURL(path.join(sub, 'runs/shared/nothing-left-running.ts')).href);
const { readProcessState } = await import(pathToFileURL(path.join(sub, 'shared/process-start-identity.ts')).href);

const identityOf = (pid) => readProcessState(pid).startIdentity;
const isRunning = (pid) => { const state = readProcessState(pid); return state !== undefined && state.state !== 'Z' && state.state !== 'X'; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withEnv(env, fn) {
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
	return Promise.resolve().then(fn).finally(restore);
}

/** A temporary state folder and the children a test starts; whatever is left at the end is killed. */
function rig(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nothing-left-running-'));
	const children = [];
	t.after(() => {
		for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const start = async (command = ['sleep', '300'], { detached = false } = {}) => {
		const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached });
		children.push(child);
		await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
		return child;
	};
	const records = () => fs.readdirSync(dir).filter((name) => /^\d+-\d+\.json$/.test(name));
	/** A session process that has already gone: its pid and start time, as an owner record would hold them. */
	const deadOwner = async () => {
		const owner = await start();
		const identity = identityOf(owner.pid);
		owner.kill('SIGKILL');
		await new Promise((resolve) => owner.once('exit', resolve));
		return { pid: owner.pid, startIdentity: identity };
	};
	const liveOwner = async () => { const owner = await start(); return { pid: owner.pid, startIdentity: identityOf(owner.pid) }; };
	return { dir, start, records, deadOwner, liveOwner };
}

test('leaving the session ends every child it recorded, and its records go', async (t) => {
	const { dir, start, records } = rig(t);
	const one = await start();
	const two = await start();
	recordChild({ kind: 'foreground', pid: one.pid, group: false }, { dir });
	recordChild({ kind: 'foreground', pid: two.pid, group: false }, { dir });
	assert.equal(records().length, 2);
	assert.equal(await endOwnChildren('session-end', { dir }), 2);
	await pause(50);
	assert.equal(isRunning(one.pid), false);
	assert.equal(isRunning(two.pid), false);
	assert.deepEqual(records(), []);
});

test('a child that leads a process group takes its own children with it', async (t) => {
	const { dir, start } = rig(t);
	const runner = await start(['sh', '-c', 'sleep 300 & sleep 301 & wait'], { detached: true });
	await pause(200);
	recordChild({ kind: 'runner', pid: runner.pid, group: true }, { dir });
	await endOwnChildren('session-end', { dir });
	await pause(100);
	assert.throws(() => process.kill(-runner.pid, 0), { code: 'ESRCH' }, 'no member of the group is left');
});

test('a runner whose leader has exited still has its group ended', async (t) => {
	const { dir, start } = rig(t);
	const runner = await start(['sh', '-c', 'sleep 300 & sleep 1'], { detached: true });
	await pause(200);
	recordChild({ kind: 'runner', pid: runner.pid, group: true }, { dir });
	await new Promise((resolve) => runner.once('exit', resolve));
	assert.doesNotThrow(() => process.kill(-runner.pid, 0), 'the grandchild keeps the group alive');
	assert.equal(await endOwnChildren('session-end', { dir }), 1);
	await pause(100);
	assert.throws(() => process.kill(-runner.pid, 0), { code: 'ESRCH' }, 'no member of the group is left');
});

test('a group whose leader pid now belongs to another process is not signalled', async (t) => {
	const { dir, start, records } = rig(t);
	const runner = await start(['sleep', '300'], { detached: true });
	recordChild({ kind: 'runner', pid: runner.pid, group: true }, { dir });
	const file = path.join(dir, records()[0]);
	const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
	fs.writeFileSync(file, JSON.stringify({ ...record, startIdentity: 'linux:1' }));
	assert.equal(await endOwnChildren('session-end', { dir }), 0);
	assert.equal(isRunning(runner.pid), true, 'a process whose start time does not match is left alone');
});

test('each ending writes one log line with kind, pid, age and reason, and nothing else', async (t) => {
	const { dir, start } = rig(t);
	const child = await start(['sleep', '299']);
	recordChild({ kind: 'foreground', pid: child.pid, group: false }, { dir, now: () => Date.now() - 125_000 });
	await endOwnChildren('session-end', { dir });
	const lines = fs.readFileSync(path.join(dir, 'ended.log'), 'utf-8').trim().split('\n');
	assert.equal(lines.length, 1);
	assert.match(lines[0], new RegExp(`^\\S+ foreground pid=${child.pid} age=12[4-9]s why=session-end result=term$`));
	assert.doesNotMatch(lines[0], /sleep|299/, 'no command text');
});

test('a child of a session that is gone is ended by the next sweep; a child of a live session is left', async (t) => {
	const { dir, start, deadOwner, liveOwner, records } = rig(t);
	const orphan = await start();
	const kept = await start();
	const gone = await deadOwner();
	const alive = await liveOwner();
	recordChild({ kind: 'foreground', pid: orphan.pid, group: false }, { dir, owner: gone });
	recordChild({ kind: 'foreground', pid: kept.pid, group: false }, { dir, owner: alive });
	assert.equal(await endOrphans({ dir }), 1);
	await pause(50);
	assert.equal(isRunning(orphan.pid), false);
	assert.equal(isRunning(kept.pid), true, 'another live session\'s worker is never touched');
	assert.deepEqual(records(), [`${alive.pid}-${kept.pid}.json`]);
	assert.match(fs.readFileSync(path.join(dir, 'ended.log'), 'utf-8'), /why=owner-gone/);
});

test('the sweep never ends the session\'s own children or its own process', async (t) => {
	const { dir, start, deadOwner, records } = rig(t);
	const mine = await start();
	recordChild({ kind: 'foreground', pid: mine.pid, group: false }, { dir });
	const gone = await deadOwner();
	// A record that names this very process as the orphan: it is never signalled.
	fs.writeFileSync(path.join(dir, `${gone.pid}-${process.pid}.json`), JSON.stringify({ version: 1, kind: 'foreground', pid: process.pid, startIdentity: identityOf(process.pid), group: false, ownerPid: gone.pid, ownerStartIdentity: gone.startIdentity, startedAtMs: Date.now() }));
	await endOrphans({ dir });
	assert.equal(isRunning(mine.pid), true);
	assert.equal(isRunning(process.pid), true);
	assert.deepEqual(records(), [`${process.pid}-${mine.pid}.json`]);
});

test('a record whose pid now belongs to another process is left alone and its record removed', async (t) => {
	const { dir, start, deadOwner, records } = rig(t);
	const stranger = await start();
	const gone = await deadOwner();
	fs.writeFileSync(path.join(dir, `${gone.pid}-${stranger.pid}.json`), JSON.stringify({ version: 1, kind: 'runner', pid: stranger.pid, startIdentity: 'linux:1', group: true, ownerPid: gone.pid, ownerStartIdentity: gone.startIdentity, startedAtMs: Date.now() }));
	assert.equal(await endOrphans({ dir }), 0);
	await pause(50);
	assert.equal(isRunning(stranger.pid), true, 'a different start time means a recycled pid: no signal');
	assert.deepEqual(records(), []);
	// Leaving the session treats a mismatch the same way.
	const mine = await start();
	fs.writeFileSync(path.join(dir, `${process.pid}-${mine.pid}.json`), JSON.stringify({ version: 1, kind: 'foreground', pid: mine.pid, startIdentity: 'linux:2', group: false, ownerPid: process.pid, ownerStartIdentity: identityOf(process.pid), startedAtMs: Date.now() }));
	await endOwnChildren('session-end', { dir });
	assert.equal(isRunning(mine.pid), true);
	assert.deepEqual(records(), []);
});

test('a child that ignores TERM is gone after the wait', async (t) => {
	const { dir, start } = rig(t);
	const stubborn = await start(['sh', '-c', 'trap "" TERM; while :; do sleep 1; done']);
	await pause(200);
	recordChild({ kind: 'foreground', pid: stubborn.pid, group: false }, { dir });
	const began = Date.now();
	await endOwnChildren('session-end', { dir, termGraceMs: 400 });
	await pause(50);
	assert.equal(isRunning(stubborn.pid), false);
	assert.ok(Date.now() - began < 2_000, 'the wait is bounded');
	assert.match(fs.readFileSync(path.join(dir, 'ended.log'), 'utf-8'), /result=kill/);
});

test('PI_REAP=0 ends nothing and still cleans the records', async (t) => {
	const { dir, start, deadOwner, records } = rig(t);
	const mine = await start();
	const orphan = await start();
	recordChild({ kind: 'foreground', pid: mine.pid, group: false }, { dir });
	recordChild({ kind: 'foreground', pid: orphan.pid, group: false }, { dir, owner: await deadOwner() });
	await withEnv({ PI_REAP: '0' }, async () => {
		await endOwnChildren('session-end', { dir });
		await endOrphans({ dir });
	});
	assert.equal(isRunning(mine.pid), true);
	assert.equal(isRunning(orphan.pid), true);
	assert.deepEqual(records(), []);
	assert.equal(fs.existsSync(path.join(dir, 'ended.log')), false);
});

test('stale records are removed: a child that already exited, and a file that is not a record', async (t) => {
	const { dir, start, liveOwner, records } = rig(t);
	const owner = await liveOwner();
	const short = await start(['sleep', '0.1']);
	recordChild({ kind: 'foreground', pid: short.pid, group: false }, { dir, owner });
	await new Promise((resolve) => short.once('exit', resolve));
	fs.writeFileSync(path.join(dir, '1-2.json'), '{not json');
	fs.writeFileSync(path.join(dir, '3-4.json'), JSON.stringify({ version: 1, kind: 'other' }));
	assert.equal(await endOrphans({ dir }), 0);
	assert.deepEqual(records(), []);
});

test('leaving at exit sends TERM and keeps the records for the next sweep', async (t) => {
	const { dir, start, records } = rig(t);
	const child = await start();
	recordChild({ kind: 'foreground', pid: child.pid, group: false }, { dir });
	signalOwnChildrenAtExit({ dir });
	await new Promise((resolve) => child.once('exit', resolve));
	assert.equal(isRunning(child.pid), false);
	assert.equal(records().length, 1, 'the sweep removes it once it sees the child gone');
});

test('the still-running note, one worker and several', () => {
	const now = 10 * 60_000;
	assert.equal(stillRunningNote([{ name: 'scout', startedAt: now - 4 * 60_000 }], now),
		'Still running: scout (4 min). The work is not done while a worker is out: read its report when it lands, or stop it now if its result is no longer needed.');
	assert.equal(stillRunningNote([{ name: 'scout', startedAt: now - 4 * 60_000 }, { name: 'reviewer', startedAt: now - 90_000 }], now),
		'Still running: scout (4 min); reviewer (2 min). The work is not done while a worker is out: read its report when it lands, or stop it now if its result is no longer needed.');
});

test('a malformed owner or an unreadable folder never throws', async (t) => {
	const { dir } = rig(t);
	assert.equal(await endOrphans({ dir: path.join(dir, 'missing') }), 0);
	assert.equal(await endOwnChildren('session-end', { dir: path.join(dir, 'missing') }), 0);
	assert.doesNotThrow(() => recordChild({ kind: 'foreground', pid: 999999999, group: false }, { dir }));
});

test('the still-running note read after a worker finished names only workers still out, or goes', () => {
	const note = (jobs) => ({ role: 'custom', customType: 'subagents-still-running', content: stillRunningNote(jobs, 600_000), details: { jobs }, timestamp: 600_000 });
	const a = { asyncId: 'a', name: 'scout', startedAt: 0 };
	const b = { asyncId: 'b', name: 'builder', startedAt: 0 };
	const user = { role: 'user', content: 'hi' };
	assert.equal(keepStillRunningNote(user, () => false), user, 'other messages pass unchanged');
	const both = note([a, b]);
	assert.equal(keepStillRunningNote(both, () => true), both, 'nothing finished: the note is untouched');
	const cut = keepStillRunningNote(both, (id) => id === 'b');
	assert.match(cut.content, /builder/);
	assert.doesNotMatch(cut.content, /scout/);
	assert.deepEqual(cut.details.jobs, [b]);
	assert.equal(keepStillRunningNote(both, () => false), undefined, 'every worker finished: no note is sent');
});
