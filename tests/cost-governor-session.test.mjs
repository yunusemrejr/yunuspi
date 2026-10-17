import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession } from '../core/coding-agent/dist/core/sdk.js';
import { DefaultResourceLoader } from '../core/coding-agent/dist/core/resource-loader.js';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';

const extension = (await import(pathToFileURL(path.resolve(import.meta.dirname, '../agent/extensions/cost-governor.ts')).href)).default;

// The only simulated boundary is the provider transport. The real SDK, agent
// loop, tool execution and context-hook chain exercise the governor.
test('the real agent loop folds an oversized request view while keeping the durable transcript', async (t) => {
	const saved = { ...process.env };
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-governor-session-'));
	process.env.PI_CONTEXT_BUDGET = '8000';
	process.env.PI_CONTEXT_KEEP = '2000';
	process.env.PI_COST_BUDGET_USD = 'off';
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(cwd, `fixture-${i}.txt`), `line ${i} ${'x'.repeat(40)}\n`.repeat(120));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [extension],
	});
	await loader.reload();
	const contexts = [];
	let calls = 0;
	const model = { id: 'cost-fixture', name: 'Cost fixture transport', api: 'openai-completions', provider: 'audit', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const modelRuntime = {
		getModel: () => model,
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ['synthetic', 'fixture'].join('-') } }),
		streamSimple(_model, context) {
			contexts.push(JSON.parse(JSON.stringify(context)));
			calls++;
			const tool = calls <= 10;
			const message = {
				role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: tool
					? [{ type: 'toolCall', id: `read-${calls}`, name: 'read', arguments: { path: `fixture-${calls}.txt` } }]
					: [{ type: 'text', text: 'Read the files and summarized them.' }],
				stopReason: tool ? 'toolUse' : 'stop',
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, reasoning: 0, cost: { input: 0.00003, output: 0.000012, cacheRead: 0, cacheWrite: 0, total: 0.000042 } },
			};
			return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd), tools: ['read'], thinkingLevel: 'off',
	});
	t.after(() => session.dispose());
	await session.bindExtensions({});
	await session.prompt('Read the fixture files and summarize them without repeating unchanged work.', { source: 'rpc' });

	const all = contexts.map((context) => JSON.stringify(context));
	const foldedAt = all.findIndex((text) => text.includes('[context-fold]'));
	assert.ok(foldedAt >= 0, 'the request view folds before it exceeds the configured budget');
	const foldedContext = contexts[foldedAt];
	assert.ok(foldedContext, 'the folded request is captured');
	const foldedText = all[foldedAt];
	assert.match(foldedText, /Read the fixture files and summarize them/, 'the current user request survives folding');
	assert.match(foldedText, /fixture-/, 'the digest names files or commands from the folded history');
	const later = all.slice(foldedAt + 1);
	assert.ok(later.length > 0, 'the session continues after folding');
	assert.ok(later.some((text) => text.includes('[context-fold]')), 'the persisted fold is reapplied on later requests');
	assert.equal(session.messages.filter((message) => message.role === 'toolResult').length, 10, 'the durable transcript still has every tool result');
	assert.ok(session.messages.length > 10, 'the session history was not truncated');
});
