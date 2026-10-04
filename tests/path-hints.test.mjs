import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nameSimilarity, missingPathHint, directoryReadHint, fileWhereDirectoryExpectedHint, withHint, annotatePathError } from '../core/coding-agent/src/core/tools/path-hints.js';
import { createReadToolDefinition } from '../core/coding-agent/src/core/tools/read.js';
import { createLsToolDefinition } from '../core/coding-agent/src/core/tools/ls.js';
import { createFindToolDefinition } from '../core/coding-agent/src/core/tools/find.js';
import { createEditToolDefinition } from '../core/coding-agent/src/core/tools/edit.js';
import { createGrepToolDefinition } from '../core/coding-agent/src/core/tools/grep.js';
import { spawnSync } from 'node:child_process';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-hints-'));
  const put = (relative, text = 'x\n') => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put('src/components/Button.tsx', 'export const Button = 1;\n');
  put('src/components/card-list.ts');
  put('src/utils.ts');
  put('docs/README.md');
  put('assets/logo.png');
  put('node_modules/pkg/Button.tsx');
  fs.mkdirSync(path.join(root, 'empty'));
  return root;
}
const runTool = async (definition, params, cwd) => {
  try { return { ok: true, result: await definition.execute('call', params, undefined, undefined, { cwd }) }; }
  catch (error) { return { ok: false, message: error.message, error }; }
};

test('name similarity separates look-alikes from unrelated names', () => {
  assert.equal(nameSimilarity('a.ts', 'a.ts'), 1);
  assert.equal(nameSimilarity('button.tsx', 'Button.tsx'), 0.98);
  assert.equal(nameSimilarity('card_list.ts', 'card-list.ts'), 0.98);
  assert.equal(nameSimilarity('Button.jsx', 'Button.tsx'), 0.92);
  const typo = nameSimilarity('Buton.tsx', 'Button.tsx');
  assert.ok(typo > 0.6 && typo <= 0.9, `typo scored ${typo}`);
  assert.equal(nameSimilarity('Button.tsx', 'database.sql'), 0);
  assert.equal(nameSimilarity('', 'x'), 0);
  assert.equal(nameSimilarity('ab', 'ac'), 0.5, 'a one-letter slip in a two-letter name is still a candidate');
});

