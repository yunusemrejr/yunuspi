import * as fs from "node:fs";

/**
 * Read the kernel process-start time (jiffies since boot) for `pid`. The value
 * uniquely identifies one process instance across PID reuse: after a process
 * dies and the OS hands its PID to an unrelated process, the start time changes.
 *
 * Returns `undefined` when the value cannot be read (non-Linux platform, the
 * process is gone, or a parse failure). Callers must treat `undefined` as
 * "cannot verify", never as "verified dead".
 */
export function readProcessStartIdentity(pid: number, readFileSync: typeof fs.readFileSync = fs.readFileSync): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8") as string;
		// The comm field is the second field and is parenthesized; it may itself
		// contain spaces and parentheses. Everything after the final ")" starts at
		// field 3 (state). The starttime is field 22, i.e. index 19 of the
		// post-comm split.
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) return undefined;
		const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fields[19];
		return startTicks ? `linux:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}
