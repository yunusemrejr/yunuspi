import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditsToNormalizedContent, closestLinesHint } from '../core/coding-agent/src/core/tools/edit-diff.js';

const file = ['import a from "a";', '', 'export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');

test('a near-miss oldText returns the real lines with numbers', () => {
  const oldText = '  for (const item of items) sum += item.cost;\n  return sum;';
  assert.throws(() => applyEditsToNormalizedContent(file, [{ oldText, newText: 'x' }], 'a.ts'), (error) => {
    assert.match(error.message, /Could not find the exact text in a\.ts/);
    assert.match(error.message, /Closest text in the file \(lines 5-6/);
    assert.match(error.message, /5:   for \(const item of items\) sum \+= item\.price;/);
    return true;
  });
});

test('unrelated oldText, tiny anchors and huge files add no hint', () => {
  assert.equal(closestLinesHint(file, 'completely different statement here'), '');
  assert.equal(closestLinesHint(file, 'a\nb'), '');
  assert.equal(closestLinesHint('x\n'.repeat(20001), 'some distinctive line'), '');
});

test('an exact edit is unaffected and multi-edit errors name the failing edit', () => {
  const ok = applyEditsToNormalizedContent(file, [{ oldText: 'let sum = 0;', newText: 'let sum = 1;' }], 'a.ts');
  assert.match(ok.newContent, /let sum = 1;/);
  assert.throws(() => applyEditsToNormalizedContent(file, [
    { oldText: 'let sum = 0;', newText: 'let sum = 2;' },
    { oldText: '  return summ;', newText: 'x' },
  ], 'a.ts'), /Could not find edits\[1\] in a\.ts.*Closest text in the file/s);
});
