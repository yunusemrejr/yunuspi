/** Memory watchdog for heavy child processes (Remotion/Chrome renders, audio synthesis).
 * A render at a high resolution, or a long procedural track, can grow past the
 * machine's RAM and take the whole desktop and every open session with it. The
 * watchdog sums the resident memory of a child's process tree once a second and
 * kills the tree when it passes its budget or when the host itself runs low, so
 * the tool returns an actionable error instead of the kernel OOM killer freezing
 * the machine. */
import { readdirSync, readFileSync } from "node:fs";

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

/** Resident MB and pids of a process and all of its descendants (Chrome workers included). */
export function treeUsage(rootPid: number): { mb: number; pids: number[] } {
  const rows = new Map<number, { ppid: number; rssKb: number }>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // comm may contain spaces and parentheses; the fields after the last ")" are stable.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.set(Number(name), { ppid: Number(fields[1]), rssKb: Number(fields[21]) * PAGE_KB });
      } catch { /* exited while scanning */ }
    }
  } catch { return { mb: 0, pids: [rootPid] }; }
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) for (const [pid, row] of rows) if (row.ppid === pids[i] && !pids.includes(pid)) pids.push(pid);
  return { mb: Math.round(pids.reduce((sum, pid) => sum + (rows.get(pid)?.rssKb ?? 0), 0) / MB), pids };
}

/** Kill the tree at `budgetMb`, or when the host drops under `floorMb` free. Returns a stop function. */
export function watchMemory(rootPid: number, budgetMb: number, onExceed: (message: string, pids: number[]) => void, options: { floorMb?: number; intervalMs?: number } = {}): () => void {
  const floorMb = options.floorMb ?? 1024;
  const timer = setInterval(() => {
    const { mb, pids } = treeUsage(rootPid);
    const free = availableMb();
    if (mb > budgetMb) onExceed(`memory budget of ${budgetMb} MB exceeded (using ${mb} MB)`, pids);
    else if (free < floorMb && mb > 256) onExceed(`host memory nearly exhausted (${free} MB free, this job uses ${mb} MB)`, pids);
  }, options.intervalMs ?? 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