test('a mistyped directory and file name resolve to the real path', () => {
  const root = fixture();
  const wrong = path.join(root, 'src/component/Buton.tsx');
  const hint = missingPathHint('src/component/Buton.tsx', wrong, root);
  assert.match(hint, new RegExp(`Nearest existing directory: ${path.join(root, 'src').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(hint.includes(`Did you mean: ${path.join(root, 'src/components/Button.tsx')}`), hint);
});

test('case and separator differences resolve, and a wrong root is repaired', () => {
  const root = fixture();
  assert.ok(missingPathHint('src/components/CARD_LIST.ts', path.join(root, 'src/components/CARD_LIST.ts'), root).includes(path.join(root, 'src/components/card-list.ts')));
  // "/src/utils.ts" was meant relative to the working directory; "myproj/src/utils.ts" repeats the folder the session is already in.
  assert.ok(missingPathHint('/src/utils.ts', '/src/utils.ts', root).includes(path.join(root, 'src/utils.ts')));
  const prefixed = missingPathHint('myproj/src/utils.ts', path.join(root, 'myproj/src/utils.ts'), root);
  assert.ok(prefixed.includes(path.join(root, 'src/utils.ts')), prefixed);
});

test('the same file name elsewhere is offered, but not from dependency trees', () => {
  const root = fixture();
  const hint = missingPathHint('lib/Button.tsx', path.join(root, 'lib/Button.tsx'), root);
  assert.ok(hint.includes(path.join(root, 'src/components/Button.tsx')), hint);
  assert.ok(!hint.includes('node_modules'), 'dependency trees are skipped');
});

test('with no candidate the hint lists what the nearest directory holds', () => {
  const root = fixture();
  const hint = missingPathHint('nothing/here.txt', path.join(root, 'nothing/here.txt'), root);
  assert.ok(!hint.includes('Did you mean'));
  for (const name of ['src/', 'docs/', 'assets/', 'empty/']) assert.ok(hint.includes(name), `${name} listed in: ${hint}`);
  const emptyHint = missingPathHint('empty/a.txt', path.join(root, 'empty/a.txt'), root);
  assert.match(emptyHint, /It contains: \(empty\)/);
});

test('a file in the way is named instead of listing a directory', () => {
  const root = fixture();
  const hint = missingPathHint('src/utils.ts/deeper.ts', path.join(root, 'src/utils.ts/deeper.ts'), root);
  assert.match(hint, /utils\.ts is a file, so nothing can exist below it/);
});

test('directory and file helpers describe the actual kind', () => {
  const root = fixture();
  assert.match(directoryReadHint(path.join(root, 'src')), /is a directory, not a file.*components\/, utils\.ts/);
  assert.equal(directoryReadHint(path.join(root, 'src/utils.ts')), '');
  assert.match(fileWhereDirectoryExpectedHint(path.join(root, 'src/utils.ts')), /is a file \(\d+ bytes\), not a directory.*components\/, utils\.ts/);
  assert.equal(fileWhereDirectoryExpectedHint(path.join(root, 'src')), '');
  assert.equal(withHint('first', ''), 'first');
  assert.equal(withHint('first', 'second'), 'first\nsecond');
});

test('hints are bounded: odd input never throws and a large tree answers quickly', () => {
  assert.equal(typeof missingPathHint('', '', ''), 'string');
  assert.equal(typeof missingPathHint('\u0000x', '/nonexistent-root-xyz/a/b', '/nonexistent-root-xyz'), 'string');
  const started = Date.now();
  missingPathHint('zzz-not-here/qqq-missing.txt', '/usr/zzz-not-here/qqq-missing.txt', '/usr');
  assert.ok(Date.now() - started < 2500, 'a miss inside /usr stays inside the search budget');
  const error = Object.assign(new Error('boom'), { code: 'EACCES' });
  assert.equal(annotatePathError(error, 'a', '/a', '/'), error);
  assert.equal(error.message, 'boom');
});

test('read keeps its first error line and adds the way out', async () => {
  const root = fixture();
  const read = createReadToolDefinition(root);
  const missing = await runTool(read, { path: 'src/components/button.ts' }, root);
  assert.equal(missing.ok, false);
  assert.match(missing.message.split('\n')[0], /^ENOENT: no such file or directory, access '.*button\.ts'$/);
  assert.ok(missing.message.includes(path.join(root, 'src/components/Button.tsx')), missing.message);
  assert.equal(missing.error.code, 'ENOENT', 'the error object keeps its code for classifiers');
  const directory = await runTool(read, { path: 'src' }, root);
  assert.equal(directory.ok, false);
  assert.match(directory.message, /is a directory, not a file.*components\//s);
  const fine = await runTool(read, { path: 'src/utils.ts' }, root);
  assert.equal(fine.ok, true);
});

test('ls and find name the way out for a missing or wrong-kind path', async () => {
  const root = fixture();
  const ls = createLsToolDefinition(root);
  const missing = await runTool(ls, { path: 'src/component' }, root);
  assert.match(missing.message.split('\n')[0], /^Path not found: /);
  assert.ok(missing.message.includes(`Did you mean: ${path.join(root, 'src/components')}`), missing.message);
  const file = await runTool(ls, { path: 'src/utils.ts' }, root);
  assert.match(file.message.split('\n')[0], /^Not a directory: /);
  assert.match(file.message, /is a file \(\d+ bytes\), not a directory/);
  const find = createFindToolDefinition(root);
  const findMissing = await runTool(find, { pattern: '*.ts', path: 'sources' }, root);
  assert.match(findMissing.message.split('\n')[0], /^Path not found: /);
  assert.match(findMissing.message, /It contains: .*src\//, 'no look-alike for "sources": the nearest directory is listed instead');
  const findFile = await runTool(find, { pattern: '*.ts', path: 'src/utils.ts' }, root);
  assert.match(findFile.message.split('\n')[0], /^Not a directory: /);
});

test('custom operations get no local hint because the listing would describe another machine', async () => {
  const root = fixture();
  const ls = createLsToolDefinition(root, { operations: { exists: async () => false, stat: async () => { throw new Error('unused'); }, readdir: async () => [] } });
  const result = await runTool(ls, { path: 'src/component' }, root);
  assert.equal(result.message, `Path not found: ${path.join(root, 'src/component')}`);
});

test('edit of a missing file names the likely file', async () => {
  const root = fixture();
  const edit = createEditToolDefinition(root);
  const result = await runTool(edit, { path: 'src/util.ts', edits: [{ oldText: 'x', newText: 'y' }] }, root);
  assert.equal(result.ok, false);
  assert.match(result.message.split('\n')[0], /^Could not edit file: src\/util\.ts\. Error code: ENOENT\.$/);
  assert.ok(result.message.includes(path.join(root, 'src/utils.ts')), result.message);
});

// ripgrep is an external binary; the check is skipped where it is not installed rather than downloading it.
test('grep of a missing directory names the likely directory', { skip: spawnSync('rg', ['--version']).status !== 0 }, async () => {
  const root = fixture();
  const result = await runTool(createGrepToolDefinition(root), { pattern: 'Button', path: 'src/component' }, root);
  assert.equal(result.ok, false);
  assert.match(result.message.split('\n')[0], /^Path not found: /);
  assert.ok(result.message.includes(`Did you mean: ${path.join(root, 'src/components')}`), result.message);
});
