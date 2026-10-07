/** Public-site intent and page policy, shared by tools and proactive hooks.
 * Routing uses user instructions and observed filenames, never page prose. */
export const SEO_SURFACE = /(?:^|\/)(?:robots\.txt|sitemap[^/]*\.xml|llms(?:-full)?\.txt|(?:pages|app|routes|content|posts|docs|public|www|templates|views|layouts)\/.*\.(?:html?|mdx?|astro|vue|svelte|tsx|jsx|php|phtml|twig)|(?:index|layout|page)\.(?:html?|php|astro|tsx|jsx))$/i;
const PRIVATE_TASK = /\b(?:private|internal|intranet|employee|staff[- ]only|admin|authenticated|local[- ]only)\s+(?:[\w-]+\s+){0,2}(?:app(?:lication)?|website|site|portal|dashboard|software|tool)\b|\b(?:localhost|not public|no public pages)\b/i;
const PUBLIC_TASK = /\b(?:public (?:website|site|pages?|web app)|marketing (?:website|site|pages?)|landing pages?|home ?page|documentation site|blog|portfolio|e-?commerce|storefront|product pages?|service pages?|knowledge base)\b/i;
const SEO_EXCLUDED = /\b(?:no|without|skip)\s+(?:SEO|search optimi[sz]ation)\b|\b(?:do not|don't|never)\s+(?:do|add|run|change|optimi[sz]e)\s+(?:the\s+)?(?:SEO|search optimi[sz]ation)\b/i;
export function seoTaskIntent(prompt: string, files: readonly string[] = []) {
  const text = String(prompt ?? '').slice(0, 24000);
  const explicit = /\b(?:seo|search engine optimi[sz]ation|structured data|core web vitals|crawlability|indexability|sitemap|robots\.txt|llms\.txt|json-ld|hreflang|canonical (?:urls?|tags?|links?))\b/i.test(text);
  const publicCue = PUBLIC_TASK.test(text);
  const privateOnly = PRIVATE_TASK.test(text) && !publicCue;
  const siteWork = /\b(?:website|web site|web pages?|static site)\b/i.test(text);
  const surface = files.slice(-64).some(file => SEO_SURFACE.test(String(file).replaceAll('\\', '/')));
  const excluded = SEO_EXCLUDED.test(text);
  const commentOnly = !explicit && /\bcomments?\b[^.\n]{0,40}\b(?:typo|spelling|wording)\b|\b(?:typo|spelling)\b[^.\n]{0,40}\bcomments?\b|\b(?:whitespace|indentation)[- ]only\b/i.test(text);
  const authOnly = !explicit && !publicCue && /\b(?:login|sign[- ]?in|password|authentication|auth)\b/i.test(text) && /\b(?:validation|handlers?|sessions?|tokens?|credentials|csrf|security)\b/i.test(text);
  return { relevant: !excluded && !privateOnly && !commentOnly && !authOnly && (explicit || publicCue || siteWork || surface),
    scope: privateOnly ? 'private' : publicCue || siteWork ? 'public' : 'unknown',
    reason: excluded ? 'user excluded SEO' : privateOnly ? 'private application: preserve access and index exclusion' : commentOnly ? 'comment-only change does not affect public discovery' : explicit ? 'explicit discovery work' : publicCue || siteWork ? 'website/content work includes discoverability' : surface ? 'observed page or discovery source; establish public scope first' : 'no site evidence' };
}

export const SEO_CONTRACT = [
  { area: 'scope-and-purpose', checks: 'Public/private route inventory, audience, one deliberate query intent per useful page; exclude private/admin/staging/search/filter/duplicates; protect private data with authentication.', evidence: 'inspection' },
  { area: 'crawl-and-identity', checks: '200 real pages, 301/308 moved URLs, actual 404/410 removals; no soft 404, loops/chains/homepage mass redirects; consistent HTTPS/host/slash/case/query policy and self canonicals; robots and X-Robots-Tag agree.', evidence: 'audit' },
  { area: 'discovery-and-graph', checks: 'Canonical indexable sitemap URLs, truthful lastmod, sitemap index beyond protocol limits; no broken/orphan/deep pages or query/calendar/facet traps; real descriptive anchor links and coherent topic graph/breadcrumbs.', evidence: 'audit' },
  { area: 'page-semantics', checks: 'Useful unique title/description, clear primary H1 and heading hierarchy, html lang, main/article/nav/time/figure/list/table semantics; stable descriptive URLs and page-specific Open Graph/social previews.', evidence: 'audit-and-render' },
  { area: 'intent-and-information', checks: 'Direct definitions/answers near top, self-contained factual passages, explicit entities/units/dates/sources, original examples, steps/comparisons/reference/troubleshooting where useful; no filler or keyword stuffing.', evidence: 'editorial-review' },
  { area: 'content-architecture', checks: 'Create relevant evergreen question/FAQ/guides/glossary/how-to/comparison/use-case/docs/integration/reference/pillar pages when real demand and distinct evidence support them; consolidate cannibalization, thin archives and duplicate intents; no doorway or mass-generated pages.', evidence: 'research-and-review' },
  { area: 'entities-and-trust', checks: 'Schema.org JSON-LD syntax, genuine applicable types, stable entity @id and coherent author/publisher/about/isPartOf/mainEntity; match visible facts; real identity/About/contact/authorship/official links/primary citations; no invented ratings, prices, credentials or claims.', evidence: 'audit-and-factual-review' },
  { area: 'machine-readable', checks: 'Concise llms.txt canonical public pointers; llms-full only for substantial docs; useful RSS/Atom and documentation/data endpoints from the same source; never export private URLs; these files do not prove ranking or AI visibility.', evidence: 'audit-and-source-parity' },
  { area: 'original-value', checks: 'Relevant calculators/converters/tools/datasets/benchmarks/diagrams/downloads/code examples/measurements/decision trees; informational pages link to tools and tools to explanations; create only with real domain value.', evidence: 'domain-review-and-execution' },
  { area: 'media-and-accessibility', checks: 'Accurate alt and empty decorative alt, dimensions, responsive modern images, appropriate lazy loading with eager critical hero; captions and media transcripts, real keyboard navigation/form labels/table semantics, readable mobile layout; no cloaking.', evidence: 'audit-and-browser' },
  { area: 'performance', checks: 'Measure LCP/CLS/INP on real mobile/field workload; optimize JS/assets/fonts/compression/cache/server response/render blocking and redirects; raw HTML timing is not Core Web Vitals.', evidence: 'measurement' },
  { area: 'locales-and-freshness', checks: 'Genuine language variants, valid reciprocal hreflang and per-language canonicals, justified x-default; actual publication and substantive modification dates; no daily/build/deployment timestamp refreshing.', evidence: 'audit-and-source-history' },
  { area: 'security', checks: 'Inspect unexpected URLs, hidden spam/backlinks, rogue canonicals/redirects/schema and scripts, compromised htaccess/nginx/middleware/routes; confirm source intent before removing suspect content; clean hacked URLs with proper status.', evidence: 'audit-and-security-review' },
  { area: 'delivery', checks: 'Re-audit raw production HTML/status/robots/canonicals/XML/JSON-LD/internal links/redirects/cache after deployment, inspect JS-rendered DOM and mobile interaction; distinguish submitted, crawled and indexed, and report bounded/unknown evidence honestly.', evidence: 'live-and-rendered' },
] as const;

export type SeoPagePolicy = { url: string; purpose?: string; intent?: string; title?: string; description?: string; canonical?: string; index?: boolean; lastmod?: string; published?: string; links?: string[]; locale?: string };
/** Reviewed route purpose takes precedence over a public-looking URL. */
export function excludedSeoPage(page?: Pick<SeoPagePolicy, 'index' | 'purpose'>): boolean {
  return page?.index === false || /\b(?:private|internal|intranet|authenticated|auth[- ]only|admin|staff[- ]only|employee[- ]only|members[- ]only|local[- ]only|staging|search|filter|duplicate|thin|noindex|non[- ]public)\b/i.test(page?.purpose ?? '');
}
/** A path cue is a conservative crawl exclusion, never proof of access control. */
export function excludedSeoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return /(?:^|\/)(?:admin|wp-admin|wp-login|account|login|logout|signin|signup|auth|private|internal|dashboard|search|cart|checkout|staging|dev|test)(?:\.(?:php|html?))?(?:\/|$)/i.test(pathname)
      || /^(?:staging|dev|test|preview|internal)\./i.test(url.hostname)
      || [...url.searchParams.keys()].some(key => /^(?:q|s|search|filter|sort|order|page|offset|calendar|date|session|token|key|password|auth)$/i.test(key));
  } catch { return true; }
}
export function seoUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}
export function publicSeoPages(pages: readonly SeoPagePolicy[], origin: string) {
  if (!Array.isArray(pages) || pages.length > 500) throw new Error('Provide at most 500 reviewed page records per batch.');
  const accepted: SeoPagePolicy[] = [], excluded: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const page of pages.slice(0, 500)) {
    const url = seoUrl(page.url, origin), canonical = page.canonical ? seoUrl(page.canonical, origin) : url;
    const reason = !url ? 'invalid URL' : new URL(url).origin !== new URL(origin).origin ? 'outside canonical origin'
      : excludedSeoPage(page) ? 'excluded page purpose'
      : excludedSeoUrl(url) ? 'private or crawl-trap URL cue' : new URL(url).search ? 'query URL needs explicit canonical policy'
      : canonical !== url ? 'alternate canonical' : seen.has(url) ? 'duplicate URL' : '';
    if (reason) { excluded.push({ url: url ?? String(page.url).slice(0, 200), reason }); continue; }
    seen.add(url!); accepted.push({ ...page, url: url!, canonical: url! });
  }
  return { accepted, excluded };
}
