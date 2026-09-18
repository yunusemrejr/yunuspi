// Browser interaction surface: markers, evaluate caps, coordinate/drag/scroll
// plumbing, lease classification and guidance hooks. DOM behavior runs
// against linkedom; live Chromium coverage stays in the manual e2e probe
// (committed tests never launch a browser).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
  fs.existsSync(path.join(dir, "extensions/lib/browser-session.ts")),
);
assert.ok(agent, "agent tree with browser-session.ts is present");
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));

const markers = await load("scripts/browser-markers.mjs");
const { createBrowserLease } = await load("scripts/browser-session-lease.mjs");
const { matchHook } = await load("extensions/lib/session-hooks.ts");

const withRect = (el, rect) => {
  el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, ...rect });
  return el;
};

test("cssPath round-trips through querySelector", () => {
  const { document } = parseHTML(
    `<main><section id="s"><button>One</button><button>Two</button></section><a href="/x">Link</a></main>`,
  );
  for (const el of document.querySelectorAll("button,a")) {
    const found = document.querySelector(markers.cssPath(el));
    assert.equal(found, el, `path resolves: ${markers.cssPath(el)}`);
  }
  assert.match(markers.cssPath(document.querySelector("button")), /^#s >/);
  assert.equal(markers.cssPath(document.querySelector("#s")), "#s");
});

test("marker collection filters visibility and caps the set", () => {
  const { document } = parseHTML(
    `<main><button id="ok">Save</button><button id="flat">Flat</button>` +
      `<button id="far">Far</button><button id="ghost" aria-hidden="true">Ghost</button>` +
      `<input type="hidden" id="hid"><a href="/v" id="link">Visit</a></main>`,
  );
  withRect(document.querySelector("#ok"), { x: 10, y: 10, width: 60, height: 24, top: 10, left: 10, bottom: 34, right: 70 });
  withRect(document.querySelector("#link"), { x: 10, y: 40, width: 60, height: 24, top: 40, left: 40, bottom: 64, right: 70 });
  withRect(document.querySelector("#far"), { x: 10, y: 5000, width: 60, height: 24, top: 5000, left: 10, bottom: 5024, right: 70 });
  const { rows, truncated } = markers.collectMarkerRows(document, { w: 1280, h: 800 });
  assert.deepEqual(rows.map((row) => row.name), ["Save", "Visit"]);
  assert.equal(rows[0].tag, "button");
  assert.equal(rows[0].path, "#ok");
  assert.deepEqual(rows[0].bounds, { x: 10, y: 10, width: 60, height: 24 });
  assert.equal(truncated, true);
  const capped = markers.collectMarkerRows(document, { w: 1280, h: 800 }, 1);
  assert.equal(capped.rows.length, 1);
  assert.equal(capped.truncated, true);
});

test("marker overlay paints numbered badges and cleans up", () => {
  const { document } = parseHTML(`<main><button>Go</button></main>`);
  withRect(document.querySelector("button"), { x: 5, y: 6, width: 40, height: 20, top: 6, left: 5, bottom: 26, right: 45 });
  const { rows } = markers.collectMarkerRows(document, { w: 1280, h: 800 });
  assert.equal(markers.paintMarkers(rows, document), 1);
  const layer = document.getElementById(markers.MARKER_OVERLAY_ID);
  assert.ok(layer);
  assert.equal(layer.children.length, 1);
  assert.equal(layer.children[0].textContent, "1");
  markers.clearMarkers(document);
  assert.equal(document.getElementById(markers.MARKER_OVERLAY_ID), null);
  // The in-page functions carry a literal overlay id (no module scope in
  // the page); the export must stay identical to those literals.
  for (const fn of [markers.paintMarkers, markers.clearMarkers]) {
    assert.ok(fn.toString().includes(`"${markers.MARKER_OVERLAY_ID}"`));
  }
});

test("collect script bundles every helper it references", () => {
  const script = markers.buildCollectScript(12);
  for (const name of [
    "INTERACTIVE_SELECTOR",
    "escapeCssIdent",
    "cssPath",
    "markerName",
    "markerVisible",
    "markerBounds",
    "collectMarkerRows",
  ]) {
    assert.ok(script.includes(name), `bundle defines ${name}`);
  }
  assert.ok(script.includes("collectMarkerRows(document, { w: innerWidth, h: innerHeight }, 12)"));
  new Function(script); // syntactically valid function body
});

test("evaluate results cap to one predictable shape", () => {
  assert.deepEqual(markers.capEvaluateResult({ a: 1 }), { text: '{"a":1}', truncated: false, chars: 7 });
  assert.deepEqual(markers.capEvaluateResult(undefined), { text: '"undefined"', truncated: false, chars: 11 });
  const circular = {};
  circular.self = circular;
  assert.equal(markers.capEvaluateResult(circular).text, '"[object Object]"');
  const big = markers.capEvaluateResult({ s: "x".repeat(1000) }, 100);
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 100);
  assert.ok(big.chars > 100);
});

