// Bounded diagnostics shared by the browser runner and its regression fixtures.
export function safeBrowserUrl(raw) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol))
      return "(non-HTTP resource)";
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return "(unavailable)";
  }
}

// Best-effort minimization, not a guarantee that arbitrary application prose is public.
export function diagnosticText(raw, limit = 800) {
  return String(raw ?? "")
    .slice(0, 8000)
    .replace(/https?:\/\/[^\s<>"')]+/gi, safeBrowserUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b(password|passwd|token|api[_-]?key|secret|authorization|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

export function createBrowserEvents(capacity = 150) {
  let sequence = 0;
  const rows = [],
    counts = {};
  return {
    record(kind, data = {}) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      rows.push({
        ...data,
        seq: ++sequence,
        kind,
        at: new Date().toISOString(),
      });
      if (rows.length > capacity) rows.shift();
    },
    summary() {
      return { cursor: sequence, counts: { ...counts }, retained: rows.length };
    },
    read({ since = 0, limit = 20, includeText = false } = {}) {
      if (
        !Number.isSafeInteger(since) ||
        since < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 30
      )
        throw Error("Invalid diagnostic cursor or limit");
      const available = rows.filter((row) => row.seq > since);
      const selected = [];
      let chars = 0;
      for (const row of available.slice(0, limit)) {
        const size = JSON.stringify(row).length;
        if (chars + size > 8000) break;
        chars += size;
        selected.push(row);
      }
      return {
        events: selected.map(({ message, ...row }) => ({
          ...row,
          ...(message
            ? {
                message: includeText
                  ? message
                  : "omitted; use includeText:true for minimized page diagnostics",
              }
            : {}),
        })),
        // A cursor from a prior runner can be ahead of this process. Return the
        // live sequence so the caller can recover instead of remaining pinned
        // forever to an impossible future cursor.
        nextCursor: selected.at(-1)?.seq ?? sequence,
        hasMore: available.length > selected.length,
        dropped: Math.max(0, (rows[0]?.seq ?? 1) - since - 1),
        summary: this.summary(),
      };
    },
  };
}

/** Classify the host fetch proxy's cause, never echo URLs, headers or page text. */
export function renderNavigationFailure(error) {
  const known = {
    ECONNREFUSED: ["unreachable", "connection refused; check that the server is running and listening on the requested address/port"],
    ECONNRESET: ["unreachable", "connection reset by the server or transport"],
    UND_ERR_SOCKET: ["unreachable", "connection closed before a response completed"],
    ENOTFOUND: ["dns", "hostname could not be resolved"],
    EAI_AGAIN: ["dns", "temporary hostname resolution failure"],
    ETIMEDOUT: ["timeout", "connection timed out"],
    UND_ERR_CONNECT_TIMEOUT: ["timeout", "connection timed out"],
    CERT_HAS_EXPIRED: ["tls", "TLS certificate expired"],
    DEPTH_ZERO_SELF_SIGNED_CERT: ["tls", "TLS certificate is self-signed"],
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: ["tls", "TLS certificate chain could not be verified"],
    ERR_TLS_CERT_ALTNAME_INVALID: ["tls", "TLS certificate does not match the hostname"],
    EACCES: ["access-denied", "transport access denied"],
    EPERM: ["access-denied", "transport operation denied"],
  };
  const pending = [error], seen = new Set(), codes = [];
  for (let n = 0; pending.length && n < 12; n++) {
    const item = pending.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (Object.hasOwn(known, item.code) && !codes.includes(item.code)) codes.push(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  const text = String(error?.message ?? "");
  const [kind, reason] = /Response exceeds|Remote loading byte cap exceeded/.test(text)
    ? ["response-limit", "navigation response exceeds the byte limit; use a smaller page or resource"]
    : error?.name === "TimeoutError" || error?.name === "AbortError" || /Timeout|timed out/.test(text)
      ? ["timeout", "navigation timeout; check server readiness; use ready:load if networkidle never settles"]
      : codes.length
        ? [known[codes[0]][0], `navigation ${known[codes[0]][0]}: ${codes.map(code => known[code][1]).join("; ")}`]
        : ["navigation-failed", "navigation request failed; transport cause unavailable"];
  return {
    stage: "navigation", kind, codes, reason,
    network: "HTTP(S) uses the harness host network, including localhost. Browser isolation does not imply network isolation.",
    nextStep: kind === "tls" ? "Correct the server certificate or URL; keep certificate verification enabled."
      : kind === "response-limit" ? "Reduce the response size before retrying."
      : "Inspect the server task/logs and listening address/port; confirm the URL with wait_for kind:http before retrying. A failed request alone does not justify deployment, a tunnel, asset rewrites or switching browsers.",
  };
}

export function browserFailure(error, stage, action, waitKind) {
  const text = String(error?.message ?? error);
  const kind = /Browser session lease expired/i.test(text)
    ? "expired"
    : /strict mode|resolved to \d+ elements/i.test(text)
    ? "ambiguous-target"
    : /selector|Unexpected token|Unknown engine/i.test(text)
      ? "invalid-selector"
      : /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(
            text,
          )
        ? "unreachable"
        : /Timeout|timed out|timeout/i.test(text)
          ? "timeout"
          : /closed|crashed|Target.*close/i.test(text)
            ? "closed"
            : /requires|must|Invalid|Unsupported|limit|Supply|Use a selector/i.test(
                  text,
                )
              ? "invalid-request"
              : "action-failed";
  const mutation = stage !== "validation" && (
    ["click", "fill", "press", "select", "check", "hover", "scroll", "drag", "evaluate", "back", "forward", "reload", "navigate", "new_tab"].includes(action) ||
    (action === "wait" && waitKind === "function")
  );
  return {
    stage,
    kind,
    outcome: mutation ? "unknown; effects may have occurred" : "not-completed",
    nextStep:
      kind === "expired"
        ? "The lease has expired and cannot be renewed. Open a new session, reacquire current state, and reconcile any pending mutation before continuing."
        : kind === "unreachable"
        ? "Check the server task and HTTP URL before navigating again."
        : /action limit reached/i.test(text)
          ? "Inspect current state and renew the lease; no action was dispatched."
        : kind === "closed"
          ? "Open a new session and reconcile any previous mutation."
          : kind === "ambiguous-target"
            ? "Inspect current state and choose one exact target."
            : /Stale browser reference/.test(text)
              ? "Capture snapshot or markers again; the old reference no longer identifies a live node in this tab."
            : mutation
                  ? "Inspect current state and logs before retrying; do not replay a mutation automatically."
                  : "Inspect the current URL, target and diagnostics; correct the cause before retrying.",
  };
}

// Compare only caller-supplied text, without returning existing form values.
export function verifyBrowserText(element, { text }) {
  if (!element.getClientRects().length || getComputedStyle(element).visibility !== "visible" || element.closest('[hidden],[inert],[aria-hidden="true"]'))
    throw Error("verify requires a visible text control or preview");
  const tag = element.tagName.toLowerCase();
  if (tag === "input" && !["text", "search", "url", "email", "tel"].includes(element.type))
    throw Error("Unsupported verification field type");
  if (["script", "style", "select", "option"].includes(tag)) throw Error("Unsupported verification target");
  const value = ["input", "textarea"].includes(tag) ? element.value : element.innerText;
  return { matches: value === text, comparison: "exact", evidence: "Current field/preview only; not proof of submission or publication" };
}

// Fixed read-only evaluator. No caller-provided JavaScript, form values or script bodies.
export function inspectBrowserElement(element, { properties = [] } = {}) {
  const clean = (value, n = 240) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  const css = getComputedStyle(element),
    rect = element.getBoundingClientRect();
  const bounds = Object.fromEntries(
    ["x", "y", "width", "height"].map((key) => [
      key,
      Math.round(rect[key] * 10) / 10,
    ]),
  );
  const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
  const top = document.elementFromPoint(x, y);
  const summary = (el) =>
    el
      ? {
          tag: el.tagName.toLowerCase(),
          id: clean(el.id),
          class: clean(el.getAttribute("class")),
        }
      : null;
  const allowed = [
    "display",
    "visibility",
    "opacity",
    "position",
    "z-index",
    "width",
    "height",
    "overflow-x",
    "overflow-y",
    "font-size",
    "line-height",
    "color",
    "background-color",
    "padding",
    "margin",
    "gap",
    "flex-direction",
    "flex-wrap",
    "grid-template-columns",
    "transform",
    "pointer-events",
  ];
  let visited = 0,
    chars = 0,
    truncated = false;
  const escape = (s) =>
    clean(s, 300).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const html = (el, depth = 0) => {
    if (++visited > 60 || depth > 4 || chars > 5000) {
      truncated = true;
      return "";
    }
    if (el.nodeType === Node.TEXT_NODE) {
      const t = escape(el.textContent);
      chars += t.length;
      return t;
    }
    if (el.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = el.tagName.toLowerCase();
    if (
      /^(script|style|template|textarea|select|option)$/.test(tag) ||
      el.matches('input[type="hidden"],[hidden],[inert],[aria-hidden="true"]')
    )
      return `<${tag}>[omitted]</${tag}>`;
    const attrs = [
      "id",
      "class",
      "role",
      "type",
      "aria-label",
      "aria-expanded",
      "aria-disabled",
      "disabled",
      "required",
    ]
      .filter((key) => el.hasAttribute(key))
      .map((key) => ` ${key}="${escape(el.getAttribute(key))}"`)
      .join("");
    chars += tag.length * 2 + attrs.length + 5;
    let body = "";
    for (const child of el.childNodes) {
      if (visited >= 60 || chars > 5000) {
        truncated = true;
        break;
      }
      body += html(child, depth + 1);
    }
    return `<${tag}${attrs}>${body}</${tag}>`;
  };
  return {
    element: summary(element),
    ...(element.tagName === "SELECT" ? {
      options: Array.from(element.options).slice(0, 30).map(option => ({ label: option.label.length <= 256 ? option.label : null, labelTruncated: option.label.length > 256, disabled: option.disabled || !!option.closest("optgroup[disabled]") })),
      optionsTruncated: element.options.length > 30,
    } : {}),
    bounds,
    visible:
      !!element.getClientRects().length &&
      css.visibility === "visible" &&
      !element.closest('[hidden],[inert],[aria-hidden="true"]'),
    disabled: element.matches(':disabled,[aria-disabled="true"]'),
    inViewport:
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth,
    centerHit: {
      targetReceivesPointer:
        !!top && (top === element || element.contains(top)),
      element: summary(top),
    },
    styles: Object.fromEntries(
      (properties.length ? properties : allowed.slice(0, 16))
        .filter((key) => allowed.includes(key))
        .map((key) => [key, clean(css.getPropertyValue(key))]),
    ),
    html: html(element).slice(0, 6000),
    truncated,
    limitations:
      "Bounded structural HTML with allowlisted attributes; values, scripts and hidden content omitted. Center hit is a point sample, not a full actionability or accessibility test. Main frame unless frame selector supplied.",
  };
}
