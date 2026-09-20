import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((candidate) =>
	fs.existsSync(path.join(candidate, "extensions/pi-subagents/src/runs/shared/child-circuit-breakers.ts")),
);
const {
	DEFAULT_CHILD_BREAKER_POLICY,
	evaluateChildBreakers,
	resolveChildBreakerPolicy,
} = await import(pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/child-circuit-breakers.ts")));

test("per-child tool-call cap trips before an exploratory child can run away", () => {
	assert.equal(DEFAULT_CHILD_BREAKER_POLICY.maxToolCalls, 48);
	assert.deepEqual(
		evaluateChildBreakers({ now: 100, startedAt: 100, lastProgressAt: 100, toolCalls: 47 }),
		{ tripped: false },
	);
	const verdict = evaluateChildBreakers({ now: 100, startedAt: 100, lastProgressAt: 100, toolCalls: 48 });
	assert.equal(verdict.tripped, true);
	if (verdict.tripped) {
		assert.equal(verdict.reason, "excessive_tool_calls");
		assert.deepEqual(verdict.evidence, { toolCalls: 48, limit: 48 });
	}
});

test("tool-call cap is independently configurable and terminal children are ignored", () => {
	const policy = resolveChildBreakerPolicy({ PI_SUBAGENT_MAX_CHILD_TOOLS: "7" });
	assert.equal(policy.maxToolCalls, 7);
	assert.equal(
		evaluateChildBreakers({ now: 100, startedAt: 100, lastProgressAt: 100, toolCalls: 7 }, policy).reason,
		"excessive_tool_calls",
	);
	assert.deepEqual(
		evaluateChildBreakers({ now: 100, startedAt: 100, lastProgressAt: 100, toolCalls: 999, terminal: true }, policy),
		{ tripped: false },
	);
});
