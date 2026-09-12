import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
  fs.existsSync(path.join(dir, "extensions/lib/browser-session.ts")),
);
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-browser-research-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
test.after(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("diagnostic buffers bound memory, paginate without repeats, expose gaps, and minimize sensitive values", async () => {
  const { createBrowserEvents, diagnosticText, browserFailure } = await load(
    "scripts/browser-diagnostics.mjs",
  );
  const events = createBrowserEvents(3);
  for (let n = 0; n < 5; n++)
    events.record("console-error", {
      message: diagnosticText(
        "TypeError token=FIXTURE_SECRET at https://example.org/a?password=URL_SECRET#x Bearer AUTH_SECRET",
      ),
    });
  const first = events.read({ limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.dropped, 2);
  assert.equal(first.nextCursor, 4);
  assert.equal(first.hasMore, true);
  assert.doesNotMatch(
    JSON.stringify(first),
    /TypeError|FIXTURE_SECRET|URL_SECRET|AUTH_SECRET/,
  );
  const next = events.read({ since: first.nextCursor, includeText: true });
  assert.equal(next.events.length, 1);
  assert.match(next.events[0].message, /TypeError/);
  assert.doesNotMatch(
    next.events[0].message,
    /FIXTURE_SECRET|URL_SECRET|AUTH_SECRET/,
  );
  assert.equal(events.read({ since: next.nextCursor }).events.length, 0);
  assert.equal(events.summary().counts["console-error"], 5);
  assert.equal(
    browserFailure(Error("strict mode violation"), "click", "click").kind,
    "ambiguous-target",
  );
  assert.match(
    browserFailure(Error("Timeout"), "click", "click").outcome,
    /unknown/,
  );
});

async function researchHarness(search, read) {
  const { registerResearchJobs } = await load(
    "extensions/pi-web-access/research-jobs.ts",
  );
  let tool;
  const events = {},
    notices = [];
  registerResearchJobs(
    {
      registerTool: (t) => (tool = t),
      on: (n, h) => (events[n] = h),
      sendMessage: (n) => notices.push(n),
    },
    search,
    read,
  );
  const ctx = {
    cwd: scratch,
    sessionManager: { getSessionId: () => "research-fixture" },
  };
  return {
    call: (p, signal) => tool.execute("id", p, signal, undefined, ctx),
    events,
    notices,
  };
}
const source = (url = "https://example.org/guide") => ({
  provider: "fixture",
  answer: "Candidate discovery",
  results: [{ title: "Source", url, snippet: "Snippet" }],
});

test("background research recovers failed discovery, reads known sources concurrently, deduplicates, and bounds excerpts", async () => {
  const queried = [],
    reads = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const harness = await researchHarness(
    async (query, options) => {
      queried.push([query, options.provider]);
      if (query === "slow") await gate;
      if (options.provider === "duckduckgo") throw Error("provider blocked");
      return source("https://example.org/guide#section");
    },
    async (url) => {
      reads.push(url);
      return {
        title: "Guide",
        content: "Authoritative text ".repeat(500),
        error: null,
      };
    },
  );
  try {
    const start = await harness.call({
      action: "start",
      queries: ["slow", "other"],
      provider: "duckduckgo",
      fallbackProviders: ["wikipedia"],
      sourceUrls: ["https://example.org/guide#seed"],
      readPages: 2,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      reads.length,
      1,
      "known source progresses before slow discovery completes",
    );
    assert.ok(
      queried.some(([q]) => q === "other"),
      "second query progresses independently",
    );
    const progress = await harness.call({
      action: "read",
      id: start.details.id,
    });
    assert.equal(progress.details.results[0].coverage, "pending");
    assert.equal(progress.details.results[1].query, "other");
    release();
    const end = await harness.call({ action: "wait", id: start.details.id });
    assert.equal(end.details.state, "complete");
    assert.equal(end.details.completedQueries, 2);
    const receipts = await harness.call({
      action: "read",
      id: start.details.id,
    });
    assert.equal(receipts.details.results[0].attempts.length, 2);
    assert.equal(
      receipts.details.results[0].attempts[0].provider,
      "duckduckgo",
    );
    const pages = await harness.call({
      action: "read",
      id: start.details.id,
      view: "sources",
    });
    assert.equal(reads.length, 1);
    assert.equal(pages.details.results.length, 1);
    assert.equal(pages.details.results[0].excerpt.length, 2400);
    assert.equal(pages.details.results[0].truncated, true);
    assert.equal(harness.notices.length, 1);
  } finally {
    release();
    harness.events.session_shutdown();
  }
});

test("research handles empty results, source-only work, source failures, cancellation, and rejects unsafe seed schemes", async () => {
  let searched = 0,
    read = 0;
  const harness = await researchHarness(
    async () => {
      searched++;
      return { provider: "fixture", answer: "none", results: [] };
    },
    async (url) => {
      read++;
      return { title: "", content: "", error: "404" };
    },
  );
  try {
    let start = await harness.call({
      action: "start",
      queries: ["empty one", "empty two"],
      readPages: 0,
    });
    assert.equal(
      (await harness.call({ action: "wait", id: start.details.id })).details
        .state,
      "failed",
    );
    start = await harness.call({
      action: "start",
      sourceUrls: ["https://example.org/missing"],
      readPages: 1,
    });
    assert.equal(
      (await harness.call({ action: "wait", id: start.details.id })).details
        .state,
      "failed",
    );
    assert.equal(searched, 2);
    assert.equal(read, 1);
    await assert.rejects(
      harness.call({ action: "start", sourceUrls: ["file:///tmp/private"] }),
      /HTTP/,
    );
    await assert.rejects(
      harness.call({
        action: "start",
        sourceUrls: ["https://example.org"],
        readPages: 0,
      }),
      /above zero/,
    );
  } finally {
    harness.events.session_shutdown();
  }
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const cancelled = await researchHarness(
    async (_query, { signal }) => {
      entered();
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("cancelled")), {
          once: true,
        }),
      );
    },
    async () => {
      throw Error("must not read");
    },
  );
  try {
    const start = await cancelled.call({
      action: "start",
      queries: ["first", "second"],
      readPages: 0,
    });
    await started;
    await cancelled.call({ action: "cancel", id: start.details.id });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await cancelled.call({ action: "status", id: start.details.id })).details
        .state,
      "cancelled",
    );
    assert.equal(cancelled.notices.length, 1);
  } finally {
    cancelled.events.session_shutdown();
  }
});

