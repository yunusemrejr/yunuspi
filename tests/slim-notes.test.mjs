import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLIM_FILE_MIN, slimNotesFile, slimNotesOn } from '../core/coding-agent/src/core/slim-notes.js';
import { loadProjectContextFiles } from '../core/coding-agent/src/core/resource-loader.js';

const RULES = ['# AGENTS.md', '', '## Rules', '', '1. Always push to BOTH remotes.', '2. Never commit secrets.', ''].join('\n');
const LOG = Array.from({ length: 40 }, (_, i) => `- **Change ${i}** shipped on some day: ${'what was done, file by file, with every detail of it. '.repeat(50)}`).join('\n');
const BIG = `${RULES}\n## What is deployed\n\n${LOG}\n\n## Reminders\n\n1. Deploy only through git.\n`;
const DENSE = Array.from({ length: 900 }, (_, i) => `## Rule ${i}\n\nDo thing ${i} exactly this way.`).join('\n');
// Long enough to slim, small enough that the 65,536-char cap does not apply.
const LONG = `${RULES}\n## What is deployed\n\n${LOG.split('\n').slice(0, 12).join('\n')}\n\n## Reminders\n\n1. Deploy only through git.\n`;

test('a file under the floor is sent unchanged', () => {
  assert.ok(RULES.length < SLIM_FILE_MIN);
  assert.equal(slimNotesFile('/p/CLAUDE.md', RULES), RULES);
});

test('a long line keeps its opening, its line number and the characters left out', () => {
  const out = slimNotesFile('/p/AGENTS.md', BIG);
  assert.ok(out.length < BIG.length / 4, `${out.length} of ${BIG.length}`);
  assert.match(out, /- \*\*Change 0\*\* shipped on some day: what was done.* … \[\+\d+ chars, line 10\]/);
});

test('a section over the section cap keeps its head and names the left-out line range', () => {
  const out = slimNotesFile('/p/AGENTS.md', BIG);
  assert.match(out, /\[lines 40–50 of this section are left out here\]/);
  for (const kept of ['## What is deployed', '## Reminders', '1. Always push to BOTH remotes.', '2. Never commit secrets.', '1. Deploy only through git.'])
    assert.ok(out.includes(kept), kept);
  assert.match(out, /Read \/p\/AGENTS\.md at that line/);
});

test('fenced code is never cut', () => {
  const fenced = `# T\n\n\`\`\`\n${'y'.repeat(900)}\n\`\`\`\n\n${LOG}`;
  assert.ok(fenced.length >= SLIM_FILE_MIN);
  assert.ok(slimNotesFile('/p/A.md', fenced).includes('y'.repeat(900)), 'code is never cut');
});

test('a fenced block that crosses the section cap keeps its closing fence', () => {
  const prose = Array.from({ length: 30 }, (_, i) => `Line ${i} ${'of plain prose '.repeat(15)}`).join('\n');
  const block = `\`\`\`\n${Array.from({ length: 10 }, () => 'z'.repeat(300)).join('\n')}\n\`\`\``;
  const notes = `# T\n\n## Setup\n\n${prose}\n${block}\n${prose}\n\n## Rules\n\n1. Rule after the block.\n\n## Log\n\n${LOG}`;
  assert.ok(notes.length >= SLIM_FILE_MIN);
  const out = slimNotesFile('/p/A.md', notes);
  assert.equal(out.split('\n').filter(line => /^\s*```/.test(line)).length % 2, 0, 'every opened fence is closed');
  assert.ok(out.includes('1. Rule after the block.'));
});

test('a large dense file that saves under 20% is sent unchanged', () => {
  assert.ok(DENSE.length >= SLIM_FILE_MIN);
  assert.equal(slimNotesFile('/p/CLAUDE.md', DENSE), DENSE);
});

test('project notes are shortened, the agent directory notes never', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-slim-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-slim-agent-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), LONG);
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), LONG);
    const files = loadProjectContextFiles({ cwd: dir, agentDir });
    const global = files.find((f) => f.path === path.join(agentDir, 'AGENTS.md'));
    const project = files.find((f) => f.path === path.join(dir, 'AGENTS.md'));
    assert.equal(global.content, LONG, 'global notes stay whole');
    assert.ok(project.content.length < LONG.length, 'project notes are shortened');
    assert.match(project.content, /\[The harness shortened this file for the prompt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('the switch sends files as they are', () => {
  assert.equal(slimNotesOn('0'), false);
  assert.equal(slimNotesOn(undefined), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-slim-off-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-slim-off-agent-'));
  const before = process.env.YUNUSPI_SLIM_NOTES;
  process.env.YUNUSPI_SLIM_NOTES = '0';
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), LONG);
    const files = loadProjectContextFiles({ cwd: dir, agentDir });
    assert.equal(files.find((f) => f.path === path.join(dir, 'AGENTS.md')).content, LONG);
  } finally {
    if (before === undefined) delete process.env.YUNUSPI_SLIM_NOTES; else process.env.YUNUSPI_SLIM_NOTES = before;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
