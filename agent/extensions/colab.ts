/** Google Colab tool: official CLI sessions, execution, files and browser sign-in.
 *
 * One tool instead of a dozen wrappers: the model chooses an action and owns
 * the lifecycle (new -> exec/run -> download -> stop). Long runs detach after
 * a short grace period and hand back a job handle. Authentication uses the
 * official copy-paste OAuth flow, with a visible browser helper and manual
 * code fallback. All output is bounded and credentials are redacted.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { choices } from "./lib/tool-schema.ts";
import {
  ColabError,
  GPU_ACCELERATORS,
  TPU_ACCELERATORS,
  authArgs,
  binaryOnPath,
  cliVersion,
  execArgs,
  harnessAgentDir,
  jobsDir,
  installCli,
  newArgs,
  normalizeGpu,
  normalizeTpu,
  parseErrorHints,
  parseSessions,
  parseUsage,
  redactSecrets,
  resolveCli,
  runCli,
  runScriptArgs,
  simpleArgs,
  stateDir,
  type AuthMode,
  type CliInfo,
  type RunResult,
} from "./lib/colab.ts";
import {
  adcInstructions,
  cancelLogin,
  checkAuth as authCheck,
  completeLogin,
  login,
  loginState,
  resumeLogin,
  shutdownAuth,
} from "./lib/colab-auth.ts";
import { jobOutput, killJob, listJobs, shutdownJobs, startJob, type ColabJob } from "./lib/colab-jobs.ts";

const AUTH_ACTIONS = ["status", "login", "complete", "cancel"] as const;
const ACTIONS = [
  "setup",
  "status",
  "auth",
  "new",
  "sessions",
  "exec",
  "run",
  "install_packages",
  "upload",
  "download",
  "ls",
  "rm",
  "log",
  "stop",
  "restart",
  "url",
  "usage",
  "doctor",
  "jobs",
  "job_output",
  "job_kill",
] as const;

const AUTH_MODES = ["oauth2", "adc"] as const;
const LOCAL_PATH = Type.String({ minLength: 1, maxLength: 4096 });
const REMOTE_PATH = Type.String({ minLength: 1, maxLength: 4096 });

function isAuthMode(value: unknown): value is AuthMode {
  return value === "oauth2" || value === "adc";
}

function json(details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function elapsed(started: number): number {
  return Math.round((Date.now() - started) / 1000);
}

function progressFactory(update: ((partial: any) => void) | undefined) {
  let last = 0;
  return (text: string) => {
    const now = Date.now();
    if (now - last < 1200) return;
    last = now;
    try { update?.({ content: [{ type: "text", text: text.slice(0, 4000) }], details: { progress: text.slice(0, 4000) } }); } catch {}
  };
}

function resolveLocal(raw: unknown, cwd: string, mode: "file" | "write" | "parent" = "file"): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ColabError("A local path is required.", "invalid-path");
  const value = raw.trim();
  if (value.includes("\0")) throw new ColabError("Local paths may not contain NUL bytes.", "invalid-path");
  const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
  if (mode === "file") {
    let stat;
    try { stat = fs.statSync(resolved); } catch { throw new ColabError(`Local file does not exist: ${resolved}`, "invalid-path"); }
    if (!stat.isFile()) throw new ColabError(`Local path is not a regular file: ${resolved}`, "invalid-path");
  } else if (mode === "parent") {
    const parent = path.dirname(resolved);
    fs.mkdirSync(parent, { recursive: true });
  }
  return resolved;
}

function remotePath(raw: unknown, fallback = "content"): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  if (value.includes("\0") || value.length > 4096) throw new ColabError("Invalid remote path.", "invalid-path");
  return value;
}

function parseEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ColabError("env must be an object of string values.", "invalid-env");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ColabError(`Invalid environment variable name: ${key}`, "invalid-env");
    if (typeof value !== "string") throw new ColabError(`Environment value for ${key} must be a string.`, "invalid-env");
    if (value.length > 16_000) throw new ColabError(`Environment value for ${key} is too long.`, "invalid-env");
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function bounded(number: unknown, fallback: number, min: number, max: number): number {
  const value = Number(number);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function tailForResult(result: RunResult): string {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return redactSecrets(text).slice(-20_000);
}

function failureDetails(label: string, result: RunResult) {
  const detail = tailForResult(result);
  return {
    ok: false,
    action: label,
    exit_code: result.code,
    timed_out: result.timedOut,
    output: detail,
    hint: result.timedOut
      ? `The command did not finish within its deadline. For long work use background: true, then poll job_output and keep the session alive.`
      : parseErrorHints(`${result.stdout}\n${result.stderr}`) || "Read the output; fix the reported condition and retry. Do not repeat an allocation that may have succeeded.",
  };
}

async function runChecked(
  cli: CliInfo,
  args: string[],
  options: { input?: string; timeoutMs?: number; signal?: AbortSignal; progress?: (text: string) => void; label: string },
): Promise<RunResult> {
  const result = await runCli(cli.bin, args, {
    ...(options.input !== undefined ? { input: options.input } : {}),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onLine: options.progress,
  });
  if (result.timedOut) throw Object.assign(new ColabError(`${options.label} timed out.`, "timeout"), { details: failureDetails(options.label, result) });
  if (result.code !== 0) throw Object.assign(new ColabError(`${options.label} failed with exit code ${result.code}.`, "command-failed"), { details: failureDetails(options.label, result) });
  return result;
}

function jobResult(job: ColabJob, graceSec: number) {
  return {
    ok: true,
    job_id: job.id,
    state: "running",
    session: job.session,
    log: job.logPath,
    waited_sec: graceSec,
    tail: redactSecrets([job.stdoutTail, job.stderrTail].filter(Boolean).join("\n")).slice(-8000),
    next: "The command is still running in the background. Poll action jobs/job_output with this job_id. The remote kernel may outlive a killed local CLI; stop the session when finished.",
  };
}

async function waitForJob(job: ColabJob, milliseconds: number, progress?: (text: string) => void): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  let lastText = "";
  while (Date.now() < deadline) {
    if (job.state !== "running") return true;
    const text = [job.stdoutTail, job.stderrTail].filter(Boolean).join("\n").slice(-3000);
    if (text && text !== lastText) { lastText = text; progress?.(redactSecrets(text)); }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return job.state !== "running";
}

async function usageFor(cli: CliInfo, mode: AuthMode): Promise<Record<string, unknown> | undefined> {
  const result = await runCli(cli.bin, [...authArgs(mode), "usage"], { timeoutMs: 30_000 });
  if (result.code !== 0) return undefined;
  return { ...parseUsage(result.stdout) };
}

async function sessionsFor(cli: CliInfo, mode: AuthMode): Promise<Record<string, unknown>> {
  const [sessions, status] = await Promise.all([
    runCli(cli.bin, [...authArgs(mode), "sessions"], { timeoutMs: 45_000 }),
    runCli(cli.bin, [...authArgs(mode), "status"], { timeoutMs: 45_000 }),
  ]);
  return {
    sessions: parseSessions(sessions.stdout),
    statuses: parseSessions(status.stdout),
    sessions_output: redactSecrets(sessions.stdout + sessions.stderr).trim().slice(-8000),
    ...(sessions.code !== 0 ? { sessions_error: redactSecrets(sessions.stderr || sessions.stdout).slice(-4000) } : {}),
  };
}



export default function colabExtension(pi: any): void {
  pi.on?.("session_shutdown", () => {
    try { shutdownAuth(); } catch {}
    try { shutdownJobs(); } catch {}
  });

  pi.registerTool({
    name: "colab",
    label: "Google Colab",
    description:
      "Google Colab through the official google-colab-cli: install and browser-authenticate the CLI, rent CPU/GPU/TPU runtimes, run Python scripts or inline code, transfer files, export notebooks, track long training jobs and stop sessions. Use for model fine-tuning (LoRA/QLoRA/SFT/DPO), RL (GRPO/PPO), small from-scratch training, evaluation, dataset work and any compute that outgrows the local machine. " +
      "Actions: setup (install/verify CLI; install:true downloads the pinned official package); status (CLI/auth/usage/sessions/jobs); auth (auth_action: status|login|complete|cancel; login opens a visible browser and auto-completes when signed in; manual code fallback); new (session name + gpu T4/L4/G4/H100/A100 or tpu v5e1/v6e1 + high_mem); sessions; exec (code or script/file, timeout_sec, output_image, env, background); run (local Python script on a fresh VM, gpu/tpu/high_mem/keep, args); install_packages (packages or requirements); upload/download/ls/rm; log (export .ipynb/.md/.txt/.jsonl); stop; restart; url; usage; doctor; jobs/job_output/job_kill. " +
      "Runs that outlive the foreground grace return a job_id and keep streaming to a private log; poll them rather than re-running. Download checkpoints and stop the runtime when done: a Colab session is billable while it exists. Authentication codes and provider tokens are never returned in tool output.",
    parameters: Type.Object({
      action: choices([...ACTIONS], "Operation to perform. Each action accepts only its own fields; unknown fields are ignored by that action's validation."),
      auth_action: Type.Optional(choices([...AUTH_ACTIONS], "auth only: status checks the cached token, login starts the browser flow, complete accepts a pasted code, cancel stops a pending login.")),
      mode: Type.Optional(choices([...AUTH_MODES], "Authentication mode. oauth2 uses the cached user token and browser flow; adc uses Application Default Credentials.")),
      install: Type.Optional(Type.Boolean({ description: "setup/status: install the pinned official CLI into the harness if it is missing (default true for setup)." })),
      update: Type.Optional(Type.Boolean({ description: "setup: run the CLI self-update before reporting (default false)." })),
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 400_000, description: "exec: inline Python source. auth complete: the authorization code from Google's page." })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Session name. Omit when exactly one session exists; always name new sessions." })),
      gpu: Type.Optional(choices([...GPU_ACCELERATORS], "new/run: T4, L4, G4, H100 or A100. Availability depends on the account tier.")),
      tpu: Type.Optional(choices([...TPU_ACCELERATORS], "new/run: v5e1 or v6e1. Do not combine with gpu.")),
      high_mem: Type.Optional(Type.Boolean({ description: "new/run: request a high-RAM shape when the accelerator supports it." })),
      file: Type.Optional(LOCAL_PATH),
      script: Type.Optional(LOCAL_PATH),
      args: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 64, description: "run: arguments forwarded to the script as sys.argv[1:]." })),
      local: Type.Optional(LOCAL_PATH),
      remote: Type.Optional(REMOTE_PATH),
      path: Type.Optional(REMOTE_PATH),
      packages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 64 })),
      requirements: Type.Optional(LOCAL_PATH),
      timeout_sec: Type.Optional(Type.Number({ minimum: 1, maximum: 86_400, description: "exec/run: remote cell timeout; foreground grace is controlled by wait_sec." })),
      wait_sec: Type.Optional(Type.Number({ minimum: 2, maximum: 3500, description: "Foreground time before a run detaches into a job (default 30)." })),
      output_image: Type.Optional(LOCAL_PATH),
      env: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16_000 }), { description: "Environment variables set in the remote kernel (values are redacted from logs)." })),
      background: Type.Optional(Type.Boolean({ description: "Detach immediately and return a job_id; poll with jobs/job_output." })),
      use_browser_cookies: Type.Optional(Type.Boolean({ description: "auth login: seed the sign-in browser from allowed signed-in Chrome cookies when available (default true)." })),
      keep: Type.Optional(Type.Boolean({ description: "run: keep the freshly allocated VM after the script finishes (default false; the CLI releases it)." })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      kind: Type.Optional(Type.String({ maxLength: 80, description: "log: event type filter, e.g. execution or file_operation." })),
      output: Type.Optional(LOCAL_PATH),
      overwrite: Type.Optional(Type.Boolean({ description: "download: replace an existing local file (default false)." })),
      open: Type.Optional(Type.Boolean({ description: "url: also open the browser URL (default false)." })),
      max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 64_000 })),
      job_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      force: Type.Optional(Type.Boolean()),
      refresh: Type.Optional(Type.Boolean({ description: "status/doctor: refresh remote reads instead of using cached last results." })),
    }),
    promptGuidelines: [
      "Colab is billed while a runtime exists: name every session, download checkpoints before stop, and stop sessions you no longer need.",
      "Use exec for iterative work in one persistent kernel; use run for a one-shot script on a fresh VM; use background:true for anything longer than about 30 seconds and poll job_output.",
      "Verify the runtime with a smoke test (torch.cuda.is_available, nvidia-smi, package versions) before training; a prepared script is not a successful run.",
      "The login browser may need the person once for Google sign-in; after that the profile or ADC carries the session. Never ask for or print a password or an OAuth code.",
    ],
    async execute(_id: string, params: any, signal: AbortSignal | undefined, update: any, ctx: any) {
      const action = String(params?.action || "");
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) throw new ColabError(`Unknown action ${JSON.stringify(action)}. Use one of: ${ACTIONS.join(", ")}.`, "invalid-action");
      const progress = progressFactory(update);
      const cwd = ctx?.cwd || process.cwd();
      const mode: AuthMode = isAuthMode(params.mode) ? params.mode : (isAuthMode(process.env.PI_COLAB_AUTH) ? process.env.PI_COLAB_AUTH : "oauth2");
      const started = Date.now();
      progress(`Colab ${action}...`);

      const cliOrThrow = async (autoInstall = false): Promise<CliInfo> => {
        const existing = resolveCli();
        if (existing) return existing;
        if (!autoInstall) {
          throw Object.assign(new ColabError("The official Colab CLI is not installed yet.", "cli-missing"), {
            details: { ok: false, installed: false, next: "Run action setup with install:true once, then retry. Installation uses uv and the pinned google-colab-cli package." },
          });
        }
        progress("Installing the official Colab CLI (this can take a minute)...");
        return installCli((line) => progress(line));
      };

      try {
        if (action === "setup") {
          const install = params.install !== false;
          const existing = resolveCli();
          let info: CliInfo;
          if (existing) info = existing;
          else if (install) info = await installCli((line) => progress(line));
          else return json({ ok: false, installed: false, next: "Run setup with install:true." });
          const version = await cliVersion(info.bin).catch(() => undefined);
          if (params.update === true) {
            const updated = await runCli(info.bin, ["update", "--install"], { timeoutMs: 600_000, onLine: (line) => progress(line) });
            if (updated.code !== 0) progress("CLI self-update did not complete; continuing with the installed version.");
          }
          return json({
            ok: true,
            installed: true,
            cli: { bin: info.bin, source: info.source, version: version ?? info.version ?? null },
            agent_dir: harnessAgentDir(),
            state_dir: stateDir(),
            jobs_dir: jobsDir(),
            browser_profile: path.join(stateDir(), "browser-profile"),
            python_requirement: "3.12+ (the official CLI pins this)",
            package: "google-colab-cli",
            next: "Run action auth with auth_action login (or ADC), then action doctor.",
            elapsed_sec: elapsed(started),
          });
        }

        if (action === "status") {
          const cli = resolveCli();
          if (!cli) return json({ ok: false, installed: false, next: "Run action setup with install:true." });
          const version = await cliVersion(cli.bin).catch(() => undefined);
          const auth = await authCheck(cli.bin, mode);
          const pending = loginState();
          let usage;
          let sessions;
          let authError;
          if (auth.authenticated) {
            try { usage = await usageFor(cli, mode); } catch (error) { authError = String((error as Error)?.message || error); }
            try { sessions = await sessionsFor(cli, mode); } catch (error) { authError = String((error as Error)?.message || error); }
          }
          return json({
            ok: true,
            installed: true,
            cli: { bin: cli.bin, source: cli.source, version: version ?? null },
            auth: { ...auth, detail: auth.authenticated ? "authenticated" : auth.detail },
            pending_auth: pending.status === "no_pending_auth" ? undefined : pending,
            usage,
            sessions,
            jobs: listJobs(),
            ...(authError ? { remote_error: redactSecrets(authError) } : {}),
            elapsed_sec: elapsed(started),
          });
        }

        if (action === "auth") {
          const authAction = String(params.auth_action || (params.code ? "complete" : "status"));
          if (!AUTH_ACTIONS.includes(authAction as (typeof AUTH_ACTIONS)[number])) throw new ColabError(`Unknown auth_action ${JSON.stringify(authAction)}.`, "invalid-action");
          if (authAction === "cancel") return json({ ...cancelLogin(), elapsed_sec: elapsed(started) });
          const cli = await cliOrThrow(authAction !== "status");
          if (authAction === "status") {
            const pending = loginState();
            if (pending.status !== "no_pending_auth") return json({ ok: true, pending_auth: pending, auth: await authCheck(cli.bin, mode) });
            return json({ ok: true, auth: await authCheck(cli.bin, mode), elapsed_sec: elapsed(started) });
          }
          if (authAction === "complete") {
            if (typeof params.code !== "string" || !params.code.trim()) return json({ ok: false, error: "auth_action complete needs the authorization code in the code field." }, true);
            const result = await completeLogin(params.code, bounded(params.wait_sec, 30, 2, 120) * 1000);
            return json({ ...result, auth: result.ok ? await authCheck(cli.bin, mode) : undefined, elapsed_sec: elapsed(started) }, result.ok !== true);
          }
          const result = await login(cli.bin, {
            mode,
            waitMs: bounded(params.wait_sec, 20, 2, 120) * 1000,
            browserTimeoutSec: bounded(params.wait_sec, 300, 30, 900),
            useBrowserCookies: params.use_browser_cookies !== false,
          });
          return json({
            ...result,
            auth: result.ok ? await authCheck(cli.bin, mode) : undefined,
            next: result.ok ? "Authenticated. Run action status or doctor." : result.next,
            elapsed_sec: elapsed(started),
          }, result.ok !== true && result.status !== "awaiting_user");
        }

        if (action === "new") {
          const cli = await cliOrThrow(true);
          const name = params.session ? String(params.session) : `yunuspi-${randomBytes(3).toString("hex")}`;
          const gpu = normalizeGpu(params.gpu);
          const tpu = normalizeTpu(params.tpu);
          if (gpu && tpu) throw new ColabError("Choose a GPU or a TPU, not both.", "invalid-accelerator");
          const pre = await runCli(cli.bin, [...authArgs(mode), "sessions"], { timeoutMs: 45_000 });
          const existing = parseSessions(pre.stdout);
          if (existing.some((session) => session.name === name)) throw new ColabError(`A session named ${name} already exists. Use it, or choose another name.`, "session-exists");
          const args = newArgs({ session: name, gpu, tpu, highMem: params.high_mem === true, auth: mode });
          const result = await runChecked(cli, args, { timeoutMs: bounded(params.timeout_sec, 300, 30, 1200) * 1000, signal, progress, label: "Allocation" });
          const status = await runCli(cli.bin, [...authArgs(mode), "status", "-s", name], { timeoutMs: 30_000 });
          const parsed = parseSessions(status.stdout)[0];
          const usage = await usageFor(cli, mode).catch(() => undefined);
          return json({
            ok: true,
            session: name,
            gpu: gpu ?? null,
            tpu: tpu ?? null,
            high_mem: params.high_mem === true,
            status: parsed ?? null,
            output: redactSecrets(result.stdout).trim().slice(-4000),
            usage,
            other_sessions: existing.map((session) => session.name),
            next: "The runtime is billable. Run action exec/run, keep artifacts under /content, download checkpoints, then action stop.",
            elapsed_sec: elapsed(started),
          });
        }

        if (action === "sessions") {
          const cli = await cliOrThrow(true);
          const data = await sessionsFor(cli, mode);
          const usage = await usageFor(cli, mode).catch(() => undefined);
          return json({ ok: true, ...data, usage, count: (data.sessions as unknown[]).length, elapsed_sec: elapsed(started) });
        }

        if (action === "exec" || action === "run") {
          const cli = await cliOrThrow(true);
          const background = params.background === true;
          const graceSec = bounded(params.wait_sec, 30, 2, 3500);
          const timeoutSec = bounded(params.timeout_sec, 120, 1, 86_400);
          const timeoutMs = Math.max(120_000, timeoutSec * 1000 + 60_000);
          let args: string[];
          let input: string | undefined;
          let label: string;
          if (action === "exec") {
            const scriptPath = params.script ?? params.file;
            if (!params.code && !scriptPath) throw new ColabError("exec needs code (inline) or script/file (a local .py or .ipynb).", "missing-input");
            if (params.code && scriptPath) throw new ColabError("exec takes either code or script/file, not both.", "invalid-input");
            const file = scriptPath ? resolveLocal(scriptPath, cwd, "file") : undefined;
            if (file) {
              const size = fs.statSync(file).size;
              if (size > 128 * 1024 * 1024) throw new ColabError("Local script is larger than 128 MB; upload data separately instead of embedding it in exec.", "too-large");
            }
            const outputImage = params.output_image ? resolveLocal(params.output_image, cwd, "parent") : undefined;
            const env = parseEnv(params.env);
            args = execArgs({ session: params.session, file, timeoutSec, outputImage, env, auth: mode });
            if (!file) input = String(params.code);
            label = file ? `Exec ${path.basename(file)}` : "Exec inline code";
          } else {
            if (!params.script) throw new ColabError("run needs script (a local Python file).", "missing-input");
            const script = resolveLocal(params.script, cwd, "file");
            const scriptArgs = Array.isArray(params.args) ? params.args.map(String) : [];
            if (scriptArgs.some((arg: string) => arg.includes("\0"))) throw new ColabError("Script arguments may not contain NUL bytes.", "invalid-input");
            const env = parseEnv(params.env);
            args = runScriptArgs({ script, scriptArgs, session: params.session, gpu: params.gpu, tpu: params.tpu, highMem: params.high_mem === true, keep: params.keep === true, timeoutSec, env, auth: mode });
            label = `Run ${path.basename(script)}`;
          }
          if (background) {
            const job = startJob({ bin: cli.bin, args, label, ...(params.session ? { session: String(params.session) } : {}), ...(input !== undefined ? { input } : {}), timeoutMs });
            return json({ ...jobResult(job, 0), next: "Detached immediately. Poll action jobs/job_output; the remote VM keeps running until the script ends (run) or you stop it (exec)." });
          }
          const job = startJob({ bin: cli.bin, args, label, ...(params.session ? { session: String(params.session) } : {}), ...(input !== undefined ? { input } : {}), timeoutMs });
          const finished = await waitForJob(job, graceSec * 1000, progress);
          if (!finished) return json(jobResult(job, graceSec));
          const output = await jobOutput(job.id, 20_000);
          const result = {
            ok: job.state === "completed",
            session: params.session ?? null,
            job_id: job.id,
            state: job.state,
            exit_code: job.exitCode ?? null,
            output: output.output,
            log: job.logPath,
            hint: job.state === "completed" ? undefined : job.error ? redactSecrets(job.error) : parseErrorHints(String(output.output || "")),
            elapsed_sec: elapsed(started),
          };
          return json(result, result.ok !== true);
        }

        if (action === "install_packages") {
          const cli = await cliOrThrow(true);
          const packages = Array.isArray(params.packages) ? params.packages.map(String) : undefined;
          const requirements = params.requirements ? resolveLocal(params.requirements, cwd, "file") : undefined;
          if (!packages?.length && !requirements) throw new ColabError("install_packages needs packages or a requirements file.", "missing-input");
          const args = [...authArgs(mode), "install"];
          if (params.session) args.push("-s", String(params.session));
          if (requirements) args.push("-r", requirements);
          if (packages?.length) args.push(...packages);
          const result = await runChecked(cli, args, { timeoutMs: 900_000, signal, progress, label: "Package install" });
          return json({ ok: true, session: params.session ?? null, requirements: requirements ?? null, packages: packages ?? [], output: redactSecrets(result.stdout + result.stderr).slice(-12_000), elapsed_sec: elapsed(started) });
        }

        if (action === "upload") {
          const cli = await cliOrThrow(true);
          if (!params.local || !params.remote) throw new ColabError("upload needs local and remote paths.", "missing-input");
          const local = resolveLocal(params.local, cwd, "file");
          const remote = remotePath(params.remote);
          const size = fs.statSync(local).size;
          if (size > 2 * 1024 * 1024 * 1024) throw new ColabError("Uploads are capped at 2 GB per file; split or use a remote download in the kernel.", "too-large");
          const args = [...authArgs(mode), "upload"];
          if (params.session) args.push("-s", String(params.session));
          args.push(local, remote);
          const result = await runChecked(cli, args, { timeoutMs: 1_800_000, signal, progress, label: "Upload" });
          return json({ ok: true, local, remote, bytes: size, output: redactSecrets(result.stdout + result.stderr).slice(-6000), elapsed_sec: elapsed(started) });
        }

        if (action === "download") {
          const cli = await cliOrThrow(true);
          if (!params.remote) throw new ColabError("download needs remote.", "missing-input");
          const remote = remotePath(params.remote);
          const local = resolveLocal(params.local || path.basename(remote), cwd, "parent");
          if (fs.existsSync(local) && params.overwrite !== true) throw new ColabError(`Local destination already exists: ${local}. Pass overwrite:true to replace it.`, "exists");
          const args = [...authArgs(mode), "download"];
          if (params.session) args.push("-s", String(params.session));
          args.push(remote, local);
          const result = await runChecked(cli, args, { timeoutMs: 1_800_000, signal, progress, label: "Download" });
          let bytes;
          try { bytes = fs.statSync(local).size; } catch {}
          return json({ ok: true, remote, local, bytes: bytes ?? null, output: redactSecrets(result.stdout + result.stderr).slice(-6000), elapsed_sec: elapsed(started) });
        }

        if (action === "ls" || action === "rm") {
          const cli = await cliOrThrow(true);
          if (action === "rm" && !params.path && !params.remote) throw new ColabError("rm needs path.", "missing-input");
          const target = remotePath(params.path ?? params.remote, "content");
          const args = [...authArgs(mode), action];
          if (params.session) args.push("-s", String(params.session));
          args.push(target);
          const result = await runChecked(cli, args, { timeoutMs: 120_000, signal, progress, label: action === "ls" ? "List files" : "Remove file" });
          return json({ ok: true, path: target, output: redactSecrets(result.stdout + result.stderr).slice(-12_000), elapsed_sec: elapsed(started) });
        }

        if (action === "log") {
          const cli = await cliOrThrow(true);
          const args = [...authArgs(mode), "log"];
          if (params.session) args.push("-s", String(params.session));
          if (params.lines) args.push("-n", String(Math.trunc(bounded(params.lines, 50, 1, 100_000))));
          if (params.kind) args.push("-t", String(params.kind).slice(0, 80));
          const output = params.output ? resolveLocal(params.output, cwd, "parent") : undefined;
          if (output) args.push("-o", output);
          const result = await runChecked(cli, args, { timeoutMs: 180_000, signal, progress, label: "Session log" });
          let bytes;
          try { bytes = output ? fs.statSync(output).size : undefined; } catch {}
          return json({ ok: true, session: params.session ?? null, output: output ?? null, bytes: bytes ?? null, text: redactSecrets(result.stdout + result.stderr).slice(-20_000), elapsed_sec: elapsed(started) });
        }

        if (action === "stop" || action === "restart") {
          const cli = await cliOrThrow(true);
          const args = simpleArgs(action === "stop" ? "stop" : "restart-kernel", { session: params.session ? String(params.session) : undefined, auth: mode });
          const result = await runChecked(cli, args, { timeoutMs: 180_000, signal, progress, label: action === "stop" ? "Stop session" : "Restart kernel" });
          const usage = await usageFor(cli, mode).catch(() => undefined);
          return json({
            ok: true,
            session: params.session ?? null,
            output: redactSecrets(result.stdout + result.stderr).slice(-6000),
            usage,
            next: action === "stop" ? "Verify no other session is still running with action sessions." : "Kernel state was reset; re-run setup/data cells before training.",
            elapsed_sec: elapsed(started),
          });
        }

        if (action === "url") {
          const cli = await cliOrThrow(true);
          const args = simpleArgs("url", { session: params.session ? String(params.session) : undefined, auth: mode, extra: params.open === true ? ["--open"] : [] });
          const result = await runChecked(cli, args, { timeoutMs: 60_000, signal, progress, label: "Session URL" });
          const url = (result.stdout.match(/https:\/\/\S+/) || [])[0];
          return json({ ok: true, session: params.session ?? null, url: url ?? null, output: redactSecrets(result.stdout + result.stderr).slice(-4000), note: "This URL attaches the Colab web UI to the existing runtime; it can grant notebook access, so share it deliberately.", elapsed_sec: elapsed(started) });
        }

        if (action === "usage") {
          const cli = await cliOrThrow(true);
          const result = await runChecked(cli, [...authArgs(mode), "usage"], { timeoutMs: 60_000, signal, progress, label: "Compute-unit usage" });
          return json({ ok: true, ...parseUsage(result.stdout), hints: parseErrorHints(result.stderr), elapsed_sec: elapsed(started) });
        }

        if (action === "doctor") {
          const checks: Array<Record<string, unknown>> = [];
          const add = (name: string, ok: boolean | undefined, detail: string, next?: string) => checks.push({ name, ok, detail, ...(next ? { next } : {}) });
          add("platform", process.platform === "linux" || process.platform === "darwin", `${process.platform}; official CLI supports Linux and macOS (WSL2 for Windows).`, process.platform === "win32" ? "Use WSL2 or a Linux VM." : undefined);
          add("node", Number(process.versions.node.split(".")[0]) >= 22, `node ${process.versions.node}`, Number(process.versions.node.split(".")[0]) >= 22 ? undefined : "YunusPi requires Node 22.19 or newer.");
          let cli: CliInfo | undefined;
          try { cli = resolveCli(); } catch (error) { add("cli", false, String((error as Error).message), "Fix PI_COLAB_CLI or run setup."); }
          if (!cli) {
            add("cli", false, "google-colab-cli not found", "Run action setup with install:true.");
          } else {
            const version = await cliVersion(cli.bin).catch(() => undefined);
            add("cli", true, `${cli.bin} (${cli.source}) ${version ?? ""}`.trim(), version && version !== "0.7.4" ? `Expected the pinned 0.7.4; run setup with update:true or reinstall.` : undefined);
            const auth = await authCheck(cli.bin, mode);
            add("auth", auth.authenticated, auth.authenticated ? `authenticated${auth.email ? ` as ${auth.email}` : ""}` : auth.detail, auth.authenticated ? undefined : auth.hint || "Run action auth with auth_action login.");
            if (auth.authenticated) {
              const usage = await usageFor(cli, mode).catch(() => undefined);
              add("compute_units", usage?.balance !== undefined ? (usage.balance as number) > 0 : undefined, usage ? `balance ${usage.balance ?? "unknown"} CU; rate ${usage.ratePerHour ?? "unknown"}/hr; active assignments ${usage.activeAssignments ?? "unknown"}` : "usage unavailable", usage?.balance !== undefined && (usage.balance as number) <= 0 ? "The account has no compute units; run `colab pay` or use a free-tier CPU runtime." : undefined);
              const sessions = await sessionsFor(cli, mode).catch(() => undefined);
              const names = (sessions?.sessions as Array<{ name: string }> | undefined)?.map((item) => item.name) ?? [];
              add("sessions", names.length === 0, names.length ? `active: ${names.join(", ")}` : "no active sessions", names.length ? "Stop sessions you no longer need; idle runtimes still consume units." : undefined);
              add("content_listing", undefined, "remote /content listing is checked only when a session name is supplied");
            }
          }
          const uv = binaryOnPath("uv");
          add("uv", uv ? true : undefined, uv ? `uv at ${uv}` : "uv not installed; the CLI can still be run from an existing install", uv ? undefined : "Install uv (https://docs.astral.sh/uv/) for one-command setup.");
          const gcloud = binaryOnPath("gcloud");
          const adcFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
          add("gcloud", gcloud ? true : undefined, gcloud ? `gcloud at ${gcloud}` : "gcloud not installed", gcloud ? undefined : "Only needed for ADC sign-in; the browser OAuth flow does not require it.");
          add("adc", adcFile && fs.existsSync(adcFile) ? true : undefined, adcFile && fs.existsSync(adcFile) ? `ADC credentials present at ${adcFile}` : "no ADC credential file found", adcFile && fs.existsSync(adcFile) ? undefined : adcInstructions());
          add("display", Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY), process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? "desktop display present" : "no display; browser sign-in falls back to manual code or ADC");
          const configDir = path.join(os.homedir(), ".config", "colab-cli");
          try { fs.mkdirSync(configDir, { recursive: true }); fs.accessSync(configDir, fs.constants.W_OK); add("config_writable", true, configDir); }
          catch { add("config_writable", false, `${configDir} is not writable`, "The official CLI stores its token and log here; run in an environment where your home is writable, or use ADC."); }
          try {
            fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
            const stat = await fsp.statfs(stateDir());
            const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
            add("disk", freeGb > 2, `${freeGb.toFixed(1)} GiB free under ${stateDir()}`, freeGb <= 2 ? "Free disk space before downloading checkpoints." : undefined);
          } catch { add("disk", undefined, "statfs unavailable"); }
          const healthy = checks.every((check) => check.ok !== false);
          return json({ ok: true, healthy, cli: cli?.bin ?? null, checks, jobs: listJobs(), pending_auth: loginState().status === "no_pending_auth" ? undefined : loginState(), elapsed_sec: elapsed(started) });
        }

        if (action === "jobs") {
          return json({ ok: true, jobs: listJobs(), count: listJobs().length, state_dir: stateDir(), note: "Job handles belong to this agent process. A killed local CLI does not necessarily stop the remote kernel; stop the session when done." });
        }

        if (action === "job_output") {
          if (!params.job_id) throw new ColabError("job_output needs job_id.", "missing-input");
          const result = await jobOutput(String(params.job_id), bounded(params.max_chars, 12_000, 500, 64_000));
          return json(result, result.ok !== true);
        }

        if (action === "job_kill") {
          if (!params.job_id) throw new ColabError("job_kill needs job_id.", "missing-input");
          return json(killJob(String(params.job_id), params.force === true));
        }

        throw new ColabError(`Unhandled action ${action}.`, "invalid-action");
      } catch (error) {
        if (error instanceof ColabError) {
          const details = (error as any).details ?? { ok: false, error: error.message, hint: error.hint };
          return json({ ...details, error: error.message, hint: details.hint ?? error.hint }, true);
        }
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        return json({ ok: false, error: message, hint: parseErrorHints(message) }, true);
      }
    },
  });
}
