import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/pi-subagents/src/runs/shared/task-intent-model.ts")),
);
const { extractTaskIntent } = await import(
	pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/task-intent-model.ts")).href
);

test("prohibitions constrain execution without retyping the task", () => {
	const intent = extractTaskIntent("Investigate the outage but never deploy to production");
	assert.equal(intent.requestedAction, "investigate");
	assert.equal(intent.environmentSensitivity, "production-mention");
	assert.equal(intent.mutationPermission, "forbidden");
	assert.equal(intent.decisionCriticality, "advisory");
});

test("governed environment targeting resolves operate", () => {
	const intent = extractTaskIntent("Deploy the build to production tonight");
	assert.equal(intent.requestedAction, "operate");
	assert.equal(intent.environmentSensitivity, "production-target");
});

test("extraction is deterministic across interleaved calls", () => {
	const a = "Investigate the outage but never deploy to production";
	const b = "Refactor the router for clarity";
	const first = extractTaskIntent(a);
	extractTaskIntent(b);
	extractTaskIntent("Summarize the changelog");
	const again = extractTaskIntent(a);
	assert.deepEqual(again, first);
});
