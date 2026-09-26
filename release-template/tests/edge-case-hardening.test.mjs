import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Isolate home/agent state BEFORE dynamic imports compute their directories.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edge-hardening-"));
process.env.HOME = path.join(scratchRoot, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(scratchRoot, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
delete process.env.PI_CHECKPOINTS;
delete process.env.PI_SUBAGENTS_ECONOMY_CONFIG;

const template = path.resolve(import.meta.dirname, "..");
const agent = [path.join(template, "agent"), path.resolve(template, "..")].find(
  (p) => fs.existsSync(path.join(p, "extensions/lib/session-signals.ts")),
);
assert.ok(agent, "agent tree is present");
const coreRoot = [path.join(template, "core"), path.join(template, "..", "core")].find(
  (p) => fs.existsSync(path.join(p, "coding-agent/src/core/skills.js")),
);
assert.ok(coreRoot, "core tree is present");

// Same SDK resolution as session-signals-diagnostics.test.mjs.
let coreUrl;
try {
  coreUrl = import.meta.resolve("@yunuspi/coding-agent");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  coreUrl = pathToFileURL(
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@yunuspi/coding-agent/dist/index.js",
    ),
  ).href;
}
register(
  `data:text/javascript,${encodeURIComponent(
    `const core=${JSON.stringify(coreUrl)};export function resolve(name,context,next){if(name==="@yunuspi/coding-agent")return {url:core,shortCircuit:true};return next(name,name==="@yunuspi/ai"?{...context,parentURL:core}:context);}`,
  )}`,
  import.meta.url,
);

const url = (p) => pathToFileURL(p).href;
const { HarnessEventBus } = await import(url(path.join(coreRoot, "agent/src/harness/events.js")));
const { loadSkillsFromDir } = await import(url(path.join(coreRoot, "coding-agent/src/core/skills.js")));
const checkpoints = await import(url(path.join(agent, "extensions/checkpoints.ts")));
const { default: registerSignals } = await import(url(path.join(agent, "extensions/session-signals.ts")));
const { default: registerReminders } = await import(url(path.join(agent, "extensions/reminders.ts")));
const { default: registerSiblings } = await import(url(path.join(agent, "extensions/siblings.ts")));
const { default: registerSessionHooks } = await import(url(path.join(agent, "extensions/session-hooks.ts")));
const { normalizeState } = await import(url(path.join(agent, "extensions/context-profile.ts")));
const economy = await import(url(path.join(agent, "extensions/pi-subagents/src/runs/shared/model-economy.ts")));
const history = await import(url(path.join(agent, "extensions/pi-subagents/src/runs/shared/run-history.ts")));
const { evaluateRoute } = await import(
  url(path.join(agent, "extensions/pi-subagents/src/runs/shared/provider-health.ts"))
);
const memory = await import(url(path.join(agent, "extensions/pi-memory/index.ts")));
const { CONTINUATION_SOURCES } = await import(url(path.join(agent, "extensions/lib/continuation-notice.ts")));

/** Minimal extension host: multi-handler events, captured tools/messages. */
function stubPi() {
  const hooks = new Map();
  return {
    hooks,
    sent: [],
    tools: new Map(),
    commands: new Map(),
    on(name, handler) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
    },
    async emit(name, event, ctx) {
      for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
    },
    registerTool(tool) {
      this.tools.set(tool.name, tool);
    },
    registerCommand(name, cmd) {
      this.commands.set(name, cmd);
    },
    async sendMessage(...args) {
      this.sent.push(args);
    },
    getActiveTools() {
      return [];
    },
    appendEntry() {},
  };
}

test("harness bus reports handler_error with no subscribers, stays silent otherwise", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const bus = new HarnessEventBus();
    await bus.emit({
      type: "handler_error",
      kind: "hook",
      hook: "before_tool",
      lane: "main",
      error: "boom",
      stack: "trace",
    });
    assert.match(logged.join("\n"), /before_tool/);
    assert.match(logged.join("\n"), /boom/);
    logged.length = 0;
    const observed = new HarnessEventBus();
    observed.on("handler_error", () => {});
    await observed.emit({ type: "handler_error", kind: "event", event: "turn_start", error: "x" });
    assert.equal(logged.length, 0);
  } finally {
    console.error = original;
  }
});

