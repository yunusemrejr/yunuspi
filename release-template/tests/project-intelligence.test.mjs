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
const { queryGraph, simplifyGraph, agentBrief } = await import(
  pathToFileURL(modulePath("query.mjs"))
);

test("agent briefs preserve directed dependencies, exact keys and provenance within the context budget", () => {
  const nodes = ["target", "consumer", "dependency", "transitive"].map(
    (id) => ({ id, key: `src/${id}.ts`, label: id, type: "file" }),
  );
  const edge = (id, source, target) => ({
    id,
    source,
    target,
    type: "imports",
    status: "inferred",
    provenance: [
      {
        sourceId: "source",
        locator: `file:src/${source}.ts`,
        scope: "checkout",
      },
    ],
  });
  const graph = {
    revision: 7,
    nodes,
    edges: [
      edge("a", "consumer", "target"),
      edge("b", "target", "dependency"),
      edge("c", "transitive", "consumer"),
    ],
    facts: [],
  };
  assert.equal(typeof agentBrief, "function");
  const brief = agentBrief(graph, {
    focus: "src/target.ts",
    hops: 2,
    maxChars: 1800,
  });
  assert.ok(JSON.stringify(brief).length <= 1800);
  assert.match(brief.summary, /src\/consumer.ts -imports-> src\/target.ts/);
  assert.match(brief.summary, /src\/target.ts -imports-> src\/dependency.ts/);
  assert.match(brief.summary, /src\/transitive.ts -imports-> src\/consumer.ts/);
  assert.match(brief.summary, /inferred.*@file:src/);
  assert.match(brief.summary, /incoming.*consumers.*outgoing.*dependencies/i);
  assert.equal(brief.revision, 7);
  assert.match(
    agentBrief(graph, { focus: "missing.ts" }).summary,
    /No matching entities/,
  );
  const crowded = {
    ...graph,
    edges: Array.from({ length: 40 }, (_, i) => ({
      ...edge(String(i), "consumer", "target"),
      type: `relation-${i}`,
    })),
  };
  const small = agentBrief(crowded, { focus: "src/target.ts", maxChars: 700 });
  assert.ok(JSON.stringify(small).length <= 700);
  assert.equal(small.truncated, true);
  assert.match(small.summary, /omitted/);
});

