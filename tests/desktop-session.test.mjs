import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find(candidate => fs.existsSync(path.join(candidate, "extensions/lib/desktop-session.ts")));
assert.ok(agentRoot, "desktop sessions ship with the distribution");
const desktop = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/desktop-session.ts")));
const register = (await import(pathToFileURL(path.join(agentRoot, "extensions/desktop-session.ts")))).default;
const available = desktop.desktopAvailability().ok && fs.existsSync("/usr/bin/xmessage");

test("a virtual display runs, shows and drives an X11 app, then cleans up", { skip: !available && "Xvfb, xdotool, xwd, ffmpeg and xmessage are required", timeout: 60_000 }, async () => {
  const manager = desktop.createDesktopManager();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-"));
  try {
    const started = await manager.start({ width: 640, height: 480 });
    assert.match(started.display, /^:\d+$/);
    await assert.rejects(manager.launch({ session: started.session, command: "true", cwd: path.join(work, "missing") }), /ENOENT/);
    assert.deepEqual(manager.logs({ session: started.session }).processes, [], "a failed spawn never registers an invalid PID");
    const launched = await manager.launch({ session: started.session, command: "xmessage -geometry 320x120+40+60 -buttons OK:0 'hello from the virtual display'", cwd: work });
    const waited = await manager.wait({ session: started.session, title: "xmessage", timeoutMs: 8000 });
    assert.ok(waited.windows.length >= 1, "the app window appears");
    const [win] = waited.windows;
    assert.ok(win.width >= 100 && win.height >= 40);
    const shot = await manager.screenshot({ session: started.session });
    assert.ok(fs.statSync(shot.path).size > 500);
    const crop = await manager.screenshot({ session: started.session, region: { x: win.x, y: win.y, width: win.width, height: win.height } });
    assert.ok(fs.statSync(crop.path).size > 200);
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = work;
      await assert.rejects(manager.screenshot({ session: started.session }), /ENOENT/);
    } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; }
    await manager.input({ action: "move", session: started.session, x: win.x + 10, y: win.y + 10 });
    await manager.input({ action: "key", session: started.session, keys: "Return" });
    await assert.rejects(manager.input({ action: "key", session: started.session, keys: "rm -rf /" }), /xdotool key names/);
    await assert.rejects(manager.input({ action: "click", session: started.session, x: 5000, y: 5 }), /x must be/);
    const logs = manager.logs({ session: started.session, pid: launched.pid });
    assert.equal(logs.processes[0].pid, launched.pid);
    const stopped = await manager.stop(started.session);
    assert.equal(stopped.stopped, true);
    assert.deepEqual(manager.list().sessions, []);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.throws(() => process.kill(launched.pid, 0), "launched processes die with the session");
    await assert.rejects(manager.screenshot({ session: started.session }), /Unknown desktop session/);
  } finally { await manager.stopAll(); fs.rmSync(work, { recursive: true, force: true }); }
});

