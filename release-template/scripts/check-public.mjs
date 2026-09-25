#!/usr/bin/env node
// Public release checks deliberately print rules and paths, never matched values.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PUBLIC_BINARY_SHA256 = {
  // Pi 0.85.1 asset; byte-identical to fork origin d981de1229ef899957bbe968bc8dcda02a21f477.
  "core/coding-agent/src/modes/interactive/assets/clankolas.png": "169acd0dfe6fbb8d8742ed24a3fc654fd0b2e2d4223c733249c5493723f1b72d",
  "docs/assets/metrics-demo.png":
    "640054a295677ff9b522e30ac6a42612c16395ecc093ee7217780a668b00acf9",
  "release-template/docs/assets/metrics-demo.png":
    "640054a295677ff9b522e30ac6a42612c16395ecc093ee7217780a668b00acf9",
  "docs/assets/graph-demo.png":
    "e377cfea6d7f421fe0850ad1ebc1b866a7d908e0784f9e173a9cd475354c6c46",
  "release-template/docs/assets/graph-demo.png":
    "e377cfea6d7f421fe0850ad1ebc1b866a7d908e0784f9e173a9cd475354c6c46",
  "docs/assets/rat.gif":
    "5509522c162182f1d42e3cdc705f0cd5da93cf894bda8651dae0e550cb6bc1c6",
  "release-template/docs/assets/rat.gif":
    "5509522c162182f1d42e3cdc705f0cd5da93cf894bda8651dae0e550cb6bc1c6",
  "agent/extensions/pi-lens/grammars/tree-sitter-bash.wasm":
    "807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d",
  "agent/extensions/pi-lens/grammars/tree-sitter-css.wasm":
    "5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c",
  "agent/extensions/pi-lens/grammars/tree-sitter-html.wasm":
    "11b3405c1543fb012f5ed7f8ee73125076dce8b168301e1e787e4c717da6b456",
  "agent/extensions/pi-lens/grammars/tree-sitter-javascript.wasm":
    "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
  "agent/extensions/pi-lens/grammars/tree-sitter-json.wasm":
    "fdb5219abe058369e16897aaa11eecf47ef4f546752c3ddbac339cdd89e1e667",
  "agent/extensions/pi-lens/grammars/tree-sitter-python.wasm":
    "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
  "agent/extensions/pi-lens/grammars/tree-sitter-tsx.wasm":
    "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
  "agent/extensions/pi-lens/grammars/tree-sitter-typescript.wasm":
    "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
  "agent/extensions/pi-lens/grammars/tree-sitter-yaml.wasm":
    "e752dc21c3591df9b45692fe417d101f45d1828c28c44d79005f4066dc7e4e91",
  // Guardian's no-import kernels are source-built by scripts/guardian/build-wasm.mjs;
  // scanner acceptance also requires the checked-in manifest and source hashes below.
  "core/coding-agent/src/core/guardian/classifier.wasm":
    "d325cf354b67fa27ff46d0299bf01f50ca778d3c23ae7afccdd1785e0fb5626c",
  "core/coding-agent/src/core/guardian/similarity.wasm":
    "ac0f25247763dfd90bfb95b8c85bf0a01794ff330c2f0eb33338cddebf83ae52",
};

// Previously published import-free Guardian kernel, reviewed at 511b6f4.
// History-only: these bytes are NEVER accepted in the tree or index, where
// the current binary and matching source/build provenance remain mandatory.
const REVIEWED_HISTORICAL_GUARDIAN = Object.freeze({
  "core/coding-agent/src/core/guardian/similarity.wasm":
    "8c7650bb3c798e0c3c0c1d84d04b9c8e4b14ea3db29c66028ea36dd789850d95",
});

const MAX_BYTES = 8 * 1024 * 1024;
const runtimeDirs =
  /^(?:agent\/)?(?:sessions|memory|logs|backups|tasks|work|artifacts|worktrees|missions|local-models|project-intelligence|npm|node_modules)(?:\/|$)/i;
