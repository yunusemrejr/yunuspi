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

test('compact UI reports retain failures, coverage, truncation and provenance without mutating the full report', () => {
  const design = { typography: [{ family: 'serif' }], spacing: [4, 8], limitations: ['sampled geometry'], truncated: true, contrast: { belowThreshold: 2 }, findings: ['small type'] };
  const report = { source: 'page.html', revision: 'current', status: 'fail', report: '.pi/review/report.json', coverage: { complete: false }, plan: { omitted: ['desktop'] }, findings: ['capture failed'], cells: [
    { ok: true, file: 'mobile.png', documentSha256: 'hash', typography: design.typography, design, errors: ['runtime error'], inspectionIncomplete: true },
    { ok: false, file: 'desktop.png', error: 'capture timed out' },
  ] };
  const original = structuredClone(report), compact = qa.compactQAResult('ui_explore', report);
  assert.deepEqual(report, original);
  for (const key of ['source', 'revision', 'status', 'report', 'coverage', 'plan', 'findings']) assert.deepEqual(compact[key], report[key]);
  assert.deepEqual(compact.cells[1], report.cells[1]);
  assert.deepEqual(compact.cells[0].errors, report.cells[0].errors);
  assert.equal(compact.cells[0].inspectionIncomplete, true);
  assert.equal(compact.cells[0].documentSha256, 'hash');
  assert.equal(compact.cells[0].design.truncated, true);
  assert.deepEqual(compact.cells[0].design.contrast, design.contrast);
  assert.deepEqual(compact.cells[0].design.findings, design.findings);
  assert.deepEqual(compact.measurementLimitations, design.limitations);
  assert.equal(compact.cells[0].design.typography, undefined);
  const plain = qa.compactQAResult('visual_review', { runId: 'run-2', design: { limitations: 'Bounded sample.', svg: { limitations: 'Inline SVG sample.' } } });
  assert.deepEqual(plain.measurementLimitations, ['Bounded sample.', 'Inline SVG sample.'], 'string limitations are whole texts, not characters');
  assert.equal(qa.compactQAResult('visual_review', { receipts: [] }).receipts.length, 0);
  assert.equal(qa.compactQAResult('other', report), report);
});

test('standing caveats are sent once per conversation and again after it is compacted', () => {
  const said = new Set();
  const reply = () => ({ runId: 'r', measurementLimitations: ['Bounded sample.', 'Inline SVG sample.'], detail: 'Zero counts are left out.' });
  assert.deepEqual(qa.onceStanding(reply(), said), reply(), 'the first reply carries them whole');
  assert.deepEqual(qa.onceStanding(reply(), said), { runId: 'r', measurementLimitations: 'As stated in earlier replies.' });
  const more = qa.onceStanding({ ...reply(), measurementLimitations: ['Bounded sample.', 'Frames need separate inspection.'] }, said);
  assert.deepEqual(more.measurementLimitations, ['Frames need separate inspection.', 'The rest as stated in earlier replies.'], 'a caveat not yet said is said');
  said.clear();
  assert.deepEqual(qa.onceStanding(reply(), said), reply(), 'after a compaction they are said again');
  assert.deepEqual(qa.onceStanding({ receipts: [] }, said), { receipts: [] });
  assert.equal(qa.onceStanding(undefined, said), undefined);
});

test("compact UI matrix hoists what every viewport shares and keeps each cell's own difference", () => {
  const viewport = (name, width, overflowElements) => ({
    viewport: name, width, height: 800, state: 'default', colorScheme: 'light', file: `${name}.png`, ok: true,
    bytes: 900, pixels: { width, height: 800 }, device: { devicePixelRatio: 1 }, documentSha256: 'abc',
    inspectionIncomplete: false, errors: [], noise: [],
    dom: { documentType: 'text/html', available: true, items: 28, overflowElements, missingAlt: 0, controls: 5, brokenImages: 0, truncated: false },
    design: { version: 2, visited: 302, viewport: { width, height: 800 }, textElements: 158, surfacePatterns: { gradients: 1, shadows: 0 },
      slopSignals: { pills: 0, glass: 0 }, contrast: { checked: 155, belowThreshold: 0, indeterminate: 3 }, findings: [],
      svg: { sampled: 1, limitations: 'Inline SVG sample.' }, limits: { elements: 600 } },
  });
  const failed = { viewport: 'tablet', width: 834, height: 800, state: 'default', file: 'tablet.png', ok: false, error: 'capture timed out', bytes: 0, typography: [] };
  const report = { source: 'page.html', revision: 'r1', initialRevision: 'r1', sourceChanged: false, at: '2026-11-10T00:00:00.000Z', status: 'incomplete',
    responsiveHash: 'x', previewOrder: [{ viewport: 'narrow' }], plan: { cells: 4, requested: 4, capped: false, omitted: [] }, findings: [], detail: 'old',
    cells: [viewport('narrow', 320, 1), viewport('mobile', 390, 1), viewport('desktop', 1440, 3), failed] };
  const original = structuredClone(report), compact = qa.compactQAResult('ui_explore', report);
  assert.deepEqual(report, original);
  assert.deepEqual(compact.cells[0], { viewport: 'narrow', width: 320, height: 800, state: 'default', file: 'narrow.png', ok: true, dom: { overflowElements: 1 } });
  assert.deepEqual(compact.cells[2], { viewport: 'desktop', width: 1440, height: 800, state: 'default', file: 'desktop.png', ok: true, dom: { overflowElements: 3 } });
  assert.deepEqual(compact.cells[3], failed);
  assert.deepEqual(compact.shared.dom, { documentType: 'text/html', available: true, items: 28, controls: 5, truncated: false });
  assert.equal(compact.shared.documentSha256, 'abc');
  assert.equal(compact.shared.colorScheme, 'light');
  assert.deepEqual(compact.measurementLimitations, ['Inline SVG sample.']);
  for (const key of ['at', 'previewOrder', 'responsiveHash', 'initialRevision', 'sourceChanged', 'plan']) assert.equal(key in compact, false, key);
  assert.equal(compact.source, 'page.html');
  assert.equal(compact.revision, 'r1');
  assert.equal(compact.detail, 'Measurements leave out zero counts and empty lists; shared holds what every captured viewport has in common. Typography and spacing tables are in the report file; detail:true returns everything.');
  const kept = qa.compactQAResult('ui_explore', { ...report, initialRevision: 'r0', sourceChanged: true, plan: { capped: true, omitted: [] } });
  assert.equal(kept.initialRevision, 'r0');
  assert.equal(kept.sourceChanged, true);
  assert.deepEqual(kept.plan, { capped: true, omitted: [] });
});

