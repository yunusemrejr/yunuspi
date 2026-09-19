// Browser interaction surface: markers, evaluate caps, coordinate/drag/scroll
// plumbing, lease classification and guidance hooks. Browser node binding is
// exercised against Chromium in browser-workflows.test.mjs.
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

test("marker overlay paints numbered badges and cleans up", () => {
  const { document } = parseHTML(`<main><button>Go</button></main>`);
  const rows = [{ bounds: { x: 5, y: 6, width: 40, height: 20 } }];
  assert.equal(markers.paintMarkers(rows, document), 1);
  assert.equal(document.getElementById(markers.MARKER_OVERLAY_ID).children[0].textContent, "1");
  markers.clearMarkers(document);
  assert.equal(document.getElementById(markers.MARKER_OVERLAY_ID), null);
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

test("stale node references request a fresh observation without echoing page content", async () => {
  const { browserFailure } = await load("scripts/browser-diagnostics.mjs");
  const stale = browserFailure(Error("Stale browser reference; capture snapshot or markers again"), "click", "click");
  assert.match(stale.nextStep, /Capture snapshot or markers again/);
});

test("lease keeps new reads free and budgets new mutations", () => {
  const lease = createBrowserLease(() => 0);
  for (const action of ["tabs", "switch_tab", "close_tab", "read", "markers", "observe", "html", "screenshot", "snapshot"]) lease.consume(action);
  assert.equal(lease.receipt().actionsRemaining, 200);
  for (const action of ["evaluate", "hover", "scroll", "drag"]) lease.consume(action);
  assert.equal(lease.receipt().actionsRemaining, 196);
});

test("guidance treats new mutations like clicks and new reads like inspection", () => {
  for (const action of ["evaluate", "hover", "scroll", "drag"]) {
    assert.equal(matchHook("browser_session", { action }, true).key, "browser-session-recovery");
    assert.equal(matchHook("browser_session", { action }).key, "browser-session-workflow");
  }
  for (const action of ["markers", "observe", "html", "tabs", "read", "navigate", "new_tab", "back", "forward", "reload"]) {
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
  for (const action of ["evaluate", "markers", "observe", "html", "hover", "scroll", "drag", "tabs", "new_tab", "switch_tab", "close_tab", "back", "forward", "reload", "dialog", "read", "request_help"]) {
    assert.ok(names.has(action), `action registered: ${action}`);
  }
  for (const param of ["script", "marker", "x", "y", "toX", "toY", "dx", "dy", "maxChars", "tab", "ref", "kind", "reason", "query", "offset", "mode", "button", "clickCount"]) {
    assert.ok(tool.parameters.properties?.[param], `param registered: ${param}`);
  }
  assert.ok(!tool.description.includes("arbitrary JS") || tool.description.includes("evaluate"));
});
