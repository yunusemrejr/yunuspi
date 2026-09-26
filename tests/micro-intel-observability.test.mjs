// New-layer observability: Span ledger accounting in /metrics, micro_status
// layers, and helper-usage/activity mappings. No inference, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/micro-intelligence/metrics.ts")),
);
const load = (rel) => import(pathToFileURL(path.join(agent, rel)));
const sessionMetricsMod = await load("extensions/lib/session-metrics.ts");
const statusMod = await load("extensions/lib/micro-intelligence/status.ts");
const activityMod = await load("extensions/lib/activity-indicators.ts");
const helperUsageMod = await load("extensions/lib/helper-usage.ts");

test("span-usage-v1 entries feed /metrics accounting", () => {
  const entries = [
    { id: "s1", type: "custom", customType: "span-usage-v1", data: { model: "respan/span-01-lite", inputTokens: 100, costUsd: 0.002, ms: 50, cached: false, signals: 12, present: 2, shadow: true } },
    { id: "s2", type: "custom", customType: "span-usage-v1", data: { model: "respan/span-01-lite", inputTokens: 50, costUsd: 0, ms: 0, cached: true, signals: 12, present: 0, shadow: false } },
  ];
  const m = sessionMetricsMod.collectSessionMetrics(entries);
  assert.equal(m.span.hits, 2);
  assert.equal(m.span.cached, 1);
  assert.equal(m.span.shadow, 1);
  assert.equal(m.span.tokens, 150);
  assert.equal(m.span.present, 2);
  assert.ok(m.detail.some((line) => line.startsWith("Span behavior sensor:")), "span line in /metrics detail");
  const empty = sessionMetricsMod.collectSessionMetrics([]);
  assert.equal(empty.span.hits, 0);
  assert.ok(!empty.detail.some((line) => line.startsWith("Span behavior sensor:")));
});

test("micro_status exposes the new layers without inference", () => {
  const snapshot = statusMod.microStatusSnapshot({ family: "lookup", substantive: true, terms: ["show"] });
  const layers = Object.fromEntries(snapshot.health.layers.map((l) => [l.layer, l.status]));
  assert.ok("span" in layers);
  assert.ok("microworker" in layers);
  assert.ok("rerank" in layers);
  assert.ok(snapshot.span && typeof snapshot.span.model === "string");
  assert.ok(snapshot.microworker && Array.isArray(snapshot.microworker.candidates));
  assert.ok(snapshot.rerank && typeof snapshot.rerank.url === "string");
  assert.ok(Array.isArray(snapshot.metrics));
});

test("activity and usage ledgers know the new helpers", () => {
  const used = activityMod.describeIntelligenceActivity("ml.span.used", { count: 1, cached: false, present: 2 });
  assert.equal(used.label, "Span sensor");
  assert.equal(activityMod.describeIntelligenceActivity("ml.span.used", { count: 1, shadow: true }), undefined);
  const skipped = activityMod.describeIntelligenceActivity("ml.microworker.skipped", { count: 1, reason: "no-route" });
  assert.equal(skipped.label, "Micro worker");
  assert.equal(activityMod.HELPER_LABELS.span, "Span sensor");
  assert.equal(activityMod.HELPER_LABELS.microworker, "Micro worker");
  assert.equal(activityMod.HELPER_LABELS.rerank, "Remote rerank");

  const ledger = helperUsageMod.createHelperUsageLedger();
  ledger.note("ml.span.used", { count: 1, cached: false });
  ledger.note("ml.microworker.used", { count: 1, cached: true });
  const snap = ledger.snapshot();
  assert.equal(snap.components["Span sensor"].executions, 1);
  assert.equal(snap.components["Micro worker"].cached, 1);
  const collected = helperUsageMod.collectHarnessUsage([{ id: "h", type: "custom", customType: "helper-usage-v1", data: snap }]);
  assert.ok(collected.components.some((row) => row.name === "Span sensor" && row.measured));
});
