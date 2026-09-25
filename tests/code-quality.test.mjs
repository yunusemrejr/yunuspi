import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find(candidate => fs.existsSync(path.join(candidate, "extensions/lib/code-quality.ts")));
assert.ok(agentRoot, "code quality ships with the distribution");
const cq = await import(pathToFileURL(path.join(agentRoot, "extensions/lib/code-quality.ts")));
const { parserFor } = await import(pathToFileURL(path.join(agentRoot, "extensions/pi-lens/semantic-radar/extract.mjs")));
const registerSourceCheck = (await import(pathToFileURL(path.join(agentRoot, "extensions/lib/source-check.ts")))).default;
const registerTool = (await import(pathToFileURL(path.join(agentRoot, "extensions/code-quality.ts")))).default;

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "code-quality-"));
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

const ORIGINAL = `export function totalPrice(items, taxRate) {
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity <= 0) continue;
    subtotal += item.price * item.quantity;
  }
  const tax = subtotal * taxRate;
  return Math.round((subtotal + tax) * 100) / 100;
}
`;
const RENAMED = `export function orderTotal(lines, vat) {
  let sum = 0;
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    sum += line.price * line.quantity;
  }
  const extra = sum * vat;
  return Math.round((sum + extra) * 100) / 100;
}
`;

test("the lexer keeps regex literals, nested templates and comments apart", () => {
  const tokens = cq.tokenize("const a = `x ${c ? `y${b}` : {k: d}} z`; const r = /\\/\\*[a-z]/g; // tail(e)\nfoo(f); /* g(h) */", "c").map(t => t.text);
  assert.deepEqual(tokens, ["const", "a", "=", "`x ${c ? `y${b}` : {k: d}} z`", "c", "?", "`y${b}`", "b", ":", "{", "k", ":", "d", "}", ";", "const", "r", "=", "/\\/\\*[a-z]/g", ";", "foo", "(", "f", ")", ";"]);
  const division = cq.tokenize("x = a / b / c;", "c").map(t => t.text);
  assert.deepEqual(division, ["x", "=", "a", "/", "b", "/", "c", ";"]);
  const py = cq.tokenize('def f(x):\n    """doc with # and \'quote\'"""\n    return x  # note\n', "python").map(t => t.norm);
  assert.deepEqual(py, ["def", "$", "(", "$", ")", ":", '""', "return", "$"]);
});

test("renamed clones are found across files; data tables and lists are not clones", () => {
  const files = [{ path: "src/cart.js", source: ORIGINAL + "\nexport const x = 1;\n" }, { path: "src/orders.js", source: "// orders\n" + RENAMED }];
  const report = cq.findDuplicates(files, { minTokens: 40, minLines: 5 });
  assert.equal(report.clones.length, 1);
  const [clone] = report.clones;
  assert.equal(clone.kind, "renamed");
  assert.deepEqual([clone.a.path, clone.a.start, clone.b.path, clone.b.start], ["src/cart.js", 1, "src/orders.js", 2]);
  assert.ok(clone.renamed.includes("totalPrice→orderTotal") || clone.renamed.includes("subtotal→sum"), clone.renamed.join());
  assert.equal(cq.findDuplicates(files, { minTokens: 40, mode: "exact" }).clones.length, 0, "exact mode needs identical text");
  const table = Array.from({ length: 40 }, (_, i) => `  { id: "k${i}", label: "Label ${i}", weight: ${i}, enabled: true },`).join("\n");
  const data = [{ path: "a.ts", source: `export const A = [\n${table}\n];\n` }, { path: "b.ts", source: `export const B = [\n${table.replaceAll("Label", "Name")}\n];\n` }];
  assert.equal(cq.findDuplicates(data, { minTokens: 40 }).clones.length, 0, "declarative data is not logic duplication");
  const focused = cq.findDuplicates([...files, { path: "src/other.js", source: ORIGINAL.replace("totalPrice", "again") }], { minTokens: 40, focus: new Set(["src/orders.js"]) });
  assert.ok(focused.clones.every(c => c.a.path === "src/orders.js" || c.b.path === "src/orders.js"));
});

