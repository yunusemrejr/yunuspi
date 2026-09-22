import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession } from "../core/coding-agent/dist/core/sdk.js";
import { DefaultResourceLoader } from "../core/coding-agent/dist/core/resource-loader.js";
import { SessionManager } from "../core/coding-agent/dist/core/session-manager.js";
import { guardianOwnerForSession } from "../core/coding-agent/dist/core/guardian/guardian-supervisor.js";
import { SettingsManager } from "../core/coding-agent/dist/core/settings-manager.js";

// The only simulated boundary is the provider transport. The SDK, AgentSession,
// tool execution, tool error generation, event delivery, WASM and steer queue
// are the real implementation. No credentials or external services are used.
test("real SDK sessions reopening one transcript retain independent Guardian ownership and next-request delivery", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-sdk-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const transcript = path.join(cwd, "shared-session.jsonl");
	fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", version: 3, id: "guardian-shared-transcript", timestamp: new Date().toISOString(), cwd })}\n`);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const model = { id: "guardian-audit", name: "Guardian audit transport", api: "openai-completions", provider: "audit", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const makeSession = async () => {
		let turn = 0;
		const contexts = [];
		const modelRuntime = {
			getModel: () => model,
			getAvailable: () => [model],
			hasConfiguredAuth: () => true,
			isUsingSubscription: () => false,
			getAuth: async () => ({ auth: { apiKey: ["synthetic", "fixture"].join("-") } }),
			streamSimple(_model, context) {
				contexts.push(JSON.parse(JSON.stringify(context)));
				turn++;
				const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
					content: turn <= 3 ? [{ type: "toolCall", id: `edit-${turn}`, name: "edit", arguments: { path: "missing.js", oldText: "a", newText: "b" } }] : [{ type: "text", text: "The missing file must be located before editing." }],
					stopReason: turn <= 3 ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
			},
		};
		const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(transcript, cwd, cwd), tools: ["edit"], thinkingLevel: "off" });
		t.after(() => session.dispose());
		return { session, contexts };
	};
	const [enabled, disabled] = await Promise.all([makeSession(), makeSession()]);
	assert.equal(enabled.session.sessionId, disabled.session.sessionId);
	assert.notEqual(enabled.session.sessionManager, disabled.session.sessionManager);
	assert.equal(guardianOwnerForSession(enabled.session.sessionId), undefined, "textual ID alone cannot select between two live owners");
	assert.equal(guardianOwnerForSession(enabled.session.sessionId, enabled.session.sessionManager), enabled.session._guardian.ownerId);
	assert.equal(guardianOwnerForSession(disabled.session.sessionId, disabled.session.sessionManager), disabled.session._guardian.ownerId);
	await disabled.session.prompt("/guardian off", { source: "rpc" });
	await Promise.all([enabled.session.prompt("Fix the missing module.", { source: "rpc" }), disabled.session.prompt("Fix the missing module.", { source: "rpc" })]);
	const notices = enabled.session.messages.filter((message) => message.customType === "guardian_intervention");
	assert.equal(notices.length, 1, JSON.stringify({messages: enabled.session.messages, stats: enabled.session._guardian.handleCommand("/guardian stats"), journal: enabled.session._guardian._arbiter.journal(), tasks: [...enabled.session._guardian._tasks.values()]}));
	assert.equal(notices[0].details.sessionId, enabled.session.sessionId);
	assert.equal(enabled.session.messages.filter((message) => message.role === "toolResult" && message.isError).length, 3);
	assert.equal(disabled.session.messages.filter((message) => message.customType === "guardian_intervention").length, 0);
	assert.equal(enabled.contexts.length, 4);
	assert.match(JSON.stringify(enabled.contexts.at(-1)), /same tool operation failed repeatedly/);
	assert.doesNotMatch(JSON.stringify(disabled.contexts), /same tool operation failed repeatedly/);
	assert.equal(enabled.session._guardian.handleCommand("/guardian status").kernel, "classifier:ready,similarity:ready");
	assert.equal(disabled.session._guardian.handleCommand("/guardian stats").stats.observed, 0);
	disabled.session.dispose();
	assert.equal(guardianOwnerForSession(enabled.session.sessionId, enabled.session.sessionManager), enabled.session._guardian.ownerId);
	assert.ok(enabled.session._guardian.noteInput({ requestId: "after-other-disposal", originalText: "Continue", source: "rpc" }));
});