test("marker failures guide recapture without echoing page content", async () => {
  const { browserFailure } = await load("scripts/browser-diagnostics.mjs");
  const stale = browserFailure(Error("Markers are stale (page navigated); capture markers again"), "click", "click");
  assert.equal(stale.nextStep, "Capture markers again on the current page; marker ids die on navigation.");
  const missing = browserFailure(Error("No markers captured; use the markers action first"), "click", "click");
  assert.equal(missing.nextStep, "Use the markers action to capture numbered targets first.");
  assert.ok(!JSON.stringify(stale).includes("navigated); capture"));
});

test("marker resolution fails closed on stale, unknown and empty sets", () => {
  const store = { url: "https://site.test/a", markers: [{ path: "#a" }, { path: "#b" }] };
  assert.deepEqual(markers.resolveMarker(store, 2, "https://site.test/a"), { path: "#b" });
  assert.throws(() => markers.resolveMarker(store, 1, "https://site.test/b"), /stale/);
  assert.throws(() => markers.resolveMarker(store, 3, "https://site.test/a"), /Unknown marker id 3/);
  assert.throws(() => markers.resolveMarker(store, 0, "https://site.test/a"), /Unknown marker id/);
  assert.throws(() => markers.resolveMarker({ url: "https://site.test/a", markers: [] }, 1, "https://site.test/a"), /No markers captured/);
});

test("lease keeps new reads free and budgets new mutations", () => {
  const lease = createBrowserLease(() => 0);
  for (const action of ["markers", "observe", "html", "screenshot", "snapshot"]) lease.consume(action);
  assert.equal(lease.receipt().actionsRemaining, 200);
  for (const action of ["evaluate", "hover", "scroll", "drag"]) lease.consume(action);
  assert.equal(lease.receipt().actionsRemaining, 196);
});

test("guidance treats new mutations like clicks and new reads like inspection", () => {
  for (const action of ["evaluate", "hover", "scroll", "drag"]) {
    assert.equal(matchHook("browser_session", { action }, true).key, "browser-session-recovery");
    assert.equal(matchHook("browser_session", { action }).key, "browser-session-workflow");
  }
  for (const action of ["markers", "observe", "html"]) {
    assert.equal(matchHook("browser_session", { action }, true).key, "browser-session-read-recovery");
    assert.equal(matchHook("browser_session", { action }), null);
  }
});

test("tool surface registers the new actions and parameters", async () => {
  const { registerBrowserSession } = await load("extensions/lib/browser-session.ts");
  let tool;
  registerBrowserSession({
    on() {},
    registerTool: (definition) => { tool = definition; },
  });
  const actions = tool.parameters.enum ?? tool.parameters.anyOf?.flatMap((entry) => entry.enum ?? []);
  const actionSchema = tool.parameters.properties?.action;
  const names = new Set(
    actionSchema?.anyOf?.flatMap((entry) => (entry.const !== undefined ? [entry.const] : entry.enum ?? [])) ??
      actions ??
      [],
  );
  for (const action of ["evaluate", "markers", "observe", "html", "hover", "scroll", "drag"]) {
    assert.ok(names.has(action), `action registered: ${action}`);
  }
  for (const param of ["script", "marker", "x", "y", "toX", "toY", "dx", "dy", "maxChars"]) {
    assert.ok(tool.parameters.properties?.[param], `param registered: ${param}`);
  }
  assert.ok(!tool.description.includes("arbitrary JS") || tool.description.includes("evaluate"));
});
