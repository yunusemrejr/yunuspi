import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const release = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
let agent = path.join(release, "agent");
try {
  await fs.access(agent);
} catch {
  agent = path.resolve(release, "..");
}
const modulePath = (name) =>
  path.join(agent, "extensions/lib/project-intelligence", name);
const { IntelligenceClient } = await import(
  pathToFileURL(modulePath("client.mjs"))
);
const { openStore, nodeId } = await import(
  pathToFileURL(modulePath("store.mjs"))
);
const { queryGraph, simplifyGraph } = await import(
  pathToFileURL(modulePath("query.mjs"))
);

async function fixture(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-public-intel-"));
  const cwd = path.join(temp, "project"),
    stateDir = path.join(temp, "private");
  await fs.mkdir(cwd);
  const clients = [];
  const client = () => {
    const c = new IntelligenceClient({
      cwd,
      stateDir,
      sessionId: `test-${clients.length}`,
    });
    clients.push(c);
    return c;
  };
  try {
    await run({ temp, cwd, stateDir, client });
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await fs.rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
}

test("first discovery, incremental return, source change, and private evidence boundaries", () =>
  fixture(async ({ cwd, client }) => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "portal", dependencies: { react: "1.0.0" } }),
    );
    await fs.writeFile(
      path.join(cwd, ".env"),
      "EXAMPLE_PRIVATE_VALUE=do-not-index",
    );
    const c = client();
    await c.ready;
    const pending = await c.request("query", {
      query: "architecture",
      maxChars: 400,
    });
    assert.match(pending.summary, /Initial discovery pending/);
    assert.ok(
      JSON.stringify(pending).length <= 400,
      "coverage warnings share the context budget",
    );
    const cold = await c.request("refresh");
    assert.ok(cold.stats.filesParsed > 0);
    assert.equal((await c.request("refresh")).stats.filesParsed, 0);
    const initial = await c.request("query", { query: "react" });
    assert.match(JSON.stringify(initial), /react/);
    assert.doesNotMatch(JSON.stringify(initial), /do-not-index/);
    await fs.symlink(".env", path.join(cwd, "innocent-alias.txt"));
    await assert.rejects(
      c.request("record", {
        fact: {
          entity: { type: "decision", key: "evidence-boundary" },
          description: "Project configuration observation",
          sourceFile: "innocent-alias.txt",
          quote: "EXAMPLE_PRIVATE_VALUE",
        },
      }),
      /secret project file/,
    );
    assert.equal(
      (await c.request("health")).health.conflicts.length,
      0,
      "package and folder names differ legitimately",
    );
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "portal", dependencies: { vue: "1.0.0" } }),
    );
    await c.request("refresh");
    assert.match(
      JSON.stringify(await c.request("query", { query: "vue" })),
      /vue/,
    );
  }));

test("independent workers converge, preserve manual history, reject stale writes, and recover after a crash", () =>
  fixture(async ({ cwd, client }) => {
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    const peers = Array.from({ length: 6 }, client);
    const identities = await Promise.all(peers.map((c) => c.ready));
    assert.ok(
      identities.every((x) => x.identity.id === identities[0].identity.id),
    );
    const make = (description) => ({
      entity: { type: "constraint", key: "auth" },
      predicate: "storage",
      description,
      exclusive: true,
    });
    const first = await peers[0].request("record", {
      recordId: "database",
      fact: make("PostgreSQL"),
    });
    await peers[1].request("record", {
      recordId: "database",
      fact: make("SQLite"),
    });
    assert.ok((await peers[0].request("health")).health.conflicts.length);
    await assert.rejects(
      peers[0].request("record", { recordId: "database", fact: make("Redis") }),
      (error) => error.code === "STALE_SOURCE",
    );
    await Promise.all(
      peers.map((c, i) =>
        c.request("record", {
          fact: {
            entity: { type: "decision", key: `decision-${i}` },
            description: `Preserve durable decision ${i}`,
          },
        }),
      ),
    );
    await peers[0].request("refresh");
    await peers[0].worker.terminate();
    const returning = client();
    await returning.ready;
    await returning.request("refresh");
    const db = openStore(identities[0].identity.dbPath);
    try {
      assert.equal(
        db.snapshot().nodes.filter((n) => n.type === "decision").length,
        6,
      );
      assert.ok(
        db.sources().some((s) => s.id === first.sourceId && s.active !== false),
      );
    } finally {
      db.close();
    }
    assert.match(
      JSON.stringify(
        await returning.request("query", { query: "durable decision" }),
      ),
      /Preserve durable decision/,
    );
  }));

