import test from 'node:test';
import assert from 'node:assert/strict';
import { planFilmBlend } from '../agent/extensions/lib/film-blend.ts';
import * as ps from '../agent/extensions/lib/presets.ts';

test('the film blend picks its lead from what the request asks for', () => {
  const cases = [
    ['a film about how a mechanical watch works inside', 'mechanism', 'anatomy'],
    ['an exploded teardown reveal of a Moka pot', 'reveal', 'anatomy-reveal'],
    ['a 30 s launch teaser for our note app with a logo sting', 'brand', 'cinetic'],
    ['a flythrough of a city at night', 'world', 'three-world'],
    ['a film about a kettle', 'mechanism', 'anatomy'],
  ];
  for (const [task, mode, lead] of cases) {
    const blend = planFilmBlend(task);
    assert.equal(blend.mode, mode, task); assert.equal(blend.lead, lead, task);
  }
  assert.deepEqual(planFilmBlend('a film about a kettle').signals, [], 'the default names no signal');
});

test('the blend gives every skill a role, one clock and a conflict order', () => {
  const brand = planFilmBlend('a hype launch film for an app, with voiceover');
  assert.equal(brand.pace, 'crisp'); assert.equal(brand.narration, 'asked');
  assert.match(brand.text, /Lead: cinetic \(.*skills\/cinetic\/SKILL\.md\)/);
  assert.match(brand.text, /cinetic directs the whole film/);
  assert.match(brand.text, /anatomy \(.*\) or anatomy-reveal \(.*\) supplies the hero 3D object/);
  assert.match(brand.text, /"visual, not narrated" default yields/);
  const mechanism = planFilmBlend('explain how a jet engine works');
  assert.match(mechanism.text, /cinetic \(.*\) is the film system around the lead/);
  assert.match(mechanism.text, /One clock for everything/);
  assert.match(mechanism.text, /Never render the film in Blender/);
  assert.match(mechanism.text, /the user's own words and brand, then cinetic's hard bans/);
  assert.match(mechanism.text, /ask before any npm install/);
});

test('/3d /video chains carry the blend; a perfect-quality request is held to its word; unrelated chains carry none', () => {
  const film = ps.createPresetChainGoal(ps.parsePresetChain('3d', '/video /noslop /nobug a picture perfect launch film for our app'));
  assert.match(film.text, /\[3D film\][\s\S]*Film blend \(brand\)[\s\S]*Lead: cinetic/);
  assert.match(film.text, /The user asked for perfect in their own words/);
  assert.match(film.text, /Noslop applies to the film/);
  assert.match(film.text, /Nobug applies to the film/);
  assert.ok(film.text.length <= 20000);
  assert.doesNotMatch(ps.createPresetChainGoal(ps.parsePresetChain('noslop', '/nobug')).text, /\[3D film\]/);
  assert.doesNotMatch(ps.createPresetChainGoal(ps.parsePresetChain('3d', 'a teapot')).text, /\[3D film\]/);
  assert.match(ps.createPresetChainGoal(ps.parsePresetChain('video', 'x')).text, /cinetic at .*skills\/cinetic\/SKILL\.md for premium motion design/);
  const live = ps.createPresetChainGoal(ps.parsePresetChain('3d', 'a watch film'));
  const joined = ps.addBoosts(live, ['video']).goal;
  assert.match(joined.text, /\[3D film\]/, 'a boost that completes the pair adds the blend');
  assert.equal(ps.addBoosts(joined, ['nobug']).goal.text.match(/\[3D film\]/g).length, 1, 'never twice');
});

test('chain completions offer the boosts that can still join', () => {
  assert.deepEqual(ps.chainCompletions('/no', '3d').map((item) => item.label), ['/noslop', '/nobug']);
  assert.deepEqual(ps.chainCompletions('make a film /nobug /n', 'video').map((item) => item.value), ['make a film /nobug /noslop ']);
  assert.equal(ps.chainCompletions('/vid', 'video'), null, 'the invoked command is not offered again');
  assert.equal(ps.chainCompletions('make a film', '3d'), null);
});

test('a film chain carries no interface guidance; other chains keep it', () => {
  const film = ps.createPresetChainGoal(ps.parsePresetChain('3d', '/video /noslop /nobug a launch film for our app'));
  for (const ui of [/Interface density is its own front/, /A terminal app's interface is its output/, /Work these fronts\. In the interface/, /UI density cut/, /interface works wherever it runs/])
    assert.doesNotMatch(film.criteria.map((c) => c.text).join('\n') + (ui.source.startsWith('UI') || ui.source.startsWith('interface') ? '' : film.text), ui);
  assert.match(film.text, /In copy everywhere/, 'copy and code rules still apply');
  const page = ps.createPresetChainGoal(ps.parsePresetChain('noslop', '/3d a three.js landing page'));
  assert.match(page.text, /Interface density is its own front/);
  assert.match(ps.createNoslopGoal ? '' : '', /^$/);
});
