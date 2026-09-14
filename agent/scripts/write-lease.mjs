// scripts/write-lease.mjs — per-path write leases for the live harness tree.
//
// WHY: the harness session-lock defers ALL repair while any pi process is
// alive, which conflates "a session exists" with "a writer is on this file".
// Write leases separate the two: a writer (patch apply, bench, editing lane)
// holds a heartbeat lease on the exact path(s) it mutates. Consumers:
//   - scripts/verify-harness.mjs --fix: a patch target whose file carries a
//     live foreign lease is DEFERRED (reported, not failed) instead of racing
//     the writer; the quiescent watchdog window applies it next pass.
//   - sessions/children: `write-lease.mjs check <paths>` gives a cheap scoped
//     probe ("is anyone mutating these right now?") while writers are active;
//     full verification runs once `quiescent` reports no live leases.
//
// Semantics:
//   - lease = JSON under ~/.pi/agent/write-leases/<sha1(path)>.lock:
//     {path, owner, acquiredAt, heartbeat, ttlMs}
//   - acquire: fresh/absent -> grant; LIVE foreign lease -> exit 3;
//     stale (heartbeat > ttlMs, or owner pid dead) -> reclaim.
//   - release: owner match (or --force / stale) -> delete; else exit 3.
//   - check <paths...>: one "<path>\tfree|leased\t<owner>" line each;
//     exit 0 iff every path is free.
//   - quiescent: exit 0 iff no LIVE lease anywhere; exit 75 otherwise.
// Exit codes are stable API: 0 ok/free, 3 conflict, 75 deferred/in-use.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_DIR =
  process.env.PI_WRITE_LEASE_DIR ||
  path.join(os.homedir(), ".pi", "agent", "write-leases");
const DEFAULT_TTL_MS = Number(process.env.PI_WRITE_LEASE_TTL_MS || 10 * 60_000);

export { DEFAULT_DIR, DEFAULT_TTL_MS };

function lockFile(p) {
  // Stable key: absolute, symlink-unresolved (patch targets are chunk files;
  // a symlink swap must not create a second lease for the same file).
  const key = crypto
    .createHash("sha1")
    .update(path.resolve(p))
    .digest("hex");
  return path.join(DEFAULT_DIR, `${key}.lock`);
}

function readLease(p) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFile(p), "utf8"));
    if (typeof data?.path !== "string" || !Number.isFinite(data.heartbeat))
      return null;
    return data;
  } catch {
    return null;
  }
}

/** pid liveness on linux: /proc/<pid> existence (kill -0 can hit EPERM races). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown owner -> be conservative
  if (pid === process.pid) return true;
  try {
    return fs.existsSync(`/proc/${pid}`);
  } catch {
    return true;
  }
}

function isStale(lease, now = Date.now()) {
  if (now - lease.heartbeat > (lease.ttlMs || DEFAULT_TTL_MS)) return true;
  return Number.isInteger(lease.ownerPid) ? !pidAlive(lease.ownerPid) : false;
}

function writeLease(p, owner, { ttlMs, heartbeat } = {}) {
  const file = lockFile(p);
  fs.mkdirSync(DEFAULT_DIR, { recursive: true });
  // Named owners (explicit --owner, e.g. cross-process lane coordination) are
  // short-lived CLI invocations: their pid dies per-command, so liveness must
  // come from the heartbeat TTL. Default owners (pid:PID) run inside a living
  // process, where /proc liveness is the sharper stale signal.
  const named = owner !== undefined && owner !== `pid:${process.pid}`;
  const payload = {
    path: path.resolve(p),
    owner: owner || `pid:${process.pid}`,
    ownerPid: named ? null : process.pid,
    host: os.hostname(),
    acquiredAt: readLease(p)?.acquiredAt ?? Date.now(),
    heartbeat: heartbeat ?? Date.now(),
    ttlMs: ttlMs ?? DEFAULT_TTL_MS,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, file); // atomic replace; unique key per path -> no cross-path races
  return payload;
}

// ── operations ────────────────────────────────────────────────────────────

/** Returns {status:"granted"|"reclaimed"|"conflict", lease}. exit-free (library). */
export function acquire(p, { owner, ttlMs, force } = {}) {
  const existing = readLease(p);
  if (!existing) return { status: "granted", lease: writeLease(p, owner, { ttlMs }) };
  const caller = owner || `pid:${process.pid}`;
  if (existing.owner === caller && !isStale(existing))
    return { status: "granted", lease: existing };
  if (force || isStale(existing))
    // Reclaim transfers holdership to the caller — otherwise the new holder
    // could never release (owner mismatch) and the lease would leak.
    return {
      status: "reclaimed",
      lease: writeLease(p, owner, { ttlMs, heartbeat: Date.now() }),
    };
  return { status: "conflict", lease: existing };
}

export function renew(p, { owner } = {}) {
  const lease = readLease(p);
  if (!lease) return { status: "absent", lease: null };
  const caller = owner || `pid:${process.pid}`;
  if (lease.owner !== caller && !isStale(lease))
    return { status: "conflict", lease };
  // Renew by a new caller on a stale lease transfers holdership (same
  // reclaim rule as acquire); the original TTL is preserved.
  return { status: "renewed", lease: writeLease(p, caller, { ttlMs: lease.ttlMs, heartbeat: Date.now() }) };
}

export function release(p, { owner, force } = {}) {
  const lease = readLease(p);
  if (!lease) return { status: "absent", lease: null };
  const caller = owner || `pid:${process.pid}`;
  if (lease.owner !== caller && !force && !isStale(lease))
    return { status: "conflict", lease };
  fs.rmSync(lockFile(p), { force: true });
  return { status: "released", lease };
}

