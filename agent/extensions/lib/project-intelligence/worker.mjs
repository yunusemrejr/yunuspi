import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveProjectIdentity } from "./identity.mjs";
import { openStore, nodeId } from "./store.mjs";
import { queryGraph, simplifyGraph, agentBrief } from "./query.mjs";
import { discoverProject } from "./discovery.mjs";
import { discoverContinuity } from "./continuity.mjs";
import { safeText, secretFile } from "./privacy.mjs";
import {
  buildChangeProvenance,
  buildReviewProvenance,
  changeRecordKey,
  normalizeWorkflow,
} from "./workflow-record.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function compactStats(stats) {
  return Object.fromEntries(
    Object.entries(stats).flatMap(([key, value]) =>
      Array.isArray(value)
        ? [
            [key, value.slice(0, 8)],
            [`${key}Count`, value.length],
          ]
        : [[key, value]],
    ),
  );
}
const owner = randomUUID(),
  controllers = new Map();
let identity,
  store,
  refreshing,
  closed = false,
  cache;
const bootstrap = (async () => {
  try {
    identity = await resolveProjectIdentity(workerData.cwd, {
      stateDir: workerData.stateDir,
    });
  } catch (error) {
    error.message = `Project identity: ${error.message}`;
    throw error;
  }
  try {
    store = openStore(identity.dbPath);
    store.ensureProject(identity);
  } catch (error) {
    error.message = `Project store: ${error.message}`;
    throw error;
  }
  return identity;
})();
bootstrap.catch(() => {});
function snapshot(all = false, includeInactive = false) {
  const revision = store.revision(),
    key = `${all ? "all" : identity.checkoutId}:${includeInactive}`;
  if (
    !cache ||
    cache.revision !== revision ||
    cache.key !== key ||
    Date.now() - cache.at > 5000
  )
    cache = {
      revision,
      key,
      at: Date.now(),
      value: store.snapshot({ ...(all ? {} : { scope: identity.checkoutId }), includeInactive }),
    };
  return cache.value;
}
async function refresh({ paths, force = false } = {}, signal) {
  if (refreshing) {
    await refreshing;
    return force || paths?.length
      ? refresh({ paths, force }, signal)
      : { revision: store.revision(), joined: true };
  }
  refreshing = (async () => {
    const freshIdentity = await resolveProjectIdentity(workerData.cwd, {
      stateDir: workerData.stateDir,
      signal,
    });
    if (freshIdentity.id !== identity.id) {
      store.deleteActivity(workerData.sessionId);
      store.close();
      store = openStore(freshIdentity.dbPath);
      cache = undefined;
    }
    identity = freshIdentity;
    store.ensureProject(identity);
    const lease = `discovery:${identity.checkoutId}`;
    if (!store.claimLease(lease, owner, 30000))
      return { busy: true, identity, revision: store.revision() };
    const leaseAbort = new AbortController();
    signal = signal
      ? AbortSignal.any([signal, leaseAbort.signal])
      : leaseAbort.signal;
    const renewal = setInterval(() => {
      try {
        if (!store.renewLease(lease, owner, 30000))
          leaseAbort.abort(Error("Discovery lease lost."));
      } catch (error) {
        leaseAbort.abort(error);
      }
    }, 10000);
    renewal.unref();
    try {
      const before = store.sources(identity.checkoutId);
      const metadata = store.getMeta(`discovery:${identity.checkoutId}`) ?? {};
      const found = await discoverProject(identity, {
        previousSources: before,
        metadata,
        paths,
        force,
        signal,
      });
      const continuity = await discoverContinuity(identity, before, { signal });
      let changed = 0,
        stale = 0;
      const versions = new Map(
        before.map((source) => [source.id, source.version]),
      );
      const batch = [...found.sources, ...continuity.sources].map((source) => ({
        ...source,
        expectedVersion: source.expectedVersion ?? versions.get(source.id) ?? 0,
      }));
      signal?.throwIfAborted();
      if (!closed) {
        try {
          changed = store.replaceSources(batch).changedCount;
        } catch (error) {
          if (error.code !== "STALE_SOURCE") throw error;
          // A rare race rolls the batch back. Preserve newer sources and still
          // apply independent evidence using the same per-source CAS contract.
          for (const source of batch) {
            signal?.throwIfAborted();
            try {
              if (
                store.replaceSource(source, {
                  expectedVersion: source.expectedVersion,
                }).changed
              )
                changed++;
            } catch (error) {
              if (error.code === "STALE_SOURCE") stale++;
              else throw error;
            }
          }
        }
      }
      for (const id of [
        ...found.removedSourceIds,
        ...continuity.removedSourceIds,
      ]) {
        signal?.throwIfAborted();
        const old = before.find((x) => x.id === id);
        if (!old) continue;
        try {
          store.removeSource(id, { expectedVersion: old.version });
          changed++;
        } catch (error) {
          if (error.code === "STALE_SOURCE") stale++;
          else throw error;
        }
      }
      store.setMeta(`discovery:${identity.checkoutId}`, found.metadata);
      store.setMeta(`discovery-stats:${identity.checkoutId}`, {
        ...compactStats(found.stats),
        changed,
        stale,
        at: Date.now(),
      });
      store.maintain();
      cache = undefined;
      return {
        identity,
        revision: store.revision(),
        changed,
        stale,
        stats: compactStats(found.stats),
      };
    } catch (error) {
      if (!closed)
        try {
          store.setMeta(`discovery-stats:${identity.checkoutId}`, {
            ...(store.getMeta(`discovery-stats:${identity.checkoutId}`) ?? {}),
            lastError: safeText(error.message, 180),
            failedAt: Date.now(),
          });
        } catch {}
      throw error;
    } finally {
      clearInterval(renewal);
      store.releaseLease(lease, owner);
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = undefined;
  }
}
function entity(input) {
  if (
    !input ||
    typeof input.type !== "string" ||
    !/^[a-z][a-z0-9_-]{0,39}$/.test(input.type) ||
    typeof input.key !== "string" ||
    !input.key.trim() ||
    input.key.length > 256
  )
    throw Error(
      "Entity requires a short type and stable key (up to 256 characters).",
    );
  const key = safeText(input.key, 256),
    label = safeText(input.label ?? input.key, 120);
  if (!label || label.includes("[redacted]") || key.includes("[redacted]"))
    throw Error("Do not store credentials in project intelligence.");
  return { id: nodeId(input.type, key), type: input.type, key, label };
}
async function record(payload, signal) {
  const input = payload.fact ?? {},
    subject = entity(input.entity),
    target = input.target ? entity(input.target) : undefined;
  const text = safeText(input.description ?? "", 600);
  if (!text && !target)
    throw Error("A description or relationship target is required.");
  if (text.includes("[redacted]"))
    throw Error("Do not store credentials in project intelligence.");
  const predicate = safeText(
    input.predicate ?? (target ? "related_to" : "description"),
    60,
  );
  if (!/^[a-z][a-z0-9_-]{0,59}$/.test(predicate))
    throw Error("Use a short relationship/property name.");
  const status = ["inferred", "assumed", "historical", "temporary"].includes(
    input.status,
  )
    ? input.status
    : "inferred";
  const confidence = Math.min(
    status === "assumed" ? 0.5 : 0.9,
    Math.max(0, Number.isFinite(input.confidence) ? input.confidence : 0.6),
  );
  let evidence = "";
  if (input.sourceFile) {
    if (typeof input.sourceFile !== "string" || secretFile(input.sourceFile))
      throw Error("Source evidence must be a non-secret project file.");
    const file = await fs.realpath(
      path.resolve(identity.root, input.sourceFile),
    );
    const rel = path.relative(identity.root, file);
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel))
      throw Error("Source evidence is outside this project.");
    if (secretFile(rel))
      throw Error("Source evidence resolves to a secret project file.");
    const before = await fs.lstat(file);
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 262144 ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino
      )
        throw Error("Evidence file exceeds 256 KiB or is not regular.");
      const bytes = Buffer.alloc(Math.min(stat.size + 1, 262145));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 262144)
        throw Error("Evidence file grew beyond the bound.");
      const after = await handle.stat();
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw Error(
          "Evidence file changed during observation; retry with current evidence.",
        );
      const content = bytes.subarray(0, bytesRead).toString("utf8");
      if (
        !input.quote ||
        typeof input.quote !== "string" ||
        input.quote.length > 600 ||
        !content.includes(input.quote)
      )
        throw Error(
          "Provide a verbatim evidence quote (up to 600 characters) found in sourceFile.",
        );
      const line = content.slice(0, content.indexOf(input.quote)).split("\n").length;
      evidence = `; file:${rel}:${line} sha256:${hash(content).slice(0, 16)}`;
    } finally {
      await handle.close();
    }
  }
  signal?.throwIfAborted();
  const localId =
    payload.recordId ??
    hash(JSON.stringify([subject.id, predicate, target?.id ?? text])).slice(
      0,
      24,
    );
  if (typeof localId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(localId))
    throw Error("Invalid recordId.");
  const id = localId.startsWith("agent:")
    ? localId
    : `agent:${workerData.sessionId}:${localId}`;
  const previous = store.sources().find((s) => s.id === id);
  if (previous && previous.scope !== identity.checkoutId && previous.scope !== "shared")
    throw Error("Record belongs to another checkout; correct it from that checkout.");
  if (payload.action === "update" && !previous)
    throw Error("Record no longer exists. Inspect its source before updating.");
  const expected =
    payload.expectedVersion ??
    ([hash(JSON.stringify([input, evidence])), hash(JSON.stringify(input))].includes(previous?.fingerprint)
      ? previous.version
      : 0);
  const root = nodeId("project", identity.id);
  const claims = [
    {
      subject: root,
      predicate: "knows",
      object: subject.id,
      relation: true,
      status,
      confidence,
    },
    {
      subject: subject.id,
      predicate,
      object: target?.id ?? text,
      relation: !!target,
      status,
      confidence,
      exclusive: !!input.exclusive,
    },
  ];
  if (target && text)
    claims.push({
      subject: subject.id,
      predicate: "description",
      object: text,
      relation: false,
      status,
      confidence,
    });
  const source = {
    id,
    scope: input.scope === "shared" ? "shared" : input.scope === "checkout" ? identity.checkoutId : previous?.scope ?? identity.checkoutId,
    kind: "agent",
    locator: `session:${safeText(workerData.sessionId, 80)}${evidence}`,
    fingerprint: hash(JSON.stringify([input, evidence])),
    nodes: [subject, ...(target ? [target] : [])],
    claims,
    ...(status === "temporary"
      ? {
          expiresAt:
            Date.now() +
            Math.min(168, Math.max(1, Number(input.expiresHours) || 24)) *
              3600000,
        }
      : {}),
  };
  const result = store.replaceSource(source, { expectedVersion: expected });
  cache = undefined;
  return {
    ...result,
    sourceId: id,
    entityId: subject.id,
    ...(target ? { targetId: target.id } : {}),
    version: store.sources().find((s) => s.id === id)?.version,
    status,
    provenance: source.locator,
  };
}
async function run(op, payload, signal) {
  await bootstrap;
  signal?.throwIfAborted();
  switch (op) {
    case "init":
      return {
        identity,
        revision: store.revision(),
        overview: queryGraph(snapshot(), { limit: 8, maxChars: 1100 }),
      };
    case "refresh":
      return refresh(payload, signal);
    case "inspect":
      if (payload.sourceId) {
        const source = store.source(payload.sourceId, { scope: payload.allScopes ? undefined : identity.checkoutId, limit: payload.limit });
        if (!source) throw Error("Source not found in this checkout. Use allScopes only to inspect another checkout.");
        while (JSON.stringify(source).length > 10000 && source.claims.length) { source.claims.pop(); source.truncated = true; }
        while (JSON.stringify(source).length > 10000 && source.nodes.length) { source.nodes.pop(); source.truncated = true; }
        return { revision: store.revision(), source, next: source.kind === "agent" ? "Correct with update: sourceId, expectedVersion=source.version and the complete replacement fact. Retract uses the same version." : "Source-owned evidence: refresh the source file instead of editing its claims." };
      }
      if (!payload.focus) throw Error("Inspect requires focus (entity ID or exact key) or sourceId.");
      payload = { ...payload, hops: payload.hops ?? 1 };
      // fall through to the shared bounded query
    case "brief":
    case "query": {
      const stats = store.getMeta(`discovery-stats:${identity.checkoutId}`);
      const caveat = !stats?.at
        ? "Initial discovery pending. "
        : stats.lastError
          ? "Refresh incomplete; previous evidence retained. "
          : stats.truncated || stats.coverageComplete === false
            ? "Partial discovery; absence is not proof of no dependency. "
            : Date.now() - stats.at > 86400000
              ? "Evidence has not refreshed in over a day. "
              : "";
      const graph = snapshot(payload.allScopes === true, payload.includeInactive === true);
      if (op === "brief") return agentBrief(graph, {
        ...payload, query: safeText(payload.query ?? "", 1000), caveat,
        maxChars: Math.min(6000, Math.max(400, payload.maxChars ?? 1800)),
      });
      const result = queryGraph(graph, {
        ...payload,
        query: safeText(payload.query ?? "", 1000),
        // Coverage warnings share the hard response budget with the subgraph.
        maxChars:
          Math.min(6000, Math.max(400, payload.maxChars ?? 6000)) -
          caveat.length,
        limit: Math.min(40, payload.limit ?? 16),
      });
      if (caveat) result.summary = caveat + result.summary;
      return result;
    }
    case "view":
      return simplifyGraph(store.snapshot(), payload);
    case "health":
      return {
        project: identity,
        revision: store.revision(),
        health: store.snapshot({ scope: payload.allScopes ? undefined : identity.checkoutId }).health,
        discovery: store.getMeta(`discovery-stats:${identity.checkoutId}`),
      };
    case "history":
      return store.history({ limit: Math.min(30, payload.limit ?? 20), sourceId: payload.sourceId, scope: payload.allScopes ? undefined : identity.checkoutId });
    case "review_history": {
      const workflow = normalizeWorkflow(payload.workflow, {
        identity,
        sessionId: workerData.sessionId,
      });
      const history = store.reviewHistory(
        identity.checkoutId,
        workerData.sessionId,
        payload.samples,
      );
      if (!workflow || !Array.isArray(payload.samples) || payload.samples.length === 0)
        return history;
      const knownNodes = snapshot().nodes;
      const linked = [];
      for (const sample of payload.samples) {
        const provenance = buildReviewProvenance({
          workflow,
          sample,
          existingNodes: knownNodes,
        });
        const sourceId = `session-review:${safeText(workerData.sessionId, 80)}:${provenance.identity.slice(0, 24)}:${provenance.aspect}`;
        const old = store.sources().find((source) => source.id === sourceId);
        const source = {
          id: sourceId,
          scope: identity.checkoutId,
          kind: "session",
          locator: `session-review:${provenance.identity}:${provenance.aspect}`,
          fingerprint: hash(JSON.stringify([provenance.identity, provenance.aspect, provenance.outcome, provenance.claims])),
          nodes: provenance.nodes,
          claims: provenance.claims,
        };
        const result = store.replaceSource(source, {
          expectedVersion: old?.version ?? 0,
        });
        linked.push({ aspect: provenance.aspect, ...result });
      }
      cache = undefined;
      // Preserve the long-standing review_history response (an array of prior
      // category observations). Graph linkage is visible through query/history
      // and never changes this caller-facing shape.
      return history;
    }
    case "update":
      if (typeof payload.sourceId !== "string" || !payload.sourceId.startsWith("agent:") || !Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1)
        throw Error("Update requires an agent sourceId, its observed expectedVersion and a complete replacement fact. Inspect first.");
      return record({ ...payload, action: "update", recordId: payload.sourceId }, signal);
    case "record":
      return record(payload, signal);
    case "observation": {
      // Network observations enrich already-known project endpoints. Arbitrary
      // research browsing must not become durable project architecture.
      if (
        !Number.isInteger(payload.status) ||
        payload.status < 100 ||
        payload.status > 599
      )
        return { changed: false };
      let url;
      try {
        url = new URL(payload.url);
      } catch {
        return { changed: false };
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return { changed: false };
      // Paths can contain reset links, signed objects or opaque credentials.
      // Retain only the already-known origin; no URL path/query/fragment enters
      // source IDs, fingerprints, provenance, history or model context.
      const endpoint = url.origin;
      const graph = snapshot();
      const known = graph.nodes.find((n) =>
        [
          n.label,
          n.key,
          ...graph.facts.filter((f) => f.subject === n.id).map((f) => f.object),
        ].some((value) => {
          if (typeof value !== "string") return false;
          try {
            const candidate = new URL(value);
            return candidate.origin === url.origin;
          } catch {
            return false;
          }
        }),
      );
      if (!known) return { changed: false };
      const id = `observation:${identity.checkoutId}:${hash(endpoint).slice(0, 24)}`,
        old = store.sources(identity.checkoutId).find((s) => s.id === id);
      const source = {
        id,
        scope: identity.checkoutId,
        kind: "deployment",
        locator: `http-observation:${safeText(endpoint, 300)}`,
        fingerprint: hash(
          `${endpoint}:${payload.status}:${Math.floor(Date.now() / 60000)}`,
        ),
        expiresAt: Date.now() + 86400000,
        nodes: [],
        claims: [
          {
            subject: known.id,
            predicate: "http_observation",
            object: `A request to ${safeText(endpoint, 300)} returned HTTP ${payload.status}; this does not establish deployment health.`,
            relation: false,
            status: "temporary",
            confidence: 1,
          },
        ],
      };
      cache = undefined;
      return store.replaceSource(source, {
        expectedVersion: old?.version ?? 0,
      });
    }
    case "retract": {
      if (
        typeof payload.sourceId !== "string" ||
        !payload.sourceId.startsWith("agent:") ||
        !Number.isSafeInteger(payload.expectedVersion)
      )
        throw Error(
          "Retract requires an agent sourceId and its observed expectedVersion. Refresh file/Git evidence instead.",
        );
      const source = store.source(payload.sourceId, { scope: identity.checkoutId, limit: 1 });
      if (!source) throw Error("Agent source not found in this checkout.");
      const result = store.removeSource(payload.sourceId, {
        expectedVersion: payload.expectedVersion,
      });
      cache = undefined;
      return result;
    }
    case "activity":
      store.setActivity({
        id: workerData.sessionId,
        checkoutId: identity.checkoutId,
        label: payload.label ?? `Session ${workerData.sessionId.slice(0, 8)}`,
        files: (payload.files ?? []).slice(0, 12).map((x) => safeText(x, 240)),
        state: payload.state ?? "working",
        expiresAt: Date.now() + 90000,
      });
      return { ok: true };
    case "changes": {
      const workflow = normalizeWorkflow(payload.workflow, {
        identity,
        sessionId: workerData.sessionId,
      });
      const files = [
        ...new Set(
          (payload.files ?? []).filter(
            (x) => typeof x === "string" && !secretFile(x),
          ),
        ),
      ]
        .sort()
        .slice(0, 32);
      if (!files.length) return { changed: false };
      const session = safeText(workerData.sessionId, 80),
        id = changeRecordKey({ sessionId: workerData.sessionId, files, workflow });
      const old = store.sources().find((x) => x.id === id);
      const change = {
        id: nodeId("change", id),
        type: "change",
        label: `Changes from session ${session.slice(0, 8)}`,
      };
      const fileNodes = files.map((file) => ({
        id: nodeId("file", file),
        type: "file",
        label: file,
        key: file,
      }));
      const nodes = [change, ...fileNodes];
      const provenance = buildChangeProvenance({
        workflow,
        changeId: change.id,
        existingNodes: snapshot().nodes,
      });
      nodes.push(...provenance.nodes);
      const claims = [
        {
          subject: nodeId("project", identity.id),
          predicate: "changed_during",
          object: change.id,
          relation: true,
          status: "historical",
          confidence: 0.9,
        },
        {
          subject: change.id,
          predicate: "result",
          object:
            "Tool writes observed; correctness requires separate verification.",
          relation: false,
          status: "historical",
          confidence: 1,
        },
        ...fileNodes.map((file) => ({
          subject: change.id,
          predicate: "modified",
          object: file.id,
          relation: true,
          status: "historical",
          confidence: 0.9,
        })),
      ];
      claims.push(...provenance.claims);
      const source = {
        id,
        scope: identity.checkoutId,
        kind: "session",
        locator: `session:${session}`,
        fingerprint: workflow
          ? hash(JSON.stringify([files, provenance.identity, provenance.claims]))
          : hash(files.join("\n")),
        nodes,
        claims,
      };
      const result = store.replaceSource(source, {
        expectedVersion: old?.version ?? 0,
      });
      cache = undefined;
      return result;
    }
    case "close":
      closed = true;
      for (const c of controllers.values()) c.abort();
      store.deleteActivity(workerData.sessionId);
      store.releaseLease(`discovery:${identity.checkoutId}`, owner);
      return { ok: true };
    default:
      throw Error("Unknown project intelligence operation.");
  }
}
parentPort.on("message", async (message) => {
  if (message.cancel) {
    controllers.get(message.cancel)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    const result = await run(
      message.op,
      message.payload ?? {},
      controller.signal,
    );
    parentPort.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: { message: safeText(error.message, 300), code: error.code, currentVersion: error.details?.currentVersion ?? error.currentVersion },
    });
  } finally {
    controllers.delete(message.id);
  }
});