test("large returning projects reuse evidence without reparsing or graph revisions", () =>
  fixture(async ({ cwd, client }) => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      '{"name":"large-project"}',
    );
    await fs.mkdir(path.join(cwd, "src"));
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        fs.mkdir(path.join(cwd, "src", `group-${i}`)),
      ),
    );
    // Hundreds of source receipts used to exceed the cache bound, making every
    // new session parse and rewrite the entire graph despite unchanged files.
    await Promise.all(
      Array.from({ length: 600 }, (_, i) =>
        fs.writeFile(
          path.join(
            cwd,
            "src",
            `group-${Math.floor(i / 100)}`,
            `module-${i}.ts`,
          ),
          `export const component${i} = ${i};\n`,
        ),
      ),
    );
    const first = client();
    await first.ready;
    const cold = await first.request("refresh", {}, { timeout: 30000 });
    assert.ok(cold.stats.filesParsed >= 600);
    await first.close();
    const returning = client();
    await returning.ready;
    const warm = await returning.request("refresh", {}, { timeout: 30000 });
    assert.equal(warm.stats.filesParsed, 0);
    assert.equal(warm.changed, 0);
    assert.equal(warm.revision, cold.revision);
    await fs.writeFile(
      path.join(cwd, "src", "group-0", "module-20.ts"),
      'import "./module-21";\n',
    );
    const change = await returning.request("refresh", {}, { timeout: 30000 });
    assert.equal(change.stats.filesParsed, 1);
    assert.ok(change.changed > 0);
  }));

test("source batches validate atomically and reject one stale member without partial writes", () =>
  fixture(async ({ temp }) => {
    const db = openStore(path.join(temp, "batch.sqlite"));
    const identity = {
      id: "batch",
      checkoutId: "main",
      root: temp,
      name: "Batch",
    };
    db.ensureProject(identity);
    const source = (id, version, label = id) => ({
      id,
      scope: "main",
      kind: "file",
      locator: `${id}.ts`,
      fingerprint: label,
      expectedVersion: version,
      nodes: [{ id: nodeId("component", id), type: "component", label }],
      claims: [
        {
          subject: nodeId("project", identity.id),
          predicate: "contains",
          object: nodeId("component", id),
          relation: true,
          status: "verified",
          confidence: 1,
        },
      ],
    });
    try {
      const first = db.replaceSources([source("a", 0), source("b", 0)]);
      assert.equal(first.changedCount, 2);
      assert.equal(
        db.replaceSources([source("a", 1), source("b", 1)]).changedCount,
        0,
      );
      assert.throws(
        () =>
          db.replaceSources([
            source("a", 1, "changed"),
            source("b", 0, "stale"),
          ]),
        (error) => error.code === "STALE_SOURCE",
      );
      assert.equal(db.revision(), first.revision);
      assert.equal(
        db.snapshot().nodes.find((node) => node.id === nodeId("component", "a"))
          .label,
        "a",
      );
    } finally {
      db.close();
    }
  }));

test("bounded graph traversal and 3000-node simplification preserve endpoints and center", () =>
  fixture(async ({ temp }) => {
    const db = openStore(path.join(temp, "graph.sqlite"));
    const identity = {
      id: "fixture",
      checkoutId: "main",
      root: temp,
      name: "Project",
    };
    db.ensureProject(identity);
    const center = nodeId("project", identity.id),
      nodes = Array.from({ length: 3000 }, (_, i) => ({
        id: nodeId("component", String(i)),
        type: i % 3 ? "component" : "api",
        label: `Component ${i}`,
      }));
    db.replaceSource(
      {
        id: "architecture",
        scope: "main",
        kind: "file",
        locator: "architecture.json",
        fingerprint: "1",
        nodes,
        claims: nodes.map((n, i) => ({
          subject: i ? nodes[i - 1].id : center,
          predicate: "depends_on",
          object: n.id,
          relation: true,
          status: "verified",
          confidence: 1,
        })),
      },
      { expectedVersion: 0 },
    );
    try {
      const graph = db.snapshot();
      const small = simplifyGraph(graph, { limit: 220 });
      assert.ok(small.nodes.length <= 220);
      assert.ok(small.nodes.some((n) => n.id === center));
      const ids = new Set(small.nodes.map((n) => n.id));
      assert.ok(
        small.edges.every((e) => ids.has(e.source) && ids.has(e.target)),
      );
      const result = queryGraph(graph, {
        focus: nodes[20].id,
        direction: "incoming",
        hops: 1,
        maxChars: 3000,
      });
      assert.ok(result.nodes.some((n) => n.id === nodes[19].id));
      assert.ok(JSON.stringify(result).length <= 3000);
    } finally {
      db.close();
    }
  }));

