import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DELEGATED_NOTES, GUIDE_ROUTES, MAX_USER_NOTES_CHARS, WORKING_NOTES, guideIndex, loadWorkingNotes, resetWorkingNotesCache,
} from '../core/coding-agent/src/core/working-notes.js';
import { buildSystemPrompt } from '../core/coding-agent/src/core/system-prompt.js';

const agentDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-notes-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); resetWorkingNotesCache(); });
  resetWorkingNotesCache();
  return dir;
};
const installGuide = (dir, name) => {
  fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
};

test('the built-in notes cover every area a session needs judgment in', () => {
  for (const heading of ['Where you are', 'Understand the request', 'Working as a team', 'Craft', 'Explaining', 'Nothing leaks', 'Visual work',
    'Numbers and logic', 'Code and shipping', 'Acting for the user', 'Reporting']) {
    assert.match(WORKING_NOTES, new RegExp(`^${heading}`, 'm'), heading);
  }
  // The notes ride in every request, so their size is a budget, not an accident.
  assert.ok(WORKING_NOTES.length < 22_000, `notes are ${WORKING_NOTES.length} chars`);
  for (const notes of [WORKING_NOTES, DELEGATED_NOTES]) {
    assert.match(notes, /Be quick and pragmatic\. Time, tokens and quality all matter/);
  }
  // Time is part of the result: independent pieces launch in one call and the dependent chain is shortened first.
  assert.match(WORKING_NOTES, /Time is part of the result\. Before a job with several pieces, lay out which are independent, which need another piece's result and which touch the same file, then launch the independent ones in one call\./);
  assert.match(WORKING_NOTES, /The longest chain of pieces that depend on each other sets the finish time: shorten it first\./);
  assert.match(WORKING_NOTES, /Never queue pieces behind one subagent or one file when they could be built in files of their own and joined once\./);
  // A desktop-only tool is checked at the widths its users have.
  assert.ok(WORKING_NOTES.includes('A tool that only ever runs on a known desktop machine (a plant, lab or admin console) is built and checked at the widths its users have.'));
  assert.ok(WORKING_NOTES.includes('a rendered page at phone and desktop width (desktop only for a desktop-only tool)'));
});

test('a big improvement is the boldest scale and is worked with the bold guide', () => {
  // Scale: big improvement joins redesign and a build from scratch; parts are judged on merit; a good design the user likes stays.
  assert.match(WORKING_NOTES, /"improve" or "better design" brings gains seen at once and may change colours; "big improvement", "completely" or "tremendously improve", "redesign", "amazing" and a UI built from scratch are the boldest scale/);
  assert.match(WORKING_NOTES, /the default is big, good, bold changes, and layout, structure and flow may change/);
  assert.match(WORKING_NOTES, /improve what is good, redesign what is weak, keep nothing only because it is there; the name, the logo and what the product says stay/);
  assert.match(WORKING_NOTES, /A good design the user is happy with stays when no big change was asked for\./);
  assert.doesNotMatch(WORKING_NOTES, /"redesign" may change layout and flow;/);
  // The way to work: the guide, a wide study of examples, three.js and friends, one idea, two iterations.
  assert.match(WORKING_NOTES, /the safe, familiar page is the failure\. Read bold-redesign\.md in the ui-design guide's references first/);
  assert.match(WORKING_NOTES, /a dozen or more examples skimmed from at least four kinds of source and the best four to six opened in full in the browser, past the first and most familiar ones; reading an index is not looking/);
  assert.match(WORKING_NOTES, /three\.js and 3D, scroll motion, a shader, kinetic type, a tactile part/);
  assert.match(WORKING_NOTES, /commit to one strong idea that suits the brand/);
  assert.match(WORKING_NOTES, /Iterate on the screenshot at least twice: what looks nice at first is usually the median/);
  // Current AI-slop patterns are searched for and avoided, including the three the owner named.
  assert.match(WORKING_NOTES, /Search the web for the current AI-slop design patterns and avoid them/);
  assert.match(WORKING_NOTES, /blinking or glowing dots, a button with a thick darker bottom edge or a bold curved accent under it, common pastels with the usual "aesthetic" fonts/);
  // Dashboards and daily tools keep a stable layout.
  assert.match(WORKING_NOTES, /A tool people work in daily keeps a stable layout: there the boldness goes into craft, colour, type and states/);
  // A delegated task gets the short form.
  assert.match(DELEGATED_NOTES, /safe, familiar page is the failure: judge what exists part by part .* at least three live examples from different sources, commit to one strong idea .* at least twice\. A good design the user is happy with stays/);
});

test('a session with no personal notes gets the built-in ones', t => {
  assert.equal(loadWorkingNotes(agentDir(t), {}), WORKING_NOTES);
  assert.match(WORKING_NOTES, /use read or read_symbol on the current target/);
  assert.match(WORKING_NOTES, /scoped approval with the exact action and destination/);
});

test('the guide index lists only guides that are installed', t => {
  const dir = agentDir(t);
  installGuide(dir, 'ui-design');
  installGuide(dir, 'research');
  installGuide(dir, 'build');
  installGuide(dir, 'operate');
  const text = loadWorkingNotes(dir, {});
  const index = text.slice(WORKING_NOTES.length);
  assert.match(index, /ui-design/);
  assert.match(index, /research/);
  assert.match(index, /shared checkout handoff: build/);
  assert.match(index, /cost and routing comparison: operate/);
  assert.match(index, /open that on a second call and adapt it/);
  assert.doesNotMatch(index, /cinetic|anatomy|browser/);
  assert.ok(index.includes(`${dir.replace(/\\/g, '/')}/skills/<name>/SKILL.md`), 'the index says where a guide lives');
  assert.equal(guideIndex(path.join(dir, 'skills'), () => false), '');
  assert.equal(guideIndex('/x', () => true).split('\n').length, GUIDE_ROUTES.length + 1);
});

test('NOTES.md in the agent directory replaces the built-in notes and is bounded', t => {
  const dir = agentDir(t);
  fs.writeFileSync(path.join(dir, 'NOTES.md'), '\n  My own rules.\n');
  assert.equal(loadWorkingNotes(dir, {}), 'My own rules.');
  resetWorkingNotesCache();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'x'.repeat(MAX_USER_NOTES_CHARS + 500));
  assert.equal(loadWorkingNotes(dir, {}).length, MAX_USER_NOTES_CHARS);
  resetWorkingNotesCache();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), '   \n');
  assert.equal(loadWorkingNotes(dir, {}), WORKING_NOTES, 'an empty file is not an override');
});

