// Runs in the existing capture page. These are review candidates, not taste,
// authorship detection, accessibility certification, or instructions to edit.
export function inspectNoiseState(root, options = {}) {
  const started = performance.now(), maxNodes = 600, maxFindings = options.detailed ? 12 : 6, maxMs = 40;
  const result = {findings: [], visited: 0, truncated: false,
    scope: 'Visible main-document DOM sample. Patterns can be intentional; inspect these locations before changing them. No aesthetic score, input values or copied page text. New density and font counts use wholly visible text elements in the current viewport; accent checks use intersecting panels; articles, quotations, code and marked user content are excluded. CSS family declarations do not prove which font rendered. Shadow roots, frames and canvas require separate review.',
    limits: {nodes: maxNodes, findings: maxFindings, scanMs: maxMs, animations: 100, textCharsPerElement: 4096}};
  if (!root || !['text/html', 'application/xhtml+xml'].includes(document.contentType)) return result;
  // aria-hidden only hides from assistive technology. Decorative branding and
  // dots often use it and still paint pixels, so visual checks must inspect them.
  const excluded = 'script,style,template,input,textarea,select,pre,code,blockquote,q,article,[role="article"],[contenteditable],[data-user-content],[data-yunuspi-noise="ignore"],[hidden],[inert]';
  const semanticState = '[role="status"],[role="alert"],[role="progressbar"],[role="timer"],[role="log"],[aria-live]:not([aria-live="off"]),[aria-busy],[aria-invalid],[aria-current]';
  const styles = new Map(), rectangles = new Map(), visibility = new Map();
  const styleOf = node => {if (!styles.has(node)) styles.set(node, getComputedStyle(node)); return styles.get(node);};
  const rectOf = node => {if (!rectangles.has(node)) rectangles.set(node, node.getBoundingClientRect()); return rectangles.get(node);};
  const visible = node => {
    if (visibility.has(node)) return visibility.get(node);
    let shown = !node.closest(excluded);
    const rect = rectOf(node);
    if (rect.width <= 0 || rect.height <= 0) shown = false;
    // Ancestor opacity and inherited visibility hide responsive/animation clones.
    for (let at = node, depth = 0; shown && at; at = at.parentElement) {
      if (++depth > 32) {shown = false; break;}
      const style = styleOf(at);
      if (style.visibility !== 'visible' || Number(style.opacity) === 0) shown = false;
    }
    visibility.set(node, shown);
    return shown;
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
  const add = (kind, node, facts = {}, other) => {
    if (result.findings.length === maxFindings) {result.truncated = true; return;}
    result.findings.push({kind, selector: identify(node), ...facts, ...(other ? {relatedSelector: identify(other)} : {})});
  };
  const text = node => {
    if (node.childElementCount || node.childNodes.length > 8) return '';
    return (node.textContent ?? '').slice(0, 321).replace(/\s+/g, ' ').trim();
  };
  const directText = node => {
    let value = '', children = 0;
    for (const child of node.childNodes) {
      if (++children > 64 || value.length >= 4096) {result.truncated = true; break;}
      if (child.nodeType === Node.TEXT_NODE) value += child.textContent.slice(0, 4096 - value.length);
    }
    return value.replace(/\s+/g, ' ').trim();
  };
  const areaInViewport = rect => Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) * Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
  const isRounded = (style, size) => ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(key => {
    const radius = parseFloat(style[key]);
    return Number.isFinite(radius) && (style[key].includes('%') ? radius >= 40 : radius >= size / 3);
  });
  const hasStateMeaning = node => {
    const state = node.closest(semanticState);
    // A live chat/log region announces arbitrary content; it does not make
    // every decorative marker in that content a necessary state indicator.
    return state && (state === node || state.childElementCount <= 3 && rectOf(state).height <= 64);
  };
  const HYPE = new Set(['new','live','beta','ai','fast','secure','private','modern','smart','pro','featured','verified','trending','popular']);
  // Interactive name check: visible text, labels, aria names and titles count.
  // Placeholder text is not a name; submit values and image-input alt are.
  const controlNamed = node => {
    if ((node.getAttribute('aria-label') || '').trim() || (node.getAttribute('title') || '').trim()) return true;
    const ids = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 4);
    if (ids.some(id => { const e = document.getElementById(id); return e && visible(e) && directText(e); })) return true;
    if (node instanceof HTMLInputElement) {
      if (/^(submit|reset|button)$/i.test(node.type)) return (node.value || '').trim().length > 0;
      if (/^image$/i.test(node.type)) return (node.getAttribute('alt') || '').trim().length > 0;
      if (node.type === 'hidden') return true;
    }
    if (node.labels && [...node.labels].some(l => visible(l))) return true;
    if (directText(node)) return true;
    const titled = node.querySelector('svg title');
    return Boolean(titled && titled.textContent.trim());
  };
  const painted = color => !['transparent','rgba(0, 0, 0, 0)'].includes(color) && !/rgba\([^)]*,\s*0\)$/.test(color);
  const animations = document.getAnimations();
  if (animations.length > 100) result.truncated = true;
  const moving = new Map();
  for (const animation of animations.slice(0, 100)) {
    const effect = animation.effect, timing = effect?.getTiming(), target = effect?.target;
    if (!target || animation.playState !== 'running' || !(timing.iterations > 1)) continue;
    const allFrames = effect.getKeyframes();
    const frames = allFrames.slice(0, 64);
    if (allFrames.length > 64) result.truncated = true;
    // Observe changing visual properties, not a class name or declared animation.
    if (!['opacity','visibility','transform','scale','filter','boxShadow','backgroundColor'].some(key => new Set(frames.map(frame => frame[key]).filter(value => value !== undefined)).size > 1)) continue;
    const list = moving.get(target) ?? [];
    list.push({pseudo: effect.pseudoElement || null, durationMs: typeof timing.duration === 'number' ? Math.round(timing.duration) : null, repeating: true});
    moving.set(target, list);
  }
  const fonts = new Map(), regions = new Map(), borders = [], tiles = [], animatedPills = new Set();
  const missingAlt = [], unnamed = [], emojiChrome = [], hypeBadges = [], terminals = [];
  let dots = [];
  const pseudoStyle = (node, which) => getComputedStyle(node, which);
  const regionFor = node => {
    const region = node.closest('form,nav,header,section,aside,main,[role="dialog"],[role="toolbar"],[role="menu"],[role="region"]');
    return region && (root === region || root.contains(region)) ? region : null;
  };
  const regionData = region => {
    if (!regions.has(region)) regions.set(region, {words: 0, chars: 0, blocks: 0, controls: 0});
    return regions.get(region);
  };
  let node = root;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (node) {
    if (result.visited >= maxNodes || performance.now() - started >= maxMs || result.findings.length === maxFindings) {result.truncated = true; break;}
    result.visited++;
    // Form field values are excluded, but visible fields still count as controls.
    // Fields are also invisible to visible() (they match its exclusion list),
    // so unnamed-field detection lives here rather than in the main walk.
    if (node.matches('input,textarea,select') && node.parentElement && visible(node.parentElement) && areaInViewport(rectOf(node)) > 0 && styleOf(node).visibility === 'visible' && Number(styleOf(node).opacity) > 0) {
      const region = regionFor(node);
      if (region) regionData(region).controls++;
      if (!node.closest('[aria-hidden="true"]') && !controlNamed(node)) unnamed.push({node});
    }
    if (visible(node)) {
      const label = text(node);
      if (label && label.length <= 320) {
        if (/^lorem ipsum dolor sit amet\b/i.test(label) || /^(?:insert (?:title|description|content) here|your (?:headline|title|description) here|placeholder (?:title|text|content))\.?$/i.test(label))
          add('placeholder-copy', node, {reason: 'Literal placeholder copy remains visible.'});
        if (!hasStateMeaning(node) && (/^[●•]\s+\S/.test(label) || /^(?:🟢|🟡|🔴)\s+\S/.test(label)))
          add('text-status-dot', node, {reason: 'A literal dot or status-emoji character prefixes this label (the text form of the decorative status dot). Remove it unless it encodes a real, changing state with a text equivalent.'});
        if (!node.closest('table,[role="table"],[role="grid"],figure,[role="figure"],svg,canvas') && (
          /\btrusted by\s+(?:over\s+|more than\s+)?[\d,.]+[km]?\+?\s+(?:teams|companies|businesses|customers|users|organizations)\b/i.test(label) ||
          /\b\d+(?:[.,]\d+)?\s*(?:x|×|times)\s+(?:faster|better|more productive|more efficient)\b/i.test(label) ||
          /\b\d+(?:[.,]\d+)?%\s*(?:uptime|availability|accuracy|faster|cost savings|savings)\b/i.test(label) ||
          /\b(?:save|reduce costs by|cut costs by)\s+(?:up to\s+)?\d+(?:[.,]\d+)?%/i.test(label)))
          add('factual-claim-evidence', node, {reason: 'Quantified marketing or performance copy needs a source and matching scope. This pattern does not establish that the claim is false or unsupported; inspect its evidence with claim_check.'});
        const previous = node.previousElementSibling;
        if (previous && visible(previous) && label === text(previous) && node.localName === previous.localName &&
            ['role','aria-label','aria-labelledby','aria-controls','aria-current','aria-expanded'].every(name => node.getAttribute(name) === previous.getAttribute(name))) {
          if (/^h[1-6]$/.test(node.localName) && !['none','presentation'].includes(node.getAttribute('role')) || node.localName === 'label' && node.htmlFor && node.htmlFor === previous.htmlFor)
            add('repeated-adjacent-label', node, {reason: 'Adjacent equivalent labels repeat the same visible text.'}, previous);
          else if (node.localName === 'a' && node.hasAttribute('href') && node.href === previous.href && node.target === previous.target && !node.hasAttribute('download') && !previous.hasAttribute('download'))
            add('repeated-adjacent-link', node, {reason: 'Adjacent links repeat text and complete destination.'}, previous);
        }
      }
      const rect = rectOf(node), style = styleOf(node), area = areaInViewport(rect);
      if (area > 0) {
        const copy = rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth ? directText(node) : '', words = (copy.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
        const control = node.matches('button,a[href],[role="button"],[role="link"],[role="tab"],[role="switch"],[role="checkbox"]');
        const region = regionFor(node);
        if (region) {
          const data = regionData(region);
          data.words += words; data.chars += copy.length; data.blocks += words > 0 ? 1 : 0; data.controls += control ? 1 : 0;
        }
        if (words && node.matches('h1,h2,h3,h4,h5,h6,label,button,a[href],[role="button"],[role="tab"]')) {
          // Count one declared primary family per text-bearing UI element;
          // fallback stacks, font sizes, bold states and icon fonts are not families.
          const family = style.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
          const data = fonts.get(family) ?? {count: 0, node}; data.count++; fonts.set(family, data);
        }
        if (node.matches('div,section,aside,li,a') && rect.width >= 120 && rect.height >= 32 && !hasStateMeaning(node) && !node.querySelector(semanticState)) {
          // Accent rail: a colored edge (2px+) as the panel's only strong
          // border, or an absolutely positioned pseudo-element bar doing the same.
          if (parseFloat(style.borderLeftWidth) >= 2 && ['borderTopWidth','borderRightWidth','borderBottomWidth'].every(key => parseFloat(style[key]) <= 1) && painted(style.borderLeftColor))
            borders.push({node, widthPx: parseFloat(style.borderLeftWidth)});
          else for (const which of ['::before', '::after']) {
            const bar = pseudoStyle(node, which);
            if (['none', 'normal'].includes(bar.content) || bar.position !== 'absolute' || !painted(bar.backgroundColor)) continue;
            const width = parseFloat(bar.width), height = parseFloat(bar.height);
            if (width >= 2 && width <= 8 && height >= rect.height * 0.6) { borders.push({node, widthPx: width, pseudo: which}); break; }
          }
        }
        // Decorative dot: a small painted round mark with no text, prefixing a
        // short label (static or glowing). Live/status semantics are exempt.
        if (!hasStateMeaning(node) && !node.matches('[aria-pressed],[aria-checked],[aria-selected],[role="switch"],[role="checkbox"]') && rect.height <= 64) {
          const label = directText(node);
          if (label && label.length <= 40) {
            const candidates = [...[...node.children].slice(0, 3).map(child => ({element: child, style: styleOf(child), rect: rectOf(child), pseudo: null})),
              ...['::before', '::after'].map(which => { const dot = pseudoStyle(node, which); return {element: node, style: dot, rect: {width: parseFloat(dot.width), height: parseFloat(dot.height)}, pseudo: which}; })];
            let found = false;
            for (const dot of candidates) {
              if (dot.pseudo && ['none', 'normal'].includes(dot.style.content)) continue;
              if (!dot.pseudo && (directText(dot.element) || dot.element.childElementCount)) continue;
              const {width, height} = dot.rect;
              if (width >= 4 && width <= 14 && height >= 4 && height <= 14 && width / height >= .7 && width / height <= 1.4 && painted(dot.style.backgroundColor) && isRounded(dot.style, Math.min(width, height))) {
                dots.push({node, widthPx: Math.round(width), glow: dot.style.boxShadow !== 'none', pseudo: dot.pseudo}); found = true; break;
              }
            }
            if (!found) {
              // Sibling layout: dot and label as separate flex/grid children.
              for (const sibling of [node.previousElementSibling, node.nextElementSibling]) {
                if (!sibling || !visible(sibling) || directText(sibling) || sibling.childElementCount) continue;
                const siblingRect = rectOf(sibling), siblingStyle = styleOf(sibling);
                const width = siblingRect.width, height = siblingRect.height;
                if (width >= 4 && width <= 14 && height >= 4 && height <= 14 && width / height >= .7 && width / height <= 1.4 && painted(siblingStyle.backgroundColor) && isRounded(siblingStyle, Math.min(width, height))) {
                  dots.push({node, widthPx: Math.round(width), glow: siblingStyle.boxShadow !== 'none', pseudo: null, sibling: identify(sibling)}); break;
                }
              }
            }
          }
        }
        // Icon tile: a square (or round) tinted/bordered box wrapping one icon.
        if (rect.width >= 24 && rect.width <= 72 && Math.abs(rect.width - rect.height) <= 2 && !directText(node) &&
            (node.matches('svg') || node.childElementCount === 1 && (node.firstElementChild.matches('svg,img') || node.firstElementChild.matches('i,span') && !node.firstElementChild.childElementCount && directText(node.firstElementChild).length <= 32)) &&
            (painted(style.backgroundColor) || parseFloat(style.borderTopWidth) >= 1 && painted(style.borderTopColor)) && parseFloat(style.borderTopLeftRadius) >= 4 &&
            !node.matches('button,a[href],input,[role="button"]') && !hasStateMeaning(node))
          tiles.push({node, sizePx: Math.round(rect.width)});
        // Missing alt: a visible image without any alt attribute. Decorative
        // images carry alt=""; presentation and hidden images are exempt.
        if (node.matches('img') && !node.hasAttribute('alt') && !node.closest('[aria-hidden="true"],[role="presentation"]'))
          missingAlt.push({node});
        // Unnamed controls: interactive elements with no accessible name.
        // Fields are handled in the dedicated branch above (see there).
        if (node.matches('button,a[href],[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="radio"]')
            && !node.closest('[aria-hidden="true"]') && !controlNamed(node))
          unnamed.push({node});
        // Emoji in chrome: headings, buttons, links and tabs carrying emoji.
        // Article and user-content prose is already outside this scan.
        if (node.matches('h1,h2,h3,h4,h5,h6,button,a[href],[role="button"],[role="tab"]') && /\p{Extended_Pictographic}/u.test((node.textContent ?? '').slice(0, 200)))
          emojiChrome.push({node});
        // Hype badge: a capsule whose whole label is one hype word. Animated
        // status pills are filtered at aggregation; they have their own cue.
        if (rect.width <= 300 && rect.height <= 64 && isRounded(style, rect.height) && !hasStateMeaning(node) && !node.matches('button,a,input,[role="button"],[role="switch"],[role="checkbox"]')) {
          const badgeLabel = (copy + ' ' + [...node.children].slice(0, 3).map(directText).join(' ')).replace(/\s+/g, ' ').trim().toLowerCase();
          if (HYPE.has(badgeLabel)) hypeBadges.push({node});
        }
        // Fake terminal: prompt lines and status codes outside code samples
        // (pre/code elements are outside this scan entirely).
        if (/^(?:>\s*(?:initializing|initialising|connected|connecting|system ready|loading|deploying)|[$›]\s*(?:npm|yarn|pnpm|bun|git|docker)\s+\S+|SYS_\d{3}|\[STATUS:\s*ACTIVE\])/i.test(copy))
          terminals.push({node});
        if (rect.width <= 300 && rect.height <= 64 && isRounded(style, rect.height) && !hasStateMeaning(node) && !node.matches('button,a,input,[role="button"],[role="switch"],[role="checkbox"]')) {
          // A short status label, actual capsule geometry and repeated dot motion
          // must all agree. Meaningful live regions and state controls are exempt.
          let badgeText = copy, safeLabel = node.childElementCount <= 3;
          for (const child of safeLabel ? node.children : []) {
            if (child.childElementCount || child.matches('input,textarea,select,[contenteditable]')) {safeLabel = false; break;}
            if (!child.matches('[aria-hidden="true"]') && visible(child)) badgeText += ' ' + directText(child);
          }
          if (safeLabel && /^(?:live|active|online|connected|running|streaming|operational|available|ready|enabled|working|tracking|recording|syncing|in progress|real[ -]?time|now live|live now|system (?:online|active|operational)|all systems operational|ai (?:online|active|live)|beta|new|v\d[.\d]* live)$/i.test(badgeText.trim().replace(/\s+/g, ' '))) {
            for (const dot of [node, ...node.children]) {
              let matched = false;
              for (const motion of moving.get(dot) ?? []) {
                const dotStyle = motion.pseudo ? getComputedStyle(dot, motion.pseudo) : styleOf(dot);
                const dotRect = motion.pseudo ? {width: parseFloat(dotStyle.width), height: parseFloat(dotStyle.height)} : rectOf(dot);
                if (dotStyle.display === 'none' || dotStyle.visibility !== 'visible' || !painted(dotStyle.backgroundColor) || (motion.pseudo && ['none','normal'].includes(dotStyle.content))) continue;
                if (dotRect.width >= 2 && dotRect.width <= 16 && dotRect.height >= 2 && dotRect.height <= 16 && dotRect.width / dotRect.height >= .65 && dotRect.width / dotRect.height <= 1.5 && isRounded(dotStyle, Math.min(dotRect.width, dotRect.height))) {
                  animatedPills.add(node);
                  add('animated-status-pill', node, {reason: 'A short status capsule contains a repeatedly animated dot without explicit live/status semantics; confirm the motion conveys a necessary state.', dot: {selector: identify(dot), pseudo: motion.pseudo, widthPx: Math.round(dotRect.width), heightPx: Math.round(dotRect.height), durationMs: motion.durationMs}});
                  matched = true; break;
                }
              }
              if (matched) break;
            }
          }
        }
        // Eyebrow pill: a small capsule kicker directly above a top-level
        // heading (the stock "Introducing X" eyebrow). Real controls exempt.
        if (/^h[12]$/.test(node.localName)) {
          let at = node.previousElementSibling, steps = 0;
          while (at && steps++ < 2) {
            const next = at.previousElementSibling;
            if (visible(at) && !hasStateMeaning(at) && !at.matches('button,a[href],input,[role="button"]')) {
              const erect = rectOf(at), estyle = styleOf(at), etext = text(at);
              if (erect.height > 0 && erect.height <= 64 && erect.width > erect.height && isRounded(estyle, erect.height) && etext && etext.length <= 80) {
                add('eyebrow-pill', at, {reason: 'A pill/badge kicker sits directly above a top-level heading (the stock eyebrow pattern). Remove it; the heading must state the point alone unless the kicker adds a version, date or scope.', heading: identify(node)});
                break;
              }
            }
            at = next;
          }
        }
      }
    }
    node = walker.nextNode();
  }
  const densities = [];
  for (const [region, data] of regions) {
    const area = areaInViewport(rectOf(region));
    const facts = {words: data.words, characters: data.chars, textElements: data.blocks, controls: data.controls, visibleAreaPx: Math.round(area), wordsPer100kPx: area > 0 ? Math.round(data.words / area * 100000) : 0};
    if (data.controls > 0 && densities.length < 6) densities.push({selector: identify(region), ...facts});
    if (data.controls >= 2 && data.words >= 160 && data.chars >= 900 && data.blocks >= 4 && data.words / data.controls >= 40 && facts.wordsPer100kPx >= 50)
      add('dense-interface-copy', region, {reason: 'Substantial visible copy surrounds relatively few controls. Review which text is necessary for the current action; counts alone do not establish irrelevance.', ...facts});
  }
  const frequentFonts = [...fonts.values()].filter(data => data.count >= 2);
  if (frequentFonts.length >= 4) add('many-interface-font-families', frequentFonts[0].node, {reason: 'At least four primary CSS font families each occur on multiple visible controls or headings. Check whether this variation has a consistent purpose.', families: frequentFonts.length, textElements: frequentFonts.reduce((sum, data) => sum + data.count, 0), relatedSelectors: frequentFonts.slice(1, 4).map(data => identify(data.node))});
  if (borders.length >= 2) add('repeated-heavy-left-border', borders[0].node, {reason: 'Several visible panels use a colored left edge (border or pseudo-element rail) as their only prominent accent: a stock generated-UI pattern. Remove the rails unless each encodes a distinct necessary state; group with spacing and headings instead.', panels: borders.length, borderWidthsPx: [...new Set(borders.map(data => data.widthPx))].slice(0, 4), relatedSelectors: borders.slice(1, 4).map(data => identify(data.node))});
  dots = dots.filter(dot => !animatedPills.has(dot.node));
  if (dots.length) add('decorative-dot-marker', dots[0].node, {reason: 'A small colored dot prefixes a short label (a stock generated-UI tell). Remove it unless it encodes a real, changing state; a label reads fine without it.', markers: dots.length, glowing: dots.filter(dot => dot.glow).length, relatedSelectors: dots.slice(1, 4).map(dot => identify(dot.node))});
  if (tiles.length) add('icon-tile', tiles[0].node, {reason: 'An icon sits inside a tinted or bordered rounded tile (a stock generated-UI badge). Show the icon plainly at text size, or drop it when the label already says it.', tiles: tiles.length, sizesPx: [...new Set(tiles.map(tile => tile.sizePx))].slice(0, 4), relatedSelectors: tiles.slice(1, 4).map(tile => identify(tile.node))});
  if (missingAlt.length) add('missing-image-alt', missingAlt[0].node, {reason: 'Visible images without an alt attribute. Give informative images a concise text equivalent and decorative images an empty alt=""; a missing attribute is neither.', images: missingAlt.length, relatedSelectors: missingAlt.slice(1, 4).map(data => identify(data.node))});
  if (unnamed.length) add('unnamed-control', unnamed[0].node, {reason: 'Interactive controls with no accessible name. Add visible text, a label, or an aria-label; placeholder text is not a name.', controls: unnamed.length, relatedSelectors: unnamed.slice(1, 4).map(data => identify(data.node))});
  if (emojiChrome.length) add('emoji-in-chrome', emojiChrome[0].node, {reason: 'Emoji inside a heading, button, link or tab label. Emoji is not an icon system; keep it only when the brand explicitly owns playful chrome.', elements: emojiChrome.length, relatedSelectors: emojiChrome.slice(1, 4).map(data => identify(data.node))});
  const staticBadges = hypeBadges.filter(data => !animatedPills.has(data.node));
  if (staticBadges.length >= 3) add('hype-badge-cluster', staticBadges[0].node, {reason: 'Three or more hype badges (NEW, BETA, AI…) as capsule labels. A badge must represent meaningful state or taxonomy; keep at most the one or two the reader acts on.', badges: staticBadges.length, relatedSelectors: staticBadges.slice(1, 4).map(data => identify(data.node))});
  if (terminals.length) add('fake-terminal-decoration', terminals[0].node, {reason: 'Decorative terminal output outside code samples. Keep terminal chrome only when the terminal itself is meaningful to the product.', blocks: terminals.length, relatedSelectors: terminals.slice(1, 4).map(data => identify(data.node))});
  if (options.detailed) result.measurements = {viewport: {width: innerWidth, height: innerHeight}, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, animationsSampled: Math.min(animations.length, 100), textBearingInterfaceFamilies: fonts.size, repeatedHeavyLeftBorders: borders.length, decorativeDots: dots.length, iconTiles: tiles.length, missingImageAlt: missingAlt.length, unnamedControls: unnamed.length, emojiChrome: emojiChrome.length, hypeBadges: staticBadges.length, terminalDecorations: terminals.length, interfaceCopy: densities};
  return result;
}
