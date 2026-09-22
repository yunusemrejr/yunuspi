import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-runtime-hardening-"));
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

const importFrom = (rel) => import(pathToFileURL(path.join(root, rel)).href);

test("transaction confine blocks symlink-parent escape for new files", async () => {
	const { runTransaction } = await importFrom("agent/scripts/transaction.mjs");
	const workspace = path.join(work, "ws");
	const outside = path.join(work, "outside");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.symlinkSync(outside, path.join(workspace, "escape"));
	const receipt = await runTransaction(
		{
			ops: [
				{
					op: "write",
					path: "escape/pwned.txt",
					content: "should never land outside",
					overwrite: true,
				},
			],
		},
		{ root: workspace, apply: true },
	);
	assert.equal(receipt.ok, false);
	assert.equal(receipt.failure?.code, "path outside workspace");
	assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
});

test("transaction confine still allows ordinary in-workspace creates", async () => {
	const { runTransaction } = await importFrom("agent/scripts/transaction.mjs");
	const workspace = path.join(work, "ws-ok");
	fs.mkdirSync(workspace, { recursive: true });
	const receipt = await runTransaction(
		{
			ops: [
				{
					op: "write",
					path: "nested/ok.txt",
					content: "fine",
					overwrite: true,
				},
			],
		},
		{ root: workspace, apply: true },
	);
	assert.equal(receipt.ok, true);
	assert.equal(fs.readFileSync(path.join(workspace, "nested/ok.txt"), "utf8"), "fine");
});

test("malformed retry-after falls back to exponential backoff instead of a zero sleep", async () => {
	const { retryProviderRequest } = await importFrom(
		"core/ai/src/utils/provider-retry.js",
	);
	const attempts = [];
	const started = Date.now();
	const error = Object.assign(new Error("throttled"), {
		status: 429,
		headers: new Headers({ "retry-after": "not-a-date" }),
	});
	await assert.rejects(
		retryProviderRequest(
			async () => {
				attempts.push(Date.now() - started);
				throw error;
			},
			{ maxRetries: 1, maxRetryDelayMs: 60_000 },
		),
		/throttled/,
	);
	assert.equal(attempts.length, 2);
	// Old code slept ~0ms on a NaN delay; exponential first retry is >= 300ms.
	assert.ok(
		attempts[1] - attempts[0] >= 300,
		`expected exponential backoff, got ${attempts[1] - attempts[0]}ms`,
	);
});

test("negative retry-after is ignored and uses exponential backoff", async () => {
	const { retryProviderRequest } = await importFrom(
		"core/ai/src/utils/provider-retry.js",
	);
	const started = Date.now();
	let elapsed = 0;
	const error = Object.assign(new Error("throttled"), {
		status: 429,
		headers: new Headers({ "retry-after": "-5" }),
	});
	await assert.rejects(
		retryProviderRequest(
			async () => {
				elapsed = Date.now() - started;
				throw error;
			},
			{ maxRetries: 1, maxRetryDelayMs: 60_000 },
		),
		/throttled/,
	);
	assert.ok(elapsed >= 300, `expected exponential backoff, got ${elapsed}ms`);
});

test("isContextOverflow does not throw when usage is missing", async () => {
	const { isContextOverflow, isRecoverableLength } = await importFrom(
		"core/ai/src/utils/overflow.js",
	);
	const bare = { stopReason: "stop", content: [] };
	assert.equal(isContextOverflow(bare, 1000), false);
	const length = { stopReason: "length", content: [] };
	assert.equal(isContextOverflow(length, 1000), false);
	assert.equal(isRecoverableLength(length, 100), false);
});

test("calculateCost never publishes a NaN cacheWrite1h rate", async () => {
	const { calculateCost } = await importFrom("core/ai/src/models.js");
	const model = {
		provider: "test",
		id: "test-model",
		cost: { input: Number.NaN, output: 1, cacheRead: 0.1, cacheWrite: 0.2 },
	};
	const usage = {
		input: 100,
		output: 10,
		cacheRead: 0,
		cacheWrite: 50,
		cacheWrite1h: 20,
		totalTokens: 160,
	};
	const cost = calculateCost(model, usage);
	assert.equal(Number.isFinite(cost.total), true);
	assert.ok(
		cost.rates.cacheWrite1h === undefined || Number.isFinite(cost.rates.cacheWrite1h),
		`cacheWrite1h rate must be finite when present, got ${cost.rates.cacheWrite1h}`,
	);
	assert.equal(cost.complete, false);
});

test("execCommand force-kills a child that ignores SIGTERM", async () => {
	const { execCommand } = await importFrom("core/coding-agent/src/core/exec.js");
	const started = Date.now();
	const result = await execCommand(
		"bash",
		["-c", 'trap "" TERM; sleep 30'],
		work,
		{ timeout: 200 },
	);
	const elapsed = Date.now() - started;
	assert.equal(result.killed, true);
	assert.ok(
		elapsed < 8000,
		`SIGTERM-ignoring child must be escalated to SIGKILL, took ${elapsed}ms`,
	);
});

test("bash-executor flushes fullOutputPath before returning", async () => {
	const { executeBashWithOperations } = await importFrom(
		"core/coding-agent/src/core/bash-executor.js",
	);
	const chunk = "x".repeat(64 * 1024);
	const chunks = 40; // 2.5 MiB, well past the temp-file threshold
	const total = chunk.length * chunks;
	const operations = {
		async exec(_command, _cwd, { onData }) {
			for (let i = 0; i < chunks; i++) onData(Buffer.from(chunk));
			return { exitCode: 0 };
		},
	};
	const result = await executeBashWithOperations("big", work, operations);
	assert.ok(result.fullOutputPath, "expected a spilled temp file");
	const stat = fs.statSync(result.fullOutputPath);
	assert.ok(
		stat.size >= total,
		`temp file must be fully flushed on return (size ${stat.size} < ${total})`,
	);
	fs.rmSync(result.fullOutputPath, { force: true });
});
