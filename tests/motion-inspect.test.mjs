// Motion timeline analysis: inventory findings over animation descriptors.
// Capture sampling needs a browser; the deterministic analysis is asserted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/motion-inspect.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const motion = await load("extensions/lib/motion-inspect.ts");

const descriptor = (over) => ({
  index: 0, kind: "CSSAnimation", target: "div.hero", durationMs: 600, delayMs: 0,
  iterations: 1, playbackRate: 1, properties: ["opacity"], ...over,
});

test("empty and garbage inventories analyze to zero without findings", () => {
  for (const raw of [undefined, null, "x", 42, [], [null, 42]]) {
    const analysis = motion.analyzeMotionTimeline(raw);
    assert.equal(analysis.count, 0);
    assert.deepEqual(analysis.findings, []);
  }
});

test("infinite loops, concurrency and owners are flagged", () => {
  const descriptors = [
    descriptor({ target: "div.blob", iterations: "infinite", properties: ["transform"] }),
    descriptor({ target: "div.ring", iterations: "infinite", durationMs: 1200, properties: ["opacity"] }),
  ];
  const analysis = motion.analyzeMotionTimeline(descriptors);
  assert.equal(analysis.infinite, 2);
  assert.ok(analysis.findings.some((f) => f.id === "continuous-motion" && f.severity === "WARN"));
  const crowd = Array.from({ length: 13 }, (_, i) => descriptor({ target: `li.item-${i}`, durationMs: 500 }));
  const crowded = motion.analyzeMotionTimeline(crowd);
  assert.equal(crowded.maxConcurrent, 13);
  assert.ok(crowded.findings.some((f) => f.id === "too-many-concurrent"));
  const owners = motion.analyzeMotionTimeline([
    descriptor({ target: "div.a", properties: ["transform"] }),
    descriptor({ target: "div.b", properties: ["transform"] }),
    descriptor({ target: "div.c", properties: ["opacity", "transform"] }),
  ]);
  assert.deepEqual(owners.transformOwners, ["div.a", "div.b", "div.c"]);
  assert.ok(owners.findings.some((f) => f.id === "transform-owners"));
});

test("layout-triggering properties and duration soup are flagged", () => {
  const analysis = motion.analyzeMotionTimeline([descriptor({ properties: ["width", "opacity"] })]);
  assert.deepEqual(analysis.layoutAnimations, ["div.hero (width)"]);
  assert.ok(analysis.findings.some((f) => f.id === "layout-props"));
  const soup = motion.analyzeMotionTimeline(Array.from({ length: 7 }, (_, i) => descriptor({ target: `div.d${i}`, durationMs: 100 * (i + 1) })));
  assert.equal(soup.distinctDurations.length, 7);
  assert.ok(soup.findings.some((f) => f.id === "duration-soup"));
});

test("reduced-motion parity distinguishes ignored from partial", () => {
  const full = [descriptor({}), descriptor({ target: "div.b" })];
  const ignored = motion.analyzeMotionTimeline(full, { reduced: full });
  assert.equal(ignored.reducedMotion.ignored, true);
  const fail = ignored.findings.find((f) => f.id === "reduced-motion");
  assert.equal(fail.severity, "FAIL");
  const partial = motion.analyzeMotionTimeline(full, { reduced: [descriptor({})] });
  assert.equal(partial.reducedMotion.ignored, false);
  assert.equal(partial.findings.find((f) => f.id === "reduced-motion").severity, "WARN");
  const calm = motion.analyzeMotionTimeline(full, { reduced: [] });
  assert.ok(!calm.findings.some((f) => f.id === "reduced-motion"));
});

test("direction continuous:false flags infinite runs", () => {
  const direction = { motion: { continuous: false } };
  const analysis = motion.analyzeMotionTimeline([descriptor({ iterations: "infinite" })], { direction });
  assert.ok(analysis.findings.some((f) => f.id === "direction-continuous"));
  const allowed = motion.analyzeMotionTimeline([descriptor({ iterations: "infinite" })], { direction: { motion: { continuous: true } } });
  assert.ok(!allowed.findings.some((f) => f.id === "direction-continuous"));
});

test("renderMotionTimeline draws finite bars and infinite continuations", () => {
  const text = motion.renderMotionTimeline(
    [descriptor({ target: "div.title", durationMs: 500 }), descriptor({ target: "div.loop", iterations: "infinite", durationMs: 1000 })],
    2000, 32,
  );
  assert.match(text, /Motion timeline/);
  assert.match(text, /div\.title/);
  assert.match(text, /div\.loop.*→.*∞/);
});
