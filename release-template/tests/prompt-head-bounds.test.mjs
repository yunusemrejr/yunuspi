import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatSkillsForPrompt } from '../core/coding-agent/src/core/skills.js';
import { loadProjectContextFiles } from '../core/coding-agent/src/core/resource-loader.js';

test('skill catalog caps each description so a large library stays a bounded head cost', () => {
  const long = 'word '.repeat(120).trim(); // 599 chars
  const skills = Array.from({ length: 250 }, (_, i) => ({
    name: `skill-${i}`,
    description: long,
    filePath: `/skills/skill-${i}/SKILL.md`,
  }));
  const block = formatSkillsForPrompt(skills);
  const descriptions = [...block.matchAll(/<description>([^<]*)<\/description>/g)].map(m => m[1]);
  assert.equal(descriptions.length, 250);
  for (const d of descriptions) assert.ok(d.length <= 201, `description capped, got ${d.length}`);
  assert.ok(descriptions[0].endsWith('…'), 'truncation is marked');
  assert.ok(block.length < 90_000, `250-skill catalog bounded, got ${block.length}`);
  // Short descriptions pass through untouched; whitespace is flattened to one line.
  const single = formatSkillsForPrompt([{ name: 'a', description: 'one\n two', filePath: '/a/SKILL.md' }]);
  assert.match(single, /<description>one two<\/description>/);
});

test('context files are capped per file with a truncation notice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-ctx-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yp-agent-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x'.repeat(70_000));
    const files = loadProjectContextFiles({ cwd: dir, agentDir });
    const hit = files.find(f => f.path === path.join(dir, 'AGENTS.md'));
    assert.ok(hit, 'context file discovered');
    assert.ok(hit.content.length < 66_000, `capped, got ${hit.content.length}`);
    assert.match(hit.content, /\[Truncated: .*70000 chars/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
