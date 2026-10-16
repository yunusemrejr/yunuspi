import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import path from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ps = await jiti.import('../agent/extensions/lib/presets.ts');
const ns = await jiti.import('../agent/extensions/lib/noslop.ts');
const gs = await jiti.import('../agent/extensions/lib/goal-state.ts');
const { default: goalExtension } = await jiti.import('../agent/extensions/goal.ts');

test('chain grammar takes preset tokens in written order and dedupes', () => {
  assert.deepEqual(ps.parsePresetChain('3d', '/video /noslop please make a film about tides'),
    { presets: ['3d', 'video', 'noslop'], task: 'please make a film about tides' });
  assert.deepEqual(ps.parsePresetChain('3d', '/3d /video make x'), { presets: ['3d', 'video'], task: 'make x' });
  assert.deepEqual(ps.parsePresetChain('noslop', '/3d'), { presets: ['noslop', '3d'], task: '' });
  assert.deepEqual(ps.parsePresetChain('video', ''), { presets: ['video'], task: '' });
  assert.deepEqual(ps.parsePresetChain('3d', 'make a minecraft clone'), { presets: ['3d'], task: 'make a minecraft clone' });
  // Unknown slash words are assignment text, not presets; near-misses do not peel.
  assert.deepEqual(ps.parsePresetChain('3d', '/videos of cats'), { presets: ['3d'], task: '/videos of cats' });
  // /goal is a token now (it asks for a goal), so it leaves the assignment instead of staying as text.
  assert.deepEqual(ps.parsePresetChain('3d', '/goal make x'), { presets: ['3d'], task: 'make x' });
  assert.deepEqual(ps.parsePresetChain('noslop', '/nobug'), { presets: ['noslop', 'nobug'], task: '' });
  assert.deepEqual(ps.parsePresetChain('nobug', '/nobugs here'), { presets: ['nobug'], task: '/nobugs here' });
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

test('/nobug hunts every bug front, proves each fix, and never masks; bare /nobug covers the whole codebase', () => {
  const bare = ps.createPresetChainGoal(ps.parsePresetChain('nobug', ''));
  assert.deepEqual(bare.criteria.map((c) => c.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'V']);
  assert.deepEqual(bare.criteria.slice(0, -1).map((c) => c.text), [...ps.NOBUG_CRITERIA], 'criteria survive verbatim');
  assert.ok(ps.NOBUG_CRITERIA.every((c) => c.length <= 240));
  assert.match(bare.text, /whole codebase/);
  for (const front of [/off-by-one/, /Edge cases/, /Broken code/, /Dependencies/, /lockfile drift/, /DRY violation is a bug when the copies can diverge/,
    /360px phone/, /Chromium, Firefox and WebKit/, /name any you could not run/, /non-TTY/, /NO_COLOR/, /Reproduce before fixing/,
    /Never mask a bug/, /reported as suspected/, /Baseline before hunting/])
    assert.match(bare.text, front);
  const focused = ps.createPresetChainGoal(ps.parsePresetChain('nobug', 'the checkout flow'));
  assert.match(focused.text, /Assignment: the checkout flow/);
  assert.match(focused.text, /waived with that reason/);
});

test('/nobug /3d /video checks the media pipeline and output for bugs and weird looks', () => {
  const chain = ps.parsePresetChain('nobug', '/3d /video make sure video has no problem');
  assert.deepEqual(chain, { presets: ['nobug', '3d', 'video'], task: 'make sure video has no problem' });
  const goal = ps.createPresetChainGoal(chain);
  assert.equal(goal.criteria.length, 10);
  for (const section of [/Boosts in force — Nobug \+ 3D \+ Video/, /\[Nobug\]/, /including work from chained boosts/,
    /audio\/picture sync, dropped or duplicated frames/, /z-fighting, inverted normals/, /weird or low-quality looks as bugs/])
    assert.match(goal.text, section);
});

test('/noslop /nobug on a terminal app reads the TUI output as its interface', () => {
  const goal = ps.createPresetChainGoal(ps.parsePresetChain('noslop', '/nobug'));
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]), ['Noslop', 'Noslop', 'Noslop', 'Nobug', 'Nobug', 'Nobug']);
  for (const rule of [/terminal app's interface is its output/, /colors that decorate instead of signal/, /quiet by default/,
    /narrow and resized terminals/, /Ctrl-C and cleanup/])
    assert.match(goal.text, rule);
});

