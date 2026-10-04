import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../core/coding-agent/dist/core/sdk.js";
import { DefaultResourceLoader } from "../core/coding-agent/dist/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../core/coding-agent/dist/core/settings-manager.js";

// A command that carries the user's own words (/goal) used to reach every hook as
// `source: "extension"`, the channel reserved for harness-generated wakes. Prompt
// analysis, design-direction guidance, the Guardian's literal-constraint tracking,
// the requirement ledger and prompt memory all skip that channel on purpose, so a
// /goal session ran its whole first task without any of them. The only simulated
// boundary here is the provider transport; the SDK, session, input queue, extension
// runner and Guardian are the real implementation.
test("authored extension messages are user input; every other extension message stays synthetic", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "authored-input-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const seen = [];
	let api;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => { api = pi; pi.on("input", (event) => { seen.push({ source: event.source, text: event.text, originalText: event.originalText }); }); }],
	});
	await loader.reload();
	const model = { id: "authored-fixture", name: "Authored input transport", api: "openai-completions", provider: "audit", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const modelRuntime = {
		getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
		streamSimple() {
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "Done." }], stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
	t.after(() => session.dispose());

	const request = "Redesign the settings page and keep the existing layout.";
	const continuation = "[goal g1, continuation 1/6] The goal is not finished: keep going.";
	const viaApi = "Authored through the extension API: keep the brand colors.";
	await session.sendUserMessage(request, { authored: true });
	await session.sendUserMessage(continuation);
	await api.sendUserMessage(viaApi, { authored: true });
	await api.sendUserMessage("[background task finished] exit 0");

	assert.deepEqual(seen.map((event) => event.source), ["interactive", "extension", "interactive", "extension"]);
	assert.deepEqual(seen.filter((event) => event.source === "interactive").map((event) => event.text), [request, viaApi]);

	// The Guardian opens an authoritative task for each authored request and none for synthetic messages.
	const tasks = [...session._guardian._tasks.values()];
	assert.deepEqual(tasks.map((task) => task.rawPrompt), [request, viaApi]);
	assert.deepEqual(tasks.map((task) => task.source), ["interactive", "interactive"]);
});

test("authored input carries the user's literal words apart from the text the model receives", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "authored-words-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const seen = [];
	const contexts = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => { pi.on("input", (event) => { seen.push({ source: event.source, text: event.text, originalText: event.originalText }); }); }],
	});
	await loader.reload();
	const model = { id: "authored-words", name: "Authored words", api: "openai-completions", provider: "audit", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const modelRuntime = {
		getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
		streamSimple(_model, context) {
			contexts.push(JSON.parse(JSON.stringify(context)));
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "Done." }], stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
	t.after(() => session.dispose());

	const words = "Make the exporter handle unicode.\n\n- keep the CLI flags\n- add regression tests";
	const delivered = `[goal-tracked g1] Goal: ${words}\n\nAcceptance criteria:\n- C1: keep the CLI flags`;
	await session.sendUserMessage(delivered, { authored: true, userText: words });
	await session.sendUserMessage("[goal g1, continuation 1/6] keep going", { userText: "a synthetic message cannot claim to be the user's words" });
	assert.equal(seen[0].text, delivered, "handlers still see the delivered text");
	assert.equal(seen[0].originalText, words, "handlers see the user's words as originalText");
	assert.equal(seen[1].originalText, "[goal g1, continuation 1/6] keep going", "userText is ignored unless the message is authored");
	assert.equal([...session._guardian._tasks.values()][0].rawPrompt, words, "the Guardian records the user's words, so its constraint spans index what was written");
	assert.match(JSON.stringify(contexts[0]), /Acceptance criteria/, "the model receives the delivered text with the criteria");
});

test("only a strict true marks input as authored", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "authored-strict-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const seen = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [(pi) => { pi.on("input", (event) => { seen.push(event.source); }); }],
	});
	await loader.reload();
	const model = { id: "authored-strict", name: "Authored strict", api: "openai-completions", provider: "audit", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const modelRuntime = {
		getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
		streamSimple() {
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "Done." }], stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: [], thinkingLevel: "off" });
	t.after(() => session.dispose());
	for (const authored of ["true", 1, {}, undefined, false]) await session.sendUserMessage("Synthetic wake", { authored });
	assert.deepEqual(seen, ["extension", "extension", "extension", "extension", "extension"], "truthy lookalikes never claim the user's authority");
});
