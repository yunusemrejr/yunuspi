// Needle asset manager: pins, verification, atomic install, CLI contracts.
// No network: downloads are mocked. The live download path is verified by
// the installer smoke run, not by committed tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

test("installAssets repairs same-size corruption instead of trusting manifest", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-ai-"));
  const dir = path.join(agentDir, "local-models", "needle3");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of assets.NEEDLE_PINNED_FILES) {
    fs.writeFileSync(path.join(dir, file.local), Buffer.alloc(file.bytes));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...assets.expectedManifest(), installedAt: "test" }));
  let fetched = 0;
  await assert.rejects(assets.installAssets({ agentDir, retryDelayMs: 1, fetchImpl: async () => { fetched++; throw new Error("repair requested"); } }), /repair requested/);
  assert.equal(fetched, 4);
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

test("CLI smoke evaluates the real runtime and reports corrupt same-size assets without an import deadlock", (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-cli-cycle-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const dir = path.join(agentDir, "local-models/needle3");
  fs.mkdirSync(dir, { recursive: true });
  // Sparse synthetic files pass the CLI's size preflight, then the real
  // worker must reject their hashes before evaluating any engine loader.
  for (const file of assets.NEEDLE_PINNED_FILES) {
    const fd = fs.openSync(path.join(dir, file.local), "w");
    try { fs.ftruncateSync(fd, file.bytes); } finally { fs.closeSync(fd); }
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(assets.expectedManifest()));
  const smoke = spawnSync(process.execPath, [cli, "smoke", "--agent-dir", agentDir], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, PI_NEEDLE_ASSETS: dir, PI_NEEDLE: "on", PI_NEEDLE_RESTARTS: "0" },
  });
  assert.equal(smoke.error, undefined, smoke.error?.message);
  assert.equal(smoke.status, 2, smoke.stderr);
  const report = JSON.parse(smoke.stdout);
  assert.equal(report.command, "smoke");
  assert.equal(report.ok, false);
  assert.equal(report.state, "cooling");
  assert.equal(report.reason, "cooling");
  assert.equal(report.dim, 0);
  assert.doesNotMatch(smoke.stderr, /unsettled top-level await/i);
});

test("CLI smoke embeds and ranks with explicitly supplied installed pinned assets", {
  skip: !process.env.PI_NEEDLE_TEST_ASSETS,
}, () => {
  const smoke = spawnSync(process.execPath, [cli, "smoke"], {
    encoding: "utf8", timeout: 100000,
    env: { ...process.env, PI_NEEDLE_ASSETS: process.env.PI_NEEDLE_TEST_ASSETS, PI_NEEDLE: "on" },
  });
  assert.equal(smoke.error, undefined, smoke.error?.message);
  assert.equal(smoke.status, 0, smoke.stderr);
  const report = JSON.parse(smoke.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.state, "healthy");
  assert.equal(report.dim, 3072);
  assert.equal(report.top, "a");
});

const downloadFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needle-download-"));
  const body = Buffer.from("verified pinned bytes");
  return { dir, dest: path.join(dir, "model"), body, expected: { local: "model", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") } };
};

test("download retries same-size corruption from zero instead of resuming poison", async () => {
  const { dest, body, expected } = downloadFixture();
  const ranges = [];
  await assets.downloadFile("https://example.invalid/model", dest, expected, async (_url, options) => {
    ranges.push(options.headers.Range);
    return new Response(ranges.length === 1 ? Buffer.alloc(body.length) : body);
  }, null, 1);
  assert.deepEqual(ranges, [undefined, undefined]);
  assert.deepEqual(fs.readFileSync(dest), body);
});

test("download resumes only matching Content-Range responses", async () => {
  const { dest, body, expected } = downloadFixture();
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 5));
  await assets.downloadFile("https://example.invalid/model", dest, expected, async (_url, options) => {
    assert.equal(options.headers.Range, "bytes=5-");
    return new Response(body.subarray(5), { status: 206, headers: { "content-range": `bytes 5-${body.length - 1}/${body.length}` } });
  }, null, 1);
  assert.deepEqual(fs.readFileSync(dest), body);
});

test("download rejects mismatched ranges then retries cleanly", async () => {
  const { dest, body, expected } = downloadFixture();
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 5));
  let attempts = 0;
  await assets.downloadFile("https://example.invalid/model", dest, expected, async () => {
    attempts++;
    return attempts === 1 ? new Response(body.subarray(5), { status: 206, headers: { "content-range": "bytes 0-15/21" } }) : new Response(body);
  }, null, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(fs.readFileSync(dest), body);
});


test("download has bounded abortable attempts when the server never responds", async () => {
  const { dest, expected } = downloadFixture();
  let attempts = 0;
  await assert.rejects(assets.downloadFile("https://example.invalid/model", dest, expected, async (_url, { signal }) => {
    attempts++;
    return new Promise((_resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("abort was not delivered")), 1000);
      signal.addEventListener("abort", () => { clearTimeout(deadline); reject(signal.reason); }, { once: true });
    });
  }, null, 1, 10), /timeout|aborted/i);
  assert.equal(attempts, 4);
  assert.equal(fs.existsSync(`${dest}.part`), false);
});
