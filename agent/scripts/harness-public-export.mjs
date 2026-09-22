#!/usr/bin/env node
/** Public SOURCE export, deliberately separate from credential-bearing backups.
 * Never prints matched private values. The live installation is read-only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
templates ??= fs.existsSync(path.join(source, "runtime/release-template"))
 ? path.join(source, "runtime/release-template")
 : fs.existsSync(path.join(source, "public-template"))
 ? path.join(source, "public-template")
 : path.resolve(source, "../release-template");
const within = (p, r) => p === r || p.startsWith(r + path.sep);
function assertRegularDirectory(dir, label = "Source root") {
 const resolved = path.resolve(dir);
 const stat = fs.lstatSync(resolved);
 if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved)
  throw Error(`${label} must be a regular directory without symlink ancestors`);
}
function readRegularSource(file, label = "Source input") {
 const resolved = path.resolve(file);
 const stat = fs.lstatSync(resolved);
 if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved)
  throw Error(`${label} must be a regular file without symlink ancestors`);
 return fs.readFileSync(resolved);
}
function copyRegularSource(file, destination, label) {
 const bytes = readRegularSource(file, label);
 const mode = fs.lstatSync(path.resolve(file)).mode & 0o111 ? 0o755 : 0o644;
 fs.writeFileSync(destination, bytes, { mode });
}
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
const credentialKeys = new Set([
 "apikey", "apisecret", "key", "secret", "clientsecret", "privatekey",
 "password", "passwd", "accesstoken", "refreshtoken", "idtoken",
 "sessiontoken", "access", "refresh", "accountid", "token",
 "authorization", "cookie",
]);
function gather(value, key = "", headerValue = false) {
 if (typeof value === "string") {
  const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
  const credentialHeader = headerValue && /(?:apikey|apisecret|authkey|authtoken|accesstoken|refreshtoken|sessiontoken|subscriptionkey|authorization|cookie)$/.test(normalizedKey);
  if (
   (credentialKeys.has(normalizedKey) || credentialHeader) &&
   value.length >= 8 &&
   !/^[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)$|^\$|^!/.test(value)
  ) {
   secrets.add(value);
   // A diagnostic/source file can contain the credential without its HTTP
   // authentication scheme. Check both exact forms without treating ordinary
   // header values, public URLs or configuration prose as credentials.
   const token = /^(?:Bearer|Basic|Token|ApiKey)\s+(\S+)\s*$/i.exec(value)?.[1];
   if (token && token.length >= 8 && !/^[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)$|^\$|^!/.test(token)) secrets.add(token);
  }
 } else if (value && typeof value === "object")
  for (const [k, v] of Object.entries(value)) gather(v, k, /^(?:headers|httpheaders|requestheaders)$/i.test(key.replace(/[-_]/g, "")));
}
for (const name of ["auth.json", "models.json", "settings.json"]) {
 try {
  gather(JSON.parse(readRegularSource(path.join(source, name), "Private configuration").toString("utf8")));
 } catch (error) {
  if (error.code !== "ENOENT")
   throw Error("Cannot safely read private configuration for leak checking");
 }
}
for (const [key, value] of Object.entries(process.env))
 if (
  /(?:^|_)(?:API_KEY|API_SECRET|CLIENT_SECRET|PRIVATE_KEY|SECRET_ACCESS_KEY|SECRET|PASSWORD|PASSWD|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN|TOKEN)$/.test(key) &&
  value &&
  value.length >= 12
 )
  secrets.add(value);
const sourceLive = readRegularSource(
 path.join(source, "extensions/live-models.ts"),
 "Live model source",
).toString("utf8");
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
 // Guardian's WASM kernels are built from these checked-in C++ sources by
 // scripts/guardian/build-wasm.mjs. The public provenance gate verifies their
 // hashes, so the sources must ship with the binaries they produced.
 ".cpp",
 ".h",
]);
/** Executable source must resolve machine-specific paths at run time. A
 * literal author home path rewritten to the /home/example placeholder still
 * ships, but as dead code for every other installation, so the export stops
 * instead. Documentation and example configuration keep the substitution. */
