/**
 * Background Colab jobs: a tool call that would otherwise block the agent for
 * the length of a training run detaches after a short grace period and hands
 * back a job handle. Output is streamed to a private log file, the last bytes
 * stay in memory for immediate polling, and the whole process group can be
 * killed without touching any other job.
 *
 * Handles are scoped to one agent process (like browser handles). The remote
 * Colab kernel may survive a killed local CLI, so stopping the runtime remains
 * the explicit `stop` action.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ownProcessGroup } from "./process-owner.ts";
import { cliEnvironment, jobsDir, redactSecrets } from "./colab.ts";

const MAX_JOBS = 12;
const TAIL_CAP = 64 * 1024;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_MS = 12 * 60 * 60 * 1000;

export type JobState = "running" | "completed" | "failed" | "timed_out" | "killed";

export interface ColabJob {
  id: string;
  label: string;
  args: string[];
  session?: string;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath: string;
  child?: ChildProcessWithoutNullStreams;
  stdoutTail: string;
  stderrTail: string;
  error?: string;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

const jobs = new Map<string, ColabJob>();
const listeners = new Set<() => void>();

function trimTail(text: string): string {
  return text.length <= TAIL_CAP ? text : text.slice(-TAIL_CAP);
}

async function pruneLogs(): Promise<void> {
  try {
    const keep = new Set([...jobs.values()].map((job) => path.basename(job.logPath)));
    const entries = await fsp.readdir(jobsDir(), { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => ({ name: entry.name, mtime: (await fsp.stat(path.join(jobsDir(), entry.name))).mtimeMs })));
    for (const file of files.filter((item) => !keep.has(item.name)).sort((a, b) => a.mtime - b.mtime).slice(0, Math.max(0, files.length - 24))) {
      await fsp.rm(path.join(jobsDir(), file.name), { force: true }).catch(() => {});
    }
  } catch { /* log retention is best-effort */ }
}

function record(job: ColabJob, stream: "out" | "err", chunk: Buffer) {
  const text = chunk.toString("utf8");
  if (stream === "out") job.stdoutTail = trimTail(job.stdoutTail + text);
  else job.stderrTail = trimTail(job.stderrTail + text);
  if (job.child?.pid === undefined) return;
  void fsp.appendFile(job.logPath, text, { mode: 0o600 }).catch(() => {});
}

function finish(job: ColabJob, state: JobState, exitCode: number | null, signal: NodeJS.Signals | null) {
  if (job.state !== "running") return;
  job.state = state;
  job.exitCode = exitCode;
  job.signal = signal;
  job.endedAt = Date.now();
  if (job.timer) clearTimeout(job.timer);
  if (job.killTimer) clearTimeout(job.killTimer);
  const line = `\n[colab job ${job.id} ${state}${exitCode === null ? "" : ` exit=${exitCode}`}${signal ? ` signal=${signal}` : ""} after ${Math.round((job.endedAt - job.startedAt) / 1000)}s]\n`;
  void fsp.appendFile(job.logPath, line, { mode: 0o600 }).catch(() => {});
  for (const listener of listeners) { try { listener(); } catch {} }
}

function killTree(job: ColabJob, force = false) {
  const child = job.child;
  if (!child?.pid) return;
  const pid = child.pid;
  try { process.kill(-pid, force ? "SIGKILL" : "SIGTERM"); } catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
  if (!force) {
    job.killTimer = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, 4000);
    job.killTimer.unref?.();
  }
}

