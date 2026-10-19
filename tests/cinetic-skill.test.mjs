import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { routeSkills } from '../agent/extensions/lib/skill-routing.ts';

const root = path.resolve(import.meta.dirname, '..');
const skillDir = path.join(root, 'agent/skills/cinetic');
const routes = prompt => routeSkills(prompt).map(route => route.name);

test('cinetic ships pinned MIT upstream files with only SKILL.md adapted', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(skillDir, 'UPSTREAM.json'), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/Leonxlnx/cinetic');
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.license, 'MIT');
  assert.deepEqual(Object.keys(provenance.modifiedFiles), ['SKILL.md']);
  const shipped = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else shipped.push(path.relative(skillDir, full));
  } };
  walk(skillDir);
  assert.deepEqual(shipped.filter(file => file !== 'UPSTREAM.json').sort(), Object.keys(provenance.files).sort(), 'every shipped file is pinned');
  for (const [file, hash] of Object.entries(provenance.files))
    if (!provenance.modifiedFiles[file]) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(skillDir, file))).digest('hex'), hash, file);
  assert.match(fs.readFileSync(path.join(skillDir, 'LICENSE.txt'), 'utf8'), /MIT License[\s\S]*Copyright \(c\) 2026 Leonxlnx/);
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.equal(parse(skill.split('---')[1]).name, 'cinetic');
  assert.match(skill, /## YunusPi integration[\s\S]*names one lead skill for the film/);
  assert.match(skill, /does not install packages the user has not approved|do not install packages the user has not approved/);
  assert.match(fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /cinetic by Leonxlnx — MIT/);
});

test('motion-design requests discover cinetic; unrelated work does not', () => {
  for (const prompt of ['make a launch film for our app', 'make a logo sting for the brand', 'build a kinetic typography intro', 'produce a teaser for the cinetic launch'])
    assert.ok(routes(prompt).includes('cinetic'), prompt);
  for (const prompt of ['fix the race condition in the job queue', 'redesign the settings page', 'add a --json flag to the CLI'])
    assert.ok(!routes(prompt).includes('cinetic'), prompt);
});
