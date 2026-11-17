import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReadToolDefinition } from '../core/coding-agent/src/core/tools/read.js';

function fixture(t, bytes) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'yunuspi-native-read-ranges-'));
  const file = path.join(dir, 'fixture.txt');
  fs.writeFileSync(file, bytes);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = createReadToolDefinition(dir);
  const reference = createReadToolDefinition(dir, { operations: {
    access: file => fsp.access(file),
    readFile: file => fsp.readFile(file),
  } });
  return { dir, file, read, reference };
}

function countNativeReads(t, target) {
  const open = fsp.open;
  const counts = { full: 0, positioned: 0, afterPositioned: undefined };
  fsp.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === target) {
      const readFile = handle.readFile.bind(handle);
      handle.readFile = async (...args) => {
        const bytes = await readFile(...args);
        counts.full += bytes.length;
        return bytes;
      };
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        counts.positioned += result.bytesRead;
        counts.afterPositioned?.();
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = open; syncBuiltinESMExports(); });
  return counts;
}

function uniformLines(lines) {
  const bytes = Buffer.alloc(lines * 128, 120);
  for (let line = 0; line < lines; line++) {
    bytes.write(String(line).padStart(6, '0'), line * 128);
    bytes[(line + 1) * 128 - 1] = 10;
  }
  return bytes;
}

function readRange(run, offset, limit, signal) {
  return run.execute('fixture-read', { path: 'fixture.txt', offset, limit }, signal);
}

function comparable(output) {
  const fullOutputPath = output.details?.fullOutputPath;
  if (!fullOutputPath) return output;
  const details = { ...output.details, fullOutputPath: '<capture>' };
  const content = output.content.map(part => part.type === 'text' ? { ...part, text: part.text.replace(fullOutputPath, '<capture>') } : part);
  try { return { ...output, content, details, capturedBytes: fs.readFileSync(fullOutputPath) }; }
  finally { fs.rmSync(fullOutputPath, { force: true }); }
}

test('five explicit pages read one full file and bounded windows with exact native output', async t => {
  const bytes = uniformLines(32768);
  const { file, read, reference } = fixture(t, bytes);
  const io = countNativeReads(t, file);
  const pages = [];
  for (const offset of [1, 401, 801, 1201, 1601]) pages.push(await readRange(read, offset, 400));
  assert.equal(io.full, bytes.length, 'only the first read builds an index');
  assert.ok(io.positioned > 0 && io.positioned < 768 * 1024, `four pages read ${io.positioned} B through positioned reads`);
  for (const [i, page] of pages.entries()) {
    assert.equal(page.details?.fullOutputPath, undefined);
    assert.deepEqual(page, await readRange(reference, i * 400 + 1, 400));
  }
});

test('indexed and legacy reads agree on Unicode, BOM, CRLF, empty EOF, long lines, and exact spill bytes', async t => {
  const source = Buffer.from(`\ufefffirst\r\n\n${'a'.repeat(65000)}${'👩‍💻é'.repeat(23000)}\r\nafter\n\next\r\n`);
  const { read, reference } = fixture(t, source);
  for (const [offset, limit] of [[1, 2], [2, 3], [3, 1], [4, 4], [7, 1], [2, undefined]]) {
    assert.deepEqual(comparable(await readRange(read, offset, limit)), comparable(await readRange(reference, offset, limit)));
  }
  await assert.rejects(readRange(read, 8, 1), /Offset 8 is beyond end of file \(7 lines total\)/);
});

test('invalid UTF-8 keeps legacy decoding and bypasses the range index', async t => {
  const bytes = uniformLines(3000);
  bytes[6] = 0xff;
  const { file, read, reference } = fixture(t, bytes);
  const io = countNativeReads(t, file);
  for (const offset of [1, 2]) assert.deepEqual(await readRange(read, offset, 1), await readRange(reference, offset, 1));
  assert.equal(io.full, bytes.length * 2);
  assert.equal(io.positioned, 0);
});

test('a same-size rewrite with restored mtime, then an atomic replacement, rebuilds the index', async t => {
  const bytes = uniformLines(3500);
  const { dir, file, read, reference } = fixture(t, bytes);
  const io = countNativeReads(t, file);
  await readRange(read, 1, 15);
  const previous = fs.statSync(file);
  const changed = Buffer.from(bytes);
  changed[4] = 10;
  changed[127] = 120;
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, previous.atime, previous.mtime);
  assert.deepEqual(await readRange(read, 2, 20), await readRange(reference, 2, 20));
  assert.equal(io.full, bytes.length * 2);

  const replacement = path.join(dir, 'replacement.txt');
  fs.writeFileSync(replacement, changed.subarray(240));
  fs.renameSync(replacement, file);
  assert.deepEqual(await readRange(read, 2, 20), await readRange(reference, 2, 20));
  assert.equal(io.full, bytes.length * 3 - 240);
});

test('mutation during a positioned read falls back on the same descriptor without stale offsets', async t => {
  const bytes = uniformLines(3500);
  const { file, read, reference } = fixture(t, bytes);
  const io = countNativeReads(t, file);
  await readRange(read, 400, 40);
  io.afterPositioned = () => {
    io.afterPositioned = undefined;
    const changed = Buffer.from(bytes);
    changed[4] = 10;
    fs.writeFileSync(file, changed);
  };
  assert.deepEqual(await readRange(read, 400, 40), await readRange(reference, 400, 40));
  assert.equal(io.full, bytes.length * 2, 'a mixed-version page is replaced by the legacy snapshot');
});

test('aborted positioned read releases its descriptor and retains the correct next page', async t => {
  const bytes = uniformLines(3500);
  const { file, read, reference } = fixture(t, bytes);
  const io = countNativeReads(t, file);
  await readRange(read, 400, 40);
  const controller = new AbortController();
  io.afterPositioned = () => {
    io.afterPositioned = undefined;
    controller.abort();
  };
  await assert.rejects(readRange(read, 400, 40, controller.signal), /Operation aborted/);
  assert.deepEqual(await readRange(read, 400, 40), await readRange(reference, 400, 40));
  assert.equal(io.full, bytes.length);
});
