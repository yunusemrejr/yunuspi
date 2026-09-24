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
    const launched = await manager.launch({ session: started.session, command: "xmessage -geometry 320x120+40+60 -buttons OK:0 'hello from the virtual display'", cwd: work });
    const waited = await manager.wait({ session: started.session, title: "xmessage", timeoutMs: 8000 });
    assert.ok(waited.windows.length >= 1, "the app window appears");
    const [win] = waited.windows;
    assert.ok(win.width >= 100 && win.height >= 40);
    const shot = await manager.screenshot({ session: started.session });
    assert.ok(fs.statSync(shot.path).size > 500);
    const crop = await manager.screenshot({ session: started.session, region: { x: win.x, y: win.y, width: win.width, height: win.height } });
    assert.ok(fs.statSync(crop.path).size > 200);
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