export function liveLeases(now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(DEFAULT_DIR).filter((f) => f.endsWith(".lock"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of entries) {
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, f), "utf8"));
      if (Number.isFinite(lease?.heartbeat) && !isStale(lease, now)) out.push(lease);
    } catch {
      /* torn/unreadable lease -> stale, ignored (reclaim-safe) */
    }
  }
  return out;
}

export function checkPaths(paths, now = Date.now()) {
  const leases = new Map(liveLeases(now).map((l) => [l.path, l]));
  return paths.map((p) => {
    const abs = path.resolve(p);
    const lease = leases.get(abs);
    return { path: abs, free: !lease, owner: lease?.owner ?? null };
  });
}

// Target-descriptor gate (consumed by verify-harness patch apply and by any
// tool that needs "is this target writable right now?"). Patch targets may
// expose the mutated file(s) as t.file (string), t.files() (array) or
// t.path() (string); anything else is written-without-lease-info and never
// deferred. Lease-store errors never block (advisory fence, not a hard gate).
export function leaseFilesOf(t) {
  try {
    if (t && typeof t.file === "string" && t.file.length > 0) return [t.file];
    if (t && typeof t.files === "function") {
      const f = t.files();
      if (
        Array.isArray(f) &&
        f.length > 0 &&
        f.every((x) => typeof x === "string")
      )
        return f;
    }
    if (t && typeof t.path === "function") {
      const p = t.path();
      if (typeof p === "string" && p.length > 0) return [p];
    }
  } catch {
    /* never fail a run on a lease probe error */
  }
  return [];
}

/** First live lease blocking this target, or null. */
export function leaseBlockingTarget(t) {
  const files = leaseFilesOf(t);
  if (files.length === 0) return null;
  return checkPaths(files).find((r) => !r.free) ?? null;
}

export { lockFile };

// ── CLI ───────────────────────────────────────────────────────────────────

const IS_MAIN =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

const ownerOpt = (args) => {
  const i = args.indexOf("--owner");
  return { owner: i >= 0 ? args[i + 1] : undefined, args: args.filter((a, j) => a !== "--owner" && !(i >= 0 && j === i + 1)) };
};
const ttlOpt = (args) => {
  const i = args.indexOf("--ttl-ms");
  return { ttlMs: i >= 0 ? Number(args[i + 1]) || DEFAULT_TTL_MS : undefined, args: args.filter((a, j) => a !== "--ttl-ms" && !(i >= 0 && j === i + 1)) };
};

if (IS_MAIN) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = () => {
    switch (cmd) {
  case "acquire": {
    const { owner, args: a1 } = ownerOpt(rest);
    const { ttlMs, args: paths } = ttlOpt(a1.includes("--force") ? a1.filter((x) => x !== "--force") : a1);
    const force = a1.includes("--force");
    if (paths.length !== 1) {
      console.error("usage: write-lease.mjs acquire <path> [--owner NAME] [--ttl-ms N] [--force]");
      process.exit(2);
    }
    const r = acquire(paths[0], { owner, ttlMs, force });
    if (r.status === "conflict") {
      console.error(`${paths[0]}: leased by ${r.lease.owner} (heartbeat ${new Date(r.lease.heartbeat).toISOString()})`);
      process.exit(3);
    }
    console.log(`${paths[0]}: ${r.status} ${r.lease.owner}`);
    break;
  }
  case "renew": {
    const { owner, args: paths } = ownerOpt(rest);
    if (paths.length !== 1) {
      console.error("usage: write-lease.mjs renew <path> [--owner NAME]");
      process.exit(2);
    }
    const r = renew(paths[0], { owner });
    if (r.status === "conflict") {
      console.error(`${paths[0]}: leased by ${r.lease.owner}; renew denied`);
      process.exit(3);
    }
    console.log(`${paths[0]}: ${r.status}`);
    if (r.status === "absent") process.exit(3);
    break;
  }
  case "release": {
    const { owner, args: a1 } = ownerOpt(rest);
    const force = a1.includes("--force");
    const { args: paths } = ttlOpt(a1.filter((x) => x !== "--force"));
    if (paths.length !== 1) {
      console.error("usage: write-lease.mjs release <path> [--owner NAME] [--force]");
      process.exit(2);
    }
    const r = release(paths[0], { owner, force });
    if (r.status === "conflict") {
      console.error(`${paths[0]}: leased by ${r.lease.owner}; release denied`);
      process.exit(3);
    }
    console.log(`${paths[0]}: ${r.status}`);
    break;
  }
  case "check": {
    if (rest.length === 0) {
      console.error("usage: write-lease.mjs check <path>...");
      process.exit(2);
    }
    const results = checkPaths(rest);
    for (const r of results)
      console.log(`${r.path}\t${r.free ? "free" : "leased"}\t${r.owner ?? "-"}`);
    process.exit(results.some((r) => !r.free) ? 3 : 0);
    break;
  }
  case "list": {
    for (const l of liveLeases())
      console.log(
        `${l.path}\t${l.owner}\t${new Date(l.heartbeat).toISOString()}\t${l.ttlMs}ms`,
      );
    break;
  }
  case "quiescent": {
    const live = liveLeases();
    if (live.length === 0) {
      console.log("quiescent: no live write leases");
      process.exit(0);
    }
    for (const l of live)
      console.log(
        `in-use: ${l.path} by ${l.owner} (heartbeat ${new Date(l.heartbeat).toISOString()})`,
      );
    process.exit(75);
    break;
  }
  default:
    console.error(
      "usage: write-lease.mjs <acquire|renew|release|check|list|quiescent> ...",
    );
    process.exit(2);
    }
  };
  run();
}