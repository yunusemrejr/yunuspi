/** Stable project identity for workdir-level memory.
 *
 * The project — not the session, not the absolute path — is the unit of
 * memory. Resolution walks up from the workdir collecting identity anchors;
 * the NEAREST anchor wins as the primary project, so an agent spawned in
 * the project root, a subdirectory, or a symlinked path resolves the same
 * project and therefore opens the same vector DB.
 *
 * Anchor precedence at one directory: explicit `.pi-project-id` beats git
 * remote. Marker files (package.json, …) never split a project: they only
 * anchor a generated identity when NO anchor exists anywhere up the tree.
 *
 * Nested projects are first-class: a subfolder with its own `.pi-project-id`
 * or its own git remote is its own project with its own DB, chained to its
 * ancestors. Retrieval fans out across the family (self + ancestors +
 * descendants), so the general project sees sub-project memories and vice
 * versa. Siblings stay isolated.
 *
 * Pure filesystem + bounded `git` spawns. No network, no inference.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ProjectIdBasis = "explicit" | "git-remote" | "generated";

export interface ProjectIdentity {
  /** Stable key: `prj_<12 hex>` (or the explicit id verbatim). */
  id: string;
  /** Human label: `<basename>-<short>`. Cosmetic only; never a key. */
  slug: string;
  basis: ProjectIdBasis;
  /** Registry key that produced this id (for alias bookkeeping). */
  key: string;
  /** Directory the identity was resolved from. */
  root: string;
}

/** One link of the project chain: identity + the anchor dir that owns it. */
export interface ProjectChainLink {
  identity: ProjectIdentity;
  /** Anchor directory (project root) for this link. */
  root: string;
}

export const PROJECT_ID_FILE = ".pi-project-id";
const EXPLICIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CHAIN_LINKS = 8;

type Env = Record<string, string | undefined>;

export function isValidProjectId(id: string): boolean {
  return EXPLICIT_ID_PATTERN.test(id);
}

/** Projects root. Override with PI_PROJECTS_DIR; defaults under the agent dir. */
export function projectsDir(env: Env = process.env): string {
  if (env.PI_PROJECTS_DIR) return env.PI_PROJECTS_DIR;
  const agent = env.PI_CODING_AGENT_DIR || path.join(env.HOME || homedir(), ".pi", "agent");
  return path.join(agent, "projects");
}

export function projectDir(identity: { id: string }, env: Env = process.env): string {
  if (!isValidProjectId(identity.id)) throw new Error(`Invalid project id: ${identity.id}`);
  return path.join(projectsDir(env), identity.id);
}

export function projectDbPath(identity: { id: string }, env: Env = process.env): string {
  return path.join(projectDir(identity, env), "memory.sqlite");
}

function registryPath(env: Env): string {
  return path.join(projectsDir(env), "registry.json");
}

interface RegistryEntry {
  id: string;
  slug: string;
  basis: ProjectIdBasis;
  firstSeen: string;
  lastSeen: string;
  /** Anchor dirs (project roots) observed for this id, newest first, max 8. */
  roots?: string[];
}

interface Registry {
  version: 1;
  keys: Record<string, RegistryEntry>;
}

function backupCorruptRegistry(file: string): void {
  try {
    const backup = `${file}.corrupt-${process.pid}-${Date.now()}.json`;
    fs.renameSync(file, backup);
  } catch {
    /* best effort; the fresh registry still unblocks resolution */
  }
}

function readRegistry(env: Env): Registry {
  const file = registryPath(env);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Registry;
    if (parsed && parsed.version === 1 && parsed.keys && typeof parsed.keys === "object") return parsed;
    backupCorruptRegistry(file);
  } catch (error) {
    // Missing registry starts fresh (explicit/git keys re-resolve). A corrupt
    // file is quarantined so the next write does not silently discard aliases.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") backupCorruptRegistry(file);
  }
  return { version: 1, keys: {} };
}