test("model-visible briefs ignore bookkeeping revisions and anonymous container labels", () => {
  const node = (id) => ({ id, key: `src/${id}.ts`, label: id, type: "file" });
  const edge = (id, source, target) => ({
    id,
    source,
    target,
    type: "imports",
    status: "inferred",
    provenance: [
      {
        sourceId: "source",
        locator: `file:src/${source}.ts`,
        scope: "checkout",
      },
    ],
  });
  const graph = (revision) => ({
    revision,
    nodes: [node("target"), node("consumer")],
    edges: [edge("a", "consumer", "target")],
    facts: [],
  });
  const options = { focus: "src/target.ts", hops: 2, maxChars: 1800 };
  const first = agentBrief(graph(7), options);
  const later = agentBrief(graph(196), options);
  // The brief is re-sent on every provider request, so a bookkeeping revision
  // bump with unchanged evidence must not change its bytes.
  assert.equal(later.summary, first.summary);
  assert.doesNotMatch(first.summary, /revision/);
  assert.equal(later.revision, 196, "the structured revision stays available");
  // Degenerate overflow path: even when nothing fits, the summary stays
  // revision-free — it is re-sent on every request and the revision lives on
  // the structured result only.
  const cramped = agentBrief(graph(199), { ...options, maxChars: 1 });
  assert.doesNotMatch(cramped.summary, /revision/);
  assert.equal(cramped.revision, 199);
  // Negative control: changed evidence still changes the brief.
  const grown = graph(197);
  grown.nodes.push(node("dependency"));
  grown.edges.push(edge("b", "target", "dependency"));
  assert.notEqual(agentBrief(grown, options).summary, first.summary);
  // A session-scoped container id is bookkeeping: the label shows the usable
  // tail (`crypto`), never the anonymous uuid the model cannot act on.
  const anonymous = {
    revision: 1,
    nodes: [
      node("target"),
      {
        id: "other",
        key: "9a85aae4-3775-4d67-a1c3-32fe9dfdd474:dependency:crypto",
        label: "crypto",
        type: "dependency",
      },
    ],
    edges: [
      {
        id: "c",
        source: "target",
        target: "other",
        type: "imports",
        status: "inferred",
        provenance: [],
      },
    ],
    facts: [],
  };
  const anonymousBrief = agentBrief(anonymous, options);
  assert.match(anonymousBrief.summary, /src\/target\.ts -imports-> crypto/);
  assert.doesNotMatch(anonymousBrief.summary, /9a85aae4/);
  // Historical rows for self-generated copies survive a scan exclusion, so the
  // query path drops them too: they are not current dependencies.
  const residue = {
    revision: 2,
    nodes: [
      node("target"),
      {
        id: "residue",
        key: "agent/artifacts/old-audit/README.md",
        label: "old-audit",
        type: "file",
      },
      {
        id: "backup",
        key: "agent/backups/copy/src/helper.ts",
        label: "helper",
        type: "file",
      },
    ],
    edges: [
      {
        id: "r1",
        source: "target",
        target: "residue",
        type: "imports",
        status: "inferred",
        provenance: [
          {
            sourceId: "s",
            locator: "file:agent/artifacts/old-audit/README.md",
            scope: "checkout",
          },
        ],
      },
      {
        id: "r2",
        source: "target",
        target: "backup",
        type: "imports",
        status: "inferred",
        provenance: [
          {
            sourceId: "s",
            locator: "file:agent/backups/copy/src/helper.ts",
            scope: "checkout",
          },
        ],
      },
    ],
    facts: [],
  };
  const residueBrief = agentBrief(residue, options);
  assert.doesNotMatch(residueBrief.summary, /artifacts|backups/);
  // Negative control: the same graph without generated copies keeps its edges.
  assert.match(
    agentBrief(
      {
        ...residue,
        nodes: [node("target"), node("dependency")],
        edges: [edge("b", "target", "dependency")],
      },
      options,
    ).summary,
    /src\/target\.ts -imports-> src\/dependency\.ts/,
  );
  // Identical evidence must render once: distinct edge ids with the same
  // relation/status/provenance are one line, not five.
  const repeated = {
    revision: 3,
    nodes: [node("target"), node("consumer"), node("dependency")],
    edges: [
      edge("a1", "consumer", "target"),
      edge("a2", "consumer", "target"),
      edge("a3", "consumer", "target"),
      edge("b", "target", "dependency"),
    ],
    facts: [],
  };
  const repeatedSummary = agentBrief(repeated, options).summary;
  const occurrences =
    repeatedSummary.split("src/consumer.ts -imports-> src/target.ts").length -
    1;
  assert.equal(occurrences, 1);
  assert.match(
    repeatedSummary,
    /src\/target\.ts -imports-> src\/dependency\.ts/,
  );
});

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

test("snapshot keeps one provenance entry per source when an edge is observed repeatedly", () =>
  fixture(async ({ temp }) => {
    const db = openStore(path.join(temp, "provenance.sqlite"));
    const identity = { id: "provenance", checkoutId: "main", root: temp, name: "Provenance" };
    db.ensureProject(identity);
    const source = nodeId("file", "src/source.ts");
    const target = nodeId("file", "src/target.ts");
    const make = (id, fingerprint) => ({
      id,
      scope: "main",
      kind: "file",
      locator: `${id}.json`,
      fingerprint,
      nodes: [
        { id: source, type: "file", key: "src/source.ts", label: "source" },
        { id: target, type: "file", key: "src/target.ts", label: "target" },
      ],
      claims: [{ subject: source, predicate: "imports", object: target, relation: true }],
    });
    try {
      db.replaceSources([make("one", "one"), make("two", "two")]);
      const edge = db.snapshot().edges.find(item => item.source === source && item.target === target);
      assert.equal(edge.provenance.length, 2);
      assert.deepEqual(edge.provenance.map(item => item.sourceId).sort(), ["one", "two"]);
    } finally {
      db.close();
    }
  }));