const portableCodeExt = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".sh", ".service", ".cpp", ".h"]);
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
 assertRegularDirectory(dir, "Export source directory");
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
   !/^agent\/extensions\/lib\/project-intelligence\/viewer-assets\/(?:index\.html|styles\.css|CYTOSCAPE-LICENSE)$/.test(rel) &&
   !/^core\/coding-agent\/src\/core\/export-html\/template\.(?:html|css)$/.test(rel) &&
   rel !== "agent/skills/motion-graphics-production/assets/timeline-starter.html"
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
 assertRegularDirectory(path.join(source, "scripts"), "Runtime scripts root");
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
   copyRegularSource(path.join(source, "scripts", entry.name), path.join(temp, entry.name), "Runtime script");
   copyTree(temp, "agent/scripts");
   fs.rmSync(temp, { recursive: true });
  }
 }
 for (const dir of ["lib"])
  if (fs.existsSync(path.join(source, "scripts", dir)))
   copyTree(path.join(source, "scripts", dir), "agent/scripts/" + dir);
 // The updater's synthetic compatibility gate is release code. Historical
 // benchmarks and private session fixtures stay outside this explicit list.
 if (fs.existsSync(path.join(source, "scripts/core-update.mjs"))) {
  const temp = path.join(stage, ".compatibility");
  fs.mkdirSync(temp);
  for (const name of CORE_COMPATIBILITY_TESTS)
   copyRegularSource(path.join(source, "scripts/compatibility", name), path.join(temp, name), "Compatibility test");
  copyTree(temp, "agent/scripts/compatibility");
  fs.rmSync(temp, { recursive: true });
 }
 for (const name of ["package.json", "package-lock.json"])
  put("agent/npm/" + name, readRegularSource(path.join(source, "npm", name), "Agent npm manifest"));
 // Ship only the portable local-inference unit templates. Authentication,
 // weights, runtime descriptors and unrelated personal units remain private.
 const modelUnits = ["pi-mini-preprocessor.service", "pi-smol-preprocessor.service"];
 const shippedUnits = new Set();
 for (const name of modelUnits) {
  const file = path.join(source, "scripts/systemd", name);
  if (!fs.existsSync(file)) continue;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
   throw Error("Inference unit must be a regular source file");
  const temp = path.join(stage, ".model-unit");
  fs.mkdirSync(temp);
  copyRegularSource(file, path.join(temp, name), "Inference unit");
  copyTree(temp, "agent/scripts/systemd");
  fs.rmSync(temp, { recursive: true });
  shippedUnits.add(`scripts/systemd/${name}`);
 }
 const manifestPath = path.join(stage, "agent/extensions/manifest.json");
 const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
 manifest.supportFiles = (manifest.supportFiles ?? []).filter(
  (p) => !p.startsWith("scripts/systemd/") || shippedUnits.has(p),
 );
 fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
 copyTree(templates, "release-template");
 // Copy template root entries while preserving dotfiles and all plain files.
 for (const entry of fs.readdirSync(templates, { withFileTypes: true })) {
  if (omitted.has(entry.name)) continue;
  const p = path.join(templates, entry.name);
  if (entry.isSymbolicLink()) throw Error("Template symlink");
  if (entry.isDirectory()) copyTree(p, entry.name);
  else {
   if (!entry.isFile()) throw Error("Template input must be a regular file");
   put(
    entry.name,
    readRegularSource(p, "Template input"),
     fs.statSync(p).mode & 0o111 ? 0o755 : 0o644,
   );
  }
 }
 // Fork source is part of the product, never reconstructed from an upstream package.
 const productFile = path.join(stage, "package.json");
 const product = fs.existsSync(productFile) ? JSON.parse(fs.readFileSync(productFile, "utf8")) : {};
 if (product.workspaces?.includes("core/*")) {
  // Export the selected installation's actual owned source. Templates provide
  // the core only for a checkout source; they must not mask local core fixes.
  const coreSource = [path.join(source, "runtime/core"), path.resolve(source, "../core"), path.resolve(templates, "../core")]
   .find(dir => fs.existsSync(path.join(dir, "identity.json")));
  if (!coreSource) throw Error("Owned core source missing; export from a complete YunusPi checkout or installation");
  if (fs.realpathSync(coreSource) !== coreSource) throw Error("Owned core source contains a symlink ancestor");
  const readOwnedFile = file => readRegularSource(file, "Owned core input");
  const coreIdentity = JSON.parse(readOwnedFile(path.join(coreSource, "identity.json")).toString("utf8"));
  if (coreIdentity.releaseAuthority !== "yunusemrejr/yunuspi") throw Error("Unowned core release authority");
  put("core/identity.json", readOwnedFile(path.join(coreSource, "identity.json")));
  for (const entry of fs.readdirSync(coreSource, { withFileTypes: true })) {
   if (!entry.isDirectory() || !fs.existsSync(path.join(coreSource, entry.name, "package.json"))) continue;
   const owned = path.join(coreSource, entry.name);
   for (const name of ["package.json", "LICENSE", "README.md", "CHANGELOG.md"]) {
    if (fs.existsSync(path.join(owned, name))) put(`core/${entry.name}/${name}`, readOwnedFile(path.join(owned, name)));
   }
   for (const name of ["src", "docs"]) if (fs.existsSync(path.join(owned, name))) copyTree(path.join(owned, name), `core/${entry.name}/${name}`);
  }
 }
 // Generate the inventory only after both the sanitized source and mirrored
 // release template exist. The generated files are then included in the
 // public scan and final exact-secret check.
 const inventoryGenerator = path.join(stage, "agent/scripts/generate-capabilities-doc.mjs");
 // Minimal/older source trees can predate the inventory feature. Once its
 // catalog is registered, a missing generator must not publish stale docs.
 if (manifest.lib?.includes("harness-capabilities.ts") || fs.existsSync(inventoryGenerator)) {
 if (!fs.existsSync(inventoryGenerator)) throw Error("Capability inventory generator missing from source");
 const generation = spawnSync(process.execPath, [inventoryGenerator, "--root", stage], { stdio: "inherit" });
 if (generation.status !== 0) throw Error("Capability inventory generation failed");
 for (const rel of [
  "release-template/docs/CAPABILITIES.md",
  "release-template/docs/CAPABILITIES.json",
  "docs/CAPABILITIES.md",
  "docs/CAPABILITIES.json",
 ]) {
  const bytes = fs.readFileSync(path.join(stage, rel));
  const existing = files.find((file) => file.path === rel);
  if (existing) existing.sha256 = createHash("sha256").update(bytes).digest("hex");
  else files.push({ path: rel, sha256: createHash("sha256").update(bytes).digest("hex") });
 }
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
