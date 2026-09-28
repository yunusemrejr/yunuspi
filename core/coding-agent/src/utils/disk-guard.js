import { statfsSync } from "node:fs";
const GIB = 1024 ** 3;
// Below the reserve a command may still write this much, so short commands keep
// working on an already tight disk.
const LOW_DISK_SLACK = 256 * 1024 ** 2;
function envGib(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/**
 * Disk limits for tool commands, in bytes (0 = that check is off). A runaway
 * writer, such as an ffmpeg filter ending in a bare `apad`, must never fill the
 * user's disk. Override with PI_DISK_BUDGET_GB, PI_DISK_RESERVE_GB, PI_MAX_FILE_GB.
 */
export function getDiskLimits() {
    return {
        budgetBytes: envGib("PI_DISK_BUDGET_GB", 40) * GIB,
        reserveBytes: envGib("PI_DISK_RESERVE_GB", 10) * GIB,
        maxFileBytes: envGib("PI_MAX_FILE_GB", 32) * GIB,
    };
}
/** Bytes available to unprivileged writers on path's filesystem, or undefined. */
export function diskAvailable(path) {
    try {
        const s = statfsSync(path);
        return s.bavail * s.bsize;
    }
    catch {
        return undefined;
    }
}
const gib = bytes => `${(bytes / GIB).toFixed(1)} GiB`;
/**
 * Poll free space under `path` and call `onTrip(reason)` once when the command
 * consumed more than the budget, or keeps writing once free space is below the
 * reserve. Returns a stop function.
 */
export function watchDisk(path, limits, onTrip, intervalMs = 250) {
    const start = diskAvailable(path);
    if (start === undefined || (!limits.budgetBytes && !limits.reserveBytes)) return () => { };
    const timer = setInterval(() => {
        const avail = diskAvailable(path);
        if (avail === undefined) return;
        const used = start - avail;
        let reason;
        if (limits.budgetBytes && used > limits.budgetBytes)
            reason = `command consumed ${gib(used)} of disk, over the ${gib(limits.budgetBytes)} per-command budget`;
        else if (limits.reserveBytes && avail < limits.reserveBytes && used > LOW_DISK_SLACK)
            reason = `free disk fell to ${gib(avail)}, below the ${gib(limits.reserveBytes)} reserve, while the command kept writing`;
        if (!reason) return;
        clearInterval(timer);
        onTrip(reason);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
/** POSIX shell prefix capping any single file the command tree writes (RLIMIT_FSIZE). */
export function fileSizeLimitPrefix(limits) {
    if (!limits.maxFileBytes || process.platform === "win32") return "";
    return `ulimit -f ${Math.floor(limits.maxFileBytes / 1024)} 2>/dev/null\n`;
}
