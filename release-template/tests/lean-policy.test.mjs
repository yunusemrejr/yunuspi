import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.dirname);
const lean = await jiti.import('../agent/extensions/lib/lean-policy.ts');

const main = { provider: 'deepseek', id: 'deepseek-flash', reasoning: true, input: ['text'] };

test('sub-agents inherit the main model exactly by default', () => {
  const route = lean.resolveChildRoute(main, null, 'high');
  assert.equal(route.provider, 'deepseek');
  assert.equal(route.id, 'deepseek-flash');
  assert.equal(route.inherited, true);
  assert.equal(route.thinking, 'high');
});

test('explicit user override wins; Jev thinking applies to child too', () => {
  const route = lean.resolveChildRoute(main, { provider: 'openai', id: 'gpt-5' }, 'low');
  assert.equal(route.id, 'gpt-5');
  assert.equal(route.inherited, false);
  assert.equal(route.thinking, 'low');
});

test('thinking clamps to what the model supports', () => {
  assert.equal(lean.clampThinking('ultra', { ...main, thinkingLevelMap: {} }), 'high');
  assert.equal(lean.clampThinking('high', { provider: 'x', id: 'y', reasoning: false }), 'off');
});

test('images: no silent switch, honest refusal naming the fix', () => {
  assert.equal(lean.modelSupportsImages(main), false);
  assert.equal(lean.modelSupportsImages({ ...main, input: ['text', 'image'] }), true);
  const msg = lean.imageRefusal(main);
  assert.match(msg, /can't process images/);
  assert.match(msg, /won't switch models automatically/);
});

test('mid-session switch keeps history and never rebuilds context', () => {
  const plan = lean.planModelSwitch(main, { provider: 'anthropic', id: 'claude-sonnet-4', reasoning: true }, 'high');
  assert.equal(plan.keepHistory, true);
  assert.equal(plan.rebuildContext, false);
  assert.ok(plan.invalidate.includes('provider-session'));
  const same = lean.planModelSwitch(main, { ...main, id: 'deepseek-pro' }, 'high');
  assert.deepEqual(same.invalidate, ['endpoint-health']);
});

test('cache strategy is detected per provider architecture', () => {
  assert.equal(lean.cacheProfileFor('anthropic', 'claude-sonnet-4').strategy, 'anthropic-breakpoints');
  assert.equal(lean.cacheProfileFor('deepseek', 'deepseek-flash').strategy, 'deepseek-automatic');
  assert.equal(lean.cacheProfileFor('openai', 'gpt-5').strategy, 'openai-prefix');
  assert.equal(lean.cacheProfileFor('google', 'gemini-2.5-flash').strategy, 'gemini-context');
  assert.equal(lean.cacheProfileFor('openrouter', 'qwen/qwen3').strategy, 'openrouter-upstream');
  assert.equal(lean.cacheProfileFor('some-new-provider', 'model-x').strategy, 'stable-prefix');
  for (const p of ['anthropic', 'deepseek', 'openai', 'google', 'openrouter', 'x']) {
    assert.equal(lean.cacheProfileFor(p, 'm').stablePrefix, true);
  }
});

test('suggestions are capped at two and decay', () => {
  const budget = new lean.SuggestionBudget();
  assert.equal(budget.shouldShow(0, 0.9), true);
  budget.record(0);
  assert.equal(budget.shouldShow(4, 0.95), false); // too soon
  assert.equal(budget.shouldShow(20, 0.7), false); // threshold rose
  assert.equal(budget.shouldShow(20, 0.85), true);
  budget.record(20);
  assert.equal(budget.shouldShow(100, 1), false); // cap reached
});

test('goal self-verification prompt carries goal, criteria and evidence demand', () => {
  const prompt = lean.selfVerificationPrompt('Ship the fix', [{ id: 'C1', text: 'Tests pass' }]);
  assert.match(prompt, /Verify your own work/);
  assert.match(prompt, /Ship the fix/);
  assert.match(prompt, /C1: Tests pass/);
  assert.deepEqual(lean.openCriteria([{ id: 'C1', status: 'open' }, { id: 'C2', status: 'met' }]).map(c => c.id), ['C1']);
});
