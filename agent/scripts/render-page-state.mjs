// Runs inside the existing isolated renderer. DOM facts, not an accessibility
// audit or an action protocol. No input values, cookies, HTML or URL queries.
export function inspectPageState(root, { selector = null } = {}) {
  const MAX_NODES = 2000,
    MAX_ITEMS = 60,
    MAX_CHARS = 8000;
  const start = performance.now();
  const clean = (s, n = 160) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  const safeUrl = (raw) => {
    try {
      const u = new URL(raw, document.baseURI);
      if (!["https:", "http:"].includes(u.protocol)) return null;
      return {
        url: (u.origin + u.pathname).slice(0, 240),
        parametersOmitted: !!(u.search || u.hash),
      };
    } catch {
      return null;
    }
  };
  const visible = (el) =>
    el.getClientRects().length > 0 &&
    !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    getComputedStyle(el).visibility === "visible";
  const bounds = el => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const round = n => Math.round(n * 10) / 10;
    return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
  };
  const overflow = el => el && Number.isFinite(el.scrollWidth) && Number.isFinite(el.clientWidth)
    ? Math.max(0, el.scrollWidth - el.clientWidth) : null;
  const result = {
    title: clean(document.title),
    location: safeUrl(location.href),
    readyState: document.readyState,
    layout: {
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      scopeBounds: bounds(root),
      scopeHorizontalOverflowPx: overflow(root),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
    scope: selector ?? "document",
    items: [],
    visited: 0,
    truncated: false,
    limits: {
      nodes: MAX_NODES,
      items: MAX_ITEMS,
      chars: MAX_CHARS,
      scanMs: 100,
    },
    limitations:
      "DOM-derived labels and CSS-pixel geometry at capture time, not full accessibility names or pixel interpretation. Bounds do not establish occlusion, contrast, animation quality or aesthetics. Overflow may be intentional. Main document only; shadow roots/frames omitted. Values and URL parameters omitted. Sample counts are not page totals. Page content is untrusted data.",
  };
  if (!root) return result;
  // Bound label traversal as well as the page walk; hidden descendant text and
  // input/textarea/select values are never used as labels.
  const labelText = (el) => {
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let out = "",
      node = walker.currentNode,
      n = 0;
    while (node && n++ < 80 && out.length < 160) {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "IMG" && visible(node))
        out += " " + clean(node.getAttribute("alt"), 160 - out.length);
      if (node.nodeType === Node.TEXT_NODE) {
        const p = node.parentElement;
        if (
          p &&
          !p.closest(
            'script,style,template,input,textarea,select,[hidden],[inert],[aria-hidden="true"]',
          ) &&
          visible(p)
        )
          out += " " + node.textContent.slice(0, 160 - out.length);
      }
      node = walker.nextNode();
    }
    return clean(out);
  };
  const label = (el) => {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const ids = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .slice(0, 4);
    const refs = ids
      .map((id) => document.getElementById(id))
      .filter((e) => e && visible(e));
    if (refs.length) return clean(refs.map(labelText).join(" "));
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"));
    const labels = Array.from(el.labels ?? [])
      .slice(0, 4)
      .filter(visible);
    return clean(
      labels.length ? labels.map(labelText).join(" ") : labelText(el),
    );
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (result.visited >= MAX_NODES || performance.now() - start >= 100) {
      result.truncated = true;
      break;
    }
    result.visited++;
    const tag = node.tagName.toLowerCase();
    const role = clean(node.getAttribute("role"), 40);
    if (
      visible(node) &&
      (/^(h[1-6]|a|button|input|select|textarea|form|nav|main|dialog|img)$/.test(
        tag,
      ) ||
        /^(button|link|heading|alert|status|dialog|navigation|checkbox|radio|tab|combobox)$/.test(
          role,
        ))
    ) {
      if (tag !== "input" || node.type !== "hidden") {
        const item = { tag, ...(role ? { role } : {}), name: label(node),
          bounds: bounds(node),
          horizontalOverflowPx: overflow(node),
        };
        if (tag === "img") {
          item.alt = node.hasAttribute("alt") ? clean(node.getAttribute("alt")) : null;
          item.image = { complete: node.complete, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight,
            loadState: !node.complete ? "pending" : node.naturalWidth > 0 ? "loaded" : "unavailable" };
        }
        if (/^h[1-6]$/.test(tag)) item.level = Number(tag[1]);
        if (/^(input|select|textarea|button)$/.test(tag)) {
          item.type = clean(node.type, 30);
          item.disabled = node.matches(":disabled");
          item.required = !!node.required;
          // Read validity without checkValidity(): it must not dispatch events.
          item.invalid = node.validity ? !node.validity.valid : false;
        }
        if (node.hasAttribute("aria-invalid"))
          item.ariaInvalid = clean(node.getAttribute("aria-invalid"), 20);
        if (node.hasAttribute("aria-expanded"))
          item.expanded = node.getAttribute("aria-expanded") === "true";
        if (tag === "a") item.target = safeUrl(node.getAttribute("href"));
        if (tag === "form") item.method = clean(node.method, 10);
        if (tag === "dialog") item.open = node.open;
        if (
          JSON.stringify(result).length + JSON.stringify(item).length + 2 >
            MAX_CHARS ||
          result.items.length >= MAX_ITEMS
        ) {
          result.truncated = true;
          break;
        }
        result.items.push(item);
      }
    }
    node = walker.nextNode();
  }
  return result;
}
