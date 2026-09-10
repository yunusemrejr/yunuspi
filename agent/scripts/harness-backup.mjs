#!/usr/bin/env node
/**
 * Pi harness backup — PRIVATE local recovery archive, zero-LLM.
 *
 * Creates a timestamped ZIP on the Desktop containing everything needed to
 * reconstruct the locally customized pi harness in ~/.pi/agent, plus the
 * provider credentials actually in use. Credential env vars are discovered
 * from real configuration (models.json `$VAR` refs, extension/script
 * `process.env` refs, and the installed pi core's provider env names) — never
 * a hard-coded provider list.
 *
 * Secrets discipline (NEVER_PRINT_SECRETS):
 *   - No env-var VALUE is ever written to stdout/stderr, not even in errors.
 *   - Discovered environment values are written to META/credentials.env
 *     (mode 0600); original config files retain their credentials too.
 *   - This ZIP is NOT sanitized for publication. Never commit or share it.
 *   - META/manifest.json records names/paths/providers only, redacted.
 *   - verify-harness.mjs [8c] greps for this marker and for console.* calls
 *     that use process.env. Keep that invariant.
 *
 * Archive layout (paths mirror $HOME so restore is mechanical):
 *   .pi/agent/...          harness config (mirrors ~/.pi/agent)
 *   .pi/.pi-lens.json      pi-lens project config for cwd=~/.pi
 *   .config/systemd/user/  pi-auto-update.{service,timer}
 *   skills/...             user skills (settings.json -> ~/skills)
 *   META/manifest.json     redacted manifest
 *   META/RESTORE.md        safe restore procedure
 *   META/credentials.env   discovered provider env vars (0600, values)
 *
 * Exit 0 = created + verified; 1 = error. Never overwrites an existing
 * archive (collision-safe -2/-3 suffix); build is staged and renamed
 * atomically after verification; final archive is chmod 0600.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077); // staging + outputs stay user-only

const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.dirname(SCRIPT_DIR); // ~/.pi/agent

const NEVER_PRINT_SECRETS = true; // marker: verify-harness.mjs [8c] asserts this stays + no console.* with process.env
void NEVER_PRINT_SECRETS;
const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

// ── Desktop resolution ────────────────────────────────────────────────
function resolveDesktop() {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--output-dir")
      throw new Error("Usage: harness-backup.mjs [--output-dir EXISTING_DIRECTORY]");
    const dir = path.resolve(args[1]);
    if (!fs.statSync(dir).isDirectory()) throw new Error("Output must be an existing directory");
    return fs.realpathSync(dir);
  }
  try {
    const d = execFileSync("xdg-user-dir", ["DESKTOP"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (d && d !== HOME && fs.existsSync(d) && fs.statSync(d).isDirectory())
      return d;
  } catch {
    /* xdg missing or errored — fall through */
  }
  const fallback = path.join(HOME, "Desktop");
  if (fs.existsSync(fallback) && fs.statSync(fallback).isDirectory())
    return fallback;
  throw new Error(
    "Desktop directory could not be resolved (xdg-user-dir DESKTOP and ~/Desktop both missing). " +
      "Refusing to save the archive somewhere unexpected.",
  );
}

// ── pi / node / scanner paths ─────────────────────────────────────────
function piVersion() {
  try {
    return execFileSync("pi", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      const root = execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(root, "@earendil-works", "pi-coding-agent", "package.json"),
          "utf8",
        ),
      );
      return String(pkg.version ?? "unknown");
    } catch {
      return "unknown";
    }
  }
}

function piDistDir() {
  const candidates = [];
  // Candidate 1: realpath of `which pi`, walked up to the dir that owns
  // package.json. WHY walk-up, not the old fixed triple-dirname: it only
  // worked when the bin symlink resolved at exactly dist/bundle/cli.js
  // depth; any upstream layout change silently returned a wrong root.
  try {
    let dir = path.dirname(
      fs.realpathSync(
        execFileSync("which", ["pi"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      ),
    );
    while (dir && !fs.existsSync(path.join(dir, "package.json"))) {
      const parent = path.dirname(dir);
      dir = parent === dir ? null : parent; // null = filesystem root reached
    }
    if (dir) candidates.push(path.join(dir, "dist"));
  } catch {
    /* fall through */
  }
  // Candidate 2: global npm root (authoritative layout).
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    candidates.push(
      path.join(root, "@earendil-works", "pi-coding-agent", "dist"),
    );
  } catch {
    /* fall through */
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// ── credential env-var discovery (from real config, not a provider list) ──
function walkJsFiles(dir, acc) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.name === "node_modules" || e.name === ".pi") continue;
      if (e.isDirectory()) walkJsFiles(p, acc);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith(".map"))
        acc.push(p);
    }
  } catch {
    /* unreadable dir — skip */
  }
  return acc;
}

