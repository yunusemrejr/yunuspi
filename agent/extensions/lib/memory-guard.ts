/** Memory watchdog for heavy child processes (Remotion/Chrome renders, audio synthesis).
 * A render at a high resolution, or a long procedural track, can grow past the
 * machine's RAM and take the whole desktop and every open session with it. The
 * watchdog sums the resident memory of a child's process tree once a second and
 * kills the tree when it passes its budget or when the host itself runs low, so
 * the tool returns an actionable error instead of the kernel OOM killer freezing
 * the machine. */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { processIdentity } from "./process-owner.ts";

const PAGE_KB = 4;
const MB = 1024;

/** Host memory the kernel can still hand out without swapping, in MB. */
export function availableMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (match) return Math.floor(Number(match[1]) / MB);
  } catch { /* not Linux: no reading, no guard */ }
  return Number.POSITIVE_INFINITY;
}

/** Budget for one heavy child: YUNUSPI_VIDEO_MEMORY_MB, else half of what is free, kept within 1.5..12 GB. */
export function memoryBudgetMb(): number {
  const override = Number(process.env.YUNUSPI_VIDEO_MEMORY_MB);
  if (Number.isFinite(override) && override >= 512) return Math.floor(override);
  const free = availableMb();
  return Number.isFinite(free) ? Math.min(12 * MB, Math.max(1.5 * MB, Math.floor(free / 2))) : 12 * MB;
}

function processSnapshot(outputLinks: readonly string[] = []) {
  const rows = new Map<number, { ppid: number; rssKb: number; identity: string; ownsOutput: boolean }>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // comm may contain spaces and parentheses; the fields after the last ")" are stable.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        // A child can retain an inherited output handle at another fd after
        // redirecting stdout/stderr. Inspect descriptors only during cleanup;
        // the ordinary memory-watch path does not need this ownership scan.
        let ownsOutput = false;
        if (Number(name) !== process.pid && outputLinks.length > 0) {
          try { ownsOutput = readdirSync(`/proc/${name}/fd`).some(fd => {
            if (!/^\d+$/.test(fd)) return false;
            try { return outputLinks.includes(readlinkSync(`/proc/${name}/fd/${fd}`)); } catch { return false; }
          }); } catch { /* exited or inaccessible */ }
        }
        rows.set(Number(name), { ppid: Number(fields[1]), rssKb: Number(fields[21]) * PAGE_KB, identity: fields[19], ownsOutput });
      } catch { /* exited while scanning */ }
    }
  } catch { /* No live process evidence. */ }
  const children = new Map<number, number[]>();
  for (const [pid, row] of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(pid);
    else children.set(row.ppid, [pid]);
  }
  return { rows, children };
}

function usageOf(snapshot: ReturnType<typeof processSnapshot>, rootPid: number, includeIdentities = false, includeOutputOwners = false): { mb: number; pids: number[]; identities?: Record<number, string>; outputOwners?: number[] } {
  const { rows, children } = snapshot;
  const pids = [rootPid];
  const seen = new Set(pids);
  for (let i = 0; i < pids.length; i++) {
    for (const pid of children.get(pids[i]) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      pids.push(pid);
    }
  }
  const outputOwners = includeOutputOwners ? [...rows].filter(([, row]) => row.ownsOutput).map(([pid]) => pid) : [];
  return { mb: Math.round(pids.reduce((sum, pid) => sum + (rows.get(pid)?.rssKb ?? 0), 0) / MB), pids,
    ...(includeIdentities ? { identities: Object.fromEntries([...new Set([...pids, ...outputOwners])].filter(pid => rows.has(pid)).map(pid => [pid, rows.get(pid)!.identity])) } : {}),
    ...(includeOutputOwners ? { outputOwners } : {}) };
}

/** Inspect resident memory and ownership with a fresh process tree. */
export function treeUsage(rootPid: number, includeIdentities = false, outputLinks: readonly string[] = []) {
  return usageOf(processSnapshot(outputLinks), rootPid, includeIdentities, outputLinks.length > 0);
}

type MemorySample = { snapshot: ReturnType<typeof processSnapshot>; free: number; at: number };
// The extension loader can evaluate this module in more than one extension.
const memoryWatchCache: { active: number; sample?: MemorySample } = ((globalThis as any)[Symbol.for("yunus-pi.memory-watch-sample.v1")] ??= { active: 0 });

function memorySample(maxAgeMs: number) {
  const previous = memoryWatchCache.sample;
  if (previous) {
    const age = performance.now() - previous.at;
    if (age >= 0 && age < maxAgeMs) return previous;
  }
  const snapshot = processSnapshot();
  const sample = { snapshot, free: availableMb(), at: performance.now() };
  memoryWatchCache.sample = sample;
  return sample;
}

/** Kill the tree at `budgetMb`, or when the host drops under `floorMb` free. Returns a stop function. */
export function watchMemory(rootPid: number, budgetMb: number, onExceed: (message: string, pids: number[]) => void, options: { floorMb?: number; intervalMs?: number } = {}): () => void {
  const floorMb = options.floorMb ?? 1024;
  const intervalMs = options.intervalMs ?? 1000;
  const rootIdentity = processIdentity(rootPid);
  memoryWatchCache.active++;
  const timer = setInterval(() => {
    // Share only nearby periodic samples. Cancellation takes its own snapshot.
    const { snapshot, free } = memorySample(Math.min(50, intervalMs / 4));
    if (rootIdentity && snapshot.rows.get(rootPid)?.identity !== rootIdentity) return;
    const { mb, pids } = usageOf(snapshot, rootPid);
    let message;
    if (mb > budgetMb) message = `memory budget of ${budgetMb} MB exceeded (using ${mb} MB)`;
    else if (free < floorMb && mb > 256) message = `host memory nearly exhausted (${free} MB free, this job uses ${mb} MB)`;
    if (message && (!rootIdentity || processIdentity(rootPid) === rootIdentity)) onExceed(message, pids);
  }, intervalMs);
  timer.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (--memoryWatchCache.active === 0) delete memoryWatchCache.sample;
  };
}