test('the notes are read once per process so the prompt prefix cannot move mid-session', t => {
  const dir = agentDir(t);
  const first = loadWorkingNotes(dir, {});
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Changed while the session runs.');
  installGuide(dir, 'cinetic');
  assert.equal(loadWorkingNotes(dir, {}), first);
});

test('PI_WORKING_NOTES=0 removes the section', t => {
  const dir = agentDir(t);
  assert.equal(loadWorkingNotes(dir, { PI_WORKING_NOTES: '0' }), '');
  assert.equal(loadWorkingNotes(dir, { PI_WORKING_NOTES: 'off' }), '');
});

test('the default system prompt carries the notes before user and project additions; a custom prompt does not', t => {
  resetWorkingNotesCache();
  t.after(resetWorkingNotesCache);
  const options = {
    cwd: '/work/project', selectedTools: ['read', 'bash'],
    appendSystemPrompt: 'APPENDED-BY-USER', contextFiles: [{ path: '/work/project/AGENTS.md', content: 'PROJECT-RULES' }],
  };
  const prompt = buildSystemPrompt(options);
  const notes = prompt.indexOf('Working notes (');
  assert.ok(notes > prompt.indexOf('Guidelines:'), 'notes follow the tool guidelines');
  assert.ok(notes < prompt.indexOf('APPENDED-BY-USER'), 'user additions come after, so they have the last word');
  assert.ok(prompt.indexOf('APPENDED-BY-USER') < prompt.indexOf('PROJECT-RULES'));
  assert.doesNotMatch(prompt, /expert coding assistant/);
  assert.equal(buildSystemPrompt(options), prompt, 'two builds are byte-identical');
  assert.doesNotMatch(buildSystemPrompt({ ...options, customPrompt: 'You are a reviewer.' }), /Working notes/);
});

test('a delegated child gets the short notes after its role prompt, with the same guide index', t => {
  resetWorkingNotesCache();
  const before = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = '1';
  t.after(() => {
    if (before === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = before;
    resetWorkingNotesCache();
  });
  const prompt = buildSystemPrompt({ cwd: '/work/project', customPrompt: 'You are a worker.', contextFiles: [{ path: '/work/project/AGENTS.md', content: 'PROJECT-RULES' }] });
  const notes = prompt.indexOf(DELEGATED_NOTES);
  assert.ok(notes > prompt.indexOf('You are a worker.'), 'the role comes first');
  assert.ok(notes < prompt.indexOf('PROJECT-RULES'), 'project rules have the last word');
  assert.doesNotMatch(prompt, /Working notes \(/, 'not the full session notes');
  const appended = buildSystemPrompt({ cwd: '/work/project', appendSystemPrompt: 'You are a worker.' });
  assert.ok(appended.includes(DELEGATED_NOTES), 'a child whose role was appended to the base prompt gets the short form too');
  assert.doesNotMatch(appended, /Working notes \(/);
  assert.ok(DELEGATED_NOTES.length < 3_000, `the short form stays short (${DELEGATED_NOTES.length} chars)`);
  for (const anchor of ['The brief is the whole assignment', 'Never invent', 'waiting for the session that gave you the task', 'what was verified'])
    assert.ok(DELEGATED_NOTES.includes(anchor), anchor);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-notes-child-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, 'NOTES.md'), 'PERSONAL-NOTES');
  assert.doesNotMatch(loadWorkingNotes(agentDir, {}, true), /PERSONAL-NOTES/, 'a child keeps the short form');
  assert.match(loadWorkingNotes(agentDir, {}), /PERSONAL-NOTES/);
  assert.equal(loadWorkingNotes(agentDir, { PI_WORKING_NOTES: '0' }, true), '');
});