test("cooldown retry waits until fresh query angles and known pages have progressed", async () => {
  const order = [],
    counts = new Map();
  const harness = await researchHarness(
    async (query) => {
      order.push(query);
      const n = (counts.get(query) ?? 0) + 1;
      counts.set(query, n);
      if (query === "limited" && n === 1)
        throw Object.assign(Error("rate limit"), { retryAfterMs: 50 });
      return source();
    },
    async () => {
      order.push("read");
      return { title: "Guide", content: "Source", error: null };
    },
  );
  try {
    const start = await harness.call({
      action: "start",
      queries: ["limited", "second", "third"],
      sourceUrls: ["https://example.org/guide"],
    });
    const end = await harness.call({ action: "wait", id: start.details.id });
    assert.equal(end.details.state, "complete");
    assert.equal(counts.get("limited"), 2);
    assert.ok(order.indexOf("third") < order.lastIndexOf("limited"));
    assert.ok(order.indexOf("read") < order.lastIndexOf("limited"));
  } finally {
    harness.events.session_shutdown();
  }
});

test(
  "real browser diagnostics support CSS, frames, network success/failure, responsive layout, waits and actionable errors",
  { timeout: 90000 },
  async (t) => {
    const { registerBrowserSession } = await load(
      "extensions/lib/browser-session.ts",
    );
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/api")) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Set-Cookie": "fixture=COOKIE_SECRET",
        });
        res.end('{"secret":"BODY_SECRET"}');
        return;
      }
      if (req.url.startsWith("/frame")) {
        res.setHeader("Content-Type", "text/html");
        res.end("<h2>Frame content</h2><button>Frame action</button>");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<!doctype html><html><head><style>#save{width:120px;color:rgb(20,30,40)}@media(max-width:500px){#save{width:80px}}</style></head><body><button id="save" onclick="document.querySelector('#state').textContent='Saved';fetch('/api?token=URL_SECRET');console.error('TypeError in app token=CONSOLE_SECRET');">Save</button><h1 id="state">Ready</h1><input value="INPUT_SECRET"><input type="hidden" value="HIDDEN_SECRET"><textarea>TEXTAREA_SECRET</textarea><iframe id="embedded" src="/frame"></iframe><script>console.error('Initial failure');setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='Loaded';document.body.append(p)},100);</script></body></html>`,
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let tool;
    const events = {};
    registerBrowserSession({
      registerTool: (t) => (tool = t),
      on: (n, h) => (events[n] = h),
    });
    const ctx = {
      cwd: scratch,
      model: { input: ["text"] },
      sessionManager: { getSessionId: () => "diagnostics-fixture" },
    };
    const call = (p) => tool.execute("id", p, undefined, undefined, ctx);
    try {
      let opened;
      try {
        opened = await call({
          action: "open",
          url: `http://127.0.0.1:${server.address().port}`,
        });
      } catch (error) {
        if (process.env.PI_BROWSER_REQUIRE === "1") throw error;
        t.skip("Chromium unavailable; set PI_BROWSER_REQUIRE=1 to require it");
        return;
      }
      const session = opened.details.session;
      let info = await call({
        action: "inspect",
        session,
        selector: "#save",
        properties: ["width", "color", "display"],
      });
      assert.equal(info.details.inspection.styles.width, "120px");
      assert.equal(
        info.details.inspection.centerHit.targetReceivesPointer,
        true,
      );
      assert.doesNotMatch(info.details.inspection.html, /onclick/);
      await call({ action: "viewport", session, width: 390, height: 844 });
      info = await call({
        action: "inspect",
        session,
        selector: "#save",
        properties: ["width"],
      });
      assert.equal(info.details.inspection.styles.width, "80px");
      const body = await call({ action: "inspect", session, selector: "body" });
      assert.doesNotMatch(
        JSON.stringify(body),
        /INPUT_SECRET|HIDDEN_SECRET|TEXTAREA_SECRET|URL_SECRET|CONSOLE_SECRET/,
      );
      assert.match(
        JSON.stringify(
          await call({ action: "snapshot", session, frame: "#embedded" }),
        ),
        /Frame content/,
      );
      assert.equal(
        (await call({ action: "wait", session, selector: "#later" })).details
          .ok,
        true,
      );
      await call({ action: "click", session, role: "button", name: "Save" });
      assert.match(
        JSON.stringify(
          await call({ action: "snapshot", session, selector: "#state" }),
        ),
        /Saved/,
      );
      // Wait for the app's response event with bounded read-only diagnostics.
      let traffic;
      for (let n = 0; n < 10; n++) {
        traffic = await call({ action: "network", session, limit: 30 });
        if (traffic.details.network.some((e) => e.status === 503)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(traffic.details.network.some((e) => e.status === 200));
      assert.ok(traffic.details.network.some((e) => e.status === 503));
      assert.doesNotMatch(
        JSON.stringify(traffic),
        /URL_SECRET|BODY_SECRET|COOKIE_SECRET/,
      );
      const logs = await call({ action: "logs", session, includeText: true });
      assert.match(JSON.stringify(logs), /TypeError in app/);
      assert.doesNotMatch(JSON.stringify(logs), /CONSOLE_SECRET/);
      assert.equal(
        (
          await call({
            action: "logs",
            session,
            since: logs.details.nextCursor,
          })
        ).details.logs.length,
        0,
      );
      const failed = await call({
        action: "click",
        session,
        selector: "#missing",
        timeoutMs: 100,
      });
      assert.equal(failed.isError, true);
      assert.equal(failed.details.failure.kind, "timeout");
      assert.match(failed.details.failure.outcome, /unknown/);
      assert.match(
        JSON.stringify(await call({ action: "snapshot", session })),
        /Saved/,
      );
      assert.ok(JSON.stringify(body).length < 14000);
    } finally {
      await events.session_shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("configured search routes continue on empty results and preserve structured cooldown receipts", async () => {
  const original = globalThis.fetch;
  const config = path.join(scratch, "web-search.json");
  const pacing = path.join(scratch, "web-search-pacing");
  fs.writeFileSync(
    config,
    JSON.stringify({
      searchRouting: {
        providers: ["wikipedia", "crossref"],
        fallbackOn: ["quota", "invalid-response"],
      },
    }),
  );
  try {
    const { search } = await load("extensions/pi-web-access/gemini-search.ts");
    const visited = [];
    globalThis.fetch = async (url) => {
      visited.push(String(url));
      if (String(url).includes("wikipedia"))
        return Response.json({ query: { search: [] } });
      return Response.json({
        message: {
          items: [
            {
              title: ["Research paper"],
              URL: "https://doi.org/10.1234/fixture",
            },
          ],
        },
      });
    };
    const result = await search("source discovery");
    assert.equal(result.provider, "crossref");
    assert.equal(visited.length, 2);
    assert.equal(result.providerErrors[0].provider, "wikipedia");
    assert.match(result.answer, /metadata only/);
    fs.rmSync(pacing, { recursive: true, force: true });
    globalThis.fetch = async () =>
      new Response("rate limit", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    await assert.rejects(search("blocked providers"), (error) => {
      assert.equal(error.name, "SearchProviderAggregateError");
      assert.equal(error.failures.length, 2);
      assert.ok(error.failures.every((f) => f.retryAfterMs > 0));
      return true;
    });
  } finally {
    globalThis.fetch = original;
    fs.rmSync(config, { force: true });
    fs.rmSync(pacing, { recursive: true, force: true });
  }
});
