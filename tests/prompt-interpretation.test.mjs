import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
	fs.existsSync(path.join(p, 'extensions/lib/prompt-interpretation.ts')),
);
if (!agent) throw new Error('agent extension tree is missing');
const mod = await import(pathToFileURL(path.join(agent, 'extensions/lib/prompt-interpretation.ts')));

test('prompt-analysis requests retain both ends of large input and distinguish initial from follow-up schema', () => {
	const long = `HEAD ${'background detail. '.repeat(2000)}TAIL preserve exact constraints`;
	const initial = mod.buildPromptAnalysisRequest(long, 'initial');
	assert.match(initial, /HEAD/);
	assert.match(initial, /TAIL preserve exact constraints/);
	assert.match(initial, /middle omitted/);
	assert.match(initial, /completionConditions/);
	assert.ok(initial.length < 27_000);
	const followup = mod.buildPromptAnalysisRequest('Also update the docs.', 'followup', {
		taskLabel: 'Current project', explicitConstraints: [], subtasks: ['earlier suggestion'],
	});
	assert.match(followup, /priorSuggestedSubtasks/);
	assert.match(followup, /clarification\/status question/);
	assert.doesNotMatch(followup, /needsMemory/);
});

test('analysis parser discards unknown fields and gates weak follow-up relations', () => {
	const prompt = 'Keep the existing API behavior.';
	const base = { intent: 'Maintain API behavior', confidence: 0.5, relation: 'replace', explicitConstraints: ['Keep the existing API behavior'] };
	const weak = mod.parsePromptAnalysis(JSON.stringify(base), prompt, 'followup');
	assert.equal(weak.relation, undefined);
	assert.deepEqual(weak.explicitConstraints, [{ text: 'Keep the existing API behavior', source: 'literal-user', start: 0, end: prompt.indexOf('.'), quoted: false }]);
	assert.equal(mod.parsePromptAnalysis(JSON.stringify({ ...base, unknown: true }), prompt, 'followup'), undefined);
	const strong = mod.parsePromptAnalysis(JSON.stringify({ ...base, confidence: 0.8, relation: 'status-question' }), prompt, 'followup');
	assert.equal(strong.relation, 'status-question');
});

test('literal constraints prefer an actionable repetition over an earlier quoted example', () => {
	const prompt = 'Example: "Keep the cache warm".\nKeep the cache warm.';
	const text = 'Keep the cache warm';
	const parsed = mod.parsePromptAnalysis(JSON.stringify({
		intent: 'Maintain the cache', explicitConstraints: [text],
	}), prompt, 'initial');
	const start = prompt.lastIndexOf(text);
	assert.deepEqual(parsed.explicitConstraints, [{
		text, source: 'literal-user', start, end: start + text.length, quoted: false,
	}]);
	assert.match(mod.renderPromptAnalysis(parsed, 'prompt_analysis'), /Keep the cache warm/);
});

test('literal constraints reach instructions between long runs of quoted examples', () => {
	const text = 'Keep the cache warm';
	const examples = Array.from({ length: 140 }, () => `Example: "${text}".`).join('\n');
	const prompt = `${examples}\n${text}.\n${examples}`;
	const parsed = mod.parsePromptAnalysis(JSON.stringify({
		intent: 'Maintain the cache', explicitConstraints: [text],
	}), prompt, 'initial');
	const start = examples.length + 1;
	assert.deepEqual(parsed.explicitConstraints, [{
		text, source: 'literal-user', start, end: start + text.length, quoted: false,
	}]);
});

test('full context projection remains valid JSON and includes every bounded advisory category', () => {
	const prompt = 'Implement the endpoint. Preserve the existing response body.';
	const parsed = mod.parsePromptAnalysis(JSON.stringify({
		intent: 'Implement endpoint', taskLabel: 'Endpoint', confidence: 0.9,
		deliverables: ['API endpoint'], explicitConstraints: ['Preserve the existing response body'],
		inferredConstraints: [{ text: 'Keep changes narrow', confidence: 0.72 }],
		subtasks: ['add route'], dependencies: ['router'], references: ['existing handler'],
		suggestedCapabilities: ['read'], expectedTools: ['test'], expectedSkills: ['typescript'],
		completionConditions: ['tests pass'], ambiguities: ['none'], needsExternalVerification: true,
		needsMemory: true, needsProjectGraph: true, reviewWorthy: true, multiPerspective: true,
	}), prompt, 'initial');
	const content = mod.renderPromptAnalysisContext(parsed, 'prompt_analysis', 'openrouter/cheap');
	const data = JSON.parse(content.split('\n')[1]);
	for (const key of ['intent', 'taskLabel', 'deliverables', 'explicitConstraints', 'inferredConstraints', 'subtasks', 'dependencies', 'references', 'suggestedCapabilities', 'expectedTools', 'expectedSkills', 'completionConditions', 'ambiguities']) assert.ok(key in data, key);
	assert.equal(data.needsMemory, true);
	assert.equal(data.route, 'openrouter/cheap');
});

test('Guardian event hashes raw source text and carries only the typed advisory contract', () => {
	const prompt = 'Do not deploy. Preserve the exact output shape.';
	const analysis = mod.fallbackPromptAnalysis(prompt, 'followup');
	const event = mod.promptAnalysisEvent({
		processId: 'process-a', sessionId: 'session-a', turnId: 'turn-a', requestId: 'request-a', prompt, analysis, inputSource: 'rpc',
	});
	assert.equal(event.version, 1);
	assert.equal(event.promptHash, createHash('sha256').update(prompt).digest('hex'));
	assert.equal(event.inputSource, 'rpc');
	assert.equal(event.analysisSource, 'fallback');
	assert.deepEqual(Object.keys(event).sort(), ['analysisSource', 'confidence', 'explicitConstraints', 'inferredConstraints', 'inputSource', 'kind', 'processId', 'promptHash', 'requestId', 'sessionId', 'subtasks', 'taskLabel', 'turnId', 'version'].sort());
});
