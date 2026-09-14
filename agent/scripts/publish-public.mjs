#!/usr/bin/env node
// Blessed publish path for this harness: live agent dir -> sanitized export ->
// public checkout -> safety scan -> commit -> push. The manual cp/scan/commit
// chain is easy to get wrong (unscanned content, wrong directory, forgotten
// scan), so the sanctioned release route lives in one owner instead.
//
// The live installation stays non-Git; only the checkout receives commits.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE =
  "Use [--checkout DIR] [--message TEXT] [--export-dir DIR] [--test-concurrency N] [--dry-run | --verify-only] [--allow-dirty].";

export function parseArgs(argv) {
  const opt = {
    checkout: path.join(os.homedir(), "yunuspi"),
    message: "",
    exportDir: "",
    dryRun: false,
    verifyOnly: false,
    allowDirty: false,
    testConcurrency: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--dry-run") {
      opt.dryRun = true;
      continue;
    }
    if (key === "--verify-only") {
      opt.verifyOnly = true;
      continue;
    }
    if (key === "--allow-dirty") {
      opt.allowDirty = true;
      continue;
    }
    if (key === "--test-concurrency" && argv[i + 1]) {
      const value = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(value) || value < 1 || value > 16)
        throw new Error("--test-concurrency must be 1-16");
      opt.testConcurrency = value;
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
  if (opt.dryRun && opt.verifyOnly)
    throw new Error("Choose --dry-run or --verify-only, not both.");
  if (opt.exportDir) opt.exportDir = path.resolve(opt.exportDir);
  return opt;
}

function canonicalPath(input) {
  let at = path.resolve(input);
  const missing = [];
  while (!existsSync(at)) {
    const parent = path.dirname(at);
    if (parent === at) break;
    missing.unshift(path.basename(at));
    at = parent;
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
    (exportDir === checkout ||
      exportDir.startsWith(checkout + path.sep) ||
      checkout.startsWith(exportDir + path.sep))
  )
    throw new Error(
      `Export directory must live outside the checkout: ${exportDir}`,
    );
  if (!existsSync(path.join(checkout, ".git")))
    throw new Error(`Not a git checkout: ${checkout}`);
  return checkout;
}

function run(
  cmd,
  argv,
  cwd,
  { allowExit = [], capture = false, env, timeoutMs } = {},
) {
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    ...(env ? { env } : {}),
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
  });
  const code = result.status;
  // A timed-out child must be reported as a timeout, not as an anonymous
  // non-zero exit (status is null once the kill signal wins).
  if (
    timeoutMs &&
    code === null &&
    (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL")
  )
    throw new Error(`${cmd} ${argv.join(" ")} timed out after ${timeoutMs}ms`);
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
    for (const entry of readdirSync(path.join(checkout, relative), {
      withFileTypes: true,
    })) {
      if (!relative && entry.name === ".git") continue;
      const child = path.join(relative, entry.name);
      const source = path.join(exportDir, child);
      let sourceStat;
      try {
        sourceStat = lstatSync(source);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!sourceStat) stale.push(child);
      else if (entry.isDirectory() && sourceStat.isDirectory()) visit(child);
      if (stale.length >= 20) return;
    }
  };
  visit();
  if (stale.length)
    throw new Error(
      `Checkout contains paths absent from the sanitized export. Review and remove obsolete paths before publishing; no files were copied:\n${stale.join("\n")}`,
    );
}

/** File-level parallelism for the public suite during publication.
 *
 * The checkout pins a serial default (`--test-concurrency=1`) so a contributor's
 * `npm test` stays predictable, but that makes a release spend minutes idling
 * cores: 79 files run one at a time, and two real-namespace sandbox tests each
 * hold a slot for their own spawn budget. The publisher raises concurrency for
 * the same file set; the sandbox budget is bounded separately, so a slow host
 * costs seconds instead of minutes. PI_PUBLISH_TEST_CONCURRENCY overrides. */
export function distributionTestConcurrency(
  env = process.env,
  cores = os.availableParallelism?.() ?? os.cpus().length,
) {
  const override = Number.parseInt(env.PI_PUBLISH_TEST_CONCURRENCY ?? "", 10);
  if (Number.isFinite(override) && override > 0) return Math.min(16, override);
  return Math.max(1, Math.min(4, Number(cores) - 2 || 1));
}

