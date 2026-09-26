/** Virtual-display computer use. Each session owns a private Xvfb display:
 * desktop applications (Electron, GTK, Qt, plain X11) are launched into it and
 * driven with pointer and keyboard input through xdotool, and inspected with
 * screenshots and window lists. The user's own desktop, clipboard and input
 * devices are never touched. Launch commands run like bash commands (the same
 * filesystem-safety hook reviews them) in their own process group, and every
 * process dies with its session. */
import fs from "node:fs/promises";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const exec = promisify(execFile);
const MAX_SESSIONS = 2, MAX_PROCESSES = 12, IDLE_MS = 20 * 60_000, LOG_BYTES = 16_384;

interface Launched { pid: number; command: string; child: ChildProcess; output: string; exited?: number | string; startedAt: number; }
export interface DesktopSession { id: string; display: string; width: number; height: number; xvfb: ChildProcess; processes: Map<number, Launched>; startedAt: number; lastUsed: number; dir: string; shots: number; }

export function desktopAvailability(): { ok: boolean; missing: string[] } {
  const directories = (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter);
  const missing = ["Xvfb", "xdotool", "xwd", "ffmpeg"].filter((binary) => !directories.some((dir) => {
    const executable = path.resolve(dir || ".", binary);
    try {
      accessSync(executable, constants.X_OK);
      return statSync(executable).isFile();
    } catch { return false; }
  }));
  return { ok: missing.length === 0, missing };
}

async function x(session: DesktopSession, args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await exec("xdotool", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: session.display }, timeout, maxBuffer: 1024 * 1024 });
  return String(stdout);
}
const number = (value: unknown, min: number, max: number, name: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
  return Math.round(value);
};