test("slop rules find placeholders, leftovers, swallowed errors and redundant logic but spare intentional code", () => {
  const source = [
    "export function load(id) {",
    "  // ... rest of the code remains the same",
    "  console.log('loading', id);",
    "  try { fetchIt(id); } catch (e) { console.error(e); }",
    "  const ok = id ? true : false;",
    "  if (ok == true) debugger;",
    "  // const old = compute(id);",
    "  // if (old) { return old; }",
    "  // return fallback(id);",
    "  throw new Error('Not implemented');",
    "}",
  ].join("\n");
  const rules = cq.codeSlop("src/load.js", source).map(f => f.rule);
  for (const rule of ["placeholder-elision", "debug-leftover", "swallowed-error", "redundant-boolean", "commented-out-code", "placeholder-implementation"]) assert.ok(rules.includes(rule), rule);
  assert.equal(cq.codeSlop("scripts/tool.js", "console.log('usage: tool <file>');").length, 0, "scripts print by design");
  assert.equal(cq.codeSlop("src/cli.js", "if (process.argv[2]) console.log('ok');").length, 0, "entry points print by design");
  assert.equal(cq.codeSlop("src/x.ts", "if (data.flag === true) run();\ntry { a(); } catch { /* best effort: cache only */ }").length, 0, "strict checks and documented catches are fine");
  assert.equal(cq.codeSlop("src/x.js", "/**\n * const a = b();\n * if (a) { c(); }\n * return a;\n */").length, 0, "JSDoc examples are not dead code");
  const py = cq.codeSlop("pkg/mod.py", "def f():\n    try:\n        g()\n    except Exception:\n        pass\n    breakpoint()\n").map(f => f.rule);
  assert.ok(py.includes("swallowed-error") && py.includes("debug-leftover"));
  const scoped = cq.codeSlop("src/load.js", source, [3, 3]).map(f => f.rule);
  assert.deepEqual(scoped, ["debug-leftover"], "a changed span limits findings");
});

test("unused imports use the token stream: spread, templates and interpolations count as uses", () => {
  const js = [
    "import { used, spread, templated, nested, unused } from './a.js';",
    "import Default, * as ns from './b.js';",
    "const x = [...spread];",
    "const y = `v: ${cond ? `${templated}` : { k: nested }}`;",
    "used(ns);",
  ].join("\n");
  assert.deepEqual(cq.unusedImports("m.js", js).map(f => f.message), ["`unused` is imported but never used.", "`Default` is imported but never used."]);
  assert.deepEqual(cq.unusedImports("m.py", "import os\nfrom typing import List, Dict\nx: List[int] = []\nprint(f'{os.sep}')\n").map(f => f.message), ["`Dict` is imported but never used."]);
  assert.deepEqual(cq.unusedImports("pkg/__init__.py", "from .a import b\n"), [], "package re-exports are intentional");
});

test("prose report flags stock phrases with replacements and measures readability", () => {
  const text = "# Introduction\n\nIn today's fast-paced world, our robust platform lets you seamlessly leverage cutting-edge tools. Let's dive in! We delve into the tapestry of features.\n\n```js\nconst robust = true; // code is ignored\n```\n\nThe tool reads files. It writes a report. You can run it daily.";
  const report = cq.proseReport(text);
  const phrases = report.phrases.map(p => p.phrase);
  for (const phrase of ["robust", "seamlessly", "leverage", "cutting-edge", "delve into", "tapestry"]) assert.ok(phrases.some(p => p.includes(phrase)), phrase);
  assert.equal(report.phrases.find(p => p.phrase === "robust").count, 1, "code blocks are skipped");
  assert.ok(report.findings.some(f => f.rule === "boilerplate-heading"));
  assert.ok(report.readingEase > 20 && report.readingEase < 110);
  assert.equal(cq.proseReport("The service stores each order in one table. Refunds reverse the charge within a day.").findings.length, 0);
});

test("prose report flags leakage phrases, meta headings and basis-free metrics", () => {
  const text = [
    "# How this site works",
    "",
    "Our next-generation platform is AI-powered and built for everyone.",
    "Take your workflow to the next level with our carefully curated toolkit.",
    "It runs 10x faster with military-grade privacy by design.",
  ].join("\n");
  const report = cq.proseReport(text);
  const rules = report.findings.map(f => f.rule);
  assert.ok(rules.includes("transparency-heading"));
  assert.ok(rules.includes("metric-without-basis"));
  const phrases = report.phrases.map(p => p.phrase);
  for (const phrase of ["next-generation", "ai-powered", "built for everyone", "take your workflow to the next level", "carefully curated", "military-grade", "privacy by design"]) assert.ok(phrases.some(p => p.includes(phrase)), phrase);
  // Basis nearby clears the metric; clean copy stays clean.
  assert.ok(!cq.proseReport("Our tool is 10x faster in tests measured on 400 teams.").findings.some(f => f.rule === "metric-without-basis"));
  assert.equal(cq.proseReport("The service stores each order in one table.").findings.length, 0);
});

