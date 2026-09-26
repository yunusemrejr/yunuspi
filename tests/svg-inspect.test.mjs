// SVG inspection: path engine, document measurement and set review.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
  fs.existsSync(path.join(p, "extensions/lib/svg-inspect.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, p)).href);
const svg = await load("extensions/lib/svg-inspect.ts");

test("flattenPath bounds absolute, relative, curve and arc data", () => {
  const rect = svg.flattenPath("M0 0H10V10H0Z");
  assert.equal(rect.stat.closed, true);
  assert.deepEqual(svg.boundsOfPoints(rect.points), { x: 0, y: 0, width: 10, height: 10 });
  const rel = svg.flattenPath("m5 5c5 0 5 10 10 10");
  assert.ok(rel.stat.curves >= 1);
  const bounds = svg.boundsOfPoints(rel.points);
  assert.ok(bounds.x >= 5 && bounds.x + bounds.width <= 15.01);
  assert.ok(Math.abs(bounds.x + bounds.width - 15) < 0.01);
  const arc = svg.flattenPath("M0 0A5 5 0 0 1 10 0");
  assert.equal(arc.stat.arcs, true);
  const arcBounds = svg.boundsOfPoints(arc.points);
  assert.ok(Math.abs(arcBounds.width - 10) < 0.5);
  assert.ok(Math.abs(arcBounds.height - 5) < 0.6);
  assert.equal(svg.boundsOfPoints([]), null);
});

test("tokenizeSvg skips comments and decodes entities", () => {
  const tags = svg.tokenizeSvg(`<!-- hi --><svg viewBox="0 0 24 24"><title>A &amp; B</title><path d="M0 0H1"/></svg>`);
  assert.deepEqual(tags.map((t) => t.name), ["svg", "title", "title", "path", "svg"]);
  assert.equal(tags[0].attrs.viewBox, "0 0 24 24");
});

test("measureSvg reports geometry, hygiene and accessibility", () => {
  const measured = svg.measureSvg(`<svg viewBox="0 0 24 24" role="img" aria-label="search">
<title>Search</title>
<defs><linearGradient id="g"><stop offset="0"/><stop offset="1"/></linearGradient>
<filter id="f"/></defs>
<g id="dup" transform="translate(4 4)"><rect id="dup" x="0" y="0" width="16" height="16" rx="2" fill="none" stroke="#111" stroke-width="2"/></g>
<use href="#missing"/>
</svg>`, "icon.svg");
  assert.deepEqual(measured.viewBox, { x: 0, y: 0, width: 24, height: 24 });
  assert.equal(measured.hasTitle, true);
  assert.equal(measured.role, "img");
  assert.equal(measured.ariaLabel, true);
  assert.equal(measured.gradients, 1);
  assert.equal(measured.gradientStops, 2);
  assert.equal(measured.filters, 1);
  assert.equal(measured.filterDefaultRegions, 1);
  assert.deepEqual(measured.idCollisions, ["dup"]);
  assert.deepEqual(measured.unresolvedRefs, ["missing"]);
  assert.deepEqual(measured.strokeWidths, [2]);
  assert.deepEqual(measured.unionBounds, { x: 4, y: 4, width: 16, height: 16 });
  assert.equal(measured.padding, 4);
  assert.deepEqual(measured.centerOffset, { dx: 0, dy: 0 });
  assert.equal(measured.boundsApproximate, true, 'stroke, filter and unresolved use geometry require rendered verification');
  for (const cause of ['stroke extents', 'filter regions', '<use> instances']) {
    assert.ok(measured.approximationCauses.some((value) => value.includes(cause)), cause);
  }
  assert.equal(measured.activeContent.length, 0);
});

test("measureSvg flags active content, externals and rotation", () => {
  const measured = svg.measureSvg(`<svg viewBox="0 0 10 10"><script>alert(1)</script><g transform="rotate(45)"><rect width="4" height="4"/></g><image href="https://example.com/x.png"/></svg>`);
  assert.ok(measured.activeContent.length >= 1);
  assert.equal(measured.externalRefs.length, 1);
  assert.equal(measured.boundsApproximate, true);
  assert.ok(measured.warnings.some((w) => /rotate/.test(w)));
  const noViewBox = svg.measureSvg(`<svg><circle cx="5" cy="5" r="4"/></svg>`);
  assert.ok(noViewBox.warnings.some((w) => /viewBox/));
  assert.equal(svg.measureSvg(`<html></html>`).warnings[0], "no <svg> root element found");
});

test("planSvgMatrix captures once above the viewport floor", () => {
  assert.deepEqual(svg.planSvgMatrix(undefined), { captureSize: 256, targets: [16, 24, 48, 256] });
  assert.deepEqual(svg.planSvgMatrix([16, 512]), { captureSize: 512, targets: [16, 512] });
  assert.throws(() => svg.planSvgMatrix([]), /1\.\.6/);
  assert.throws(() => svg.planSvgMatrix([4]), /1\.\.6/);
});

test("compareSvgSet flags the sibling that drifted", () => {
  const base = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
  const measures = [
    svg.measureSvg(base(`<rect x="4" y="4" width="16" height="16" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round"/>`), "a.svg"),
    svg.measureSvg(base(`<rect x="4" y="4" width="16" height="16" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round"/>`), "b.svg"),
    svg.measureSvg(base(`<rect x="0.5" y="0.5" width="23" height="23" fill="#111" stroke="#111" stroke-width="1.5" stroke-linejoin="miter"/>`), "c.svg"),
  ];
  const { summary, outliers, approximate } = svg.compareSvgSet(measures);
  assert.ok(summary.some((s) => /stroke widths: 2/));
  assert.ok(outliers.some((o) => o.file === "c.svg" && o.check === "stroke"), JSON.stringify(outliers));
  assert.deepEqual(approximate, ['a.svg', 'b.svg', 'c.svg']);
  assert.ok(!outliers.some((o) => ['mass', 'padding', 'center'].includes(o.check)), 'stroke estimates cannot become exact geometry verdicts');
  assert.ok(summary.some((line) => /geometry unknown.*render matrix/.test(line)));
  assert.ok(!outliers.some((o) => o.file === "a.svg" || o.file === "b.svg"), JSON.stringify(outliers));
});

test("compareSvgSet retains mass, padding and center checks for exact fill geometry", () => {
  const base = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
  const measures = [
    svg.measureSvg(base(`<rect x="4" y="4" width="16" height="16" fill="#111"/>`), "a.svg"),
    svg.measureSvg(base(`<rect x="4" y="4" width="16" height="16" fill="#111"/>`), "b.svg"),
    svg.measureSvg(base(`<rect x="0.5" y="0.5" width="23" height="23" fill="#111"/>`), "c.svg"),
  ];
  const { outliers, approximate } = svg.compareSvgSet(measures);
  assert.deepEqual(approximate, []);
  assert.ok(outliers.some((o) => o.file === "c.svg" && o.check === "mass"), JSON.stringify(outliers));
  assert.ok(outliers.some((o) => o.file === "c.svg" && o.check === "padding"), JSON.stringify(outliers));
  const offset = svg.measureSvg(base(`<rect x="8" y="4" width="12" height="12" fill="#111"/>`), "d.svg");
  const centered = svg.compareSvgSet([measures[0], offset]);
  assert.ok(centered.outliers.some((o) => o.file === "d.svg" && o.check === "center"), JSON.stringify(centered.outliers));
});
