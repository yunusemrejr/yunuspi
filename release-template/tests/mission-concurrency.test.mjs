import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = [path.join(rootDir, "agent"), path.resolve(rootDir, "../agent"), path.resolve(rootDir, "..")]
	.find((candidate) => fs.existsSync(path.join(candidate, "extensions/pi-subagents/src/missions/store.ts")));
assert.ok(agentDir, "mission store source is available");

const storeUrl = pathToFileURL(path.join(agentDir, "extensions/pi-subagents/src/missions/store.ts")).href;
const lifecycleUrl = pathToFileURL(path.join(agentDir, "extensions/pi-subagents/src/missions/lifecycle.ts")).href;
const { createMission, listGlobalMissions, missionRecordPath, readMission, updateMission, updateMissionFromCurrent } = await import(storeUrl);

function waitFor(predicate, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) return resolve();
			if (Date.now() >= deadline) return reject(new Error(`Timed out after ${timeoutMs}ms`));
			setTimeout(check, 10);
		};
		check();
	});
}

function childProcess(child, label) {
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${label} exited with ${code ?? signal}\n${stdout}\n${stderr}`));
		});
	});
}

function fixtureLocation(root) {
	return {
		projectRoot: path.join(root, "project"),
		missionDir: path.join(root, "missions"),
		globalIndexDir: path.join(root, "index"),
		writeGlobalIndex: true,
	};
}

test("concurrent lifecycle completions preserve every mission run and artifact", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mission-concurrency-"));
	try {
		const location = fixtureLocation(root);
		const mission = createMission(location, { title: "Concurrent completion", objective: "Preserve every result", status: "active" });
		const seedArtifacts = Array.from({ length: 1_000 }, (_, index) => ({ kind: "note", path: path.join(root, "seed", `${index}.txt`) }));
		updateMission(location, mission.id, { addArtifacts: seedArtifacts });

		const workerPath = path.join(root, "mission-worker.mjs");
		const readyDir = path.join(root, "ready");
		const goPath = path.join(root, "go");
		fs.mkdirSync(readyDir);
		fs.writeFileSync(workerPath, `
import fs from "node:fs";
const { attachMissionToLaunchResult } = await import(process.env.LIFECYCLE_URL);
const location = JSON.parse(process.env.MISSION_LOCATION);
const index = Number(process.env.WORKER_INDEX);
fs.writeFileSync(process.env.READY_PATH, "ready", { flag: "wx" });
const deadline = Date.now() + 15000;
while (!fs.existsSync(process.env.GO_PATH)) {
  if (Date.now() >= deadline) throw new Error("start barrier timeout");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}
attachMissionToLaunchResult({
  binding: { missionId: process.env.MISSION_ID, location, autoCreated: false, announceInContent: false },
  result: {
    content: [{ type: "text", text: "completed " + index }],
    details: {
      mode: "single",
      runId: "run-" + index,
      results: [{ agent: "worker", exitCode: 0, usage: { input: 1, output: 1 }, savedOutputPath: process.env.ARTIFACT_PATH }],
    },
  },
});
`);

		const workerCount = 24;
		const workers = Array.from({ length: workerCount }, (_, index) => {
			const artifactPath = path.join(root, "results", `${index}.txt`);
			const child = spawn(process.execPath, ["--experimental-strip-types", workerPath], {
				env: {
					...process.env,
					LIFECYCLE_URL: lifecycleUrl,
					MISSION_LOCATION: JSON.stringify(location),
					MISSION_ID: mission.id,
					WORKER_INDEX: String(index),
					READY_PATH: path.join(readyDir, String(index)),
					GO_PATH: goPath,
					ARTIFACT_PATH: artifactPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			return childProcess(child, `mission worker ${index}`);
		});
		await waitFor(() => fs.readdirSync(readyDir).length === workerCount);
		fs.writeFileSync(goPath, "go");
		await Promise.all(workers);

		const stored = readMission(location, mission.id);
		assert.equal(stored.runs.length, workerCount, "no completed run may be overwritten by a concurrent writer");
		assert.equal(stored.artifacts.length, seedArtifacts.length + workerCount, "no result artifact may be overwritten by a concurrent writer");
		assert.deepEqual(new Set(stored.runs.map((run) => run.runId)), new Set(Array.from({ length: workerCount }, (_, index) => `run-${index}`)));
		assert.equal(stored.status, "completed");

		const indexed = listGlobalMissions(location.globalIndexDir);
		assert.deepEqual(indexed.warnings, []);
		assert.equal(indexed.entries.length, 1);
		assert.equal(indexed.entries[0].lastRunId, stored.runs.at(-1).runId, "record and index are committed by the same transaction");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a dead mission lock is reclaimed without letting release delete a successor lock", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mission-stale-lock-"));
	try {
		const location = fixtureLocation(root);
		const mission = createMission(location, { title: "Stale lock", objective: "Recover safely", status: "active" });
		const lockDir = `${missionRecordPath(location, mission.id)}.lock`;
		fs.mkdirSync(lockDir, { mode: 0o700 });
		fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ version: 1, pid: 2_147_483_647, hostname: os.hostname(), token: "dead-owner", createdAt: Date.now() }), { mode: 0o600 });
		const updated = updateMission(location, mission.id, { summary: "recovered" });
		assert.equal(updated.summary, "recovered");
		assert.equal(fs.existsSync(lockDir), false);

		const successor = { version: 1, pid: process.pid, hostname: os.hostname(), token: "successor-owner", createdAt: Date.now() };
		const replaced = updateMissionFromCurrent(location, mission.id, () => {
			fs.rmSync(lockDir, { recursive: true, force: true });
			fs.mkdirSync(lockDir, { mode: 0o700 });
			fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(successor), { mode: 0o600 });
			return { summary: "successor retained" };
		});
		assert.equal(replaced.summary, "successor retained");
		assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf-8")).token, successor.token, "release only removes its own token");
		fs.rmSync(lockDir, { recursive: true, force: true });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