test("a cancellation observed while a request is queued prevents worker dispatch", () =>
  fixture(async ({ client }) => {
    const c = client();
    await c.ready;
    const signal = {
      aborted: false,
      reason: Error("queued request cancelled"),
      throwIfAborted() {},
      addEventListener(_name, listener) {
        this.aborted = true;
        listener();
      },
      removeEventListener() {},
    };
    await assert.rejects(c.request("health", {}, { signal }), /queued request cancelled/);
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
    const author = client(),
      peer = client();
    await Promise.all([author.ready, peer.ready]);
    const fact = (description, scope) => ({
      entity: {
        type: "constraint",
        key: "durable-contract",
        label: "Storage contract",
      },
      description,
      ...(scope ? { scope } : {}),
    });
    const first = await author.request("record", {
      fact: fact("Original evidence", "shared"),
    });
    const inspection = await peer.request("inspect", {
      sourceId: first.sourceId,
    });
    assert.equal(inspection.source.version, first.version);
    assert.ok(
      inspection.source.nodes.some((node) => node.key === "durable-contract"),
    );
    const corrected = await peer.request("update", {
      sourceId: first.sourceId,
      expectedVersion: inspection.source.version,
      fact: fact("Corrected evidence"),
    });
    assert.equal(corrected.sourceId, first.sourceId);
    assert.equal(
      (await author.request("inspect", { sourceId: first.sourceId })).source
        .scope,
      "shared",
    );
    await assert.rejects(
      author.request("update", {
        sourceId: first.sourceId,
        expectedVersion: first.version,
        fact: fact("Stale evidence"),
      }),
      (error) =>
        error.code === "STALE_SOURCE" &&
        error.currentVersion === corrected.version,
    );
    await assert.rejects(
      peer.request("update", {
        sourceId: first.sourceId,
        fact: fact("Missing version"),
      }),
      /expectedVersion/,
    );
    const focused = await author.request("inspect", {
      focus: "durable-contract",
      hops: 0,
    });
    assert.equal(focused.nodes.length, 1);
    assert.equal(focused.nodes[0].id, first.entityId);
    assert.match(JSON.stringify(focused), /Corrected evidence/);
    assert.doesNotMatch(
      JSON.stringify(focused),
      /Original evidence|Stale evidence/,
    );
    const history = await author.request("history", {
      sourceId: first.sourceId,
    });
    assert.ok(
      history.length >= 2 &&
        history.every((row) => row.sourceId === first.sourceId),
    );
    await peer.request("retract", {
      sourceId: first.sourceId,
      expectedVersion: corrected.version,
    });
    assert.deepEqual(
      (await author.request("query", { query: "durable-contract" })).nodes,
      [],
    );
    assert.equal(
      (await author.request("inspect", { sourceId: first.sourceId })).source
        .active,
      false,
    );
    assert.ok(
      (await author.request("history", { sourceId: first.sourceId })).some(
        (row) => row.event === "source-removed",
      ),
    );
  }));

