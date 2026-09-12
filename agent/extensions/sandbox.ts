/** Disposable experiments: the trusted helper owns namespaces, limits and cleanup. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const helper = fileURLToPath(new URL("../scripts/sandbox-runner.py", import.meta.url));

export default function sandbox(pi: any) {
  pi.registerTool({
    name: "sandbox_run",
    label: "Disposable Sandbox",
    description: "Run a small experiment in a fresh, disposable Linux sandbox. A multiline Bash script shares /workspace for this call only; returns stdout, stderr and exit status, then destroys all files and processes. No host project/home directories, credentials or network. Supply inline files or explicit relative source files to COPY from the current project (regular files only; no directories or symlinks). System tools under /usr and the harness's Node binary are read-only. Fixed limits: 256 MiB memory, 32 processes/threads, one CPU, four simultaneous sandboxes per user. Requires Bubblewrap, cgroup v2 and a systemd user manager; fails closed. No package downloads, persistent handles or automatic copy-back.",
    promptSnippet: "Run disposable, resource-bounded experiments without changing the project",
    promptGuidelines: [
      "Use sandbox_run for small reproductions, uncertain scripts and destructive test fixtures that should not touch the project or other agents' files. Combine related steps in one script; every call starts empty and cleans up automatically.",
      "Pass only the source files or fixtures needed for the experiment. Inspect exitCode, started, timedOut and truncated. Sandbox results cover only the supplied snapshot; validate integrated changes separately. If isolation is unavailable, report it rather than rerunning the experiment on the host.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 65536, description: "Bash script executed in /workspace (no login files); use set -e when any failing step should stop the script." }),
      files: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512, description: "Relative destination under /workspace." }),
        content: Type.Optional(Type.String({ maxLength: 262144, description: "Inline UTF-8 fixture; choose exactly one of content or source." })),
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Explicit relative project file to copy, including current uncommitted bytes. No symlinks, directories or special files." })),
      }, { additionalProperties: false }), { maxItems: 128 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, default: 30000 })),
      maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65536, default: 16384 })),
    }, { additionalProperties: false }),
    async execute(_id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const failure = (error: string, started: false | null = false) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ started, error }) }], details: { started, error } });
      if (signal?.aborted) return failure("Sandbox cancelled before launch");
      if (process.platform !== "linux") return failure("sandbox_run requires Linux; use the documented Linux/WSL2/VM environment");
      let input: string;
      try {
        input = JSON.stringify(params);
        if (!input || Buffer.byteLength(input) > 3 * 1024 * 1024) throw Error("Sandbox request exceeds 3 MiB");
      } catch (error) { return failure(String(error)); }
      return await new Promise((resolve) => {
        // Do not route this fixed launcher through generic host-shell execution.
        // It cannot execute the supplied script until its OS boundary is ready.
        const child = spawn("/usr/bin/python3", ["-I", helper, ctx.cwd, process.execPath], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", size = 0, closed = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
          if (closed || killTimer) return;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
          killTimer.unref();
        };
        const deadline = setTimeout(stop, 135000);
        const capture = (chunk: Buffer, error: boolean) => {
          size += chunk.length;
          if (size > 512 * 1024) { stop(); return; }
          if (error) stderr += chunk.toString("utf8"); else stdout += chunk.toString("utf8");
        };
        child.stdout.on("data", (chunk) => capture(chunk, false));
        child.stderr.on("data", (chunk) => capture(chunk, true));
        child.stdin.on("error", () => {}); // Early refusal may close stdin.
        const finish = (error?: Error) => {
          if (closed) return;
          closed = true;
          clearTimeout(deadline);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", stop);
          try {
            if (error || size > 512 * 1024) throw error ?? Error("Sandbox launcher output exceeded its bound");
            const result = JSON.parse(stdout);
            if (typeof result.started !== "boolean" && result.started !== null) throw Error("Invalid sandbox result");
            resolve({ isError: !result.started || result.exitCode !== 0 || result.cancelled || result.timedOut || Boolean(result.error),
              content: [{ type: "text", text: JSON.stringify(result) }], details: result });
          } catch (error) { resolve(failure(`Sandbox launcher failed; execution state unknown: ${String(error)}${stderr ? "; " + stderr.slice(0, 2048) : ""}`, null)); }
        };
        child.on("error", finish);
        child.on("close", () => finish());
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        child.stdin.end(input);
      });
    },
  });
}
