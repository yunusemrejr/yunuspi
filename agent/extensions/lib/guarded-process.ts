/** Shared child-process plumbing for the local studios (video, Blender,
 * Brush): guarded spawn, line streaming, deadline, memory watch and
 * process-group kill on abort. One owner so every heavy local job yields to
 * the keyboard and dies alone when it runs away. */
import path from "node:path";
import { spawn } from "node:child_process";
import { guardedCommand } from "./self-mutation-guard.ts";
import { memoryBudgetMb, watchMemory } from "./memory-guard.ts";
import { ownProcessGroup } from "./process-owner.ts";

export type Progress = (text: string) => void;
/** Spawn a (guarded) process, stream lines, enforce a deadline, kill the
 * whole process group on abort. Returns stdout/stderr tails. */
export async function runGuarded(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number; guard?: boolean; gpu?: boolean; nice?: number; memoryMb?: number; env?: Record<string, string | undefined>; onLine?: (line: string) => void }) {
  options.signal?.throwIfAborted();
  // Heavy local work yields to whatever the person is doing at the keyboard.
  const niced = options.nice ? { command: "nice", args: ["-n", String(options.nice), command, ...args] } : { command, args };
  const target = options.guard === false ? niced : guardedCommand(niced.command, niced.args, { gpu: options.gpu });
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(target.command, target.args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...options.env } });
    ownProcessGroup(child.pid);
    let stdout = "", stderr = "", pending = "", settled = false;
    const tail = (text: string, add: string) => (text + add).slice(-200_000);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } };
    const timer = setTimeout(() => { kill(); finish(new Error(`${path.basename(command)} exceeded ${Math.round(options.timeoutMs / 1000)}s`)); }, options.timeoutMs);
    timer.unref?.();
    const stopWatching = watchMemory(child.pid!, options.memoryMb ?? memoryBudgetMb(), (message, pids) => {
      kill();
      for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      finish(new Error(`${path.basename(command)} stopped: ${message}. Nothing else was affected. Lower the resolution (render scale), render scene by scene with scene/from/to, or shorten the audio, then retry.`));
    });
    const abort = () => { kill(); finish(new Error(`${path.basename(command)} cancelled`)); };
    options.signal?.addEventListener("abort", abort, { once: true });
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching();
      options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ stdout, stderr });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = tail(stdout, text);
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = tail(stderr, chunk.toString("utf8")); });
    child.on("error", (error: any) => finish(error.code === "ENOENT" ? new Error(`${command} is not installed`) : error));
    child.on("close", (code) => {
      if (pending) options.onLine?.(pending);
      if (code === 0) finish();
      else finish(new Error(`${path.basename(command)} exited with ${code}: ${(stderr || stdout).slice(-3000)}`));
    });
  });
}

export function throttled(progress: Progress | undefined, ms = 2500): Progress {
  let last = 0;
  return (text) => { const now = Date.now(); if (progress && now - last >= ms) { last = now; progress(text); } };
}