test('a four-way chain keeps two core fronts per preset inside the criteria budget', () => {
  const goal = ps.createPresetChainGoal(ps.parsePresetChain('nobug', '/noslop /3d /video make a film'));
  assert.equal(goal.criteria.length, 9, 'two per preset plus V, never silently clipped');
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]), ['Nobug', 'Nobug', 'Noslop', 'Noslop', '3D', '3D', 'Video', 'Video']);
  assert.match(goal.criteria[1].text, /interface works wherever it runs/, 'nobug keeps the interface front over dependencies when compressed');
});

test('/anatomy covers both anatomy skills, chains with /3d and /video, and bare /anatomy surveys honestly', () => {
  assert.deepEqual(ps.parsePresetChain('anatomy', '/3d /video a 10 s reveal of a moka pot'),
    { presets: ['anatomy', '3d', 'video'], task: 'a 10 s reveal of a moka pot' });
  // Skill commands and file names are text, not boosts.
  for (const text of ['/skill:anatomy explain a dial', 'see /anatomy-reveal/SKILL.md', 'open src/anatomy/figure.mjs'])
    assert.deepEqual(ps.extractPresetTokens(text).presets, [], text);
  const made = ps.createPresetChainGoal(ps.parsePresetChain('anatomy', 'an exploded view of a mechanical keyboard'));
  assert.deepEqual(made.boosts, ['anatomy']);
  assert.equal(made.criteria.length, 6, 'five anatomy fronts plus V');
  assert.ok(made.criteria.every((c) => !c.text.endsWith('…')), 'no front is clipped');
  for (const rule of [/Assignment: an exploded view of a mechanical keyboard/, /anatomy explains how a system/, /anatomy-reveal shows off one physical object/,
    /scripts\/new-project\.mjs/, /references\/3d\.md/, /scan-apart/, /extract frames from the encoded MP4/, /silent by design: when \/video is also in force/])
    assert.match(made.text, rule);
  const bare = ps.createPresetChainGoal(ps.parsePresetChain('anatomy', ''));
  assert.match(bare.text, /No assignment was given\. Survey the current project for existing anatomy work/);
  assert.match(bare.text, /Do not invent a figure nobody asked for/);
  const film = ps.createPresetChainGoal(ps.parsePresetChain('video', '/anatomy reveal film of a kettle'));
  assert.match(film.text, /\[Video\]\nVideo boost in force[\s\S]*anatomy-reveal for a product reveal/);
  assert.match(film.text, /\[Anatomy\]\nAnatomy boost in force/);
  assert.match(ps.createPresetChainGoal(ps.parsePresetChain('3d', 'x')).text, /anatomy-reveal for one object built part by part/);
});

