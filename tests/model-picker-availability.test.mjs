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
