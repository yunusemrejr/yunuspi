// Needle asset manager: pins, verification, atomic install, CLI contracts.
// No network: downloads are mocked. The live download path is verified by
// the installer smoke run, not by committed tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/needle-assets.mjs")),
);
const assets = await import(pathToFileURL(path.join(agent, "extensions/lib/needle-assets.mjs")));
const cli = path.join(agent, "extensions/lib/needle-assets.mjs");

test("pins are well-formed and immutable", () => {
  assert.equal(assets.NEEDLE_REPO, "Cactus-Compute/needle3");
  assert.match(assets.NEEDLE_REVISION, /^[0-9a-f]{40}$/);
  assert.ok(assets.NEEDLE_PINNED_FILES.length >= 3);
  const names = assets.NEEDLE_PINNED_FILES.map((f) => f.local);
  assert.ok(names.includes("needle.js") && names.includes("needle.wasm") && names.includes("needle3.cact"));
  for (const file of assets.NEEDLE_PINNED_FILES) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.local} pins a sha256`);
    assert.ok(file.bytes > 0, `${file.local} pins a size`);
    assert.ok(!file.remote.includes(".."), "no path traversal in remote names");
    assert.ok(!file.local.includes("/") && !file.local.includes(".."), "flat local names");
  }
  const manifest = assets.expectedManifest();
  assert.equal(manifest.revision, assets.NEEDLE_REVISION);
  assert.equal(manifest.files.length, assets.NEEDLE_PINNED_FILES.length);
});

test("verifyAssets reports every missing file on an empty dir", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "needle-av-")), "needle3");
  const result = await assets.verifyAssets(dir, true);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("manifest.json")));
  assert.ok(result.problems.some((p) => p.includes("needle3.cact missing")));
});

test("verifyAssets detects size mismatch (truncation)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-av-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, revision: assets.NEEDLE_REVISION }));
  fs.writeFileSync(path.join(dir, "needle.js"), Buffer.alloc(100));
  const result = await assets.verifyAssets(dir, false);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("needle.js") && p.includes("!=")));
});

test("installAssets rejects oversized mocks and keeps previous assets", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-ai-"));
  const dir = path.join(agentDir, "local-models", "needle3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sentinel.txt"), "previous");
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start: (controller) => {
        controller.enqueue(Buffer.alloc(70000, 1));
        controller.close();
      },
    }),
  });
  await assert.rejects(assets.installAssets({ agentDir, fetchImpl, retryDelayMs: 5 }), /oversized|sha256|size/);
  assert.equal(fs.readFileSync(path.join(dir, "sentinel.txt"), "utf8"), "previous");
  assert.ok(!fs.existsSync(path.join(dir, "manifest.json")));
  assert.equal(fs.readdirSync(path.join(agentDir, "local-models")).filter((n) => n.startsWith(".needle3-stage-")).length, 0);
});

test("installAssets network failure leaves no trace", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-ai-"));
  const fetchImpl = async () => { throw new Error("boom"); };
  await assert.rejects(assets.installAssets({ agentDir, fetchImpl, retryDelayMs: 5 }), /boom/);
  const models = path.join(agentDir, "local-models");
  assert.ok(!fs.existsSync(models) || fs.readdirSync(models).length === 0);
});

test("installAssets short-circuits when sizes and manifest match", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-ai-"));
  const dir = path.join(agentDir, "local-models", "needle3");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of assets.NEEDLE_PINNED_FILES) {
    fs.writeFileSync(path.join(dir, file.local), Buffer.alloc(file.bytes));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...assets.expectedManifest(), installedAt: "test" }));
  let fetched = 0;
  const receipt = await assets.installAssets({ agentDir, fetchImpl: async () => { fetched++; throw new Error("must not fetch"); } });
  assert.equal(receipt.installed, false);
  assert.equal(fetched, 0);
});

test("CLI status/verify exit 2 on missing assets, help exits 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-cli-"));
  const status = spawnSync(process.execPath, [cli, "status", "--agent-dir", dir], { encoding: "utf8" });
  assert.equal(status.status, 2);
  assert.match(status.stdout, /"ok": false/);
  const verify = spawnSync(process.execPath, [cli, "verify", "--agent-dir", dir], { encoding: "utf8" });
  assert.equal(verify.status, 2);
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  const bad = spawnSync(process.execPath, [cli, "frobnicate", "--agent-dir", dir], { encoding: "utf8" });
  assert.equal(bad.status, 3);
});

test("CLI smoke exits 2 without assets (no hang, no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-cli-"));
  const smoke = spawnSync(process.execPath, [cli, "smoke", "--agent-dir", dir], { encoding: "utf8", timeout: 30000 });
  assert.equal(smoke.status, 2);
});
