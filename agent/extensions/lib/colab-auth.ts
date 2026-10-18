/**
 * Browser-assisted Colab CLI authentication.
 *
 * The official CLI uses Google's remote copy-paste OAuth flow: it prints an
 * accounts.google.com URL, then blocks on `input("Enter the authorization
 * code: ")`. A local helper opens that URL in a real browser, clicks the
 * account/consent screens when the person is already signed in, and reads the
 * code Google displays. When Google requires a password, 2-step verification,
 * CAPTCHA or device confirmation, the helper reports `needs_user`; the person
 * finishes in the visible window and the helper keeps polling without ever
 * handling a password itself. Manual code entry remains available.
 *
 * The CLI child is kept alive between tool calls so the authorization code can
 * be pasted later. The code is written to the child's stdin and never returned
 * as part of a tool result.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ownProcessGroup } from "./process-owner.ts";
import {
  ColabError,
  authArgs,
  authBrowserScript,
  browserProfileDir,
  cliEnvironment,
  parseErrorHints,
  parseWhoami,
  redactSecrets,
  runCli,
  stateDir,
  type AuthMode,
} from "./colab.ts";
import { getBrowserCookiesForHosts } from "../pi-web-access/chrome-cookies.ts";

export interface AuthCheck {
  authenticated: boolean;
  provider?: string;
  email?: string;
  expiresIn?: string;
  scopes: string[];
  exitCode: number | null;
  timedOut: boolean;
  hint?: string;
  detail: string;
}

interface PendingAuth {
  bin: string;
  mode: AuthMode;
  startedAt: number;
  child?: ChildProcessWithoutNullStreams;
  helper?: ChildProcessWithoutNullStreams;
  url?: string;
  stage?: string;
  helperState?: string;
  helperReason?: string;
  helperError?: string;
  codeCaptured?: boolean;
  codeWritten?: boolean;
  done?: boolean;
  exitCode?: number | null;
  output?: string;
  error?: string;
  timer?: NodeJS.Timeout;
}

let pending: PendingAuth | undefined;

function settle(_p: PendingAuth) {
  /* State changes are observed by the polling wait below; no promise wakeups. */
}

function killChild(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
    }, 2000).unref?.();
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function publicState(p: PendingAuth) {
  return {
    status: p.done ? (p.exitCode === 0 ? "authenticated" : "failed") : p.error || p.helperError ? "failed" : "awaiting_user",
    stage: p.stage,
    url: p.url,
    reason: p.helperReason,
    error: p.error || p.helperError,
    code_captured: Boolean(p.codeCaptured),
    code_written: Boolean(p.codeWritten),
    elapsed_sec: Math.round((Date.now() - p.startedAt) / 1000),
    hint: p.done && p.exitCode === 0 ? undefined : "A browser window is open. Sign in and approve Colab access there; the login completes automatically. If it closed, run action auth with auth_action login again, or paste the code with auth_action complete.",
  };
}

function maskedDetail(text: string): string {
  return redactSecrets(String(text || "")).slice(0, 4000);
}

async function runAuthProbe(bin: string, mode: AuthMode, timeoutMs = 30_000): Promise<AuthCheck> {
  const args = [...authArgs(mode), "whoami"];
  const result = await runCli(bin, args, { timeoutMs, env: { ...cliEnvironment() } });
  const combined = `${result.stdout}\n${result.stderr}`;
  const parsed = parseWhoami(combined);
  const authenticated = result.code === 0 && !result.timedOut && (Boolean(parsed.provider) || Boolean(parsed.email));
  const detail = maskedDetail(result.stdout || result.stderr || (result.timedOut ? "auth check timed out" : "no output"));
  const hint = authenticated ? undefined : parseErrorHints(combined) || (mode === "adc"
    ? adcInstructions()
    : "Run action auth with auth_action login to open the sign-in browser.");
  return {
    authenticated,
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.email ? { email: redactSecrets(parsed.email) } : {}),
    ...(parsed.expiresIn ? { expiresIn: parsed.expiresIn } : {}),
    scopes: parsed.scopes,
    exitCode: result.code,
    timedOut: result.timedOut,
    ...(hint ? { hint } : {}),
    detail,
  };
}

export function adcInstructions(): string {
  return "ADC needs a one-time gcloud login with the Colab scopes: gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory";
}

export async function checkAuth(bin: string, mode: AuthMode = "oauth2"): Promise<AuthCheck> {
  return runAuthProbe(bin, mode);
}

function extractUrl(text: string): string | undefined {
  const match = String(text || "").match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/);
  return match?.[0]?.replace(/[.,;:]+$/, "");
}

function hasDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function openSystemBrowser(url: string): boolean {
  const candidates = process.platform === "darwin" ? [["open", [url]]] : [["xdg-open", [url]], ["gio", ["open", url]], ["sensible-browser", [url]]];
  for (const [command, args] of candidates) {
    try {
      const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch {}
  }
  return false;
}

async function cookieFile(): Promise<string | undefined> {
  if (process.env.PI_COLAB_USE_BROWSER_COOKIES === "0") return undefined;
  try {
    const extracted = await getBrowserCookiesForHosts({
      hosts: ["accounts.google.com", "sdk.cloud.google.com", "colab.research.google.com"],
      allowExplicit: true,
    });
    if (!extracted?.entries?.length) return undefined;
    const dir = path.join(stateDir(), "auth");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `cookies-${randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(file, JSON.stringify(extracted.entries), { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

function startBrowserHelper(p: PendingAuth, url: string, timeoutSec: number): void {
  const script = process.env.PI_COLAB_AUTH_BROWSER || authBrowserScript();
  if (!fs.existsSync(script)) {
    p.helperError = `The browser helper is missing at ${script}; use the printed URL and auth_action complete with the code.`;
    if (openSystemBrowser(url)) p.helperState = "system-browser";
    return;
  }
  void cookieFile().then((cookies) => {
    const args = [script, "--url", url, "--profile", browserProfileDir(), "--timeout", String(timeoutSec)];
    if (!hasDisplay()) args.push("--headless");
    if (cookies) args.push("--cookies", cookies);
    let helper: ChildProcessWithoutNullStreams;
    try {
      helper = spawn(process.execPath, args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], detached: false }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      p.helperError = `Could not start the browser helper: ${error instanceof Error ? error.message : String(error)}`;
      openSystemBrowser(url);
      return;
    }
    p.helper = helper;
    let buffer = "";
    helper.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          if (event.status === "opened") p.helperState = `browser:${event.browser}`;
          else if (event.status === "navigated") p.stage = event.stage;
          else if (event.status === "needs_user") { p.helperState = "needs_user"; p.helperReason = event.reason; }
          else if (event.status === "action") { p.helperState = `action:${event.action}`; }
          else if (event.status === "code") {
            p.codeCaptured = true;
            p.helperState = "code";
            writeCode(p, event.code);
          } else if (event.status === "timeout") {
            p.helperError = `The sign-in browser timed out after ${event.seconds}s. Run auth login again, or paste the code with auth_action complete.`;
          } else if (event.status === "error") {
            p.helperError = `Browser sign-in failed (${event.stage || "startup"}): ${event.message || "unknown error"}`;
          }
          settle(p);
        } catch { /* one malformed helper line does not abort the flow */ }
      }
    });
    helper.stderr.on("data", () => { /* helper diagnostics stay off the tool surface */ });
    helper.on("error", (error) => { p.helperError = `Browser helper error: ${error.message}`; openSystemBrowser(url); settle(p); });
    helper.on("close", () => {
      if (p.helperState === "needs_user" && !p.done) p.helperState = "browser-closed";
      if (!p.done && !p.codeCaptured) {
        if (!p.helperError) p.helperError = "The sign-in browser closed before a code was captured. Re-run auth login, or paste the code with auth_action complete.";
        if (!p.url) openSystemBrowser(url);
      }
      settle(p);
    });
  });
}

function writeCode(p: PendingAuth, code: unknown): void {
  if (p.codeWritten) return;
  const value = String(code ?? "").trim();
  if (!/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(value)) {
    p.error = "The browser returned an unexpected authorization code; nothing was written to the CLI.";
    return;
  }
  if (!p.child?.stdin.writable) {
    p.error = "The Colab CLI stopped waiting for the authorization code; run auth login again.";
    return;
  }
  p.codeWritten = true;
  try {
    p.child.stdin.write(`${value}\n`);
    p.child.stdin.end();
  } catch {
    p.error = "The Colab CLI stopped accepting the authorization code; run auth login again.";
  }
}

async function waitForFinish(ms: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, Math.min(120_000, ms));
  while (Date.now() < deadline) {
    if (!pending || pending.done) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Start the OAuth flow, wait a short time for an already-signed-in browser,
 * then return awaiting_user with the login kept alive for a later call. */
export async function login(
  bin: string,
  options: { mode?: AuthMode; waitMs?: number; browserTimeoutSec?: number; useBrowserCookies?: boolean } = {},
): Promise<Record<string, unknown>> {
  const mode = options.mode ?? "oauth2";
  if (mode === "adc") {
    const checked = await checkAuth(bin, "adc");
    return checked.authenticated
      ? { ok: true, status: "authenticated", ...checked }
      : { ok: false, status: "adc_required", ...checked, next: adcInstructions() };
  }
  if (pending) {
    if (pending.done) {
      const state = publicState(pending);
      pending = undefined;
      return { ok: state.status === "authenticated", ...state };
    }
    await waitForFinish(Number(options.waitMs ?? 15_000));
    return { ok: false, ...publicState(pending) };
  }
  const existing = await checkAuth(bin, mode);
  if (existing.authenticated) return { ok: true, status: "authenticated", ...existing };

  const p: PendingAuth = { bin, mode, startedAt: Date.now() };
  pending = p;
  const args = [...authArgs(mode), "whoami"];
  const child = spawn(bin, args, { env: cliEnvironment({ ...(options.useBrowserCookies === false ? { PI_COLAB_USE_BROWSER_COOKIES: "0" } : {}) }), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }) as ChildProcessWithoutNullStreams;
  if (child.pid) ownProcessGroup(child.pid);
  p.child = child;
  let helperStarted = false;
  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    p.output = `${p.output ?? ""}${text}`.slice(-32_000);
    if (!p.url) {
      const url = extractUrl(text);
      if (url) {
        p.url = url;
        p.stage = "oauth-url";
        if (!helperStarted) {
          helperStarted = true;
          startBrowserHelper(p, url, Number(options.browserTimeoutSec ?? 300));
        }
        settle(p);
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (error: NodeJS.ErrnoException) => {
    p.error = error.code === "ENOENT" ? `The Colab CLI is not installed at ${bin}. Run action setup.` : error.message;
    p.done = true;
    settle(p);
  });
  const finishChild = (code: number | null) => {
    if (p.done) return;
    p.done = true;
    p.exitCode = code;
    if (code !== 0 && !p.error) {
      const detail = p.output || "";
      p.error = parseErrorHints(detail) || `Colab sign-in did not complete (exit ${code}). ${p.url ? "Open the printed URL and use auth_action complete with the displayed code." : ""}`;
    }
    if (p.helper && p.helperState !== "code") killChild(p.helper);
    settle(p);
  };
  child.on("exit", (code) => finishChild(code));
  child.on("close", (code) => finishChild(code));
  // Keep the child's stdin open; this is exactly the prompt it is blocked on.
  await waitForFinish(Number(options.waitMs ?? 20_000));
  if (p.done) {
    const state = publicState(p);
    pending = undefined;
    return { ok: state.status === "authenticated", ...state, ...(p.url ? { url: p.url } : {}) };
  }
  return { ok: false, ...publicState(p) };
}

export async function completeLogin(code: string, waitMs = 30_000): Promise<Record<string, unknown>> {
  if (!pending || pending.done) {
    pending = undefined;
    return { ok: false, status: "no_pending_auth", next: "Run auth login first; there is no Colab sign-in waiting for a code." };
  }
  const value = String(code ?? "").trim();
  if (!/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(value)) return { ok: false, status: "invalid_code", next: "Paste the authorization code shown on the Google page exactly as displayed." };
  writeCode(pending, value);
  await waitForFinish(Math.max(1_000, Math.min(120_000, waitMs)));
  const state = publicState(pending);
  if (pending.done) pending = undefined;
  return { ok: state.status === "authenticated", ...state };
}

export async function resumeLogin(waitMs = 20_000): Promise<Record<string, unknown>> {
  if (!pending) return { ok: false, status: "no_pending_auth", next: "Run auth login to start the browser sign-in." };
  await waitForFinish(Math.max(1_000, Math.min(120_000, waitMs)));
  const state = publicState(pending);
  if (pending.done) pending = undefined;
  return { ok: state.status === "authenticated", ...state };
}

export function loginState(): Record<string, unknown> {
  if (!pending) return { status: "no_pending_auth" };
  return publicState(pending);
}

export function cancelLogin(): Record<string, unknown> {
  if (!pending) return { ok: true, status: "no_pending_auth" };
  const p = pending;
  p.done = true;
  killChild(p.helper);
  killChild(p.child);
  pending = undefined;
  return { ok: true, status: "cancelled" };
}

/** Session shutdown must not leave a blocked CLI or an orphan browser. */
export function shutdownAuth(): void {
  if (!pending) return;
  killChild(pending.helper);
  killChild(pending.child);
  pending = undefined;
}

export function validateManualCode(code: string): string {
  const value = String(code ?? "").trim();
  if (!/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(value)) throw new ColabError("That does not look like a Google authorization code.", "invalid-code");
  return value;
}
