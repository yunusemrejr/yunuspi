import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import path from 'node:path';

const jiti = createJiti(import.meta.dirname);
const ps = await jiti.import('../agent/extensions/lib/presets.ts');
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
  const glued = ps.extractPresetTokens('/goal /3d /anatom,y/noslop /nobug /video make a penguin film');
  assert.deepEqual([glued.presets, glued.goal, glued.task], [['3d', 'anatomy', 'noslop', 'nobug', 'video'], true, 'make a penguin film'], 'glued and comma-garbled tokens are read');
  assert.deepEqual(ps.extractPresetTokens('copy /3d/models and /video/x.mp4').presets, [], 'paths whose pieces are not all tokens stay text');
  const penguin = ps.createBoostedGoal(glued.task.replace('make a penguin film', 'make a video using threejs, about types of penguins. TTS narration elevenlabs. at the end says example.com'), glued.presets);
  for (const said of ['TTS narration elevenlabs.', 'at the end says example.com']) assert.ok(penguin.criteria.some((c) => c.text === said), `a verbless requirement stays a criterion: ${said}`);
  assert.ok(penguin.criteria.some((c) => /^Anatomy: the subject's parts/.test(c.text)), 'anatomy in a film judges the picture, not a kit build');
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

test('file names and paths that start like a preset stay text', () => {
  const found = ps.extractPresetTokens('convert /video.mp4 and /3d.glb, then render /3d. Done /noslop');
  assert.deepEqual(found.presets, ['3d', 'noslop']);
  assert.match(found.task, /\/video\.mp4/);
  assert.match(found.task, /\/3d\.glb/);
});

test('tilde fenced code is text, never boosts', () => {
  const found = ps.extractPresetTokens('run this example:\n~~~\n/3d /video\n~~~\nthen /noslop');
  assert.deepEqual(found.presets, ['noslop']);
  assert.match(found.task, /~~~\n\/3d \/video\n~~~/);
});

test('each boost alone is a short standard; bare boosts survey and may honestly find nothing', () => {
  for (const id of ps.PRESET_IDS) {
    const goal = ps.createPresetChainGoal({ presets: [id], task: 'make a kettle film' });
    assert.ok(goal.text.length < 2500, `${id} brief stays short (${goal.text.length})`);
    assert.equal(goal.criteria.length, 4, `${id}: three fronts and V`);
    assert.deepEqual(goal.boosts, [id]);
  }
  assert.match(ps.createPresetChainGoal({ presets: ['3d'], task: '' }).text, /survey this project for existing 3D[\s\S]*say so in one line/);
  assert.match(ps.createPresetChainGoal({ presets: ['video'], task: 'x' }).text, /skills\/cinetic\/SKILL\.md/);
  for (const id of ['3d', 'video']) assert.doesNotMatch(ps.createPresetChainGoal({ presets: [id], task: 'x' }).text, /desloppify|codebase/i);
  const noslop = ps.createPresetChainGoal({ presets: ['noslop'], task: '  the   settings\npage  ' });
  assert.match(noslop.text, /Focus: the settings page\. Fronts outside it are waived/);
  assert.match(noslop.text, /made-up labels[\s\S]*pill badges[\s\S]*neon, glows/);
  assert.equal(ps.noslopFocus('x'.repeat(600)).length, 500);
});

test('a video chain judges the picture and the file; a code chain keeps the codebase standards', () => {
  const task = 'create a 20 second ad for a cooking site with 3d anatomy and a narrator';
  const film = ps.createBoostedGoal(task, ['3d', 'noslop', 'nobug', 'video', 'anatomy']);
  assert.ok(film.text.length < 6500, `five chained boosts stay short (${film.text.length})`);
  assert.match(film.text, /Noslop on the picture/);
  assert.match(film.text, /Nobug on the output: check the encoded file/);
  assert.doesNotMatch(film.text, /Desloppify:|Baseline first|360px/, 'no codebase audit during a film');
  assert.match(film.text, /Lead guide: cinetic/);
  assert.match(film.text, /never a generated or stock photo with 3D decoration/);
  assert.match(film.text, /the user named is the one to use/, 'explicit tool choices win over the options');
  assert.equal((film.text.match(/Lead guide:/g) ?? []).length, 1, 'one film paragraph');
  assert.match(ps.filmDirective('an exploded view of a camera'), /Lead guide: anatomy-reveal/);
  assert.match(ps.filmDirective('how a gearbox works'), /Lead guide: anatomy \(/);
  const code = ps.createBoostedGoal('clean up the dashboard', ['noslop', 'nobug']);
  assert.match(code.text, /Desloppify:[\s\S]*Debug:/);
  assert.doesNotMatch(code.text, /Film:|on the picture/);
});

test('a boosted goal keeps the user requirements first, budgets the fronts, and ends with V', () => {
  const task = 'Make a film about tides. Keep it under two minutes. Use real footage only.';
  const own = gs.createGoal(task).criteria.filter((c) => c.id !== 'V').map((c) => c.text);
  const front = /^(Noslop|Nobug|3D|Video|Anatomy): /;
  for (const presets of [['3d'], ['3d', 'video'], ['3d', 'video', 'noslop'], ['nobug', 'noslop', '3d', 'video', 'anatomy']]) {
    const goal = ps.createBoostedGoal(task, presets);
    const per = presets.length === 1 ? 3 : presets.length === 2 ? 2 : 1;
    assert.equal(goal.criteria.filter((c) => front.test(c.text)).length, per * presets.length, presets.join('+'));
    assert.ok(goal.criteria.length <= gs.MAX_CRITERIA);
    assert.equal(goal.criteria.at(-1).id, 'V');
    assert.deepEqual(goal.criteria.slice(0, own.length).map((c) => c.text), own);
    assert.equal(goal.text.split('\n\n')[0], task, 'the task opens the text');
  }
});

test('a bare boost joins a live goal: fronts fill free slots before V, and a repeat adds nothing', () => {
  const full = gs.createPresetGoal('own work', Array.from({ length: 10 }, (_, i) => `own item ${i + 1} stays`));
  const joined = ps.addBoosts(full, ['3d']);
  assert.deepEqual([joined.fresh, joined.fronts, joined.goal.criteria.length], [['3d'], 1, 12]);
  assert.match(joined.goal.criteria.at(-2).text, /^3D: /);
  assert.match(joined.goal.text, /^own work\n\nStandards added to this goal — 3D — [\s\S]*\[3D\]\n3D: build the picture/);
  assert.deepEqual(ps.addBoosts(joined.goal, ['3d']).fresh, [], 'a repeat adds nothing');
  const solo = ps.createPresetChainGoal(ps.parsePresetChain('noslop', 'the settings page'));
  assert.deepEqual(ps.addBoosts(solo, ['noslop']).fresh, []);
  assert.deepEqual(ps.addBoosts(solo, ['nobug']).fresh, ['nobug']);
  const pair = ps.createPresetChainGoal(ps.parsePresetChain('3d', 'Make a watch film with brass gears'));
  const film = ps.addBoosts(pair, ['video']).goal;
  assert.ok(film.text.includes(ps.filmDirective('Make a watch film with brass gears')), 'joining video plans the film from the user words');
  const near = ps.addBoosts(gs.createPresetGoal('x'.repeat(19_950), ['one thing']), ['3d']);
  assert.equal(near.clipped, true);
  assert.ok(near.goal.text.length <= gs.MAX_GOAL_TEXT);
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
  return { commands, tools, entries, sent, sentOptions, notes, ctx, pi, hooks };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('/3d /video /noslop <task> starts one goal from a single dispatch; bare boosts join it', async () => {
  const h = harness();
  for (const name of ps.PRESET_IDS) assert.equal(typeof h.commands[name]?.handler, 'function', `${name} registered`);
  await h.commands['3d'].handler('/video /noslop please make a video about tides', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.deepEqual(goal.boosts, ['3d', 'video', 'noslop']);
  assert.match(h.sent[0], /Boosts in force — 3D \+ Video \+ Noslop/);
  assert.deepEqual(h.sentOptions[0], { authored: true, userText: '/3d /video /noslop please make a video about tides', deliverAs: 'followUp' });
  assert.match(h.notes.at(-1).text, /3D \+ Video \+ Noslop boost on/);
  const before = h.entries.length;
  await h.commands.video.handler('', h.ctx); await tick();
  assert.equal(h.entries.length, before, 'a boost already in force persists nothing');
  assert.match(h.notes.at(-1).text, /Video already in force on goal/);
  await h.commands.nobug.handler('/noslop', h.ctx); await tick();
  assert.equal(h.entries.at(-1).data.id, goal.id, 'the goal is joined, not replaced');
  assert.deepEqual(h.entries.at(-1).data.boosts, ['3d', 'video', 'noslop', 'nobug']);
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: '/nobug', deliverAs: 'steer' });
});

test('preset tokens anywhere in /goal make one boosted goal that keeps the user words', async () => {
  const h = harness();
  await h.commands.goal.handler('build a bakery site /noslop', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.deepEqual(goal.boosts, ['noslop']);
  assert.ok(goal.text.startsWith('build a bakery site\n\nBoosts in force'));
  assert.ok(goal.criteria.some((c) => c.text.startsWith('Noslop: ')));
  assert.deepEqual(h.sentOptions.at(-1), { authored: true, userText: 'build a bakery site /noslop', deliverAs: 'followUp' });
  await h.commands['3d'].handler('make a rat scene /video /goal', h.ctx); await tick();
  assert.deepEqual(h.entries.at(-1).data.boosts, ['3d', 'video']);
  const fresh = harness();
  await fresh.commands.goal.handler('/3d', fresh.ctx); await tick();
  assert.match(fresh.entries.at(-1).data.text, /survey this project for existing 3D/);
});

test('/noslop alone starts a desloppify goal whose fronts close through the goal tool', async () => {
  const h = harness();
  await h.commands.noslop.handler('', h.ctx); await tick();
  const goal = h.entries.at(-1).data;
  assert.equal(goal.criteria.length, 4);
  assert.match(h.sent[0], /\[goal-tracked [\s\S]*Desloppify:/);
  assert.deepEqual(h.sentOptions[0], { authored: true, userText: '/noslop', deliverAs: 'followUp' });
  assert.match((await h.tools.goal.execute('id', { action: 'met', id: 'C1', evidence: 'screens compared before and after: 14 elements to 6' }, undefined, undefined, h.ctx)).content[0].text, /Recorded/);
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

test('standard names resolve however they are written, and strangers are reported', () => {
  assert.deepEqual(ps.resolveStandards(['/3D', ' Video ', 'design', 'cinema', 'video', '']), { ids: ['3d', 'video', 'design'], unknown: ['cinema'] });
  assert.deepEqual(ps.STANDARD_IDS.filter((id) => !ps.PRESET_IDS.includes(id)), ['design', 'research', 'browser'], 'standards without a shortcut command');
  const offer = ps.standardsOffer({ boosts: ['video', 'retired-standard'] });
  assert.match(offer, /^Standards \(in force: Video\): before starting, adopt/);
  assert.doesNotMatch(offer, /^- video:/m);
  for (const id of ps.STANDARD_IDS.filter((id) => id !== 'video')) assert.match(offer, new RegExp(`^- ${id}: \\S`, 'm'), id);
  assert.equal(ps.standardsOffer({ boosts: [...ps.STANDARD_IDS] }), '');
  assert.deepEqual(ps.standardTools(['research', 'browser', 'noslop']), ['web_search', 'fetch_content', 'browser_session']);
});

test('a plain /goal offers the standards; the model adopts what its work needs through the goal tool', async () => {
  const h = harness();
  const staged = [];
  h.pi.events = { emit: (name, data) => staged.push({ name, names: data.names }) };
  await h.commands.goal.handler('Make a 20 second launch film for the bakery with a turning 3D loaf', h.ctx); await tick();
  assert.equal(h.entries.at(-1).data.boosts, undefined, 'nothing is assumed from the wording');
  assert.match(h.sent[0], /\[goal-tracked [\s\S]*\n\nStandards: before starting, adopt each one this goal's work calls for with goal\(\{action:"adopt"/);
  assert.match(h.sent[0], /^- video: a finished video or film$/m);
  const run = (params) => h.tools.goal.execute('id', params, undefined, undefined, h.ctx);

  const none = await run({ action: 'adopt', items: ['films'] });
  assert.match(none.content[0].text, /^Not a standard: films\. adopt takes standard names in items: design, noslop, nobug, 3d, video, anatomy, research, browser\.$/);

  const persisted = h.entries.length;
  const adopted = await run({ action: 'adopt', items: ['video', '3D', 'films'] });
  const text = adopted.content[0].text;
  assert.match(text, /^Not a standard: films\.\n\nStandards added to this goal — Video \+ 3D/);
  assert.match(text, /\nFilm: one film whose hero in every shot is the subject built in 3D/);
  assert.match(text, /\[Video\]\nVideo: a finished film/);
  assert.match(text, /\[3D\]\n3D: build the picture/);
  assert.match(text, /\n\nCriteria now:\n- C1: /);
  assert.deepEqual(adopted.details, { adopted: ['video', '3d'], inForce: ['video', '3d'] });
  const goal = h.entries.at(-1).data;
  assert.equal(h.entries.length, persisted + 1);
  assert.deepEqual(goal.boosts, ['video', '3d']);
  assert.ok(goal.criteria.some((c) => c.text.startsWith('Video: ')) && goal.criteria.some((c) => c.text.startsWith('3D: ')));
  assert.equal(goal.criteria.at(-1).id, 'V');
  assert.deepEqual(staged.at(-1), { name: 'adaptive-pipeline-selection', names: ['video_project', 'video_render', 'video_qa', 'narration_tts', 'video_frames', 'media_info', 'blender'] });

  const stagedBefore = staged.length;
  const again = await run({ action: 'adopt', items: ['video'] });
  assert.match(again.content[0].text, /^Already in force:\n\n\[Video\]\nVideo: a finished film/, 'a model that lost the text to compaction can read it again');
  assert.equal(h.entries.length, persisted + 1, 'adopting a standard twice changes nothing');
  assert.equal(staged.length, stagedBefore);

  // The goal anchor names what is in force, and a resumed kickoff offers only what is left.
  assert.match(gs.goalAnchor(goal), /\nStandards in force: video, 3d \(goal adopt with a name returns it again\)\.\n/);
  await h.commands.goal.handler('resume', h.ctx); await tick();
  assert.match(h.sent.at(-1), /\nStandards \(in force: Video, 3D\): /);
  assert.doesNotMatch(h.sent.at(-1), /^- (?:video|3d): /m);
  assert.match(h.sent.at(-1), /^- research: /m);
});

test('work that is plainly a film adopts the video standard when the model did not', async () => {
  const h = harness();
  await h.commands.goal.handler('Tell the bakery story for the launch', h.ctx); await tick();
  const result = (toolName, id) => { for (const hook of h.hooks.get('tool_result')) hook({ toolName, toolCallId: id, input: {}, details: {} }, h.ctx); };
  result('read', 't0');
  assert.equal(h.entries.at(-1).data.boosts, undefined, 'ordinary tools say nothing about the kind of work');
  result('video_project', 't1'); await tick();
  assert.deepEqual(h.entries.at(-1).data.boosts, ['video']);
  assert.match(h.sent.at(-1), /^\[goal g\w+\] Standards added to this goal — Video — [\s\S]*\[Video\]\nVideo: a finished film/);
  assert.deepEqual(h.sentOptions.at(-1), { deliverAs: 'steer' });
  assert.match(h.notes.at(-1).text, /Video standard in force, taken from the work under way/);
  const sent = h.sent.length;
  result('video_render', 't2'); await tick();
  assert.equal(h.sent.length, sent, 'a standard already in force is not sent twice');
  result('blender', 't3'); await tick();
  assert.deepEqual(h.entries.at(-1).data.boosts, ['video', '3d']);
  assert.match(h.sent.at(-1), /\nFilm: one film whose hero/, '3D joining a film brings the film paragraph');
});

test('the old shortcuts still run but are kept out of menus; /goal is the one listed command', () => {
  const h = harness();
  for (const name of ps.PRESET_IDS) {
    assert.equal(h.commands[name].hidden, true, name);
    assert.match(h.commands[name].description, /^Shortcut for \/goal with the /);
  }
  assert.equal(h.commands.goal.hidden, undefined);
  assert.doesNotMatch(h.commands.goal.description, /\/3d|\/video|boost/i);
  assert.doesNotMatch(gs.GOAL_USAGE, /\/3d|\/video|boost/i);
});
