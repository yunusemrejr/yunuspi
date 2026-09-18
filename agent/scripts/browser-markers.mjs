// Marker overlay, element recipes and evaluate-result caps for the isolated
// browser runner. The collector helpers are plain DOM functions with no
// module-scope closures so the runner can compose them into one in-page
// script (Playwright serializes function sources, not scope); regression
// tests import and drive the same functions against linkedom.
export const MARKER_LIMIT = 50;
export const MARKER_OVERLAY_ID = "pi-marker-overlay";

export const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
].join(",");

export function escapeCssIdent(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** Short unique-ish CSS path: id shortcut, else tag/nth-of-type chain. */
export function cssPath(el) {
  if (!el || el.nodeType !== 1) return "body";
  const withId = (node) =>
    node.id &&
    /^[A-Za-z][\w:.-]*$/.test(node.id) &&
    `#${escapeCssIdent(node.id)}`;
  const direct = withId(el);
  if (direct) return direct;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node.tagName !== "HTML" && parts.length < 12) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    for (
      let sib = node.previousElementSibling;
      sib;
      sib = sib.previousElementSibling
    ) {
      if (sib.tagName === node.tagName) index++;
    }
    parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = node.parentElement;
    const anchor = node && node.nodeType === 1 ? withId(node) : null;
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
  }
  return parts.join(" > ") || "body";
}

export function markerName(el) {
  const label =
    (typeof el.getAttribute === "function" && el.getAttribute("aria-label")) ||
    el.innerText ||
    el.textContent ||
    "";
  return String(label).replace(/\s+/g, " ").trim().slice(0, 80);
}

export function markerVisible(el, viewport) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  if (
    typeof el.closest === "function" &&
    el.closest("[hidden],[inert]")
  )
    return false;
  if (
    typeof el.getAttribute === "function" &&
    el.getAttribute("aria-hidden") === "true"
  )
    return false;
  if (el.tagName === "INPUT" && el.type === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  if (viewport && viewport.w > 0 && viewport.h > 0) {
    if (rect.bottom < 0 || rect.right < 0 || rect.top > viewport.h || rect.left > viewport.w)
      return false;
  }
  return true;
}

export function markerBounds(el) {
  const rect = el.getBoundingClientRect();
  const round = (n) => Math.round(n * 10) / 10;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

/** Visible interactive elements in document order. Pure DOM walk; the runner
 * supplies the live document, tests supply linkedom. */
export function collectMarkerRows(root, viewport = null, limit = MARKER_LIMIT) {
  const doc = root.ownerDocument ?? root;
  const scope = root.querySelectorAll ? root : doc;
  const candidates = Array.from(scope.querySelectorAll(INTERACTIVE_SELECTOR));
  const seen = new Set();
  const rows = [];
  for (const el of candidates) {
    if (rows.length >= limit) break;
    if (seen.has(el)) continue;
    seen.add(el);
    if (!markerVisible(el, viewport)) continue;
    rows.push({
      tag: el.tagName.toLowerCase(),
      role:
        (typeof el.getAttribute === "function" && el.getAttribute("role")) ||
        null,
      name: markerName(el),
      bounds: markerBounds(el),
      path: cssPath(el).slice(0, 256),
    });
  }
  return { rows, candidates: candidates.length, limit, truncated: candidates.length > rows.length };
}

/** Numbered overlay badges at viewport coordinates. Returns the badge count.
 * Self-contained (literal overlay id, inline clear): the runner passes this
 * function into the page via page.evaluate(fn, rows), where module scope
 * does not exist. Tests pass an explicit document. */
export function paintMarkers(rows, doc = globalThis.document) {
  doc.getElementById?.("pi-marker-overlay")?.remove();
  const layer = doc.createElement("div");
  layer.id = "pi-marker-overlay";
  layer.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;",
  );
  rows.forEach((row, index) => {
    const badge = doc.createElement("div");
    badge.textContent = String(index + 1);
    badge.setAttribute(
      "style",
      `position:absolute;left:${Math.max(0, Math.round(row.bounds.x))}px;` +
        `top:${Math.max(0, Math.round(row.bounds.y))}px;` +
        "min-width:22px;height:22px;line-height:22px;text-align:center;" +
        "background:#d92d20;color:#fff;font:700 13px/22px system-ui,sans-serif;" +
        "border-radius:11px;padding:0 5px;box-sizing:border-box;",
    );
    layer.appendChild(badge);
  });
  doc.documentElement.appendChild(layer);
  return rows.length;
}

/** Self-contained for the same reason as paintMarkers. */
export function clearMarkers(doc = globalThis.document) {
  doc.getElementById?.("pi-marker-overlay")?.remove();
}

/** One self-contained in-page script: helper sources plus the invocation.
 * The runner passes this to page.evaluate via new Function so helper
 * definitions travel with the call (bare names resolve inside the bundle). */
export function buildCollectScript(limit = MARKER_LIMIT) {
  const sources = [
    `const INTERACTIVE_SELECTOR=${JSON.stringify(INTERACTIVE_SELECTOR)};`,
    `const MARKER_LIMIT=${JSON.stringify(MARKER_LIMIT)};`,
    escapeCssIdent.toString(),
    cssPath.toString(),
    markerName.toString(),
    markerVisible.toString(),
    markerBounds.toString(),
    collectMarkerRows.toString(),
  ];
  return `${sources.join("\n")}\nreturn collectMarkerRows(document, { w: innerWidth, h: innerHeight }, ${JSON.stringify(limit)});`;
}

/** Cap an evaluate() return value to transportable JSON text. One shape:
 * always { text, truncated, chars } so agents can rely on it. */
export function capEvaluateResult(value, maxChars = 8000) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (typeof json !== "string") {
    try {
      json = JSON.stringify(String(value));
    } catch {
      json = '"[unserializable]"';
    }
  }
  if (json.length > maxChars)
    return { text: json.slice(0, maxChars), truncated: true, chars: json.length };
  return { text: json, truncated: false, chars: json.length };
}

/** Resolve a 1-based marker id against the stored set. Markers die on
 * navigation: the page behind them is gone, so re-capture instead of
 * reusing a stale recipe. */
export function resolveMarker(store, id, currentUrl) {
  if (!store || !Array.isArray(store.markers) || store.markers.length === 0)
    throw Error("No markers captured; use the markers action first");
  if (store.url !== currentUrl)
    throw Error("Markers are stale (page navigated); capture markers again");
  if (!Number.isInteger(id) || id < 1 || id > store.markers.length)
    throw Error(
      `Unknown marker id ${id}; markers run 1..${store.markers.length}`,
    );
  return store.markers[id - 1];
}
