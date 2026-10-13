import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import path from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ps = await jiti.import('../agent/extensions/lib/presets.ts');
const ns = await jiti.import('../agent/extensions/lib/noslop.ts');
const { default: goalExtension } = await jiti.import('../agent/extensions/goal.ts');

test('chain grammar peels leading preset tokens in written order and dedupes', () => {
  assert.deepEqual(ps.parsePresetChain('3d', '/video /noslop please make a film about tides'),
    { presets: ['3d', 'video', 'noslop'], task: 'please make a film about tides' });
  assert.deepEqual(ps.parsePresetChain('3d', '/3d /video make x'), { presets: ['3d', 'video'], task: 'make x' });
  assert.deepEqual(ps.parsePresetChain('noslop', '/3d'), { presets: ['noslop', '3d'], task: '' });
  assert.deepEqual(ps.parsePresetChain('video', ''), { presets: ['video'], task: '' });
  assert.deepEqual(ps.parsePresetChain('3d', 'make a minecraft clone'), { presets: ['3d'], task: 'make a minecraft clone' });
  // Unknown slash words are assignment text, not presets; near-misses do not peel.
  assert.deepEqual(ps.parsePresetChain('3d', '/videos of cats'), { presets: ['3d'], task: '/videos of cats' });
  assert.deepEqual(ps.parsePresetChain('3d', '/goal make x'), { presets: ['3d'], task: '/goal make x' });
  assert.equal(ps.presetUserText(['3d', 'video', 'noslop'], 'please make  a\nfilm'), '/3d /video /noslop please make a film');
  assert.equal(ps.presetUserText(['3d'], ''), '/3d');
});

test('/3d with an assignment boosts real 3D craft; bare /3d surveys and may honestly find none', () => {
  const made = ps.createPresetChainGoal(ps.parsePresetChain('3d', 'make a minecraft clone'));
  assert.deepEqual(made.criteria.map((c) => c.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'V']);
  assert.deepEqual(made.criteria.slice(0, -1).map((c) => c.text), [...ps.THREE_D_CRITERIA]);
  for (const front of [/Assignment: make a minecraft clone/, /Blender/, /three\.js/, /references/, /render/i, /frame rate/, /placeholder/])
    assert.match(made.text, front);
  const bare = ps.createPresetChainGoal(ps.parsePresetChain('3d', ''));
  assert.match(bare.text, /Survey the current project for existing 3D work/);
  assert.match(bare.text, /no 3D work at all, say so plainly/);
  assert.match(bare.text, /Do not invent a 3D project/);
});

test('/video demands finished sound and a verified master; bare /video surveys first', () => {
  const made = ps.createPresetChainGoal(ps.parsePresetChain('video', 'make a 60s explainer about tides'));
  assert.deepEqual(made.criteria.slice(0, -1).map((c) => c.text), [...ps.VIDEO_CRITERIA]);
  for (const front of [/Assignment: make a 60s explainer/, /TTS/, /mixed under speech/, /captions/, /video_qa/, /Plan before rendering/])
    assert.match(made.text, front);
  const bare = ps.createPresetChainGoal(ps.parsePresetChain('video', ''));
  assert.match(bare.text, /Survey the current project for existing video work/);
  assert.match(bare.text, /no video work at all, say so plainly/);
});

test('a three-way chain stacks full briefs and tracks only core fronts within budget', () => {
  const goal = ps.createPresetChainGoal(ps.parsePresetChain('3d', '/video /noslop please make a video about tides'));
  assert.equal(goal.criteria.length, 10, 'three core fronts per preset plus V');
  assert.equal(goal.criteria.at(-1).id, 'V');
  const labels = goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]);
  assert.deepEqual(labels, ['3D', '3D', '3D', 'Video', 'Video', 'Video', 'Noslop', 'Noslop', 'Noslop']);
  for (const section of [/Assignment: please make a video about tides/, /Boosts in force — 3D \+ Video \+ Noslop/,
    /\[3D\]/, /\[Video\]/, /\[Noslop\]/, /Desloppify this codebase/, /3D boost in force/, /Video boost in force/])
    assert.match(goal.text, section);
  assert.match(goal.criteria[7].text, /^Noslop: UI density cut/, 'chained noslop tracks screen density as a core front');
  const bareChain = ps.createPresetChainGoal(ps.parsePresetChain('3d', '/noslop'));
  assert.match(bareChain.text, /with no assignment: survey the current project/);
  assert.equal(bareChain.criteria.length, 7);
});

test('solo /noslop through the chain builder is byte-identical to the shipped goal', () => {
  const viaChain = ps.createPresetChainGoal(ps.parsePresetChain('noslop', 'the settings page'), 1700000000000);
  const direct = ns.createNoslopGoal('the settings page', 1700000000000);
  assert.deepEqual(viaChain, direct);
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
  return { commands, entries, sent, sentOptions, notes, ctx };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('/3d /video /noslop <task> starts one stacked goal from a single dispatch', async () => {
  const h = harness();
  for (const name of ['noslop', '3d', 'video']) assert.equal(typeof h.commands[name]?.handler, 'function', `${name} registered`);
  await h.commands['3d'].handler('/video /noslop please make a video about tides', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.equal(goal.criteria.length, 10);
  assert.match(h.sent[0], /Boosts in force — 3D \+ Video \+ Noslop/);
  assert.deepEqual(h.sentOptions[0], { authored: true, userText: '/3d /video /noslop please make a video about tides' });
  assert.match(h.notes.at(-1).text, /3D \+ Video \+ Noslop boost on/);
  await h.commands.video.handler('', h.ctx); await tick();
  assert.match(h.entries.at(-1).data.text, /Survey the current project for existing video work/, 'bare /video replaces the goal like any preset');
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/video' });
});
