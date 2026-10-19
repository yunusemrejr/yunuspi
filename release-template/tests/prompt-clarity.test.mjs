import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX} from '../core/coding-agent/src/core/messages.js';
import {formatSkillsForPrompt} from '../core/coding-agent/src/core/skills.js';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(dir => fs.existsSync(path.join(dir, 'extensions/session-signals.ts')));
assert.ok(agent);

test('compaction checkpoint tells the model to continue without restating or acknowledging it', () => {
  assert.match(COMPACTION_SUMMARY_PREFIX, /Continue the task directly from the messages that follow, without acknowledging this checkpoint\./);
  assert.match(COMPACTION_SUMMARY_PREFIX, /without restating it/);
  assert.ok(COMPACTION_SUMMARY_PREFIX.endsWith('<summary>\n') && COMPACTION_SUMMARY_SUFFIX.endsWith('</summary>'));
});

test('initial and update summaries keep errors, faithful corrections and a no-narration rule', () => {
  const source = fs.readFileSync(path.join(root, 'core/coding-agent/src/core/compaction/compaction.js'), 'utf8');
  const prompt = (name) => source.slice(source.indexOf(`const ${name} = \``), source.indexOf('`;', source.indexOf(`const ${name} = \``)));
  for (const name of ['SUMMARIZATION_PROMPT', 'UPDATE_SUMMARIZATION_INSTRUCTIONS']) {
    const text = prompt(name);
    assert.ok(text.includes('## Errors and Fixes'), name);
    assert.ok(text.includes('${SUMMARY_RULES}'), name);
    for (const heading of ['## Goal', '## Constraints & Preferences', '## Progress', '## Key Decisions', '## Next Steps', '## Critical Context'])
      assert.ok(text.includes(heading), `${name} keeps ${heading}`);
  }
  const rules = prompt('SUMMARY_RULES');
  assert.match(rules, /Capture user feedback and explicit instructions faithfully, especially corrections/);
  assert.match(rules, /Do not mention this summarization request or that the context was compacted/);
  assert.match(rules, /do not call any tool/);
});

test('skill hedging is stated once by the catalog preamble, not repeated by harness lines', async () => {
  const skill = {name: 'fixture-guide', description: 'Inspect a fixture', filePath: '/fixture/SKILL.md'};
  assert.match(formatSkillsForPrompt([skill]), /even if the file calls them mandatory/);
  const signals = fs.readFileSync(path.join(agent, 'extensions/session-signals.ts'), 'utf8');
  const toolFirst = /export const HARNESS_TOOL_FIRST =\s*"([^"]+)"/.exec(signals)?.[1];
  assert.ok(toolFirst?.includes('tool_search') && toolFirst.includes('skill_review'));
  assert.doesNotMatch(toolFirst, /mandatory|adapt or skip/);
  const {compactSkillCatalog} = await import(pathToFileURL(path.join(agent, 'extensions/lib/tool-discovery.ts')));
  const block = '<available_skills>\n  <skill>\n    <name>fixture-guide</name>\n    <description>Inspect a fixture</description>\n    <location>/fixture/SKILL.md</location>\n  </skill>\n</available_skills>';
  const projected = compactSkillCatalog({systemPrompt: `A\n${block}\nB`, systemPromptOptions: {skills: [skill]}}, ['skill_review']);
  assert.ok(projected.includes('skill_review') && projected.includes('1 workflows'));
  assert.doesNotMatch(projected, /mandatory|adapt or skip/);
});