test('a five-way chain keeps two core fronts per preset inside the criteria budget', () => {
  const goal = ps.createPresetChainGoal(ps.parsePresetChain('anatomy', '/3d /video /noslop /nobug make a reveal film'));
  assert.equal(goal.criteria.length, 11);
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]),
    ['Anatomy', 'Anatomy', '3D', '3D', 'Video', 'Video', 'Noslop', 'Noslop', 'Nobug', 'Nobug']);
  assert.match(goal.criteria[1].text, /One truthful model/);
  const boosted = ps.createBoostedGoal('Make a reveal film of a kettle.', ['anatomy', '3d', 'video', 'noslop', 'nobug'], 'lit');
  assert.ok(boosted.criteria.length <= 12);
  assert.equal(boosted.criteria.filter((c) => /^(Anatomy|3D|Video|Noslop|Nobug): /.test(c.text)).length, 5);
  assert.match(boosted.criteria.find((c) => c.text.startsWith('Anatomy: ')).text, /One truthful model/);
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
  for (const name of ['noslop', 'nobug', '3d', 'video', 'anatomy']) assert.equal(typeof h.commands[name]?.handler, 'function', `${name} registered`);
  await h.commands['3d'].handler('/video /noslop please make a video about tides', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.equal(goal.criteria.length, 10);
  assert.match(h.sent[0], /Boosts in force — 3D \+ Video \+ Noslop/);
  assert.deepEqual(h.sentOptions[0], { authored: true, userText: '/3d /video /noslop please make a video about tides', deliverAs: 'followUp' });
  assert.match(h.notes.at(-1).text, /3D \+ Video \+ Noslop boost on/);
  // A bare boost on a live goal joins it; one the goal already carries adds nothing.
  const entriesBefore = h.entries.length, sentBefore = h.sent.length;
  await h.commands.video.handler('', h.ctx); await tick();
  assert.equal(h.entries.length, entriesBefore, 'bare /video on a goal that already carries video persists nothing');
  assert.equal(h.sent.length, sentBefore, 'and sends nothing');
  assert.match(h.notes.at(-1).text, /Video already in force on goal/);
  await h.commands.nobug.handler('/noslop', h.ctx); await tick();
  assert.equal(h.entries.at(-1).data.id, goal.id, 'the goal is joined, not replaced');
  assert.deepEqual(h.entries.at(-1).data.boosts, ['3d', 'video', 'noslop', 'nobug']);
  assert.match(h.sent.at(-1), /Boosts added to this goal — Nobug/);
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/nobug', deliverAs: 'steer' });
});

test('preset tokens count anywhere in text, in written order, and never inside paths or code', () => {
  assert.deepEqual(ps.extractPresetTokens('build a site /noslop'),
    { presets: ['noslop'], goal: false, task: 'build a site', literal: 'build a site /noslop' });
  const middle = ps.extractPresetTokens('make a rat scene /3d then a trailer /video and clean it');
  assert.deepEqual([middle.presets, middle.task], [['3d', 'video'], 'make a rat scene then a trailer and clean it']);
  const mixed = ps.extractPresetTokens('/video a teaser /goal /3d');
  assert.deepEqual([mixed.presets, mixed.goal, mixed.task], [['video', '3d'], true, 'a teaser']);
  assert.deepEqual(ps.extractPresetTokens('/noslop make X /goal'), { presets: ['noslop'], goal: true, task: 'make X', literal: '/noslop make X /goal' });
  assert.deepEqual(ps.extractPresetTokens('/video cut it with /noslop and /3d /VIDEO').presets, ['video', 'noslop', '3d']);
  assert.deepEqual(ps.extractPresetTokens('/noslop /3d /NOSLOP make x').presets, ['noslop', '3d']);
  assert.deepEqual(ps.extractPresetTokens('/videos of cats /3d').presets, ['3d']);
  for (const text of ['fix src/3d/model.ts and /video/x', 'open http://x/video now', 'foo/noslop bar', 'use src/3d/model.glb', '/3d/models', 'a/3d.']) {
    const found = ps.extractPresetTokens(text);
    assert.deepEqual([found.presets, found.goal, found.task], [[], false, text], text);
  }
  assert.deepEqual(ps.extractPresetTokens('use `/3d` and /video here'),
    { presets: ['video'], goal: false, task: 'use `/3d` and here', literal: 'use `/3d` and /video here' });
  assert.deepEqual(ps.extractPresetTokens('run `/noslop` only').presets, []);
  const fenced = ps.extractPresetTokens('build it\n```\n/3d /video\n```\nthen /noslop');
  assert.deepEqual([fenced.presets, fenced.task], [['noslop'], 'build it\n```\n/3d /video\n```']);
  assert.equal(ps.extractPresetTokens('make\n  a  site /noslop').literal, 'make a site /noslop');
});

