#!/usr/bin/env node
/** Public SOURCE export, deliberately separate from credential-bearing backups.
 * Never prints matched private values. The live installation is read-only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {CORE_COMPATIBILITY_TESTS} from "./lib/core-compatibility.mjs";
const ownAgent = path.resolve(
 path.dirname(fileURLToPath(import.meta.url)),
 "..",
);
const args = process.argv.slice(2);
let source = ownAgent,
 output,
 templates;
for (let i = 0; i < args.length; i++) {
 if (["--source", "--output", "--templates"].includes(args[i]) && args[i + 1]) {
  const key = args[i++],
   value = path.resolve(args[i]);
  if (key === "--source") source = value;
  else if (key === "--output") output = value;
  else templates = value;
 } else
  throw Error(
   "Use --output NEW_DIRECTORY [--source AGENT_DIRECTORY] [--templates DIRECTORY]",
  );
}
if (!output)
 throw Error("--output is required; never export into the live installation.");
templates ??= fs.existsSync(path.join(source, "public-template"))
 ? path.join(source, "public-template")
 : path.resolve(source, "../release-template");
const within = (p, r) => p === r || p.startsWith(r + path.sep);
source = fs.realpathSync(source);
templates = fs.realpathSync(templates);
for (let at = output; ; at = path.dirname(at)) {
 if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink())
  throw Error("Output ancestor is a symlink");
 if (at === path.dirname(at)) break;
}
if (
 within(output, source) ||
 within(source, output) ||
 within(output, templates) ||
 within(templates, output)
)
 throw Error("Source/template/output overlap rejected");
if (
 fs.existsSync(output) &&
 (!fs.lstatSync(output).isDirectory() || fs.readdirSync(output).length)
)
 throw Error("Output must be absent or an empty directory.");
const secrets = new Set();
function gather(value, key = "") {
 if (typeof value === "string") {
  if (
   /^(?:api[_-]?key|api[_-]?secret|key|secret|password|passwd|access[_-]?token|refresh[_-]?token|access|refresh|accountId|token|authorization|cookie)$/i.test(
    key,
   ) &&
   value.length >= 8 &&
   !/^[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)$|^\$|^!/.test(value)
  )
   secrets.add(value);
 } else if (value && typeof value === "object")
  for (const [k, v] of Object.entries(value)) gather(v, k);
}
for (const name of ["auth.json", "models.json", "settings.json"]) {
 try {
  gather(JSON.parse(fs.readFileSync(path.join(source, name), "utf8")));
 } catch (error) {
  if (error.code !== "ENOENT")
   throw Error("Cannot safely read private configuration for leak checking");
 }
}
for (const [key, value] of Object.entries(process.env))
 if (
  /(?:API_KEY|SECRET|PASSWORD|TOKEN)$/.test(key) &&
  value &&
  value.length >= 12
 )
  secrets.add(value);
const sourceLive = fs.readFileSync(
 path.join(source, "extensions/live-models.ts"),
 "utf8",
);
const fallback = /const ORCA_FALLBACK_KEY = ("[^"\r\n]*"|'[^'\r\n]*');/.exec(
 sourceLive,
);
if (fallback) {
 const value = fallback[1].slice(1, -1);
 if (value.length >= 8) secrets.add(value);
}
const allowedExt = new Set([
 ".ts",
 ".js",
 ".mjs",
 ".cjs",
 ".json",
 ".jsonc",
 ".md",
 ".yml",
 ".yaml",
 ".toml",
 ".scm",
 ".wasm",
 ".gif",
 ".png",
 ".py",
 ".ipynb",
 ".sh",
 ".service",
 ".timer",
 ".path",
 ".apparmor",
]);
/** Executable source must resolve machine-specific paths at run time. A
 * literal author home path rewritten to the /home/example placeholder still
 * ships, but as dead code for every other installation, so the export stops
 * instead. Documentation and example configuration keep the substitution. */
