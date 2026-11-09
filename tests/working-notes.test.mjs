import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GUIDE_ROUTES, MAX_USER_NOTES_CHARS, WORKING_NOTES, guideIndex, loadWorkingNotes, resetWorkingNotesCache,
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
    cwd: '/work/project', selectedTools: ['read', 'bash'], toolSnippets: { read: 'Read a file' },
    appendSystemPrompt: 'APPENDED-BY-USER', contextFiles: [{ path: '/work/project/AGENTS.md', content: 'PROJECT-RULES' }],
  };
  const prompt = buildSystemPrompt(options);
  const notes = prompt.indexOf('Working notes (');
  assert.ok(notes > prompt.indexOf('Guidelines:'), 'notes follow the tool guidelines');
  assert.ok(notes < prompt.indexOf('APPENDED-BY-USER'), 'user additions come after, so they have the last word');
  assert.ok(prompt.indexOf('APPENDED-BY-USER') < prompt.indexOf('PROJECT-RULES'));
  assert.doesNotMatch(prompt, /expert coding assistant/);
  assert.equal(buildSystemPrompt(options), prompt, 'two builds are byte-identical');
  assert.doesNotMatch(buildSystemPrompt({ ...options, customPrompt: 'You are a reviewer.' }), /Working notes \(/);
});