test("skill scan reports unreadable directories and keeps collected skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-edge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "ok"));
  fs.writeFileSync(path.join(root, "ok", "SKILL.md"), "---\ndescription: ok skill for edge test\n---\n\n# ok\n");
  const fileAsDir = path.join(root, "not-a-dir.md");
  fs.writeFileSync(fileAsDir, "# plain\n");
  const bad = loadSkillsFromDir({ dir: fileAsDir, source: "test" });
  assert.equal(bad.skills.length, 0);
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(bad.diagnostics[0].type, "warning");
  assert.equal(bad.diagnostics[0].path, fileAsDir);
  const good = loadSkillsFromDir({ dir: root, source: "test" });
  assert.ok(good.skills.some((s) => s.name === "ok"));
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // chmod unenforceable as root
  const locked = path.join(root, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "SKILL.md"), "---\ndescription: locked\n---\n");
  fs.chmodSync(locked, 0o000);
  try {
    const res = loadSkillsFromDir({ dir: root, source: "test" });
    assert.ok(res.skills.some((s) => s.name === "ok"), "readable sibling survives");
    assert.ok(res.diagnostics.length >= 1, "failure is reported");
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test("sibling scan failure reports truncation instead of empty peers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sib-edge-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sib-cwd-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "active"), "block the scan");
  const pi = stubPi();
  registerSiblings(pi, { directory: dir });
  const tool = pi.tools.get("session_coordinate");
  assert.ok(tool, "session_coordinate is registered");
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => "edge-sib",
      getSessionFile: () => path.join(cwd, "s.json"),
    },
  };
  const res = await tool.execute("id1", {}, undefined, undefined, ctx);
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.details.peers, []);
  assert.equal(res.details.truncated, true);
});

test("healthy sibling scan reports no truncation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sib-ok-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sib-ok-cwd-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const pi = stubPi();
  registerSiblings(pi, { directory: dir });
  const tool = pi.tools.get("session_coordinate");
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => "edge-sib-ok",
      getSessionFile: () => path.join(cwd, "s.json"),
    },
  };
  const res = await tool.execute("id1", {}, undefined, undefined, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.details.truncated, false);
});

test("a native child run never lists its own orchestrator as an independent sibling", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sib-child-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sib-child-cwd-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const parentSid = "01a0aaaa-0000-7000-8000-000000000001";
  const parentFile = path.join(cwd, "sessions", `2026-09-26T05-40-13-572Z_${parentSid}.jsonl`);
  const session = (sid, file) => ({ cwd, sessionManager: { getSessionId: () => sid, getSessionFile: () => file } });
  const parentPi = stubPi(), childPi = stubPi(), otherPi = stubPi();
  registerSiblings(parentPi, { directory: dir });
  registerSiblings(childPi, { directory: dir });
  registerSiblings(otherPi, { directory: dir });
  await parentPi.tools.get("session_coordinate").execute("p", {}, undefined, undefined, session(parentSid, parentFile));
  await otherPi.tools.get("session_coordinate").execute("o", {}, undefined, undefined, session("01a0cccc-0000-7000-8000-000000000003", path.join(cwd, "sessions", "other.jsonl")));
  // Native child layout: <parent-session-dir>/<runId>/run-N/session.jsonl
  const childFile = path.join(cwd, "sessions", `2026-09-26T05-40-13-572Z_${parentSid}`, "b4067521-f6d1-421d-9b57-f976284c3cb0", "run-0", "session.jsonl");
  const res = await childPi.tools.get("session_coordinate").execute("c", {}, undefined, undefined, session("01a0bbbb-0000-7000-8000-000000000002", childFile));
  const peers = res.details.peers.map((peer) => peer.sid ?? peer.sessionId ?? peer);
  assert.ok(!JSON.stringify(peers).includes(parentSid), "the orchestrator is the child's parent, not a sibling");
  assert.ok(JSON.stringify(peers).includes("01a0cccc"), "a genuinely independent root stays visible");
});

test("checkpoint state distinguishes missing, corrupt, and round-tripped storage", () => {
  const { readState, writeState, defaultState } = checkpoints;
  const missing = readState("edge-missing-sid");
  assert.deepEqual(missing, defaultState("edge-missing-sid"));
  const stateDir = path.join(process.env.HOME, ".pi", "checkpoints");
  const shadowsBefore = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).filter((n) => n.startsWith("shadow-"))
    : [];
  assert.equal(shadowsBefore.length, 0, "a missing file leaves no trace");
  writeState({ ...defaultState("edge-rt"), verifyStrikes: 1 });
  assert.equal(readState("edge-rt").verifyStrikes, 1);
  fs.writeFileSync(path.join(stateDir, "state-edge-rt.json"), "{nope");
  assert.deepEqual(readState("edge-rt"), defaultState("edge-rt"));
  const shadows = fs.readdirSync(stateDir).filter((n) => n.startsWith("shadow-"));
  assert.equal(shadows.length, 1);
  assert.match(fs.readFileSync(path.join(stateDir, shadows[0]), "utf8"), /state-corrupt/);
});

