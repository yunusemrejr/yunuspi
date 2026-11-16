// Functions serialized into the page: no host closures, secrets or imports.
// Keep references bound to actual DOM nodes, never re-resolve an old CSS path.
export function collectBrowserTargets(root, { limit = 50, viewportOnly = false } = {}) {
  const elements = [], rows = [];
  const scopes = [root];
  let visited = 0, truncated = false;
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const visible = el => el.getClientRects().length && !el.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(el).visibility === "visible";
  const labelText = element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node, text = '', count = 0;
    while ((node = walker.nextNode()) && count++ < 80 && text.length < 100) {
      const parent = node.parentElement;
      if (parent && !parent.closest('script,style,input,textarea,select,[hidden],[inert],[aria-hidden="true"]') && visible(parent)) text += ' ' + node.textContent.slice(0, 100 - text.length);
    }
    return clean(text);
  };
  const selector = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="combobox"],[role="textbox"],[role="slider"],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let el = walker.currentNode;
    while (el) {
      if (++visited > 4000 || rows.length >= limit) { truncated = true; break; }
      if (el.shadowRoot) scopes.push(el.shadowRoot);
      if (el.matches?.(selector) && visible(el)) {
        const rect = el.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        if (!viewportOnly || inViewport) {
          const labels = [...(el.labels ?? [])].filter(visible).map(labelText);
          const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => el.getRootNode().getElementById?.(id)).filter(node => node && visible(node)).map(labelText);
          const name = clean(el.getAttribute('aria-label') || labelled.join(' ') || labels.join(' ') ||
            (!el.matches('input,textarea,select,[contenteditable]') ? labelText(el) : '') || el.getAttribute('placeholder') || el.getAttribute('title'));
          elements.push(el);
          rows.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name,
            disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
            ...(el.matches('input[type="checkbox"],input[type="radio"]') ? { checked: el.checked } : {}),
            ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}),
            inViewport, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
        }
      }
      el = walker.nextNode();
    }
    if (truncated) break;
  }
  return { elements, rows, truncated, visited };
}

export function readBrowserPage(root, { offset = 0, maxChars = 8000, query } = {}) {
  const textCap = 250000, nodeCap = 20000;
  const hidden = 'script,style,template,noscript,input,textarea,select,[hidden],[inert],[aria-hidden="true"]';
  const parts = [], scopes = [root];
  let visited = 0, chars = 0, truncated = false, sourceRemaining = 1000000;
  const isHigh = code => code >= 0xd800 && code <= 0xdbff;
  const splitsPair = (value, index) => {
    const next = value.charCodeAt(index);
    return isHigh(value.charCodeAt(index - 1)) && next >= 0xdc00 && next <= 0xdfff;
  };
  const readText = (node, capacity) => {
    const chunks = [];
    const length = node.length;
    let start = 0, kept = 0, pendingSpace = false;
    while (start < length && sourceRemaining > 0) {
      const count = Math.min(8192, length - start, sourceRemaining);
      let raw = node.substringData(start, count);
      sourceRemaining -= count;
      // Revisit a trailing high surrogate with the next chunk so normalization
      // and copying see the complete pair. Charge both reads to the budget.
      if (start + count < length && isHigh(raw.charCodeAt(count - 1))) raw = raw.slice(0, -1);
      if (!raw.length) break;
      start += raw.length;
      const collapsed = raw.replace(/\s+/g, ' ');
      const body = collapsed.trim();
      if (!body) { pendingSpace = true; continue; }
      const prefix = kept && (pendingSpace || collapsed.startsWith(' ')) ? ' ' : '';
      const next = prefix + body;
      const room = capacity - kept;
      if (next.length > room) {
        chunks.push(next.slice(0, splitsPair(next, room) ? room - 1 : room));
        truncated = true;
        break;
      }
      chunks.push(next);
      kept += next.length;
      pendingSpace = collapsed.endsWith(' ');
    }
    if (start < length) truncated = true;
    return chunks.join('');
  };
  // DOM text only: skip form contents and hidden nodes; follow open shadow roots.
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.currentNode;
    while (node) {
      if (++visited > nodeCap) { truncated = true; break; }
      if (node.shadowRoot && !node.closest(hidden)) scopes.push(node.shadowRoot);
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement ?? scope.host;
        if (parent && !parent.closest(hidden) && parent.getClientRects().length && getComputedStyle(parent).visibility === 'visible') {
          const separator = parts.length ? 1 : 0;
          const text = readText(node, Math.max(0, textCap - chars - separator));
          if (text) { parts.push(text); chars += separator + text.length; }
          if (truncated) break;
        }
      }
      node = walker.nextNode();
    }
    if (truncated) break;
  }
  const text = parts.join('\n');
  // Native lowercase keeps contextual case behavior. Only build a coordinate
  // mapping when it expands the text (for example, capital dotted I).
  let start = splitsPair(text, offset) ? offset + 1 : offset;
  if (query) {
    const folded = text.toLowerCase();
    const expanded = folded.length !== text.length;
    const foldedOffset = expanded ? text.slice(0, start).toLowerCase().length : start;
    start = folded.indexOf(query.toLowerCase(), foldedOffset);
    if (expanded && start >= 0) {
      let sourceIndex = 0, foldedIndex = 0;
      for (const point of text) {
        foldedIndex += point.toLowerCase().length;
        if (foldedIndex > start) { start = sourceIndex; break; }
        sourceIndex += point.length;
      }
    }
  }
  let end = start < 0 ? offset : Math.min(text.length, start + maxChars);
  if (start >= 0 && splitsPair(text, end)) end--;
  return { text: start < 0 ? '' : text.slice(start, end), offset: start < 0 ? offset : start,
    nextOffset: end, hasMore: start >= 0 && end < text.length, chars: text.length, truncated,
    ...(query ? { found: start >= 0 } : {}),
    limitations: 'Visible DOM text, capped at 250000 UTF-16 code units, 20000 nodes, and 1000000 source code units per read. Form values and hidden text are omitted. Frame scope is explicit; open shadow roots follow light DOM. Offsets refer to this page state.' };
}

export function browserHumanHelp(root) {
  const visible = el => el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(el).visibility === 'visible';
  const widget = [...root.querySelectorAll('iframe[src],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]')].slice(0, 100).find(el =>
    visible(el) && /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(el.getAttribute('src') || el.className));
  const text = (document.title + '\n' + (document.body?.innerText ?? '').slice(0, 4000));
  const challenge = /verify (?:that )?you (?:are|are a) human|verify you.?re human|checking your browser|unusual traffic from your computer|complete the (?:security check|captcha)/i.test(text);
  return widget || challenge ? {
    kind: 'verification', suspected: true,
    nextStep: 'Inspect the screenshot. If verification blocks progress, use request_help to ask the user for the visible challenge answer. Enter only their supplied answer into the observed field. Do not guess, bypass or repeatedly retry challenges. Image-selection or account/device verification may require the user to complete it in a session opened with visible:true on the desktop. After they reply, inspect whether verification succeeded before continuing.',
  } : null;
}
