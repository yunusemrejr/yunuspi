import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'extensions/lib/session-diagnostics.ts')));
assert.ok(agent, 'agent tree with session-diagnostics.ts is present');
const { failureCategory } = await import(pathToFileURL(path.join(agent, 'extensions/lib/session-diagnostics.ts')));

test('optimistic-concurrency edit rejection classifies as edit-conflict', () => {
  const error = 'Edits rejected: src/com/mailgenie/web/assets/app.js changed since it was last read (optimistic-concurrency conflict; expected hash a438bbef78fbf08db7d9b595, current 61f0c4c5259d517b24eaeaee). No file was changed.';
  const result = failureCategory(error);
  assert.equal(result.category, 'edit-conflict');
  assert.match(result.recovery, /rebuild/i);
});

test('unknown agent classifies as caller input, not unclassified', () => {
  const result = failureCategory('Unknown agent: generic\nEffective cwd: /home/user/projects/mymailgenie\nDid you mean: delegate?');
  assert.equal(result.category, 'input');
});

test('todo dependency block (legacy and blocker-naming shapes) classifies as guard', () => {
  for (const error of [
    'Error: Complete dependencies before starting or completing this task',
    'Error: batch operation 1: Complete dependencies before starting or completing this task',
    'Error: Complete dependencies before starting or completing this task: blocked by #4 "Rebuild UI shell" (in_progress), #5 "Upgrade genie" (in_progress)',
  ]) {
    const result = failureCategory(error);
    assert.equal(result.category, 'guard');
    assert.match(result.recovery, /blockers/);
  }
});

test('setup refusals and a reasoning-exhausted reply get a category instead of unclassified', () => {
  assert.equal(failureCategory('Speech recognition is not installed. Create it once with: python3 -m venv ~/.pi/agent/local-models/asr/venv').category, 'dependency');
  assert.equal(failureCategory('Audio was not submitted: ElevenLabs is not configured. Inspect music_compose for local music').category, 'dependency');
  assert.equal(failureCategory('Vision model spent its whole output allowance (including reasoning) before answering; retry with a larger maxTokens').category, 'truncated');
});

test('bare nouns still do not classify', () => {
  assert.equal(failureCategory('dependencies: react, typescript').category, 'unclassified');
  assert.equal(failureCategory('agent: delegate finished ok').category, 'unclassified');
  assert.equal(failureCategory('Edits applied cleanly to app.js').category, 'unclassified');
});