test("checkpoint write failure warns once without throwing", (t) => {
  const dotpi = path.join(process.env.HOME, ".pi");
  fs.rmSync(dotpi, { recursive: true, force: true });
  fs.writeFileSync(dotpi, "block");
  t.after(() => fs.rmSync(dotpi, { force: true }));
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const { writeState, defaultState, readState } = checkpoints;
    writeState(defaultState("edge-ro"));
    writeState(defaultState("edge-ro"));
    assert.equal(
      warned.filter((w) => w.includes("[checkpoints]")).length,
      1,
      "one throttled warning for repeated failures",
    );
    assert.deepEqual(readState("edge-ro"), defaultState("edge-ro"));
  } finally {
    console.warn = original;
  }
});

test("signal terminate tracking tolerates missing results and resets on switch", async () => {
  const pi = stubPi();
  registerSignals(pi);
  await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "read" });
  const ctx = {
    model: { provider: "fixture", id: "w", contextWindow: 1_000_000, maxTokens: 4096 },
    getContextUsage: () => ({ tokens: 900_000 }),
    cwd: "/fixture",
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "edge-sig",
      getHeader: () => undefined,
    },
  };
  await pi.emit("tool_execution_end", { toolCallId: "t9", toolName: "bash", result: { terminate: true } });
  await pi.emit(
    "turn_end",
    { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolCallId: "t9" }] },
    ctx,
  );
  assert.equal(pi.sent.length, 0, "terminating-only turn stays silent");
  await pi.emit("session_switch", {});
  await pi.emit(
    "turn_end",
    { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolCallId: "t9" }] },
    ctx,
  );
  assert.equal(pi.sent.length, 1, "switch clears terminating tools so the pressure notice fires");
});

test("reminder terminate tracking tolerates missing results", async () => {
  const pi = stubPi();
  registerReminders(pi);
  await pi.emit("tool_execution_end", { toolCallId: "t1", toolName: "read" });
  await pi.emit("tool_execution_end", { toolCallId: "t2", toolName: "bash", result: { terminate: true } });
  await pi.emit("turn_start", {});
});

test("economy config fails closed to last-good on corrupt files", (t) => {
  const {
    loadModelEconomyConfig,
    clearModelEconomyConfigCache,
    lastModelEconomyConfigError,
    ECONOMY_CONFIG_ENV,
  } = economy;
  const file = path.join(scratchRoot, "economy.json");
  process.env[ECONOMY_CONFIG_ENV] = file;
  t.after(() => {
    delete process.env[ECONOMY_CONFIG_ENV];
    clearModelEconomyConfigCache();
    try {
      fs.unlinkSync(file);
    } catch {}
  });
  fs.writeFileSync(file, "{corrupt");
  clearModelEconomyConfigCache();
  const first = loadModelEconomyConfig();
  assert.equal(first.maxInputPerMillion, 50, "first load falls back to defaults");
  assert.ok(lastModelEconomyConfigError(), "failure is flagged");
  fs.writeFileSync(file, JSON.stringify({ maxInputPerMillion: 1, maxOutputPerMillion: 2 }));
  clearModelEconomyConfigCache();
  assert.equal(loadModelEconomyConfig().maxInputPerMillion, 1);
  assert.equal(lastModelEconomyConfigError(), undefined, "recovery clears the flag");
  fs.writeFileSync(file, "{corrupt again");
  // No cache clear: production keeps the cached config across the file
  // change (the size/mtime stamp differs), which is what last-good needs.
  const held = loadModelEconomyConfig();
  assert.equal(held.maxInputPerMillion, 1, "keeps last-good ceilings");
  assert.equal(held.maxOutputPerMillion, 2);
  assert.equal(lastModelEconomyConfigError()?.filePath, file);
  fs.writeFileSync(file, JSON.stringify({ maxInputPerMillion: "cheap" }));
  clearModelEconomyConfigCache();
  assert.throws(() => loadModelEconomyConfig(), /positive finite number/, "invalid values still throw");
});

test("memory recall failure is flagged distinctly from empty results", async (t) => {
  const {
    searchRelevantMemories,
    lastMemoryRecallError,
    _setExecFileForTest,
    _resetExecFileForTest,
    _setQmdAvailable,
  } = memory;
  _setQmdAvailable(true);
  t.after(() => {
    _resetExecFileForTest();
    _setQmdAvailable(false);
  });
  _setExecFileForTest((bin, args, opts, cb) => {
    if (args[0] === "collection") {
      cb(null, JSON.stringify(["pi-memory"]), "");
      return {};
    }
    cb(new Error("qmd exploded"), "", "");
    return {};
  });
  assert.equal(await searchRelevantMemories("hello world"), "");
  const flagged = lastMemoryRecallError();
  assert.ok(flagged && flagged.reason.includes("qmd exploded"));
  _setExecFileForTest((bin, args, opts, cb) => {
    if (args[0] === "collection") {
      cb(null, JSON.stringify(["pi-memory"]), "");
      return {};
    }
    cb(null, JSON.stringify([{ path: "mem.md", content: "recall works" }]), "");
    return {};
  });
  assert.match(await searchRelevantMemories("hello world"), /recall works/);
  assert.equal(lastMemoryRecallError(), null, "success clears the flag");
});

