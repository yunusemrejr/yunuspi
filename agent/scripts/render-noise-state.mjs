// Runs in the existing capture page. These are review candidates, not taste,
// authorship detection, accessibility certification, or instructions to edit.
export function inspectNoiseState(root) {
  const started = performance.now(), maxNodes = 600, maxFindings = 6, maxMs = 40;
  const result = {findings: [], visited: 0, truncated: false,
    scope: 'Visible main-document DOM sample. Repetition can be intentional; inspect these locations before changing them. No aesthetic score, input values or copied page text.',
    limits: {nodes: maxNodes, findings: maxFindings, scanMs: maxMs}};
  if (!root || !['text/html', 'application/xhtml+xml'].includes(document.contentType)) return result;
  const excluded = 'script,style,template,input,textarea,select,pre,code,blockquote,q,[contenteditable],[hidden],[inert],[aria-hidden="true"]';
  const visible = node => {
    if (node.closest(excluded)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // visibility and opacity can be inherited from ancestors; hidden responsive
    // clones and transparent animation staging must not count as repetitions.
    for (let at = node, depth = 0; at; at = at.parentElement) {
      if (++depth > 32) return false;
      const style = getComputedStyle(at);
      if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const identify = node => {
    const parts = [];
    for (let at = node; at && parts.length < 4; at = at.parentElement) {
      let index = 1, steps = 0;
      for (let sibling = at.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (++steps > 256) return null;
        if (sibling.localName === at.localName) index++;
      }
      parts.unshift(`${at.localName}:nth-of-type(${index})`);
    }
    return parts.join(' > ').slice(0, 220);
  };
  const add = (kind, node, other) => {
    if (result.findings.length === maxFindings) {result.truncated = true; return;}
    result.findings.push({kind, selector: identify(node), ...(other ? {relatedSelector: identify(other)} : {})});
  };
  const text = node => {
    // Plain text only: nested labels, icons, hidden children and long content
    // require semantic interpretation and are deliberately left alone.
    if (node.childElementCount || node.childNodes.length > 8) return '';
    return (node.textContent ?? '').slice(0, 321).replace(/\s+/g, ' ').trim();
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (result.visited >= maxNodes || performance.now() - started >= maxMs || result.findings.length === maxFindings) {result.truncated = true; break;}
    result.visited++;
    if (visible(node)) {
      const label = text(node);
      if (label && label.length <= 320) {
        if (/^lorem ipsum dolor sit amet\b/i.test(label) || /^(?:insert (?:title|description|content) here|your (?:headline|title|description) here|placeholder (?:title|text|content))\.?$/i.test(label))
          add('placeholder-copy', node);
        const previous = node.previousElementSibling;
        if (previous && visible(previous) && label === text(previous) && node.localName === previous.localName &&
            ['role','aria-label','aria-labelledby','aria-controls','aria-current','aria-expanded'].every(name => node.getAttribute(name) === previous.getAttribute(name))) {
          if (/^h[1-6]$/.test(node.localName) && !['none','presentation'].includes(node.getAttribute('role')) || node.localName === 'label' && node.htmlFor && node.htmlFor === previous.htmlFor)
            add('repeated-adjacent-label', node, previous);
          // Equal display labels alone do not establish equal actions. Only
          // adjacent links with the same complete destination and target qualify.
          else if (node.localName === 'a' && node.hasAttribute('href') && node.href === previous.href && node.target === previous.target && !node.hasAttribute('download') && !previous.hasAttribute('download'))
            add('repeated-adjacent-link', node, previous);
        }
      }
    }
    node = walker.nextNode();
  }
  return result;
}
