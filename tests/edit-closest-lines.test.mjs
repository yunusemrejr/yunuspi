import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditsToNormalizedContent, applyEditsWithOriginalLineEndings, closestLinesHint, normalizeToLF } from '../core/coding-agent/src/core/tools/edit-diff.js';
import { createEditToolDefinition } from '../core/coding-agent/src/core/tools/edit.js';
import { createWriteToolDefinition } from '../core/coding-agent/src/core/tools/write.js';

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

test('overlapping occurrences of the same oldText are ambiguous', () => {
  assert.throws(() => applyEditsToNormalizedContent('aaaa', [{ oldText: 'aaa', newText: 'x' }], 'a.txt'), /Found 2 occurrences/);
});

test('an equivalent match preserves punctuation and whitespace outside the replaced span', () => {
  const original = 'Cafe\u0301 — marker; suffix “kept”   \nnext\n';
  const { newContent } = applyEditsToNormalizedContent(original, [
    { oldText: 'Café - marker', newText: 'replacement' },
    { oldText: 'next', newText: 'done' },
  ], 'a.txt');
  assert.equal(newContent, 'replacement; suffix “kept”   \ndone\n');
});

test('an exact match remains distinct from a fuzzy lookalike in a mixed batch', () => {
  const original = 'say "yes"\nsay “yes”\nstate — old\n';
  const { newContent } = applyEditsToNormalizedContent(original, [
    { oldText: 'say "yes"', newText: 'say "no"' },
    { oldText: 'state - old', newText: 'state - new' },
  ], 'a.txt');
  assert.equal(newContent, 'say "no"\nsay “yes”\nstate - new\n');
});

test('equivalent matching refuses half a compatibility character and an empty normalized query', () => {
  assert.throws(() => applyEditsToNormalizedContent('ﬁ', [{ oldText: 'f', newText: 'x' }], 'a.txt'), /exact text/);
  assert.throws(() => applyEditsToNormalizedContent('a', [{ oldText: '\t', newText: 'x' }], 'a.txt'), /exact text/);
});

test('a fuzzy multiline edit cannot end inside an unchanged Unicode grapheme', () => {
  assert.throws(() => applyEditsToNormalizedContent('state — old\nkeep 👩‍💻', [
    { oldText: 'state - old\nkeep 👩', newText: 'replacement' },
  ], 'a.txt'), /complete source span/);
});

test('normal edit transport preserves BOM and untouched mixed newline bytes', async t => {
  const readFile = t.mock.fn(async () => Buffer.from('\ufefffirst\r\nsecond\nstate — old\rthird\n'));
  const writeFile = t.mock.fn(async () => {});
  const tool = createEditToolDefinition('/var/tmp', { operations: { readFile, writeFile, access: async () => {} } });
  await tool.execute('edit', {
    path: 'fixture.txt', edits: [{ oldText: 'state - old', newText: 'state - new\nmore' }],
  });
  assert.equal(writeFile.mock.calls[0].arguments[1], '\ufefffirst\r\nsecond\nstate - new\r\nmore\rthird\n');
});

test('mixed newline splices preserve both logical breaks when a bare CR meets LF', () => {
  for (const [content, oldText, newText, expected] of [
    ['a\nb\rc', 'c', '\nc', 'a\nb\n\nc'],
    ['a\rY\nz', 'Y', '', 'a\n\nz'],
  ]) {
    const result = applyEditsWithOriginalLineEndings(content, normalizeToLF(content), [{ oldText, newText }], 'a.txt');
    assert.equal(result.newContent, expected);
    assert.equal(normalizeToLF(result.writeContent), expected);
  }
});

test('normal edit transport refuses invalid UTF-8 before writing', async t => {
  const readFile = t.mock.fn(async () => Buffer.concat([Buffer.from([0xff]), Buffer.from(' unchanged\nfoo\n')]));
  const writeFile = t.mock.fn(async () => {});
  const tool = createEditToolDefinition('/var/tmp', { operations: { readFile, writeFile, access: async () => {} } });
  await assert.rejects(tool.execute('edit', {
    path: 'fixture.txt', edits: [{ oldText: 'foo', newText: 'bar' }],
  }), /valid UTF-8/);
  assert.equal(writeFile.mock.callCount(), 0);
});

test('edit and write return the successful receipt when Stop arrives during their write', async t => {
  for (const name of ['edit', 'write']) {
    const controller = new AbortController();
    const writeFile = t.mock.fn(async () => { controller.abort(); });
    const tool = name === 'edit'
      ? createEditToolDefinition('/var/tmp', { operations: {
          access: async () => {}, readFile: async () => Buffer.from('old'), writeFile,
        } })
      : createWriteToolDefinition('/var/tmp', { operations: { mkdir: async () => {}, writeFile } });
    const args = name === 'edit'
      ? { path: 'fixture.txt', edits: [{ oldText: 'old', newText: 'new' }] }
      : { path: 'fixture.txt', content: 'new' };
    assert.match((await tool.execute(name, args, controller.signal)).content[0].text, /Successfully/);
    assert.equal(writeFile.mock.calls[0].arguments[1], 'new');
    await assert.rejects(tool.execute(name, args, controller.signal), /Operation aborted/);
    assert.equal(writeFile.mock.callCount(), 1);
  }
});

test('edit and write refuse text that would change during UTF-8 encoding', async t => {
  const writeFile = t.mock.fn(async () => {});
  const edit = createEditToolDefinition('/var/tmp', { operations: {
    readFile: async () => Buffer.from('old'), access: async () => {}, writeFile,
  } });
  const write = createWriteToolDefinition('/var/tmp', { operations: { mkdir: async () => {}, writeFile } });
  await assert.rejects(edit.execute('edit', {
    path: 'fixture.txt', edits: [{ oldText: 'old', newText: '\ud800' }],
  }), /valid Unicode/);
  await assert.rejects(write.execute('write', { path: 'fixture.txt', content: '\ud800' }), /valid Unicode/);
  assert.equal(writeFile.mock.callCount(), 0);
});
