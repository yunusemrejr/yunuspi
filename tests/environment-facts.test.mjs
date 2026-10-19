import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, ".."), path.resolve(root, "../..")]
  .find((dir) => existsSync(path.join(dir, "scripts/workspace-facts.mjs")));
assert.ok(agent, "find live or exported agent sources");
const { workspaceFacts } = await import(pathToFileURL(path.join(agent, "scripts/workspace-facts.mjs")));

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yunuspi-environment-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}






test("workspace deployment and embedded hints preserve unknown authority and omit config contents", async (t) => {
  const dir = await temporary(t);
  for (const marker of ["compose.yml", "vercel.json", ".cpanel.yml", "platformio.ini", "sdkconfig.defaults", "sketch.yaml", "pico_sdk_import.cmake", "west.yml"])
    await fs.writeFile(path.join(dir, marker), "PRIVATE-CONFIG\n");
  await fs.mkdir(path.join(dir, "public_html"));
  const facts = await workspaceFacts(dir);
  assert.equal(facts.environmentEvidence.length, 8);
  assert.equal(facts.authority, "unresolved");
  assert.ok(facts.environmentEvidence.every((x) => x.verified === false));
  assert.match(facts.environmentGuidance.join(" "), /compile-only.*upload/);
  assert.match(facts.environmentGuidance.join(" "), /databases and user uploads/);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE-CONFIG/);
  assert.ok(JSON.stringify(facts).length <= facts.limits.outputChars);
  await fs.unlink(path.join(dir, "platformio.ini"));
  await fs.symlink(path.join(dir, "vercel.json"), path.join(dir, "platformio.ini"));
  assert.ok(!(await workspaceFacts(dir)).environmentEvidence.some((x) => x.candidate === "PlatformIO"));
  const generic = path.join(dir, "generic");
  await fs.mkdir(generic);
  await fs.writeFile(path.join(generic, "CMakeLists.txt"), "generic build");
  assert.deepEqual((await workspaceFacts(generic)).environmentEvidence, []);
  const spoofed = path.join(dir, 'spoofed');
  await fs.mkdir(spoofed);
  for (const name of ['package.json', 'platformio.ini', 'vercel.json']) await fs.mkdir(path.join(spoofed, name));
  for (const name of ['public_html', 'src']) await fs.writeFile(path.join(spoofed, name), 'PRIVATE-NOT-A-DIRECTORY');
  const invalidKinds = await workspaceFacts(spoofed);
  assert.deepEqual(invalidKinds.manifests, []);
  assert.deepEqual(invalidKinds.directories, []);
  assert.deepEqual(invalidKinds.environmentEvidence, []);
});