const sensitiveNames =
  /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|settings\.json|models(?:-store)?\.json|provider-health\.json|free-route-evidence\.json|live-model-catalog\.json|run-history\.jsonl|yunuspi-session-[^/]+\.html|pi-session-[^/]+-diagnostics\.json|api-key|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key|sqlite|db|jsonl|tar|tgz|zip|onnx|safetensors))$/i;
const placeholder =
  /^(?:|UNKNOWN|REDACTED|CHANGEME|YOUR[_ -].*|\$\{[^}]+\}|<[^>]+>|none|null|undefined|.*(?:synthetic|placeholder|example|dummy|fake|test|\.\.).*)$/i;
// A value that spells an environment-variable name is a reference, not a secret.
// Deliberately case-sensitive: a mixed-case token must never be exempted by shape.
const envReference = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const publishable = (value) => placeholder.test(value) || envReference.test(value);

function guardianWasmHasCurrentProvenance(name, data, digest) {
  if (!name.startsWith("core/coding-agent/src/core/guardian/") || !name.endsWith(".wasm")) return true;
  try {
    const directory = path.join(REPO_ROOT, "core/coding-agent/src/core/guardian");
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, "wasm-provenance.json"), "utf8"));
    const artifact = provenance?.artifacts?.[path.basename(name)];
    if (provenance?.format !== "yunuspi-guardian-wasm-provenance-v1" || provenance.buildCommand !== "node scripts/guardian/build-wasm.mjs" || provenance.target !== "wasm32-unknown-unknown") return false;
    if (artifact?.sha256 !== digest || artifact.bytes !== data.length || !Array.isArray(artifact.imports) || artifact.imports.length !== 0) return false;
    for (const [relativePath, expectedHash] of Object.entries(provenance.sources ?? {})) {
      const source = path.join(directory, path.basename(relativePath));
      if (createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== expectedHash) return false;
    }
    for (const [relativePath, expectedHash] of Object.entries(provenance.trainingSources ?? {})) {
      if (createHash("sha256").update(fs.readFileSync(path.join(REPO_ROOT, relativePath))).digest("hex") !== expectedHash) return false;
    }
    return Boolean(provenance.compiler && provenance.flags?.length && provenance.modelTraining && provenance.trainingData);
  } catch {
    return false;
  }
}

