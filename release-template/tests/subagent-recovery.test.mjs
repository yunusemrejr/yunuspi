import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((dir) =>
	fs.existsSync(path.join(dir, "extensions/pi-subagents/src/agents/agents.ts")),
);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-recovery-"));
process.env.HOME = work;
process.env.PI_CODING_AGENT_DIR = path.join(work, "agent");
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
const load = (name) => import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src", name)).href);
const discovery = await load("agents/agents.ts");
const { handleManagementAction } = await load("agents/agent-management.ts");
const retry = await load("shared/file-system-retry.ts");

test("invalid user overrides retain the builtin and expose the broken file", () => {
	const directory = path.join(process.env.PI_CODING_AGENT_DIR, "agents");
	fs.mkdirSync(directory, { recursive: true });
	const brokenFile = path.join(directory, "worker.md");
	fs.writeFileSync(brokenFile, "---\nname: worker\ndescription: Broken override\nallowNestedSubagents: invalid\n---\nWorker\n");
	discovery.clearAgentDiscoveryCache();
	const found = discovery.discoverAgents(work, "user");
	const worker = found.agents.find((entry) => entry.name === "worker");
	assert.equal(worker?.source, "builtin");
	assert.equal(discovery.findBlockingAgentDiagnostic("worker", worker, found.agentDiagnostics), undefined);
	assert.equal(discovery.findShadowedAgentDiagnostic("worker", worker, found.agentDiagnostics)?.filePath, brokenFile);
	const context = { cwd: work, modelRegistry: { getAvailable: () => [] } };
	for (const action of ["get", "list", "models"]) {
		const result = handleManagementAction(action, { agent: "worker", agentScope: "user" }, context);
		assert.notEqual(result.isError, true, action);
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		assert.ok(text.includes(brokenFile), action);
		assert.match(text, /Warning: ignoring invalid user agent definition/);
	}
});

test("fallback diagnostics follow aliases and preserve package namespaces", () => {
	const worker = { name: "worker", aliases: ["helper"], source: "builtin" };
	const broken = { name: "worker", source: "user", filePath: "/test/worker.md", error: "invalid tools" };
	assert.equal(discovery.findShadowedAgentDiagnostic("helper", worker, [broken]), broken);
	assert.equal(discovery.findBlockingAgentDiagnostic("worker", undefined, [broken]), broken);
	assert.match(discovery.formatBlockingAgentError("worker", broken), /invalid tools.*\/test\/worker\.md/);
	const packaged = { ...broken, packageSpecified: true, runtimeName: "other/worker" };
	assert.equal(discovery.findShadowedAgentDiagnostic("worker", worker, [packaged]), undefined);
	assert.equal(discovery.findBlockingAgentDiagnostic("other/worker", undefined, [packaged]), packaged);
});

test("filesystem retries bound parent stalls and preserve child durability", () => {
	const total = (delays) => delays.reduce((sum, delay) => sum + delay, 0);
	const parent = retry.resolveFileSystemRetryDelays({});
	const child = retry.resolveFileSystemRetryDelays({ PI_SUBAGENT_CHILD: "1" });
	assert.equal(total(parent), 100);
	assert.equal(total(child), 7885);
	assert.equal(parent.length, child.length);
	assert.equal(total(retry.resolveFileSystemRetryDelays({ [retry.FS_RETRY_MAX_TOTAL_MS_ENV]: "0", PI_SUBAGENT_CHILD: "1" })), 0);
	assert.throws(() => retry.resolveFileSystemRetryDelays({ [retry.FS_RETRY_MAX_TOTAL_MS_ENV]: "9007199254740992" }));
	const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
	const waits = [];
	let attempts = 0;
	assert.throws(() => retry.runFileSystemOperationWithRetry(() => { attempts++; throw busy; }, {
		retryDelaysMs: parent, wait: (ms) => waits.push(ms),
	}), (error) => error === busy);
	assert.equal(attempts, child.length + 1);
	assert.equal(total(waits), 100);
	assert.equal(retry.runFileSystemOperationWithRetry(() => "written"), "written");
});