/** Atomic write (tmp + rename) under the registry lock. */
function writeRegistry(env: Env, registry: Registry): void {
  const file = registryPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Exclusive registry lock via atomic mkdir. Concurrent sessions resolving a
 * fresh identity converge on one id instead of last-writer-wins divergence.
 * Stale locks (crashed holders) expire; a stuck lock never blocks resolution.
 */
function withRegistryLock<T>(env: Env, fn: () => T): T {
  fs.mkdirSync(projectsDir(env), { recursive: true });
  const lockDir = `${registryPath(env)}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return fn();
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        /* a racing holder won; retry */
      }
      if (Date.now() >= deadline) return fn();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      /* best effort */
    }
  }
}

function updateRegistry(env: Env, fn: (registry: Registry) => void): Registry {
  return withRegistryLock(env, () => {
    const registry = readRegistry(env);
    fn(registry);
    writeRegistry(env, registry);
    return registry;
  });
}

function slugFor(dir: string, id: string): string {
  const base = (path.basename(path.resolve(dir)) || "root")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "root";
  return `${base}-${id.replace(/^prj_/, "").slice(-6)}`;
}

function bestEffortRealpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function recordRoot(entry: RegistryEntry, dir: string): void {
  const real = bestEffortRealpath(dir);
  entry.roots = [real, ...(entry.roots ?? []).filter((r) => r !== real)].slice(0, 8);
}

function assignId(env: Env, key: string, anchorDir: string, basis: ProjectIdBasis, now: string): ProjectIdentity {
  let resolved: ProjectIdentity | undefined;
  updateRegistry(env, (registry) => {
    const existing = registry.keys[key];
    if (existing && isValidProjectId(existing.id)) {
      existing.lastSeen = now;
      existing.slug = slugFor(anchorDir, existing.id);
      recordRoot(existing, anchorDir);
      resolved = { id: existing.id, slug: existing.slug, basis: existing.basis, key, root: anchorDir };
      return;
    }
    let id = `prj_${createHash("sha256").update(`${basis}:${key}`).digest("hex").slice(0, 12)}`;
    const taken = new Set(Object.values(registry.keys).map((entry) => entry.id));
    for (let salt = 1; taken.has(id); salt++) {
      id = `prj_${createHash("sha256").update(`${basis}:${key}:${salt}`).digest("hex").slice(0, 12)}`;
    }
    const slug = slugFor(anchorDir, id);
    const entry: RegistryEntry = { id, slug, basis, firstSeen: now, lastSeen: now, roots: [] };
    recordRoot(entry, anchorDir);
    registry.keys[key] = entry;
    resolved = { id, slug, basis, key, root: anchorDir };
  });
  return resolved as ProjectIdentity;
}

/** Walk up from cwd looking for a `.pi-project-id` file. Returns id + dir. */
export function findExplicitId(cwd: string): { id: string; dir: string } | undefined {
  let dir = path.resolve(cwd);
  for (let guard = 0; guard < 64; guard++) {
    const candidate = path.join(dir, PROJECT_ID_FILE);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024) {
        const first = fs.readFileSync(candidate, "utf-8").split("\n", 1)[0]?.trim() ?? "";
        if (isValidProjectId(first)) return { id: first, dir };
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Nearest directory containing `.git` (dir or worktree file), else undefined. */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let guard = 0; guard < 64; guard++) {
    try {
      fs.lstatSync(path.join(dir, ".git"));
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Bounded `origin` URL lookup. Never throws; undefined on any failure. */
export function gitOriginUrl(repoRoot: string, env: Env = process.env): string | undefined {
  if ((env.PI_PROJECT_ID_GIT ?? "").toLowerCase() === "off") return undefined;
  try {
    const url = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize remote URLs so https/ssh/scp spellings of one repo match. Only
 * the host + path identify a repository; scheme, user, port and `.git`
 * suffix are transport details.
 */
export function normalizeRemoteUrl(url: string): string {
  let rest = url.trim();
  const scp = /^([^@/:]+)@([^:]+):(.+)$/.exec(rest);
  if (scp) rest = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  try {
    const parsed = new URL(rest);
    let repo = parsed.pathname.replace(/\/+$/, "");
    if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
    if (!parsed.hostname || !repo || repo === "/") throw new Error("not a repository URL");
    return `${parsed.hostname.toLowerCase()}${repo.toLowerCase()}`;
  } catch {
    let fallback = rest.replace(/\/+$/, "");
    if (fallback.toLowerCase().endsWith(".git")) fallback = fallback.slice(0, -4);
    return fallback.toLowerCase();
  }
}

/** Project-root markers: anchor a generated identity, never split one. */
const PROJECT_ROOT_MARKERS = [
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "Cargo.toml",
  "go.mod", "composer.json", "Gemfile", "pom.xml", "build.gradle",
  "build.gradle.kts", "Package.swift", "CMakeLists.txt", "meson.build",
  "dune-project", "mix.exs", "pubspec.yaml", ".project", "flake.nix",
];

/**
 * Nearest ancestor directory holding a project marker. Never returns HOME
 * itself (a stray ~/package.json must not swallow every home subdirectory).
 */
export function findMarkerRoot(cwd: string): string | undefined {
  let home = "";
  try {
    home = path.resolve(homedir());
  } catch {
    home = "";
  }
  let dir = path.resolve(cwd);
  for (let guard = 0; guard < 64; guard++) {
    if (home && dir === home) return undefined;
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (fs.lstatSync(path.join(dir, marker)).isFile()) return dir;
      } catch {
        /* absent */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** One directory's winning anchor (explicit beats git at the same level). */
export interface ProjectAnchor {
  dir: string;
  explicitId?: string;
  remote?: string;
}

/**
 * Walk up collecting one anchor per anchoring directory, nearest first.
 * Remote-less `.git` dirs are not anchors (the walk continues above them).
 */
export function findProjectAnchors(cwd: string, env: Env = process.env, maxAnchors = MAX_CHAIN_LINKS): ProjectAnchor[] {
  const anchors: ProjectAnchor[] = [];
  let dir = path.resolve(cwd);
  for (let guard = 0; guard < 64 && anchors.length < maxAnchors; guard++) {
    let explicitId: string | undefined;
    const candidate = path.join(dir, PROJECT_ID_FILE);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024) {
        const first = fs.readFileSync(candidate, "utf-8").split("\n", 1)[0]?.trim() ?? "";
        if (isValidProjectId(first)) explicitId = first;
      }
    } catch {
      /* absent */
    }
    let remote: string | undefined;
    try {
      fs.lstatSync(path.join(dir, ".git"));
      const origin = gitOriginUrl(dir, env);
      if (origin) remote = normalizeRemoteUrl(origin);
    } catch {
      /* no repo here */
    }
    if (explicitId || remote) anchors.push({ dir, explicitId, remote });
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return anchors;
}

export interface ResolveProjectOptions {
  /** Defaults to PI_PROJECT_ID_AUTO (on unless `off`/`0`). */
  autoWrite?: boolean;
  now?: () => string;
}

function resolveGenerated(cwd: string, anchorDir: string, opts: ResolveProjectOptions, env: Env, now: string): ProjectChainLink {
  const autoWrite = opts.autoWrite ?? !["off", "0"].includes((env.PI_PROJECT_ID_AUTO ?? "on").toLowerCase());
  if (autoWrite) {
    const generated = `prj_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      fs.writeFileSync(path.join(anchorDir, PROJECT_ID_FILE), `${generated}\n`, { flag: "wx" });
      return resolveExplicit(anchorDir, generated, anchorDir, env, now);
    } catch (error) {
      // A concurrent writer (or a file that appeared mid-resolution) wins:
      // re-resolve once so both writers converge on one identity.
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        const chain = resolveProjectChain(cwd, { ...opts, autoWrite: false }, env);
        if (chain.length) return chain[0];
      }
    }
  }
  // Registry alias on the ANCHOR dir (not the spawn subdir) keeps every
  // location in the project pointing at one id even when the id file could
  // not be written (read-only dir, disabled auto-write).
  const real = bestEffortRealpath(anchorDir);
  const key = `path:${createHash("sha256").update(real).digest("hex")}`;
  const identity = assignId(env, key, anchorDir, "generated", now);
  return { identity: { ...identity, root: cwd }, root: anchorDir };
}