test("compact visual review prunes zero measures, keeps sections and drops volatile keys", () => {
  const review = {
    runId: 'run-1', source: 'index.html', revision: 'abc', at: '2026-11-10T00:00:00.000Z', file: '.pi/ui-review/x/capture.png', dir: '.pi/ui-review/x',
    pixels: { width: 1440, height: 900 }, palette: ['text: #111 (15:1)'], responsiveHash: 'hash', noise: [], errors: [], blocking: 0, next: 'done', consistent: true,
    report: '.pi/ui-review/x/report.json',
    dom: { items: 32, overflowElements: 0, missingAlt: 0, controls: 8, truncated: false },
    design: { version: 2, visited: 302, viewport: { width: 1440, height: 900 }, contrast: { checked: 158, belowThreshold: 0 },
      findings: [{ kind: 'slop-oversized-type', count: 2 }], slopSignals: { pills: 0, oversizedType: 2 },
      svg: { sampled: 1, findings: [], limitations: 'Inline SVG sample.' }, limitations: ['Bounded sample.'], typography: [{ size: 16 }] },
    sections: [{ id: 'spacing', verdict: 'PASS', evidence: ['2 distinct spacing values'] }],
  };
  const original = structuredClone(review), compact = qa.compactQAResult('visual_review', review);
  assert.deepEqual(review, original);
  assert.deepEqual(compact.sections, review.sections);
  for (const key of ['at', 'responsiveHash', 'previewOrder']) assert.equal(key in compact, false, key);
  assert.deepEqual(compact.dom, { items: 32, controls: 8, truncated: false });
  assert.deepEqual(compact.design, { visited: 302, contrast: { checked: 158 }, findings: review.design.findings, slopSignals: { oversizedType: 2 }, svg: { sampled: 1 } });
  assert.deepEqual(compact.measurementLimitations, ['Bounded sample.', 'Inline SVG sample.']);
  assert.deepEqual(compact.pixels, review.pixels);
  assert.equal(compact.runId, 'run-1');
  assert.equal(compact.file, review.file);
  assert.equal(compact.detail, 'Measurements leave out zero counts and empty lists. Typography and spacing tables are in the report file; detail:true returns everything.');
});

test("planUiMatrix expands viewports × states and caps at 12 captures", () => {
  const minimal = qa.planUiMatrix({});
  assert.equal(minimal.cells.length, 4);
  assert.deepEqual(minimal.cells.map((c) => c.viewport), ["narrow", "mobile", "tablet", "desktop"]);
  assert.ok(minimal.cells.every((c) => c.state === "default" && c.colorScheme === "light"));
  const full = qa.planUiMatrix({ viewports: ['mobile', 'desktop'], states: ["default", "dark", "reduced-motion", "full"] });
  assert.equal(full.cells.length, 8);
  assert.equal(full.capped, false);
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
  assert.deepEqual(qa.summarizePageState(undefined), { available: false, items: 0, overflowElements: 0, scopeOverflowPx: 0, missingAlt: 0, images: 0, controls: 0, unnamedControls: 0, smallTargets: 0, brokenImages: 0, truncated: false });
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
  assert.throws(() => qa.normalizeVerdict([]), /one entry for each rubric section/, "an empty verdict is answered with the shape to send");
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
  assert.deepEqual(qa.creativeVerificationLines([], { name: "brief" }, true), [], "a recorded video_qa review covers a film's direction");
  assert.deepEqual(qa.creativeVerificationLines([]), []);
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

test("qaFolder creates a missing workspace output folder instead of failing with ENOENT", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-folder-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = await qa.qaFolder("build/ui-review/pass1", dir, "ui-review", "matrix");
  assert.ok(fs.statSync(output).isDirectory());
  assert.equal(path.dirname(output), path.join(fs.realpathSync(dir), "build/ui-review/pass1"));
  await assert.rejects(() => qa.qaFolder("../outside", dir, "ui-review", "matrix"), /inside the current workspace/);
});
