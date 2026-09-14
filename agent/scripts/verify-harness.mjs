#!/usr/bin/env node
/**
 * Pi harness verifier — THE single authority for harness integrity.
 *
 * Run after ANY pi / pi-coding-agent / extension npm update (and any time
 * behavior seems off). This file checks; the actual repair logic for every
 * node_modules patch lives in scripts/patches/<name>.mjs modules. There are
 * NO inline patch-application blocks in this file anymore (2026-08-31: the
 * old [2] moderation and [2b] thinking-reflow inline blocks were moved into
 * retry-429-policy.mjs and thinking-reflow.mjs — two mechanisms editing one
 * file is how drift happens).
 *
 * Patch module contract (scripts/patches/*.mjs):
 *   export function targets(): [{ name, exists(), isApplied(), apply() }]
 * Every module is auto-discovered and run through checkPatch() below — a new
 * patch file is verified the moment it lands, no second registry to update.
 *
 * Lifecycle (deterministic, idempotent):
 *   UPDATE  auto-update.sh            (systemd pi-auto-update.timer 06:23)
 *   VERIFY  verify-harness.mjs --fix  (re-apply wiped patches, prune, drift)
 *   BACKUP  harness-backup.mjs        (/harness-backup command)
 * Updates invoke verification; backups are an explicit user command.
 * --fix exits 0 only when the final checked state is clean.
 *
 * Usage:
 *   node ~/.pi/agent/scripts/verify-harness.mjs            # check only
 *   node ~/.pi/agent/scripts/verify-harness.mjs --fix      # repair what it can
 *   node ~/.pi/agent/scripts/verify-harness.mjs --smoke    # check + live smoke test (1 tiny LLM call)
 *
 * Exit code 0 = final state clean (including after --fix repairs);
 * 1 = issues remain (needs attention, or repaired-but-verify-again).
 */

import { execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launcherSpec, activePiProcesses } from "./core-update.mjs";

// WHY promisified execFile over a hand-rolled spawn wrapper: the runtime
// already gives timeout (SIGTERM after N ms), maxBuffer output capping, and
// a rejection path that surfaces stderr — the 35-line wrapper it replaces
// re-implemented all three and was used by exactly one caller.
const execFileP = promisify(execFile);

// Syntax-only checks: never import Python or start a service while verifying.
async function checkSourceSyntax(file) {
  const options = { timeout: 30_000, maxBuffer: 1_000_000 };
  if (file.endsWith(".json")) JSON.parse(fs.readFileSync(file, "utf8"));
  else if (file.endsWith(".py")) await execFileP("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_bytes(), filename=sys.argv[1])", file], options);
  else if (file.endsWith(".sh")) await execFileP("/bin/bash", ["-n", file], options);
  else if (file.endsWith(".service")) await execFileP("systemd-analyze", ["--user", "verify", file], options);
  else if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file)) await execFileP("node", ["--experimental-strip-types", "--check", file], options);
  else throw new Error("Unsupported syntax verifier for " + path.extname(file));
}

const HOME = os.homedir();
const AGENT_DIR = path.join(HOME, ".pi", "agent");
const EXT_DIR = path.join(AGENT_DIR, "extensions");
const NPM_DIR = path.join(AGENT_DIR, "npm");

const args = new Set(process.argv.slice(2));
const FIX = args.has("--fix");
const SMOKE = args.has("--smoke");
const STAGED = args.has("--staged");

let failures = 0;
let repaired = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const fixed = (msg) => {
  repaired++;
  console.log(`  ✓ ${msg}`);
};
const info = (msg) => console.log(`  · ${msg}`);

// ── Load-state truth tables (single source: extensions/manifest.json) ─
// WHY a manifest: the fork migration retired the npm copies of these
// packages; the ONLY way an update resurrects them is package.json
// (npm install) or settings.packages (pi loads them). All asserted in
// sections [1]/[2] must fail loudly so re-introduction is a conscious edit
// of the manifest. Retiring an extension now means ONE change: delete the
// file on disk AND its entry here — the inventory is never hard-coded in
// this file (that is how lists go stale — see the manifest retired[] tombstones
// for the 2026-08-31 lesson).
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

/** Load the canonical extension inventory (extensions/manifest.json).
 *  Returns {ok, ...arrays}; on missing/corrupt manifest the inventory is
 *  empty and sections [1]/[2] degrade to a clear failure + skip (never a
 *  fake pass, never a TypeError crash). */