/** Temp root for the distribution test run.
 *
 * Tests create their fixtures with mkdtemp(os.tmpdir()). The guarded-command
 * wrapper keeps protected roots read-only by re-binding every existing sibling
 * of each ancestor writable, so a fixture under a busy /tmp (thousands of
 * entries) turns one sandboxed spawn into ~7k bwrap arguments (~9s each; the
 * real-isolation tests spent ~220s there). A low-entry temp root produces the
 * same tests with ~135 arguments (~0.4s per spawn). Candidates are tried in
 * order; the caller removes the returned directory. */
export function createDistributionTempRoot(
  candidates = ["/var/tmp", os.tmpdir()],
) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.W_OK | constants.X_OK);
      return mkdtempSync(path.join(candidate, "yunuspi-dist-tmp-"));
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "EACCES" ||
        error?.code === "EPERM" ||
        error?.code === "EROFS"
      )
        continue;
      throw error;
    }
  }
  // No candidate was usable: keep the run working on the system temp root.
  return mkdtempSync(path.join(os.tmpdir(), "yunuspi-dist-tmp-"));
}

function verifyDistribution(exportDir, { testConcurrency, timings }) {
  // Dependencies must never enter the public checkout or the release export.
  const fixture = mkdtempSync(path.join(os.tmpdir(), "yunuspi-distribution-"));
  const tempRoot = createDistributionTempRoot();
  const timed = (label, work) => {
    const started = Date.now();
    try {
      return work();
    } finally {
      timings?.push([label, Date.now() - started]);
    }
  };
  try {
    copyTree(exportDir, fixture);
    // --prefer-offline keeps a warm npm cache from being re-fetched from scratch.
    timed("deps", () =>
      run(
        "npm",
        [
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--prefer-offline",
        ],
        fixture,
        { timeoutMs: 600000 },
      ),
    );
    timed(`tests(concurrency=${testConcurrency})`, () =>
      run("npm", ["test"], fixture, {
        timeoutMs: 1200000,
        env: {
          ...process.env,
          PI_PUBLIC_TEST_CONCURRENCY: String(testConcurrency),
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
        },
      }),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const PUBLISH_LOCK = path.join(AGENT_DIR, "logs", "publish-public.lock");

/** One release at a time per installation.
 *
 * Two sessions publishing together otherwise each run a full distribution suite
 * and the second is refused by the checkout guard afterwards, which wastes the
 * whole verification. `flock -n` makes the second call fail immediately with the
 * holder named and exit 75 instead of queueing behind a minute of tests. */
export function publishLockHeld(env = process.env) {
  return env.PI_PUBLISH_LOCK_HELD === "1";
}

export function runWithPublishLock(argv = process.argv.slice(1)) {
  if (publishLockHeld()) return main();
  mkdirSync(path.dirname(PUBLISH_LOCK), { recursive: true });
  const child = spawnSync(
    "/bin/bash",
    [
      "-c",
      'exec 9>"$1" || exit 1; flock -n -E 75 9 || exit $?; export PI_PUBLISH_LOCK_HELD=1; exec "$2" "${@:3}"',
      "publish-lock",
      PUBLISH_LOCK,
      process.execPath,
      ...argv,
    ],
    { stdio: "inherit" },
  );
  if (child.status === 75) {
    console.error(
      `[publish] refused: another publish holds ${PUBLISH_LOCK}; wait for it instead of starting a second distribution run`,
    );
    return 75;
  }
  return child.status ?? 1;
}

/** The verified export must still match the live source at publish time.
 *
 * The distribution test runs for minutes against the shared live tree, so an
 * edit between export and copy (another session, or an automatic formatter)
 * would otherwise publish bytes that no longer match the live source —
 * observed 2026-09-14 when a formatter reformat landed mid-publish and the
 * committed bytes diverged from the tree they claim to release. Re-export and
 * require byte equality with what was verified. */
export function assertExportStillCurrent(exportDir, runExport) {
  const reExport = mkdtempSync(path.join(os.tmpdir(), "yunuspi-reexport-"));
  try {
    runExport(reExport);
    const drifted = run(
      "diff",
      ["-rq", reExport, exportDir, "-x", ".git"],
      AGENT_DIR,
      { allowExit: [1], capture: true },
    ).stdout.trim();
    if (drifted)
      throw new Error(
        `Live source changed during distribution verification; the verified export is stale, publish refused. Re-run publish. First drift:\n${drifted.split("\n").slice(0, 3).join("\n")}`,
      );
  } finally {
    rmSync(reExport, { recursive: true, force: true });
  }
}

/** Commits the checkout holds that origin does not.
 *
 * A publish killed between `git commit` and `git push` leaves the checkout
 * ahead of its remote with no record anywhere. Observed 2026-09-14: the
 * background task `publish wave 7` was SIGTERM'd as "Killed during Pi session
 * shutdown/reload" right after the commit, so the release stayed local and the
 * next run reported "nothing to publish" and stranded it. The next run must
 * detect and finish that state instead. */
export function pendingReleaseCommits(checkout, branch, runner = run) {
  const ref = `refs/remotes/origin/${branch}`;
  const known =
    runner("git", ["rev-parse", "--verify", "--quiet", ref], checkout, {
      allowExit: [1],
      capture: true,
    }).code === 0;
  if (!known) return [];
  const ahead = runner("git", ["log", "--oneline", `${ref}..HEAD`], checkout, {
    capture: true,
  }).stdout.trim();
  return ahead ? ahead.split("\n") : [];
}

/** How a scanned release finishes.
 *
 * `stagedChanges` false plus pending commits is the interrupted-release state:
 * reporting "nothing to publish" there would silently strand a verified commit
 * that origin never received, so it must push instead. */
export function releaseCompletion({ stagedChanges, pendingCommits }) {
  if (stagedChanges) return "commit-and-push";
  if (pendingCommits > 0) return "push-pending";
  return "nothing";
}

/** Push, then require the remote branch to actually carry the local HEAD.
 *
 * "git push exited 0" is not evidence the release landed; a rejected ref, a
 * killed transfer or a mistyped remote all exit non-zero late or leave the
 * remote ref unchanged. The postcondition is the remote SHA, so it is re-read
 * from the remote rather than assumed. */
export function pushAndVerifyRelease(checkout, branch, runner = run) {
  const head = runner("git", ["rev-parse", "HEAD"], checkout, {
    capture: true,
  }).stdout.trim();
  runner("git", ["push", "-q", "origin", branch], checkout, {
    timeoutMs: 300000,
  });
  let remote = "";
  try {
    remote =
      runner("git", ["ls-remote", "origin", `refs/heads/${branch}`], checkout, {
        capture: true,
      })
        .stdout.trim()
        .split(/\s+/)[0] || "";
  } catch (error) {
    throw new Error(
      `git push ran but the remote SHA could not be verified (re-run to confirm origin/${branch}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (remote !== head)
    throw new Error(
      `release did not land: origin/${branch}=${remote || "(absent)"} but local HEAD=${head}`,
    );
  return head;
}

const TERMINATION_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** Session shutdown must not strand a release between commit and push.
 *
 * The commit/push section owns the point of no return, so termination signals
 * arriving inside it are deferred and replayed right afterwards instead of
 * killing the runner mid-release (the 2026-09-14 loss above). Outside that
 * section the previous behavior is kept: the signal exits immediately. */
export function installReleaseCompletionGuard(
  target = process,
  signals = TERMINATION_SIGNALS,
) {
  let critical = false;
  let deferred = "";
  for (const name of Object.keys(signals))
    target.on(name, () => {
      if (!critical) {
        console.error(`[publish] aborted by ${name} before committing`);
        target.exit(signals[name]);
        return;
      }
      deferred = name;
      console.error(
        `[publish] deferring ${name} until the verified release is committed and pushed`,
      );
    });
  return {
    begin: () => {
      critical = true;
    },
    end: () => {
      critical = false;
      return deferred;
    },
  };
}

/** Whether the index holds changes relative to HEAD.
 *
 * `git diff --cached --quiet` exits 1 when something is staged and 0 when
 * nothing is. Reading that code as a truthy "has changes" flag is how the fix
 * for the interrupted-release loss itself reported "nothing to publish" while
 * 69 exported files sat staged (2026-09-15). The exit code is now named. */
export function hasStagedChanges(checkout, runner = run) {
  return (
    runner("git", ["diff", "--cached", "--quiet"], checkout, {
      allowExit: [1],
    }).code === 1
  );
}

function main() {
  const guard = installReleaseCompletionGuard();
  let deferredSignal = "";
  const opt = parseArgs(process.argv.slice(2));
  const timings = [];
  const testConcurrency = opt.testConcurrency || distributionTestConcurrency();
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
      verifyDistribution(exportDir, { testConcurrency, timings });
      console.log(
        "[publish] verified distribution; checkout, index and remote untouched",
      );
      return;
    }
    const dirty = run("git", ["status", "--porcelain"], opt.checkout, {
      capture: true,
    }).stdout.trim();
    const beforeHead = run("git", ["rev-parse", "HEAD"], opt.checkout, {
      capture: true,
    }).stdout.trim();
    const branch =
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opt.checkout, {
        capture: true,
      }).stdout.trim() || "main";
    const stranded = pendingReleaseCommits(opt.checkout, branch);
    if (stranded.length)
      console.log(
        `[publish] checkout holds ${stranded.length} commit(s) absent from origin/${branch} (earlier run was interrupted); this run finishes that release:\n${stranded.slice(0, 5).join("\n")}`,
      );
    if (dirty && !opt.allowDirty)
      throw new Error(
        `Checkout has uncommitted changes; review or pass --allow-dirty:\n${dirty.slice(0, 800)}`,
      );
    assertNoStaleCheckoutPaths(exportDir, opt.checkout);
    console.log(
      `[publish] verify  distribution in an isolated temporary copy (test concurrency ${testConcurrency})`,
    );
    verifyDistribution(exportDir, { testConcurrency, timings });
    if (
      run("git", ["status", "--porcelain"], opt.checkout, {
        capture: true,
      }).stdout.trim() !== dirty ||
      run("git", ["rev-parse", "HEAD"], opt.checkout, {
        capture: true,
      }).stdout.trim() !== beforeHead
    )
      throw new Error(
        "Checkout changed during distribution verification; review concurrent work before publishing.",
      );
    assertNoStaleCheckoutPaths(exportDir, opt.checkout);
    console.log("[publish] re-export equality check against the live tree");
    assertExportStillCurrent(exportDir, (dir) =>
      run(
        process.execPath,
        ["scripts/harness-public-export.mjs", "--output", dir],
        AGENT_DIR,
      ),
    );
    copyTree(exportDir, opt.checkout);
    console.log("[publish] scan    public safety checks");
    run(process.execPath, ["scripts/check-public.mjs", "."], opt.checkout);
    run("git", ["add", "-A"], opt.checkout);
    const stagedChanges = hasStagedChanges(opt.checkout);
    const pending = pendingReleaseCommits(opt.checkout, branch);
    const action = releaseCompletion({
      stagedChanges,
      pendingCommits: pending.length,
    });
    if (action === "nothing") {
      console.log("[publish] nothing to publish (checkout already current)");
      return;
    }
    guard.begin();
    if (action === "push-pending")
      console.log(
        `[publish] finishing an interrupted release: pushing ${pending.length} commit(s) already committed to the checkout but absent from origin/${branch}`,
      );
    else {
      const message =
        opt.message ||
        `Harness update ${new Date().toISOString().slice(0, 10)}`;
      run("git", ["commit", "-q", "-m", message], opt.checkout);
    }
    const head = pushAndVerifyRelease(opt.checkout, branch);
    guard.end();
    console.log(
      `[publish] pushed ${head} to origin/${branch} (remote SHA verified)`,
    );
  } finally {
    deferredSignal = guard.end();
    cleanup?.();
    if (timings.length)
      console.log(
        `[publish] timings ${timings.map(([label, ms]) => `${label}=${(ms / 1000).toFixed(1)}s`).join(" ")}`,
      );
  }
  if (deferredSignal) {
    console.error(
      `[publish] release completed while ${deferredSignal} was pending; exiting with the interrupted status`,
    );
    process.exitCode = TERMINATION_SIGNALS[deferredSignal] ?? 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const code = runWithPublishLock();
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    console.error(
      `[publish] refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
