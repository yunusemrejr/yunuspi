import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find(dir => fs.existsSync(path.join(dir, "extensions/lib/browser-session.ts")));
const load = relative => import(pathToFileURL(path.join(agent, relative)));
const { registerBrowserSession, isolatedBrowserEnvironment } = await load("extensions/lib/browser-session.ts");
function unavailableBrowser(t, error) {
  if (process.env.PI_BROWSER_REQUIRE === "1" || !/browserType\.launch|browser startup failure/i.test(String(error.message))) throw error;
  t.skip("Chromium unavailable; PI_BROWSER_REQUIRE=1 requires it");
}

test("isolated browser children resolve the installed executable without inheriting private state", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browser-binary-cache-"));
  const script = `import { createRequire } from 'node:module';
    const { chromium } = createRequire(${JSON.stringify(path.join(agent, "npm/package.json"))})('playwright');
    console.log(JSON.stringify({ executable: chromium.executablePath(), home: process.env.HOME,
      cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME, keys: Object.keys(process.env) }));`;
  const probe = (env, cwd) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  try {
    const source = { PATH: process.env.PATH, HOME: path.join(scratch, "original"), PI_RENDER_BROWSER_CHANNEL: "chromium",
      NODE_OPTIONS: "--trace-warnings", GITHUB_TOKEN: "YOUR_GITHUB_TOKEN", DISPLAY: ":99" };
    for (const setting of [{}, { XDG_CACHE_HOME: path.join(scratch, "shared-cache") },
      { PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, "explicit-binaries") }, { PLAYWRIGHT_BROWSERS_PATH: "0" },
      { PLAYWRIGHT_BROWSERS_PATH: "relative-binaries" }, { PLAYWRIGHT_BROWSERS_PATH: "relative-binaries", INIT_CWD: scratch }]) {
      const original = { ...source, ...setting };
      const privateHome = path.join(scratch, "private-home");
      const isolated = isolatedBrowserEnvironment(privateHome, false, original);
      // Different child cwd must not reinterpret a relative caller cache path.
      const before = probe(original, process.cwd());
      const after = probe(isolated, scratch);
      assert.equal(after.executable, before.executable, JSON.stringify(setting));
      assert.equal(after.home, privateHome);
      assert.equal(after.cache, path.join(privateHome, "cache"));
      assert.equal(after.config, path.join(privateHome, "config"));
      for (const key of ["NODE_OPTIONS", "GITHUB_TOKEN", "DISPLAY", "INIT_CWD"]) assert.ok(!after.keys.includes(key), key);
      assert.equal(isolated.PI_RENDER_BROWSER_CHANNEL, "chromium");
    }
    assert.equal(isolatedBrowserEnvironment(scratch, true, source).DISPLAY, ":99");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("browser validates before dispatch and resolves private aliases with compact fresh action observations", { timeout: 60000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "browser-alias-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Alias fixture</title><label>Search<input></label><button onclick="document.querySelector('h1').textContent='Saved'">Save</button><h1>Ready</h1>${Array.from({ length: 40 }, (_, i) => `<h2>Fixture section ${i} with ordinary explanatory text</h2>`).join("")}`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const tools = [], hooks = [];
  for (let i = 0; i < 2; i++) {
    const events = {}; hooks.push(events);
    registerBrowserSession({ registerTool: value => tools.push(value), on: (name, fn) => events[name] = fn });
  }
  const ctx = { cwd: scratch, model: { input: ["text"] }, sessionManager: { getSessionId: () => "alias-fixture" } };
  const call = (p, owner = 0) => tools[owner].execute("fixture", p, undefined, undefined, ctx);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of [{ action: "open", session: "workspace" }, { action: "open", session: "workspace", url: "file:///tmp/fixture.html" }, { action: "fill", session: "missing", text: "fixture" }]) {
      const result = await call(p);
      assert.equal(result.isError, true);
      assert.equal(result.details.failure.outcome, "not-dispatched");
      assert.doesNotMatch(result.details.failure.nextStep, /reconcile|timeout/i);
    }
    assert.deepEqual((await call({ action: "list" })).details.sessions, []);
    const opened = await call({ action: "open", session: "workspace", url });
    assert.notEqual(opened.isError, true, JSON.stringify(opened.details));
    const id = opened.details.session;
    assert.notEqual(id, "workspace");
    assert.equal(opened.details.alias, "workspace");
    assert.equal(opened.details.pageState.itemsOmitted, true);
    assert.equal(opened.details.pageState.items, undefined);
    assert.equal((await call({ action: "open", session: "workspace", url })).details.failure.kind, "duplicate-alias");
    assert.equal((await call({ action: "snapshot", session: "workspace" }, 1)).details.failure.kind, "unknown-session");
    assert.equal((await call({ action: "snapshot", session: id }, 1)).details.failure.kind, "unknown-session");
    const search = opened.details.targets.find(row => row.name === "Search");
    const filled = await call({ action: "fill", session: "workspace", ref: search.ref, text: "draft" });
    assert.equal(filled.details.session, id);
    assert.notEqual(filled.details.targets.find(row => row.name === "Search").ref, search.ref);
    assert.equal((await call({ action: "verify", session: id, selector: "input", text: "draft" })).details.verification.matches, true);
    const snapshot = await call({ action: "snapshot", session: "workspace" });
    assert.ok(snapshot.details.pageState.items.length > 20);
    const compactBytes = Buffer.byteLength(filled.content[0].text);
    const detailedBytes = Buffer.byteLength(snapshot.content[0].text);
    assert.ok(compactBytes < detailedBytes / 2, `${compactBytes} compact vs ${detailedBytes} detailed bytes`);
    t.diagnostic(`Action observation ${compactBytes} bytes; explicit snapshot ${detailedBytes} bytes (${Math.round(100 * (1 - compactBytes / detailedBytes))}% less text).`);
    assert.equal((await call({ action: "close", session: "workspace" })).details.closed, true);
    assert.deepEqual((await call({ action: "list" })).details.aliases, {});
    assert.equal((await call({ action: "snapshot", session: "workspace" })).details.failure.outcome, "not-dispatched");
    const reopened = await call({ action: "open", session: "workspace", url });
    assert.notEqual(reopened.details.session, id);
    await hooks[0].session_start();
    assert.deepEqual((await call({ action: "list" })).details.aliases, {});
  } catch (error) { unavailableBrowser(t, error); } finally {
    await Promise.all(hooks.map(events => events.session_shutdown()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("local HTML fragments reach the page while literal hashes and asset confinement remain intact", { timeout: 60000 }, async t => {
  const { renderCapture, resolveLocalRenderSource } = await load("scripts/render-capture.mjs");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "render-fragment-"));
  const dir = path.join(scratch, "site"); fs.mkdirSync(dir);
  const source = path.join(dir, "index.html");
  const literal = path.join(dir, "index.html#literal.html");
  fs.writeFileSync(source, `<!doctype html><title>Fixture</title><h1 id="route">Pending</h1><script>document.querySelector('#route').textContent=location.hash==='#v=sources'?'Sources route':'Unexpected route'</script><script src="/linked.js"></script>`);
  fs.writeFileSync(literal, "<!doctype html><h1>Literal hash filename</h1>");
  fs.writeFileSync(path.join(scratch, "outside.js"), "document.title='OUTSIDE_ASSET_EXECUTED';");
  fs.symlinkSync(path.join(scratch, "outside.js"), path.join(dir, "linked.js"));
  try {
    assert.deepEqual(await resolveLocalRenderSource(literal), { target: literal, fragment: "" });
    const routed = await renderCapture({ source: source + "#v=sources", output: "both", width: 500, height: 400 }, path.join(scratch, "capture.png"));
    assert.equal(routed.conditions.fragmentApplied, true);
    assert.ok(fs.existsSync(routed.output));
    assert.match(JSON.stringify(routed.pageState.items), /Sources route/);
    assert.equal(routed.pageState.title, "Fixture");
    assert.ok(routed.errors.length > 0, "symlinked asset remains blocked");
    const exact = await renderCapture({ source: literal, output: "text" }, path.join(scratch, "literal.png"));
    assert.match(JSON.stringify(exact.pageState.items), /Literal hash filename/);
    assert.equal(exact.conditions.fragmentApplied, undefined);
    await assert.rejects(resolveLocalRenderSource(path.join(dir, "missing.html#v=sources")), { code: "ENOENT" });
  } catch (error) { unavailableBrowser(t, error); } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("oversized embedded resources return a precise tool failure independent of capture dimensions", { timeout: 60000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "render-resource-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
  const source = path.join(scratch, "index.html");
  // A tiny SVG safely exercises the same natural-image dimension guard without
  // retaining private assets or a large compressed image fixture.
  fs.writeFileSync(path.join(scratch, "large.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="3400"><rect width="100%" height="100%" fill="green"/></svg>');
  fs.writeFileSync(source, '<!doctype html><h1>Resource fixture</h1><img src="large.svg" width="100" alt="Synthetic image">');
  const tools = [];
  const { default: register } = await load("extensions/render-and-wait.ts");
  register({ registerTool: tool => tools.push(tool), on() {} });
  const tool = tools.find(tool => tool.name === "render_see");
  const ctx = { cwd: scratch, model: { input: ["text", "image"] }, sessionManager: { getSessionId: () => "resource-fixture" } };
  try {
    for (const params of [{ fullPage: true, output: "image", width: 1500, height: 1100 }, { fullPage: false, output: "both", width: 400, height: 300, selector: "h1" }, { output: "text", width: 400, height: 300 }]) {
      const result = await tool.execute("fixture", { source, ...params }, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.equal(result.details.status, "failed");
      const failure = result.details.failure;
      assert.equal(failure.stage, "resource-validation");
      assert.equal(failure.kind, "image-dimensions");
      assert.equal(failure.outcome, "not-captured");
      assert.deepEqual(failure.images, [{ imageIndex: 0, width: 5000, height: 3400 }]);
      assert.deepEqual(failure.limits, { maxEdge: 8192, maxPixels: 16000000 });
      assert.match(failure.nextStep, /Changing viewport, fullPage, selector or CSS display size does not/);
      assert.equal(result.content.some(part => part.type === "image"), false);
    }
    fs.writeFileSync(path.join(scratch, "large.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="340"><rect width="100%" height="100%" fill="green"/></svg>');
    const repaired = await tool.execute("fixture", { source, width: 400, height: 300 }, undefined, undefined, ctx);
    assert.equal(repaired.isError, undefined);
    assert.equal(repaired.details.status, "captured");
    assert.equal(repaired.content.some(part => part.type === "image"), true);
  } catch (error) { unavailableBrowser(t, error); } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
