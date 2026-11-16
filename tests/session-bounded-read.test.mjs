import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEntriesFromFile } from "../core/coding-agent/src/core/session-manager.js";

const header = JSON.stringify({ type: "session", id: "fixture", version: 3, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/tmp/fixture" });
const entry = id => JSON.stringify({ type: "custom", id, parentId: null, customType: "fixture", timestamp: "2026-11-01T00:00:00.000Z" });
const snapshot = file => fs.lstatSync(file, { bigint: true });

function fixture(t, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-session-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const activeDir = path.join(directory, "active");
  fs.mkdirSync(activeDir);
  const file = path.join(activeDir, "fixture.jsonl");
  fs.writeFileSync(file, contents);
  return { directory, activeDir, file, expected: snapshot(file) };
}

function bounded(file, expected, { maxBytes = Number(expected.size), maxRecords = 10 } = {}) {
  return loadEntriesFromFile(file, { readOnly: true, bounds: { expected, maxBytes, maxRecords } });
}

function observeReads(t, afterFirstRead) {
  const original = fs.readSync;
  const calls = [];
  t.mock.method(fs, "readSync", function(fd, buffer, offset, length, position) {
    const bytes = original(fd, buffer, offset, length, position);
    calls.push({ length, bytes });
    if (calls.length === 1) afterFirstRead?.();
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test("bounded reading preserves fragmented UTF-8, skipped lines, and an unterminated final record", (t) => {
  const prefix = `${header}\r\n\nnot a JSON record\n{"type":"custom","id":"final","data":"`;
  const paddedLength = 1024 * 1024 - Buffer.byteLength(prefix) - 1;
  const fixtureText = `${prefix}${"x".repeat(paddedLength)}🙂"}`;
  const { file, expected } = fixture(t, fixtureText);
  const entries = bounded(file, expected, { maxRecords: 2 });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].data.length, paddedLength + 2);
  assert.equal(entries[1].data.slice(-2), "🙂");
  assert.throws(() => bounded(file, expected, { maxRecords: 1 }), { code: "SESSION_READ_RECORD_LIMIT" });
  assert.equal(snapshot(file).size, expected.size);
  assert.equal(snapshot(file).mtimeNs, expected.mtimeNs);

  assert.equal(loadEntriesFromFile(file, { readOnly: true }).length, 2);
  assert.equal(snapshot(file).size, expected.size);
  assert.equal(loadEntriesFromFile(file).length, 2);
  assert.equal(snapshot(file).size, expected.size + 1n, "legacy loading still repairs the terminal separator");
});

test("bounded reading rejects byte or record limits before scanning the remainder", (t) => {
  const { file, expected } = fixture(t, `${header}\n${entry("first")}\n${entry("second")}\n${"x".repeat(2 * 1024 * 1024)}`);
  const calls = observeReads(t);
  assert.throws(() => loadEntriesFromFile(file, { readOnly: true, bounds: null }), TypeError);
  assert.throws(() => bounded(file, expected, { maxBytes: Number(expected.size) - 1 }), { code: "SESSION_READ_BYTE_LIMIT" });
  assert.equal(calls.length, 0);
  assert.throws(() => bounded(file, expected, { maxRecords: 2 }), { code: "SESSION_READ_RECORD_LIMIT" });
  assert.equal(calls.length, 1);
  assert.ok(BigInt(calls[0].bytes) < expected.size);
});

test("a final symlink to the original inode is rejected after the path is swapped", (t) => {
  const { directory, activeDir, file, expected } = fixture(t, `${header}\n`);
  const parked = path.join(directory, "parked");
  fs.renameSync(activeDir, parked);
  fs.mkdirSync(activeDir);
  const target = path.join(parked, path.basename(file));
  assert.equal(snapshot(target).ctimeNs, expected.ctimeNs);
  fs.symlinkSync(target, file);
  const calls = observeReads(t);
  assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
  assert.equal(calls.length, 0);
  fs.unlinkSync(file);
  assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
});

test("a FIFO substituted for a regular file opens nonblocking and is never read", (t) => {
  const { file, expected } = fixture(t, `${header}\n`);
  fs.unlinkSync(file);
  execFileSync("mkfifo", [file], { timeout: 2000 });
  const open = fs.openSync;
  t.mock.method(fs, "openSync", function(target, flags, ...args) {
    if (target === file) assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
    return open(target, flags, ...args);
  });
  const calls = observeReads(t);
  assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
  assert.equal(calls.length, 0);
});

test("growth during the read cannot consume past the verified snapshot size", (t) => {
  const { file, expected } = fixture(t, `${header}\n${entry("before")}\n`);
  const calls = observeReads(t, () => fs.appendFileSync(file, `${entry("after")}\n`));
  assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
  assert.deepEqual(calls, [{ length: Number(expected.size), bytes: Number(expected.size) }]);
  assert.ok(snapshot(file).size > expected.size);
});

test("after-read validation rejects same-size rewrites and descriptor-stable path replacement", async (t) => {
  await t.test("same-size rewrite", (t) => {
    const original = `${header}\n${entry("before")}\n`;
    const { file, expected } = fixture(t, original);
    observeReads(t, () => {
      fs.writeFileSync(file, original.replace("before", "mutate"));
      fs.utimesSync(file, 1, 1);
    });
    assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
    assert.equal(snapshot(file).size, expected.size);
    assert.equal(snapshot(file).ino, expected.ino);
  });
  await t.test("directory swap with an unchanged file descriptor", (t) => {
    const { directory, activeDir, file, expected } = fixture(t, `${header}\n`);
    const parked = path.join(directory, "parked");
    observeReads(t, () => {
      fs.renameSync(activeDir, parked);
      fs.mkdirSync(activeDir);
      fs.writeFileSync(file, `${header}\n`);
    });
    assert.throws(() => bounded(file, expected), { code: "SESSION_READ_CHANGED" });
    const original = snapshot(path.join(parked, path.basename(file)));
    assert.equal(original.ino, expected.ino);
    assert.equal(original.ctimeNs, expected.ctimeNs);
    assert.notEqual(snapshot(file).ino, expected.ino);
  });
});
