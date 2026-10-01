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
// extension stands in for Double: it launches child work inside
// before_agent_start from ctx.signal and leaves it pending.
test("Stop during before_agent_start aborts extension preflight children and frees the next prompt", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-stop-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const children = [];
	const extension = (pi) => {
		pi.on("before_agent_start", async (event, ctx) => {
			// What Double does: bind children to ctx.signal, then wait for them.
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