test("complexity ranks functions with tree-sitter and flags async without await", async () => {
  const parser = await parserFor(".js");
  const branches = Array.from({ length: 14 }, (_, i) => `  if (x === ${i}) y += ${i};`).join("\n");
  const tree = parser.parse(`async function busy(x, a, b, c, d, e) {\n  let y = 0;\n${branches}\n  return y;\n}\nasync function lazy() { return 1; }\nconst fine = async () => { await work(); };\n`);
  const metrics = cq.functionMetrics(tree.rootNode);
  tree.delete();
  const busy = metrics.find(m => m.name === "busy");
  assert.equal(busy.cyclomatic, 15); assert.equal(busy.params, 6);
  const findings = cq.complexityFindings(metrics).map(f => f.message);
  assert.ok(findings.some(m => m.startsWith("busy: cyclomatic 15")));
  assert.ok(findings.some(m => m.startsWith("lazy is async but never awaits")) === false, "one-line functions are exempt");
  assert.ok(!findings.some(m => m.startsWith("fine")));
});

test("code_quality runs over trees and changed files, bounded and inside the workspace", async () => {
  const dir = workspace();
  try {
    write(dir, "src/cart.js", ORIGINAL);
    write(dir, "node_modules/lib/index.js", ORIGINAL);
    write(dir, "dist/bundle.min.js", ORIGINAL);
    write(dir, "README.md", "Our robust, seamless, cutting-edge tool helps you leverage data.\n".repeat(5));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
    write(dir, "src/orders.js", RENAMED);
    const all = await cq.codeQuality({ operation: "duplicates", minTokens: 40 }, dir, undefined, parserFor);
    assert.equal(all.scope.files, 2, "ignored and generated trees are skipped");
    assert.equal(all.clones.length, 1);
    const changed = await cq.codeQuality({ operation: "duplicates", changed: true, minTokens: 40 }, dir, undefined, parserFor);
    assert.equal(changed.scope.focus, 1); assert.equal(changed.clones.length, 1);
    const prose = await cq.codeQuality({ operation: "prose" }, dir, undefined, parserFor);
    assert.equal(prose.files[0].file, "README.md"); assert.ok(prose.files[0].phrases.length >= 3);
    const complexity = await cq.codeQuality({ operation: "complexity", paths: ["src"] }, dir, undefined, parserFor);
    assert.equal(complexity.scope.functions, 2);
    await assert.rejects(cq.codeQuality({ operation: "slop", paths: ["../"] }, dir), /escapes the workspace/);
    await assert.rejects(cq.codeQuality({ operation: "duplicates", changed: true, base: "--output=/tmp/x" }, dir), /not a valid revision/);
    const tools = [];
    registerTool({ registerTool: tool => tools.push(tool) });
    const result = await tools[0].execute("q", { operation: "slop", paths: ["src"] }, undefined, undefined, { cwd: dir });
    assert.equal(result.details.operation, "slop");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the edit hook points a new block at the nearby code it repeats", async () => {
  const dir = workspace();
  const hooks = new Map();
  registerSourceCheck({ registerTool() {}, on: (name, handler) => hooks.set(name, handler) });
  try {
    write(dir, "src/cart.js", ORIGINAL);
    write(dir, "src/orders.js", RENAMED + "\n// ... existing code here\n");
    const event = { toolName: "write", input: { path: "src/orders.js" }, content: [{ type: "text", text: "ok" }], details: {}, isError: false };
    const note = await hooks.get("tool_result")(event, { cwd: dir, sessionManager: { getSessionId: () => "s" } });
    assert.ok(note, "an advisory is attached");
    const text = note.content[1].text;
    assert.match(text, /repeats src\/cart\.js:1-9/);
    assert.match(text, /placeholder-elision/);
    assert.equal(note.details.codeQuality.clones.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("git_info review flags risky additions and drafts a commit header; blame summarizes line history", async () => {
  const { runGitInfo } = await import(pathToFileURL(path.join(agentRoot, "extensions/git-tools.ts")));
  const dir = workspace();
  const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir });
  try {
    git("init", "-q");
    write(dir, "package.json", '{"name":"x","dependencies":{"a":"1.0.0"}}\n');
    write(dir, "src/app.js", "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "init");
    const clean = JSON.parse(await runGitInfo({ action: "review" }, dir));
    assert.equal(clean.files, 0); assert.deepEqual(clean.risks, []);
    write(dir, "package.json", '{"name":"x","dependencies":{"a":"1.0.0","b":"^2.1.0"}}\n');
    write(dir, "src/app.js", `export const a = 1;\nconsole.log(a);   \nconst key = "${["gh", "p_"].join("")}${"A".repeat(36)}";\n`);
    write(dir, "tests/app.test.js", "it.only('works', () => {});\n");
    write(dir, ".env", "TOKEN=1\n");
    const review = JSON.parse(await runGitInfo({ action: "review" }, dir));
    const risks = review.risks.join("\n");
    for (const pattern of [/debug statement/, /possible GitHub token/, /focused test/, /environment file/, /without a lockfile update/]) assert.match(risks, pattern);
    assert.match(review.whitespace[0], /src\/app\.js:2: trailing whitespace/);
    assert.equal(review.untracked, 2);
    assert.match(review.commit.draft, /^\w+(\(\w+\))?: </);
    const blame = JSON.parse(await runGitInfo({ action: "blame", path: "src/app.js", range: "1,+1" }, dir));
    assert.equal(blame.commits.length, 1); assert.equal(blame.commits[0].summary, "init"); assert.equal(blame.commits[0].lines, "1");
    await assert.rejects(runGitInfo({ action: "blame", path: "src/app.js", range: "1;rm" }, dir), /range must look like/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bash router points once at an installed specialist that is off the wire", async () => {
  const registerRouter = (await import(pathToFileURL(path.join(agentRoot, "extensions/bash-router.ts")))).default;
  const hooks = new Map();
  let active = ["bash", "read"];
  registerRouter({ on: (name, handler) => hooks.set(name, handler), registerCommand() {}, getActiveTools: () => active, getAllTools: () => [{ name: "bash" }, { name: "read" }, { name: "git_info" }] });
  const call = id => hooks.get("tool_call")({ toolName: "bash", toolCallId: id, input: { command: "git status" } });
  const result = id => hooks.get("tool_result")({ toolName: "bash", toolCallId: id, content: [{ type: "text", text: "clean" }], isError: false });
  assert.equal(call("a"), undefined, "never blocks an inactive route");
  const first = result("a");
  assert.match(first.content.at(-1).text, /git_info is installed but not active; tool_search\(\{names:\["git_info"\]\}\)/);
  call("b");
  assert.equal(result("b"), undefined, "said once per session");
  hooks.get("session_start")();
  const uninstalled = new Map();
  registerRouter({ on: (name, handler) => uninstalled.set(name, handler), registerCommand() {}, getActiveTools: () => ["bash"], getAllTools: () => [{ name: "bash" }] });
  uninstalled.get("tool_call")({ toolName: "bash", toolCallId: "c", input: { command: "git status" } });
  assert.equal(uninstalled.get("tool_result")({ toolName: "bash", toolCallId: "c", content: [], isError: false }), undefined, "no hint for tools that are not installed");
});

test("a bash commit with a staged secret or conflict marker is stopped, asked about, or allowed when clean", async () => {
  const gitTools = (await import(pathToFileURL(path.join(agentRoot, "extensions/git-tools.ts")))).default;
  const hooks = [];
  gitTools({ registerTool() {}, on: (name, handler) => { if (name === "tool_call") hooks.push(handler); } });
  const guard = hooks[0];
  const dir = workspace();
  const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir });
  const call = (command, ctx = {}) => guard({ toolName: "bash", input: { command } }, { cwd: dir, hasUI: false, ...ctx });
  try {
    git("init", "-q");
    write(dir, "a.js", "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "init");
    write(dir, "a.js", "export const a = 2;\n"); git("add", "a.js");
    assert.equal(await call('git commit -m "clean change"'), undefined, "clean staged changes commit normally");
    write(dir, "config.js", `export const token = "${["gh", "p_"].join("")}${"B".repeat(36)}";\n`); git("add", "config.js");
    const blocked = await call('git add -A && git commit -m "add config"');
    assert.equal(blocked.block, true); assert.match(blocked.reason, /possible GitHub token/);
    assert.equal((await call('git commit -m "x"', { hasUI: true, ui: { confirm: async () => true } })), undefined, "a person can allow it");
    assert.equal((await call('git commit -m "x"', { hasUI: true, ui: { confirm: async () => false } })).block, true);
    assert.equal(await call("git status"), undefined);
    assert.equal(await guard({ toolName: "read", input: { path: "a.js" } }, { cwd: dir }), undefined);
    process.env.PI_COMMIT_SECRET_GUARD = "off";
    try { assert.equal(await call('git commit -m "x"'), undefined); } finally { delete process.env.PI_COMMIT_SECRET_GUARD; }
    git("reset", "-q", "config.js"); fs.rmSync(path.join(dir, "config.js"));
    write(dir, "a.js", "<<<<<<< HEAD\nexport const a = 2;\n=======\nexport const a = 3;\n>>>>>>> other\n");
    const marker = await call("git commit -am wip");
    assert.equal(marker.block, true); assert.match(marker.reason, /merge conflict marker/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
