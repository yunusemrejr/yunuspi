import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) =>
  fs.existsSync(path.join(p, 'extensions/lib/cost-states.ts')),
);
assert.ok(agent, 'agent tree with cost-states.ts is present');
const lib = pathToFileURL(path.join(agent, 'extensions/lib/')).href;
const { classifyCostState, formatCost, formatCostRow } = await import(lib + 'cost-states.ts');

test('unknown cost is never rendered as $0', () => {
  assert.equal(classifyCostState({}), 'unknown');
  assert.equal(formatCost(0, 'unknown'), '$?');
  assert.equal(formatCost(0, 'pending'), '$+?');
  assert.equal(formatCost(0.002, 'pending'), '$~0.002000+?');
  assert.ok(!/0\.0/.test(formatCost(0, 'unknown')), 'unknown never renders zero digits');
});

test('verified zero and free evidence render explicitly', () => {
  assert.equal(classifyCostState({ seen: true, reported: 0, estimated: 0 }), 'verified-zero');
  assert.equal(formatCost(0, 'verified-zero'), '$0.000 (verified)');
  assert.equal(formatCost(0, 'free-evidence'), '$0.000 (free)');
  assert.equal(formatCost(0.001234, 'estimated'), '$~0.001234');
  assert.equal(formatCost(0.001234, 'provider-reported'), '$0.001234');
  assert.ok(formatCostRow('openrouter/x', 0, 'unknown').includes('[unknown]'));
});