test("entity inspection exposes declaration provenance from the graph snapshot, with scope and hard output bounds", () =>
  fixture(async ({ client }) => {
    const c = client(), info = await c.ready;
    const store = openStore(info.identity.dbPath);
    const id = nodeId("component", "standalone-module");
    const source = (name, scope, options = {}) => ({
      id: name, scope, kind: "file", locator: `file:src/${name}.js`, fingerprint: name,
      nodes: [{ id, type: "component", key: "standalone-module", label: "Standalone module", status: "inferred", confidence: 0.65 }],
      claims: [], ...options,
    });
    try {
      store.replaceSource(source("local-declaration", info.identity.checkoutId));
      store.replaceSource(source("foreign-declaration", "another-checkout"));
      store.replaceSource(source("expired-declaration", info.identity.checkoutId, { expiresAt: Date.now() - 1000 }));
      const options = { focus: "standalone-module", hops: 0, maxChars: 6000 };
      const inspected = await c.request("inspect", options);
      assert.equal(inspected.nodes.length, 1);
      assert.equal(inspected.edges.length, 0);
      assert.equal(inspected.facts.length, 0);
      assert.equal(inspected.nodes[0].status, "inferred");
      assert.equal(inspected.nodes[0].confidence, 0.65);
      assert.deepEqual(inspected.nodes[0].provenance.map(p => p.sourceId), ["local-declaration"]);
      assert.equal(inspected.nodes[0].provenance[0].version, 1);
      assert.equal(inspected.nodes[0].provenance[0].scope, info.identity.checkoutId);
      assert.match(inspected.nodes[0].provenance[0].observedAt, /^\d{4}-/);
      assert.equal(inspected.revision, store.revision());
      assert.doesNotMatch(JSON.stringify(inspected), /foreign-declaration|expired-declaration/);
      assert.equal((await c.request("query", options)).nodes[0].provenance, undefined, "ordinary queries do not pay for declaration inspection");
      const all = await c.request("inspect", { ...options, allScopes: true, includeInactive: true });
      assert.deepEqual(all.nodes[0].provenance.map(p => p.sourceId), ["expired-declaration", "foreign-declaration", "local-declaration"]);
      for (let i = 0; i < 12; i++) store.replaceSource(source(`extra-${i}`, info.identity.checkoutId));
      const crowded = await c.request("inspect", options);
      assert.equal(crowded.truncated, true);
      assert.ok(crowded.nodes[0].provenance.length <= 8);
      for (const maxChars of [400, 700, 1800, 6000]) {
        const bounded = await c.request("inspect", { ...options, maxChars });
        assert.ok(JSON.stringify(bounded).length <= maxChars, `inspection exceeds ${maxChars} characters`);
      }
    } finally { store.close(); }
  }));

test("retrieval distinguishes missing evidence, directed reachability and paged matches", () => {
  const snapshot = {
    revision: 1,
    project: { id: "fixture", rootNodeId: "root", name: "Fixture" },
    nodes: Array.from({ length: 80 }, (_, i) => ({
      id: `n${i}`,
      key: `src/module-${i}.ts`,
      type: "file",
      label: `Module ${i}`,
      status: "inferred",
      confidence: 0.7,
    })),
    edges: Array.from({ length: 79 }, (_, i) => ({
      id: `e${i}`,
      source: `n${i + 1}`,
      target: `n${i}`,
      type: "imports",
      status: "inferred",
      confidence: 0.7,
    })),
    facts: [
      {
        id: "fact",
        subject: "n20",
        predicate: "route",
        object: "/billing",
        provenance: [{ sourceId: "routes", locator: "routes.ts", version: 1 }],
      },
    ],
    sources: [],
    health: { ok: true, conflicts: [], staleSources: 0 },
    activity: [],
  };
  const before = JSON.stringify(snapshot);
  for (const options of [{ query: "does-not-exist" }, { focus: "missing" }]) {
    const result = queryGraph(snapshot, options);
    assert.deepEqual(result.nodes, []);
    assert.equal(result.truncated, false);
    assert.deepEqual(simplifyGraph(snapshot, options).nodes, []);
  }
  assert.equal(
    queryGraph(snapshot, { focus: "src/module-20.ts", hops: 0 }).nodes[0].id,
    "n20",
  );
  assert.equal(
    queryGraph(snapshot, { query: "/billing", hops: 0 }).nodes[0].id,
    "n20",
  );
  const options = {
    focus: "n20",
    direction: "incoming",
    hops: 2,
    maxChars: 6000,
  };
  assert.deepEqual(
    queryGraph(snapshot, options).nodes.map((n) => [n.id, n.distance]),
    [
      ["n20", 0],
      ["n21", 1],
      ["n22", 2],
    ],
  );
  assert.deepEqual(
    simplifyGraph(snapshot, options).nodes.map((n) => n.id),
    ["n20", "n21", "n22"],
  );
  assert.deepEqual(
    simplifyGraph(snapshot, { ...options, direction: "outgoing" }).nodes.map(
      (n) => n.id,
    ),
    ["n20", "n19", "n18"],
  );
  const first = simplifyGraph(snapshot, { types: ["file"], limit: 20 });
  const second = simplifyGraph(snapshot, {
    types: ["file"],
    limit: 20,
    offset: first.page.size,
  });
  assert.equal(first.page.total, 80);
  assert.equal(first.page.hasMore, true);
  const ids = new Set(first.nodes.filter((n) => !n.aggregate).map((n) => n.id));
  assert.ok(
    second.nodes.filter((n) => !n.aggregate).every((n) => !ids.has(n.id)),
  );
  assert.ok(
    JSON.stringify(queryGraph(snapshot, { query: "/billing", maxChars: 400 }))
      .length <= 400,
  );
  assert.equal(
    JSON.stringify(snapshot),
    before,
    "response budgets cannot mutate cached evidence",
  );
});

