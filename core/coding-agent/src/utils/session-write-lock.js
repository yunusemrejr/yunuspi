import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { performance } from "perf_hooks";

const sleepWord = new Int32Array(new SharedArrayBuffer(4));
function startIdentity(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    catch { return undefined; }
}
function ownerIsDead(owner) {
    try { process.kill(owner.pid, 0); }
    catch (error) { return error.code === "ESRCH"; }
    const current = startIdentity(owner.pid);
    return typeof owner.start === "string" && current !== undefined && owner.start !== current;
}
function inspectOwner(lock) {
    try {
        const entries = readdirSync(lock, { withFileTypes: true });
        // An empty directory, an unreadable/partial owner file or extra entries is
        // not a live owner: it is what a process killed between mkdir(lock) and
        // publishing its owner file (or between unlink(owner) and rmdir(lock))
        // leaves behind. Report it as an orphan instead of an unknown owner.
        if (entries.length !== 1 || !entries[0].isFile() || !/^owner-\d+-[a-f0-9-]{36}$/.test(entries[0].name)) return { orphan: true };
        const file = join(lock, entries[0].name);
        if (statSync(file).size > 512) return { orphan: true };
        const owner = JSON.parse(readFileSync(file, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return { orphan: true };
        return { ...owner, file };
    }
    catch { return { orphan: true }; }
}
function releaseOwner(lock, file) {
    // Only the actor that removed this unique owner file may remove the
    // directory. A competing stale reclaimer cannot remove a newer lock.
    unlinkSync(file);
    rmdirSync(lock);
}
/** A live writer publishes its owner file within one syscall of mkdir, so an
 *  ownerless lock directory this old cannot belong to a running writer: it is a
 *  crash artifact and may be reclaimed. Without this, one SIGKILL in the
 *  publish/release window wedged the session permanently ("unknown owner
 *  requires manual inspection"). */
const ORPHAN_GRACE_MS = 2_000;
function reclaimOrphan(lock) {
    try {
        if (Date.now() - statSync(lock).mtimeMs < ORPHAN_GRACE_MS) return false;
        for (const entry of readdirSync(lock)) unlinkSync(join(lock, entry));
        rmdirSync(lock);
        return true;
    }
    catch { return false; }
}
/** Short synchronous transactions; no live owner can lose its lock by age. */
export function withSessionWriteLock(file, transaction) {
    let canonical;
    try { canonical = realpathSync(file); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        canonical = join(realpathSync(dirname(resolve(file))), basename(file));
    }
    const lock = `${canonical}.write-lock`;
    const ownerFile = join(lock, `owner-${process.pid}-${randomUUID()}`);
    const deadline = performance.now() + 250;
    for (;;) {
        try { mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            const owner = inspectOwner(lock);
            if (owner?.orphan) {
                // Wait out the acquisition deadline first: a live writer may be
                // inside its one-syscall publish window. Only an ownerless lock
                // older than the grace is reclaimed; a fresh one stays busy.
                if (performance.now() < deadline) { Atomics.wait(sleepWord, 0, 0, 10); continue; }
                if (reclaimOrphan(lock)) continue;
                throw Object.assign(new Error(`Session write is locked: ${lock}. Retry after the active writer finishes; an unknown owner requires manual inspection.`), { code: "ESESSIONBUSY" });
            }
            else if (owner && ownerIsDead(owner)) {
                try { releaseOwner(lock, owner.file); }
                catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
                continue;
            }
            else if (owner?.pid === process.pid || performance.now() >= deadline) {
                throw Object.assign(new Error(`Session write is locked: ${lock}. Retry after the active writer finishes; an unknown owner requires manual inspection.`), { code: "ESESSIONBUSY" });
            }
            Atomics.wait(sleepWord, 0, 0, 10);
        }
    }
    try { writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, start: startIdentity(process.pid) }), { flag: "wx", mode: 0o600 }); }
    catch (error) {
        try { unlinkSync(ownerFile); } catch { /* Publication may have failed before creation. */ }
        try { rmdirSync(lock); } catch { /* Unknown state stays closed. */ }
        throw error;
    }
    try { return transaction(); }
    finally {
        // Releasing a lock cannot turn an already committed receipt into a
        // failed delivery. Keep the lock closed and report cleanup separately.
        try { releaseOwner(lock, ownerFile); }
        catch (error) { console.warn(`Session write lock cleanup failed: ${error.message}`); }
    }
}
