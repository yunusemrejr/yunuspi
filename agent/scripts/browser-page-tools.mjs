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
  const parts = [], scopes = [root];
  let visited = 0, chars = 0, truncated = false;
  // DOM text only: skip form contents and hidden nodes; follow open shadow roots.
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.currentNode;
    while (node) {
      if (++visited > 20000 || chars >= 250000) { truncated = true; break; }
      if (node.shadowRoot) scopes.push(node.shadowRoot);
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && !parent.closest('script,style,template,noscript,input,textarea,select,[hidden],[inert],[aria-hidden="true"]') && parent.getClientRects().length && getComputedStyle(parent).visibility === 'visible') {
          const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 250000 - chars);
          if (text) { parts.push(text); chars += text.length + 1; }
        }
      }
      node = walker.nextNode();
    }
    if (truncated) break;
  }
  const text = parts.join('\n');
  const start = query ? text.toLowerCase().indexOf(query.toLowerCase(), offset) : offset;
  const end = start < 0 ? offset : Math.min(text.length, start + maxChars);
  return { text: start < 0 ? '' : text.slice(start, end), offset: start < 0 ? offset : start,
    nextOffset: end, hasMore: start >= 0 && end < text.length, chars: text.length, truncated,
    ...(query ? { found: start >= 0 } : {}),
    limitations: 'Visible DOM text, capped at 250000 characters/20000 nodes; form values and hidden text omitted. Frame scope is explicit; open shadow roots follow light DOM. Offsets refer to this page state, not a durable document.' };
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