function resolveExplicit(cwd: string, explicitId: string, anchorDir: string, env: Env, now: string): ProjectChainLink {
  const key = `explicit:${explicitId}`;
  let slug = slugFor(anchorDir, explicitId);
  // Computed outside the lock: the cross-link alias must not hold the
  // registry locked across a child-process spawn.
  const origin = gitOriginUrl(anchorDir, env);
  updateRegistry(env, (registry) => {
    const seen = registry.keys[key];
    slug = slugFor(anchorDir, explicitId);
    const entry: RegistryEntry = {
      id: explicitId,
      slug,
      basis: "explicit",
      firstSeen: seen?.firstSeen ?? now,
      lastSeen: now,
      roots: seen?.roots ?? [],
    };
    recordRoot(entry, anchorDir);
    registry.keys[key] = entry;
    // Cross-link: the same dir's git remote resolves to this explicit id, so
    // a second clone (same remote, no id file) shares the project — unless
    // the remote key already belongs to a different id (never steal).
    if (origin) {
      const remoteKey = `remote:${normalizeRemoteUrl(origin)}`;
      const mapped = registry.keys[remoteKey];
      if (!mapped) {
        const alias: RegistryEntry = { id: explicitId, slug, basis: "explicit", firstSeen: now, lastSeen: now, roots: [] };
        recordRoot(alias, anchorDir);
        registry.keys[remoteKey] = alias;
      }
    }
  });
  return { identity: { id: explicitId, slug, basis: "explicit", key, root: cwd }, root: anchorDir };
}

