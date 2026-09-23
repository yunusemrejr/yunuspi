/** Disposable experiments: the trusted helper owns namespaces, limits and cleanup. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { BG_REQUEST_CHANNEL, BG_RESPONSE_CHANNEL, BG_REQUEST_SCHEMA, BG_RESPONSE_SCHEMA } from "./pi-background-tasks/src/core/extension-api.ts";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const helper = fileURLToPath(new URL("../scripts/sandbox-runner.py", import.meta.url));

export default function sandbox(pi: any) {
  const cleanups = new Set<() => void>();
  // Admission receipts only; the existing background registry owns every task.
  const admissions = new Map<string, { fingerprint: string; promise: Promise<any>; pending: () => boolean }>();
  let generation = 0;
  const nextGeneration = () => {
    generation++;
    // Pending/late-ack owners survive cache pruning, so a quick switch back
    // cannot create another listener for the same stable run request identity.
    for (const [key, receipt] of admissions) if (!receipt.pending()) admissions.delete(key);
  };
  pi.on("session_start", nextGeneration);
  pi.on("session_switch", nextGeneration);
  pi.on("session_shutdown", () => { generation++; admissions.clear(); for (const cleanup of [...cleanups]) cleanup(); });
  const request = (operation: string, payload: unknown, id: string, signal?: AbortSignal, late?: (response: any) => void, released?: () => void): Promise<any> => {
    if (!pi.events?.on || !pi.events?.emit) return Promise.resolve({ ok: false, error: "Background task service is unavailable; use foreground sandbox_run here or ask the parent to own background work" });
    if (signal?.aborted) return Promise.resolve({ ok: false, error: "Sandbox cancelled before background dispatch" });
    if (cleanups.size >= 16) return Promise.resolve({ ok: false, error: "Background sandbox admission capacity reached; inspect existing bg tasks" });
    return new Promise(resolve => {
      let settled = false, cleaned = false, unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (cleaned) return; cleaned = true; clearTimeout(timer); unsubscribe?.(); signal?.removeEventListener("abort", aborted); cleanups.delete(shutdown); released?.(); };
      const finish = (response: any) => {
        if (settled) { cleanup(); late?.(response); return; }
        settled = true; cleanup(); resolve(response);
      };
      const uncertain = (error: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        // The run API may acknowledge after admission. Retain one bounded late
        // listener so cancellation/timeout still kills that exact owned task.
        if (late) { timer = setTimeout(cleanup, 150000); timer.unref(); }
        else cleanup();
        resolve({ ok: false, uncertain: Boolean(late), error });
      };
      const aborted = () => uncertain("Sandbox background admission cancelled; any late admitted task will be stopped");
      const shutdown = () => { if (!settled) resolve({ ok: false, uncertain: Boolean(late), error: "Session shut down during sandbox admission" }); settled = true; cleanup(); };
      cleanups.add(shutdown);
      unsubscribe = pi.events.on(BG_RESPONSE_CHANNEL, (response: any) => {
        if (response?.schema_version === BG_RESPONSE_SCHEMA && response.request_id === id && response.operation === operation) finish(response);
      });
      timer = setTimeout(() => uncertain(operation === "run" ? "Background admission was not acknowledged; inspect bg_status before any intentional retry" : "Background task service unavailable; use foreground sandbox_run here or ask the parent to own background work"), 5000);
      signal?.addEventListener("abort", aborted, { once: true });
      try { pi.events.emit(BG_REQUEST_CHANNEL, { schema_version: BG_REQUEST_SCHEMA, request_id: id, operation, payload }); }
      catch { uncertain("Background service dispatch failed; execution state may be unknown"); }
    });
  };
  const stopLate = (response: any) => {
    if (response?.ok && typeof response.result?.id === "string") void request("kill", { taskId: response.result.id }, `sandbox-kill-${randomUUID()}`);
  };
  pi.registerTool({
    name: "sandbox_run",
    label: "Disposable Sandbox",
    description: "Run a small experiment in a fresh, disposable Linux sandbox. A multiline Bash script shares /workspace for this call only; returns stdout, stderr and exit status, then destroys all files and processes. No host project/home directories, credentials or network. Supply inline files or explicit relative source files to COPY from the current project (regular files only; no directories or symlinks). System tools under /usr and the harness's Node binary are read-only. Fixed limits: 256 MiB memory, 32 processes/threads, one CPU, four simultaneous sandboxes per user. Requires Bubblewrap, cgroup v2 and a systemd user manager; fails closed. Set background:true to use the existing bg task registry with bg_status/bg_logs/bg_kill and its single completion wake; no separate sandbox manager. Source files are copied when the helper actually launches. Background requests cap at 48 KiB. No package downloads, persistent sandbox handles or automatic copy-back.",
    promptSnippet: "Run disposable, resource-bounded experiments without changing the project",
    promptGuidelines: [
      "Use sandbox_run for small reproductions, uncertain scripts and destructive test fixtures that should not touch the project or other agents' files. Combine related steps in one script; every call starts empty and cleans up automatically.",
      "Pass only the source files or fixtures needed for the experiment. Inspect exitCode, started, timedOut and truncated. Sandbox results cover only the supplied snapshot; validate integrated changes separately. If isolation is unavailable, report it rather than rerunning the experiment on the host.",
    ],
    parameters: Type.Object({
      background: Type.Optional(Type.Boolean({ description: "Return a bg task ID immediately; same disposable isolation, existing completion notification and bg management tools. Default false." })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short experiment name for background mode; default Sandbox experiment." })),
      command: Type.String({ minLength: 1, maxLength: 65536, description: "Bash script executed in /workspace (no login files); use set -e when any failing step should stop the script." }),
      files: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512, description: "Relative destination under /workspace." }),
        content: Type.Optional(Type.String({ maxLength: 262144, description: "Inline UTF-8 fixture; choose exactly one of content or source." })),
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Explicit relative project file to copy, including current uncommitted bytes. No symlinks, directories or special files." })),
      }, { additionalProperties: false }), { maxItems: 128 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000, default: 30000 })),
      maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65536, default: 16384 })),
    }, { additionalProperties: false }),
    async execute(id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: any) {
      const failure = (error: string, started: false | null = false) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ started, error }) }], details: { started, error } });
      if (signal?.aborted) return failure("Sandbox cancelled before launch");
      if (process.platform !== "linux") return failure("sandbox_run requires Linux; use the documented Linux/WSL2/VM environment");
      const owner = { cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.(), generation };
      const record = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : undefined;
      if (record && Object.hasOwn(record, "background") && typeof record.background !== "boolean") return failure("background must be boolean");
      const background = record?.background === true;
      const body = record ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "background" && key !== "name")) : params;
      let input: string;
      try {
        input = JSON.stringify(body);
        if (!input || Buffer.byteLength(input) > 3 * 1024 * 1024) throw Error("Sandbox request exceeds 3 MiB");
      } catch (error) { return failure(String(error)); }
      if (background) {
        if (!owner.sessionId || typeof id !== "string" || !id) return failure("Background sandbox admission requires session and tool-call identity");
        if (Buffer.byteLength(input) > 48 * 1024) return failure("Background sandbox request exceeds 48 KiB; use explicit source copies or foreground mode");
        if (record?.name !== undefined && (typeof record.name !== "string" || !record.name.trim() || record.name.length > 80)) return failure("Background sandbox name must contain 1..80 characters");
        const requestId = `sandbox-run-${createHash("sha256").update(JSON.stringify([owner.cwd, owner.sessionId, id])).digest("hex")}`;
        const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
        const fingerprint = createHash("sha256").update(JSON.stringify(canonical([body, record?.name ?? "Sandbox experiment"]))).digest("hex");
        const previous = admissions.get(requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return failure("Sandbox tool-call identity reused with conflicting arguments; inspect the original bg task", null);
          if (!signal) return await previous.promise;
          // A duplicate is only an observer. Cancelling it cannot kill the
          // original request's task or remove that owner's response listener.
          return await new Promise(resolve => {
            let done = false;
            const finish = (value: unknown) => { if (done) return; done = true; signal.removeEventListener("abort", abort); resolve(value); };
            const abort = () => finish(failure("Sandbox admission wait cancelled; the original request still owns its background task", null));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            void previous.promise.then(finish, () => finish(failure("Original sandbox admission failed; inspect bg_status", null)));
          });
        }
        if (admissions.size >= 128) return failure("Sandbox admission history capacity reached; start a new session before launching more background experiments");
        // Coalesce BEFORE dispatch: duplicate API replies must never detach the
        // first caller's response listener while its real task is still starting.
        let active = true, pendingResponse = false;
        const promise = (async () => {
          const capabilities = await request("capabilities", {}, `sandbox-capabilities-${randomUUID()}`, signal);
          if (!capabilities.ok || !capabilities.result?.run || !capabilities.result?.kill || !capabilities.result?.logs || !capabilities.result?.run_completion_trigger) return failure(capabilities.error ?? "Background task service lacks required sandbox lifecycle capabilities");
          if (signal?.aborted) return failure("Sandbox cancelled before background launch");
          if (generation !== owner.generation || ctx.cwd !== owner.cwd || ctx.sessionManager?.getSessionId?.() !== owner.sessionId) return failure("Session changed before sandbox dispatch; no sandbox launched");
          const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
          // Only the fixed helper invocation enters the host shell. User script
          // bytes remain base64 data until the helper installs its OS isolation.
          const command = "exec " + ["/usr/bin/python3", "-I", helper, "--background", owner.cwd, process.execPath, Buffer.from(input).toString("base64"), String(Date.now() + 10000)].map(quote).join(" ");
          pendingResponse = true;
          const admitted = await request("run", { name: typeof record?.name === "string" ? record.name : "Sandbox experiment", command, isAgent: false,
            timeoutSeconds: 135, notifyOnCompletion: true, triggerOnCompletion: true }, requestId, signal, stopLate, () => { pendingResponse = false; active = false; });
          if (!admitted.uncertain) { pendingResponse = false; active = false; }
          if (!admitted.ok) return failure(/duplicate request_id/.test(admitted.error ?? "") ? "This sandbox tool call was already dispatched; inspect bg_status instead of relaunching it" : admitted.error ?? "Background sandbox admission failed", admitted.uncertain || /duplicate request_id/.test(admitted.error ?? "") ? null : false);
          if (signal?.aborted || generation !== owner.generation || ctx.cwd !== owner.cwd || ctx.sessionManager?.getSessionId?.() !== owner.sessionId) {
            stopLate(admitted); return failure("Sandbox admission cancelled after launch; stop requested for its bg task", null);
          }
          const task = admitted.result;
          if (!task || typeof task.id !== "string" || typeof task.outputPath !== "string") return failure("Invalid background sandbox acknowledgement; inspect bg_status", null);
          const result = { background: true, taskId: task.id, status: task.status, outputPath: task.outputPath,
            snapshot: "Explicit source files are copied at actual helper launch; inline fixtures are this request's bytes",
            next: "Continue independent work or yield. One bg completion notification follows; use bg_logs for the sandbox JSON result and bg_kill to stop." };
          return { isError: false, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        })();
        admissions.set(requestId, { fingerprint, promise, pending: () => active });
        try { return await promise; } finally { if (!pendingResponse) active = false; }
      }
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