test("run history flags storage faults and cools timed-out routes", (t) => {
  const { recordRun, loadRunsForAgent, lastRunHistoryError } = history;
  recordRun("edge-agent", "task one", 0, 1000, {});
  assert.equal(loadRunsForAgent("edge-agent").length, 1);
  assert.equal(lastRunHistoryError(), undefined);
  recordRun("edge-agent", "slow task", 1, 300_000, { timedOut: true, model: "edgeprov/edge-model" });
  const decision = evaluateRoute({ provider: "edgeprov", model: "edge-model" });
  assert.equal(decision.allowed, false, "timed-out route cools");
  assert.equal(decision.kind, "route-failure");
  assert.ok(decision.waitMs > 0);
  const brokenDir = path.join(scratchRoot, "broken-agent");
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.mkdirSync(path.join(brokenDir, "run-history.jsonl"));
  process.env.PI_CODING_AGENT_DIR = brokenDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = path.join(scratchRoot, "agent");
  });
  assert.deepEqual(loadRunsForAgent("edge-agent"), []);
  assert.equal(lastRunHistoryError()?.op, "load");
  process.env.PI_CODING_AGENT_DIR = path.join(scratchRoot, "agent");
  assert.equal(loadRunsForAgent("edge-agent").length, 2);
  assert.equal(lastRunHistoryError(), undefined, "success clears the flag");
});

test("context profile normalizes corrupt disk state", () => {
  const state = {
    v: 1,
    session: 42,
    updatedAt: null,
    seq: -3,
    lastAt: "soon",
    digests: "nope",
    records: [null, "x", { seq: 1 }],
    totals: null,
    tools: 7,
    pending: 0,
  };
  normalizeState(state, "edge-sid");
  assert.equal(state.session, "edge-sid");
  assert.equal(state.seq, 0);
  assert.equal(state.lastAt, null);
  assert.deepEqual(state.digests, []);
  assert.deepEqual(state.records, [{ seq: 1 }]);
  assert.deepEqual(state.totals, {
    requests: 0,
    breaks: 0,
    envelopeBreaks: 0,
    resentChars: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(state.tools, null);
  assert.equal(state.pending, null);
  assert.equal(typeof state.session.slice(0, 24), "string");
  const big = { session: "s", records: Array.from({ length: 100 }, (_, i) => ({ seq: i })) };
  normalizeState(big, "s");
  assert.equal(big.records.length, 30, "ring stays bounded");
});

test("session switch starts a fresh heuristic window", async () => {
  const pi = stubPi();
  checkpoints.default(pi);
  const mkctx = (sid) => ({
    cwd: process.env.HOME,
    sessionManager: { getSessionId: () => sid, getBranch: () => [] },
  });
  await pi.emit("session_start", {}, mkctx("edge-win-a"));
  checkpoints.writeState({ ...checkpoints.defaultState("edge-win-a"), verifyStrikes: 5 });
  await pi.emit("session_switch", {}, mkctx("edge-win-b"));
  const fileB = path.join(process.env.HOME, ".pi", "checkpoints", "state-edge-win-b.json");
  assert.ok(fs.existsSync(fileB), "switch persists a fresh window for the new session");
  assert.deepEqual(JSON.parse(fs.readFileSync(fileB, "utf8")), checkpoints.defaultState("edge-win-b"));
});

test("repeat deploys keep a single continuation source", async (t) => {
  const pi = stubPi();
  registerSessionHooks(pi);
  t.after(() => pi.emit("session_shutdown", {}));
  const deploy = { toolName: "bash", input: { command: "git push prod" } };
  await pi.emit("tool_call", { ...deploy, toolCallId: "d1" });
  await pi.emit(
    "tool_result",
    { toolCallId: "d1", toolName: "bash", isError: false, content: [] },
    { sessionManager: { id: 1 } },
  );
  await pi.emit("tool_call", { ...deploy, toolCallId: "d2" });
  await pi.emit(
    "tool_result",
    { toolCallId: "d2", toolName: "bash", isError: false, content: [] },
    { sessionManager: { id: 2 } },
  );
  const list = globalThis[CONTINUATION_SOURCES] ?? [];
  assert.equal(
    list.filter((s) => s.name === "deploy").length,
    1,
    "the previous deploy notice is disposed before re-registering",
  );
});