function collectEnvNames() {
  const refs = new Set();
  const reEnv =
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;
  const reDollar = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g; // ${VAR} / $VAR shell+models.json style
  const reQuotedKey = /["']([A-Z][A-Z0-9_]{2,})["']/g; // dist: apiKeyEnv-style declarations

  const scan = (text, useDollar) => {
    for (const re of [reEnv, ...(useDollar ? [reDollar] : []), reQuotedKey]) {
      let m;
      while ((m = re.exec(text)) != null) refs.add(m[1] ?? m[2]); // groups: reEnv m1|m2, dollar/quoted m1 (m3 never existed — dead ref removed)
    }
  };

  // 1. models.json — the authoritative provider config ($VAR refs).
  const modelsPath = path.join(AGENT, "models.json");
  if (fs.existsSync(modelsPath))
    scan(fs.readFileSync(modelsPath, "utf8"), true);

  // 2. Harness extension + script sources (process.env refs).
  for (const dir of [
    path.join(AGENT, "extensions"),
    path.join(AGENT, "scripts"),
  ]) {
    const files = walkJsFiles(dir, []);
    for (const f of files) scan(fs.readFileSync(f, "utf8"), false);
  }
  let shSources = [];
  try {
    shSources = fs
      .readdirSync(path.join(AGENT, "scripts"))
      .filter((f) => f.endsWith(".sh"))
      .map((f) => path.join(AGENT, "scripts", f));
  } catch {
    /* ignore */
  }
  for (const f of shSources) scan(fs.readFileSync(f, "utf8"), true);

  // 3. Installed pi core (the real runtime): process.env refs + quoted
  //    SECRET/KEY/TOKEN env-name declarations, intersected with env later.
  const dist = piDistDir();
  if (dist) {
    const js = walkJsFiles(dist, []);
    for (const f of js) {
      const text = fs.readFileSync(f, "utf8");
      // only keep credential-ish quoted tokens to limit noise
      const q = text.match(reQuotedKey) ?? [];
      for (const tok of q) {
        const name = tok.slice(1, -1);
        if (/(_API_KEY|_TOKEN|_SECRET|_KEY)$/.test(name)) refs.add(name);
      }
    }
  }

  // Noise to exclude: runtime/session vars and generic shell vars. Only
  // names actually set in THIS environment can be captured anyway.
  const NOISE =
    /^(PI_(SESSION|MODEL|PROVIDER|REASONING|SUBAGENT|CODING|INFERENCE)|LOG_TOKENS|NO_COLOR|XDG_|LC_|LANG|TERM|DISPLAY|WAYLAND|DBUS|USER|LOGNAME|HOME|PATH|SHELL|SHLVL|PWD|OLDPWD|_|SSH_|SUDO_)/;
  const captured = [];
  for (const n of refs) {
    if (NOISE.test(n)) continue;
    const v = process.env[n];
    if (v === undefined || v === "") continue;
    captured.push({ name: n, value: v }); // value stays in this array only
  }
  captured.sort((a, b) => a.name.localeCompare(b.name));
  return captured;
}

// ── manifest ──────────────────────────────────────────────────────────
/** Read+parse a JSON config; null on missing/corrupt (manifest carries the
 *  empty default instead of failing the whole backup). */
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function buildManifest({
  archiveName,
  piVer,
  nodeVer,
  captured,
  includedRoots,
  fileCount,
}) {
  // Each config read ONCE — the old body re-parsed models.json twice and
  // settings.json twice through four separate try/catch blocks.
  const models = readJsonSafe(path.join(AGENT, "models.json")) ?? {};
  const storeProviders = Object.keys(
    readJsonSafe(path.join(AGENT, "models-store.json")) ?? {},
  ).sort();
  const settings = readJsonSafe(path.join(AGENT, "settings.json")) ?? {};
  let extensionFiles = [];
  try {
    extensionFiles = fs
      .readdirSync(path.join(AGENT, "extensions"))
      .filter((f) => f.endsWith(".ts"))
      .sort();
  } catch {
    /* ignore */
  }
  return {
    createdAt: new Date().toISOString(),
    archiveName,
    piVersion: piVer,
    nodeVersion: nodeVer,
    sourceHome: HOME,
    header:
      "PRIVATE RECOVERY MANIFEST — does not record credential values intentionally. Paths and provider names are private metadata. Credentials are retained in META/credentials.env and original configuration files. Never publish this archive.",
    includedRoots,
    excludedRoots: [
      ".pi/agent/sessions/ (session histories — disposable)",
      ".pi/agent/logs/ (logs)",
      ".pi/agent/artifacts/ (subagent artifacts)",
      ".pi/agent/missions/ (runtime mission state)",
      ".pi/agent/scripts/.pi/ (background-task outputs)",
      ".pi/agent/npm/node_modules/ (reinstall via npm ci from lockfile; extensions/node_modules symlink excluded)",
      // WHY: telemetry.json dropped from this list 2026-08-31 — orphan of the
      // deleted pi-context-router (2026-08-12 refactor); file deleted, nothing
      // writes or reads it anymore (see FORBIDDEN_FILE note below).
      ".pi/agent/run-history.jsonl (runtime state)",
      ".pi/top-level runtime dirs: sessions/ tasks/ inference-slots/ sibling-bridge/ web-search-cache/ (runtime data — never archived)",
      ".pi/backups/ (older backup artifacts; live config is the source of truth)",
      ".pi/agent/*.bak* (stale file backups)",
      "META/credentials.env VALUE never logged; manifest shows names only",
    ],
    extensions: extensionFiles,
    packageCount: Array.isArray(settings.packages) ? settings.packages.length : 0,
    providers: [
      ...new Set([...Object.keys(models.providers ?? {}), ...storeProviders]),
    ].sort(),
    defaultProvider: settings.defaultProvider ?? null,
    credentialEnvVars: captured.map((c) => c.name), // names only — redacted
    credentialFiles: [
      ".pi/agent/auth.json (pi /login store)",
      ".pi/agent/models.json (literal apiKey values)",
    ],
    literalApiKeyProviders: Object.entries(models.providers ?? {})
      // providers whose apiKey is a literal (not $ENV / !cmd) — names only
      .filter(([, pv]) => {
        const k = pv?.apiKey;
        return (
          typeof k === "string" &&
          k.length >= 8 &&
          !k.startsWith("$") &&
          !k.startsWith("!")
        );
      })
      .map(([name]) => name),
    fileCount,
    restoreNotes: [
      "See META/RESTORE.md — the authoritative restore procedure. Nothing restores automatically; this manifest is documentation only.",
    ],
  };
}

// ── copy jobs (src on disk -> dest relative to $HOME, mirrored in archive) ──
function copyJobs() {
  const jobs = [];
  const agentFile = (f) =>
    jobs.push({ src: path.join(AGENT, f), dst: path.join(".pi", "agent", f) });
  // Discover live configuration/resources, not a list that forgets the next
  // agents/, prompts/, themes/, keybindings.json or provider configuration.
  const separate = new Set([
    "extensions",
    "scripts",
    "npm",
    "memory",
    "backups",
  ]);
  const runtime = new Set([
    "sessions",
    "logs",
    "artifacts",
    "missions",
    "run-history.jsonl",
    ".pi",
  ]);
  for (const f of fs.readdirSync(AGENT).sort()) {
    if (!separate.has(f) && !runtime.has(f)) agentFile(f);
  }
  jobs.push({
    src: path.join(AGENT, "extensions"),
    dst: path.join(".pi", "agent", "extensions"),
  });
  jobs.push({
    src: path.join(AGENT, "scripts"),
    dst: path.join(".pi", "agent", "scripts"),
  });
  jobs.push({
    src: path.join(AGENT, "npm", "package.json"),
    dst: path.join(".pi", "agent", "npm", "package.json"),
  });
  jobs.push({
    src: path.join(AGENT, "npm", "package-lock.json"),
    dst: path.join(".pi", "agent", "npm", "package-lock.json"),
  });
  if (fs.existsSync(path.join(AGENT, "memory")))
    jobs.push({
      src: path.join(AGENT, "memory"),
      dst: path.join(".pi", "agent", "memory"),
    });
  // Retired-extension/script source (manifest retired[] says "moved to
  // backups/" — restoring should keep the option to reinstate). Stale
  // models.json.pre-*.bak snapshots inside are dropped by the *.bak* zip rule.
  if (fs.existsSync(path.join(AGENT, "backups")))
    jobs.push({
      src: path.join(AGENT, "backups"),
      dst: path.join(".pi", "agent", "backups"),
    });
  // Root-level ~/.pi customizations that live OUTSIDE agent/: pi-lens project
  // config.
  const lensCfg = path.join(HOME, ".pi", ".pi-lens.json");
  if (fs.existsSync(lensCfg))
    jobs.push({ src: lensCfg, dst: path.join(".pi", ".pi-lens.json") });
  // Persisted user reminders are not disposable logs. Histories remain excluded.
  for (const name of ["reminders", "checkpoints"]) {
    const src = path.join(HOME, ".pi", name);
    if (fs.existsSync(src)) jobs.push({ src, dst: path.join(".pi", name) });
  }
  const skillDir = path.join(HOME, "skills");
  if (fs.existsSync(skillDir)) jobs.push({ src: skillDir, dst: "skills" });
  for (const f of [
    "pi-auto-update.service",
    "pi-auto-update.timer",
    "pi-harness-repair.service",
    "pi-harness-repair.timer",
    "pi-harness-repair.path",
    "pi-mini-preprocessor.service",
  ]) {
    const p = path.join(HOME, ".config", "systemd", "user", f);
    if (fs.existsSync(p))
      jobs.push({ src: p, dst: path.join(".config", "systemd", "user", f) });
  }
  return jobs.filter((j) => fs.existsSync(j.src));
}

function copyJob(job, staging) {
  const target = path.join(staging, job.dst);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Exclude BEFORE copying: never stage huge dependency/runtime trees just
  // to throw them away at ZIP time. Source directories named tasks/missions
  // inside forks are legitimate and must survive.
  fs.cpSync(job.src, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (src) => {
      const base = path.basename(src);
      return (
        !["node_modules", ".git", ".DS_Store"].includes(base) &&
        !(base === ".pi" && src !== job.src) &&
        !base.includes(".bak")
      );
    },
  });
}

