import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;

function waitSynchronously(delayMs) {
  if (delayMs <= 0) return;
  if (WAIT_VIEW) {
    try {
      Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
      return;
    } catch {
      // Fall through for runtimes that prohibit blocking Atomics.wait.
    }
  }
  const until = Date.now() + delayMs;
  while (Date.now() < until) {
    // Portable fallback; lock waits are bounded by waitMs.
  }
}

function reclaimStaleLock(fsImpl, lockDir) {
  const entries = fsImpl.readdirSync(lockDir);
  if (entries.length === 0) {
    try {
      fsImpl.rmdirSync(lockDir);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
      throw error;
    }
  }
  if (entries.length !== 1 || !entries[0].startsWith("owner-")) return false;
  const ownerPath = path.join(lockDir, entries[0]);
  const claimPath = `${lockDir}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    // Moving the exact observed token is the stale-owner compare-and-swap.
    // A second waiter that observed the same stale directory loses with ENOENT
    // and therefore cannot remove a replacement directory.
    fsImpl.renameSync(ownerPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let removed = false;
  try {
    fsImpl.rmdirSync(lockDir);
    removed = true;
  } catch (error) {
    if (error?.code === "ENOENT") removed = true;
  }
  if (removed) {
    try { fsImpl.unlinkSync(claimPath); } catch { /* best-effort tombstone cleanup */ }
    return true;
  }
  try { fsImpl.renameSync(claimPath, ownerPath); } catch { /* leave uncertain ownership for timeout */ }
  return false;
}

/** Acquire an exclusive mkdir lock and return its best-effort release function. */
export function acquireDirectoryLock(lockDir, options = {}) {
  const fsImpl = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitSynchronously;
  const staleAfterMs = options.staleAfterMs ?? 15_000;
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = options.pollMs ?? 50;
  const label = options.label ?? "directory lock";
  const deadline = now() + waitMs;

  for (;;) {
    try {
      fsImpl.mkdirSync(lockDir, { mode: 0o700 });
      const tokenPath = path.join(lockDir, `owner-${process.pid}-${randomUUID()}`);
      try {
        fsImpl.writeFileSync(tokenPath, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        // The directory was created by this attempt. A non-recursive removal
        // cannot erase a replacement lock if stale takeover raced the failure.
        try {
          fsImpl.rmdirSync(lockDir);
        } catch {
          // Leave an uncertain lock for stale recovery.
        }
        throw error;
      }
      return () => {
        let removedOwnToken = false;
        try {
          fsImpl.unlinkSync(tokenPath);
          removedOwnToken = true;
        } catch {
          // Stale takeover removed our token; never touch the replacement.
        }
        if (!removedOwnToken) return;
        try {
          fsImpl.rmdirSync(lockDir);
        } catch {
          // Non-empty or already replaced: stale recovery owns cleanup.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (now() - fsImpl.statSync(lockDir).mtimeMs > staleAfterMs) {
          if (reclaimStaleLock(fsImpl, lockDir)) continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") {
          if (now() >= deadline) throw new Error(`${label} timeout: ${lockDir}`, { cause: inspectionError });
          continue;
        }
        if (now() >= deadline) throw new Error(`${label} timeout: ${lockDir}`, { cause: inspectionError });
        wait(Math.min(pollMs, Math.max(0, deadline - now())));
        continue;
      }
      if (now() >= deadline) throw new Error(`${label} timeout: ${lockDir}`);
      wait(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  }
}