test("bundled viewer assets retain upstream license and reviewed Cytoscape bytes", async () => {
  const assets = modulePath("viewer-assets");
  assert.equal(
    createHash("sha256")
      .update(await fs.readFile(path.join(assets, "cytoscape.min.js")))
      .digest("hex"),
    "61de2fede6b3b1a08181b14acb8668abb8300834945633e647794472b0d00979",
  );
  assert.match(
    await fs.readFile(path.join(assets, "CYTOSCAPE-LICENSE"), "utf8"),
    /MIT|Permission is hereby granted/,
  );
  for (const file of ["index.html", "styles.css", "app.js"])
    assert.ok((await fs.stat(path.join(assets, file))).size > 100);
});

test("viewer server is private, reusable, and observes peer revisions", () =>
  fixture(async ({ cwd, client }) => {
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    const c = client();
    const { identity } = await c.ready;
    await c.request("refresh");
    const { openProjectViewer } = await import(
      pathToFileURL(modulePath("viewer.mjs"))
    );
    let viewer;
    try {
      viewer = await openProjectViewer({
        dbPath: identity.dbPath,
        identity,
        launch: false,
      });
      const url = new URL(viewer.url),
        base = url.origin,
        token = url.hash.slice(1);
      assert.equal((await fetch(base + "/api/snapshot")).status, 401);
      const headers = { Authorization: `Bearer ${token}` };
      assert.equal(
        (
          await fetch(base + "/api/snapshot", {
            headers: { ...headers, Origin: "https://foreign.example.invalid" },
          })
        ).status,
        403,
      );
      const initial = await fetch(base + "/api/snapshot", { headers });
      assert.equal(initial.status, 200);
      const first = await initial.json();
      assert.ok(Number.isInteger(first.revision));
      const reused = await openProjectViewer({
        dbPath: identity.dbPath,
        identity,
        launch: false,
      });
      assert.equal(reused.pid, viewer.pid);
      assert.equal(reused.url, viewer.url);
      await c.request("record", {
        fact: {
          entity: { type: "decision", key: "live" },
          description: "Live peer contribution",
        },
      });
      const updated = await (
        await fetch(base + `/api/poll?since=${first.revision}`, { headers })
      ).json();
      assert.ok(updated.revision > first.revision);
      await c.close();
      assert.equal(
        (await fetch(base + "/api/health", { headers })).status,
        200,
        "viewer survives originating session shutdown",
      );
    } finally {
      if (viewer?.pid)
        try {
          process.kill(viewer.pid, "SIGTERM");
        } catch {}
    }
  }));

test("a worker accepts process-only parent flags and exits when idle", () =>
  fixture(async ({ cwd, stateDir, temp }) => {
    const file = path.join(temp, "idle.mjs");
    await fs.writeFile(
      file,
      `import {IntelligenceClient} from ${JSON.stringify(pathToFileURL(modulePath("client.mjs")).href)};const c=new IntelligenceClient(${JSON.stringify({ cwd, stateDir, sessionId: "idle" })});await c.ready;`,
    );
    await exec(
      process.execPath,
      ["--stack-trace-limit=10", "--v8-pool-size=4", file],
      { timeout: 5000, maxBuffer: 10000 },
    );
  }));

test("automatic HTTP evidence retains known origins without path or query credentials", () =>
  fixture(async ({ client }) => {
    const c = client();
    await c.ready;
    await c.request("record", {
      fact: {
        entity: {
          type: "external",
          key: "service",
          label: "https://service.example.invalid/",
        },
        description: "Configured service endpoint",
      },
    });
    await c.request("observation", {
      url: "https://service.example.invalid/reset/PRIVATE-PATH-VALUE?token=PRIVATE-QUERY-VALUE",
      status: 503,
    });
    const result = await c.request("query", {
      query: "service",
      maxChars: 6000,
    });
    assert.match(JSON.stringify(result), /HTTP 503/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE-PATH-VALUE|PRIVATE-QUERY-VALUE/,
    );
    assert.doesNotMatch(
      JSON.stringify(await c.request("history")),
      /PRIVATE-PATH-VALUE|PRIVATE-QUERY-VALUE/,
    );
  }));

