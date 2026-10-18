import test from 'node:test';
import assert from 'node:assert/strict';
import { goalRequestText, mediaFile, mediaWork } from '../agent/extensions/lib/media-work.ts';
import { uiFileCue, uiPromptCue } from '../agent/extensions/lib/ui-doctrine.ts';
import { routeSkills } from '../agent/extensions/lib/skill-routing.ts';

const routes = (prompt) => routeSkills(prompt).map((route) => route.name);
const film = [
  'make a 30 second launch film for my note app with bold typography and a calm color palette',
  'create a motion ad for the brand',
  'make a 20 second intro video for the podcast',
  'make a pixel perfect film about a watch',
  'add kinetic type and transitions to act 2 of the film',
];
const ui = ['redesign the landing page hero', 'add a dark mode toggle to the navbar', 'make the landing page hero video autoplay and fix its typography', 'build a video player component with a calm color palette'];

test('film and render requests get no interface guidance', () => {
  for (const prompt of film) {
    assert.equal(mediaWork(prompt), true, prompt);
    assert.equal(uiPromptCue(prompt).strength, 'none', prompt);
    assert.ok(!routes(prompt).some((name) => name === 'ui-design' || name === 'frontend'), `${prompt}: ${routes(prompt)}`);
  }
});

test('requests that name an interface surface keep it, even with video in them', () => {
  for (const prompt of ui) {
    assert.equal(mediaWork(prompt), false, prompt);
    assert.equal(uiPromptCue(prompt).strength, 'strong', prompt);
    assert.ok(routes(prompt).includes('ui-design'), prompt);
  }
  assert.equal(mediaWork('fix the race condition in the job queue'), false);
});

test('video project files are film frames, not interface files', () => {
  assert.equal(mediaFile('films/launch/src/acts/Act2.tsx'), true);
  assert.equal(mediaFile('src/Scene.tsx', "import {AbsoluteFill} from 'remotion';"), true);
  assert.equal(mediaFile('index.html', '<div data-composition-id="main">'), true);
  assert.equal(uiFileCue('films/launch/src/acts/Act2.tsx', 'export const Act2 = () => null;'), false);
  assert.equal(uiFileCue('public/html/scene.html', '<html><body><canvas></canvas></body></html>'), false);
  assert.equal(uiFileCue('src/components/Hero.tsx', 'export const Hero = () => <div/>;'), true, 'an app component is still interface work');
  assert.equal(mediaFile('src/components/Hero.tsx', 'export const Hero = () => <div/>;'), false);
});

test('goal turns are judged by the user\'s words, not the preset fronts the harness wrote into them', () => {
  // A /3d /video /noslop film goal: Noslop's own front says "UI and visual slop gone", which used to turn
  // every continuation of the film into interface work and hand it UI doctrine.
  const continuation = '[goal g1, continuation 1/6] The goal is not finished: 3 criteria have no evidence yet.\n- C1: make a 1 minute video explaining how a supersonic car works.\n- C5: Noslop: UI and visual slop gone: no fake live/active state in the interface\n- V: Result checked end to end against the real artifact (tests run, app launched).';
  assert.equal(mediaWork(continuation), true);
  assert.equal(uiPromptCue(continuation).strength, 'none');
  const kickoff = '[goal-tracked g1] Goal: make a film /3d /noslop\n\nBoosts in force, in the order written — 3D → Noslop — all applied to this goal. The user wrote: «make a film about rockets /3d /noslop»\n\n[Noslop]\nCut every screen, page and dashboard down.\n\nAcceptance criteria (refine):\n- C1: make a film about rockets\n- C2: Noslop: UI and visual slop gone\n- V: Result checked';
  assert.equal(goalRequestText(kickoff), 'make a film about rockets /3d /noslop\n- C1: make a film about rockets');
  assert.equal(mediaWork(kickoff), true);
  // The user's own interface surface still counts.
  assert.equal(mediaWork('[goal-tracked g2] Goal: redesign the landing page with a hero video\n\nAcceptance criteria x:\n- C1: redesign the landing page with a hero video\n- V: Result checked'), false);
  assert.equal(goalRequestText('make a film'), 'make a film', 'ordinary prompts pass through unchanged');
});
