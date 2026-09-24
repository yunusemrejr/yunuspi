/** Local language model (Qwen3.5-0.8B on llama.cpp): pinned assets, atomic
 * installation, systemd user service and retirement of the SmolLM2 selector.
 *
 * Why this model (measured 2026-09-25 on harness decisions, 4 CPU threads):
 * skill-hint relevance AUC 0.88 and 0.88 accuracy for Qwen3.5-0.8B, versus
 * 0.53 for SmolLM2-135M (chance), 0.47 for LFM2.5-350M and 0.85 for the 1.4x
 * slower LFM2.5-1.2B; it also picked exactly the failing-test lines from a
 * test log. p50 latency ~0.9 s per judgement, ~1.4 GB RSS at 4K context.
 * License: Apache-2.0 (Qwen/Qwen3.5-0.8B). Nothing is committed: weights and
 * the llama.cpp runtime download at install time and are checksum-pinned.
 *
 * CLI: node local-lm-assets.mjs <status|verify|install|repair|smoke|uninstall> [--agent-dir PATH] [--no-service]
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { downloadFile, needleAgentDir } from "./needle-assets.mjs";

export const LOCAL_LM_MODEL = "Qwen3.5-0.8B";
export const LOCAL_LM_PORT = 18736;
export const LOCAL_LM_ENDPOINT = `http://127.0.0.1:${LOCAL_LM_PORT}/completion`;
export const LOCAL_LM_DIRNAME = "qwen3.5-0.8b";
export const LOCAL_LM_SERVICE = "pi-local-lm.service";
const LLAMA_TAG = "b10878";
export const LOCAL_LM_PINNED_FILES = [
  {
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
    local: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
    bytes: 16813791,
    sha256: "adce157d6efde29bf6bd2d6d6c95df3f93f38c5c59ec8df2d2736c09e10dde13",
  },
  {
    url: "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q4_0.gguf",
    local: "Qwen3.5-0.8B-Q4_0.gguf",
    bytes: 563036064,
    sha256: "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf",
  },
];
const MANIFEST_VERSION = 1;

export function localLmDir(agentDir = needleAgentDir()) {
  return process.env.PI_LOCAL_LM_ASSETS || join(agentDir, "local-models", LOCAL_LM_DIRNAME);
}
const serverBinary = (dir) => join(dir, "runtime", `llama-${LLAMA_TAG}`, "llama-server");
const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyLocalLm(dir = localLmDir(), full = false) {
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); } catch { problems.push("manifest.json missing (run install)"); }
  for (const file of LOCAL_LM_PINNED_FILES.filter((entry) => entry.local.endsWith(".gguf"))) {
    try {
      const info = await stat(join(dir, file.local));
      if (info.size !== file.bytes) problems.push(`${file.local} size ${info.size} != pinned ${file.bytes}`);
      else if (full && await sha256File(join(dir, file.local)) !== file.sha256) problems.push(`${file.local} sha256 mismatch`);
    } catch { problems.push(`${file.local} missing`); }
  }
  if (!existsSync(serverBinary(dir))) problems.push("llama-server runtime missing");
  try {
    const runtime = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
    if (runtime.model !== LOCAL_LM_MODEL || runtime.endpoint !== LOCAL_LM_ENDPOINT) problems.push("runtime.json does not describe the pinned model");
  } catch { problems.push("runtime.json missing"); }
  return { ok: problems.length === 0, dir, problems, manifest: manifest ?? null };
}

function unitText(dir) {
  return `[Unit]
Description=YunusPi local language model (${LOCAL_LM_MODEL}, loopback only)
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
ExecStart=${serverBinary(dir)} --model ${join(dir, LOCAL_LM_PINNED_FILES[1].local)} --host 127.0.0.1 --port ${LOCAL_LM_PORT} --api-key-file ${join(dir, "api-key")} --parallel 1 --threads 4 --threads-batch 4 --ctx-size 4096 --n-predict 128 --no-webui --log-disable
WorkingDirectory=${dir}
Nice=10
CPUQuota=400%
MemoryMax=2G
TasksMax=32
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
Restart=on-failure
RestartSec=10
TimeoutStopSec=5

[Install]
WantedBy=default.target
`;
}

const systemctl = (...args) => spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 20_000 });

/** Stop and remove the retired SmolLM2 selector (service + weights). */
export async function retireSmol(agentDir = needleAgentDir()) {
  const notes = [];
  const unit = join(unitDir(), "pi-smol-preprocessor.service");
  if (existsSync(unit)) {
    systemctl("disable", "--now", "pi-smol-preprocessor.service");
    await rm(unit, { force: true });
    systemctl("daemon-reload");
    notes.push("stopped and removed pi-smol-preprocessor.service");
  }
  const old = join(agentDir, "local-models", "smollm2-135m");
  if (existsSync(old)) { await rm(old, { recursive: true, force: true }); notes.push("removed local-models/smollm2-135m"); }
  return notes;
}