test("agents inspect and correct shared evidence across sessions without stale overwrites", () =>
  fixture(async ({ client }) => {
    const author = client(), peer = client();
    await Promise.all([author.ready, peer.ready]);
    const fact = (description, scope) => ({
      entity: { type: "constraint", key: "durable-contract", label: "Storage contract" },
      description,
      ...(scope ? { scope } : {}),
    });
    const first = await author.request("record", { fact: fact("Original evidence", "shared") });
    const inspection = await peer.request("inspect", { sourceId: first.sourceId });
    assert.equal(inspection.source.version, first.version);
    assert.ok(inspection.source.nodes.some(node => node.key === "durable-contract"));
    const corrected = await peer.request("update", {
      sourceId: first.sourceId,
      expectedVersion: inspection.source.version,
      fact: fact("Corrected evidence"),
    });
    assert.equal(corrected.sourceId, first.sourceId);
    assert.equal((await author.request("inspect", { sourceId: first.sourceId })).source.scope, "shared");
    await assert.rejects(author.request("update", {
      sourceId: first.sourceId, expectedVersion: first.version, fact: fact("Stale evidence"),
    }), error => error.code === "STALE_SOURCE" && error.currentVersion === corrected.version);
    await assert.rejects(peer.request("update", {
      sourceId: first.sourceId, fact: fact("Missing version"),
    }), /expectedVersion/);
    const focused = await author.request("inspect", { focus: "durable-contract", hops: 0 });
    assert.equal(focused.nodes.length, 1);
    assert.equal(focused.nodes[0].id, first.entityId);
    assert.match(JSON.stringify(focused), /Corrected evidence/);
    assert.doesNotMatch(JSON.stringify(focused), /Original evidence|Stale evidence/);
    const history = await author.request("history", { sourceId: first.sourceId });
    assert.ok(history.length >= 2 && history.every(row => row.sourceId === first.sourceId));
    await peer.request("retract", { sourceId: first.sourceId, expectedVersion: corrected.version });
    assert.deepEqual((await author.request("query", { query: "durable-contract" })).nodes, []);
    assert.equal((await author.request("inspect", { sourceId: first.sourceId })).source.active, false);
    assert.ok((await author.request("history", { sourceId: first.sourceId })).some(row => row.event === "source-removed"));
  }));

test("retrieval distinguishes missing evidence, directed reachability and paged matches", () => {
  const snapshot = {
    revision: 1,
    project: { id: "fixture", rootNodeId: "root", name: "Fixture" },
    nodes: Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`, key: `src/module-${i}.ts`, type: "file", label: `Module ${i}`,
      status: "inferred", confidence: 0.7,
    })),
    edges: Array.from({ length: 79 }, (_, i) => ({
      id: `e${i}`, source: `n${i + 1}`, target: `n${i}`, type: "imports", status: "inferred", confidence: 0.7,
    })),
    facts: [{ id: "fact", subject: "n20", predicate: "route", object: "/billing", provenance: [{ sourceId: "routes", locator: "routes.ts", version: 1 }] }],
    sources: [], health: { ok: true, conflicts: [], staleSources: 0 }, activity: [],
  };
  const before = JSON.stringify(snapshot);
  for (const options of [{ query: "does-not-exist" }, { focus: "missing" }]) {
    const result = queryGraph(snapshot, options);
    assert.deepEqual(result.nodes, []);
    assert.equal(result.truncated, false);
    assert.deepEqual(simplifyGraph(snapshot, options).nodes, []);
  }
  assert.equal(queryGraph(snapshot, { focus: "src/module-20.ts", hops: 0 }).nodes[0].id, "n20");
  assert.equal(queryGraph(snapshot, { query: "/billing", hops: 0 }).nodes[0].id, "n20");
  const options = { focus: "n20", direction: "incoming", hops: 2, maxChars: 6000 };
  assert.deepEqual(queryGraph(snapshot, options).nodes.map(n => [n.id, n.distance]), [["n20", 0], ["n21", 1], ["n22", 2]]);
  assert.deepEqual(simplifyGraph(snapshot, options).nodes.map(n => n.id), ["n20", "n21", "n22"]);
  assert.deepEqual(simplifyGraph(snapshot, { ...options, direction: "outgoing" }).nodes.map(n => n.id), ["n20", "n19", "n18"]);
  const first = simplifyGraph(snapshot, { types: ["file"], limit: 20 });
  const second = simplifyGraph(snapshot, { types: ["file"], limit: 20, offset: first.page.size });
  assert.equal(first.page.total, 80);
  assert.equal(first.page.hasMore, true);
  const ids = new Set(first.nodes.filter(n => !n.aggregate).map(n => n.id));
  assert.ok(second.nodes.filter(n => !n.aggregate).every(n => !ids.has(n.id)));
  assert.ok(JSON.stringify(queryGraph(snapshot, { query: "/billing", maxChars: 400 })).length <= 400);
  assert.equal(JSON.stringify(snapshot), before, "response budgets cannot mutate cached evidence");
});