const portableCodeExt = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".sh"]);
const omitted = new Set([
 "node_modules",
 ".git",
 "__pycache__",
 "sessions",
 "logs",
 "memory",
 "backups",
 "artifacts",
 "worktrees",
 "local-models",
]);
const stage = fs.mkdtempSync(
 path.join(path.dirname(output), ".yunuspi-public-"),
);
const files = [];
function put(rel, data, mode = 0o644) {
 const p = path.join(stage, rel);
 fs.mkdirSync(path.dirname(p), { recursive: true });
 fs.writeFileSync(p, data, { mode });
 files.push({
  path: rel,
  sha256: createHash("sha256").update(data).digest("hex"),
 });
}
function copyTree(dir, prefix) {
 for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (omitted.has(entry.name)) continue;
  const p = path.join(dir, entry.name),
   rel = prefix + "/" + entry.name,
   stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
   throw Error("Unreviewed link or special source file");
  if (stat.isDirectory()) {
   copyTree(p, rel);
   continue;
  }
  if (
   !allowedExt.has(path.extname(entry.name)) &&
   !/^(?:LICENSE|NOTICE|COPYING)(?:\..*)?$/.test(entry.name) &&
   ![".gitignore", "pre-push", "pre-commit"].includes(entry.name) &&
   !/^agent\/extensions\/lib\/project-intelligence\/viewer-assets\/(?:index\.html|styles\.css|CYTOSCAPE-LICENSE)$/.test(rel)
  )
   continue;
  let bytes = fs.readFileSync(p);
  if (!/\.(?:wasm|gif|png)$/.test(p)) {
   let text = bytes.toString("utf8");
   const home = os.homedir();
   if (text.includes(home)) {
    if (portableCodeExt.has(path.extname(entry.name)))
     throw Error(
      "Hardcoded home path in exported source; resolve it at run time instead: " +
       rel,
     );
    text = text.replaceAll(home, "/home/example");
   }
   if (rel === "agent/extensions/live-models.ts")
    text = text.replace(
     /const ORCA_FALLBACK_KEY = ("[^"\r\n]*"|'[^'\r\n]*');/,
     'const ORCA_FALLBACK_KEY = process.env.ORCAROUTER_API_KEY ?? "";',
    );
   if (/hardcoded-secrets.*\.ya?ml$/.test(rel))
    text = text.replace(
     /(\b(?:api_key|apiKey|password|secret)\s*[:=]\s*)(["'])([^"'\r\n]+)\2/g,
     "$1$2YOUR_SECRET$2",
    );
   for (const secret of secrets)
    if (text.includes(secret))
     throw Error("Private value detected in exported source: " + rel);
   bytes = Buffer.from(text);
  }
  put(rel, bytes, stat.mode & 0o111 ? 0o755 : 0o644);
 }
}
try {
 copyTree(path.join(source, "extensions"), "agent/extensions");
 copyTree(path.join(source, "skills"), "agent/skills");
 // Runtime scripts only. Historical benchmarks/session fixtures never enter a public release.
 for (const entry of fs.readdirSync(path.join(source, "scripts"), {
  withFileTypes: true,
 })) {
  if (
   entry.isFile() &&
   /\.(?:mjs|sh|py)$/.test(entry.name) &&
   entry.name !== "test-harness.mjs"
  ) {
   const temp = path.join(stage, ".single");
   fs.mkdirSync(temp);
   fs.copyFileSync(
    path.join(source, "scripts", entry.name),
    path.join(temp, entry.name),
   );
   copyTree(temp, "agent/scripts");
   fs.rmSync(temp, { recursive: true });
  }
 }
 for (const dir of ["patches", "lib"])
  if (fs.existsSync(path.join(source, "scripts", dir)))
   copyTree(path.join(source, "scripts", dir), "agent/scripts/" + dir);
 // The updater's synthetic compatibility gate is release code. Historical
 // benchmarks and private session fixtures stay outside this explicit list.
 if (fs.existsSync(path.join(source, "scripts/core-update.mjs"))) {
  const temp = path.join(stage, ".compatibility");
  fs.mkdirSync(temp);
  for (const name of CORE_COMPATIBILITY_TESTS)
   fs.copyFileSync(path.join(source, "scripts/compatibility", name), path.join(temp, name));
  copyTree(temp, "agent/scripts/compatibility");
  fs.rmSync(temp, { recursive: true });
 }
 for (const name of ["package.json", "package-lock.json"])
  put("agent/npm/" + name, fs.readFileSync(path.join(source, "npm", name)));
 // Mini service and machine-specific systemd installation are opt-in, not a source runtime dependency.
 const manifestPath = path.join(stage, "agent/extensions/manifest.json");
 const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
 manifest.supportFiles = (manifest.supportFiles ?? []).filter(
  (p) => !p.startsWith("scripts/systemd/"),
 );
 fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
 copyTree(templates, "release-template");
 // Copy template root entries while preserving dotfiles and all plain files.
 for (const entry of fs.readdirSync(templates, { withFileTypes: true })) {
  const p = path.join(templates, entry.name);
  if (entry.isSymbolicLink()) throw Error("Template symlink");
  if (entry.isDirectory()) copyTree(p, entry.name);
  else
   put(
    entry.name,
    fs.readFileSync(p),
    fs.statSync(p).mode & 0o111 ? 0o755 : 0o644,
   );
 }
 const { scanTree } = await import(
  pathToFileURL(path.join(stage, "scripts/check-public.mjs"))
 );
 const findings = scanTree(stage);
 if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }));
  throw Error("Public scan rejected export");
 }
 // Scan all final bytes, including templates and binary assets, against local exact credentials.
 for (const file of files) {
  const b = fs.readFileSync(path.join(stage, file.path));
  for (const secret of secrets)
   if (b.includes(Buffer.from(secret)))
    throw Error("Exact private-value leak rejected: " + file.path);
 }
 // POSIX rename atomically replaces an empty destination directory. A newly
 // nonempty directory or symlink fails instead of merging unscanned contents.
 fs.renameSync(stage, output);
 console.log(
  JSON.stringify({
   ok: true,
   output,
   files: files.length,
   privateConfigurationCopied: false,
  }),
 );
} finally {
 fs.rmSync(stage, { recursive: true, force: true });
}
