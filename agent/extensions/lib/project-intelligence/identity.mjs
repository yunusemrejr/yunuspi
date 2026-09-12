import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
const exec = promisify(execFile);
const MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "pom.xml",
  "CMakeLists.txt",
  "build.gradle",
];
export async function gitRead(cwd, args, { signal, maxBuffer = 131072 } = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete env[key];
  try {
    return (
      await exec("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
        cwd,
        env,
        signal,
        timeout: 2500,
        maxBuffer,
        encoding: "utf8",
      })
    ).stdout.trim();
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "ENOENT" || error.code === 128 || error.code === 1)
      return undefined;
    throw error;
  }
}
async function anchor(directory) {
  const stat = await fs.stat(directory);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
async function workspaceManifest(directory) {
  let handle;
  try {
    handle = await fs.open(path.join(directory, "package.json"), "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size > 65536) return;
    const bytes = Buffer.alloc(65537),
      { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead > 65536 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      return;
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch {
  } finally {
    await handle?.close();
  }
}
async function initializeRegistry(db, signal) {
  db.exec("PRAGMA busy_timeout=2000");
  // journal_mode transitions can return SQLITE_BUSY before busy_timeout is
  // honored. Retry only initialization, before any identity mutation.
  for (let attempt = 0; attempt < 5; attempt++) {
    signal?.throwIfAborted();
    let transaction = false;
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE",
      );
      transaction = true;
      db.exec(
        "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS anchors(anchor TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL); CREATE TABLE IF NOT EXISTS checkouts(anchor TEXT PRIMARY KEY,id TEXT NOT NULL,project TEXT NOT NULL,root TEXT NOT NULL,seen INTEGER NOT NULL); COMMIT",
      );
      return;
    } catch (error) {
      if (transaction)
        try {
          db.exec("ROLLBACK");
        } catch {}
      if (attempt === 4 || !/(?:busy|locked)/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
async function localRoot(cwd) {
  let here = cwd,
    selected;
  for (
    let depth = 0;
    depth < 10 && here !== os.homedir() && path.dirname(here) !== here;
    depth++
  ) {
    for (const marker of MARKERS)
      try {
        if ((await fs.stat(path.join(here, marker))).isFile()) {
          selected ??= here;
          break;
        }
      } catch {}
    if ((await workspaceManifest(here))?.workspaces) selected = here;
    here = path.dirname(here);
  }
  return selected ?? cwd;
}
/** Private registry: filesystem identity joins symlinks and moves; Git common
 * directory joins worktrees. Remote equality alone never joins live clones. */
export async function resolveProjectIdentity(cwd, { stateDir, signal } = {}) {
  signal?.throwIfAborted();
  const canonical = await fs.realpath(cwd);
  if (!(await fs.stat(canonical)).isDirectory())
    throw Error("Project cwd must be a directory.");
  const top = await gitRead(canonical, ["rev-parse", "--show-toplevel"], {
    signal,
  });
  const root = top ? await fs.realpath(top) : await localRoot(canonical);
  const commonRaw = top
    ? await gitRead(
        root,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { signal },
      )
    : undefined;
  const commonDir = commonRaw
    ? await fs.realpath(path.resolve(root, commonRaw))
    : undefined;
  const [rootAnchor, commonAnchor, branch, head] = await Promise.all([
    anchor(root),
    commonDir ? anchor(commonDir) : undefined,
    top
      ? gitRead(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          signal,
        })
      : undefined,
    top
      ? gitRead(canonical, ["rev-parse", "--verify", "HEAD"], { signal })
      : undefined,
  ]);
  if (!stateDir || !path.isAbsolute(stateDir))
    throw Error(
      "An absolute private intelligence state directory is required.",
    );
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
  const dbPath = path.join(stateDir, "registry.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    await initializeRegistry(db, signal);
    await fs.chmod(dbPath, 0o600);
    signal?.throwIfAborted();
    db.exec("BEGIN IMMEDIATE");
    try {
      const lookup = (key) =>
        key &&
        db.prepare("SELECT project FROM anchors WHERE anchor=?").get(key)
          ?.project;
      let id =
        lookup(commonAnchor ? `git:${commonAnchor}` : undefined) ??
        lookup(`root:${rootAnchor}`);
      id ??= randomUUID();
      db.prepare("INSERT OR IGNORE INTO projects VALUES (?,?)").run(
        id,
        Date.now(),
      );
      db.prepare("INSERT OR IGNORE INTO anchors VALUES (?,?,?)").run(
        `root:${rootAnchor}`,
        id,
        "root",
      );
      if (commonAnchor)
        db.prepare("INSERT OR IGNORE INTO anchors VALUES (?,?,?)").run(
          `git:${commonAnchor}`,
          id,
          "git",
        );
      // The common-dir owner wins if a previously standalone directory is
      // deliberately attached as a worktree. Preserve the old domain, never
      // delete/merge its facts as a side effect of identity resolution.
      const existing = db
        .prepare("SELECT id,project FROM checkouts WHERE anchor=?")
        .get(rootAnchor);
      const checkoutId = existing?.project === id ? existing.id : randomUUID();
      db.prepare(
        "INSERT INTO checkouts VALUES (?,?,?,?,?) ON CONFLICT(anchor) DO UPDATE SET id=excluded.id,project=excluded.project,root=excluded.root,seen=excluded.seen",
      ).run(rootAnchor, checkoutId, id, root, Date.now());
      db.exec("COMMIT");
      return {
        id,
        checkoutId,
        root,
        cwd: canonical,
        commonDir,
        branch: branch ?? (head ? "(detached)" : undefined),
        head,
        name: path.basename(root) || root,
        git: !!top,
        stateDir,
        dbPath: path.join(stateDir, id + ".sqlite"),
        identityBasis: commonDir
          ? "git-common-directory filesystem identity"
          : "project-root filesystem identity",
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