export function createDesktopManager(options: { now?: () => number; artifactRoot?: () => string } = {}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, DesktopSession>();
  const pendingStarts = new Map<AbortController, Promise<void>>();
  const pendingStops = new Set<Promise<void>>();
  let shutdownEpoch = 0;
  let stopAllPromise: Promise<void> | undefined;
  const get = (id: unknown) => {
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    if (!session) throw new Error(`Unknown desktop session${sessions.size ? `; open sessions: ${[...sessions.keys()].join(", ")}` : "; start one first"}`);
    if (session.xvfb.exitCode !== null) { void stop(session.id); throw new Error("The virtual display exited; start a new session"); }
    session.lastUsed = now();
    return session;
  };
  const reap = async () => { for (const session of [...sessions.values()]) if (now() - session.lastUsed > IDLE_MS) await stop(session.id); };

  async function start(params: { width?: number; height?: number }) {
    const epoch = shutdownEpoch;
    if (stopAllPromise) throw new Error("Desktop sessions are stopping");
    const availability = desktopAvailability();
    if (!availability.ok) throw new Error(`Virtual display tools are missing: ${availability.missing.join(", ")}. On Debian/Ubuntu: sudo apt-get install xvfb xdotool x11-apps ffmpeg`);
    await reap();
    if (stopAllPromise || epoch !== shutdownEpoch) throw new Error("Desktop sessions stopped during startup");
    if (sessions.size + pendingStarts.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} desktop sessions; stop one first`);
    const width = params.width === undefined ? 1280 : number(params.width, 320, 2560, "width");
    const height = params.height === undefined ? 800 : number(params.height, 240, 1600, "height");
    const controller = new AbortController();
    let finish!: () => void;
    pendingStarts.set(controller, new Promise<void>((resolve) => { finish = resolve; }));
    let xvfb: ChildProcess | undefined;
    let dir: string | undefined;
    try {
      // Xvfb allocates its own free display and acknowledges readiness on our pipe.
      // A socket discovered by scanning /tmp could belong to another process.
      xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-noreset", "-nocursor"], { stdio: ["ignore", "ignore", "ignore", "pipe"], detached: true, signal: controller.signal });
      const child = xvfb;
      child.unref();
      const display = await new Promise<string>((resolve, reject) => {
        let receipt = "", settled = false;
        const timer = setTimeout(() => fail(new Error("The virtual display did not start within 6 seconds")), 6000);
        const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
        child.on("error", fail);
        child.once("exit", () => fail(new Error("The virtual display exited before it was ready")));
        child.stdio[3]!.on("error", fail);
        child.stdio[3]!.on("data", (chunk: Buffer) => {
          if (settled) return;
          receipt += chunk.toString("ascii");
          if (receipt.length > 32 || !/^\d*\n?$/.test(receipt)) return fail(new Error("Invalid virtual display readiness receipt"));
          if (/^\d+\n$/.test(receipt)) {
            settled = true; clearTimeout(timer); resolve(`:${receipt.trim()}`);
          }
        });
        child.stdio[3]!.once("end", () => fail(new Error("The virtual display closed its readiness pipe")));
      });
      const id = `desk-${randomBytes(3).toString("hex")}`;
      dir = await fs.mkdtemp(path.join(options.artifactRoot?.() ?? os.tmpdir(), `${id}-`));
      if (controller.signal.aborted || child.exitCode !== null || child.signalCode !== null) throw new Error("The virtual display stopped during startup");
      sessions.set(id, { id, display, width, height, xvfb: child, processes: new Map(), startedAt: now(), lastUsed: now(), dir, shots: 0 });
      return { session: id, display, width, height, note: "Private virtual display: nothing here reaches the user's screen. Launch an app, then screenshot, click, type and key against it." };
    } catch (error) {
      if (xvfb?.pid) { try { process.kill(-xvfb.pid, "SIGKILL"); } catch { /* already gone */ } }
      if (dir) await fs.rm(dir, { recursive: true, force: true });
      throw error;
    } finally { pendingStarts.delete(controller); finish(); }
  }

  async function launch(params: { session: string; command: string; cwd: string }) {
    const session = get(params.session);
    if (typeof params.command !== "string" || !params.command.trim() || params.command.length > 4000) throw new Error("command must be a non-empty shell command up to 4000 characters");
    for (const [pid, proc] of session.processes) if (proc.exited !== undefined && session.processes.size >= MAX_PROCESSES) session.processes.delete(pid);
    if ([...session.processes.values()].filter((p) => p.exited === undefined).length >= MAX_PROCESSES) throw new Error(`At most ${MAX_PROCESSES} running processes per desktop session`);
    const before = new Set((await windows(session).catch(() => [])).map((w) => w.id));
    if (!sessions.has(session.id) || stopAllPromise) throw new Error("Desktop session stopped during launch");
    const child = spawn("/bin/sh", ["-c", params.command], { cwd: params.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DISPLAY: session.display, WAYLAND_DISPLAY: "", GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb" } });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.once("spawn", resolve); });
    if (!sessions.has(session.id)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } throw new Error("Desktop session stopped during launch"); }
    const record: Launched = { pid: child.pid!, command: params.command.slice(0, 300), child, output: "", startedAt: now() };
    const collect = (chunk: Buffer) => { record.output = (record.output + chunk.toString("utf8")).slice(-LOG_BYTES); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.on("exit", (code, signal) => { record.exited = code ?? signal ?? "exited"; });
    session.processes.set(record.pid, record);
    // Give the app a moment to map its first window.
    let appeared: Array<{ id: string; title: string }> = [];
    for (let i = 0; i < 30 && !appeared.length && record.exited === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      appeared = (await windows(session).catch(() => [])).filter((w) => !before.has(w.id));
    }
    return { session: session.id, pid: record.pid, ...(appeared.length ? { windows: appeared } : { note: record.exited !== undefined ? `Process exited (${record.exited}); read logs.` : "No new window yet; use wait or screenshot." }) };
  }

  async function windows(session: DesktopSession) {
    const ids = (await x(session, ["search", "--onlyvisible", "--name", "."]).catch(() => "")).split("\n").filter(Boolean).slice(0, 30);
    const out: Array<{ id: string; title: string; x: number; y: number; width: number; height: number }> = [];
    for (const id of ids) {
      try {
        const title = (await x(session, ["getwindowname", id])).trim().slice(0, 200);
        const geometry = Object.fromEntries((await x(session, ["getwindowgeometry", "--shell", id])).split("\n").filter(Boolean).map((line) => line.split("=")));
        const w = Number(geometry.WIDTH), h = Number(geometry.HEIGHT);
        if (w > 1 && h > 1) out.push({ id, title, x: Number(geometry.X), y: Number(geometry.Y), width: w, height: h });
      } catch { /* windows can close between search and inspection */ }
    }
    return out;
  }

  async function screenshot(params: { session: string; region?: { x: number; y: number; width: number; height: number } }) {
    const session = get(params.session);
    const file = path.join(session.dir, `shot-${String(++session.shots).padStart(3, "0")}.png`);
    const crop = params.region ? `crop=${number(params.region.width, 8, session.width, "region.width")}:${number(params.region.height, 8, session.height, "region.height")}:${number(params.region.x, 0, session.width - 8, "region.x")}:${number(params.region.y, 0, session.height - 8, "region.y")}` : undefined;
    await new Promise<void>((resolve, reject) => {
      const grab = spawn("xwd", ["-root", "-silent", "-display", session.display], { stdio: ["ignore", "pipe", "ignore"] });
      const encode = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "pipe,file", "-f", "xwd_pipe", "-i", "pipe:0", "-frames:v", "1", ...(crop ? ["-vf", crop] : []), "-y", file], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "", settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        grab.stdout!.unpipe(encode.stdin!);
        grab.kill("SIGKILL");
        if (error) { encode.kill("SIGKILL"); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Screenshot timed out")), 15_000);
      grab.on("error", finish); encode.on("error", finish);
      grab.stdout!.on("error", finish); encode.stdin!.on("error", finish);
      encode.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-LOG_BYTES); });
      grab.stdout!.pipe(encode.stdin!);
      grab.on("close", (code) => { if (code !== 0) finish(new Error(`Screenshot capture failed (${code})`)); });
      encode.on("close", (code) => finish(code === 0 ? undefined : new Error(`Screenshot failed: ${stderr.slice(-300)}`)));
    });
    return { session: session.id, path: file, windows: await windows(session) };
  }

  async function input(params: any) {
    const session = get(params.session);
    const within = (value: unknown, limit: number, name: string) => number(value, 0, limit - 1, name);
    switch (params.action) {
      case "click": {
        const button = params.button === "right" ? "3" : params.button === "middle" ? "2" : "1";
        await x(session, ["mousemove", "--sync", String(within(params.x, session.width, "x")), String(within(params.y, session.height, "y")), "click", ...(params.double ? ["--repeat", "2", "--delay", "80"] : []), button]);
        return { clicked: [params.x, params.y], button: params.button ?? "left" };
      }
      case "move": await x(session, ["mousemove", "--sync", String(within(params.x, session.width, "x")), String(within(params.y, session.height, "y"))]); return { moved: [params.x, params.y] };
      case "drag":
        await x(session, ["mousemove", "--sync", String(within(params.x, session.width, "x")), String(within(params.y, session.height, "y")), "mousedown", "1", "mousemove", "--sync", String(within(params.toX, session.width, "toX")), String(within(params.toY, session.height, "toY")), "mouseup", "1"]);
        return { dragged: [params.x, params.y, params.toX, params.toY] };
      case "scroll": {
        const amount = number(params.amount ?? 3, 1, 30, "amount");
        await x(session, ["click", "--repeat", String(amount), "--delay", "30", params.direction === "up" ? "4" : "5"]);
        return { scrolled: params.direction === "up" ? "up" : "down", amount };
      }
      case "type": {
        if (typeof params.text !== "string" || !params.text || params.text.length > 2000) throw new Error("text must be 1..2000 characters");
        await x(session, ["type", "--delay", "12", "--", params.text], 60_000);
        return { typed: params.text.length };
      }
      case "key": {
        const keys = typeof params.keys === "string" ? params.keys.trim().split(/\s+/) : [];
        if (!keys.length || keys.length > 10 || keys.some((k: string) => !/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(k))) throw new Error('keys must be xdotool key names such as "Return", "ctrl+s" or "alt+F4 Return"');
        await x(session, ["key", "--delay", "40", "--", ...keys]);
        return { pressed: keys };
      }
      case "focus": {
        if (typeof params.window !== "string" || !/^\d{1,12}$/.test(params.window)) throw new Error("window must be an id from windows");
        await x(session, ["windowfocus", "--sync", params.window]);
        await x(session, ["windowraise", params.window]).catch(() => "");
        return { focused: params.window };
      }
    }
    throw new Error("Unknown input action");
  }

  async function wait(params: { session: string; title?: string; timeoutMs?: number }) {
    const session = get(params.session);
    const timeout = params.timeoutMs === undefined ? 10_000 : number(params.timeoutMs, 100, 60_000, "timeoutMs");
    const needle = (params.title ?? "").toLowerCase();
    const until = now() + timeout;
    while (now() <= until) {
      const found = (await windows(session)).filter((w) => !needle || w.title.toLowerCase().includes(needle));
      if (found.length) return { session: session.id, windows: found };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { session: session.id, windows: [], timedOut: true, note: `No window${needle ? ` titled like "${params.title}"` : ""} within ${timeout} ms; check logs.` };
  }

  function logs(params: { session: string; pid?: number }) {
    const session = get(params.session);
    return { session: session.id, processes: [...session.processes.values()].filter((p) => params.pid === undefined || p.pid === params.pid).map((p) => ({ pid: p.pid, command: p.command, running: p.exited === undefined, ...(p.exited !== undefined ? { exit: p.exited } : {}), output: p.output.slice(-4000) })) };
  }

  async function stop(id: string) {
    const session = sessions.get(id);
    if (!session) return { stopped: false };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    pendingStops.add(done);
    try {
      sessions.delete(id);
      for (const proc of session.processes.values()) if (proc.exited === undefined) { try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already gone */ } }
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const proc of session.processes.values()) if (proc.exited === undefined) { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ } }
      try { process.kill(-session.xvfb.pid!, "SIGKILL"); } catch { try { session.xvfb.kill("SIGKILL"); } catch { /* gone */ } }
      return { stopped: true, session: id, screenshots: session.dir };
    } finally { pendingStops.delete(done); finish(); }
  }
  const list = () => ({ sessions: [...sessions.values()].map((s) => ({ session: s.id, display: s.display, size: `${s.width}x${s.height}`, processes: [...s.processes.values()].filter((p) => p.exited === undefined).length, idleSeconds: Math.round((now() - s.lastUsed) / 1000) })) });
  const stopAll = () => {
    if (stopAllPromise) return stopAllPromise;
    shutdownEpoch++;
    stopAllPromise = (async () => {
      const pending = [...pendingStarts];
      for (const [controller] of pending) controller.abort();
      await Promise.all(pending.map(([, done]) => done));
      for (const id of [...sessions.keys()]) await stop(id);
      await Promise.all(pendingStops);
    })().finally(() => { stopAllPromise = undefined; });
    return stopAllPromise;
  };
  return { start, launch, screenshot, input, wait, logs, stop, list, stopAll, windows: (id: string) => windows(get(id)), sessions };
}