/**
 * Resolve the full project chain for a workdir: primary first, then
 * ancestors (outermost last). Links with duplicate ids collapse — the same
 * explicit id repeated at two levels is one project, not parent/child.
 */
export function resolveProjectChain(cwd: string, opts: ResolveProjectOptions = {}, env: Env = process.env): ProjectChainLink[] {
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const root = path.resolve(cwd);
  const anchors = findProjectAnchors(root, env);
  if (!anchors.length) {
    const anchorDir = findMarkerRoot(root) ?? root;
    return [resolveGenerated(root, anchorDir, opts, env, now)];
  }
  const chain: ProjectChainLink[] = [];
  const seenIds = new Set<string>();
  for (const anchor of anchors) {
    let link: ProjectChainLink;
    if (anchor.explicitId) {
      link = resolveExplicit(root, anchor.explicitId, anchor.dir, env, now);
    } else if (anchor.remote) {
      const identity = assignId(env, `remote:${anchor.remote}`, anchor.dir, "git-remote", now);
      link = { identity: { ...identity, root }, root: anchor.dir };
    } else {
      continue;
    }
    if (seenIds.has(link.identity.id)) continue;
    seenIds.add(link.identity.id);
    chain.push(link);
    if (chain.length >= MAX_CHAIN_LINKS) break;
  }
  if (!chain.length) {
    const anchorDir = findMarkerRoot(root) ?? root;
    return [resolveGenerated(root, anchorDir, opts, env, now)];
  }
  return chain;
}

/** Resolve the primary project identity for a workdir (chain head). */
export function resolveProjectIdentity(cwd: string, opts: ResolveProjectOptions = {}, env: Env = process.env): ProjectIdentity {
  return resolveProjectChain(cwd, opts, env)[0].identity;
}

export interface DescendantProject {
  id: string;
  slug: string;
  basis: ProjectIdBasis;
  root: string;
}

/**
 * Known sub-projects strictly below `root` (from registry anchor roots).
 * Lets a general project see its sub-project DBs. Bounded and ordered by
 * depth, then path. Registry reads are lock-free (stale reads are harmless:
 * missing DBs are skipped when opening family stores).
 */
export function findDescendantProjects(root: string, env: Env = process.env, limit = 8): DescendantProject[] {
  const base = bestEffortRealpath(root);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  const registry = readRegistry(env);
  const out: DescendantProject[] = [];
  const seenIds = new Set<string>();
  for (const entry of Object.values(registry.keys)) {
    if (!entry?.id || seenIds.has(entry.id)) continue;
    const below = (entry.roots ?? []).filter((r) => r.startsWith(prefix));
    if (!below.length) continue;
    seenIds.add(entry.id);
    below.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    out.push({ id: entry.id, slug: entry.slug, basis: entry.basis, root: below[0] });
  }
  out.sort((a, b) => a.root.length - b.root.length || (a.root < b ? -1 : 1));
  return out.slice(0, Math.max(1, Math.min(32, limit)));
}
