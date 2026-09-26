/** Shared command execution utilities for extensions and custom tools. */
import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.js";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.js";

/** Execute a command with owned process-tree cancellation and timeout. */
export async function execCommand(command, args, cwd, options) {
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647)) {
        throw new Error("Invalid timeout: must be between 0 and 2147483647 milliseconds");
    }
    if (options?.signal?.aborted) {
        return { stdout: "", stderr: "Command aborted", code: 1, killed: true };
    }
    const proc = spawn(command, args, {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    if (proc.pid) trackDetachedChildPid(proc.pid);
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId;
    let forceKillId;
    const killProcess = () => {
        if (killed || !proc.pid) return;
        killed = true;
        if (process.platform === "win32") {
            killProcessTree(proc.pid);
            return;
        }
        try {
            process.kill(-proc.pid, "SIGTERM");
        } catch {
            // The process group may already have exited; preserve child cleanup.
            proc.kill("SIGTERM");
        }
        forceKillId = setTimeout(() => killProcessTree(proc.pid), 5000);
    };
    // Stream decoders retain split UTF-8 code points independently per pipe.
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", data => { stdout += data; });
    proc.stderr?.on("data", data => { stderr += data; });
    if (options?.signal) {
        if (options.signal.aborted) killProcess();
        else options.signal.addEventListener("abort", killProcess, { once: true });
    }
    if (timeout > 0) timeoutId = setTimeout(killProcess, timeout);
    try {
        const code = await waitForChildProcess(proc, { isCancelled: () => killed });
        return { stdout, stderr, code: killed && code === 0 ? 1 : code ?? 1, killed };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { stdout, stderr: stderr ? `${stderr}\n${message}` : message, code: 1, killed };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (forceKillId) clearTimeout(forceKillId);
        options?.signal?.removeEventListener("abort", killProcess);
        // The leader may exit before a TERM-ignoring descendant. A cancelled
        // invocation must not return while that owned group continues working.
        if (killed && proc.pid) killProcessTree(proc.pid);
        if (proc.pid) untrackDetachedChildPid(proc.pid);
    }
}
