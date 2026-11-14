// A child that runs on a role's own model shows the role beside the model:
// "legwork · provider/leaf". Without a role the labels stay exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.dirname);
const { formatModelThinking } = await jiti.import('../agent/extensions/pi-subagents/src/shared/formatters.ts');
const { buildWidgetLines } = await jiti.import('../agent/extensions/pi-subagents/src/tui/render.ts');

const theme = { fg: (_color, text) => text, bold: (text) => text };

function widgetJob(steps) {
  return {
    asyncId: 'role-run', asyncDir: '/tmp/role-run', status: 'running', mode: 'parallel',
    startedAt: 1000, updatedAt: 2000, steps,
  };
}

test('formatModelThinking puts the role first, then the model and thinking', () => {
  assert.equal(formatModelThinking('deepinfra/leaf'), 'deepinfra/leaf');
  assert.equal(formatModelThinking('deepinfra/leaf', 'high'), 'deepinfra/leaf · thinking high');
  assert.equal(formatModelThinking('deepinfra/leaf', undefined, 'short', 'legwork'), 'legwork · deepinfra/leaf');
  assert.equal(formatModelThinking('deepinfra/leaf', 'high', 'short', 'legwork'), 'legwork · deepinfra/leaf · thinking high');
});

test('widget rows show the role beside the model only when the step has one', () => {
  const withoutRole = buildWidgetLines([widgetJob([
    { agent: 'scout', status: 'running', model: 'deepinfra/leaf', thinking: 'high' },
  ])], theme, 200);
  const withRole = buildWidgetLines([widgetJob([
    { agent: 'scout', status: 'running', model: 'deepinfra/leaf', thinking: 'high', role: 'legwork' },
  ])], theme, 200);

  const plainRow = withoutRole.find((line) => line.includes('deepinfra/leaf'));
  const roleRow = withRole.find((line) => line.includes('deepinfra/leaf'));
  assert.ok(plainRow, `no model row in:\n${withoutRole.join('\n')}`);
  assert.ok(roleRow, `no model row in:\n${withRole.join('\n')}`);
  assert.ok(plainRow.includes('(deepinfra/leaf · thinking high)'), plainRow);
  assert.ok(!plainRow.includes('legwork'), plainRow);
  assert.ok(roleRow.includes('(legwork · deepinfra/leaf · thinking high)'), roleRow);
});
