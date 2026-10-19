import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

test("workspace facts map CI workflows and deploy-shaped scripts without running them", async (t) => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, ".github/workflows"), { recursive: true });
  await fs.writeFile(path.join(dir, ".github/workflows/ship.yml"), "name: ship\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n  deploy:\n    needs: build\n");
  await fs.writeFile(path.join(dir, ".github/workflows/nightly.yaml"), "on: [schedule, workflow_dispatch]\njobs:\n  sweep:\n    runs-on: x\n");
  await fs.mkdir(path.join(dir, "scripts"));
  for (const name of ["deploy-staging.sh", "build.sh", "release.mjs"]) await fs.writeFile(path.join(dir, "scripts", name), "exit 1\n");
  const facts = await workspaceFacts(dir);
  assert.deepEqual(facts.workflows.map((w) => [w.file, w.triggers, w.jobs]), [
    [".github/workflows/nightly.yaml", ["schedule", "workflow_dispatch"], ["sweep"]],
    [".github/workflows/ship.yml", ["push", "workflow_dispatch"], ["build", "deploy"]],
  ]);
  assert.deepEqual(facts.deployScripts, ["scripts/deploy-staging.sh", "scripts/release.mjs"]);
});

test("workflow discovery parses YAML forms and skips unsafe entries and deploy lookalikes", async (t) => {
  const dir = await temporary(t);
  const outside = await temporary(t);
  const workflows = path.join(dir, ".github/workflows");
  await fs.mkdir(workflows, { recursive: true });
  await fs.writeFile(path.join(workflows, "crlf.yml"), 'name: crlf\r\n"on": [push]\r\njobs:\r\n    build:\r\n        runs-on: x\r\n    lint:\r\n        runs-on: x\r\n');
  await fs.writeFile(path.join(workflows, "inline.yml"), "on: push # ci\njobs:\n  ship:\n    runs-on: x\n");
  await fs.writeFile(path.join(workflows, "broken.yml"), "on: [push\njobs: {\n");
  const triggers = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const jobs = Array.from({ length: 14 }, (_, i) => `j${i}`);
  await fs.writeFile(
    path.join(workflows, "caps.yml"),
    `on: [${triggers.join(", ")}]\njobs:\n  ${"x".repeat(70)}:\n    runs-on: x\n${jobs.map((j) => `  ${j}:\n    runs-on: x\n`).join("")}`,
  );
  const leak = path.join(outside, "leak.yml");
  await fs.writeFile(leak, "on: [push]\njobs:\n  leak:\n    runs-on: x\n");
  await fs.symlink(leak, path.join(workflows, "linked.yml"));
  execFileSync("mkfifo", [path.join(workflows, "pipe.yml")]);
  await fs.writeFile(path.join(workflows, "huge.yml"), `# ${"x".repeat(256 * 1024)}\non: [push]\n`);
  const scripts = path.join(dir, "scripts");
  await fs.mkdir(scripts);
  for (const name of ["deployment.sh", "release-notes.md", "deploy.log", "publish.test.ts", "redeploy.sh"])
    await fs.writeFile(path.join(scripts, name), "exit 1\n");
  await fs.symlink(leak, path.join(scripts, "deploy-linked.sh"));
  const facts = await workspaceFacts(dir);
  const found = Object.fromEntries(facts.workflows.map((w) => [w.file, w]));
  const rel = (name) => `.github/workflows/${name}`;
  assert.deepEqual(Object.keys(found).sort(), [rel("broken.yml"), rel("caps.yml"), rel("crlf.yml"), rel("inline.yml")]);
  assert.deepEqual(found[rel("broken.yml")], { file: rel("broken.yml"), error: "unparsed" });
  assert.deepEqual([found[rel("crlf.yml")].triggers, found[rel("crlf.yml")].jobs], [["push"], ["build", "lint"]]);
  assert.deepEqual([found[rel("inline.yml")].triggers, found[rel("inline.yml")].jobs], [["push"], ["ship"]]);
  assert.deepEqual(found[rel("caps.yml")].triggers, triggers.slice(0, 16));
  assert.equal(found[rel("caps.yml")].jobs.length, 12);
  assert.equal(found[rel("caps.yml")].jobs[0], "x".repeat(60));
  assert.deepEqual(facts.deployScripts, ["scripts/deployment.sh"]);
  assert.doesNotMatch(JSON.stringify(facts), /leak/);
});