// cp preserves source permissions: reduce every staged regular file to owner-only
// while preserving executability. Never chmod through a symbolic link.
function secureStaging(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      // Absolute links into the original HOME must remain portable after restore.
      if (path.isAbsolute(target) && (target === HOME || target.startsWith(HOME + path.sep))) {
        const stagedTarget = path.join(STAGING_ROOT, path.relative(HOME, target));
        fs.unlinkSync(file);
        fs.symlinkSync(path.relative(path.dirname(file), stagedTarget), file);
      }
    } else if (e.isDirectory()) {
      fs.chmodSync(file, 0o700);
      secureStaging(file);
    } else if (e.isFile()) {
      fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o700 : 0o600);
    } else throw new Error("Unsupported special file in backup staging");
  }
}
let STAGING_ROOT;

function stagedEntries(dir, prefix = "") {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const name = prefix + e.name;
      return e.isDirectory()
        ? [name + "/", ...stagedEntries(path.join(dir, e.name), name + "/")]
        : [name];
    });
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function restoreDoc(piVer, nodeVer) {
  return `# Pi Harness Restore (safe, manual — nothing auto-restores)

Archive: one snapshot of ~/.pi/agent + pi systemd units + ~/skills,
created ${new Date().toISOString()}. Pi core ${piVer}, node ${nodeVer}.

## What is inside
- .pi/agent/: settings.json, models.json (provider defs incl. literal
  apiKey values), models-store.json, auth.json, extensions/ (all .ts +
  forks),
  scripts/ (verify-harness.mjs, auto-update.sh, patches/, bench/),
  npm/package.json + package-lock.json (exact runtime dependency pins),
  memory/, backups/ (retired extension/script source), maintenance docs,
  and all other live agent configuration/resources (agents, prompts, themes).
- .pi/: .pi-lens.json, persisted reminders/ and checkpoints/.
- .config/systemd/user/: update/repair services, timers and installation-change watch.
- skills/: user-level skills referenced by settings.json.
- META/: manifest.json (redacted), this file, credentials.env (0600).

## What is NOT inside (and why)
Runtime/regenerable state: .pi/agent sessions/, logs/, artifacts/,
missions/, scripts/.pi/, run-history.jsonl,
and the ~/.pi top-level runtime dirs (sessions/,
tasks/, inference-slots/, sibling-bridge/, web-search-cache/, backups/ older
artifacts). npm/node_modules is reinstalled
via npm ci (extensions/node_modules symlink is recreated in step 6), and
*.bak* stale snapshots are dropped. (context-composition.json and
telemetry.json are orphans of the deleted pi-context-router — removed
2026-08-31, no writer/reader since 2026-08-12.) Pi core itself is an
upstream npm package and is reinstalled by version (see manifest piVersion).

## Safe restore procedure
1. Stop pi sessions that might write ~/.pi/agent.
2. Inspect: unzip -l <archive> (names only).
3. Extract into a NEW private directory (never overlay an existing extraction):
   umask 077
   restore_dir=$(mktemp -d "\${TMPDIR:-/tmp}/harness-restore.XXXXXXXX")
   unzip -q <archive> -d "$restore_dir"
4. The archive contains credentials — keep it 0600 and delete the temp
   dir afterwards; never paste any credential value anywhere.
5. Restore only paths present in the extraction; save the current configuration first.
   These commands merge files and can overwrite existing credentials. Review them:
   # Run each command only when its source directory exists:
   cp -a "$restore_dir/.pi" ~/
   cp -a "$restore_dir/.config" ~/
   cp -a "$restore_dir/skills" ~/
6. Install the recorded core FIRST, then runtime deps from the lockfile:
   npm i -g --ignore-scripts @earendil-works/pi-coding-agent@${piVer}
   npm --prefix ~/.pi/agent/npm ci
   # Keep the saved allowScripts policy; do not blanket-approve new scripts.
   # forks resolve npm deps through this symlink (excluded from the archive):
   ln -sfn "$HOME/.pi/agent/npm/node_modules" ~/.pi/agent/extensions/node_modules
7. Restore credentials (values are in META/credentials.env):
   set -a; source "$restore_dir/META/credentials.env"; set +a
   — merge the exports into ~/.bashrc (or your profile) to persist.
   /login-style auth lives in .pi/agent/auth.json, already restored.
8. Re-enable the update timer:
   systemctl --user daemon-reload
   systemctl --user enable --now pi-auto-update.timer pi-harness-repair.timer
9. Reapply node_modules patches + verify (also regenerates/enables the repair watch for this install):
   node ~/.pi/agent/scripts/verify-harness.mjs --fix
10. Start a FRESH Pi session after verification; running sessions retain old JS.
11. Portability: this is a private recovery snapshot, not the public installer.
    Linux systemd units are optional; do not enable them on macOS/Windows.
    Python virtual environments/native dependencies must be recreated on the
    destination OS. Review absolute paths in settings, commands and systemd
    units when changing user/home directories. External symlinks require their
    original targets; home-internal symlinks are stored relative.
12. Notes: literal apiKey values are inside .pi/agent/models.json as-is.
    providers using $ENV refs or \`!command\` refs re-resolve at runtime;
    env-var credentials were captured at backup time into
    META/credentials.env (names only are listed in manifest.json).
`;
}

