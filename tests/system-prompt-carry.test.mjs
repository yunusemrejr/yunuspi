import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentSession } from '../core/coding-agent/dist/core/sdk.js';
import { DefaultResourceLoader } from '../core/coding-agent/dist/core/resource-loader.js';
import { SessionManager } from '../core/coding-agent/dist/core/session-manager.js';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';

// Four sessions on 0.48/0.49 re-billed 80k–760k prompt tokens after every
// harness follow-up (cache-miss cause "system"): a triggered turn skips
// before_agent_start and fell back to the bare base prompt. The real SDK and
// agent loop run here; only the provider transport is simulated.
test('a harness-triggered turn keeps the system prompt extensions built, so the prefix cache still hits', async (t) => {
	const saved = { ...process.env };
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-carry-'));
	process.env.PI_CODING_AGENT_DIR = cwd;
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	let api, hold;
	const extension = (pi) => {
		api = pi;
		pi.on('before_agent_start', async (event) => {
			if (hold) await hold;
			return { systemPrompt: `${event.systemPrompt}\n\nExtension addition: frozen date anchor.` };
		});
		// Tool staging re-applies the active set between runs (as adaptive workflows do).
		pi.on('agent_settled', () => { pi.setActiveTools(pi.getActiveTools()); });
	};
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
	await loader.reload();
	const systems = [];
	let calls = 0;
	const model = { id: 'carry-fixture', name: 'Carry fixture', api: 'openai-completions', provider: 'audit', baseUrl: 'https://invalid.example', reasoning: false, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 };
	const modelRuntime = {
		getModel: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingSubscription: () => false,
		getAuth: async () => ({ auth: { apiKey: ['synthetic', 'fixture'].join('-') } }),
		streamSimple(_model, context) {
			systems.push(context.systemPrompt);
			calls++;
			const tool = calls === 2; // the follow-up run makes one tool call, so it has a second turn
			const message = {
				role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: tool ? [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'missing.txt' } }] : [{ type: 'text', text: 'Done.' }],
				stopReason: tool ? 'toolUse' : 'stop',
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message };
		},
	};
	const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ['read'], thinkingLevel: 'off' });
	t.after(() => session.dispose());
	await session.bindExtensions({});
	await session.prompt('Summarize the project.', { source: 'rpc' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(systems[0], /Extension addition: frozen date anchor\.$/);
	await api.sendMessage({ customType: 'project-test-followup', content: 'Run the planned check.', display: true }, { triggerTurn: true });
	assert.equal(calls, 3, 'the follow-up ran a tool turn and a final turn');
	assert.deepEqual(systems.slice(1), [systems[0], systems[0]], 'every follow-up request carries the byte-identical system prompt');
	await session.prompt('Now list the files.', { source: 'rpc' });
	assert.equal(systems.at(-1), systems[0], 'the next user prompt rebuilds the same prompt from the base');
	assert.equal(systems.at(-1).match(/Extension addition/g).length, 1, 'additions are rebuilt on the base, never stacked on the carried prompt');
	// Esc while before_agent_start is still running: the prompt never reaches the
	// model, and a later harness wake still carries the previous prompt.
	let release; hold = new Promise((resolve) => { release = resolve; });
	const aborted = session.prompt('A request the user cancels.', { source: 'rpc' }).catch((error) => error);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await session.abort();
	release(); hold = undefined;
	await aborted;
	const before = systems.length;
	await api.sendMessage({ customType: 'background-task-notification', content: 'Render finished.', display: true }, { triggerTurn: true });
	assert.ok(systems.length > before, 'the wake ran');
	assert.ok(systems.slice(before).every((system) => system === systems[0]), 'an aborted prompt leaves the carried prompt in force');
});
