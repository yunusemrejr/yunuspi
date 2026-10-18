/**
 * Google Colab CLI integration: discovery, installation, argument building,
 * bounded process execution, output parsing and secret redaction.
 *
 * The tool wraps the official `google-colab-cli` package instead of speaking
 * Colab's private backend protocol. That keeps authentication, runtime
 * allocation and kernel transport owned by Google, while YunusPi owns the
 * agent-facing contract: safe argv construction, bounded output, background
 * jobs, clear failures and a browser-assisted OAuth sign-in.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@yunuspi/coding-agent";
import { ownProcessGroup } from "./process-owner.ts";

export const COLAB_INSTALL_VERSION = process.env.PI_COLAB_CLI_VERSION || "0.7.4";
export const GPU_ACCELERATORS = ["T4", "L4", "G4", "H100", "A100"] as const;
export const TPU_ACCELERATORS = ["v5e1", "v6e1"] as const;
export const AUTH_MODES = ["oauth2", "adc"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const MAX_CAPTURE = 96 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

export class ColabError extends Error {
  code: string;
  hint?: string;
  constructor(message: string, code = "colab-error", hint?: string) {
    super(message);
    this.name = "ColabError";
    this.code = code;
    this.hint = hint;
  }
}

export interface CliInfo {
  bin: string;
  source: "env" | "harness" | "user" | "path";
  version?: string;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ParsedUsage {
  balance?: number;
  ratePerHour?: number;
  activeAssignments?: number;
  raw: string;
}

export interface ParsedWhoami {
  provider?: string;
  email?: string;
  expiresIn?: string;
  scopes: string[];
  raw: string;
}

export interface ParsedSession {
  name: string;
  endpoint?: string;
  hardware?: string;
  shape?: string;
  variant?: string;
  status?: string;
  lastExecution?: string;
  raw: string;
}

export function stateDir(): string {
  return process.env.PI_COLAB_STATE_DIR || path.join(os.homedir(), ".pi", "colab");
}

export function jobsDir(): string {
  return path.join(stateDir(), "jobs");
}

export function browserProfileDir(): string {
  return path.join(stateDir(), "browser-profile");
}

export function harnessAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  try {
    return getAgentDir();
  } catch {
    return path.join(os.homedir(), ".pi", "agent");
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(): string[] {
  const home = os.homedir();
  const agent = harnessAgentDir();
  return [
    path.join(agent, "local-tools", "colab", "venv", "bin", "colab"),
    path.join(agent, "local-tools", "bin", "colab"),
    path.join(home, ".local", "share", "uv", "tools", "google-colab-cli", "bin", "colab"),
    path.join(home, ".local", "bin", "colab"),
    "/usr/local/bin/colab",
    "/usr/bin/colab",
  ];
}

function pathLookup(): string | undefined {
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, "colab");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Find the CLI without installing anything. An explicit override that does
 * not exist is an error: silently falling back to another binary would make
 * the agent test a different install than the one it was told to use. */
export function resolveCli(): CliInfo | undefined {
  const explicit = process.env.PI_COLAB_CLI || process.env.COLAB_CLI_PATH;
  if (explicit && explicit.trim()) {
    const bin = path.resolve(explicit.trim());
    if (!isExecutableFile(bin)) throw new ColabError(`PI_COLAB_CLI/COLAB_CLI_PATH points at a non-executable file: ${bin}`, "cli-missing");
    return { bin, source: "env" };
  }
  for (const candidate of pathCandidates()) {
    if (isExecutableFile(candidate)) return { bin: candidate, source: candidate.startsWith(harnessAgentDir()) ? "harness" : "user" };
  }
  const found = pathLookup();
  if (found) return { bin: found, source: "path" };
  return undefined;
}

/** Environment for every CLI invocation: stable, machine-readable, and
 * inherited from the agent only where it matters. Secrets present in the
 * agent environment stay there; this function never prints values. */
export function cliEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  env.PYTHONUNBUFFERED = "1";
  env.NO_COLOR = "1";
  env.TERM = process.env.COLAB_TERM || "dumb";
  env.COLUMNS = env.COLUMNS || "120";
  return env;
}

