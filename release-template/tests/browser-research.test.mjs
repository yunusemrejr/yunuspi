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

test("browser leases renew across long tasks, reserve reconciliation reads, and reject expired leases", async () => {
  const { createBrowserLease } = await load("scripts/browser-session-lease.mjs");
  let now = 0;
  const lease = createBrowserLease(() => now);
  for (let n = 0; n < 200; n++) lease.consume("click");
  assert.equal(lease.receipt().actionsRemaining, 0);
  assert.throws(() => lease.consume("fill"), /action limit/);
  for (const action of ["snapshot", "inspect", "verify", "logs", "network", "renew"]) lease.consume(action);
  now = 599_999;
  lease.renew();
  assert.equal(lease.receipt().generation, 2);
  assert.equal(lease.receipt().actionsRemaining, 200);
  now = 600_001; // Past the original process lifetime.
  lease.consume("fill");
  assert.equal(lease.receipt().actionsRemaining, 199);
  assert.equal(lease.receipt().remainingMs, 599_998);
  now = 1_199_999;
  assert.throws(() => lease.consume("snapshot"), /expired/);
  assert.throws(() => lease.renew(), /expired/);
  lease.consume("close");
  assert.equal(lease.receipt().remainingMs, 0);
});

test("renderer classifies nested transport causes without inventing network restrictions or leaking URLs", async () => {
  const { renderNavigationFailure } = await load("scripts/browser-diagnostics.mjs");
  for (const [code, kind] of [["ECONNREFUSED", "unreachable"], ["ECONNRESET", "unreachable"], ["ENOTFOUND", "dns"], ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"], ["EACCES", "access-denied"]]) {
    const error = new TypeError("fetch failed", { cause: new AggregateError([Object.assign(Error("http://private.invalid/?token=PRIVATE_VALUE"), {code})]) });
    const failure = renderNavigationFailure(error);
    assert.equal(failure.kind, kind);
    assert.deepEqual(failure.codes, [code]);
    assert.match(failure.network, /including localhost/);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_VALUE|private.invalid/);
  }
  const unknown = renderNavigationFailure(new TypeError("fetch failed"));
  assert.equal(unknown.kind, "navigation-failed");
  assert.deepEqual(unknown.codes, []);
  assert.match(unknown.reason, /cause unavailable/);
  assert.match(unknown.nextStep, /wait_for/);
  assert.equal(renderNavigationFailure(Object.assign(Error("deadline"), {name:"TimeoutError"})).kind, "timeout");
  assert.equal(renderNavigationFailure(Error("Response exceeds 5 MiB")).kind, "response-limit");
});

test("niche discovery excludes mainstream hosts and their subdomains from actual search results", async () => {
  const { parseDuckDuckGoResults } = await load("extensions/pi-web-access/duckduckgo.ts");
  const urls = ["https://old.reddit.com/r/topic", "https://www.quora.com/question", "https://twitter.com/topic", "https://x.com/topic", "https://woodworking.example.org/threads/123", "https://reddit.com.example.org/forum"];
  const html = urls.map((url, n) => `<a class="result-link" href="${url}">Venue ${n}</a>`).join("\n");
  const results = parseDuckDuckGoResults(html, { domainFilter: ["-reddit.com", "-quora.com", "-twitter.com", "-x.com"] });
  assert.deepEqual(results.map(result => result.url), urls.slice(4));
});

