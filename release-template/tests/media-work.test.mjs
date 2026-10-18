import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaFile, mediaWork } from '../agent/extensions/lib/media-work.ts';
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
