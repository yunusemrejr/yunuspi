import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-exclusions-'));
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(sandbox, 'exclusions.json');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/pi-subagents/src/runs/shared/model-exclusions.ts')),
);
assert.ok(agent, 'agent tree with model-exclusions.ts is present');
const shared = pathToFileURL(path.join(agent, 'extensions/pi-subagents/src/runs/shared/')).href;
const { recordModelFailure, findModelExclusion, filterFallbackCandidates } = await import(shared + 'model-exclusions.ts');

test('recorded failures exclude and filter candidates', () => {
  recordModelFailure({ modelId: 'm-x', provider: 'p', reason: 'boom' });
  assert.ok(findModelExclusion('p/m-x'), 'recorded model is excluded');
  assert.deepEqual(filterFallbackCandidates(['p/m-x', 'p/m-ok']), ['p/m-ok']);
});

test('recording merges sibling exclusions instead of dropping them', () => {
  // Simulate a sibling session appending straight to the shared file.
  const file = process.env.PI_MODEL_EXCLUSIONS_PATH;
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Date.now();
  disk.exclusions.push({ provider: 'p', modelId: 'm-sibling', reason: 'sibling', recordedAt: now, expiresAt: now + 3600_000 });
  fs.writeFileSync(file, JSON.stringify(disk));

  recordModelFailure({ modelId: 'm-z', provider: 'p', reason: 'boom' });
  const ids = JSON.parse(fs.readFileSync(file, 'utf8')).exclusions.map((e) => e.modelId).sort();
  assert.deepEqual(ids, ['m-sibling', 'm-x', 'm-z']);
  assert.ok(findModelExclusion('p/m-sibling'), 'sibling exclusion is visible in-memory');
});