function loadManifest() {
  const empty = {
    ok: false,
    extensions: [],
    lib: [],
    forks: {},
    foldedMarkers: [],
    npmPackages: [],
    vendoredDeps: [],
    retired: [],
  };
  let raw;
  try {
    raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  } catch {
    bad(
      `canonical manifest missing: ${MANIFEST_PATH} — restore it (delete nothing silently: an empty manifest would pass everything)`,
    );
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    bad(`canonical manifest corrupt: ${MANIFEST_PATH} — ${e.message}`);
    return empty;
  }
  const problems = [];
  if (!Array.isArray(data.extensions)) problems.push("extensions[]");
  if (!Array.isArray(data.lib)) problems.push("lib[]");
  if (
    data.supportFiles !== undefined &&
    (!Array.isArray(data.supportFiles) ||
      data.supportFiles.some(
        (p) =>
          typeof p !== "string" ||
          path.isAbsolute(p) ||
          p.split(/[\\/]/).includes(".."),
      ))
  )
    problems.push("supportFiles[]");
  if (
    !data.forks ||
    typeof data.forks !== "object" ||
    Array.isArray(data.forks)
  )
    problems.push("forks{}");
  if (!Array.isArray(data.foldedMarkers)) problems.push("foldedMarkers[]");
  if (!Array.isArray(data.npmPackages)) problems.push("npmPackages[]");
  if (!Array.isArray(data.vendoredDeps)) problems.push("vendoredDeps[]");
  if (!Array.isArray(data.retired)) problems.push("retired[]");
  if (problems.length > 0) {
    bad(
      `canonical manifest missing keys: ${MANIFEST_PATH} — ${problems.join(", ")}`,
    );
    return empty;
  }
  return { ...data, ok: true };
}

// WHY an example name is NOT used here: this file is itself a scan target
// for the retired-name check below, so code comments must stay name-free.

/** Component-boundary matcher for a retired name. Hyphens, dots and
 * underscores belong to filenames, so a newer prefixed filename must not
 * count as resurrection of an unrelated retired basename. The one glob form
 *  matches both the literal prose form (asterisk, as in the provider
 *  auto-catalog set) and real files of that family. */
