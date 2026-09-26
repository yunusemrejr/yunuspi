// Creative QA planners: matrix expansion, verdict validation, receipt
// gating and comparison plans. Capture runners need a browser and are
// covered by live inspection, not asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/creative-qa.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const qa = await load("extensions/lib/creative-qa.ts");
const hooks = await load("extensions/lib/session-hooks.ts");

test("planUiMatrix expands viewports × states and caps at 12 captures", () => {
  const minimal = qa.planUiMatrix({});
  assert.equal(minimal.cells.length, 2);
  assert.deepEqual(minimal.cells.map((c) => c.viewport), ["mobile", "desktop"]);
  assert.ok(minimal.cells.every((c) => c.state === "default" && c.colorScheme === "light"));
  const full = qa.planUiMatrix({ states: ["default", "dark", "reduced-motion", "full"] });
  assert.equal(full.cells.length, 8);
  assert.ok(full.cells.some((c) => c.state === "dark" && c.colorScheme === "dark" && c.file === "mobile-dark.png"));
  assert.ok(full.cells.some((c) => c.state === "reduced-motion" && c.reducedMotion === "reduce"));
  assert.ok(full.cells.some((c) => c.state === "full" && c.fullPage === true));
  const capped = qa.planUiMatrix({ viewports: ["mobile", "tablet", "desktop"], widths: [1920, 1280], states: ["default", "dark", "reduced-motion", "full"] });
  assert.equal(capped.capped, true);
  assert.equal(capped.cells.length, 12);
  const custom = qa.planUiMatrix({ viewports: ["nope"], widths: [500] });
  assert.deepEqual(custom.cells.map((c) => c.viewport), ["desktop", "w500"]);
});

test("summarizePageState rolls up overflow, alt and controls", () => {
  const summary = qa.summarizePageState({
    scopeHorizontalOverflowPx: 12,
    items: [
      { horizontalOverflowPx: 30, role: "button", label: "ok" },
      { horizontalOverflowPx: 0, kind: "img", alt: null },
      { kind: "img", alt: "logo" },
      { role: "link", label: "docs" },
    ],
  });
  assert.equal(summary.overflowElements, 1);
  assert.equal(summary.scopeOverflowPx, 12);
  assert.equal(summary.images, 2);
  assert.equal(summary.missingAlt, 1);
  assert.equal(summary.controls, 2);
  assert.deepEqual(qa.summarizePageState(undefined), { items: 0, overflowElements: 0, scopeOverflowPx: 0, missingAlt: 0, images: 0, controls: 0, truncated: false });
});

test("inkQuadrants measures compositional balance as a proxy", () => {
  const blank = { width: 10, height: 10, data: new Uint8Array(10 * 10 * 4).fill(255) };
  assert.deepEqual(qa.inkQuadrants(blank, [255, 255, 255]).map((q) => q.share), [25, 25, 25, 25]);
  const img = { width: 10, height: 10, data: new Uint8Array(10 * 10 * 4).fill(255) };
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) img.data.set([0, 0, 0, 255], (y * 10 + x) * 4);
  const quads = qa.inkQuadrants(img, [255, 255, 255]);
  assert.equal(quads[0].quadrant, "top-left");
  assert.equal(quads[0].share, 100);
});

test("normalizeVerdict requires unique sections with evidence", () => {
  const verdict = qa.normalizeVerdict([
    { id: "contrast", verdict: "fail", evidence: ["3.8:1 at 120,44"] },
    { id: "type", verdict: "PASS", evidence: ["3 levels"] },
  ]);
  assert.equal(verdict.blocking, 1);
  assert.equal(verdict.sections[0].verdict, "FAIL");
  assert.throws(() => qa.normalizeVerdict([]), /1\.\.16/);
  assert.throws(() => qa.normalizeVerdict([{ id: "a", verdict: "PASS", evidence: ["x"] }, { id: "a", verdict: "PASS", evidence: ["y"] }]), /unique/);
  assert.throws(() => qa.normalizeVerdict([{ id: "a", verdict: "maybe", evidence: ["x"] }]), /PASS\|WARN\|FAIL\|UNKNOWN/);
  assert.throws(() => qa.normalizeVerdict([{ id: "a", verdict: "PASS", evidence: [] }]), /evidence/);
});

test("creativeVerificationLines gate only newest blocking receipts", () => {
  const fail = { source: "page.html", revision: "aaa", at: 1, sections: [{ id: "contrast", verdict: "FAIL", evidence: ["x"] }], blocking: 1, improvements: 0 };
  const clean = { source: "page.html", revision: "bbb", at: 2, sections: [{ id: "contrast", verdict: "PASS", evidence: ["x"] }], blocking: 0, improvements: 0 };
  assert.match(qa.creativeVerificationLines([fail])[0], /visual review: 1 blocking finding\(s\) open on page\.html \(rev aaa\): contrast/);
  assert.deepEqual(qa.creativeVerificationLines([fail, clean]), []);
  assert.deepEqual(qa.creativeVerificationLines([clean, fail]), [], "order-independent: newest receipt wins");
  assert.match(qa.creativeVerificationLines([], { name: "brief" })[0], /no visual review is recorded yet/);
  assert.deepEqual(qa.creativeVerificationLines([]), []);
});

test("planCompare needs 2..4 distinct variants", () => {
  const plan = qa.planCompare({ sources: ["a.html", "b.html", "a.html"] });
  assert.deepEqual(plan.sources, ["a.html", "b.html"]);
  assert.deepEqual(qa.planCompare({ variants: ["a.html", "b.html"] }).sources, ["a.html", "b.html"]);
  assert.throws(() => qa.planCompare({ sources: ["a.html"] }), /2\.\.4/);
  assert.throws(() => qa.planCompare({}), /2\.\.4/);
});

test("sourceRevision hashes files and marks live sources", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "qa-rev-"));
  try {
    await fs.promises.writeFile(path.join(dir, "page.html"), "<h1>hi</h1>");
    const rev = await qa.sourceRevision("page.html", dir);
    assert.match(rev, /^[0-9a-f]{16}$/);
    assert.equal(await qa.sourceRevision("missing.html", dir), "missing");
    assert.equal(await qa.sourceRevision("https://example.com/x", dir), "live");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("creative hook rules bind the QA loop", () => {
  assert.equal(hooks.matchHook("creative_direct", {})?.key, "creative-direction-loop");
  assert.equal(hooks.matchHook("visual_review", {})?.key, "visual-review-receipt");
  assert.equal(hooks.matchHook("ui_explore", {})?.key, "art-qa-evidence");
  assert.equal(hooks.matchHook("motion_inspect", {})?.key, "art-qa-evidence");
  assert.equal(hooks.matchHook("svg_inspect", {})?.key, "art-qa-evidence");
  assert.equal(hooks.matchHook("creative_compare", {})?.key, "art-qa-evidence");
});
