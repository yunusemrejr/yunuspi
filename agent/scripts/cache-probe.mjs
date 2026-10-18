#!/usr/bin/env node
/**
 * Cache probe — measure what the harness puts at the front of every model request.
 *
 * Provider prefix caches (DeepSeek, OpenAI, Gemini, GLM, Qwen, ...) only hit when
 * a request starts with the bytes of the previous one. This probe runs the real
 * harness (RPC mode, the installed extensions) against a local OpenAI-compatible
 * fake provider that records every request body and simulates a prefix cache, then
 * reports, between consecutive requests, whether the tool schemas, the system
 * prompt and the earlier messages stayed byte-identical.
 *
 * Nothing leaves the machine and no real credentials are used: the agent directory
 * is a throwaway copy (only the immutable runtime code is shared by symlink), the
 * provider is `fakeds`, Jev and the network are off, and every environment variable
 * that looks like a key, token or secret is dropped from the child.
 *
 *   node agent/scripts/cache-probe.mjs                      # probe the installed harness
 *   node agent/scripts/cache-probe.mjs --repo <checkout>    # overlay a checkout's extensions
 *   node agent/scripts/cache-probe.mjs --scenario ui        # core-tier / UI work instead
 *   node agent/scripts/cache-probe.mjs --keep               # keep the work directory
 *
 * Exit status 1 means the wire shrank, a head change followed an unchanged prompt,
 * or a request rewrote earlier messages. Run it under a memory cap on a shared box:
 *   systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0 node agent/scripts/cache-probe.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const baseAgent = path.resolve(option("agent", process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")));
const repo = option("repo") ? path.resolve(option("repo")) : undefined;
const scenarioName = option("scenario", "basic");
const port = Number(option("port", 18000 + (process.pid % 1000)));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-cache-probe-"));
const stage = path.join(work, "agent");
// Not a credential: the fake provider accepts any value.
const placeholderKey = "probe-placeholder";
const project = path.join(work, "project");
const capture = path.join(work, "requests");

// ── scenario: scripted tool turns keyed by a TASKn marker in the user prompt ────────────────────────────────
const P = (rel) => path.join(project, rel);
const turns = {
  1: [
    { name: "bash", args: { command: "ls -la && cat package.json" } },
    { name: "read", args: { path: P("docs/notes.md") } },
    { name: "read", args: { path: P("src/math.js") } },
    { name: "grep", args: { pattern: "add", path: project } },
    { name: "bash", args: { command: "node --test 2>&1 | tail -30" } },
    { name: "edit", args: { path: P("src/math.js"), edits: [{ oldText: "return a - b;", newText: "return a + b;" }] } },
    { name: "bash", args: { command: "node --test 2>&1 | tail -30" } },
  ],
  2: [
    { name: "read", args: { path: P("src/math.js") } },
    { name: "write", args: { path: P("src/sub.js"), content: "export function sub(a, b) {\n  return a - b;\n}\n" } },
    { name: "bash", args: { command: "node --test 2>&1 | tail -30" } },
  ],
  3: [
    { name: "bash", args: { command: "git status --short && git diff | head -40" } },
    { name: "read", args: { path: P("src/sub.js") } },
  ],
  4: [
    { name: "read", args: { path: P("src/math.js") } },
    { name: "write", args: { path: P("index.html"), content: "<!doctype html><html><head><meta charset=utf-8><title>Home</title><link rel=stylesheet href=styles.css></head><body><h1>Welcome</h1></body></html>\n" } },
    { name: "write", args: { path: P("styles.css"), content: "body{font-family:sans-serif;margin:0;padding:2rem}\n" } },
    { name: "edit", args: { path: P("styles.css"), edits: [{ oldText: "margin:0", newText: "margin:1rem" }] } },
    { name: "bash", args: { command: "cat styles.css" } },
  ],
};
const scenarios = {
  // A small direct-tier fix, a follow-up feature, then a request that names the web.
  basic: [
    "TASK1: The add function in src/math.js is wrong and the tests fail. Fix it and verify with the tests.",
    "TASK2: Now add a sub function in src/sub.js with its own test.",
    "TASK3: Show git status and the diff.",
  ],
  // Interface work stages the larger studio wire from the first turn.
  ui: [
    "TASK4: Redesign the landing page UI of this website: improve the layout, typography and colors and make the hero section look polished and modern.",
    "TASK2: Now add a sub function in src/sub.js with its own test.",
  ],
};
if (!scenarios[scenarioName]) throw new Error(`Unknown scenario ${scenarioName}; use ${Object.keys(scenarios).join(", ")}`);

// ── fake provider with a simulated prefix cache ─────────────────────────────────────────────────────────────
fs.mkdirSync(capture, { recursive: true });
let requestCount = 0;
let previousRendered = "";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const id = ++requestCount;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* recorded as empty */ }
    fs.writeFileSync(path.join(capture, `req-${String(id).padStart(3, "0")}.json`), JSON.stringify(body));
    const messages = body.messages ?? [];
    const hasTools = (body.tools ?? []).length > 0;
    let task = 0, taskIndex = -1;
    messages.forEach((m, i) => {
      if (m.role !== "user") return;
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const hit = text.match(/TASK(\d)/);
      if (hit && Number(hit[1]) > task) { task = Number(hit[1]); taskIndex = i; }
    });
    const done = messages.slice(taskIndex + 1).filter((m) => m.role === "tool").length;
    const call = id < 120 && hasTools && turns[task]?.[done];
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `probe-${id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "deepseek-flash" };
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { reasoning_content: `Considering step ${id}. ` }, finish_reason: null }] });
    if (call) {
      send({ ...base, choices: [{ index: 0, delta: { content: `Step ${id}.` }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { content: hasTools ? `Task ${task} complete.` : "OK." }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    // Render system, tools, then the rest: the order in which chat templates lay out a request.
    const rendered = JSON.stringify(messages[0] ?? "") + JSON.stringify(body.tools ?? []) + JSON.stringify(messages.slice(1));
    let shared = 0;
    const limit = Math.min(previousRendered.length, rendered.length);
    while (shared < limit && previousRendered[shared] === rendered[shared]) shared++;
    previousRendered = rendered;
    const prompt = Math.ceil(rendered.length / 4), hit = Math.floor(shared / 4 / 64) * 64;
    send({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: 40, total_tokens: prompt + 40, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: prompt - hit } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

// ── isolated agent directory and project ────────────────────────────────────────────────────────────────────
function stageAgent() {
  fs.mkdirSync(stage, { recursive: true });
  for (const dir of ["extensions", "skills", "scripts", "bin"]) fs.cpSync(path.join(baseAgent, dir), path.join(stage, dir), { recursive: true, dereference: false });
  fs.symlinkSync(path.join(baseAgent, "runtime"), path.join(stage, "runtime"));
  for (const file of ["AGENTS.md", "installation.json", "live-model-catalog.json", "models-store.json"]) {
    if (fs.existsSync(path.join(baseAgent, file))) fs.copyFileSync(path.join(baseAgent, file), path.join(stage, file));
  }
  if (repo) fs.cpSync(path.join(repo, "agent", "extensions"), path.join(stage, "extensions"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.endsWith(`${path.sep}dist`) });
  const settings = JSON.parse(fs.readFileSync(path.join(baseAgent, "settings.json"), "utf8"));
  settings.defaultProvider = "fakeds";
  settings.defaultModel = "deepseek-flash";
  fs.writeFileSync(path.join(stage, "settings.json"), JSON.stringify(settings, null, 1));
  fs.writeFileSync(path.join(stage, "models.json"), JSON.stringify({
    providers: { fakeds: {
      baseUrl: `http://127.0.0.1:${port}`, apiKey: placeholderKey, api: "openai-completions",
      models: [{ id: "deepseek-flash", name: "DeepSeek Flash (probe)", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000,
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true } }],
    } },
  }));
}