export function scanContent(name, data) {
  const findings = [];
  const add = (rule) => findings.push({ path: name, rule });
  if (data.length > MAX_BYTES) {
    add("oversized-unreviewed-file");
    return findings;
  }
  if (data.includes(0)) {
    const digest = createHash("sha256").update(data).digest("hex");
    if (PUBLIC_BINARY_SHA256[name] === digest && guardianWasmHasCurrentProvenance(name, data, digest))
      return findings;
    add("binary-unreviewed-file");
    return findings;
  }
  const text = data.toString("utf8");
  if (text.includes("\ufffd")) add("invalid-utf8");
  const patterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    [
      "provider-token",
      /\b(?:ak_[A-Za-z0-9_-]{24,}|sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{24,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36})\b/,
    ],
    ["bearer-credential", /\bBearer\s+eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ["credential-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i],
    [
      "personal-home-path",
      /(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)(?!user(?:[/\\]|\b)|example(?:[/\\]|\b)|runner(?:[/\\]|\b)|USERNAME\b)[A-Za-z0-9_.-]+[/\\]/,
    ],
    [
      "private-network-address",
      /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    ],
  ];
  for (const [rule, regex] of patterns) if (regex.test(text)) add(rule);
  const assignments =
    /["']?(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|password|passwd|authorization|bearer|namecheap[_-]?(?:user|username)|godaddy[_-]?(?:user|username))["']?\s*[:=]\s*["']([^"'\r\n]{1,512})["']/gi;
  for (const match of text.matchAll(assignments)) {
    if (
      [
        "config/models.example.json",
        "release-template/config/models.example.json",
      ].includes(name) &&
      /^[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)$/.test(match[1])
    )
      continue;
    // Chromium's documented legacy Linux derivation constant is public, not a user's password.
    // Exact path and value fingerprint: another credential in this file is still rejected.
    if (
      name === "agent/extensions/pi-web-access/chrome-cookies.ts" &&
      createHash("sha256").update(match[1]).digest("hex") ===
        "487ba2299be7f759d7c7bf6a4ac3a32cee81f1bb9332fc485947e32918864fb2"
    )
      continue;
    if (!publishable(match[1]) && !/^(?:Bearer )?\$\{/.test(match[1]))
      add("credential-literal");
  }
  // Shell/env assignments may be unquoted. Restrict names and syntax to avoid code expressions.
  const env =
    /^\s*(?:export\s+)?(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*([^\s'"#]+)\s*$/gm;
  for (const match of text.matchAll(env))
    if (!publishable(match[1]) && !match[1].startsWith("$"))
      add("credential-environment-literal");
  return findings;
}

export function scanPath(name) {
  const normalized = name.replaceAll("\\", "/");
  const bad =
    normalized.startsWith("/") || normalized.split("/").some((p) => p === "..");
  if (bad || normalized.split("/").includes(".git"))
    return [{ path: name, rule: "unsafe-path" }];
  const scoped = normalized.replace(/^(?:release-template|public-template)\//i, "");
  const packageOnly =
    /^(?:agent\/)?npm(?:\/(?:package\.json|package-lock\.json))?$/.test(
      scoped,
    );
  if (
    normalized.split("/").some(part => ["node_modules", "__pycache__"].includes(part)) ||
    (runtimeDirs.test(scoped) && !packageOnly) ||
    sensitiveNames.test(normalized)
  )
    return [{ path: name, rule: "private-runtime-file" }];
  return [];
}

export function scanTree(root) {
  const findings = [];
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      // Installed dependencies and build outputs are never published from a
      // working tree (both are gitignored here), so walking them only makes the
      // pre-push hook fail on every checkout that has run npm install. Tracked
      // copies of those paths are still caught by scanPath()/scanGit().
      if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === "__pycache__" || /^core\/[^/]+\/dist$/.test(name))) {
        continue;
      }
      if (!prefix && entry.name === ".git") continue;
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        findings.push({ path: name, rule: "symlink" });
        continue;
      }
      const forbidden = scanPath(name);
      findings.push(...forbidden);
      if (entry.isDirectory()) {
        if (!forbidden.length) walk(filename, name + "/");
      } else if (entry.isFile()) {
        if (fs.statSync(filename).size > MAX_BYTES)
          findings.push({ path: name, rule: "oversized-unreviewed-file" });
        else findings.push(...scanContent(name, fs.readFileSync(filename)));
      } else findings.push({ path: name, rule: "special-file" });
    }
  }
  walk(path.resolve(root));
  return findings;
}

export function scanGit(root, { history = true } = {}) {
  const git = (args, input) =>
    execFileSync("git", ["-C", root, ...args], {
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  const findings = [];
  // Scan the index, including ignored tracked files and staged-but-not-committed blobs.
  const records = git(["ls-files", "--stage", "-z"])
    .toString()
    .split("\0")
    .filter(Boolean);
  const objects = new Map();
  function inspect(mode, oid, filename, origin) {
    findings.push(...scanPath(filename).map((f) => ({ ...f, origin })));
    if (mode === "120000" || mode === "160000")
      findings.push({
        path: filename,
        rule: mode === "120000" ? "symlink" : "submodule",
        origin,
      });
    let paths = objects.get(oid);
    if (!paths) objects.set(oid, paths = new Map());
    // Content exemptions depend on the path (not just the blob's bytes).
    if (!paths.has(filename)) paths.set(filename, origin);
  }

  for (const record of records) {
    const m = /^(\d+) ([a-f0-9]+) \d\t([\s\S]+)$/.exec(record);
    if (m) inspect(m[1], m[2], m[3], "index");
  }
  if (history) {
    // Every reachable commit is checked: a removed secret still exists in Git history.
    const commits = git(["rev-list", "--all"])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const commit of commits) {
      const rows = git(["ls-tree", "-rz", "--full-tree", commit])
        .toString()
        .split("\0")
        .filter(Boolean);
      for (const row of rows) {
        const m = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (m) inspect(m[1], m[2], m[3], "history");
      }
      findings.push(
        ...scanContent(
          "(commit message)",
          git(["show", "-s", "--format=%B", commit]),
        ).map((f) => ({ ...f, origin: "history" })),
      );
    }
    const tags = git([
      "for-each-ref",
      "--format=%(objecttype) %(objectname)",
      "refs/tags",
    ])
      .toString()
      .trim()
      .split("\n");
    for (const tag of tags) {
      const match = /^tag ([a-f0-9]+)$/.exec(tag);
      if (match)
        findings.push(
          ...scanContent(
            "(annotated tag)",
            git(["cat-file", "tag", match[1]]),
          ).map((f) => ({ ...f, origin: "history" })),
        );
    }
  }
  // Batch Git plumbing instead of spawning two processes for every blob.
  // Bound each content batch so a large history does not require one huge buffer.
  const ids = [...objects.keys()];
  const sizes = ids.length ? git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], ids.join('\n') + '\n').toString().trim().split('\n') : [];
  let batch = [], batchBytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const data = git(['cat-file', '--batch'], batch.map(([oid]) => oid).join('\n') + '\n');
    let offset = 0;
    for (const [oid, size] of batch) {
      const headerEnd = data.indexOf(10, offset);
      if (headerEnd < 0 || data.toString('ascii', offset, headerEnd) !== `${oid} blob ${size}`)
        throw Error('Invalid Git batch response; publication blocked.');
      const end = headerEnd + 1 + size;
      if (end >= data.length || data[end] !== 10) throw Error('Truncated Git blob; publication blocked.');
      const content = data.subarray(headerEnd + 1, end);
      for (const [filename, origin] of objects.get(oid)) {
        const reviewedHistory = origin === "history" && Object.hasOwn(REVIEWED_HISTORICAL_GUARDIAN, filename)
          && createHash("sha256").update(content).digest("hex") === REVIEWED_HISTORICAL_GUARDIAN[filename];
        if (!reviewedHistory) findings.push(...scanContent(filename, content).map(f => ({ ...f, origin })));
      }
      offset = end + 1;
    }
    batch = []; batchBytes = 0;
  };
  for (let i = 0; i < ids.length; i++) {
    const match = /^([a-f0-9]+) (\d+)$/.exec(sizes[i] ?? '');
    if (!match || match[1] !== ids[i]) throw Error('Cannot inspect Git object; publication blocked.');
    const oid = ids[i], size = Number(match[2]);
    if (size > MAX_BYTES) {
      for (const [filename, origin] of objects.get(oid))
        findings.push({ path: filename, rule: 'oversized-unreviewed-file', origin });
      continue;
    }
    if (batchBytes + size > 16 * 1024 * 1024) flush();
    batch.push([oid, size]); batchBytes += size;
  }
  flush();
  return findings;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = path.resolve(process.argv[2] || ".");
    const findings = [
      ...scanTree(root),
      ...(fs.existsSync(path.join(root, ".git")) ? scanGit(root) : []),
    ];
    const unique = [
      ...new Map(findings.map((f) => [JSON.stringify(f), f])).values(),
    ];
    if (unique.length) {
      console.error(JSON.stringify({ ok: false, findings: unique }, null, 2));
      process.exitCode = 1;
    } else
      console.log(
        "Public safety checks passed (tree, index, reachable history where available). Manual review remains required.",
      );
  } catch (err) {
    const detail =
      err instanceof Error ? err.stack || err.message : String(err);
    if (detail) console.error(String(detail).slice(0, 2000));
    console.error(
      "Public safety scan could not complete; publication blocked.",
    );
    process.exitCode = 1;
  }
}
