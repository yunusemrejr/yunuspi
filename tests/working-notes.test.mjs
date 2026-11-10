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
  for (const heading of ['Understand the request', 'Craft', 'Explaining', 'Nothing leaks', 'Visual work',
    'Numbers and logic', 'Code and shipping', 'Acting for the user', 'Reporting']) {
    assert.match(WORKING_NOTES, new RegExp(`^${heading}`, 'm'), heading);
  }
  // The notes ride in every request, so their size is a budget, not an accident.
  assert.ok(WORKING_NOTES.length < 8_000, `notes are ${WORKING_NOTES.length} chars`);
});

test('a session with no personal notes gets the built-in ones', t => {
  assert.equal(loadWorkingNotes(agentDir(t), {}), WORKING_NOTES);
});

test('the guide index lists only guides that are installed', t => {
  const dir = agentDir(t);
  installGuide(dir, 'ui-design');
  installGuide(dir, 'research');
  const text = loadWorkingNotes(dir, {});
  const index = text.slice(WORKING_NOTES.length);
  assert.match(index, /ui-design/);
  assert.match(index, /research/);
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
  assert.ok(DELEGATED_NOTES.length < 1_400, `the short form stays short (${DELEGATED_NOTES.length} chars)`);
  for (const anchor of ['The brief is the whole assignment', 'Never invent', 'waiting for the session that gave you the task', 'what was verified'])
    assert.ok(DELEGATED_NOTES.includes(anchor), anchor);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-notes-child-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, 'NOTES.md'), 'PERSONAL-NOTES');
  assert.doesNotMatch(loadWorkingNotes(agentDir, {}, true), /PERSONAL-NOTES/, 'a child keeps the short form');
  assert.match(loadWorkingNotes(agentDir, {}), /PERSONAL-NOTES/);
  assert.equal(loadWorkingNotes(agentDir, { PI_WORKING_NOTES: '0' }, true), '');
});