test("real forum workflow preserves drafts across renewal and reconciles a timed-out submit without duplicates", { timeout: 90000 }, async (t) => {
  const { registerBrowserSession } = await load("extensions/lib/browser-session.ts");
  const posts = [];
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push(Object.fromEntries(new URLSearchParams(body)));
      // Persist before deliberately withholding the response. The browser cannot
      // infer failure from its timeout; /history is the reconciliation surface.
      pending.add(res);
      res.on("close", () => pending.delete(res));
      return;
    }
    if (req.url === "/history") {
      res.end(`<h1>Pending moderation</h1><article id="receipt"><h2>Submission ${posts.length}</h2><p>Account: fixture-author</p><a href="/entry/1">Entry receipt</a></article>`);
      return;
    }
    if (req.url === "/entry/1") {
      res.end(`<h1>Pending moderation</h1><p>Account: fixture-author</p><pre id="submitted"></pre><script>document.querySelector('#submitted').textContent=${JSON.stringify(posts[0]?.answer ?? "")}</script>`);
      return;
    }
    res.end(`<!doctype html><h1>Specialist forum</h1><p>Account: fixture-author</p>
      <form method="POST" action="/submit">
      <label>Category<select name="category"><option value="general">General</option><option value="q">Questions</option><option disabled>Closed</option><option>Duplicate</option><option>Duplicate</option></select></label>
      <label>Answer<textarea name="answer" required></textarea></label>
      <label><input type="checkbox" name="disclosure" required>Disclose affiliation</label>
      <label>Password<input type="password" value="FIXTURE_PRIVATE_VALUE"></label>
      <div contenteditable="true" role="textbox" aria-label="Rich editor"></div>
      <button>Submit answer</button></form>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let tool;
  const events = {};
  registerBrowserSession({ registerTool: t => tool = t, on: (name, fn) => events[name] = fn });
  const ctx = { cwd: scratch, model: { input: ["text"] }, sessionManager: { getSessionId: () => "forum-fixture" } };
  const call = p => tool.execute("fixture", p, undefined, undefined, ctx);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let opened;
    try { opened = await call({ action: "open", url }); }
    catch (error) {
      if (process.env.PI_BROWSER_REQUIRE === "1") throw error;
      t.skip("Chromium unavailable; set PI_BROWSER_REQUIRE=1 to require it");
      return;
    }
    const session = opened.details.session;
    assert.equal(opened.details.lease.generation, 1);
    const control = { session, role: "combobox", name: "Category" };
    const options = await call({ ...control, action: "inspect" });
    assert.equal(options.details.inspection.options[1].label, "Questions");
    assert.equal(options.details.inspection.options[2].disabled, true);
    assert.equal((await call({ ...control, action: "select", option: "Closed" })).isError, true);
    assert.equal((await call({ ...control, action: "select", option: "Duplicate" })).isError, true);
    assert.equal((await call({ ...control, action: "select", option: "Questions" })).details.ok, true);
    const draft = "I maintain this tool.\nHere is the reproducible method and its limitation.";
    const editor = { session, role: "textbox", name: "Answer" };
    assert.equal((await call({ ...editor, action: "fill", text: draft })).details.ok, true);
    assert.equal((await call({ ...editor, action: "verify", text: draft + "wrong" })).details.verification.matches, false);
    assert.equal((await call({ ...editor, action: "verify", text: draft })).details.verification.matches, true);
    const secret = await call({ session, action: "verify", selector: 'input[type="password"]', text: "guess" });
    assert.equal(secret.isError, true);
    assert.doesNotMatch(JSON.stringify(secret), /FIXTURE_PRIVATE_VALUE/);
    const rich = { session, role: "textbox", name: "Rich editor" };
    assert.equal((await call({ ...rich, action: "fill", text: "A helpful comment" })).details.ok, true);
    assert.equal((await call({ ...rich, action: "verify", text: "A helpful comment" })).details.verification.matches, true);
    const checkbox = { session, action: "check", role: "checkbox", name: "Disclose affiliation", checked: true };
    assert.equal((await call(checkbox)).details.ok, true);
    assert.equal((await call(checkbox)).details.ok, true); // Desired state must not toggle off.
    const renewed = await call({ session, action: "renew" });
    assert.equal(renewed.details.lease.generation, 2);
    assert.equal(renewed.details.lease.actionsRemaining, 200);
    assert.equal((await call({ ...editor, action: "verify", text: draft })).details.verification.matches, true);
    const sent = await call({ session, action: "click", role: "button", name: "Submit answer", timeoutMs: 1000 });
    assert.equal(sent.isError, true);
    assert.equal(sent.details.failure.kind, "timeout");
    assert.match(sent.details.failure.outcome, /unknown/);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { category: "q", answer: draft.replaceAll("\n", "\r\n"), disclosure: "on" });
    await call({ session, action: "navigate", url: url + "/history" });
    assert.match(JSON.stringify(await call({ session, action: "snapshot" })), /Pending moderation/);
    await call({ session, action: "navigate", url: url + "/entry/1" });
    const receipt = await call({ session, action: "verify", selector: "#submitted", text: posts[0].answer });
    assert.equal(receipt.details.verification.matches, true);
    assert.equal(posts.length, 1, "reconciliation must not resubmit");
    await call({ session, action: "close" });
    await assert.rejects(call({ session, action: "renew" }), /Unknown or foreign/);
    assert.equal((await call({ action: "list" })).details.sessions.length, 0);
  } finally {
    await events.session_shutdown();
    for (const res of pending) res.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
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
