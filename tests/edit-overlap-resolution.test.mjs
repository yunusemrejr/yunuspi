import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEditsToNormalizedContent } from '../core/coding-agent/src/core/tools/edit-diff.js';
import { createEditTool } from '../core/coding-agent/src/core/tools/edit.js';

const file = [
 '    function setPlaying(on) {',
 '      playing = !!on;',
 '      if (cinePlay) {',
 '        cinePlay.textContent = playing ? "⏸" : "▶";',
 '      }',
 '    }',
 '',
].join('\n');

test('an inner edit the outer edit already applies is dropped instead of rejecting the batch', () => {
 const outer = { oldText: '      if (cinePlay) {\n        cinePlay.textContent = playing ? "⏸" : "▶";\n      }', newText: '      if (cinePlay) {\n        cinePlay.textContent = playing ? "Pause" : "Play";\n      }' };
 const inner = { oldText: '        cinePlay.textContent = playing ? "⏸" : "▶";', newText: '        cinePlay.textContent = playing ? "Pause" : "Play";' };
 const { newContent } = applyEditsToNormalizedContent(file, [outer, inner], 'motion.js');
 assert.match(newContent, /"Pause" : "Play"/);
 assert.equal(newContent.split('Pause').length, 2);
});

test('a partial overlap on unchanged seam text merges', () => {
 const a = { oldText: '    function setPlaying(on) {\n      playing = !!on;', newText: '    function setPlaying(next) {\n      playing = !!on;' };
 const b = { oldText: '      playing = !!on;\n      if (cinePlay) {', newText: '      playing = !!on;\n      if (cinePlay && on) {' };
 const { newContent } = applyEditsToNormalizedContent(file, [a, b], 'motion.js');
 assert.match(newContent, /setPlaying\(next\)[\s\S]*if \(cinePlay && on\)/);
});

test('conflicting overlaps are rejected with exact line ranges', () => {
 const a = { oldText: '      playing = !!on;\n      if (cinePlay) {', newText: '      playing = Boolean(on);\n      if (cinePlay) {' };
 const b = { oldText: '      if (cinePlay) {\n        cinePlay', newText: '      if (!cinePlay) return;\n        cinePlay' };
 assert.throws(() => applyEditsToNormalizedContent(file, [a, b], 'motion.js'), /edits\[0\] \(lines 2-3\) and edits\[1\] \(lines 3-4\) overlap on line 3 in motion\.js/);
});

test('the edit tool rejects misplaced contained replacements and conflicting deletions before writing', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'yunuspi-edit-overlaps-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const tool = createEditTool(dir);
 const path = 'sample.txt';
 const before = 'header original\r\nfooter old\r\nstable marker\n';
 await writeFile(join(dir, path), before);
 for (const [outer, inner] of [
  ['header unrelated\nfooter requested', 'requested'],
  ['header unrelated\nfooter old', ''],
 ]) {
  await assert.rejects(tool.execute('edit-overlap', { path, edits: [
   { oldText: 'stable marker', newText: 'separate request' },
   { oldText: 'header original\nfooter old', newText: outer },
   { oldText: 'original', newText: inner },
  ] }), /edits\[1\] \(lines 1-2\).*edits\[2\] \(line 1\).*overlap on line 1.*No file was changed/s);
  assert.equal(await readFile(join(dir, path), 'utf8'), before);
 }
});

test('contained ranges coalesce by coordinates, including Unicode and deletion', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'yunuspi-edit-overlaps-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const tool = createEditTool(dir);
 const path = 'sample.txt';
 const oldText = 'Cafe\u0301 — first\nremove! then 🐈';
 const newText = 'Coffee\n then 🐕';
 await writeFile(join(dir, path), `\ufeffprefix\r\n${oldText.replaceAll('\n', '\r\n')}\nsuffix\r`);
 const result = await tool.execute('edit-overlap', { path, edits: [
  { oldText: '🐈', newText: '🐕' },
  { oldText: 'remove!', newText: '' },
  { oldText: 'Café - first', newText: 'Coffee' },
  { oldText, newText },
  { oldText: '🐈', newText: '🐕' },
 ] });
 assert.match(result.content[0].text, /Successfully replaced/);
 assert.equal(await readFile(join(dir, path), 'utf8'), '\ufeffprefix\r\nCoffee\r\n then 🐕\nsuffix\r');
});

test('equal original ranges require equal replacements', () => {
 const oldText = 'original';
 const long = { oldText, newText: 'prefix requested suffix' };
 const short = { oldText, newText: 'requested' };
 for (const edits of [[long, short], [short, long]]) {
  assert.throws(() => applyEditsToNormalizedContent(oldText, edits, 'sample.txt'), /edits\[0\] \(line 1\) and edits\[1\] \(line 1\) overlap on line 1/);
 }
 assert.equal(applyEditsToNormalizedContent(oldText, [short, short], 'sample.txt').newContent, 'requested');
});

test('the edit tool rejects an oldText that splits a Unicode surrogate pair', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'yunuspi-edit-overlaps-'));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const tool = createEditTool(dir);
 const path = 'sample.txt';
 const before = 'keep 🐈 intact\n';
 await writeFile(join(dir, path), before);
 for (const half of ['\ud83d', '\udc08']) {
  await assert.rejects(tool.execute('edit-overlap', { path, edits: [
   { oldText: 'keep', newText: 'leave' },
   { oldText: half, newText: 'broken' },
  ] }), /edits\[1\]\.oldText must be valid Unicode.*No file was changed/s);
  assert.equal(await readFile(join(dir, path), 'utf8'), before);
 }
});
