/** Shared child-process plumbing for the local studios (video, Blender,
 * Brush): guarded spawn, line streaming, deadline, memory watch and
 * process-group kill on abort. One owner so every heavy local job yields to
 * the keyboard and dies alone when it runs away. */
import path from "node:path";
import { readlinkSync } from 'node:fs';
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { guardedCommand } from "./self-mutation-guard.ts";
import { memoryBudgetMb, watchMemory, treeUsage } from "./memory-guard.ts";
import { ownProcessGroup, processIdentity } from "./process-owner.ts";

export type Progress = (text: string) => void;
/** Spawn a (guarded) process, stream lines, enforce a deadline, kill the
 * whole process group on abort. Returns stdout/stderr tails. */
export async function runGuarded(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number; guard?: boolean; gpu?: boolean; nice?: number; memoryMb?: number; env?: Record<string, string | undefined>; replaceEnv?: boolean; onLine?: (line: string) => void }) {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error("Invalid timeoutMs: use 0 for unlimited or a finite non-negative deadline within 2147483647ms");
  }
  // Heavy local work yields to whatever the person is doing at the keyboard.
  const niced = options.nice ? { command: "nice", args: ["-n", String(options.nice), command, ...args] } : { command, args };
  const target = options.guard === false ? niced : guardedCommand(niced.command, niced.args, { gpu: options.gpu });
  options.signal?.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(target.command, target.args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: options.replaceEnv ? { ...options.env } : { ...process.env, ...options.env } });
    const childIdentity = child.pid ? processIdentity(child.pid) : '';
    const outputLinks = childIdentity ? [1, 2].flatMap(fd => {
      try { const link = readlinkSync(`/proc/${child.pid}/fd/${fd}`); return /^(?:pipe|socket):\[\d+\]$/.test(link) ? [link] : []; } catch { return []; }
    }) : [];
    ownProcessGroup(child.pid);
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    let stdout = "", stderr = "", pending = "", lineTruncated = false, settled = false, failure: Error | undefined;
    const tail = (text: string, add: string) => {
      const joined = text + add;
      let start = Math.max(0, joined.length - 200_000);
      const first = joined.charCodeAt(start);
      if (start && first >= 0xdc00 && first <= 0xdfff) start++;
      return joined.slice(start);
    };
    const kill = () => {
      if (!child.pid) return;
      // Snapshot descendants before killing their parent: detached workers can
      // own another process group while still inheriting this job's pipes.
      if (childIdentity) {
        const tree = treeUsage(child.pid, true, outputLinks);
        const descendants = tree.identities?.[child.pid] === childIdentity ? tree.pids.slice(1) : [];
        // Exact inherited output handles still identify job writers after a
        // parent exits and the kernel reparents detached descendants.
        for (const pid of [...new Set([...descendants, ...(tree.outputOwners ?? [])])].reverse()) {
          if (pid === child.pid && tree.identities?.[pid] !== childIdentity) continue;
          const identity = tree.identities?.[pid];
          if (identity && processIdentity(pid) === identity) try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
      // A reaped leader's numeric PID must never authorize an unrelated group.
      if (!childIdentity || processIdentity(child.pid) === childIdentity) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const timer = options.timeoutMs > 0 ? setTimeout(() => { stop(new Error(`${path.basename(command)} exceeded ${Math.round(options.timeoutMs / 1000)}s`)); }, options.timeoutMs) : undefined;
    timer?.unref();
    const stopWatching = child.pid ? watchMemory(child.pid, options.memoryMb ?? memoryBudgetMb(), (message) => {
      stop(new Error(`${path.basename(command)} stopped: ${message}. Nothing else was affected. Lower the resolution (render scale), render scene by scene with scene/from/to, or shorten the audio, then retry.`));
    }) : () => {};
    const abort = () => { stop(new Error(`${path.basename(command)} cancelled`)); };
    function stop(error: Error) {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timer);
      stopWatching();
      options.signal?.removeEventListener("abort", abort);
      kill();
      // Killing is asynchronous. Release output/worker ownership only after
      // close confirms that the child and its inherited stdio are gone.
    }
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopWatching();
      options.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve({ stdout, stderr });
    }
    const emitLine = () => {
      const line = (lineTruncated ? "[... line prefix omitted ...] " : "") + pending;
      pending = "";
      lineTruncated = false;
      options.onLine?.(line);
    };
    const appendStdout = (text: string) => {
      stdout = tail(stdout, text);
      if (!options.onLine) return;
      // Bound partial lines too: a renderer can print megabytes without LF.
      // Scan only the new chunk rather than rescanning the retained prefix.
      let start = 0, newline: number;
      const append = (part: string) => {
        if (pending.length + part.length > 200_000) lineTruncated = true;
        pending = tail(pending, part);
      };
      while (!settled && !failure && (newline = text.indexOf("\n", start)) >= 0) {
        append(text.slice(start, newline));
        emitLine();
        start = newline + 1;
      }
      if (!settled && !failure) append(text.slice(start));
    };
    const failProgress = (error: unknown) => { stop(error instanceof Error ? error : new Error(String(error))); };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || failure) return;
      try { appendStdout(stdoutDecoder.write(chunk)); } catch (error) { failProgress(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (!settled && !failure) stderr = tail(stderr, stderrDecoder.write(chunk)); });
    child.on("error", (error: any) => stop(error.code === "ENOENT" ? new Error(`${command} is not installed`) : error));
    child.on("close", (code) => {
      if (settled) return;
      if (failure) { finish(failure); return; }
      try {
        appendStdout(stdoutDecoder.end());
        stderr = tail(stderr, stderrDecoder.end());
        if (pending || lineTruncated) emitLine();
      } catch (error) { finish(failure ?? (error instanceof Error ? error : new Error(String(error)))); return; }
      if (failure) finish(failure);
      else if (code === 0) finish();
      else finish(new Error(`${path.basename(command)} exited with ${code}: ${(stderr || stdout).slice(-3000)}`));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export function throttled(progress: Progress | undefined, ms = 2500): Progress {
  let last = 0;
  return (text) => { const now = Date.now(); if (progress && now - last >= ms) { last = now; progress(text); } };
}