test('connector words a removed token strands at an edge go; mid-text ones stay', () => {
  const task = (text) => ps.extractPresetTokens(text).task;
  assert.equal(task('/3d and make X'), 'make X');
  assert.equal(task('make a site, /noslop'), 'make a site');
  assert.equal(task('make a site with /video, /noslop'), 'make a site');
  assert.equal(task('build x; then /3d'), 'build x');
  assert.equal(task('/goal build a site /noslop'), 'build a site');
  assert.equal(task('C++ build /noslop'), 'C++ build', 'a + inside a word is not a connector');
  assert.equal(task('make it and /noslop more'), 'make it and more');
  assert.equal(task('with a dragon /3d'), 'with a dragon', 'a connector no token stranded stays');
  assert.equal(task('with /3d a dragon'), 'a dragon', 'a connector a token stranded at the start goes');
  assert.equal(task('no tokens here, and  nothing  changes'), 'no tokens here, and  nothing  changes');
});

test('a boosted goal keeps the user requirements first, budgets the fronts, and ends with V', () => {
  const task = 'Make a film about tides. Keep it under two minutes. Use real footage only.';
  const own = gs.createGoal(task).criteria.filter((c) => c.id !== 'V').map((c) => c.text);
  const bullets = Array.from({ length: 9 }, (_, i) => `- requirement number ${i + 1} stays`).join('\n');
  const listed = gs.createGoal(`Build the thing.\n${bullets}`).criteria.filter((c) => c.id !== 'V').map((c) => c.text);
  const front = /^(Noslop|Nobug|3D|Video): /;
  for (const presets of [['3d'], ['3d', 'video'], ['3d', 'video', 'noslop'], ['nobug', 'noslop', '3d', 'video']]) {
    const goal = ps.createBoostedGoal(task, presets, `${presets.map((id) => `/${id}`).join(' ')} ${task}`);
    const perPreset = presets.length === 1 ? 3 : presets.length === 2 ? 2 : 1;
    assert.equal(goal.criteria.filter((c) => front.test(c.text)).length, perPreset * presets.length, `${presets.join('+')} fronts`);
    assert.ok(goal.criteria.length <= 12, `${presets.join('+')} within budget`);
    assert.equal(goal.criteria.at(-1).id, 'V');
    const first = goal.criteria.findIndex((c) => front.test(c.text));
    assert.ok(first >= 1, 'the user requirement leads');
    assert.deepEqual(goal.criteria.slice(0, first).map((c) => c.text), own.slice(0, first));
    assert.deepEqual(goal.boosts, presets);
    assert.equal(goal.text.split('\n\n')[0], task, 'the task opens the text');
    assert.match(goal.text, /The user wrote: «/);
  }
  const crowded = ps.createBoostedGoal(`Build the thing.\n${bullets}`, ['nobug', 'noslop', '3d', 'video'], 'lit');
  assert.equal(crowded.criteria.length, 12);
  assert.deepEqual(crowded.criteria.slice(0, 7).map((c) => c.text), listed.slice(0, 7), 'own requirements come first and take the slots left');
});

test('a bare boost joins a live goal: fronts fill free slots before V, and a repeat adds nothing', () => {
  const full = gs.createPresetGoal('own work', Array.from({ length: 10 }, (_, i) => `own item ${i + 1} stays`));
  const joined = ps.addBoosts(full, ['3d']);
  assert.deepEqual(joined.fresh, ['3d']);
  assert.equal(joined.fronts, 1, 'only one slot was free');
  assert.equal(joined.goal.criteria.length, 12);
  assert.equal(joined.goal.criteria.at(-1).id, 'V');
  assert.match(joined.goal.criteria.at(-2).text, /^3D: /);
  assert.deepEqual(joined.goal.criteria.slice(0, 10).map((c) => c.text), full.criteria.slice(0, 10).map((c) => c.text));
  assert.match(joined.goal.text, /^own work\n\nBoosts added to this goal — 3D — /);
  assert.match(joined.goal.text, /\[3D\]\n3D boost in force/);
  assert.deepEqual(ps.addBoosts(joined.goal, ['3d']).fresh, [], 'a repeat adds nothing');
  const solo = ps.createPresetChainGoal(ps.parsePresetChain('noslop', 'the settings page'));
  assert.deepEqual(ps.addBoosts(solo, ['noslop']).fresh, [], 'a solo /noslop goal already carries its fronts');
  assert.deepEqual(ps.addBoosts(solo, ['nobug']).fresh, ['nobug']);
  const roomy = ps.addBoosts(gs.createPresetGoal('roomy', ['one thing']), ['3d', 'video']);
  assert.deepEqual([roomy.fresh, roomy.fronts, roomy.goal.boosts], [['3d', 'video'], 4, ['3d', 'video']]);
});