// ── verification ──────────────────────────────────────────────────────
function verifyArchive(zipPath, expected = []) {
  const report = {
    integrityOk: false,
    required: [],
    requiredTotal: 0,
    forbidden: [],
    fileCount: 0,
  };
  execFileSync("unzip", ["-t", zipPath], {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }); // throws on failure
  report.integrityOk = true;
  const entries = execFileSync("unzip", ["-Z1", zipPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  report.fileCount = entries.length;
  const actual = new Set(entries);
  for (const entry of expected) {
    if (!actual.has(entry)) report.required.push(entry);
  }
  const has = (p) => entries.some((e) => e === p);
  const hasPrefix = (p) => entries.some((e) => e.startsWith(p));
  const REQUIRED = [
    "META/manifest.json",
    "META/RESTORE.md",
    "META/credentials.env",
    ".pi/agent/settings.json",
    ".pi/agent/extensions/harness-backup.ts",
    ".pi/agent/scripts/verify-harness.mjs",
    ".pi/agent/scripts/auto-update.sh",
    ".pi/agent/npm/package.json",
    ".pi/agent/npm/package-lock.json",
  ];
  for (const p of REQUIRED) if (!has(p)) report.required.push(p);
  // WHY: count derived from the list, never a duplicated literal (the old
  // REQUIRED_COUNT=16 const drifted the moment an entry changed).
  report.requiredTotal = REQUIRED.length;
  // WHY prefix checks, not named entries: the old list hard-coded one skill
  // (skills/council-mode/SKILL.md) and one patch file — either would fail
  // every future backup the moment the user renamed/removed it (the same
  // lists-drift lesson as REQUIRED_COUNT). Directory presence is the
  // invariant that matters.
  if (!hasPrefix(".pi/agent/extensions/"))
    report.required.push("extensions/ dir");
  if (!hasPrefix(".pi/agent/scripts/patches/"))
    report.required.push("scripts/patches/ dir");
  // Optional credentials, Linux services, retired sources and external skills
  // are verified through the exact staged inventory when present.
  const FORBIDDEN_PREFIXES = [
    ".pi/agent/sessions/",
    ".pi/agent/logs/",
    ".pi/agent/artifacts/",
    ".pi/agent/missions/",
    ".pi/agent/reminders/",
    ".pi/agent/npm/node_modules/",
    ".pi/agent/scripts/.pi/",
    ".pi/agent/.pi/",
    ".pi/sessions/",

    ".pi/tasks/",
    ".pi/inference-slots/",
    ".pi/sibling-bridge/",
    ".pi/web-search-cache/",
    ".pi/backups/",
  ];
  const FORBIDDEN_FILE = [
    /^\.bak/,
    /\.bak$|\.bak\./,
    /^run-history\.jsonl$/,
    /^repo-recon\.json$/, // deleted 2026-08-31 — orphan of pi-context-router; kept as recreation guard
    // WHY: /^context-composition\.json$/ and /^telemetry\.json$/ removed 2026-08-31 —
    // orphans of the deleted pi-context-router (2026-08-12 refactor); files
    // deleted, nothing writes or reads them anymore.
  ];
  // WHY no name-segment matching for runtime dirs (the old FORBIDDEN_DIRS):
  // since the forks folded into extensions/, fork source names (e.g.
  // pi-subagents' missions/) are
  // LEGITIMATE source inside the trees we back up, so matching a bare segment
  // made every backup fail its own verification. The invariant that matters is
  // that the specific RUNTIME/regenerable dirs never appear at their canonical
  // mirrored paths, and that no vendor node_modules leaks in — every fork
  // imports its runtime deps through the reinstallable extensions/node_modules
  // symlink (excluded from the archive by path), so ANY node_modules entry is
  // forbidden (pi-fff's vendored copy was removed with that fork's retirement).
  for (const e of entries) {
    const base = e.split("/").pop();
    if (FORBIDDEN_FILE.some((r) => r.test(base)))
      report.forbidden.push(`file:${base}`);
    if (e.split("/").includes("node_modules"))
      report.forbidden.push(`node_modules:${e}`);
    if (FORBIDDEN_PREFIXES.some((p) => e.startsWith(p)))
      report.forbidden.push(`runtime:${e}`);
  }
  // WHY: dedupe only. The old `.filter(f => !report.forbidden.includes(f))`
  // predicate read the ORIGINAL array while it was being evaluated, so every
  // element was always "included" and the result was permanently empty —
  // the forbidden-entry check silently never fired.
  report.forbidden = [...new Set(report.forbidden)];
  return report;
}

// ── main ──────────────────────────────────────────────────────────────
function main() {
  const desktop = resolveDesktop();
  const piVer = piVersion();
  const nodeVer = process.version;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-"); // 2026-08-30-23-30-00
  const base = `Pi-Harness-Backup-${stamp}.zip`;

  const staging = fs.mkdtempSync(path.join(desktop, ".pi-harness-stage-"));
  STAGING_ROOT = staging;
  let finalPath = null;
  let failed = null;
  try {
    fs.chmodSync(staging, 0o700);
    const jobs = copyJobs();
    for (const j of jobs) copyJob(j, staging);

    const captured = collectEnvNames();
    const metaDir = path.join(staging, "META");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, "credentials.env"),
      captured.map((c) => `${c.name}=${shellQuote(c.value)}`).join("\n") + `\n`,
      { mode: 0o600 },
    );

    // included root paths for the manifest (home-relative)
    const roots = [...new Set(jobs.map((j) => j.dst.split(path.sep)[0]))];
    const fileCount0 = fs.readdirSync(staging, { recursive: true }).length;
    const manifest = buildManifest({
      archiveName: base,
      piVer,
      nodeVer,
      captured,
      includedRoots: roots,
      fileCount: fileCount0,
    });
    fs.writeFileSync(
      path.join(metaDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      {
        mode: 0o644,
      },
    );
    fs.writeFileSync(
      path.join(metaDir, "RESTORE.md"),
      restoreDoc(piVer, nodeVer),
      { mode: 0o644 },
    );

    // Exact staged inventory catches silent omissions anywhere in a fork.
    secureStaging(staging);
    const expected = stagedEntries(staging);
    const zipRoots = fs.readdirSync(staging);
    const zipName = `${base}.part.zip`;
    const zipPath = path.join(staging, zipName);
    execFileSync(
      "zip",
      [
        "-r",
        "-1", // fast compression: this is a local recovery snapshot
        "-q",
        "-y",
        zipPath,
        ...zipRoots,
      ],
      { cwd: staging, stdio: ["ignore", "pipe", "ignore"] },
    );

    // Validate before publication: a visible final ZIP is always complete.
    const report = verifyArchive(zipPath, expected);
    if (!report.integrityOk)
      throw new Error("archive integrity check failed after rename");
    if (report.required.length > 0)
      throw new Error(
        `archive missing required entries: ${report.required.join(", ")}`,
      );
    if (report.forbidden.length > 0)
      throw new Error(
        `archive contains forbidden entries: ${report.forbidden.join(", ")}`,
      );
    fs.chmodSync(zipPath, 0o600);
    let candidate = base;
    for (let n = 2; ; n++) {
      try {
        fs.linkSync(zipPath, path.join(desktop, candidate));
        finalPath = path.join(desktop, candidate);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        candidate = base.replace(/\.zip$/, `-${n}.zip`);
      }
    }
    const size = fs.statSync(finalPath).size;
    const mib = (size / (1024 * 1024)).toFixed(2);
    out(`Pi harness backup complete`);
    out(`  archive:       ${finalPath}`);
    out(`  size:          ${mib} MiB (${size} bytes)`);
    out(`  files:         ${report.fileCount}`);
    out(
      `  verification:  PASS (integrity ok; ${report.requiredTotal} required entries present; ${report.forbidden.length} forbidden classes absent; credentials: ${manifest.credentialEnvVars.length} env vars + literal apiKeys in models.json)`,
    );
    out(`  PRIVATE:       contains credentials and personal data; NEVER publish or commit this ZIP`);
    out(`  secrets:       none printed; values retained inside the archive (0600)`);
  } catch (e) {
    if (finalPath) {
      try {
        fs.unlinkSync(finalPath);
      } catch {
        /* ignore */
      }
    }
    failed = e;
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (failed) {
    // WHY exit here, after `finally`: the old process.exit(1) inside catch
    // synchronously terminated the process and skipped cleanup, so every
    // failed backup leaked a .pi-harness-stage-* dir (holding META/credentials.env)
    // on the Desktop. Cleanup must run before the process exits.
    err(`harness-backup failed: ${failed?.message ?? String(failed)}`);
    process.exit(1);
  }
}

try { main(); } catch {
  err("harness-backup failed before staging: check output directory and zip/unzip availability");
  process.exitCode = 1;
}
