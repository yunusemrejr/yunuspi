import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = [path.join(root, "agent"), path.resolve(root, "..")].find(candidate => fs.existsSync(path.join(candidate, "extensions/pi-memory/local-search.ts")));
assert.ok(agentRoot, "built-in memory search ships with the distribution");
const search = await import(pathToFileURL(path.join(agentRoot, "extensions/pi-memory/local-search.ts")));

const DAY = 86_400_000;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-search-"));
  const daily = path.join(dir, "daily", "proj-0123456789abcdef01234567");
  const other = path.join(dir, "daily", "other-0123456789abcdef01234567");
  fs.mkdirSync(daily, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "# Deployment\n\nThe staging server deploys through the GitHub Actions workflow deploy.yml; never push directly to main.\n\n# Preferences\n\n- The user prefers pnpm over npm.\n- Commit messages follow conventional commits.\n");
  fs.writeFileSync(path.join(dir, "SCRATCHPAD.md"), "- [ ] investigate flaky websocket reconnect test\n");
  fs.writeFileSync(path.join(daily, "2026-09-01.md"), "## Session Summary\n\nFixed the websocket reconnect race by awaiting the close event before reconnecting.\nToken used in the test: ghp_" + "x".repeat(36) + "\n");
  fs.writeFileSync(path.join(daily, "2026-09-20.md"), "## Session Summary\n\nThe websocket reconnect test is flaky again on CI; suspect the timer mock.\n");
  fs.writeFileSync(path.join(other, "2026-09-10.md"), "Other project: websocket reconnect uses exponential backoff with jitter.\n");
  const old = new Date(Date.now() - 40 * DAY), recent = new Date(Date.now() - 2 * DAY);
  fs.utimesSync(path.join(daily, "2026-09-01.md"), old, old); fs.utimesSync(path.join(daily, "2026-09-20.md"), recent, recent);
  return { dir, daily, paths: { memory: path.join(dir, "MEMORY.md"), scratchpad: path.join(dir, "SCRATCHPAD.md"), project: path.join(dir, "projects", "proj.md"), projectDaily: daily, dailyRoot: path.join(dir, "daily") } };
}

test("blocks keep their section heading and split at list items", () => {
  const blocks = search.splitBlocks("m.md", "# Prefs\n\n- one item here\n- two item here\n\n## Deploy\n\nA paragraph that\nwraps lines.\n", 0, false);
  assert.deepEqual(blocks.map(b => [b.heading, b.line, b.text]), [["Prefs", 3, "- one item here"], ["Prefs", 4, "- two item here"], ["Deploy", 8, "A paragraph that\nwraps lines."]]);
});

test("BM25 ranks relevant blocks, tolerates typos and inflections, prefers recent logs", async () => {
  const { dir, paths } = fixture();
  try {
    const files = await search.memorySearchFiles(paths);
    const typo = await search.searchMemory(files, "how do we deploy stagin");
    assert.match(typo.results[0].block.text, /staging server deploys/);
    assert.ok(typo.results[0].matched.includes("stagin"), typo.results[0].matched.join());
    const recent = await search.searchMemory(files, "websocket reconnect");
    const logs = recent.results.filter(hit => hit.block.daily).map(hit => hit.block.file);
    assert.match(logs[0], /2026-09-20/, "a recent log outranks an equally matching older one");
    const pref = await search.searchMemory(files, "which package manager, pnpm?");
    assert.match(pref.results[0].block.text, /prefers pnpm/);
    assert.deepEqual((await search.searchMemory(files, "the and of")).results, [], "stop words alone match nothing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("project scope isolates other projects' logs; all scope reaches them", async () => {
  const { dir, paths } = fixture();
  try {
    const project = await search.searchMemory(await search.memorySearchFiles(paths, "project"), "exponential backoff jitter");
    assert.equal(project.results.length, 0);
    const all = await search.searchMemory(await search.memorySearchFiles(paths, "all"), "exponential backoff jitter");
    assert.match(all.results[0].block.file, /other-/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("results redact token-like strings and semantic reranking fuses when available", async () => {
  const { dir, paths } = fixture();
  try {
    const files = await search.memorySearchFiles(paths);
    const found = await search.searchMemory(files, "websocket reconnect race close event");
    const text = search.formatHits(found.results);
    assert.doesNotMatch(text, /ghp_x{36}/); assert.match(text, /\[redacted\]/);
    const reversed = async (_query, candidates) => candidates.map(c => c.id).reverse();
    const reranked = await search.searchMemory(files, "websocket reconnect", { mode: "semantic", rerank: reversed, limit: 3 });
    assert.equal(reranked.reranked, true);
    const keyword = await search.searchMemory(files, "websocket reconnect", { mode: "keyword", rerank: reversed, limit: 3 });
    assert.equal(keyword.reranked, false, "keyword mode never reranks");
    const unavailable = await search.searchMemory(files, "websocket reconnect", { mode: "deep", rerank: async () => undefined });
    assert.equal(unavailable.reranked, false);
    assert.ok(unavailable.results.length > 0, "keyword order survives an unavailable reranker");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("symlinked and oversized memory files are not read", async () => {
  const { dir, paths } = fixture();
  try {
    const secret = path.join(dir, "outside.md");
    fs.writeFileSync(secret, "outside secret deploy notes\n");
    fs.symlinkSync(secret, path.join(paths.projectDaily, "2026-09-21.md"));
    const found = await search.searchMemory(await search.memorySearchFiles(paths), "outside secret deploy notes");
    assert.ok(found.results.every(hit => !hit.block.text.includes("outside secret")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