export function startJob(input: {
  bin: string;
  args: string[];
  label: string;
  session?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  onStarted?: (job: ColabJob) => void;
  onFinished?: (job: ColabJob) => void;
}): ColabJob {
  if ([...jobs.values()].filter((job) => job.state === "running").length >= MAX_JOBS) {
    const finished = [...jobs.values()].filter((job) => job.state !== "running").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0];
    if (finished) jobs.delete(finished.id);
    else throw new Error(`All ${MAX_JOBS} Colab job slots are running; wait for one or kill one first.`);
  }
  const id = `colab-${randomBytes(4).toString("hex")}`;
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  const logPath = path.join(jobsDir(), `${id}.log`);
  const job: ColabJob = { id, label: input.label.slice(0, 160), args: input.args.map(redactSecrets), session: input.session, startedAt: Date.now(), state: "running", logPath, stdoutTail: "", stderrTail: "" };
  jobs.set(id, job);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1000, Math.min(MAX_RUNTIME_MS, Number(input.timeoutMs))) : MAX_RUNTIME_MS;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(input.bin, input.args, {
      env: cliEnvironment(input.env),
      stdio: [input.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    finish(job, "failed", null, null);
    job.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
  job.child = child;
  if (child.pid) ownProcessGroup(child.pid);
  child.stdout.on("data", (chunk: Buffer) => record(job, "out", chunk));
  child.stderr.on("data", (chunk: Buffer) => record(job, "err", chunk));
  child.on("error", (error) => {
    job.error = error.message;
    finish(job, "failed", null, null);
    input.onFinished?.(job);
  });
  child.on("close", (code, signal) => {
    finish(job, code === 0 ? "completed" : "failed", code, signal);
    input.onFinished?.(job);
    void pruneLogs();
  });
  job.timer = setTimeout(() => {
    if (job.state !== "running") return;
    job.error = `Job exceeded its ${Math.round(timeoutMs / 1000)}s deadline and was killed locally. The remote kernel may still be running; check action status and stop the session if needed.`;
    killTree(job, true);
    finish(job, "timed_out", null, "SIGKILL");
  }, timeoutMs);
  job.timer.unref?.();
  void fsp.writeFile(logPath, `# ${new Date(job.startedAt).toISOString()} ${job.label}\n# ${job.args.join(" ")}\n\n`, { mode: 0o600 }).catch(() => {});
  if (input.input !== undefined) {
    child.stdin.end(input.input);
  }
  input.onStarted?.(job);
  return job;
}

export function listJobs(): Array<Record<string, unknown>> {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((job) => ({
      id: job.id,
      label: job.label,
      session: job.session,
      state: job.state,
      started_at: new Date(job.startedAt).toISOString(),
      ended_at: job.endedAt ? new Date(job.endedAt).toISOString() : undefined,
      elapsed_sec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
      exit_code: job.exitCode,
      log: job.logPath,
      error: job.error ? redactSecrets(job.error) : undefined,
    }));
}

export function findJob(id: string): ColabJob | undefined {
  return jobs.get(String(id || "").trim());
}

export async function jobOutput(id: string, maxChars = 12_000): Promise<Record<string, unknown>> {
  const job = findJob(id);
  if (!job) return { ok: false, error: "Unknown Colab job. Job handles belong to this agent process; use the returned id or start a new job." };
  const limit = Math.max(500, Math.min(64_000, Number(maxChars) || 12_000));
  let text = "";
  try {
    const stat = await fsp.stat(job.logPath);
    if (stat.size > 0) {
      const start = Math.max(0, stat.size - Math.max(limit * 2, 4096));
      const handle = await fsp.open(job.logPath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString("utf8");
      } finally { await handle.close(); }
    }
  } catch {
    text = `${job.stdoutTail}\n${job.stderrTail}`;
  }
  if (!text) text = `${job.stdoutTail}\n${job.stderrTail}`;
  const clipped = text.length > limit ? `[... ${text.length - limit} characters omitted ...]\n${text.slice(-limit)}` : text;
  return {
    ok: true,
    id: job.id,
    state: job.state,
    exit_code: job.exitCode,
    elapsed_sec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    output: redactSecrets(clipped),
    log: job.logPath,
    truncated: text.length > limit,
  };
}

export function jobSnapshot(job: ColabJob): Record<string, unknown> {
  return {
    id: job.id,
    label: job.label,
    session: job.session,
    state: job.state,
    elapsed_sec: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
    exit_code: job.exitCode,
    log: job.logPath,
    tail: redactSecrets([job.stdoutTail, job.stderrTail].filter(Boolean).join("\n")).slice(-8000),
  };
}

export function killJob(id: string, force = false): Record<string, unknown> {
  const job = findJob(id);
  if (!job) return { ok: false, error: "Unknown Colab job id." };
  if (job.state !== "running") return { ok: true, id: job.id, state: job.state, note: "The job had already finished." };
  job.error = "Killed by the agent. The remote kernel may still be running; use action status/stop to release the runtime.";
  killTree(job, force);
  finish(job, "killed", null, "SIGTERM");
  return {
    ok: true,
    id: job.id,
    state: job.state,
    note: "The local CLI was stopped. A remote Colab kernel can survive a dropped websocket; check action status and stop the session if it should be released.",
  };
}

export function onJobsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function shutdownJobs(): void {
  for (const job of jobs.values()) {
    if (job.state !== "running") continue;
    job.error = "Agent session ended; the local CLI was stopped. The remote kernel may still be running.";
    killTree(job, true);
    finish(job, "killed", null, "SIGTERM");
  }
}
