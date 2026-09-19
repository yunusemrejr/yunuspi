import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.join(template, "..", "agent")]
  .find(candidate => fs.existsSync(path.join(candidate, "extensions/pi-memory/mutation.ts")));
const { acquireMemoryMutation } = await import(pathToFileURL(path.join(agent, "extensions/pi-memory/mutation.ts")));

test("memory mutation release tolerates an already-removed owner marker", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-lock-"));
  try {
    const release = await acquireMemoryMutation(directory);
    const lock = path.join(directory, ".mutation.lock");
    const owner = fs.readdirSync(lock)[0];
    fs.unlinkSync(path.join(lock, owner));
    assert.doesNotThrow(release);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("memory mutation release leaves another marker for explicit recovery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-lock-"));
  try {
    const release = await acquireMemoryMutation(directory);
    const lock = path.join(directory, ".mutation.lock");
    fs.writeFileSync(path.join(lock, "recovery-marker"), "manual recovery\n");
    assert.doesNotThrow(release);
    assert.deepEqual(fs.readdirSync(lock), ["recovery-marker"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
