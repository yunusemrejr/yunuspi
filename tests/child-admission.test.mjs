import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireChildAdmission } from "../agent/extensions/pi-subagents/src/runs/shared/child-admission.ts";

const moduleUrl = new URL("../agent/extensions/pi-subagents/src/runs/shared/child-admission.ts", import.meta.url).href;

function setup(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-child-admission-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return { directory, capacity: 1 };
}

async function hold(options) {
	const result = await acquireChildAdmission(options);
	assert.equal(result.kind, "admitted");
	return result.lease;
}

test("a shared slot can be released while another caller waits, and a waiting Stop never gets a slot", async (t) => {
	const options = setup(t);
	const holder = await hold(options);
	const controller = new AbortController();
	const stopped = acquireChildAdmission({ ...options, signal: controller.signal, waitMs: 1000 });
	const next = acquireChildAdmission({ ...options, waitMs: 1000 });
	await delay(15);
	controller.abort();
	assert.equal((await stopped).kind, "cancelled");
	assert.equal((await acquireChildAdmission({ ...options, waitMs: 0 })).kind, "capacity");
	holder.release();
	const admitted = await next;
	assert.equal(admitted.kind, "admitted");
	holder.release();
	assert.equal((await acquireChildAdmission({ ...options, waitMs: 0 })).kind, "capacity", "old release cannot affect the new holder");
	admitted.lease.release();
});

test("full admission respects its deadline and retains even an aged live lease", async (t) => {
	const options = setup(t);
	const holder = await hold(options);
	const old = new Date(Date.now() - 600_000);
	fs.utimesSync(path.join(options.directory, "slot-v1-0", "owner.json"), old, old);
	assert.equal((await acquireChildAdmission({ ...options, waitMs: 20 })).kind, "capacity");
	assert.equal((await acquireChildAdmission({ ...options, deadlineAt: Date.now() + 20, waitMs: 500 })).kind, "timed_out");
	holder.release();
	const oldLiveLease = path.join(options.directory, `subagent-${process.pid}-legacy.lock`);
	fs.writeFileSync(oldLiveLease, "0");
	fs.utimesSync(oldLiveLease, old, old);
	assert.equal((await acquireChildAdmission({ ...options, waitMs: 0 })).kind, "capacity");
	assert.ok(fs.existsSync(oldLiveLease));
});

test("separate parents cannot exceed the cap and a crashed reserved owner is reclaimable", { timeout: 10_000 }, async (t) => {
	const options = setup(t);
	const code = `
		import { acquireChildAdmission } from ${JSON.stringify(moduleUrl)};
		process.send('ready');
		process.once('message', async () => {
			const result = await acquireChildAdmission(${JSON.stringify({ ...options, waitMs: 500 })});
			if (result.kind === 'admitted') setInterval(() => {}, 1000);
			process.send(result.kind);
		});
	`;
	const makeParent = () => spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const parents = [makeParent(), makeParent()];
	const exits = parents.map(parent => once(parent, "exit"));
	try {
		await Promise.all(parents.map(parent => once(parent, "message")));
		const decisions = parents.map(parent => once(parent, "message"));
		parents.forEach(parent => parent.send("start"));
		const kinds = (await Promise.all(decisions)).map(([kind]) => kind);
		assert.deepEqual([...kinds].sort(), ["admitted", "capacity"]);
		const winner = kinds.indexOf("admitted");
		parents[winner].kill("SIGKILL");
		await exits[winner];
		const recovered = await hold({ ...options, waitMs: 0 });
		recovered.release();
	} finally {
		parents.forEach(parent => parent.kill("SIGKILL"));
		await Promise.all(exits);
	}
});

test("a crashed parent keeps occupying its slot until the recorded child exits", { timeout: 10_000 }, async (t) => {
	const options = setup(t);
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const childExit = once(child, "exit");
	const code = `
		import { acquireChildAdmission } from ${JSON.stringify(moduleUrl)};
		const holder = await acquireChildAdmission(${JSON.stringify(options)});
		holder.lease.markSpawning();
		holder.lease.markChild(${child.pid});
		process.send('running');
		setInterval(() => {}, 1000);
	`;
	const parent = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const parentExit = once(parent, "exit");
	try {
		assert.deepEqual(await once(parent, "message"), ["running", undefined]);
		parent.kill("SIGKILL");
		await parentExit;
		assert.equal((await acquireChildAdmission({ ...options, waitMs: 0 })).kind, "capacity");
		child.kill("SIGKILL");
		await childExit;
		const recovered = await hold({ ...options, waitMs: 0 });
		recovered.release();
	} finally {
		parent.kill("SIGKILL");
		child.kill("SIGKILL");
		await Promise.all([parentExit, childExit]);
	}
});

test("a live slot remains counted while configured capacity is reduced", async (t) => {
	const options = setup(t);
	const first = await hold(options);
	const second = await hold({ ...options, capacity: 2 });
	first.release();
	assert.equal((await acquireChildAdmission({ ...options, waitMs: 0 })).kind, "capacity");
	second.release();
	const remaining = await hold(options);
	remaining.release();
});
