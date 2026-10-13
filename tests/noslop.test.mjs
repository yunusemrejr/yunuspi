import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import path from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ns = await jiti.import('../agent/extensions/lib/noslop.ts');
const { default: goalExtension } = await jiti.import('../agent/extensions/goal.ts');

test('a bare /noslop goal covers every desloppify front plus verification', () => {
  const goal = ns.createNoslopGoal('');
  assert.equal(goal.status, 'active');
  assert.deepEqual(goal.criteria.map((c) => c.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'V']);
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text), [...ns.NOSLOP_CRITERIA], 'criteria survive verbatim, never clip-truncated');
  assert.ok(goal.criteria.every((c) => c.status === 'open' && c.text.length <= 240));
  assert.match(goal.text, /whole codebase/);
  assert.doesNotMatch(goal.text, /Requested focus/);
});

test('the brief names the slop to remove and the rules for removing it', () => {
  const { text } = ns.createNoslopGoal('');
  for (const front of [/blinking/, /pill/, /gradients/, /monospace/, /emojis/, /SaaS/, /text-noise/, /made-up labels/,
    /meta information and build narration/, /stock phrases/, /comments that narrate/, /Dead code/,
    /Duplicated code and duplicated functionality/, /Subtraction first/, /Real things are not slop/,
    /Preserve product behavior/, /inventory/i]) assert.match(text, front);
});

test('a focus narrows the brief and out-of-focus fronts are waived, not skipped', () => {
  const goal = ns.createNoslopGoal(ns.noslopFocus('  the   settings\npage  '));
  assert.match(goal.text, /Requested focus: the settings page/);
  assert.match(goal.text, /waived with that reason/);
  assert.equal(ns.noslopFocus('x'.repeat(600)).length, 500);
  assert.equal(ns.noslopFocus(''), '');
});

function harness() {
  const commands = {}, tools = {}, entries = [], sent = [], sentOptions = [], notes = [];
  const pi = {
    on: () => {},
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage: async (text, options) => { sent.push(text); sentOptions.push(options); },
  };
  const ctx = { cwd: path.resolve(import.meta.dirname, '..'), ui: { notify: (text, level) => notes.push({ text, level }), setStatus: () => {} }, sessionManager: { getBranch: () => entries }, hasPendingMessages: () => false };
  goalExtension(pi);
  const call = (params) => tools.goal.execute('id', params, undefined, undefined, ctx).then((r) => r.content[0].text);
  return { commands, tools, entries, sent, sentOptions, notes, ctx, call };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('/noslop with no instruction starts a desloppify goal and kicks the session off', async () => {
  const h = harness();
  assert.equal(typeof h.commands.noslop?.handler, 'function');
  assert.match(h.commands.noslop.description, /[Dd]esloppify/);
  await h.commands.noslop.handler('', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.equal(goal.criteria.length, 7);
  assert.match(goal.criteria[1].text, /UI and visual slop gone/);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /\[goal-tracked /);
  assert.match(h.sent[0], /Desloppify this codebase/);
  assert.deepEqual(h.sentOptions[0], { authored: true, userText: '/noslop' });
  assert.match(h.notes.at(-1).text, /\/goal shows progress/);
  // The fronts close through the ordinary goal tool: one shared state owner.
  assert.match(await h.call({ action: 'met', id: 'C1', evidence: 'inventory diff read: 14 items listed per front in notes.md line 3' }), /Recorded/);
});

test('/noslop accepts an instruction and keeps the user words as the authored text', async () => {
  const h = harness();
  await h.commands.goal.handler('Ship the exporter', h.ctx); await tick();
  await h.commands.noslop.handler('focus on src/ui only', h.ctx); await tick();
  assert.match(h.entries.at(-1).data.text, /Requested focus: focus on src\/ui only/, 'noslop replaces the previous goal like /goal does');
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/noslop focus on src/ui only' });
});
