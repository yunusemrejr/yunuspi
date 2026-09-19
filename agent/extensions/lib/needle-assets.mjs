/** Official Needle3 asset management: pinned revision, checksum manifest,
 * atomic installation and repair. No weights are committed; this module
 * fetches them from the official Hugging Face repo during setup/update.
 *
 * Upstream (verified 2026-09-19):
 * - GitHub source: https://github.com/cactus-compute/needle (there is no
 *   `Cactus-Compute/needle3` repo; "needle3" is the model generation)
 * - Official weights + engines: https://huggingface.co/Cactus-Compute/needle3
 * - License: Apache-2.0 (LICENSE ships beside the weights)
 * - WASM target: wasm/needle.js + wasm/needle.wasm + needle3.cact
 * - Native fallback: <platform>/needle CLI (e.g. linux-x86_64/needle)
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

export const NEEDLE_REPO = "Cactus-Compute/needle3";
/** Pinned upstream revision (immutable HF commit SHA). */
export const NEEDLE_REVISION = "b009f8937124b2d0458f4ed040c10c41fd2a0dfc";
export const NEEDLE_ENGINE_VERSION = "3.0.0";
export const NEEDLE_GENERATION = 3;

const baseUrl = () => `https://huggingface.co/${NEEDLE_REPO}/resolve/${NEEDLE_REVISION}`;

/** Pinned files: remote path, local name, expected bytes, sha256. */
export const NEEDLE_PINNED_FILES = [
  {
    remote: "wasm/needle.js",
    local: "needle.js",
    bytes: 62502,
    sha256: "d00ec67ec7e03e4720dfc6c3dad95a0540afd00169a983ce3fabcd7aeaa0fa93",
  },
  {
    remote: "wasm/needle.wasm",
    local: "needle.wasm",
    bytes: 679381,
    sha256: "9dc7a6982382df191f7d455e2baf4746ac21887ab3796f12c332aaab6c8f769a",
  },
  {
    remote: "needle3.cact",
    local: "needle3.cact",
    bytes: 35335380,
    sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  },
  {
    remote: "LICENSE",
    local: "LICENSE",
    bytes: 11358,
    sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  },
];

export const NEEDLE_MANIFEST_VERSION = 1;

export function needleAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function needleAssetDir(env = process.env) {
  return env.PI_NEEDLE_ASSETS || join(needleAgentDir(env), "local-models", "needle3");
}

export function expectedManifest() {
  return {
    version: NEEDLE_MANIFEST_VERSION,
    repo: NEEDLE_REPO,
    revision: NEEDLE_REVISION,
    engine: NEEDLE_ENGINE_VERSION,
    generation: NEEDLE_GENERATION,
    files: NEEDLE_PINNED_FILES.map(({ local, bytes, sha256 }) => ({ local, bytes, sha256 })),
  };
}

export async function readManifest(dir) {
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    const value = JSON.parse(raw);
    if (!value || value.version !== NEEDLE_MANIFEST_VERSION) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function hashFile(path, bytes) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest("hex"), expected: bytes };
}

/** Verify installed assets. `full` hashes every file (35MB weights take
 * ~100ms); otherwise sizes + manifest revision are checked. */
export async function verifyAssets(dir = needleAssetDir(), full = false) {
  const problems = [];
  const manifest = await readManifest(dir);
  if (!manifest) problems.push("manifest.json missing or unreadable (run repair)");
  if (manifest && manifest.revision !== NEEDLE_REVISION) {
    problems.push(`revision ${manifest.revision} does not match pinned ${NEEDLE_REVISION} (run repair)`);
  }
  for (const file of NEEDLE_PINNED_FILES) {
    const path = join(dir, file.local);
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        problems.push(`${file.local} is not a regular file`);
        continue;
      }
      if (info.size !== file.bytes) {
        problems.push(`${file.local} size ${info.size} != pinned ${file.bytes} (truncated?)`);
        continue;
      }
      if (full) {
        const { sha256 } = await hashFile(path, file.bytes);
        if (sha256 !== file.sha256) problems.push(`${file.local} sha256 mismatch (corrupt?)`);
      }
    } catch {
      problems.push(`${file.local} missing`);
    }
  }
  return { ok: problems.length === 0, dir, problems, manifest: manifest ?? null };
}

