import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelSelectorComponent } from '../core/coding-agent/src/modes/interactive/components/model-selector.js';

const model = { provider: 'configured-provider', id: 'mimo-v2.6-flash', name: 'MiMo Flash', api: 'openai-completions', baseUrl: 'https://example.invalid/v1', contextWindow: 32000, maxTokens: 8000 };
const row = { provider: model.provider, id: model.id, model };
function selector() {
  const picker = Object.create(ModelSelectorComponent.prototype);
  Object.assign(picker, { currentModel: model, allModels: [row], activeModels: [row], selectedIndex: 0, updateList() {} });
  return picker;
}
test('a matching registered route precedes a session-only unlisted ID', () => {
  const picker = selector();
  picker.filterModels('mimo');
  assert.equal(picker.filteredModels.length, 2);
  assert.equal(picker.filteredModels[picker.selectedIndex].model, model);
  assert.equal(picker.filteredModels[1].model.piUnlistedModel, true);
  assert.match(picker.filteredModels[1].model.name, /unverified/);
});
test('exact provider identity is preserved and unmatched session-only requests stay possible', () => {
  const picker = selector();
  picker.filterModels('configured-provider/mimo-v2.6-flash');
  assert.equal(picker.filteredModels.length, 1);
  assert.equal(picker.filteredModels[0].model, model);
  picker.filterModels('configured-provider/future-model');
  assert.equal(picker.filteredModels.length, 1);
  assert.equal(picker.filteredModels[0].model.provider, model.provider);
  assert.equal(picker.filteredModels[0].model.id, 'future-model');
  assert.equal(picker.filteredModels[0].model.piUnlistedModel, true);
});

test('G: typing a provider id lists that provider first, in its published order, and hides nothing', () => {
  const entry = (provider, id, name) => { const m = { provider, id, name, api: 'openai-completions', baseUrl: 'https://example.invalid/v1', contextWindow: 32000, maxTokens: 8000 }; return { provider, id, model: m }; };
  const rows = [entry('deepinfra', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash'), entry('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash'),
    entry('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'), entry('openrouter', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash')];
  const picker = Object.create(ModelSelectorComponent.prototype);
  Object.assign(picker, { currentModel: model, allModels: rows, activeModels: rows, selectedIndex: 0, updateList() {} });
  for (const query of ['deepseek', 'deeps']) {
    picker.filterModels(query);
    const shown = picker.filteredModels.filter((item) => !item.model.piUnlistedModel).map((item) => `${item.provider}/${item.id}`);
    assert.deepEqual(shown.slice(0, 2), ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'], query);
    assert.equal(shown.length, 4, 'nothing is hidden');
  }
});
