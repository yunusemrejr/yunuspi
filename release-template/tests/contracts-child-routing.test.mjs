import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-contracts-routing-'));
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_PROVIDER_STATE_FILE = path.join(sandbox, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(sandbox, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(sandbox, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/model-selection.ts')),
);
assert.ok(agent, 'agent tree with model-selection.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { selectAffordableModel, describeSelectionRejections } = await import(shared + 'model-selection.ts');
const { loadModelEconomyConfig } = await import(shared + 'model-economy.ts');
const req = await import(shared + 'child-route-requirements.ts');
const { confidentValue, checkCapabilityProvenance } = await import(shared + 'catalog-confidence.ts');
const { formatCandidateRejection, recoveryHintForDimension, recordRouteDecision } = await import(shared + 'route-decision-record.ts');

const cfg = loadModelEconomyConfig();
const parent = { provider: 'p', id: 'big', fullId: 'p/big', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text', 'image'], cost: { input: 5, output: 20, cacheRead: 5, cacheWrite: 5 } };
const small = { provider: 'p', id: 'small', fullId: 'p/small', contextWindow: 32000, maxTokens: 4096, input: ['text'], cost: { input: 0.1, output: 0.4, cacheRead: 0.1, cacheWrite: 0.1 } };

test('child-scoped routing drops parent capacity gates', () => {
  const legacy = describeSelectionRejections([parent, small], cfg, { preferredModel: 'p/big' });
  const legacySmall = legacy.rejections.find((r) => r.route === 'p/small');
  assert.ok(legacySmall && legacySmall.dimensions.includes('context'), 'legacy inherits parent context');

  const child = req.buildChildRouteRequirements({ estimatedPromptTokens: 2000, contextMode: 'fresh', outputReserveTokens: 1024, toolCalling: false });
  const scoped = describeSelectionRejections([parent, small], cfg, { preferredModel: 'p/big', child });
  assert.ok(!scoped.rejections.some((r) => r.route === 'p/small'), 'child workload passes small model');
  assert.ok(scoped.rejections.some((r) => r.route === 'p/big' && r.dimensions.includes('price')));
});

test('context mode drives context requirements', () => {
  const fresh = req.buildChildRouteRequirements({ estimatedPromptTokens: 2000, contextMode: 'fresh', outputReserveTokens: 1024 });
  const fork = req.buildChildRouteRequirements({ estimatedPromptTokens: 2000, contextMode: 'full-fork', outputReserveTokens: 1024 });
  assert.ok(fork.minContextWindow >= fresh.minContextWindow);
  const prompt = req.estimateChildPromptTokens({ briefChars: 4000, contextMode: 'full-fork', parentPromptTokens: 50000 });
  assert.ok(prompt > 50000, 'full fork carries parent state');
  const pruned = req.estimateChildPromptTokens({ briefChars: 4000, contextMode: 'pruned-fork', parentPromptTokens: 50000, pruneRetention: 0.25 });
  assert.ok(pruned < prompt && pruned > 1000, 'pruned fork carries a fraction');
});

test('output reserve follows the report shape', () => {
  const verdict = req.estimateOutputReserve({ reportShape: 'verdict' });
  const audit = req.estimateOutputReserve({ reportShape: 'audit', fileCount: 40 });
  assert.ok(audit > verdict * 2, 'audits reserve more than verdicts');
});

test('rejection dimensions stay orthogonal with deterministic hints', () => {
  const { rejections } = describeSelectionRejections([parent, small], cfg, { preferredModel: 'p/big' });
  assert.ok(rejections.length >= 2);
  for (const rejection of rejections) {
    assert.ok(rejection.dimensions.length > 0);
    assert.ok(formatCandidateRejection(rejection).includes(rejection.route));
    for (const dimension of rejection.dimensions) {
      assert.ok(recoveryHintForDimension(dimension).length > 10, dimension);
    }
  }
  const dimensions = new Set(rejections.flatMap((r) => r.dimensions));
  assert.ok(dimensions.has('price') && (dimensions.has('context') || dimensions.has('output')));
});

test('successful selections attach bounded decision records', () => {
  const cheap = { ...small, fullId: 'q/tiny', provider: 'q' };
  const child = req.buildChildRouteRequirements({ estimatedPromptTokens: 1500, contextMode: 'fresh', outputReserveTokens: 1024, toolCalling: false });
  const pick = selectAffordableModel([cheap], cfg, { child, decision: { preferenceRole: 'automatic' } });
  assert.ok(pick, 'cheap route is selected');
  assert.ok(pick.decision, 'decision record attached');
  assert.equal(pick.decision.choice, pick.model);
  assert.equal(pick.decision.preferenceRole, 'automatic');
  assert.ok(pick.decision.candidates.length >= 1);
  assert.ok(JSON.stringify(pick.decision).length < 20000, 'record is bounded');
});

test('image needs route image-capable models; container images do not', () => {
  const { childRequirementsFromTask, detectImageNeed } = req;
  assert.equal(detectImageNeed('Review the attached screenshot for UI bugs'), true);
  assert.equal(detectImageNeed('Compare these two images'), true);
  assert.equal(detectImageNeed('Review the docker image build'), false);
  assert.equal(detectImageNeed('Review the login code'), false);
  assert.deepEqual(childRequirementsFromTask('Review the attached screenshot').inputModalities, ['text', 'image']);
  assert.equal(childRequirementsFromTask('Review the login code').inputModalities, undefined);
});

test('same model through two backends fails only where the payload is rejected', async () => {
  const { buildSelectionGateContext, evaluateCandidateGates } = await import(shared + 'model-selection.ts');
  const a = { provider: 'pa', id: 'm', fullId: 'pa/m', contextWindow: 64000, maxTokens: 8192, input: ['text'], cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.1 } };
  const b = { ...a, provider: 'pb', fullId: 'pb/m' };
  const gate = buildSelectionGateContext([a, b], {
    toolWire: { backend: 'deepseek', compatible: (route) => route.startsWith('pa/') ? { ok: false, reason: 'union rejected' } : { ok: true } },
  });
  const rejected = evaluateCandidateGates(a, gate);
  assert.ok(rejected.dimensions.includes('backend-compat'));
  assert.deepEqual(evaluateCandidateGates(b, gate).dimensions, [], 'same model stays eligible on the compatible backend');
});

test('auth-bound routes reject as authorization, not cooldown', async () => {
  const { buildSelectionGateContext, evaluateCandidateGates } = await import(shared + 'model-selection.ts');
  const model = { provider: 'pa', id: 'm', fullId: 'pa/m', contextWindow: 64000, maxTokens: 8192, input: ['text'], cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.1 } };
  const authHealth = { version: 1, providers: { pa: { cooldownUntil: Date.now() + 60000, failure: { kind: 'provider-auth', scope: 'provider' }, models: {} } } };
  const gate = buildSelectionGateContext([model], {}, Date.now(), authHealth);
  const verdict = evaluateCandidateGates(model, gate);
  assert.ok(verdict.dimensions.includes('authorization'));
  assert.ok(!verdict.dimensions.includes('provider-cooling'));
  assert.ok(verdict.detail.authorization.includes('dead credentials'));
});

test('catalog confidence gates high-stakes evidence selectively', () => {
  const facts = {
    contextWindow: confidentValue(32000, 'stored-cache', Date.now()),
    maxOutput: confidentValue(8192, 'inferred-fallback', Date.now()),
  };
  const loose = checkCapabilityProvenance(facts, { floors: { contextWindow: 'stored-cache' } });
  assert.equal(loose.ok, true);
  const strict = checkCapabilityProvenance(facts, { floors: { maxOutput: 'official-pricing' } });
  assert.equal(strict.ok, false);
  assert.ok(strict.misses[0].includes('maxOutput'));
  const unknown = checkCapabilityProvenance({}, { requireKnown: ['toolCalling'] });
  assert.equal(unknown.ok, false);
});

test('decision records bound required capabilities', () => {
  const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`capability-${i}`, 'x'.repeat(500)]));
  const record = recordRouteDecision({ candidates: [{ route: 'p/m', free: true }], requiredCapabilities: big });
  assert.ok(Object.keys(record.requiredCapabilities).length <= 16, 'capability keys capped');
  assert.ok(Object.values(record.requiredCapabilities).every((v) => String(v).length <= 160), 'capability values truncated');
  assert.ok(JSON.stringify(record).length < 20000, 'record stays bounded');
});

test('preferred reasoning never hard-gates; required always does', () => {
  for (const action of ['implement', 'plan', 'operate', 'investigate', 'review', 'unknown']) {
    const preferred = req.buildChildRouteRequirements({ estimatedPromptTokens: 1000, reasoning: 'preferred' }, { requestedAction: action });
    assert.equal(preferred.reasoning, false, `${action}: preferred must not gate`);
    const required = req.buildChildRouteRequirements({ estimatedPromptTokens: 1000, reasoning: 'required' }, { requestedAction: action });
    assert.equal(required.reasoning, true, `${action}: required must gate`);
  }
});