export async function downloadFile(url, dest, expected, fetchImpl, onProgress, retryDelayMs = 1000, downloadTimeoutMs = 120_000) {
  const { Readable } = await import("node:stream");
  const part = `${dest}.part`;
  // Resumable: long blob connections can drop mid-file (observed HF socket
  // resets on the 35MB weights). Retry with Range resume; the pinned
  // size+sha256 gate every attempt's result regardless.
  let attempt = 0;
  for (;;) {
    attempt++;
    let have = 0;
    try {
      have = (await stat(part)).size;
      if (have >= expected.bytes) {
        const existing = have === expected.bytes ? await hashFile(part, expected.bytes) : null;
        if (existing?.sha256 === expected.sha256) { await rename(part, dest); return; }
        await rm(part, { force: true });
        have = 0;
      }
    } catch {
      have = 0;
    }
    try {
      const signal = AbortSignal.timeout(downloadTimeoutMs);
      const response = await fetchImpl(url, {
        signal,
        redirect: "follow",
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      });
      if (!response.ok || !response.body) throw new Error(`download ${response.status} for ${url}`);
      const resumed = response.status === 206 && have > 0;
      if (response.status === 206) {
        const range = response.headers?.get("content-range");
        if (range !== `bytes ${have}-${expected.bytes - 1}/${expected.bytes}`) {
          await response.body.cancel().catch(() => {});
          await rm(part, { force: true });
          throw new Error(`invalid resume range for ${expected.local}`);
        }
      }
      if (!resumed && have > 0) {
        await rm(part, { force: true });
        have = 0;
      }
      let size = have;
      const sink = createWriteStream(part, { mode: 0o600, flags: resumed ? "a" : "w" });
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (chunks) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > expected.bytes + 1024) throw new Error(`oversized download for ${expected.local}`);
            onProgress?.(expected.local, size, expected.bytes);
            yield chunk;
          }
        },
        sink,
        { signal },
      );
      if (size !== expected.bytes) throw new Error(`${expected.local} size ${size} != pinned ${expected.bytes} (attempt ${attempt})`);
      const { sha256 } = await hashFile(part, expected.bytes);
      if (sha256 !== expected.sha256) {
        await rm(part, { force: true });
        throw new Error(`${expected.local} sha256 mismatch`);
      }
      await rename(part, dest);
      return;
    } catch (error) {
      if (attempt >= 4) {
        await rm(part, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

/** Install (or repair) assets atomically: download + verify into a sibling
 * stage directory, then swap. A failure or interruption never destroys the
 * previous working assets. Returns a human-readable receipt. */
export async function installAssets(options = {}) {
  const {
    agentDir = needleAgentDir(),
    fetchImpl = globalThis.fetch,
    onProgress = null,
    force = false,
    retryDelayMs = 1000,
    downloadTimeoutMs = 120_000,
  } = options;
  const dir = process.env.PI_NEEDLE_ASSETS || join(agentDir, "local-models", "needle3");
  if (!force) {
    const current = await verifyAssets(dir, true);
    if (current.ok) return { installed: false, dir, note: "assets already match the pinned manifest" };
  }
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  const stage = join(dirname(dir), `.needle3-stage-${process.pid}-${Date.now()}`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const file of NEEDLE_PINNED_FILES) {
      await downloadFile(`${baseUrl()}/${file.remote}`, join(stage, file.local), file, fetchImpl, onProgress, retryDelayMs, downloadTimeoutMs);
    }
    await writeFile(
      join(stage, "manifest.json"),
      `${JSON.stringify({ ...expectedManifest(), installedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const check = await verifyAssets(stage, true);
    if (!check.ok) throw new Error(`staged assets failed verification: ${check.problems.join("; ")}`);
    // Atomic swap with rollback: previous working assets survive any failure.
    const backup = `${dir}.prev-${process.pid}`;
    let hadPrevious = false;
    try {
      const info = await stat(dir);
      hadPrevious = info.isDirectory();
    } catch {
      hadPrevious = false;
    }
    if (hadPrevious) await rename(dir, backup);
    try {
      await rename(stage, dir);
    } catch (error) {
      if (hadPrevious) await rename(backup, dir).catch(() => {});
      throw error;
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true });
    return { installed: true, dir, note: `installed pinned ${NEEDLE_REVISION.slice(0, 12)} (${NEEDLE_PINNED_FILES.length} files)` };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function repairAssets(options = {}) {
  return installAssets({ ...options, force: true });
}

// CLI: node needle-assets.mjs <verify|install|repair|smoke|status> [--agent-dir PATH]
// Exit 0 on success; verify/smoke exit 2 when assets are missing or corrupt.
let invoked = false;
try {
  invoked = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
} catch {
  invoked = false;
}
if (invoked) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log("node needle-assets.mjs <verify|install|repair|smoke|status> [--agent-dir PATH]");
    process.exit(command === undefined ? 3 : 0);
  }
  let agentDir = needleAgentDir();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--agent-dir" && rest[i + 1]) agentDir = rest[++i];
    else if (rest[i] === "--help" || rest[i] === "-h") {
      console.log("node needle-assets.mjs <verify|install|repair|smoke|status> [--agent-dir PATH]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${rest[i]}`);
      process.exit(3);
    }
  }
  const dir = process.env.PI_NEEDLE_ASSETS || join(agentDir, "local-models", "needle3");
  try {
    if (command === "verify" || command === "status") {
      const result = await verifyAssets(dir, command === "verify");
      console.log(JSON.stringify({ command, ...result, manifest: result.manifest ? { revision: result.manifest.revision, installedAt: result.manifest.installedAt } : null }, null, 2));
      process.exit(result.ok ? 0 : 2);
    } else if (command === "install" || command === "repair") {
      const receipt = command === "install" ? await installAssets({ agentDir }) : await repairAssets({ agentDir });
      console.log(JSON.stringify({ command, ...receipt }));
      process.exit(0);
    } else if (command === "smoke") {
      const check = await verifyAssets(dir, false);
      if (!check.ok) {
        console.error(JSON.stringify({ command, ok: false, problems: check.problems }));
        process.exit(2);
      }
      const runtime = await import("./needle-runtime.ts");
      const handle = runtime.createNeedleRuntime({ assetDir: dir });
      handle.warmup();
      const deadline = Date.now() + 90000;
      let health = handle.health();
      while (health.state === "warming" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        health = handle.health();
      }
      const embedded = health.state === "healthy" || health.state === "degraded"
        ? await handle.embed(["needle smoke test"])
        : { ok: false, reason: health.state };
      const ranked = embedded.ok
        ? await handle.rank({ query: "browser screenshot", candidates: [{ id: "a", text: "take a browser screenshot" }, { id: "b", text: "bake bread" }], topK: 2 })
        : embedded;
      console.log(JSON.stringify({
        command,
        ok: ranked.ok === true,
        state: handle.health().state,
        dim: handle.health().dim,
        top: ranked.ok ? ranked.value.ranked[0]?.id : undefined,
        ...(!ranked.ok ? { reason: ranked.reason } : {}),
      }));
      await handle.shutdown();
      process.exit(ranked.ok ? 0 : 2);
    } else {
      console.error(`Unknown command: ${command ?? "(none)"}. Use verify|install|repair|smoke|status.`);
      process.exit(3);
    }
  } catch (error) {
    console.error(JSON.stringify({ command, ok: false, error: String(error?.message ?? error).slice(0, 300) }));
    process.exit(1);
  }
}
