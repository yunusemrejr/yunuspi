/** Disk guard for extension-spawned shells (managed bash, background tasks).
 * Mirrors core/coding-agent/src/utils/disk-guard.js: an unbounded writer
 * (e.g. ffmpeg `apad` without `whole_dur`) once filled a 74 GB file and the
 * whole SSD. Two layers: `ulimit -f` caps any single file inside the shell,
 * and a statfs watch stops the command when it consumes the per-command
 * budget or pushes free space under the reserve floor.
 */
import { statfsSync } from "node:fs";

const GiB = 1024 ** 3;
const LOW_DISK_SLACK = 256 * 1024 ** 2;

export interface DiskLimits {
  budgetBytes: number;
  reserveBytes: number;
  maxFileBytes: number;
}

function gbFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 0 disables a limit. Env: PI_DISK_BUDGET_GB, PI_DISK_RESERVE_GB, PI_MAX_FILE_GB. */
export function getDiskLimits(env: NodeJS.ProcessEnv = process.env): DiskLimits {
  return {
    budgetBytes: gbFromEnv("PI_DISK_BUDGET_GB", 40, env) * GiB,
    reserveBytes: gbFromEnv("PI_DISK_RESERVE_GB", 10, env) * GiB,
    maxFileBytes: gbFromEnv("PI_MAX_FILE_GB", 32, env) * GiB,
  };
}

export function diskAvailable(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`;

/** Poll free space on `path`'s filesystem; call `onTrip(reason)` once. Returns a stop function. */
export function watchDisk(
  path: string,
  limits: DiskLimits,
  onTrip: (reason: string) => void,
  intervalMs = 250,
): () => void {
  if (limits.budgetBytes <= 0 && limits.reserveBytes <= 0) return () => {};
  const start = diskAvailable(path);
  if (start === undefined) return () => {};
  let tripped = false;
  const timer = setInterval(() => {
    const avail = diskAvailable(path);
    if (tripped || avail === undefined) return;
    const used = start - avail;
    let reason: string | undefined;
    if (limits.budgetBytes > 0 && used > limits.budgetBytes) {
      reason = `consumed ${gib(used)} of disk, over the ${gib(limits.budgetBytes)} per-command budget (PI_DISK_BUDGET_GB)`;
    } else if (limits.reserveBytes > 0 && avail < limits.reserveBytes && used > LOW_DISK_SLACK) {
      reason = `free space fell to ${gib(avail)}, under the ${gib(limits.reserveBytes)} reserve (PI_DISK_RESERVE_GB), after this command wrote ${gib(used)}`;
    }
    if (reason === undefined) return;
    tripped = true;
    clearInterval(timer);
    onTrip(reason);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Shell prefix capping any single file the command writes (bash counts 1 KiB blocks). */
export function fileSizeLimitPrefix(limits: DiskLimits, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" || limits.maxFileBytes <= 0) return "";
  return `ulimit -f ${Math.floor(limits.maxFileBytes / 1024)} 2>/dev/null\n`;
}