export async function installLocalLm(options = {}) {
  const { agentDir = needleAgentDir(), fetchImpl = globalThis.fetch, force = false, service = true, onProgress = null } = options;
  const dir = localLmDir(agentDir);
  const notes = [];
  if (force || !(await verifyLocalLm(dir, true)).ok) {
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    const stage = join(dirname(dir), `.${LOCAL_LM_DIRNAME}-stage-${process.pid}-${Date.now()}`);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      for (const file of LOCAL_LM_PINNED_FILES) await downloadFile(file.url, join(stage, file.local), file, fetchImpl, onProgress, 1000, 900_000);
      await mkdir(join(stage, "runtime"), { recursive: true });
      const unpack = spawnSync("tar", ["-xzf", join(stage, LOCAL_LM_PINNED_FILES[0].local), "-C", join(stage, "runtime")], { encoding: "utf8" });
      if (unpack.status !== 0) throw new Error(`llama.cpp runtime could not be unpacked: ${String(unpack.stderr).slice(0, 200)}`);
      // The release tarball unpacks to build/bin or llama-<tag>; normalize.
      const unpacked = [join(stage, "runtime", `llama-${LLAMA_TAG}`), join(stage, "runtime", "build", "bin")].find((path) => existsSync(join(path, "llama-server")));
      if (!unpacked) throw new Error("llama-server not found in the pinned runtime archive");
      if (unpacked !== join(stage, "runtime", `llama-${LLAMA_TAG}`)) await rename(unpacked, join(stage, "runtime", `llama-${LLAMA_TAG}`));
      await rm(join(stage, LOCAL_LM_PINNED_FILES[0].local), { force: true });
      let apiKey = "";
      try { apiKey = (await readFile(join(dir, "api-key"), "utf8")).trim(); } catch { /* new key below */ }
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(apiKey)) apiKey = randomBytes(32).toString("hex");
      await writeFile(join(stage, "api-key"), `${apiKey}\n`, { mode: 0o600 });
      await writeFile(join(stage, "runtime.json"), `${JSON.stringify({ version: 2, enabled: true, model: LOCAL_LM_MODEL, endpoint: LOCAL_LM_ENDPOINT, apiKey, execution: "background", timeoutMs: 5000 }, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(stage, "manifest.json"), `${JSON.stringify({ version: MANIFEST_VERSION, model: LOCAL_LM_MODEL, llama: LLAMA_TAG, files: LOCAL_LM_PINNED_FILES.map(({ local, bytes, sha256 }) => ({ local, bytes, sha256 })), installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      const check = await verifyLocalLm(stage, true);
      if (!check.ok) throw new Error(`staged local model failed verification: ${check.problems.join("; ")}`);
      const backup = `${dir}.prev-${process.pid}`;
      const hadPrevious = existsSync(dir);
      if (hadPrevious) await rename(dir, backup);
      try { await rename(stage, dir); } catch (error) { if (hadPrevious) await rename(backup, dir).catch(() => {}); throw error; }
      if (hadPrevious) await rm(backup, { recursive: true, force: true });
      notes.push(`installed ${LOCAL_LM_MODEL} with llama.cpp ${LLAMA_TAG}`);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } else notes.push("assets already match the pinned manifest");
  if (service) {
    if (spawnSync("systemctl", ["--user", "--version"], { encoding: "utf8" }).status !== 0) notes.push("systemd user services unavailable; start llama-server manually (see docs/LOCAL-INTELLIGENCE.md)");
    else {
      await mkdir(unitDir(), { recursive: true });
      const unitPath = join(unitDir(), LOCAL_LM_SERVICE);
      const text = unitText(dir);
      let current = "";
      try { current = await readFile(unitPath, "utf8"); } catch { /* new unit */ }
      if (current !== text) { await writeFile(unitPath, text, { mode: 0o644 }); systemctl("daemon-reload"); }
      const started = systemctl("enable", "--now", LOCAL_LM_SERVICE);
      if (current && current !== text) systemctl("restart", LOCAL_LM_SERVICE);
      notes.push(started.status === 0 ? `service ${LOCAL_LM_SERVICE} enabled` : `service start failed: ${String(started.stderr).slice(0, 160)}`);
      notes.push(...await retireSmol(agentDir));
    }
  }
  await chmod(dir, 0o700).catch(() => {});
  return { dir, notes };
}

/** One real inference through the service: proves the model answers. */
export async function smokeLocalLm(agentDir = needleAgentDir(), timeoutMs = 60_000) {
  const dir = localLmDir(agentDir);
  const runtime = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const started = Date.now();
      const response = await fetch(runtime.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runtime.apiKey}` },
        body: JSON.stringify({ prompt: "Question: Is Paris the capital of France? Answer yes or no.\nAnswer:", n_predict: 2, temperature: 0 }), signal: AbortSignal.timeout(20_000) });
      if (response.ok) { const body = await response.json(); return { ok: /yes/i.test(String(body.content)), ms: Date.now() - started, answer: String(body.content).trim().slice(0, 20) }; }
      last = `http ${response.status}`;
    } catch (error) { last = String(error?.message ?? error).slice(0, 120); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, reason: last || "timeout" };
}

let invoked = false;
try { invoked = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { invoked = false; }
if (invoked) void (async () => {
  const [command, ...rest] = process.argv.slice(2);
  let agentDir = needleAgentDir(), service = true;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--agent-dir" && rest[i + 1]) agentDir = rest[++i];
    else if (rest[i] === "--no-service") service = false;
    else { console.error(`Unknown argument: ${rest[i]}`); process.exit(3); }
  }
  try {
    if (command === "status" || command === "verify") {
      const result = await verifyLocalLm(localLmDir(agentDir), command === "verify");
      const active = spawnSync("systemctl", ["--user", "is-active", LOCAL_LM_SERVICE], { encoding: "utf8" });
      console.log(JSON.stringify({ command, ...result, service: String(active.stdout).trim() || "unknown" }, null, 2));
      process.exit(result.ok ? 0 : 2);
    } else if (command === "install" || command === "repair") {
      console.log(JSON.stringify({ command, ...await installLocalLm({ agentDir, force: command === "repair", service }) }));
    } else if (command === "smoke") {
      const result = await smokeLocalLm(agentDir);
      console.log(JSON.stringify({ command, ...result }));
      process.exit(result.ok ? 0 : 2);
    } else if (command === "uninstall") {
      systemctl("disable", "--now", LOCAL_LM_SERVICE);
      await rm(join(unitDir(), LOCAL_LM_SERVICE), { force: true });
      await rm(localLmDir(agentDir), { recursive: true, force: true });
      console.log(JSON.stringify({ command, ok: true }));
    } else { console.error("node local-lm-assets.mjs <status|verify|install|repair|smoke|uninstall> [--agent-dir PATH] [--no-service]"); process.exit(3); }
  } catch (error) { console.error(JSON.stringify({ command, ok: false, error: String(error?.message ?? error).slice(0, 300) })); process.exit(1); }
})();