function retireNameRe(name) {
  const core = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, "(?:[a-z0-9-]+|\\*)");
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${core}(?:$|[^A-Za-z0-9_.-])`);
}

/** A mention of a retired name counts as a deletion record ONLY when the
 *  same line (or, for .md files, the enclosing section heading) reads as
 *  one — e.g. the "Deleted systems / do not recreate" and changelog
 *  sections legitimately name retired things. */
const RETIRE_RECORD_RE =
  /retir|delet|remov|supersed|orphan|no longer|never expected|do not recreate|scrub|dropped|moved to backups|changelog|changes \(/i;

/** Registries/docs scanned for stale mentions of retired components. History
 *  (memory/, backups/, sessions/, artifacts/, missions/) is excluded on
 *  purpose: past-tense journals legitimately name retired things. */
function retireDocFiles() {
  const files = [];
  for (const md of ["HARNESS-MAINTENANCE.md", "EXTENSION-FORK-PLAN.md"]) {
    const p = path.join(AGENT_DIR, md);
    if (fs.existsSync(p)) files.push(p);
  }
  for (const dir of ["scripts", path.join("scripts", "patches")]) {
    const p = path.join(AGENT_DIR, dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      if (/\.(mjs|sh)$/.test(f)) files.push(path.join(p, f));
    }
  }
  return files.sort();
}

/** Retired component resurrected on disk? Checks the live extension roots —
 *  any file/dir whose name matches (glob-aware). */
function retireResurrections(name) {
  const re = retireNameRe(name);
  const hits = [];
  for (const [label, dir] of [
    ["extensions", EXT_DIR],
    ["extensions/lib", path.join(EXT_DIR, "lib")],
    ["npm/node_modules", path.join(NPM_DIR, "node_modules")],
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      if (re.test(f)) hits.push(`${label}/${f}`);
    }
  }
  return hits;
}

/** Shared runner for the patch-registry section: import a patch module and
 *  check/fix every exported target. With --fix, a successful re-apply counts
 *  as repaired (not failed) so the run exits 0 on a clean final state. */
async function checkPatch(file, label) {
  let patch;
  try {
    patch = await import(path.join(AGENT_DIR, "scripts", "patches", file));
  } catch (e) {
    bad(`${label}: module failed to load — ${String(e.message ?? e)}`);
    return;
  }
  if (typeof patch.targets !== "function") {
    bad(`${label}: module violates the targets() contract`);
    return;
  }
  let targets;
  try {
    targets = patch.targets();
  } catch (e) {
    bad(`${label}: targets() threw — ${String(e.message ?? e)}`);
    return;
  }
  if (!Array.isArray(targets)) {
    bad(`${label}: targets() must return an array — fix the patch module`);
    return;
  }
  if (targets.length === 0) {
    bad(`${label}: no targets found (package missing / layout changed)`);
    return;
  }
  let applied = 0;
  for (const t of targets) {
    // WHY enforce the contract here: this is the sole consumer of targets().
    // A malformed module (e.g. a target without exists(), the 2026-08-31
    // regression in the since-retired auto-update patch) must fail as one
    // reported target, never
    // TypeError-crash the whole verification run mid-refactor.
    const missing = ["name", "exists", "isApplied", "apply"].filter(
      (k) => typeof t?.[k] !== (k === "name" ? "string" : "function"),
    );
    if (missing.length > 0) {
      bad(
        `${label}: target violates targets() contract (missing ${missing.join(
          ", ",
        )}) — fix the patch module`,
      );
      continue;
    }
    try {
      if (!t.exists()) {
        bad(
          `${t.name}: required target file missing — upstream layout changed`,
        );
      } else if (t.isApplied()) {
        applied++;
        ok(`${t.name}: patch present`);
      } else if (FIX) {
        t.apply();
        if (!t.isApplied())
          throw new Error(
            "apply() returned without establishing the patch invariant",
          );
        applied++;
        fixed(`${t.name}: patch re-applied (was wiped by update)`);
      } else {
        bad(`${t.name}: patch MISSING — re-run with --fix`);
      }
    } catch (e) {
      bad(`${t.name}: check/apply threw — ${String(e.message ?? e)}`);
    }
  }
  if (applied === 0) {
    bad(`${label}: no targets applied — manual review needed`);
  }
}

// ── pi package location ────────────────────────────────────────────────
function findPiPackage() {
  try {
    const which = execSync("which pi", { encoding: "utf-8" }).trim();
    if (which) {
      const real = fs.realpathSync(which);
      const pkg = path.dirname(path.dirname(real)); // bin/pi -> package root
      if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
    }
  } catch {
    /* fall through */
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const pkg = path.join(root, "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(pkg)) return pkg;
  } catch {
    /* fall through */
  }
  return null;
}

async function main() {
  console.log("== Pi harness verification ==");
  if (!STAGED && fs.existsSync(path.join(AGENT_DIR,"logs/core-update-transaction.json"))) {
    let validating = false;
    try {
      const held=fs.fstatSync(8),expected=fs.statSync(path.join(AGENT_DIR,"logs/harness-session.lock"));
      validating=process.env.PI_HARNESS_SESSION_LOCK_HELD==="1"&&held.ino===expected.ino&&held.dev===expected.dev;
    } catch {}
    if (!validating) bad("interrupted core update pending — run auto-update.sh --repair-only before using Pi");
  }
  const piPkg = findPiPackage();
  if (piPkg) {
    try {
      const pj = JSON.parse(
        fs.readFileSync(path.join(piPkg, "package.json"), "utf-8"),
      );
      ok(`pi package found: ${pj.name} ${pj.version} (${piPkg})`);
    } catch {
      bad(`pi package at ${piPkg} has an unreadable package.json`);
    }
  } else {
    bad("pi package not found — cannot verify patches; check the npm install");
  }

  // ── 0. Canonical inventory (single source: extensions/manifest.json) ─
  const manifest = loadManifest();
  const EXPECTED_EXTENSIONS = manifest.extensions;
  const EXPECTED_LIB = manifest.lib;
  const FORKED = manifest.forks;
  const FOLDED_MARKERS = manifest.foldedMarkers;
  const NPM_MANAGED = manifest.npmPackages;
  // Direct deps agent/npm/package.json must contain: the vendored runtime
  // dependency root the forks import through the extensions/node_modules
  // symlink (exact pins — nothing in this tree may float or auto-update).
  const EXPECTED_DEPS = [...manifest.vendoredDeps].sort();

  // ── 1. Extensions present + parse ────────────────────────────────────
  console.log("\n[1] Extensions");
  if (fs.existsSync(EXT_DIR)) {
    const present = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith(".ts"));
    if (manifest.ok) {
      // Both directions on purpose: retirement is ONE edit (manifest entry +
      // disk file), and anything pi would auto-load from extensions/ must be
      // registered — the harness never keeps a second hand-maintained list.
      const unknown = present.filter((f) => !EXPECTED_EXTENSIONS.includes(f));
      for (const f of EXPECTED_EXTENSIONS) {
        if (!present.includes(f))
          bad(
            `missing extension: ${f} (still registered in manifest — retire it there too)`,
          );
      }
      for (const f of unknown)
        bad(
          `extension file not in manifest: ${f} — register or delete it (never hand-edit verify-harness.mjs)`,
        );
      for (const f of EXPECTED_LIB) {
        if (!fs.existsSync(path.join(EXT_DIR, "lib", f)))
          bad(`missing lib module: lib/${f}`);
      }
      for (const dir of Object.keys(FORKED)) {
        if (!fs.existsSync(path.join(EXT_DIR, path.basename(dir))))
          bad(`missing fork: ${dir}`);
      }
      ok(
        `${present.length} extension files + ${Object.keys(FORKED).length} forks present (per extensions/manifest.json)`,
      );
    } else {
      info("inventory checks skipped: manifest.json unreadable (see above)");
    }
    const libDir = path.join(EXT_DIR, "lib");
    // Keep verification fail-closed when an update removes or replaces the
    // library directory.  The manifest check above reports the missing
    // modules, but an unguarded readdirSync here used to abort the verifier
    // before it emitted RESULT, which made health automation treat a crash as
    // an unknown (and sometimes falsely healthy) state.
    let libFiles = [];
    try {
      if (fs.existsSync(libDir) && fs.statSync(libDir).isDirectory()) {
        libFiles = fs
          .readdirSync(libDir)
          .filter((f) => f.endsWith(".ts"));
      } else {
        bad(`extension library directory missing: ${libDir}`);
      }
    } catch (e) {
      bad(`extension library directory unreadable: ${libDir} — ${e.message}`);
    }
    if (manifest.ok) {
      for (const file of libFiles.filter(file => !EXPECTED_LIB.includes(file)))
        bad(`extension library not in manifest: lib/${file} — register or remove it`);
    }
    const parseTargets = [
      ...(manifest.supportFiles ?? []).map((f) => path.join(AGENT_DIR, f)),
      ...present.map((f) => path.join(EXT_DIR, f)),
      ...libFiles.map((f) => path.join(libDir, f)),
    ];
    // Parallel on purpose: --check takes one file per process, so the old
    // serial loop paid a full node startup per file (~2s for 12+ files);
    // concurrent is ~0.3s. Each failure maps to its file's basename.
    const parseResults = await Promise.all(
      parseTargets.sort().map(async (p) => {
        try {
          await checkSourceSyntax(p);
          return null;
        } catch (e) {
          return `${path.basename(p)}: ${(e.stderr || e.message).toString().slice(0, 400)}`;
        }
      }),
    );
    for (const failure of parseResults.filter(Boolean))
      bad(`syntax error in ${failure}`);
    if (!parseResults.some(Boolean))
      ok(
        `all ${parseTargets.length} extension/lib/support files validate (JS/TS/Python syntax, JSON data and systemd units)`,
      );
  } else {
    bad(`extensions dir missing: ${EXT_DIR}`);
  }

  // ── 2. Load-state drift (forks retired, nothing resurrects them) ─────
  console.log("\n[2] Load-state drift");
  let settingsPkgs = [];
  let deps = [];
  try {
    settingsPkgs =
      JSON.parse(
        fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf-8"),
      ).packages ?? [];
  } catch (e) {
    bad(`settings.json unreadable — cannot check packages: ${e.message}`);
  }
  try {
    const declared =
      JSON.parse(fs.readFileSync(path.join(NPM_DIR, "package.json"), "utf-8"))
        .dependencies ?? {};
    const locked =
      JSON.parse(
        fs.readFileSync(path.join(NPM_DIR, "package-lock.json"), "utf-8"),
      ).packages?.[""]?.dependencies ?? {};
    deps = Object.keys(declared).sort();
    for (const [name, version] of Object.entries(declared)) {
      if (
        typeof version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
      )
        bad(`vendored dependency must be exact-pinned: ${name}`);
      if (locked[name] !== version) bad(`vendored lockfile drift: ${name}`);
      const installed = JSON.parse(
        fs.readFileSync(
          path.join(NPM_DIR, "node_modules", name, "package.json"),
          "utf-8",
        ),
      ).version;
      if (installed !== version)
        bad(
          `vendored installed-version drift: ${name} (expected ${version}, got ${installed})`,
        );
    }
  } catch (e) {
    bad(`npm/package.json unreadable — cannot check deps: ${e.message}`);
  }
  if (manifest.ok) {
    const wantSettings = NPM_MANAGED.map((p) => `npm:${p}`).sort();
    if (
      JSON.stringify([...settingsPkgs].sort()) === JSON.stringify(wantSettings)
    ) {
      ok(`settings.packages = ${wantSettings.join(", ")}`);
    } else {
      bad(
        `settings.packages drifted: got [${settingsPkgs.join(", ")}], want [${wantSettings.join(", ")}] — update extensions/manifest.json ONLY if the change is intentional`,
      );
    }
    if (JSON.stringify(deps) === JSON.stringify(EXPECTED_DEPS)) {
      ok(`npm/package.json deps = ${EXPECTED_DEPS.join(", ")}`);
    } else {
      bad(
        `npm/package.json deps drifted: got [${deps.join(", ")}], want [${EXPECTED_DEPS.join(", ")}]`,
      );
    }
    const banned = Object.values(FORKED);
    for (const name of banned) {
      const inSettings = settingsPkgs.some(
        (p) => p === `npm:${name}` || p.endsWith(`/${name}`),
      );
      const inDeps = deps.includes(name);
      const inModules = fs.existsSync(path.join(NPM_DIR, "node_modules", name));
      if (inSettings || inDeps || inModules) {
        bad(
          `resurrection: ${name} ${[
            inSettings && "in settings.packages",
            inDeps && "in package.json",
            inModules && "installed in node_modules",
          ]
            .filter(Boolean)
            .join(
              " + ",
            )} — it is FORKED into extensions/; remove it (or update extensions/manifest.json deliberately)`,
        );
      }
    }
    if (
      !banned.some((n) => deps.includes(n) || settingsPkgs.includes(`npm:${n}`))
    ) {
      ok(`${banned.length} forked package names absent from load paths`);
    }
    for (const { file, marker, label } of FOLDED_MARKERS) {
      const p = path.join(AGENT_DIR, file);
      if (!fs.existsSync(p)) {
        bad(`folded-marker check: ${file} missing`);
      } else if (fs.readFileSync(p, "utf-8").includes(marker)) {
        ok(`folded into fork: ${label}`);
      } else {
        bad(
          `folded patch lost in fork source: ${label} (${marker} not in ${file})`,
        );
      }
    }
  } else {
    info("load-state checks skipped: manifest.json unreadable (see above)");
  }

  // ── 3. Patch registry (every scripts/patches/*.mjs, auto-discovered) ──
  console.log("\n[3] Patch registry");
  const patchDir = path.join(AGENT_DIR, "scripts", "patches");
  const patchFiles = fs
    .readdirSync(patchDir)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  if (patchFiles.length === 0) bad("no patch modules found");
  for (const f of patchFiles) {
    await checkPatch(f, f.replace(/\.mjs$/, ""));
  }

  // ── 3a. Out-of-band update recovery (outside the replaceable package) ─
  console.log("\n[3a] Automatic repair units");
  if (!manifest?.supportFiles?.some(file => file.startsWith("scripts/systemd/pi-harness-repair."))) {
    info("optional automatic repair units are not part of this installation");
  } else try {
    if (!piPkg)
      throw new Error(
        "Cannot configure repair watch without a Pi installation",
      );
    const units = path.join(HOME, ".config", "systemd", "user");
    // PathChanged takes one raw absolute path (spaces allowed), not shell quotes.
    const unitPath = (p) => {
      if (/[\r\n\0]/.test(p)) throw new Error("Invalid systemd watch path");
      return p.replaceAll("%", "%%");
    };
    let changed = false;
    for (const suffix of ["service", "timer", "path"]) {
      const name = `pi-harness-repair.${suffix}`;
      const source = fs
        .readFileSync(path.join(AGENT_DIR, "scripts", "systemd", name), "utf8")
        .replace("@CORE_PARENT@", unitPath(path.dirname(piPkg)))
        .replace("@CORE_PACKAGE@", unitPath(path.join(piPkg, "package.json")));
      const file = path.join(units, name);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === source)
        continue;
      if (!FIX || STAGED) {
        bad(`${name} missing or drifted — run --fix`);
        continue;
      }
      fs.mkdirSync(units, { recursive: true });
      fs.writeFileSync(file, source);
      changed = true;
      fixed(`${name} installed from maintained source`);
    }
    const systemctl = (...argv) =>
      execFileSync("systemctl", ["--user", ...argv], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const triggers = ["pi-harness-repair.timer", "pi-harness-repair.path"];
    if (FIX && !STAGED) {
      if (changed) systemctl("daemon-reload");
      systemctl("enable", "--now", ...triggers);
      if (changed) systemctl("restart", "pi-harness-repair.path");
    }
    for (const unit of STAGED ? [] : triggers) {
      if (systemctl("is-enabled", unit).trim() !== "enabled")
        throw new Error(`${unit} is not enabled`);
      if (systemctl("is-active", unit).trim() !== "active")
        throw new Error(`${unit} is not active`);
    }
    ok(
      STAGED ? "repair unit sources match host-verified configuration (host services checked before staging)" : "installation-change watch and periodic repair fallback enabled and active",
    );
  } catch (error) {
    bad(`automatic repair unavailable: ${error.message}`);
  }

  // The normal CLI takes a shared session lease before loading any core code.
  // npm can replace its bin link, so launcher restoration belongs to repair.
  try {
    if (!piPkg) throw Error("Pi package unavailable");
    const launcher = launcherSpec(piPkg);
    const existing = fs.readFileSync(launcher.file, "utf8");
    if (!fs.lstatSync(launcher.file).isSymbolicLink() && existing === launcher.source) {
      ok("Pi launcher protects sessions from concurrent update/repair");
    } else if (FIX && !STAGED) {
      const ownedLink = fs.lstatSync(launcher.file).isSymbolicLink() && fs.realpathSync(launcher.file).startsWith(piPkg + path.sep);
      if (!ownedLink && !existing.includes("# PI_HARNESS_LAUNCHER_V1\n")) throw Error("Unrecognized Pi launcher; preserve it for review");
      const temp = `${launcher.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temp, launcher.source, { mode: 0o755, flag: "wx" });
        fs.renameSync(temp, launcher.file);
      } finally { fs.rmSync(temp, { force: true }); }
      fixed("Pi session-lock launcher installed");
    } else bad("Pi session-lock launcher missing or drifted — run --fix");
  } catch (error) { bad(`Pi launch protection unavailable: ${error.message}`); }

  // ── 4. Config + memory store parse ───────────────────────────────────
  console.log("\n[4] Config + memory");
  for (const f of ["settings.json", "models.json", "models-store.json"]) {
    const p = path.join(AGENT_DIR, f);
    if (fs.existsSync(p)) {
      try {
        JSON.parse(fs.readFileSync(p, "utf-8"));
        ok(`${f} parses`);
      } catch (e) {
        bad(`${f} corrupt: ${e.message}`);
      }
    }
  }
  const modelsPath = path.join(AGENT_DIR, "models.json");
  if (fs.existsSync(modelsPath)) {
    const mode = fs.statSync(modelsPath).mode & 0o777;
    if ((mode & 0o077) === 0) {
      ok("models.json permissions are private (0600-class)");
    } else if (FIX) {
      fs.chmodSync(modelsPath, 0o600);
      fixed(`models.json permissions hardened (${mode.toString(8)} -> 600)`);
    } else {
      bad(
        `models.json permissions are ${mode.toString(8)}; credentials require 600 (run with --fix)`,
      );
    }
  }
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf-8"),
    );
    if (s.compaction?.keepRecentTokens > 20000) {
      info(
        `compaction.keepRecentTokens=${s.compaction.keepRecentTokens} (stock default 20000 — restore if not intentional)`,
      );
    }
  } catch {
    /* already reported */
  }
  const MEM_DIR = path.join(AGENT_DIR, "memory");
  let memOk = 0,
    memBad = 0;
  if (fs.existsSync(MEM_DIR)) {
    for (const f of fs
      .readdirSync(MEM_DIR)
      .filter((f) => f.endsWith(".json"))) {
      try {
        JSON.parse(fs.readFileSync(path.join(MEM_DIR, f), "utf-8"));
        memOk++;
      } catch {
        memBad++;
        bad(`memory file corrupt: ${f}`);
      }
    }
  }
  if (memOk > 0) ok(`${memOk} memory files parse`);
  if (memBad === 0 && memOk === 0) info("no memory files present");

  // ── 5. Model stickiness ──────────────────────────────────────────────
  console.log("\n[5] Model selection ownership");
  // Structural check of direct API calls, not a proof about aliases or runtime
  // authorization. Include maintained forks; top-level-only scans missed both
  // the recovery owner and the user-confirmed profile switch.
  const modelSelectionOwners = new Map([
    ["pi-subagents/src/extension/autonomous-recovery.ts", "bounded recovery"],
    ["pi-subagents/src/slash/slash-commands.ts", "user-confirmed profile switch"],
  ]);
  const observedOwners = new Set();
  let stickinessBad = 0;
  function checkModelSelection(dir) {
    if (!fs.existsSync(dir)) return; // Inventory checks report missing paths.
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { checkModelSelection(file); continue; }
      if (!entry.isFile() || !/\.(?:ts|js|mjs)$/.test(entry.name)) continue;
      const relative = path.relative(EXT_DIR, file).split(path.sep).join("/");
      const text = fs.readFileSync(file, "utf-8");
      const re = /\bpi\s*\.\s*setModel\s*\(/g;
      for (const m of text.matchAll(re)) {
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
        if (line.startsWith("*") || line.startsWith("//")) continue;
        if (modelSelectionOwners.has(relative)) { observedOwners.add(relative); continue; }
        stickinessBad++;
        bad(`${relative}: direct pi.setModel call on line ${text.slice(0, m.index).split("\n").length} — outside declared model-selection owners`);
      }
    }
  }
  checkModelSelection(EXT_DIR);
  for (const owner of observedOwners) info(`model-selection owner: ${owner} (${modelSelectionOwners.get(owner)})`);
  if (stickinessBad === 0)
    ok("direct pi.setModel scan: no calls outside declared owners (structural coverage only)");

  // ── 6. Install-script allowlist (npm 11 allowScripts policy) ───────────
  console.log("\n[6] Install-script allowlist (agent/npm)");
  try {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(NPM_DIR, "package.json"), "utf-8"),
    );
    const allow = pkgJson.allowScripts ?? {};
    const withScripts = [];
    for (const dir of fs.readdirSync(path.join(NPM_DIR, "node_modules"))) {
      if (dir.startsWith(".") || dir.startsWith("@")) continue;
      const pj = path.join(NPM_DIR, "node_modules", dir, "package.json");
      let meta;
      try {
        if (!fs.existsSync(pj)) continue;
        meta = JSON.parse(fs.readFileSync(pj, "utf-8"));
      } catch {
        continue;
      }
      const s = meta.scripts ?? {};
      if (s.install || s.preinstall || s.postinstall)
        withScripts.push({ name: dir, version: meta.version ?? "?" });
    }
    let uncovered = 0;
    for (const p of withScripts) {
      const key = `${p.name}@${p.version}`;
      if (allow[key] === true || allow[p.name] === true) continue;
      uncovered++;
      bad(
        `script-bearing dep not allowlisted: ${key} — run npm approve-scripts --all (auto-update.sh does it)`,
      );
    }
    if (uncovered === 0)
      ok(
        `${withScripts.length} script-bearing dep${withScripts.length === 1 ? "" : "s"} covered by allowScripts`,
      );
  } catch (e) {
    info(`allowlist check skipped (${String(e)})`);
  }

  // ── 7. Duplicate package-skill prune (user ~/skills wins) ────────────
  console.log("\n[7] Duplicate package-skill prune (user skills win)");
  try {
    const userSkillRoots = [
      path.join(HOME, "skills"),
      path.join(AGENT_DIR, "skills"),
    ];
    const pkgSkillsRoot = path.join(NPM_DIR, "node_modules");
    const pruned = [];
    if (fs.existsSync(pkgSkillsRoot)) {
      for (const pkgDir of fs.readdirSync(pkgSkillsRoot)) {
        if (pkgDir.startsWith(".") || pkgDir.startsWith("@")) continue;
        const skillsDir = path.join(pkgSkillsRoot, pkgDir, "skills");
        if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory())
          continue;
        for (const name of fs.readdirSync(skillsDir)) {
          const pkgSkill = path.join(skillsDir, name);
          if (!fs.existsSync(path.join(pkgSkill, "SKILL.md"))) continue;
          const userWins = userSkillRoots.some((r) =>
            fs.existsSync(path.join(r, name, "SKILL.md")),
          );
          if (!userWins) continue;
          pruned.push(`${pkgDir}/skills/${name}`);
          if (FIX) {
            fs.rmSync(pkgSkill, { recursive: true, force: true });
          }
        }
      }
    }
    if (pruned.length === 0) {
      ok("no package skills shadowed by user skills");
    } else if (FIX) {
      fixed(
        `pruned ${pruned.length} duplicate package skill(s): ${pruned.join(", ")} (user copies win)`,
      );
    } else {
      bad(
        `${pruned.length} package skill(s) duplicate user ~/skills copies — run --fix to prune: ${pruned.join(", ")}`,
      );
    }
  } catch (e) {
    bad(`skill prune failed: ${String(e.message ?? e)}`);
  }

  // ── 8. harness-backup command (script + extension survive updates) ────
  console.log("\n[8] harness-backup command");
  {
    const scriptPath = path.join(AGENT_DIR, "scripts", "harness-backup.mjs");
    if (fs.existsSync(scriptPath)) {
      try {
        execFileSync("node", ["--check", scriptPath], { stdio: "pipe" });
        const src = fs.readFileSync(scriptPath, "utf-8");
        if (!src.includes("NEVER_PRINT_SECRETS")) {
          bad("harness-backup.mjs lost its secret-redaction marker");
        } else if (
          /console\.(log|error|warn)\s*\([^)]*process\.env/.test(src)
        ) {
          bad(
            "harness-backup.mjs console.* uses process.env (may leak values)",
          );
        } else {
          ok(
            "scripts/harness-backup.mjs present, parses, redaction marker intact",
          );
        }
      } catch (e) {
        bad(
          `harness-backup.mjs syntax error: ${(e.stderr || e.message).toString().slice(0, 400)}`,
        );
      }
    } else {
      bad("scripts/harness-backup.mjs missing");
    }
  }

  // ── 9. Retired-component reference scan ──────────────────────────────
  console.log("\n[9] Retired-component reference scan");
  // WHY a live tombstone table: retiring a component used to be two
  // independent edits (delete the file, scrub the docs) that could silently
  // diverge — a name could linger in a registry comment or backup list long
  // after the component was gone. The table lives in the manifest (the one
  // inventory), so the retirement workflow is: delete the component + remove
  // it from its list + tombstone it in retired[]; this scan then reports
  // every stale mention the cleanup missed. History files are NOT scanned
  // — they are a journal, not a registry.
  if (manifest.ok) {
    const retired = manifest.retired;
    let refBad = 0;
    if (retired.length === 0) {
      ok("retired table empty — nothing tombstoned");
    } else {
      // Shape check (a malformed tombstone silently scans nothing).
      for (const r of retired) {
        if (!r || typeof r.name !== "string" || typeof r.retired !== "string")
          bad(
            "retired[] entry missing name/retired strings — fix the manifest",
          );
      }
      // 9a. Re-registered while retired?
      for (const r of retired) {
        const n = r.name;
        const rereg = [
          manifest.extensions.includes(n) && "extensions[]",
          manifest.lib.includes(n) && "lib[]",
          Object.keys(manifest.forks).some((k) => path.basename(k) === n) &&
            "forks{}",
          manifest.npmPackages.includes(n) && "npmPackages[]",
        ].filter(Boolean);
        if (rereg.length > 0)
          bad(
            `retired name re-registered in manifest ${rereg.join(" + ")}: ${n}`,
          );
      }
      // 9b. Resurrection guard (file reappeared on disk).
      for (const r of retired) {
        for (const hit of retireResurrections(r.name))
          bad(
            `retired file reappeared on disk: ${hit} — delete it or un-retire it in extensions/manifest.json`,
          );
      }
      // 9c. Stale-mention scan over registries/docs.
      const docFiles = retireDocFiles();
      if (docFiles.length === 0) {
        bad(
          "no scan targets found (HARNESS-MAINTENANCE.md / scripts missing?)",
        );
      }
      for (const file of docFiles) {
        let text;
        try {
          text = fs.readFileSync(file, "utf-8");
        } catch (e) {
          bad(`cannot read scan target ${file}: ${e.message}`);
          continue;
        }
        const isMd = file.endsWith(".md");
        const lines = text.split("\n");
        let sectionRecord = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isMd && /^#{1,6}\s+/.test(line)) {
            sectionRecord = RETIRE_RECORD_RE.test(line);
          }
          if (RETIRE_RECORD_RE.test(line) || (isMd && sectionRecord)) continue;
          for (const r of retired) {
            if (retireNameRe(r.name).test(line)) {
              refBad++;
              bad(
                `${path.relative(AGENT_DIR, file)}:${i + 1}: stale mention of retired "${r.name}" — ${line.trim().slice(0, 120)}`,
              );
            }
          }
        }
      }
      if (refBad === 0 && docFiles.length > 0)
        ok(
          `${retired.length} retired names clean across ${docFiles.length} docs/scripts (deletion records only)`,
        );
    }
  } else {
    info("retired scan skipped: manifest.json unreadable (see above)");
  }

  // ── 10. Optional smoke test ──────────────────────────────────────────
  if (SMOKE) {
    console.log("\n[10] Smoke test (1 tiny LLM call)");
    // WHY spawn instead of execFile: execFile("pi", …) stalls past its timeout
    // on this Node (v22.22.3) while the identical command exits in ~5s via a
    // direct spawn — the smoke was effectively unusable. spawn with ignored
    // stdin + manual output collection terminates correctly; the timeout
    // SIGKILLs the child's process group so nothing lingers.
    const smoke = await new Promise((resolve) => {
      const child = spawn(
        "pi",
        ["-p", "--no-session", "--mode", "text", "Reply with exactly: OK"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1" },
          windowsHide: true,
          detached: process.platform !== "win32", // group leader → group kill
        },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.on("error", (err) =>
        finish({
          killed: false,
          code: null,
          signal: null,
          error: err,
          stdout,
          stderr,
        }),
      );
      child.on("close", (code, signal) =>
        finish({ killed: false, code, signal, stdout, stderr }),
      );
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        finish({
          killed: true,
          code: child.exitCode ?? null,
          signal: "SIGKILL",
          stdout,
          stderr,
        });
      }, 180_000);
    });
    if (
      smoke.code === 0 &&
      !smoke.killed &&
      !smoke.error &&
      /(?:^|\n)OK\s*(?:\n|$)/.test(smoke.stdout)
    )
      ok("pi -p smoke test passed (extensions load, model responds)");
    else if (smoke.killed) bad(`smoke test timed out after 180s (SIGKILLed)`);
    else if (smoke.error)
      bad(`smoke test failed to spawn: ${smoke.error.message}`);
    else
      bad(
        `smoke test failed (exit ${smoke.code}, signal ${smoke.signal}): ${(smoke.stderr || smoke.stdout || "(no output)").slice(0, 400)}`,
      );
  } else {
    info("smoke test skipped (pass --smoke to run one tiny LLM call)");
  }

  const summary =
    failures === 0
      ? repaired > 0
        ? `PASS (${repaired} issue(s) repaired)`
        : "PASS"
      : `${failures} issue(s) need attention`;
  // RESULT remains a compatibility-stable structural exit summary. Make the
  // coverage boundary explicit so a plain PASS cannot be mistaken for the
  // behavioral regression suite or a live provider smoke test.
  console.log(
    `COVERAGE: ${SMOKE ? "structural + live provider smoke (behavioral suite not run)" : "structural only (behavioral suite and live provider smoke not run)"}`,
  );
  console.log(`\nRESULT: ${summary}`);
  process.exit(failures === 0 ? 0 : 1);
}

