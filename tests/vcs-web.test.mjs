import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
  fs.existsSync(path.join(dir, "extensions/git-tools.ts")),
);
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-vcs-web-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
const originalFetch = globalThis.fetch;
const clearPace = () =>
  fs.rmSync(path.join(scratch, "web-search-pacing"), {
    recursive: true,
    force: true,
  });
test.after(() => {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
    },
  ).trim();
function repository(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("git inspection ignores inherited repository/index overrides and executable diff helpers", async () => {
  const { runGitInfo } = await load("extensions/git-tools.ts");
  const project = repository("project"),
    other = repository("other");
  git(project, "branch", "-m", "feature.v2");
  fs.writeFileSync(path.join(project, "file.txt"), "project change\n");
  const hook = path.join(scratch, "must-not-run.sh"),
    marker = path.join(scratch, "executed");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  git(project, "config", "diff.external", hook);
  git(project, "config", "core.fsmonitor", hook);
  const old = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  try {
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = path.join(scratch, "foreign-index");
    assert.match(
      await runGitInfo({ action: "status" }, project),
      /branch: feature\.v2/,
    );
    assert.match(
      await runGitInfo({ action: "diff" }, project),
      /project change/,
    );
    const scope = JSON.parse(await runGitInfo({ action: "scope" }, project));
    assert.equal(scope.workTree, project);
    assert.equal(scope.commonDir, path.join(project, ".git"));
    assert.equal(scope.scope, "project");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(process.env.GIT_INDEX_FILE), false);
  } finally {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("managed capture and cleanup preserve repointed branches, foreign repos and synthetic symlink targets", async () => {
  const { createWorktrees, cleanupWorktrees, diffWorktrees } = await load(
    "extensions/pi-subagents/src/runs/shared/worktree.ts",
  );
  const project = repository("managed");
  const setup = createWorktrees(project, "ownership", 1, { baseDir: scratch });
  const child = setup.worktrees[0];
  git(child.path, "switch", "-c", "user-work");
  assert.match(
    diffWorktrees(setup, ["worker"], path.join(scratch, "patches"))[0].error,
    /ownership/,
  );
  assert.equal(
    cleanupWorktrees(setup, { kind: "setup-rollback" }).tasks[0].preserved,
    true,
  );
  assert.equal(fs.existsSync(child.path), true);
  git(child.path, "switch", child.branch);
  const outside = path.join(scratch, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "important");
  fs.symlinkSync(outside, path.join(child.path, "alias"));
  child.syntheticPaths = ["alias/keep"];
  assert.match(
    diffWorktrees(setup, ["worker"], path.join(scratch, "patches"))[0].error,
    /Synthetic path/,
  );
  assert.equal(cleanupWorktrees(setup).tasks[0].preserved, true);
  assert.equal(
    fs.readFileSync(path.join(outside, "keep"), "utf8"),
    "important",
  );
  child.syntheticPaths = [];
  fs.unlinkSync(path.join(child.path, "alias"));
  const clean = cleanupWorktrees(setup);
  assert.equal(clean.state, "complete");
  assert.equal(git(project, "branch", "--list", child.branch), "");
  const foreign = repository("foreign");
  const forged = { ...setup, worktrees: [{ ...child, path: foreign }] };
  assert.equal(
    cleanupWorktrees(forged, { kind: "setup-rollback" }).tasks[0].preserved,
    true,
  );
  assert.ok(fs.existsSync(path.join(foreign, "file.txt")));
});

test("remote redirect handling cancels discarded bodies and validates redirect bounds", async () => {
  const { fetchRemoteUrl } = await load("extensions/pi-web-access/ssrf-protection.ts");
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  let cancelled = false;
  const requested = [];
  const redirect = {
    status: 302,
    headers: new Headers({ location: "https://example.com/next" }),
    body: { cancel: async () => { cancelled = true; } },
  };
  const final = new Response("ok", { status: 200 });
  const result = await fetchRemoteUrl("https://example.com/start", {}, {
    lookup,
    fetch: async (url) => {
      requested.push(url.href);
      return requested.length === 1 ? redirect : final;
    },
  });
  assert.equal(await result.text(), "ok");
  assert.deepEqual(requested, ["https://example.com/start", "https://example.com/next"]);
  assert.equal(cancelled, true, "discarded redirect body is released before the next hop");
  await assert.rejects(
    fetchRemoteUrl("https://example.com/start", {}, { lookup, maxRedirects: -1 }),
    /maxRedirects must be an integer from 0 through 20/,
  );
  await assert.rejects(
    fetchRemoteUrl("https://example.com/start", {}, { lookup, maxRedirects: 21 }),
    /maxRedirects must be an integer from 0 through 20/,
  );
});

test("search pacing shares reservations between processes and obeys cancellation and Retry-After", async () => {
  clearPace();
  const {
    waitForSearchSlot,
    coolSearchProvider,
    retryAfterMs,
    readSearchBody,
  } = await load("extensions/pi-web-access/search-transport.ts");
  const started = Date.now();
  await waitForSearchSlot("process-fixture", undefined, 250);
  const module = pathToFileURL(
    path.join(agent, "extensions/pi-web-access/search-transport.ts"),
  ).href;
  const worker = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m=await import(${JSON.stringify(module)}); await m.waitForSearchSlot('process-fixture',undefined,250); console.log(Date.now());`,
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const timestamp = await new Promise((resolve, reject) => {
    let output = "";
    worker.stdout.on("data", (c) => (output += c));
    worker.on("error", reject);
    worker.on("close", (code) =>
      code === 0
        ? resolve(Number(output.trim()))
        : reject(Error("pacing child failed")),
    );
  });
  assert.ok(
    timestamp - started >= 220,
    `cross-process spacing: ${timestamp - started}ms`,
  );
  await assert.rejects(coolSearchProvider("blocked", 60000), /cooling down/);
  await assert.rejects(waitForSearchSlot("blocked"), /retry after/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(waitForSearchSlot("cancelled", abort.signal), /abort/i);
  assert.equal(retryAfterMs("120"), 120000);
  assert.equal(retryAfterMs(new Date(20000).toUTCString(), 0), 20000);
  await assert.rejects(
    readSearchBody(new Response("too large"), 2),
    /bounded body/,
  );
});

test("search blocks challenges without endpoint evasion; reference APIs preserve domain and coverage semantics", async () => {
  clearPace();
  const { searchWithDuckDuckGo } = await load(
    "extensions/pi-web-access/duckduckgo.ts",
  );
  const { searchFree } = await load("extensions/pi-web-access/free-search.ts");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      '<html><body><form id="challenge-form">Bots use DuckDuckGo</form></body></html>',
    );
  };
  await assert.rejects(searchWithDuckDuckGo("fixture"), /cooling down/);
  await assert.rejects(searchWithDuckDuckGo("another query"), /retry after/);
  assert.equal(calls, 1);
  clearPace();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "120" },
    });
  };
  await assert.rejects(searchWithDuckDuckGo("limited"), /120s/);
  assert.equal(calls, 1);
  clearPace();
  fs.writeFileSync(
    path.join(scratch, "web-search.json"),
    JSON.stringify({ searxngUrl: "https://search.example.invalid" }),
  );
  const credentialFixture = new URL("https://example.org/");
  credentialFixture.username = "fixture";
  globalThis.fetch = async (url) => {
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.pathname, "/search");
    return Response.json({
      results: [
        {
          title: "Good <b>source</b>",
          url: "https://docs.example.org/page",
          content: "Evidence",
        },
        { title: "Bad", url: credentialFixture.href, content: "secret" },
        { title: "Other", url: "https://elsewhere.invalid/", content: "Other" },
      ],
    });
  };
  const result = await searchFree("searxng", "query", {
    domainFilter: ["example.org"],
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, "Good source");
  await assert.rejects(
    searchFree("wikipedia", "query", { recencyFilter: "day" }),
    /does not support/,
  );
  globalThis.fetch = async () =>
    Response.json({
      query: { search: [{ title: "Example", snippet: "A <b>reference</b>" }] },
    });
  const wiki = await searchFree("wikipedia", "query", {});
  assert.match(wiki.answer, /encyclopedia only/);
  assert.equal(wiki.results[0].snippet, "A reference");
  globalThis.fetch = async () =>
    Response.json({
      message: {
        items: [
          {
            title: ["Paper"],
            URL: "https://doi.org/10.1234/example",
            "container-title": ["Journal"],
          },
        ],
      },
    });
  assert.match(
    (await searchFree("crossref", "query", {})).answer,
    /metadata only/,
  );
  globalThis.fetch = originalFetch;
});

test("background research continues distinct query angles, paginates, and rejects foreign handles", async () => {
  const { registerResearchJobs } = await load(
    "extensions/pi-web-access/research-jobs.ts",
  );
  let tool;
  const notices = [],
    events = {};
  registerResearchJobs(
    {
      registerTool: (value) => (tool = value),
      on: (name, handler) => (events[name] = handler),
      sendMessage: (value) => notices.push(value),
    },
    async (query) => {
      if (query === "failure") throw Error("provider unavailable");
      return {
        answer: "candidate",
        provider: "fixture",
        results:
          query === "empty"
            ? []
            : [
                {
                  title: "Source",
                  url: "https://example.org",
                  snippet: "Evidence",
                },
              ],
      };
    },
  );
  const ctx = { cwd: scratch, sessionManager: { getSessionId: () => "one" } };
  const call = (p, c = ctx) => tool.execute("id", p, undefined, undefined, c);
  const start = await call({
    action: "start",
    queries: ["first", "failure", "empty", "fourth"],
    readPages: 0,
  });
  const id = start.details.id;
  const end = await call({ action: "wait", id });
  assert.equal(end.details.state, "partial");
  assert.equal(end.details.completedQueries, 4);
  const read = await call({ action: "read", id });
  assert.equal(read.details.results.length, 3);
  assert.equal(read.details.nextOffset, 3);
  assert.match(read.details.coverage, /not evidence of absence/);
  assert.equal(notices.length, 1);
  assert.equal(
    (await call({ action: "read", id, offset: 3 })).details.results[0].query,
    "fourth",
  );
  await assert.rejects(
    call({ action: "start", queries: ["same", " SAME "] }),
    /distinct/,
  );
  await assert.rejects(
    call({ action: "read", id }, { ...ctx, cwd: scratch + "-other" }),
    /foreign/,
  );
  events.session_shutdown();
});

test(
  "real browser sessions isolate storage, support actions and logs, and clean temporary profiles",
  { timeout: 90000 },
  async (t) => {
    const { registerBrowserSession } = await load(
      "extensions/lib/browser-session.ts",
    );
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<html><body><button onclick="localStorage.setItem('saved','yes');document.querySelector('h1').textContent='Saved'">Save</button><h1 id="state"></h1><input aria-label="Name" value="DO_NOT_ECHO"><script>document.querySelector('h1').textContent=localStorage.getItem('saved')?'Saved':'Fresh';console.error('PRIVATE_CONSOLE_FIXTURE')</script></body></html>`,
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/?token=PRIVATE_URL_FIXTURE`;
    let tool;
    const events = {};
    registerBrowserSession({
      registerTool: (value) => (tool = value),
      on: (name, handler) => (events[name] = handler),
    });
    const ctx = {
      cwd: scratch,
      model: { input: ["text", "image"] },
      sessionManager: { getSessionId: () => "browser-owner" },
    };
    const call = (p, signal, c = ctx) =>
      tool.execute("id", p, signal, undefined, c);
    try {
      let opened;
      try {
        opened = await call({ action: "open", url });
      } catch (error) {
        assert.equal(
          (await call({ action: "list" })).details.sessions.length,
          0,
        );
        if (process.env.PI_BROWSER_REQUIRE === "1") throw error;
        t.skip(
          "Real Chromium runtime unavailable; failed-start cleanup verified. Set PI_BROWSER_REQUIRE=1 on the installed harness.",
        );
        return;
      }
      assert.notEqual(opened.isError, true, JSON.stringify(opened.details));
      const one = opened.details.session;
      assert.equal(opened.details.pageState.itemsOmitted, true);
      assert.match(JSON.stringify(await call({ action: "snapshot", session: one })), /Fresh/);
      assert.doesNotMatch(
        JSON.stringify(opened),
        /DO_NOT_ECHO|PRIVATE_CONSOLE_FIXTURE|PRIVATE_URL_FIXTURE/,
      );
      const clicked = await call({
        action: "click",
        session: one,
        role: "button",
        name: "Save",
      });
      assert.equal(clicked.details.ok, true);
      assert.match(JSON.stringify(await call({ action: "snapshot", session: one })), /Saved/);
      const two = (await call({ action: "open", url })).details.session;
      assert.match(
        JSON.stringify(await call({ action: "snapshot", session: two })),
        /Fresh/,
      );
      assert.match(
        JSON.stringify(await call({ action: "navigate", session: one, url })),
        /itemsOmitted/,
      );
      assert.match(JSON.stringify(await call({ action: "snapshot", session: one })), /Saved/);
      await call({
        action: "fill",
        session: two,
        role: "textbox",
        name: "Name",
        text: "PRIVATE_FILLED_VALUE",
      });
      assert.doesNotMatch(
        JSON.stringify(await call({ action: "snapshot", session: two })),
        /PRIVATE_FILLED_VALUE/,
      );
      const shot = await call({ action: "screenshot", session: one });
      assert.ok(shot.content.some((item) => item.type === "image"));
      assert.equal(
        fs.readFileSync(shot.details.output).subarray(1, 4).toString(),
        "PNG",
      );
      assert.match(
        JSON.stringify(await call({ action: "logs", session: one })),
        /console-error/,
      );
      const saved = shot.details.output;
      await call({ action: "close", session: one });
      assert.equal(fs.existsSync(saved), false);
      assert.equal((await call({ action: "snapshot", session: one })).details.failure.kind, "unknown-session");
      const controller = new AbortController();
      const pending = call(
        { action: "click", session: two, selector: "#missing" },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(pending, /cancelled/);
      assert.equal((await call({ action: "snapshot", session: two }, undefined, {
          ...ctx,
          cwd: scratch + "-foreign",
        })).details.failure.kind, "unknown-session");
    } finally {
      await events.session_shutdown();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
