import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanContent } from '../scripts/check-public.mjs';

test('only reviewed screenshot bytes at their intended paths pass the public scanner', () => {
  for (const name of ['metrics-demo.png', 'graph-demo.png']) {
    const bytes = fs.readFileSync(new URL(`../docs/assets/${name}`, import.meta.url));
    assert.deepEqual(scanContent(`docs/assets/${name}`, bytes), []);
    assert.deepEqual(scanContent(`release-template/docs/assets/${name}`, bytes), []);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    assert.ok(scanContent(`docs/assets/${name}`, changed).some(f => f.rule === 'binary-unreviewed-file'));
    assert.ok(scanContent('docs/assets/unreviewed.png', bytes).some(f => f.rule === 'binary-unreviewed-file'));
  }
});
