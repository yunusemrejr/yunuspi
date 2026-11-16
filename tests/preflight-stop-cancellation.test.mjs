import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../core/coding-agent/dist/core/sdk.js";
import { DefaultResourceLoader } from "../core/coding-agent/dist/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/dist/core/settings-manager.js";

// Real SDK + AgentSession; only the provider transport is simulated. The
// extension stands in for a pre-turn planner: it launches child work inside
// before_agent_start from ctx.signal and leaves it pending.
test("Stop during before_agent_start aborts extension preflight children and frees the next prompt", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-stop-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const children = [];
	const extension = (pi) => {
		pi.on("before_agent_start", async (event, ctx) => {
			// Bind children to ctx.signal, then wait for them.
			const signals = [ctx.signal, event.signal];
			assert.ok(signals[0] && signals[1], "an idle-started prompt still has a request-owned signal");
			const child = { signal: ctx.signal, aborted: false };
			ctx.signal.addEventListener("abort", () => { child.aborted = true; }, { once: true });
			children.push(child);
			await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
			return undefined;
		});
	};
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
	await loader.reload();
	const model = { id: "stop-audit", name: "Stop audit transport", api: "openai-completions", provider: "audit", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	let turns = 0;
	const modelRuntime = {
		getModel: () => model,
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
		streamSimple() {
			turns++;
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
	t.after(() => session.dispose());

	const first = session.prompt("first prompt", { source: "rpc" });
	first.catch(() => {});
	while (children.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.isStreaming, false, "no agent run exists yet, so no agent signal can reach the preflight");

	const stopped = Date.now();
	await session.abort();
	await assert.rejects(first);
	assert.equal(children[0].aborted, true, "Stop reaches children launched during preflight");
	assert.ok(Date.now() - stopped < 2000, "cancellation is prompt");
	assert.equal(turns, 0, "the abandoned prompt never reaches the model");

	// The replacement prompt starts on a fresh chain and is not blocked by the old preflight.
	const second = session.prompt("second prompt", { source: "rpc" });
	second.catch(() => {});
	while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(children[0].aborted, true);
	assert.equal(children[1].aborted, false, "new request has its own live signal");
	await session.abort();
	await assert.rejects(second);
	assert.equal(children[1].aborted, true);
});

async function nextTurnFixture(t, pauseAt) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "next-turn-stop-"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const paused = Promise.withResolvers();
	const resume = Promise.withResolvers();
	let first = true;
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
		noContextFiles: true, extensionFactories: [pi => {
			if (!pauseAt) return;
			pi.on(pauseAt, async (_event, ctx) => {
				if (!first) return;
				first = false;
				paused.resolve();
				await Promise.race([resume.promise, new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }))]);
			});
		}] });
	await loader.reload();
	const manager = SessionManager.create(cwd, cwd);
	const model = { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid",
		reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	let turns = 0;
	const modelRuntime = { getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: "synthetic-fixture" } }), streamSimple() {
			turns++;
			const message = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
				content: [{ type: "text", text: "Synthetic result" }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0,
					cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
		} };
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader,
		sessionManager: manager, noTools: "all", thinkingLevel: "off" });
	t.after(() => { resume.resolve(); session.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });
	const accepted = [];
	return { session, manager, paused: paused.promise, resume: resume.resolve, accepted, turns: () => turns,
		queued: (content, canDeliver) => session.sendCustomMessage({ customType: "fixture-next-turn", content, display: false },
			{ deliverAs: "nextTurn", canDeliver, onAccepted: () => accepted.push(content) }),
		committed: () => manager.getEntries().filter(row => row.type === "custom_message" && row.customType === "fixture-next-turn").map(row => row.content),
	};
}

for (const pauseAt of ["before_agent_start", "agent_start"]) {
	test(`Stop during ${pauseAt} preserves next-turn messages until a successful append`, { timeout: 10_000 }, async t => {
		const f = await nextTurnFixture(t, pauseAt);
		await f.queued("Synthetic queued first");
		const stopping = f.session.prompt("Synthetic stopped prompt");
		const finished = stopping.then(() => "settled", () => "canceled");
		await f.paused;
		await f.queued("Synthetic queued while pending");
		await f.session.abort();
		assert.equal(await finished, pauseAt === "before_agent_start" ? "canceled" : "settled");
		assert.deepEqual(f.committed(), []);
		assert.deepEqual(f.accepted, []);
		assert.equal(f.turns(), 0);
		await f.session.prompt("Synthetic replacement prompt");
		assert.deepEqual(f.committed(), ["Synthetic queued first", "Synthetic queued while pending"]);
		assert.deepEqual(f.accepted, f.committed());
		const reopened = SessionManager.open(f.manager.getSessionFile(), f.manager.getSessionDir());
		assert.equal(reopened.getEntries().filter(row => row.type === "custom_message" && row.customType === "fixture-next-turn").length, 2);
		await f.session.prompt("Synthetic following prompt");
		assert.equal(f.committed().length, 2);
		assert.equal(f.accepted.length, 2);
	});
}

test("a late next-turn enqueue waits for the following prompt and a revoked message stays dropped", { timeout: 10_000 }, async t => {
	const f = await nextTurnFixture(t, "before_agent_start");
	let eligible = true;
	await f.queued("Synthetic revoked message", () => eligible);
	const first = f.session.prompt("Synthetic first prompt");
	await f.paused;
	eligible = false;
	await f.queued("Synthetic later message");
	f.resume();
	await first;
	assert.deepEqual(f.accepted, []);
	assert.deepEqual(f.committed(), []);
	await f.session.prompt("Synthetic second prompt");
	assert.deepEqual(f.accepted, ["Synthetic later message"]);
	assert.deepEqual(f.committed(), f.accepted);
});

test("a failed next-turn append retries exactly once on the following prompt", { timeout: 10_000 }, async t => {
	const f = await nextTurnFixture(t);
	await f.queued("Synthetic message survives failed append");
	const append = f.manager.appendCustomMessageEntry.bind(f.manager);
	let failOnce = true;
	f.manager.appendCustomMessageEntry = (...args) => {
		if (args[0] === "fixture-next-turn" && failOnce) {
			failOnce = false;
			assert.equal(args[5], true, "deferred messages commit through the durable append path");
			throw new Error("Synthetic append fault");
		}
		return append(...args);
	};
	await f.session.prompt("Synthetic prompt with a failed durable write");
	assert.equal(failOnce, false);
	assert.deepEqual(f.accepted, []);
	assert.deepEqual(f.committed(), []);
	assert.equal(f.turns(), 0);
	await f.session.prompt("Synthetic prompt after storage recovers");
	assert.deepEqual(f.committed(), ["Synthetic message survives failed append"]);
	assert.deepEqual(f.accepted, f.committed());
	assert.equal(f.turns(), 1);
});