// One lock for scheduled updates, manual verification and periodic repair.
// FD 9 is inherited from the owning shell; validate it before trusting the flag.
const lockPath = path.join(AGENT_DIR, "logs", "harness-update.lock");
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
let locked = false;
try {
  const held = fs.fstatSync(9),
    expected = fs.statSync(lockPath);
  locked =
    process.env.PI_HARNESS_LOCK_HELD === "1" &&
    held.ino === expected.ino &&
    held.dev === expected.dev &&
    spawnSync("flock", ["-n", "9"], { stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] }).status === 0;
} catch {
  /* direct invocation must acquire the lock */
}
if (locked) {
  (async () => {
    if (FIX) {
      const sessionLock = path.join(AGENT_DIR, "logs", "harness-session.lock");
      let sessionHeld = false;
      try {
        const held = fs.fstatSync(8), expected = fs.statSync(sessionLock);
        sessionHeld = process.env.PI_HARNESS_SESSION_LOCK_HELD === "1" && held.ino === expected.ino && held.dev === expected.dev &&
          spawnSync("flock", ["-n", "8"], { stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 8] }).status === 0;
      } catch {}
      if (!sessionHeld) {
        const child = spawn("/bin/bash", ["-c",
          'exec 8>"$1" || exit 1; flock -n -E 75 8 || exit $?; export PI_HARNESS_SESSION_LOCK_HELD=1; exec "$2" "${@:3}"',
          "harness-session-lock", sessionLock, process.execPath, ...process.argv.slice(1)],
          { stdio: ["inherit", "inherit", "inherit", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] });
        child.on("error", error => { console.error(error.message); process.exitCode = 1; });
        child.on("exit", code => {
          // Exit 75 means the exclusive session lease is held by a live session,
          // so a writing repair was deferred. Say so explicitly and point at the
          // read-only alternative instead of a bare non-zero exit.
          if (code === 75)
            console.error(
              "Pi sessions active; repairs deferred (exit 75). Re-run after sessions end, or use `verify-harness.mjs --staged` to validate without writing.",
            );
          process.exitCode = code ?? 1;
        });
        return;
      }
      // Include legacy/direct launches that predate or bypass the wrapper.
      if (!STAGED && fs.existsSync(path.join(AGENT_DIR,"logs/core-update-transaction.json"))) {
        throw Error("Interrupted core update pending; run auto-update.sh --repair-only to recover before repairing");
      }
      const core = findPiPackage();
      if (!STAGED && core && activePiProcesses(core).length) {
        console.error(
          "Pi sessions active; repairs deferred (exit 75). Re-run after sessions end, or use `verify-harness.mjs --staged` to validate without writing.",
        );
        process.exitCode = 75;
        return;
      }
    }
    await main();
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  const child = spawn(
    "/bin/bash",
    [
      "-c",
      'exec 9>"$1" || exit 1; flock -w 120 -E 75 9 || exit $?; export PI_HARNESS_LOCK_HELD=1; exec "$2" "${@:3}"',
      "harness-lock",
      lockPath,
      process.execPath,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  child.on("error", (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
