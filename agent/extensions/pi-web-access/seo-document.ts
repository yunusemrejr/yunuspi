import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { seoSignals } from './web-probe.ts';
import { excludedSeoUrl, seoUrl, type SeoPagePolicy } from '../lib/seo-policy.ts';

export type SeoFinding = { code: string; severity: 'error' | 'warning' | 'review'; url: string; message: string };
const text = (value: unknown, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export function validSeoDate(value: string): boolean {
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))?$/.test(value)) return false;
  const date = new Date(value);
  const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Static evidence only. Never execute scripts or fetch schema contexts/images. */
export function inspectSeoDocument(html: string, url: string, options: { status?: number; headers?: Headers; truncated?: boolean; policy?: SeoPagePolicy; now?: number } = {}) {
  const { document } = parseHTML(html);
  const headers = options.headers ?? new Headers();
  const base = seoUrl(document.querySelector('base[href]')?.getAttribute('href') ?? '', url) ?? url;
  const signals = seoSignals(document, url, base, headers, options.truncated === true, options.status ?? 200);
  const findings: SeoFinding[] = [];
  const add = (code: string, severity: SeoFinding['severity'], message: string) => { if (!findings.some(row => row.code === code && row.message === message)) findings.push({ code, severity, url, message }); };
  const intendedIndex = options.policy?.index !== false && !excludedSeoUrl(url);
  for (const message of signals.findings) {
    if (!intendedIndex && /missing|no canonical|no og:image|0 h1|robots directive blocks/.test(String(message))) continue;
    add('page-signal', /conflicting|does not parse|outside head|HTTP [45]\d\d/.test(String(message)) ? 'error' : 'warning', String(message));
  }
  if (options.status === undefined) add('http-status-unknown', 'review', 'HTML source alone does not establish an HTTP status; inspect the actual serving path.');
  if (!intendedIndex && !signals.noindex && options.status === 200) add('excluded-indexable', 'error', 'Excluded page has no observed noindex; private data requires access control, not robots.txt.');
  if (!intendedIndex && !signals.noindex && options.status === undefined) add('excluded-access-unknown', 'review', 'Excluded HTML lacks noindex, but server access and status remain unknown; inspect actual authentication/index policy.');
  if (intendedIndex && signals.noindex) add('public-noindex', 'error', 'Intended public indexable page has an observed noindex directive.');
  const canonical = signals.canonical;
  if (intendedIndex && !canonical) add('canonical-missing', 'error', 'Intended public page has no observed canonical identity.');
  if (intendedIndex && canonical && canonical !== url) add('canonical-identity', 'warning', 'Canonical differs from the served URL; reconcile redirects, sitemap and internal links with the intended identity.');
  if (intendedIndex && canonical && (new URL(canonical).search || new URL(canonical).hash)) add('canonical-query', 'review', 'Canonical contains query/fragment data; establish a stable preferred identity.');
  if (canonical && new URL(canonical).origin !== new URL(url).origin) add('canonical-origin', 'review', 'Cross-origin canonical: confirm deliberate consolidation and rule out injection.');
  const meta = (key: string) => document.querySelector(`meta[property="${key}" i],meta[name="${key}" i]`)?.getAttribute('content') ?? '';
  const ogUrl = seoUrl(meta('og:url'), base);
  if (ogUrl && canonical && ogUrl !== canonical) add('social-identity', 'error', 'og:url and canonical disagree.');
  if (intendedIndex && (!meta('og:title') || !meta('og:description') || !meta('twitter:card'))) add('social-metadata', 'review', 'Check page-specific Open Graph title/description/image and social card type.');
  const language = document.documentElement?.getAttribute('lang');
  if (language) { try { Intl.getCanonicalLocales(language); } catch { add('html-language', 'error', 'html lang is not a valid language tag.'); } }
  if (intendedIndex && !document.querySelector('main,[role="main"]')) add('main-landmark', 'warning', 'No main landmark in initial HTML.');

  const anchors = Array.from(document.querySelectorAll('a[href]')) as any[];
  const links = anchors.slice(0, 400).flatMap(anchor => {
    const target = seoUrl(anchor.getAttribute('href'), base);
    if (!target) return [];
    const label = text(anchor.textContent || anchor.getAttribute('aria-label') || anchor.querySelector('img')?.getAttribute('alt'), 100);
    if (!label || /^(?:click here|here|read more|learn more)$/i.test(label)) add('anchor-text', 'review', 'Navigation anchor lacks standalone descriptive text.');
    if (new URL(target).origin === new URL(url).origin && (excludedSeoUrl(target) || new URL(target).search)) add('crawl-trap-link', 'review', 'Link exposes a private/search/query surface; confirm access and deliberate crawl/index rules.');
    return [{ url: target, text: label }];
  });
  if (document.querySelector('[onclick]') && !anchors.length) add('js-only-navigation', 'warning', 'Click handlers exist without real anchor links; inspect whether public navigation requires JavaScript.');
  const images = Array.from(document.querySelectorAll('img')) as any[];
  if (images.some(image => !image.getAttribute('width') || !image.getAttribute('height'))) add('image-dimensions', 'review', 'Images lack intrinsic width/height; verify CSS aspect ratios and layout shift in the browser.');
  if (images.some(image => !image.hasAttribute('srcset') && !image.parentElement?.matches('picture'))) add('responsive-images', 'review', 'Check responsive sources, file sizes and formats at mobile and desktop widths.');
  if (images.some(image => image.getAttribute('loading') === 'lazy' && image.getAttribute('fetchpriority') === 'high')) add('critical-image-lazy', 'warning', 'A high-priority image is lazy loaded; verify the LCP/hero image loads promptly.');
  if (document.querySelector('video,audio')) add('media-text', 'review', 'Verify captions/transcript and searchable surrounding text, with applicable truthful media schema.');
  for (const input of Array.from(document.querySelectorAll('input,select,textarea')) as any[]) {
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(input.getAttribute('type'))) continue;
    const id = input.getAttribute('id');
    if (!input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby') && !input.closest('label') && !Array.from(document.querySelectorAll('label')).some((label: any) => id && label.getAttribute('for') === id)) { add('form-label', 'warning', 'Form control lacks an observed programmatic label.'); break; }
  }
  if (Array.from(document.querySelectorAll('table')).some((table: any) => !table.querySelector('th'))) add('table-semantics', 'review', 'Table has no header cells; confirm data-table semantics.');
  const schemaNodes: any[] = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json" i]')) as any[]) {
    try {
      const stack = [JSON.parse(script.textContent ?? '')];
      let visited = 0;
      while (stack.length && visited++ < 2000 && schemaNodes.length < 200) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { stack.push(...node.slice(0, 200)); continue; }
        if (node['@type']) schemaNodes.push(node);
        stack.push(...Object.values(node).filter(value => value && typeof value === 'object').slice(0, 100));
      }
      if (stack.length) add('schema-coverage', 'review', 'Structured-data traversal limit reached; inspect full graph.');
    } catch { /* syntax finding belongs to seoSignals */ }
  }
  const types = (node: any): string[] => [node['@type']].flat().filter(value => typeof value === 'string');
  const ids = new Set<string>();
  for (const node of schemaNodes) {
    const nodeTypes = types(node);
    if (node['@id']) {
      const id = text(node['@id'], 2048);
      if (ids.has(id)) add('schema-id-repeated', 'review', 'Repeated entity @id; verify compatible definitions.');
      ids.add(id);
      if (!seoUrl(id, url)) add('schema-id', 'review', 'Entity @id has no resolvable HTTP(S) identity.');
    } else if (nodeTypes.some(type => /^(?:WebSite|WebPage|Organization|Person|Article|BlogPosting)$/.test(type))) add('schema-stable-id', 'review', 'Give important graph entities stable @id values and coherent relationships.');
    if (nodeTypes.some(type => /^(?:WebPage|Article|BlogPosting)$/.test(type)) && node.url && canonical && seoUrl(node.url, base) !== canonical) add('schema-page-identity', 'error', 'Structured-data page URL and canonical disagree.');
    for (const field of ['datePublished', 'dateModified']) if (node[field]) {
      const value = String(node[field]);
      if (!validSeoDate(value) || Date.parse(value) > (options.now ?? Date.now()) + 86400000) add('schema-date', 'error', `${field} is invalid or in the future.`);
    }
    if (node.datePublished && node.dateModified && Date.parse(node.dateModified) < Date.parse(node.datePublished)) add('date-order', 'error', 'dateModified precedes datePublished.');
    if (nodeTypes.some(type => /^(?:Article|BlogPosting)$/.test(type)) && (!node.author || !node.publisher)) add('article-identity', 'review', 'Verify real author/publisher identity and visible publication/modification dates.');
    if (node.aggregateRating || node.review || node.offers || nodeTypes.some(type => /^(?:FAQPage|HowTo|Product|SoftwareApplication|Dataset|VideoObject)$/.test(type))) add('schema-visible-facts', 'review', 'Verify applicable schema and every rating/review/price/FAQ/step/media/data claim against visible genuine content; syntax does not establish eligibility.');
  }
  if (intendedIndex && !schemaNodes.length) add('entity-context', 'review', 'Consider truthful WebSite/WebPage and real entity relationships where useful.');
  const scriptCount = document.querySelectorAll('script').length;
  if (/\beval\s*\(\s*(?:atob|unescape)\s*\(/i.test(html)) add('obfuscated-script', 'review', 'Encoded eval cue in source; inspect origin and purpose before treating it as malicious.');
  if (Array.from(document.querySelectorAll('[hidden] a[href],a[style]')).some((anchor: any) => /casino|payday loan|viagra|pharma/i.test(anchor.textContent ?? '') && (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(anchor.getAttribute('style') ?? '') || anchor.closest('[hidden]')))) add('hidden-spam-cue', 'review', 'Hidden link has spam-like wording; compare with source intent and inspect routes/server rules.');
  for (const el of document.querySelectorAll('script,style,noscript,template,[hidden],input,textarea,select,[contenteditable]')) el.remove();
  const content = text(document.querySelector('main,article')?.textContent ?? document.body?.textContent, 100000);
  if (intendedIndex && scriptCount && content.length < 160) add('javascript-shell', 'warning', 'Little meaningful initial HTML with scripts present; inspect rendered DOM and SSR/prerender suitability.');
  if (intendedIndex && /^(?:404|not found|page not found|access denied)\b/i.test(text(document.title))) add('soft-error-cue', 'review', 'Error-like title in HTML; verify soft-404 behavior and the actual removed-URL status.');
  return { url, status: options.status ?? null, sha256: createHash('sha256').update(html).digest('hex'), canonical, noindex: signals.noindex,
    title: signals.title, description: signals.description, language: language ?? null, h1: signals.h1,
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 60).map((heading: any) => ({ level: Number(heading.localName[1]), text: text(heading.textContent, 90) })),
    openGraph: { ...signals.openGraph, url: ogUrl ?? null }, hreflang: signals.hreflang, jsonLd: signals.jsonLd,
    contentLength: content.length, contentHash: createHash('sha256').update(content).digest('hex'), answerPreview: content.slice(0, 400),
    links, linkCount: anchors.length, schemaTypes: [...new Set(schemaNodes.flatMap(types))].slice(0, 30), findings,
    coverage: { rawHtml: true, complete: !options.truncated, httpStatus: options.status !== undefined, headers: options.headers !== undefined, linksComplete: anchors.length <= 400, renderedDom: false, coreWebVitals: false, schemaFacts: false, indexed: 'unverified' },
    cache: { control: headers.get('cache-control'), etag: headers.get('etag'), encoding: headers.get('content-encoding'), vary: headers.get('vary') } };
}
