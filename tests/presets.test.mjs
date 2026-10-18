import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import path from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ps = await jiti.import('../agent/extensions/lib/presets.ts');
const ns = await jiti.import('../agent/extensions/lib/noslop.ts');
const gs = await jiti.import('../agent/extensions/lib/goal-state.ts');
const fb = await jiti.import('../agent/extensions/lib/film-blend.ts');
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
  assert.equal(goal.criteria.length, 11, 'three core fronts per preset, the 3D film front, then V');
  assert.equal(goal.criteria.at(-1).id, 'V');
  const labels = goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]);
  assert.deepEqual(labels, ['3D', '3D', '3D', 'Video', 'Video', 'Video', 'Noslop', 'Noslop', 'Noslop', '3D film']);
  for (const section of [/Assignment: please make a video about tides/, /Boosts in force — 3D \+ Video \+ Noslop/,
    /\[3D\]/, /\[Video\]/, /\[Noslop\]/, /Desloppify this codebase/, /3D boost in force/, /Video boost in force/])
    assert.match(goal.text, section);
  assert.ok(!goal.criteria.some((c) => /UI density cut|interface works wherever/.test(c.text)), 'a film tracks no interface fronts');
  assert.match(goal.criteria[6].text, /^Noslop: Copy and labels honest/, 'a film chain tracks honest on-screen copy instead');
  const page = ps.createPresetChainGoal(ps.parsePresetChain('3d', '/noslop a three.js landing page hero'));
  assert.ok(page.criteria.some((c) => /^Noslop: UI density cut/.test(c.text)), 'outside a film, chained noslop still tracks screen density');
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
  assert.equal(goal.criteria.length, 11);
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
  assert.equal(goal.criteria.length, 10, 'two per preset, the 3D film front and V, never silently clipped');
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]), ['Nobug', 'Nobug', 'Noslop', 'Noslop', '3D', '3D', 'Video', 'Video', '3D film']);
  assert.match(goal.criteria[1].text, /Broken code and dependencies/, 'in a film chain nobug tracks dependencies, not an interface');
  const app = ps.createPresetChainGoal(ps.parsePresetChain('nobug', '/noslop /3d /anatomy the configurator page'));
  assert.match(app.criteria[1].text, /interface works wherever it runs/, 'outside a film nobug keeps the interface front when compressed');
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
  for (const name of ['anatomy', 'anatomy-reveal']) {
    const guide = path.resolve(import.meta.dirname, '../agent/skills', name, 'SKILL.md');
    assert.ok(made.text.includes(`${name} at ${guide}`), `the brief names the installed ${name} guide`);
  }
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
  assert.equal(goal.criteria.length, 12);
  assert.deepEqual(goal.criteria.slice(0, -1).map((c) => c.text.split(':')[0]),
    ['Anatomy', 'Anatomy', '3D', '3D', 'Video', 'Video', 'Noslop', 'Noslop', 'Nobug', 'Nobug', '3D film']);
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
  const commands = {}, tools = {}, entries = [], sent = [], sentOptions = [], notes = [], hooks = new Map();
  const pi = {
    on: (event, handler) => { if (!hooks.has(event)) hooks.set(event, []); hooks.get(event).push(handler); },
    registerCommand: (name, options) => { commands[name] = options; },
    registerTool: (tool) => { tools[tool.name] = tool; },
    appendEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage: async (text, options) => { sent.push(text); sentOptions.push(options); },
  };
  const ctx = { cwd: path.resolve(import.meta.dirname, '..'), ui: { notify: (text, level) => notes.push({ text, level }), setStatus: () => {} }, sessionManager: { getBranch: () => entries }, hasPendingMessages: () => false };
  goalExtension(pi);
  return { commands, entries, sent, sentOptions, notes, ctx, pi, hooks };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('/3d /video /noslop <task> starts one stacked goal from a single dispatch', async () => {
  const h = harness();
  for (const name of ['noslop', 'nobug', '3d', 'video', 'anatomy']) assert.equal(typeof h.commands[name]?.handler, 'function', `${name} registered`);
  await h.commands['3d'].handler('/video /noslop please make a video about tides', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.equal(goal.criteria.length, 11);
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
  assert.deepEqual(crowded.criteria.slice(0, 6).map((c) => c.text), listed.slice(0, 6), 'own requirements come first and take the slots left');
  assert.match(crowded.criteria.at(-2).text, /^3D film: /, 'the 3D film front keeps its reserved slot');
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


test('long assignments keep every chained brief inside the 20k goal cap', () => {
  const cases = [
    [['3d', 'video', 'noslop'], 4000],
    [['anatomy', '3d', 'video', 'noslop'], 2000],
    [['anatomy', '3d', 'video', 'noslop', 'nobug'], 4000],
  ];
  for (const [presets, size] of cases) {
    const goal = ps.createPresetChainGoal({ presets, task: 'x'.repeat(size) });
    assert.ok(goal.text.length <= gs.MAX_GOAL_TEXT, `${presets.join('+')} stays inside the cap`);
    for (const id of presets) assert.ok(goal.text.includes(`[${ps.PRESET_LABELS[id]}]`), `${id} brief present for a ${size}-char assignment`);
    assert.ok(goal.criteria.length <= 12);
  }
  const five = ps.createPresetChainGoal({ presets: ['anatomy', '3d', 'video', 'noslop', 'nobug'], task: 'make a watch film about brass gears' });
  assert.match(five.text, /\[Nobug\]\n/);
  assert.ok(!five.text.endsWith('…'), 'a complete brief ends the text, never a half-cut one');
});

test('/goal + boosts keeps every brief and the film blend for a long paste', () => {
  const task = 'x'.repeat(4000);
  const literal = `/goal /3d /video ${'y'.repeat(100_000)}`;
  const goal = ps.createBoostedGoal(task, ['3d', 'video', 'noslop', 'nobug', 'anatomy'], literal);
  assert.ok(goal.text.length <= gs.MAX_GOAL_TEXT);
  for (const label of ['3D', 'Video', 'Noslop', 'Nobug', 'Anatomy', '3D film']) assert.ok(goal.text.includes(`[${label}]`), `${label} section present`);
  assert.ok(goal.text.startsWith(task.slice(0, 200)), 'the assignment still opens the goal text');
  assert.ok(!goal.text.includes('y'.repeat(500)), 'the quoted invocation is bounded, not pasted wholesale');
});

test('a bare boost on a live preset goal quotes the user assignment, not the earlier brief', () => {
  const pair = ps.createPresetChainGoal(ps.parsePresetChain('3d', 'Make a watch film with brass gears'));
  const joined = ps.addBoosts(pair, ['video']);
  assert.deepEqual(joined.fresh, ['video']);
  assert.match(joined.goal.text, /\[Video\]\nVideo boost in force[\s\S]*?Assignment: Make a watch film with brass gears/);
  assert.ok(!joined.goal.text.includes('Assignment: 3D boost in force'), 'the old brief is not quoted as the assignment');
  assert.ok(!joined.goal.text.includes('Assignment: Assignment:'), 'no nested assignment labels');
});

test('joining the film pair live plans the same film as the chain typed once', () => {
  for (const task of ['a flythrough of a city at night', 'a film about a kettle', '']) {
    const expected = fb.planFilmBlend(task).text;
    const oneShot = ps.createPresetChainGoal(ps.parsePresetChain('3d', `/video ${task}`.trim()));
    assert.ok(oneShot.text.includes(expected), `one-shot ${JSON.stringify(task)} carries the planned blend`);
    const pair = ps.createPresetChainGoal(ps.parsePresetChain('3d', task));
    const joined = ps.addBoosts(pair, ['video']).goal;
    assert.ok(joined.text.includes(expected), `live join ${JSON.stringify(task)} plans the same blend, not a brief-scanned one`);
  }
});

test('a boost whose brief cannot fit the goal cap is reported as clipped', () => {
  const near = gs.createPresetGoal('x'.repeat(19_950), ['one thing']);
  const joined = ps.addBoosts(near, ['3d']);
  assert.deepEqual(joined.fresh, ['3d']);
  assert.equal(joined.clipped, true, 'the owner must know the appended brief was cut');
  assert.ok(joined.goal.text.length <= gs.MAX_GOAL_TEXT);
  const plenty = ps.addBoosts(gs.createPresetGoal('short goal', ['one thing']), ['3d']);
  assert.equal(plenty.clipped, false, 'a normal join is not reported as clipped');
});

test('tilde fenced code is text, never boosts', () => {
  const found = ps.extractPresetTokens('run this example:\n~~~\n/3d /video\n~~~\nthen /noslop');
  assert.deepEqual(found.presets, ['noslop']);
  assert.match(found.task, /~~~\n\/3d \/video\n~~~/);
});

test('a preset command routes /goal resume and retry with a note to the live goal', async () => {
  const h = harness();
  await h.commands.goal.handler('Ship the bakery site', h.ctx); await tick();
  const id = h.entries.at(-1).data.id;
  await h.commands['3d'].handler('resume keep going', h.ctx); await tick();
  assert.equal(h.entries.at(-1).data.id, id, 'the live goal is resumed, not replaced');
  assert.equal(h.entries.at(-1).data.status, 'active');
  assert.match(h.sent.at(-1), /The user's note on resuming: keep going/);
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: 'keep going', deliverAs: 'followUp' });
  await h.commands.video.handler('retry try the staging host', h.ctx); await tick();
  assert.equal(h.entries.at(-1).data.id, id);
  assert.match(h.sent.at(-1), /try the staging host/);
});

test('a near-cap live goal reports the clipped boost instead of claiming the full brief', async () => {
  const h = harness();
  await h.commands.goal.handler('x'.repeat(19_950), h.ctx); await tick();
  await h.commands['3d'].handler('', h.ctx); await tick();
  assert.match(h.notes.at(-1).text, /character cap, so this brief was clipped/);
});


test('a failed goal-state append warns and is retried at the next turn boundary', async () => {
  const h = harness();
  await h.commands.goal.handler('Ship the exporter', h.ctx); await tick();
  const id = h.entries.at(-1).data.id;
  const append = h.pi.appendEntry;
  let failed = false;
  h.pi.appendEntry = (type, data) => {
    if (type === 'goal-state-v1' && !failed) { failed = true; throw Error('ENOSPC: no space left on device'); }
    return append(type, data);
  };
  await h.commands.goal.handler('clear', h.ctx); await tick();
  const warning = h.notes.find((note) => /Goal state could not be saved/.test(note.text));
  assert.ok(warning, JSON.stringify(h.notes));
  assert.match(warning.text, /will not survive a restart/);
  assert.equal(warning.level, 'warning');
  // Disk state still says active: the failed append was rolled back by the manager.
  assert.equal(h.entries.at(-1).data.id, id);
  assert.notEqual(h.entries.at(-1).data.status, 'cleared');
  // The next turn boundary retries the same snapshot, so a restart sees `cleared`.
  for (const handler of h.hooks.get('before_agent_start') ?? []) await handler({ type: 'before_agent_start' }, h.ctx);
  assert.equal(h.entries.at(-1).data.status, 'cleared');
});
