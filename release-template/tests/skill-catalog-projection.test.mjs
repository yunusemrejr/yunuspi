import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatSkillsForPrompt } from '../core/coding-agent/src/core/skills.js';

const release = path.resolve(import.meta.dirname, '..');
const agent = fs.existsSync(path.join(release, 'agent')) ? path.join(release, 'agent') : path.resolve(release, '..');
const { compactSkillCatalog, skillCatalogProjectionMiss } = await import(pathToFileURL(path.join(agent, 'extensions/lib/tool-discovery.ts')).href);

const skill = (name, description) => ({ name, description, filePath: `/skills/${name}/SKILL.md`, disableModelInvocation: false });
const long = 'Build detailed technical animations & "figures" that explain how a system works. '.repeat(8);
const skills = [skill('short', 'A short <description>.'), skill('long', long), skill('hidden', 'never shown')].map((s, index) => index === 2 ? { ...s, disableModelInvocation: true } : s);

test('the catalogue projection recognizes the block the prompt shows, including capped long descriptions', () => {
  const systemPrompt = `Intro.${formatSkillsForPrompt(skills)}\nCurrent working directory: /work`;
  assert.ok(systemPrompt.includes('…'), 'the long description is capped in the prompt');
  const event = { systemPrompt, systemPromptOptions: { skills } };
  assert.equal(skillCatalogProjectionMiss(event, ['skill_review']), null, 'a capped description must not make the projection miss');
  const projected = compactSkillCatalog(event, ['skill_review']);
  assert.ok(projected.includes('Installed skills: 2 workflows.'), 'hidden skills are not counted');
  assert.ok(!projected.includes('<available_skills>') && !projected.includes('Build detailed'), 'the whole block is replaced by one line');
  assert.ok(projected.endsWith('Current working directory: /work') && projected.startsWith('Intro.'), 'text around the block is untouched');
});

test('a foreign catalogue block is reported, never rewritten', () => {
  const event = { systemPrompt: 'x<available_skills>\n  <skill>other</skill>\n</available_skills>y', systemPromptOptions: { skills } };
  assert.equal(compactSkillCatalog(event, ['skill_review']), undefined);
  assert.equal(skillCatalogProjectionMiss(event, ['skill_review']), 'block-not-exact');
});
