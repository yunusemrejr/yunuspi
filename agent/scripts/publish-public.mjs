#!/usr/bin/env node
// Blessed publish path for this harness: live agent dir -> sanitized export ->
// public checkout -> safety scan -> commit -> push. The manual cp/scan/commit
// chain is easy to get wrong (unscanned content, wrong directory, forgotten
// scan), so the sanctioned release route lives in one owner instead.
//
// The live installation stays non-Git; only the checkout receives commits.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE =
  "Use [--checkout DIR] [--message TEXT] [--export-dir DIR] [--dry-run | --verify-only] [--allow-dirty].";

export function parseArgs(argv) {
  const opt = {
    checkout: path.join(os.homedir(), "yunuspi"),
    message: "",
    exportDir: "",
    dryRun: false,
    verifyOnly: false,
    allowDirty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--dry-run") {
      opt.dryRun = true;
      continue;
    }
    if (key === "--verify-only") { opt.verifyOnly = true; continue; }
    if (key === "--allow-dirty") {
      opt.allowDirty = true;
      continue;
    }
    if (
      ["--checkout", "--message", "--export-dir"].includes(key) &&
      argv[i + 1]
    ) {
      opt[
        {
          "--checkout": "checkout",
          "--message": "message",
          "--export-dir": "exportDir",
        }[key]
      ] = argv[++i];
      continue;
    }
    throw new Error(`Unknown option ${JSON.stringify(key)}. ${USAGE}`);
  }
  opt.checkout = path.resolve(opt.checkout);
  if (opt.dryRun && opt.verifyOnly) throw new Error("Choose --dry-run or --verify-only, not both.");
  if (opt.exportDir) opt.exportDir = path.resolve(opt.exportDir);
  return opt;
}

function canonicalPath(input) {
  let at = path.resolve(input); const missing = [];
  while (!existsSync(at)) {
    const parent = path.dirname(at); if (parent === at) break;
    missing.unshift(path.basename(at)); at = parent;
  }
  return path.join(realpathSync(at), ...missing);
}

/** The live tree is never a publish target, and the export must not nest
 * inside the checkout (a self-copy would recurse or leak temp state). */
export function assertSafeCheckout(checkout, exportDir, agentDir = AGENT_DIR) {
  checkout = canonicalPath(checkout);
  agentDir = canonicalPath(agentDir);
  exportDir = exportDir ? canonicalPath(exportDir) : "";
  if (
    checkout === path.resolve(agentDir) ||
    checkout.startsWith(path.resolve(agentDir) + path.sep) ||
    agentDir.startsWith(checkout + path.sep)
  )
    throw new Error(
      `Refusing to publish into the live installation: ${checkout}`,
    );
  if (
    exportDir &&
    (exportDir === checkout || exportDir.startsWith(checkout + path.sep) || checkout.startsWith(exportDir + path.sep))
  )
    throw new Error(
      `Export directory must live outside the checkout: ${exportDir}`,
    );
  if (!existsSync(path.join(checkout, ".git")))
    throw new Error(`Not a git checkout: ${checkout}`);
  return checkout;
}

function run(cmd, argv, cwd, { allowExit = [], capture = false } = {}) {
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  const code = result.status;
  if (code !== 0 && !allowExit.includes(code))
    throw new Error(
      `${cmd} ${argv.join(" ")} failed: exit=${code ?? result.error?.message ?? "none"}`,
    );
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function copyTree(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true }))
    cpSync(path.join(src, entry.name), path.join(dest, entry.name), {
      recursive: true,
      force: true,
    });
}

/** Overlay publication must never silently retain a file the exporter removed.
 * Leave deletion review to the caller instead of deleting arbitrary checkout
 * files. This also applies with --allow-dirty. */
