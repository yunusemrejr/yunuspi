import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { cacheProfileFor } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/lean-policy.ts')).href);

test('every DeepSeek provider route is classified as an automatic prefix cache', () => {
	const routes = [
		['deepseek', 'deepseek-v4-flash'],
		['deepinfra', 'deepseek-ai/DeepSeek-V4-Flash'],
		['deepinfra', 'deepseek-ai/DeepSeek-V4-Pro'],
		['qwen-cloud-token-plan', 'deepseek-v4-pro'],
		['openrouter', 'deepseek/deepseek-v4.1-flash'],
		['openrouter', '~deepseek/deepseek-pro-latest'],
		['opencode', 'deepseek-v4-flash'],
		['fireworks', 'accounts/fireworks/models/deepseek-v4-flash-0731'],
		['together', 'deepseek-ai/DeepSeek-V3'],
		['amazon-bedrock', 'deepseek.v3.2'],
	];
	for (const [provider, model] of routes) {
		const profile = cacheProfileFor(provider, model);
		assert.equal(profile.strategy, 'deepseek-automatic', `${provider}/${model}`);
		assert.equal(profile.stablePrefix, true, `${provider}/${model}`);
		assert.equal(profile.breakpoints, 0, `${provider}/${model} needs no explicit breakpoints`);
	}
});

test('a provider alias does not hide a DeepSeek model from the cache profile', () => {
	assert.equal(cacheProfileFor('some-gateway', 'deepseek-chat').strategy, 'deepseek-automatic');
	assert.equal(cacheProfileFor('some-gateway', 'vendor/DeepSeek-V4-Flash-0731').strategy, 'deepseek-automatic');
	assert.equal(cacheProfileFor('some-gateway', 'glm-5.3').strategy, 'stable-prefix');
});
