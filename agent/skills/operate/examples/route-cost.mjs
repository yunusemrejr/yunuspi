import { readFile } from 'node:fs/promises';
import { resolveOwnedCore } from '../../../scripts/lib/owned-core.mjs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demo = [
  {
    name: 'Direct',
    calls: [{ usage: { input: 1200, output: 320, cacheRead: 0, cacheWrite: 0 }, usdPerMillion: { input: 2, output: 8 } }],
  },
  {
    name: 'Decide and escalate',
    calls: [
      { usage: { input: 400, output: 40, cacheRead: 0, cacheWrite: 0 }, usdPerMillion: { input: 0.2, output: 0.8 } },
      { usage: { input: 300, output: 320, cacheRead: 900, cacheWrite: 0 }, usdPerMillion: { input: 2, output: 8, cacheRead: 0.2 } },
    ],
  },
];

try {
  const [file] = process.argv.slice(2);
  if (!file || process.argv.length !== 3) throw Error('Usage: node route-cost.mjs --demo | cases.json');
  const cases = file === '--demo' ? demo : JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) throw Error('Expected a nonempty array of cases');
  const modelModule = join(dirname(resolveOwnedCore()), 'ai', 'dist', 'models.js');
  const { calculateCost } = await import(pathToFileURL(modelModule));

  const estimates = cases.map(({ name, calls }, index) => {
    if (typeof name !== 'string' || !name.trim() || !Array.isArray(calls) || !calls.length) {
      throw Error(`Case ${index + 1} needs a name and at least one call`);
    }
    const costs = calls.map(({ usage, usdPerMillion }) => calculateCost({ cost: usdPerMillion }, { ...usage }));
    const total = costs.reduce((sum, cost) => sum + cost.total, 0);
    return {
      name,
      calls: costs.length,
      estimatedUsd: costs.every(cost => cost.complete) && Number.isFinite(total) ? total : null,
    };
  });
  console.log(JSON.stringify({ input: file === '--demo' ? 'synthetic' : 'provided', estimates }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