test("launch commands get the same destructive-command review as bash, inside the workspace", async () => {
  const hooks = [];
  const safety = (await import(pathToFileURL(path.join(agentRoot, "extensions/filesystem-safety.ts")))).default;
  safety({ on: (name, handler) => { if (name === "tool_call") hooks.push(handler); }, registerTool() {}, registerCommand() {}, getActiveTools: () => [], appendEntry() {} });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-safety-"));
  try {
    const ctx = { cwd: work, hasUI: false, sessionManager: { getSessionId: () => "s" } };
    let blocked;
    for (const hook of hooks) { const verdict = await hook({ toolName: "desktop_session", input: { action: "launch", session: "x", command: "rm -rf /" } }, ctx); if (verdict?.block) blocked = verdict; }
    assert.ok(blocked, "a destructive launch is blocked before it runs");
    for (const hook of hooks) assert.equal((await hook({ toolName: "desktop_session", input: { action: "screenshot", session: "x" } }, ctx))?.block, undefined, "non-launch actions are not shell commands");
    const tools = new Map();
    register({ on() {}, registerTool: tool => tools.set(tool.name, tool) });
    await assert.rejects(tools.get("desktop_session").execute("t", { action: "launch", session: "none", command: "true", cwd: "/" }, undefined, undefined, { cwd: work }), /inside the workspace/);
    assert.deepEqual((await tools.get("desktop_session").execute("t", { action: "list" }, undefined, undefined, { cwd: work })).details, { sessions: [] });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test("dependency availability follows PATH and requires executable files", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-path-"));
  const prior = process.env.PATH;
  try {
    process.env.PATH = work;
    for (const binary of ["Xvfb", "xdotool", "xwd", "ffmpeg"])
      fs.writeFileSync(path.join(work, binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.deepEqual(desktop.desktopAvailability(), { ok: true, missing: [] });
    fs.chmodSync(path.join(work, "xwd"), 0o644);
    fs.unlinkSync(path.join(work, "ffmpeg"));
    fs.mkdirSync(path.join(work, "ffmpeg"));
    assert.deepEqual(desktop.desktopAvailability(), { ok: false, missing: ["xwd", "ffmpeg"] });
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("an unavailable interpreter rejects display startup without an uncaught spawn error", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-spawn-"));
  const prior = process.env.PATH;
  const manager = desktop.createDesktopManager();
  try {
    for (const binary of ["Xvfb", "xdotool", "xwd", "ffmpeg"])
      fs.writeFileSync(path.join(work, binary), "#!/missing-yunuspi-test-interpreter\n", { mode: 0o755 });
    process.env.PATH = work;
    assert.equal(desktop.desktopAvailability().ok, true);
    await assert.rejects(manager.start({}), /ENOENT/);
    assert.deepEqual(manager.list().sessions, []);
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    await manager.stopAll(); fs.rmSync(work, { recursive: true, force: true });
  }
});

test("stopAll cancels and drains an in-flight display startup", { timeout: 5000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pending-"));
  const prior = process.env.PATH;
  const manager = desktop.createDesktopManager();
  const pidFile = path.join(work, "pid");
  let pid;
  try {
    for (const binary of ["xdotool", "xwd", "ffmpeg"])
      fs.writeFileSync(path.join(work, binary), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(work, "Xvfb"), `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec /bin/sleep 20\n`, { mode: 0o755 });
    process.env.PATH = work;
    const rejected = assert.rejects(manager.start({}), /abort|stopped/i);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(pidFile), "the pending display process started");
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    await manager.stopAll();
    await rejected;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(manager.list().sessions, []);
    assert.throws(() => process.kill(pid, 0), "cancelled startup leaves no display process");
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    await manager.stopAll();
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("artifact creation failure cleans up the ready display process", { skip: !available, timeout: 10_000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-artifacts-"));
  const prior = process.env.PATH;
  const xvfb = (prior ?? "/usr/bin:/bin").split(path.delimiter).map(dir => path.resolve(dir || ".", "Xvfb")).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const pidFile = path.join(work, "pid");
  const manager = desktop.createDesktopManager({ artifactRoot: () => path.join(work, "missing") });
  let pid;
  try {
    fs.writeFileSync(path.join(work, "Xvfb"), `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec ${quote(xvfb)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${work}${path.delimiter}${prior ?? "/usr/bin:/bin"}`;
    await assert.rejects(manager.start({ width: 640, height: 480 }), /ENOENT/);
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(manager.list().sessions, []);
    assert.throws(() => process.kill(pid, 0), "failed startup kills its owned Xvfb");
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    await manager.stopAll();
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("concurrent starts use distinct owned displays and include pending sessions in the limit", { skip: !available, timeout: 15_000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-concurrent-"));
  const manager = desktop.createDesktopManager({ artifactRoot: () => work });
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 3 }, () => manager.start({ width: 640, height: 480 })));
    const started = outcomes.filter(result => result.status === "fulfilled").map(result => result.value);
    const rejected = outcomes.filter(result => result.status === "rejected");
    assert.equal(started.length, 2);
    assert.equal(new Set(started.map(result => result.display)).size, 2);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /At most 2 desktop sessions/);
    assert.equal(manager.list().sessions.length, 2);
  } finally { await manager.stopAll(); fs.rmSync(work, { recursive: true, force: true }); }
});

test("overlapping shutdown drains idle reaping and cancels the start waiting behind it", { skip: !available, timeout: 10_000 }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-reap-"));
  let now = 0;
  const manager = desktop.createDesktopManager({ now: () => now, artifactRoot: () => work });
  try {
    const initial = await manager.start({ width: 640, height: 480 });
    const pid = manager.sessions.get(initial.session).xvfb.pid;
    now = 21 * 60_000;
    const restarting = assert.rejects(manager.start({ width: 640, height: 480 }), /stopped during startup/);
    const first = manager.stopAll();
    const second = manager.stopAll();
    assert.equal(first, second, "overlapping shutdown calls share one drain");
    await first;
    await restarting;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(manager.list().sessions, []);
    assert.throws(() => process.kill(pid, 0), "shutdown drains the display already being reaped");
  } finally { await manager.stopAll(); fs.rmSync(work, { recursive: true, force: true }); }
});