test('preset tokens anywhere in /goal make one boosted goal; a preset inside /goal keeps the user words', async () => {
  const h = harness();
  await h.commands.goal.handler('build a bakery site /noslop', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.deepEqual(goal.boosts, ['noslop']);
  assert.ok(goal.text.startsWith('build a bakery site\n\nBoosts in force'));
  assert.match(goal.text, /The user wrote: «build a bakery site \/noslop»/);
  assert.ok(goal.criteria.some((c) => c.text.startsWith('Noslop: ')));
  assert.equal(goal.criteria.at(-1).id, 'V');
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: 'build a bakery site /noslop', deliverAs: 'followUp' });
  assert.match(h.notes.at(-1).text, /^Goal g\w+ with Noslop boosts — \d+ criteria/);
  await h.commands['3d'].handler('make a rat scene /video /goal', h.ctx); await tick();
  const chained = h.entries.at(-1).data;
  assert.deepEqual(chained.boosts, ['3d', 'video']);
  assert.ok(chained.text.startsWith('make a rat scene\n\n'));
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/3d make a rat scene /video /goal', deliverAs: 'followUp' });
  await h.commands.noslop.handler('make X /goal', h.ctx); await tick();
  assert.deepEqual(h.entries.at(-1).data.boosts, ['noslop']);
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/noslop make X /goal', deliverAs: 'followUp' });
});

test('a bare boost on a live goal joins it; with no live goal /goal /3d is the bare preset', async () => {
  const h = harness();
  await h.commands.goal.handler('Ship the bakery site', h.ctx); await tick();
  const plain = h.entries.at(-1).data;
  await h.commands['3d'].handler('', h.ctx); await tick();
  const joined = h.entries.at(-1).data;
  assert.equal(joined.id, plain.id, 'the same goal joins; it is not replaced');
  assert.ok(joined.text.startsWith('Ship the bakery site\n\nBoosts added to this goal — 3D'));
  assert.equal(joined.criteria.length, Math.min(12, plain.criteria.length + 3));
  assert.equal(joined.criteria.at(-1).id, 'V');
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/3d', deliverAs: 'steer' });
  assert.match(h.sent.at(-1), /Boosts added to this goal — 3D/);
  assert.match(h.notes.at(-1).text, /^3D boost added to goal g\w+/);
  const count = h.entries.length;
  await h.commands['3d'].handler('', h.ctx); await tick();
  assert.equal(h.entries.length, count, 'a repeat persists nothing');
  assert.match(h.notes.at(-1).text, /3D already in force on goal g\w+/);
  await h.commands['3d'].handler('status', h.ctx);
  assert.match(h.notes.at(-1).text, /^Goal g\w+ \[active\]/, 'status still reads the live goal');
  const fresh = harness();
  await fresh.commands.goal.handler('/3d', fresh.ctx); await tick();
  assert.match(fresh.entries.at(-1).data.text, /Survey the current project for existing 3D work/);
  assert.deepEqual(fresh.entries.at(-1).data.boosts, ['3d']);
});

test('file names and paths that start like a preset stay text', () => {
  const found = ps.extractPresetTokens('convert /video.mp4 and /3d.glb, then render /3d. Done /noslop');
  assert.deepEqual(found.presets, ['3d', 'noslop']);
  assert.match(found.task, /\/video\.mp4/);
  assert.match(found.task, /\/3d\.glb/);
});