function makeProject() {
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "probe-project", version: "1.0.0", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(project, "src/math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  fs.writeFileSync(path.join(project, "test/math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
  // A deterministic ~40 KB note so the conversation is large enough for cache effects to matter.
  const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon".split(" ");
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  fs.writeFileSync(path.join(project, "docs/notes.md"), Array.from({ length: 900 }, () => Array.from({ length: 14 }, () => words[next() % words.length]).join(" ")).join("\n"));
  const git = (...a) => execFileSync("git", ["-c", "user.email=probe@example.invalid", "-c", "user.name=probe", ...a], { cwd: project, stdio: "ignore" });
  git("init", "-q", "."); git("add", "-A"); git("commit", "-qm", "init");
}

// ── drive the harness over RPC ──────────────────────────────────────────────────────────────────────────────
async function drive() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i.test(name)));
  Object.assign(env, { PI_CODING_AGENT_DIR: stage, PI_OFFLINE: "1", PI_JEV: "off", DEEPSEEK_API_KEY: placeholderKey });
  const bin = path.join(stage, "bin", "yunuspi");
  const launch = ["--mode", "rpc", "--no-session", "--provider", "fakeds", "--model", "deepseek-flash", "--thinking", "high"];
  const capped = process.platform === "linux" && !process.env.PI_PROBE_NO_CGROUP && (() => { try { execFileSync("systemd-run", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  const child = capped
    ? spawn("systemd-run", ["--user", "--scope", "--quiet", "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0", bin, ...launch], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(bin, launch, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let waiters = [];
  const log = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { const event = JSON.parse(line); log.push(event); waiters = waiters.filter((w) => !w(event)); } catch { /* not JSON */ }
    }
  });
  child.stderr.on("data", () => {});
  const wait = (predicate, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the harness")), ms);
    waiters.push((event) => (predicate(event) ? (clearTimeout(timer), resolve(event), true) : false));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(Number(process.env.PI_PROBE_BOOT_MS || 9000));
    for (const message of scenarios[scenarioName]) {
      const finished = wait((event) => event.type === "agent_end", 180_000);
      child.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
      await finished;
      await sleep(1500);
    }
  } finally {
    child.stdin.end();
    await sleep(500);
    child.kill("SIGTERM");
  }
}

// ── analysis ────────────────────────────────────────────────────────────────────────────────────────────────
const digest = (value) => crypto.createHash("sha1").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 10);
const toolNames = (body) => (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
const systemOf = (body) => {
  const m = (body.messages ?? []).find((x) => x.role === "system" || x.role === "developer");
  return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "";
};

function analyze() {
  const files = fs.readdirSync(capture).filter((f) => f.endsWith(".json")).sort();
  const requests = files.map((f) => ({ f, body: JSON.parse(fs.readFileSync(path.join(capture, f), "utf8")) }));
  // A run that never reached the provider proves nothing; refuse to call it a pass.
  if (requests.length < 2) throw new Error(`only ${requests.length} provider request(s) were captured; the harness did not run the scenario`);
  const findings = [];
  let unstableChars = 0, totalChars = 0;
  console.log(`requests captured: ${requests.length}; scenario: ${scenarioName}; first wire: ${toolNames(requests[0]?.body ?? {}).length} tools`);
  for (let i = 1; i < requests.length; i++) {
    const a = requests[i - 1].body, b = requests[i].body;
    const na = toolNames(a), nb = toolNames(b);
    const added = nb.filter((x) => !na.includes(x)), removed = na.filter((x) => !nb.includes(x));
    const sa = systemOf(a), sb = systemOf(b);
    const am = a.messages ?? [], bm = b.messages ?? [];
    let kept = 0;
    while (kept < am.length && kept < bm.length && digest(am[kept]) === digest(bm[kept])) kept++;
    // The harness ends each request with transient user-role notes that the next request drops; anything else that
    // fails to carry over (an assistant or tool message, or a user message with a transient note behind it) is a rewrite.
    const rewritten = am.slice(kept).some((m) => m.role !== "user");
    const prevChars = JSON.stringify(a).length;
    const keptChars = JSON.stringify(am.slice(0, kept)).length + (digest(a.tools ?? []) === digest(b.tools ?? []) ? JSON.stringify(a.tools ?? []).length : 0);
    totalChars += prevChars; unstableChars += prevChars - Math.min(prevChars, keptChars);
    const notes = [];
    if (added.length) notes.push(`wire +[${added.join(",")}]`);
    if (removed.length) { notes.push(`wire -[${removed.join(",")}]`); findings.push(`${requests[i].f}: tools removed (${removed.join(", ")})`); }
    if (sa !== sb) notes.push("system prompt changed");
    if (sa !== sb && !added.length && !removed.length) findings.push(`${requests[i].f}: system prompt changed with an identical tool set`);
    if (rewritten) { notes.push(`history rewritten at message ${kept} (${bm[kept]?.role})`); findings.push(`${requests[i].f}: earlier message ${kept} was rewritten`); }
    if (notes.length) console.log(`  ${requests[i].f}: ${notes.join("; ")}`);
  }
  const first = requests[0]?.body;
  if (first) {
    const listed = [...systemOf(first).matchAll(/^- ([a-z_][a-z0-9_]*): /gm)].map((m) => m[1]);
    const phantom = listed.filter((name) => !toolNames(first).includes(name));
    if (phantom.length) findings.push(`first request lists tools that are not on the wire: ${phantom.join(", ")}`);
  }
  console.log(`unstable share of previously sent text: ${(100 * unstableChars / Math.max(totalChars, 1)).toFixed(2)}%`);
  if (findings.length) { console.log("\nFINDINGS"); for (const f of findings) console.log(`  - ${f}`); }
  else console.log("\nNo wire shrink, no head change without a tool change, no rewritten history.");
  return findings.length;
}

let status = 0;
try {
  stageAgent();
  makeProject();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await drive();
  status = analyze() ? 1 : 0;
} catch (error) {
  console.error(`cache-probe failed: ${error.message}`);
  status = 2;
} finally {
  server.close();
  if (flag("keep")) console.log(`work directory kept: ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}
process.exit(status);
