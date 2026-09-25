import type { CodeSignal } from './code-guidance-signals.ts';
import { createHash } from 'node:crypto';

const UI_FILE = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|php)$/i;
const EXCLUDED = /(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|__fixtures__|skills|references)\/|\.(?:min|generated|test|spec)\.|(?:^|\/)SKILL\.md$/i;
const luminance = (hex: string) => {
  const full = hex.length === 3 ? [...hex].map(c=>c+c).join('') : hex;
  const rgb = [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
};

/** Explicit tool check shares the edit-hook policy; absence of cues is not a pass. */
export function inspectUiSource(file: string, text: string) {
  const normalized = file.replaceAll('\\','/');
  if (typeof text !== 'string' || text.length > 24000) throw Error('UI source check requires at most 24000 characters; inspect a complete smaller component');
  const supported = UI_FILE.test(normalized) && !EXCLUDED.test(normalized);
  return { sourceHash:createHash('sha256').update(text).digest('hex'), status:supported?'inspected':'unsupported',
    findings:supported?slopGuidanceSignals(normalized,text,12):[],
    scope:'Bounded source cues only; no CSS cascade, rendering, interaction execution or visual certification. No findings does not mean good design.',
    next:'Inspect the complete component in its project design system, then verify rendered appearance and relevant interaction states.' };
}

/** Advisory checks of small authored changes. Never infer authorship or rewrite automatically. */
export function slopGuidanceSignals(file: string, value: unknown, limit = 3): CodeSignal[] {
  if (typeof value !== 'string' || value.length > 24000) return [];
  file = file.replaceAll('\\', '/');
  if (EXCLUDED.test(file)) return [];
  const ui = UI_FILE.test(file);
  // DOM-generating scripts (vanilla JS/TS builders, template literals) carry
  // markup structure but not authorial stylesheets: markup-shape cues apply,
  // CSS-property cues do not.
  const script = /\.[cm]?[jt]s$/i.test(file);
  const prose = /\.(?:md|mdx|txt|html?|jsx|tsx|vue|svelte|php)$/i.test(file);
  if (!ui && !prose && !script) return [];
  // Examples and comments are not authored product presentation.
  const text = value.replace(/```[\s\S]*?```|<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g,'').replace(/^\s*>.*$/gm,'').replace(/^\s*\/\/.*$/gm,'');
  const out: CodeSignal[] = [];
  if (ui || script) {
    const add = (key: string, check: string) => out.push({key, skill:'ui-antipattern-review', check});
    // Require a short markup region containing the label, enclosure and motion.
    // aria-live, a stock ticker, or a plain status label alone is not this pattern.
    for (const match of text.matchAll(/<(?:span|div|p)\b[^>]{0,500}>[\s\S]{0,900}?>\s*(?:live|online|real[ -]time)\s*<\//gi)) {
      const region = match[0];
      if (/\b(?:rounded-full|(?:status-)?pill|badge)\b/i.test(region)
          && /\b(?:animate-(?:ping|pulse)|blink\w*|puls(?:e|ing)[-_ ]?dot)\b/i.test(region)) {
        add('ui-live-pill', 'A live/status label, pill enclosure and blinking/pulsing treatment occur together. Remove this decorative status badge by default; prefer quiet, specific status text tied to observed state. If live activity is required, verify connected, stale, offline and reduced-motion states. A source cue cannot prove the status is fake.');
        break;
      }
    }
    if (/<(?:div|span)\b[^>]{0,800}\b(?:onClick|onclick|@click)\s*=/i.test(text))
      add('ui-clickable-container', 'A div/span has a click handler. Check its complete semantics and keyboard behavior; prefer a native button for actions or a real link for navigation. Verify accessible name, focus and Enter/Space behavior before delivery.');
    if (/<a\b[^>]{0,800}\bhref\s*=\s*["'](?:#|javascript:void\(0\))["']/i.test(text))
      add('ui-placeholder-navigation', 'A link has a placeholder destination. Connect navigation to the actual destination, or use a button for an action. Exercise the intended interaction; a convincing visual state is not working behavior.');
    // Stylesheet cues need an authorial stylesheet; a script embedding a few
    // declarations (inline styles, CSSOM) cannot establish these patterns.
    if (!ui) return out.slice(0,Math.min(12,Math.max(1,Number.isInteger(limit)?limit:3)));
    if (/\boutline\s*:\s*(?:none|0)\s*[;}]/i.test(text) || /\b(?:outline-none|focus:outline-none)\b/.test(text))
      add('ui-focus-suppression', 'Focus outline suppression was observed. Verify a visible replacement on the rendered control for keyboard users, including forced colors; another stylesheet or utility may supply it.');
    const families = new Set([...text.matchAll(/\bfont-family\s*:\s*([^;}\n]+)/gi)]
      .map(m=>m[1].split(',')[0].trim().replace(/["']/g,'').toLowerCase())
      .filter(f=>f && !/^(?:var\(|inherit$|initial$|unset$|monospace$|ui-monospace$)/.test(f)));
    if (families.size >= 3)
      add('ui-font-competition', 'At least three primary font families occur in this source. Assign a purpose to each; simplify competing display faces and near-identical sans pairings. Keep needed script fallbacks and code fonts. Inspect loaded fonts, long labels, zoom and weight hierarchy; names alone cannot establish a bad pairing.');
    if (/\bfont-size\s*:\s*(?:[1-9]|1[01])px\b/i.test(text) && /\b(?:text-transform\s*:\s*uppercase|letter-spacing\s*:)/i.test(text))
      add('ui-small-tracked-copy', 'Tiny pixel text occurs with uppercase or tracking. Inspect whether labels remain readable at real density, narrow widths and zoom; avoid using tiny uppercase metadata as the default hierarchy.');
    if ((text.match(/\bposition\s*:\s*absolute\b/gi)||[]).length >= 3)
      add('ui-fragile-placement', 'Multiple absolutely positioned elements occur together. Check whether meaningful content depends on fixed coordinates; verify long text, zoom, narrow widths and overlap. Icons and deliberate overlays may legitimately use absolute positioning.');
    // Only explicit opaque hex pairs within one declaration block; never combine
    // values from different selectors or pretend to resolve variables/layers.
    for (const block of text.matchAll(/\{([^{}]{1,1800})\}/g)) {
      const color = /(?:^|;)\s*color\s*:\s*#([\da-f]{6}|[\da-f]{3})\s*(?:;|$)/i.exec(block[1]);
      const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*#([\da-f]{6}|[\da-f]{3})\s*(?:;|$)/i.exec(block[1]);
      if (!color || !bg || /\b(?:opacity|background-image)\s*:|\b(?:color|background(?:-color)?)\s*:[^;]*\b(?:var|rgb|hsl)\(/i.test(block[1])) continue;
      const a=luminance(color[1]), b=luminance(bg[1]), ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      if (ratio < 3) { add('ui-low-contrast-pair', `An explicit text/background pair has ${ratio.toFixed(2)}:1 contrast before cascade and compositing. Measure the actual rendered colors and text size; this is below even the 3:1 large-text threshold if applied to ordinary visible text. Verify exceptions and overrides before calling it a violation.`); break; }
    }
    const decorations = [/(?:linear|radial|conic)-gradient\s*\(/i, /backdrop-filter\s*:[^;}\n]{0,120}blur\s*\(/i,
      /(?:box|text)-shadow\s*:/i, /animation(?:-iteration-count)?\s*:[^;}\n]{0,240}\binfinite\b/i];
    if (decorations.filter(re=>re.test(text)).length >= 3)
      out.push({key:'ui-decoration-cluster',skill:'ui-antipattern-review',check:'Several decorative CSS treatments occur together. Inspect the rendered hierarchy against the existing design system and real content; retain effects with a clear purpose and simplify competing emphasis. A branded treatment alone is not a defect.'});
    if ((text.match(/animation(?:-iteration-count)?\s*:[^;}\n]{0,240}\binfinite\b/gi)||[]).length >= 2)
      out.push({key:'ui-continuous-motion',skill:'ui-antipattern-review',check:'Multiple continuous animations were observed. Check attention, interruption and reduced-motion behavior in the complete component; this partial change cannot establish whether safeguards are missing.'});
  }
  if (prose) {
    const stock = [/\bin today.s (?:fast.paced|rapidly evolving|digital)\b/i,/\bunlock (?:the |your )?(?:full |true )?potential\b/i,/\bseamless(?:ly)?\b/i,/\brevolutionary\b/i,/\bcutting.edge\b/i,/\ball.in.one (?:solution|platform)\b/i];
    if (stock.filter(re=>re.test(text)).length >= 3)
      out.push({key:'prose-stock-cluster',skill:'natural-editorial-writing',check:'Several stock promotional phrases occur together. Replace unsupported generalities with specific behavior and reader value, preserving the requested voice and required wording. This is not evidence of AI authorship.'});
    if (/\blorem ipsum\b/i.test(text))
      out.push({key:'placeholder-copy',skill:'anti-ai-slop',check:'Placeholder copy was observed. Before delivery, confirm whether a mockup was requested; otherwise use supplied content or clearly disclose missing facts. Never invent testimonials, customers or performance numbers to fill space.'});
  }
  return out.slice(0,Math.min(12,Math.max(1,Number.isInteger(limit)?limit:3)));
}