export function assertNoStaleCheckoutPaths(exportDir, checkout) {
  const stale = [];
  const visit = (relative = "") => {
    for (const entry of readdirSync(path.join(checkout, relative), { withFileTypes: true })) {
      if (!relative && entry.name === ".git") continue;
      const child = path.join(relative, entry.name);
      const source = path.join(exportDir, child);
      let sourceStat;
      try { sourceStat = lstatSync(source); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!sourceStat) stale.push(child);
      else if (entry.isDirectory() && sourceStat.isDirectory()) visit(child);
      if (stale.length >= 20) return;
    }
  };
  visit();
  if (stale.length) throw new Error(
    `Checkout contains paths absent from the sanitized export. Review and remove obsolete paths before publishing; no files were copied:\n${stale.join("\n")}`,
  );
}

function verifyDistribution(exportDir) {
  // Dependencies must never enter the public checkout or the release export.
  const fixture = mkdtempSync(path.join(os.tmpdir(), "yunuspi-distribution-"));
  try {
    copyTree(exportDir, fixture);
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], fixture);
    run("npm", ["test"], fixture);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const exportDir =
    opt.exportDir || mkdtempSync(path.join(os.tmpdir(), "yunuspi-export-"));
  const cleanup = opt.exportDir
    ? null
    : () => rmSync(exportDir, { recursive: true, force: true });
  try {
    opt.checkout = assertSafeCheckout(opt.checkout, exportDir);
    console.log(`[publish] export  ${AGENT_DIR} -> ${exportDir}`);
    run(
      process.execPath,
      ["scripts/harness-public-export.mjs", "--output", exportDir],
      AGENT_DIR,
    );
    const diff = run(
      "diff",
      ["-rq", exportDir, opt.checkout, "-x", ".git"],
      AGENT_DIR,
      { allowExit: [1], capture: true },
    );
    const changed = diff.stdout.trim() ? diff.stdout.trim().split("\n") : [];
    console.log(
      changed.length
        ? `[publish] ${changed.length} differing path(s):\n${changed.slice(0, 20).join("\n")}`
        : "[publish] checkout already matches the export",
    );
    if (opt.dryRun) {
      console.log(
        "[publish] dry run: stopping before copy, scan, commit and push",
      );
      return;
    }
    if (opt.verifyOnly) {
      verifyDistribution(exportDir);
      console.log("[publish] verified distribution; checkout, index and remote untouched");
      return;
    }
    const dirty = run("git", ["status", "--porcelain"], opt.checkout, {
      capture: true,
    }).stdout.trim();
    const beforeHead = run("git", ["rev-parse", "HEAD"], opt.checkout, { capture: true }).stdout.trim();
    if (dirty && !opt.allowDirty)
      throw new Error(
        `Checkout has uncommitted changes; review or pass --allow-dirty:\n${dirty.slice(0, 800)}`,
      );
    assertNoStaleCheckoutPaths(exportDir, opt.checkout);
    console.log("[publish] verify  distribution in an isolated temporary copy");
    verifyDistribution(exportDir);
    if (run("git", ["status", "--porcelain"], opt.checkout, { capture: true }).stdout.trim() !== dirty ||
        run("git", ["rev-parse", "HEAD"], opt.checkout, { capture: true }).stdout.trim() !== beforeHead)
      throw new Error("Checkout changed during distribution verification; review concurrent work before publishing.");
    assertNoStaleCheckoutPaths(exportDir, opt.checkout);
    copyTree(exportDir, opt.checkout);
    console.log("[publish] scan    public safety checks");
    run(process.execPath, ["scripts/check-public.mjs", "."], opt.checkout);
    run("git", ["add", "-A"], opt.checkout);
    if (
      !run("git", ["diff", "--cached", "--quiet"], opt.checkout, {
        allowExit: [1],
      }).code
    ) {
      console.log("[publish] nothing to publish (checkout already current)");
      return;
    }
    const message =
      opt.message || `Harness update ${new Date().toISOString().slice(0, 10)}`;
    run("git", ["commit", "-q", "-m", message], opt.checkout);
    const branch =
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opt.checkout, {
        capture: true,
      }).stdout.trim() || "main";
    run("git", ["push", "-q", "origin", branch], opt.checkout);
    const head = run("git", ["log", "--oneline", "-1"], opt.checkout, {
      capture: true,
    }).stdout.trim();
    console.log(`[publish] pushed ${head} to origin/${branch}`);
  } finally {
    cleanup?.();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[publish] refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