test("an unscoped agent query returns a category-diverse overview like the viewer", () => {
  const nodes = [{ id: "proj", type: "project", label: "P", key: "p" }];
  const types = [
    ...Array.from({ length: 12 }, () => "file"),
    "dependency",
    "pipeline",
    "database",
    "decision",
    "api",
    "configuration",
    "external",
  ];
  types.forEach((type, i) =>
    nodes.push({ id: `n${i}`, type, label: `${type}${i}`, key: `k${i}` }),
  );
  // One high-level member is disconnected: overviews still surface it.
  nodes.push({
    id: "orphan",
    type: "constraint",
    label: "orphan",
    key: "orphan",
  });
  const edges = types.map((type, i) => ({
    id: `e${i}`,
    source: "proj",
    target: `n${i}`,
    type: "contains",
    status: "verified",
  }));
  const snapshot = {
    revision: 3,
    project: { rootNodeId: "proj" },
    nodes,
    edges,
    facts: [],
    sources: [],
    health: {},
    activity: [],
  };
  const overview = queryGraph(snapshot, { limit: 10, maxChars: 6000 });
  assert.equal(overview.nodes[0].id, "proj");
  const seen = new Set(overview.nodes.map((node) => node.type));
  for (const type of [
    "dependency",
    "pipeline",
    "database",
    "decision",
    "api",
    "configuration",
    "external",
    "constraint",
  ])
    assert.ok(seen.has(type), `overview reserves ${type}`);
  assert.ok(
    overview.nodes.filter((node) => node.type === "file").length <= 1,
    "implementation files cannot crowd out the map",
  );
  assert.equal(overview.truncated, true);
  // Focusing the project node is the same overview; explicit filters stay exact.
  assert.deepEqual(
    queryGraph(snapshot, { focus: "proj", limit: 10, maxChars: 6000 }).nodes.map(
      (node) => node.id,
    ),
    overview.nodes.map((node) => node.id),
  );
  const filtered = queryGraph(snapshot, {
    types: ["file"],
    limit: 8,
    maxChars: 6000,
  });
  assert.ok(filtered.nodes.length > 0);
  assert.ok(filtered.nodes.every((node) => node.type === "file"));
  // Reachable members keep traversal distance; disconnected ones omit it.
  const wide = queryGraph(snapshot, { limit: 40, maxChars: 20000 });
  const orphan = wide.nodes.find((node) => node.id === "orphan");
  assert.ok(orphan, "disconnected categories stay visible");
  assert.ok(!("distance" in orphan));
  assert.equal(wide.nodes.find((node) => node.id === "proj").distance, 0);
});

test("health reports entity and relationship shape for orientation", () =>
  fixture(async ({ cwd, client }) => {
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "shaped", dependencies: { react: "1.0.0" } }),
    );
    await fs.mkdir(path.join(cwd, "src"));
    await fs.writeFile(
      path.join(cwd, "src", "index.ts"),
      'import "./helper";\n',
    );
    await fs.writeFile(path.join(cwd, "src", "helper.ts"), "export {};\n");
    const c = client();
    await c.ready;
    await c.request("refresh");
    const { health, shape } = await c.request("health");
    assert.ok(health.nodeCount >= 3);
    assert.equal(typeof shape.byType.file, "number");
    assert.ok(shape.byType.file >= 2);
    assert.equal(shape.byType.project, 1);
    assert.ok(Object.keys(shape.byRelation).length > 0);
    assert.ok(
      Object.values(shape.byRelation).every(
        (count) => Number.isInteger(count) && count > 0,
      ),
    );
  }));