function tail(text: string, cap = MAX_CAPTURE): string {
  if (text.length <= cap) return text;
  return `[... ${text.length - cap} characters omitted ...]\n${text.slice(-cap)}`;
}

function splitLines(onLine: ((line: string) => void) | undefined, text: string, stream: "out" | "err") {
  if (!onLine) return;
  for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(`${stream === "err" ? "[stderr] " : ""}${redactSecrets(line).slice(0, 4000)}`);
}

/** Execute the CLI with bounded capture, optional stdin, a deadline and
 * process-group cancellation. Never rejects for a non-zero exit; callers
 * interpret the result. */
export function runCli(
  bin: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string | undefined>;
    onLine?: (line: string) => void;
  } = {},
): Promise<RunResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const useLines = Boolean(options.onLine);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(bin, args, {
      cwd: options.cwd || process.cwd(),
      env: cliEnvironment(options.env),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) ownProcessGroup(child.pid);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, signal, stdout: redactSecrets(tail(stdout)), stderr: redactSecrets(tail(stderr)), timedOut, durationMs: Date.now() - started });
    };
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      }, 3000);
      killTimer.unref?.();
    };
    const abort = () => { kill(); finish(null, "SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (useLines) splitLines(options.onLine, text, "out");
      stdout += text;
      if (stdout.length > MAX_CAPTURE * 2) stdout = stdout.slice(-MAX_CAPTURE);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (useLines) splitLines(options.onLine, text, "err");
      stderr += text;
      if (stderr.length > MAX_CAPTURE * 2) stderr = stderr.slice(-MAX_CAPTURE);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") stderr += `\n${bin} is not installed or is not executable`;
      else stderr += `\n${error.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Ensure a usable CLI, installing the pinned official package into a
 * harness-local venv when none is present. */
export async function ensureCli(onLine?: (line: string) => void): Promise<CliInfo & { installed: boolean }> {
  const existing = resolveCli();
  if (existing) {
    const version = await cliVersion(existing.bin).catch(() => undefined);
    return { ...existing, ...(version ? { version } : {}), installed: false };
  }
  const info = await installCli(onLine);
  return { ...info, installed: true };
}

function findUv(): string | undefined {
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, "uv");
    if (isExecutableFile(candidate)) return candidate;
  }
  const fallback = path.join(os.homedir(), ".local", "bin", "uv");
  return isExecutableFile(fallback) ? fallback : undefined;
}

export async function installCli(onLine?: (line: string) => void): Promise<CliInfo> {
  const agent = harnessAgentDir();
  const root = path.join(agent, "local-tools", "colab");
  const venv = path.join(root, "venv");
  const uv = findUv();
  const progress = (line: string) => onLine?.(redactSecrets(line).slice(0, 4000));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const installEnv = {
    UV_CACHE_DIR: path.join(root, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
    UV_LINK_MODE: "copy",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
  const spec = `google-colab-cli==${COLAB_INSTALL_VERSION}`;
  if (uv) {
    progress(`Installing ${spec} into ${venv} with uv`);
    const v = await runCli(uv, ["venv", "--python", "3.12", venv], { timeoutMs: 600_000, env: installEnv, onLine: progress });
    if (v.code !== 0) {
      const fallback = await runCli(uv, ["venv", "--python", "3", venv], { timeoutMs: 600_000, env: installEnv, onLine: progress });
      if (fallback.code !== 0) throw new ColabError(`uv could not create the Colab CLI venv (${tail(v.stderr || fallback.stderr, 4000)})`, "install-failed", "Install uv, then retry setup. The official package is google-colab-cli.");
    }
    const pip = await runCli(uv, ["pip", "install", "--python", path.join(venv, "bin", "python"), spec], { timeoutMs: 900_000, env: installEnv, onLine: progress });
    if (pip.code !== 0) throw new ColabError(`Installing ${spec} failed: ${tail(pip.stderr || pip.stdout, 6000)}`, "install-failed", "Check network access to PyPI, then retry setup.");
  } else {
    const python = ["python3", "python"].map((name) => pathLookupBinary(name)).find(Boolean);
    if (!python) throw new ColabError("Neither uv nor python3 was found, so the Colab CLI cannot be installed", "install-failed", "Install uv (https://docs.astral.sh/uv/) and retry setup.");
    progress(`uv is missing; creating the venv with ${python}`);
    const v = spawnSync(python, ["-m", "venv", venv], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
    if (v.status !== 0) throw new ColabError(`python could not create the Colab CLI venv: ${tail(v.stderr || v.stdout || "", 4000)}`, "install-failed", "Install uv and retry; it also provisions the required Python version.");
    const pip = await runCli(path.join(venv, "bin", "pip"), ["install", spec], { timeoutMs: 900_000, env: installEnv, onLine: progress });
    if (pip.code !== 0) throw new ColabError(`Installing ${spec} failed: ${tail(pip.stderr || pip.stdout, 6000)}`, "install-failed");
  }
  const bin = path.join(venv, "bin", "colab");
  if (!isExecutableFile(bin)) throw new ColabError(`The Colab CLI was installed but ${bin} is missing`, "install-failed");
  const version = await cliVersion(bin).catch(() => undefined);
  return { bin, source: "harness", ...(version ? { version } : {}) };
}

export function binaryOnPath(name: string): string | undefined { return pathLookupBinary(name); }

function pathLookupBinary(name: string): string | undefined {
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export async function cliVersion(bin: string): Promise<string | undefined> {
  const result = await runCli(bin, ["version"], { timeoutMs: 30_000, env: { PYTHONUNBUFFERED: "1" } });
  const text = `${result.stdout}\n${result.stderr}`;
  const match = text.match(/Version:\s*([0-9A-Za-z.+-]+)/i) || text.match(/\b(\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.]+)?)\b/);
  return match?.[1];
}

export function authArgs(mode: AuthMode = "oauth2"): string[] {
  if (!AUTH_MODES.includes(mode)) throw new ColabError(`Unknown auth mode: ${mode}. Use oauth2 or adc.`, "invalid-auth-mode");
  return ["--auth", mode];
}

export function assertSessionName(name: string): string {
  const value = String(name || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new ColabError("Session names must be 1-64 characters, start with a letter or digit, and use only letters, digits, dot, underscore or dash.", "invalid-session");
  }
  return value;
}

export function normalizeGpu(gpu: string | undefined): string | undefined {
  if (gpu === undefined || gpu === null || String(gpu).trim() === "") return undefined;
  const value = String(gpu).trim().toUpperCase();
  const match = GPU_ACCELERATORS.find((item) => item === value);
  if (!match) throw new ColabError(`Unsupported GPU ${JSON.stringify(gpu)}. Supported: ${GPU_ACCELERATORS.join(", ")}.`, "invalid-gpu", "An unknown --gpu would silently become A100 and probably fail allocation.");
  return match;
}

export function normalizeTpu(tpu: string | undefined): string | undefined {
  if (tpu === undefined || tpu === null || String(tpu).trim() === "") return undefined;
  const value = String(tpu).trim().toLowerCase();
  const match = TPU_ACCELERATORS.find((item) => item === value);
  if (!match) throw new ColabError(`Unsupported TPU ${JSON.stringify(tpu)}. Supported: ${TPU_ACCELERATORS.join(", ")}.`, "invalid-tpu");
  return match;
}

export function newArgs(input: { session: string; gpu?: string; tpu?: string; highMem?: boolean; auth?: AuthMode }): string[] {
  const name = assertSessionName(input.session);
  const gpu = normalizeGpu(input.gpu);
  const tpu = normalizeTpu(input.tpu);
  if (gpu && tpu) throw new ColabError("Choose a GPU or a TPU, not both.", "invalid-accelerator");
  const args = [...authArgs(input.auth), "new", "-s", name];
  if (gpu) args.push("--gpu", gpu);
  if (tpu) args.push("--tpu", tpu);
  if (input.highMem) args.push("--high-mem");
  return args;
}

export function execArgs(input: {
  session?: string;
  file?: string;
  timeoutSec?: number;
  outputImage?: string;
  env?: Record<string, string>;
  auth?: AuthMode;
}): string[] {
  const args = [...authArgs(input.auth), "exec"];
  if (input.session) args.push("-s", assertSessionName(input.session));
  if (input.file) args.push("-f", input.file);
  const timeout = Number.isFinite(input.timeoutSec) ? Number(input.timeoutSec) : 120;
  if (timeout < 1 || timeout > 24 * 3600) throw new ColabError("timeout_sec must be between 1 and 86400.", "invalid-timeout");
  args.push("--timeout", String(timeout));
  if (input.outputImage) args.push("--output-image", input.outputImage);
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ColabError(`Invalid environment variable name: ${JSON.stringify(key)}`, "invalid-env");
    if (String(value).length > 16_000) throw new ColabError(`Environment value for ${key} is too long.`, "invalid-env");
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

export function runScriptArgs(input: {
  script: string;
  scriptArgs?: string[];
  session?: string;
  gpu?: string;
  tpu?: string;
  highMem?: boolean;
  keep?: boolean;
  timeoutSec?: number;
  env?: Record<string, string>;
  auth?: AuthMode;
}): string[] {
  const args = [...authArgs(input.auth), "run"];
  if (input.session) args.push("-s", assertSessionName(input.session));
  const gpu = normalizeGpu(input.gpu);
  const tpu = normalizeTpu(input.tpu);
  if (gpu && tpu) throw new ColabError("Choose a GPU or a TPU, not both.", "invalid-accelerator");
  if (gpu) args.push("--gpu", gpu);
  if (tpu) args.push("--tpu", tpu);
  if (input.highMem) args.push("--high-mem");
  if (input.keep) args.push("--keep");
  const timeout = Number.isFinite(input.timeoutSec) ? Number(input.timeoutSec) : 120;
  if (timeout < 1 || timeout > 24 * 3600) throw new ColabError("timeout_sec must be between 1 and 86400.", "invalid-timeout");
  args.push("--timeout", String(timeout));
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ColabError(`Invalid environment variable name: ${JSON.stringify(key)}`, "invalid-env");
    args.push("--env", `${key}=${value}`);
  }
  args.push(input.script, ...(input.scriptArgs ?? []));
  return args;
}

export function simpleArgs(command: string, input: { session?: string; auth?: AuthMode; extra?: string[] } = {}): string[] {
  const safe = ["new", "sessions", "status", "stop", "restart-kernel", "usage", "version", "skill", "readme", "url", "pay", "log", "ls", "rm", "upload", "download", "install", "exec", "run", "auth", "drivemount", "whoami", "console", "ssh", "repl", "edit"];
  if (!safe.includes(command)) throw new ColabError(`Unsupported Colab CLI command: ${command}`, "invalid-command");
  const args = [...authArgs(input.auth), command];
  if (input.session) args.push("-s", assertSessionName(input.session));
  if (input.extra) args.push(...input.extra);
  return args;
}

export function parseUsage(text: string): ParsedUsage {
  const raw = String(text || "");
  const balance = raw.match(/Current balance:\s*([0-9]+(?:\.[0-9]+)?)\s*compute units/i)?.[1];
  const rate = raw.match(/Usage rate:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*hr/i)?.[1];
  const active = raw.match(/Active assignments:\s*(\d+)/i)?.[1];
  return {
    ...(balance !== undefined ? { balance: Number(balance) } : {}),
    ...(rate !== undefined ? { ratePerHour: Number(rate) } : {}),
    ...(active !== undefined ? { activeAssignments: Number(active) } : {}),
    raw,
  };
}

export function parseWhoami(text: string): ParsedWhoami {
  const raw = String(text || "");
  const provider = raw.match(/Auth provider:\s*([A-Za-z0-9_-]+)/i)?.[1];
  const email = raw.match(/Email:\s*([^\s]+@[^\s]+)/i)?.[1];
  const expiresIn = raw.match(/Expires in:\s*([^\n]+)/i)?.[1]?.trim();
  const scopes: string[] = [];
  const scopeBlock = raw.split(/Scopes:\s*\n?/i)[1];
  if (scopeBlock) for (const line of scopeBlock.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(\S+)/);
    if (match) scopes.push(match[1]);
  }
  return { ...(provider ? { provider } : {}), ...(email ? { email } : {}), ...(expiresIn ? { expiresIn } : {}), scopes, raw };
}

export function parseSessions(text: string): ParsedSession[] {
  const sessions: ParsedSession[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") || trimmed.startsWith("[colab]")) continue;
    const match = trimmed.match(/^\[([^\]]+)\]\s+(.*)$/);
    if (!match) continue;
    const [, name, rest] = match;
    const parts = rest.split("|").map((part) => part.trim());
    const field = (label: string) => {
      const found = parts.find((part) => part.toLowerCase().startsWith(`${label.toLowerCase()}:`));
      return found?.split(":").slice(1).join(":").trim();
    };
    sessions.push({
      name,
      endpoint: parts[0] || undefined,
      hardware: field("Hardware"),
      shape: field("Shape"),
      variant: field("Variant"),
      status: field("Status"),
      lastExecution: field("Last Execution"),
      raw: trimmed,
    });
  }
  return sessions;
}

/** Mask credentials and personal data before any CLI text reaches the model,
 * progress UI, job log or error message. The original text is never retained
 * in the returned value. */
export function redactSecrets(input: string): string {
  let text = String(input ?? "");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=.-]{8,}/gi, "Bearer <redacted>");
  text = text.replace(/(?:ya29|1\/\/)[0-9A-Za-z._~+/=-]{12,}/g, "<redacted-google-token>");
  text = text.replace(/\b(?:hf|sk|gh[pousr]|github_pat|npm|AIza|xox[baprs])[_-][A-Za-z0-9_-]{16,}\b/g, "<redacted-credential>");
  text = text.replace(/\b(?:4\/|1\/\/)[0-9A-Za-z._~+/=-]{20,}\b/g, "<redacted-auth-code>");
  text = text.replace(/\b((?:COLAB_JUPYTER_TOKEN|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|WANDB_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)\s*[:=]\s*)[^\s,}"']+/gi, "$1<redacted>");
  text = text.replace(/\b((?:access_token|refresh_token|api[_-]?key|client_secret|password)\s*[:=]\s*)[^\s,}"']+/gi, "$1<redacted>");
  text = text.replace(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (match, domain) => `${match[0]}***@${domain}`);
  return text;
}

export function parseErrorHints(text: string): string | undefined {
  const value = String(text || "");
  if (/\b401\b|unauthorized|invalid_grant|no valid default credentials|failed to refresh token|credentials.*(?:invalid|expired)/i.test(value))
    return "Colab authentication failed. Run the `colab` tool with action auth and auth_action login (or use ADC: gcloud auth application-default login with the Colab scopes).";
  if (/\b403\b|permission denied|quota|USER_PROJECT_DENIED/i.test(value))
    return "The account lacks permission or quota for this operation. Check `colab usage` and the account used by `auth status`; try a CPU/T4 runtime or another auth mode.";
  if (/\b412\b|precondition failed|too many active sessions|allocation refused/i.test(value))
    return "Colab refused a new runtime: too many active sessions or temporary capacity/usage limits. Stop an old session with action stop, wait, or request a smaller accelerator.";
  if (/(?:session|runtime).*(?:not found|404|expired|lost)/i.test(value))
    return "The remote session is gone. Create a new one with action new, re-upload data, and resume from the last downloaded checkpoint.";
  if (/out of memory|CUDA out of memory|OOM|killed/i.test(value))
    return "The runtime ran out of memory. Restart the kernel, reduce batch size/sequence length or model precision, or request a larger accelerator/high-memory runtime.";
  if (/quota exceeded|rate limit|429/i.test(value))
    return "The request was rate-limited. Back off, reuse the existing session, or retry with a smaller/cheaper operation.";
  if (/could not connect|connection (?:refused|reset|closed|timed out)|websocket (?:closed|error)|connection timed out|timed out waiting/i.test(value))
    return "The local CLI lost its connection to the runtime. Check `colab status`; the kernel may still be running. Reattach with exec, restart the kernel, or stop the session if it is unrecoverable.";
  if (/command not found|is not installed|No such file or directory/i.test(value))
    return "The Colab CLI is not installed. Run the `colab` tool with action setup (install: true).";
  return undefined;
}

/** Small, stable identifier for a session/job/artifact name. */
export function safeLabel(value: string, max = 80): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}


export function authBrowserScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "colab-auth-browser.mjs");
}

