import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as Diff from 'diff';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateDiffString, generateUnifiedPatch } from '../core/coding-agent/src/core/tools/edit-diff.js';

function rows(prefix, count, ending = '\n') {
  return Array.from({ length: count }, (_, index) => prefix + ' row ' + index + ending).join('');
}

test('large exact replacement still emits a standard patch and returns promptly', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'yunuspi-edit-diff-cost-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const n = 5_000;
  const before = 'start\n' + rows('old', n) + 'finish\n';
  const after = 'start\n' + rows('new', n) + 'finish\n';
  writeFileSync(path.join(cwd, 'before'), before);
  writeFileSync(path.join(cwd, 'after'), after);
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { applyPatch } from 'diff';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { createEditToolDefinition } from './core/coding-agent/src/core/tools/edit.js';
    const cwd = process.argv[1];
    const target = path.join(cwd, 'before');
    const oldText = await readFile(target, 'utf8');
    const newText = await readFile(path.join(cwd, 'after'), 'utf8');
    const receipt = await createEditToolDefinition(cwd).execute('diff', { path: target, edits: [{ oldText, newText }] });
    assert.equal(await readFile(target, 'utf8'), newText);
    assert.equal(applyPatch(oldText, receipt.details.patch), newText);
    assert.equal(receipt.details.firstChangedLine, 2);
  `, cwd], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 12_000, killSignal: 'SIGKILL' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('large diff patches preserve context, empty ranges, and absent final newlines', () => {
  const oldRows = rows('previous', 320);
  const newRows = rows('replacement', 330);
  for (const [before, after, context] of [
    [oldRows, '', 0],
    ['', newRows, 0],
    ['start\n' + oldRows + 'old ending', 'start\n' + newRows + 'new ending', 4],
    ['start\n' + oldRows + 'shared ending', 'start\n' + newRows + 'shared ending', 1],
    ['start\r\n' + rows('old', 300, '\r\n'), 'start\r\n' + rows('new', 340, '\r\n'), 1],
  ]) {
    assert.equal(Diff.applyPatch(before, generateUnifiedPatch('sample', before, after, context)), after);
  }

  const display = generateDiffString('start\n' + oldRows + 'same', 'start\n' + newRows + 'same', 1);
  assert.equal(display.firstChangedLine, 2);
  assert.match(display.diff, /^\s+1 start\n-\s+2 previous row 0/);
  assert.match(display.diff, /\+331 replacement row 329\n 322 same$/);
});

test('terminal rendering keeps both lines of a long replacement without an exhaustive word diff', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { stripVTControlCharacters } from 'node:util';
    import { renderDiff } from './core/coding-agent/src/modes/interactive/components/diff.js';
    import { initTheme } from './core/coding-agent/src/modes/interactive/theme/theme.js';
    initTheme('dark');
    const makeLine = prefix => Array.from({ length: 5000 }, (_, index) => prefix + index).join(' ');
    const expected = '-1 ' + makeLine('before') + '\\n+1 ' + makeLine('after');
    assert.equal(stripVTControlCharacters(renderDiff(expected)), expected);
  `], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 9_000, killSignal: 'SIGKILL' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
