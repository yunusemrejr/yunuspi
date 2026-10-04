import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find((dir) => fs.existsSync(path.join(dir, 'extensions/pi-subagents/src/slash/double-pair-picker.ts')));
if (!agent) throw new Error('Double pair picker source is missing');
const { DoublePairPicker } = await import(pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/slash/double-pair-picker.ts')).href);

const MODELS = [
  { provider: 'openrouter', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true, thinkingLevelMap: { xhigh: 'x' } },
  { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
  { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', reasoning: true },
  { provider: 'cheap', id: 'plain-model', name: 'Plain', reasoning: false },
  { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', reasoning: true },
];

const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t', ctrlT: '\x14', ctrlR: '\x12' };
const keybindings = {
  matches(data, id) {
    return { 'tui.select.up': KEYS.up, 'tui.select.down': KEYS.down, 'tui.select.confirm': KEYS.enter, 'tui.select.cancel': KEYS.esc, 'tui.input.tab': KEYS.tab }[id] === data;
  },
};
const theme = { fg: (_color, text) => text, bold: (text) => text };
const tui = { renders: 0, requestRender() { this.renders++; } };
const strip = (lines) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

const open = (extra = {}) => {
  const results = [];
  const picker = new DoublePairPicker(tui, theme, keybindings, {
    models: MODELS,
    session: { provider: 'openrouter', id: 'glm-5.3-flash' },
    sessionThinking: 'high',
    done: (result) => results.push(result),
    ...extra,
  });
  const press = (...keys) => { for (const key of keys) picker.handleInput(key); };
  const type = (text) => { for (const char of text) picker.handleInput(char); };
  const screen = () => strip(picker.render(100));
  return { picker, results, press, type, screen };
};

test('the popup lists every provider\'s models with the session model first and two empty slots', () => {
  const { screen } = open();
  const view = screen();
  assert.match(view, /Custom Double · two models, one decision/);
  assert.match(view, /▸ A {2}builds the plan {2}choose a model below/);
  assert.match(view, /B {2}stress-tests it {2}choose a model below/);
  assert.match(view, /reconciles on model A/);
  const rows = view.split('\n').filter((line) => /\[[a-z]+\]/.test(line) && /→|^ {2}\S/.test(line));
  assert.match(rows[0], /→ glm-5\.3-flash \[openrouter\].*session/, 'the session model leads');
  for (const provider of ['openrouter', 'deepseek', 'zai', 'cheap', 'anthropic']) assert.match(view, new RegExp(`\\[${provider}\\]`));
  assert.match(view, /enter pick for A · tab switch A\/B · ctrl\+t thinking · ctrl\+r reconciler · esc cancel/);
});

test('search narrows across providers, enter fills A then B, and the Start row confirms', () => {
  const { press, type, screen, results } = open();
  type('deepseek');
  assert.match(screen(), /→ deepseek-flash \[deepseek\]/);
  assert.doesNotMatch(screen(), /\[zai\]/, 'the search filtered the list');
  press(KEYS.enter);
  assert.match(screen(), /A {2}builds the plan {2}deepseek-flash \[deepseek\] · thinking high/);
  assert.match(screen(), /▸ B {2}stress-tests it/, 'the next empty slot becomes active');
  type('zai');
  press(KEYS.enter);
  const view = screen();
  assert.match(view, /B {2}stress-tests it {2}glm-5\.3-flash \[zai\] · thinking high/);
  assert.match(view, /→ ▶ Start Double with these two models/, 'both slots filled: Start is the first row');
  assert.match(view, /enter start/);
  press(KEYS.enter);
  assert.equal(results.length, 1);
  assert.equal(results[0].confirmed, true);
  assert.deepEqual(results[0].pair, {
    a: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'high' },
    b: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'high' },
    reconcile: 'a',
  });
});

test('the same id on two providers stays two different choices, and the slots may share a provider', () => {
  const { press, type, results } = open();
  type('glm');
  // Two providers carry glm-5.3-flash; the picker keeps them apart.
  press(KEYS.down, KEYS.enter);
  type('glm');
  press(KEYS.enter, KEYS.enter);
  assert.equal(results[0].confirmed, true);
  assert.notEqual(`${results[0].pair.a.provider}/${results[0].pair.a.id}`, `${results[0].pair.b.provider}/${results[0].pair.b.id}`);
});

test('tab switches the slot being filled, ctrl+t cycles that slot\'s thinking, ctrl+r cycles the reconciler', () => {
  const { press, type, screen, results } = open();
  type('claude');
  press(KEYS.enter);
  type('plain');
  press(KEYS.enter);
  // The non-reasoning model has no levels to cycle: it was clamped to off at pick time.
  assert.match(screen(), /plain-model \[cheap\] · thinking off/);
  press(KEYS.ctrlT);
  assert.match(screen(), /plain-model runs without thinking levels/);
  press(KEYS.tab);
  assert.match(screen(), /▸ A {2}builds the plan/);
  press(KEYS.ctrlT);
  const afterCycle = screen();
  assert.doesNotMatch(afterCycle, /claude-sonnet \[anthropic\] · thinking high/, 'A moved off the session level');
  assert.match(afterCycle, /claude-sonnet \[anthropic\] · thinking /);
  press(KEYS.ctrlR);
  assert.match(screen(), /reconciles on model B/);
  press(KEYS.ctrlR);
  assert.match(screen(), /reconciles on the session model/);
  press(KEYS.ctrlR);
  assert.match(screen(), /reconciles on model A/);
  press(KEYS.ctrlR);
  press(KEYS.enter);
  assert.equal(results[0].pair.reconcile, 'b');
  assert.equal(results[0].pair.b.thinking, 'off');
});

test('escape cancels without a pair; an incomplete pair cannot start', () => {
  const { press, type, results, screen } = open();
  type('deepseek');
  press(KEYS.enter);
  assert.doesNotMatch(screen(), /▶ Start/, 'one slot filled: no Start row');
  press(KEYS.esc);
  assert.deepEqual(results, [{ confirmed: false }]);
});

test('a prefilled pair opens on Start, and re-picking a model keeps the thinking already chosen for it', () => {
  const initial = { a: { provider: 'deepseek', id: 'deepseek-flash', thinking: 'low' }, b: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'medium' }, reconcile: 'session' };
  const { press, type, screen, results } = open({ initial });
  assert.match(screen(), /→ ▶ Start Double/);
  assert.match(screen(), /reconciles on the session model/);
  // Re-pick A's own model: its chosen thinking stays.
  type('deepseek');
  press(KEYS.enter);
  assert.match(screen(), /deepseek-flash \[deepseek\] · thinking low/);
  press(KEYS.enter);
  assert.equal(results[0].pair.a.thinking, 'low');
  assert.equal(results[0].pair.b.thinking, 'medium');
  assert.equal(results[0].pair.reconcile, 'session');
});

test('a half prefill (one remembered model is gone) starts on the empty slot', () => {
  const initial = { a: undefined, b: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'medium' }, reconcile: 'a' };
  const { screen, press, type, results } = open({ initial });
  assert.match(screen(), /▸ A {2}builds the plan {2}choose a model below/);
  assert.doesNotMatch(screen(), /▶ Start/);
  type('deepseek');
  press(KEYS.enter, KEYS.enter);
  assert.equal(results[0].confirmed, true);
  assert.equal(results[0].pair.b.id, 'glm-5.3-flash');
});

test('no match says so, and enter on nothing does nothing', () => {
  const { screen, press, type, results } = open();
  type('zzzzzz');
  assert.match(screen(), /No matching models you can run/);
  press(KEYS.enter);
  assert.equal(results.length, 0);
});
