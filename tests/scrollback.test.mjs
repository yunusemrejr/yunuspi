import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(dir => fs.existsSync(path.join(dir, 'scripts/compatibility/legacy-transforms/preserve-terminal-scrollback.mjs')));
const { transformScrollback } = await import(pathToFileURL(path.join(agent, 'scripts/compatibility/legacy-transforms/preserve-terminal-scrollback.mjs')));
const source = `function paint(clear, newLines, height) {
  const output = { append: value => writes.push(value) };
  if (clear) {
    output.append("\\x1b[2J\\x1b[H\\x1b[3J"); // Clear screen, home, then clear scrollback
  }
  for (let i = 0; i < newLines.length; i++) {
                if (i > 0)
                    output.append("\\r\\n");
    output.append(newLines[i]);
  }
}`;

test('redraw preserves history without replaying it; initial paint remains complete', () => {
  const patched = transformScrollback(source);
  assert.equal(transformScrollback(patched), patched);
  assert.throws(() => transformScrollback(patched.replace('let redrawStart = clear ?', 'let redrawStart = false ?')), /drift/);
  assert.throws(() => transformScrollback(source.replace('newLines.length', 'changed.length')), /drift/);
  const writes = [];
  const paint = vm.runInNewContext(`(${patched})`, { writes, isImageLine: () => false });
  const lines = Array.from({ length: 100 }, (_, i) => `row ${i}`);
  paint(false, lines, 10);
  assert.ok(writes.includes('row 0'));
  writes.length = 0; paint(true, lines, 10);
  assert.ok(!writes.join('').includes('\x1b[3J'));
  assert.deepEqual(writes.filter(value => value.startsWith('row ')), lines.slice(-10));
  writes.length = 0; paint(true, ['short'], 10);
  assert.deepEqual(writes.filter(value => value === 'short'), ['short']);
});

test('an image origin just above the viewport remains available for redraw', () => {
  const writes = [];
  const paint = vm.runInNewContext(`(${transformScrollback(source)})`, { writes, isImageLine: line => line === 'IMAGE' });
  paint.call({ getKittyImageReservedRows: () => 3 }, true, ['old', 'IMAGE', '', '', 'tail'], 3);
  assert.ok(writes.includes('IMAGE')); assert.ok(!writes.includes('old'));
});
