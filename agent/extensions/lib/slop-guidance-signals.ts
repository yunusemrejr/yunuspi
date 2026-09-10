import type { CodeSignal } from './code-guidance-signals.ts';

/** Advisory checks of small authored changes. Never infer authorship or rewrite automatically. */
export function slopGuidanceSignals(file: string, value: unknown): CodeSignal[] {
  if (typeof value !== 'string' || value.length > 24000) return [];
  if (/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|__fixtures__|skills|references)\/|\.(?:min|generated|test|spec)\.|(?:^|\/)SKILL\.md$/i.test(file)) return [];
  const ui = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|php)$/i.test(file);
  const prose = /\.(?:md|mdx|txt|html?|jsx|tsx|vue|svelte|php)$/i.test(file);
  if (!ui && !prose) return [];
  // Examples and comments are not authored product presentation.
  const text = value.replace(/```[\s\S]*?```|<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g,'').replace(/^\s*>.*$/gm,'');
  const out: CodeSignal[] = [];
  if (ui) {
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
  return out.slice(0,3);
}
