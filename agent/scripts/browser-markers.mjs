// Numbered overlays and in-page result bounds for the browser runner.
export const MARKER_LIMIT = 50;
export const MARKER_OVERLAY_ID = "pi-marker-overlay";

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
