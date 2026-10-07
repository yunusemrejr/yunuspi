/** Bounded, unauthenticated site evidence. Transport stays under the existing
 * DNS/redirect/domain-policy owner; no browser, cookies or submissions. */
import { Parser } from 'htmlparser2';
import { parseHTML } from 'linkedom';
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, type Lookup } from './ssrf-protection.ts';
import { readCapped, robotsVerdict } from './web-probe.ts';
import { inspectSeoDocument, validSeoDate, type SeoFinding } from './seo-document.ts';
import { excludedSeoUrl, publicSeoPages, seoUrl, type SeoPagePolicy } from '../lib/seo-policy.ts';

export function parseSeoSitemap(xml: string) {
  const entries: Array<{ url: string; lastmod?: string }> = [], errors: string[] = [];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { kind: 'invalid', entries, errors: ['DTD/entities are unsupported; no external resources are fetched.'], truncated: false };
  const stack: string[] = [];
  let root = '', roots = 0, entry: { url: string; lastmod?: string } | undefined, value = '', namespace = '', prefix = '';
  const local = (name: string) => prefix && name.startsWith(prefix + ':') ? name.slice(prefix.length + 1) : name;
  const fail = (message: string) => { if (!errors.includes(message) && errors.length < 10) errors.push(message); };
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(markup) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(markup)) fail('Invalid XML entity or control character.');
  let attributes = new Set<string>();
  const parser = new Parser({
    onopentagname() { attributes = new Set(); },
    onattribute(name, _value, quote) { if (attributes.has(name) || quote !== '"' && quote !== "'") fail('Duplicate or unquoted XML attribute.'); attributes.add(name); },
    onopentag(name, attrs) {
      if (!stack.length) { prefix = name.includes(':') ? name.split(':')[0] : ''; root = local(name); namespace = attrs[prefix ? 'xmlns:' + prefix : 'xmlns'] ?? ''; roots++; }
      stack.push(name);
      if (stack.length === 2 && (root === 'urlset' && local(name) === 'url' || root === 'sitemapindex' && local(name) === 'sitemap')) entry = { url: '' };
      if (entry && stack.length === 3 && ['loc', 'lastmod'].includes(local(name))) value = '';
    },
    ontext(data) {
      if (!stack.length && data.trim()) fail('Text outside XML root.');
      if (entry && stack.length === 3 && ['loc', 'lastmod'].includes(local(stack.at(-1)!))) value += data;
    },
    onclosetag(name, implied) {
      if (implied || stack.at(-1) !== name) fail('Mismatched or unclosed XML tags.');
      if (entry && stack.length === 3 && local(name) === 'loc') { if (entry.url) fail('Duplicate loc in sitemap entry.'); entry.url = value.trim(); }
      if (entry && stack.length === 3 && local(name) === 'lastmod') entry.lastmod = value.trim();
      if (entry && stack.length === 2 && ['url', 'sitemap'].includes(local(name))) { if (!entry.url) fail('Sitemap entry has no loc.'); if (entries.length < 2000) entries.push(entry); entry = undefined; }
      stack.pop();
    },
    onerror() { fail('Malformed XML.'); },
  }, { xmlMode: true, decodeEntities: true });
  parser.end(xml);
  if (roots !== 1 || !['urlset', 'sitemapindex'].includes(root)) fail('Expected one urlset or sitemapindex root.');
  if (namespace !== 'http://www.sitemaps.org/schemas/sitemap/0.9') fail('Missing or incorrect sitemap protocol namespace.');
  return { kind: errors.length ? 'invalid' : root, entries, errors, truncated: entries.length >= 2000 };
}

/** Read feed entries only; RSS/Atom descriptions are never instructions. */
export function parseSeoFeed(xml: string) {
  const entries: Array<{ url: string; published?: string }> = [], stack: string[] = [], errors: string[] = [];
  let root = '', roots = 0, entry: { url: string; published?: string } | undefined, value = '';
  if (/<!DOCTYPE|<!ENTITY|<html|<!doctype html/i.test(xml)) return { entries, errors: ['Feed has HTML or unsupported DTD/entities.'] };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (!stack.length) { root = name; roots++; if (name === 'feed' && attrs.xmlns !== 'http://www.w3.org/2005/Atom') errors.push('Atom namespace missing or incorrect.'); }
      stack.push(name);
      if (name === 'item' && root === 'rss' || name === 'entry' && root === 'feed') entry = { url: '' };
      if (entry && ['link', 'pubDate', 'published'].includes(name)) { value = ''; if (name === 'link' && attrs.href && (!attrs.rel || attrs.rel === 'alternate')) entry.url = attrs.href; }
    },
    ontext(data) { if (entry && ['link', 'pubDate', 'published'].includes(stack.at(-1)!)) value += data; },
    onclosetag(name, implied) {
      if (implied || stack.at(-1) !== name) { if (!errors.length) errors.push('Malformed feed XML.'); }
      if (entry && name === 'link' && root === 'rss') entry.url = value.trim();
      if (entry && ['pubDate', 'published'].includes(name)) entry.published = value.trim();
      if (entry && ['item', 'entry'].includes(name)) { if (entries.length < 500) entries.push(entry); entry = undefined; }
      stack.pop();
    },
  }, { xmlMode: true, decodeEntities: true });
  parser.end(xml);
  if (roots !== 1 || !['rss', 'feed'].includes(root)) errors.push('Expected one RSS or Atom root.');
  return { entries, errors: errors.slice(0, 10) };
}

export type SeoAuditOptions = { url: string; canonicalOrigin?: string; pages?: SeoPagePolicy[]; maxPages?: number; signal?: AbortSignal; lookup?: Lookup; allowLoopback?: boolean; fetcher?: typeof fetch };
export async function auditSeoSite(options: SeoAuditOptions) {
  const target = seoUrl(options.url);
  if (!target || excludedSeoUrl(target)) throw new Error('Use a public HTTP(S) entry URL without credentials, private paths or crawl-trap parameters.');
  const maxPages = options.maxPages ?? 12;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error('maxPages must be 1 through 40.');
  const expectedOrigin = options.canonicalOrigin ? seoUrl(options.canonicalOrigin) : undefined;
  if (options.canonicalOrigin && !expectedOrigin) throw new Error('canonicalOrigin must be an HTTP(S) URL.');
  const initialPolicy = publicSeoPages(options.pages ?? [], new URL(expectedOrigin ?? target).origin);
  const excludedUrls = new Set(initialPolicy.excluded.map(page => page.url));
  if (excludedUrls.has(target)) throw new Error('The reviewed inventory excludes the audit entry; use a canonical public entry instead.');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const findings: SeoFinding[] = [], failures: Array<{ url: string; error: string }> = [];
  const add = (code: string, severity: SeoFinding['severity'], url: string, message: string) => { if (findings.length < 600) findings.push({ code, severity, url, message }); };
  let requests = 0, bytes = 0;
  const fetcher = options.fetcher ?? fetch;
  const ssrf = loadSsrfConfig(), domainPolicy = loadFetchContentDomainPolicy();
  let origin: string | undefined = expectedOrigin ? new URL(expectedOrigin).origin : undefined;
  const allowedOrigins = new Set([new URL(target).origin, ...(origin ? [origin] : [])]);
  const get = async (url: string, cap = 1024 * 1024, initial = false) => {
    signal.throwIfAborted();
    const hops: Array<{ from: string; to: string; status: number }> = [];
    const started = performance.now();
    const response = await fetchRemoteUrl(url, { signal }, { ...ssrf, domainPolicy, lookup: options.lookup, allowLoopback: options.allowLoopback === true,
      fetch: async (input, init) => { if (++requests > 100) throw new Error('Site request budget exhausted.'); return fetcher(input, init); },
      onRedirect: ({ from, to, response, init }) => {
        if (excludedSeoUrl(to.href) || excludedUrls.has(to.href) || publicSeoPages(options.pages ?? [], to.origin).excluded.some(page => page.url === to.href)) throw new Error('Redirect enters an excluded private/staging/search surface.');
        // First entry may establish HTTPS/www normalization on the same host.
        const normalHost = (host: string) => host.replace(/^www\./i, '');
        if (!allowedOrigins.has(to.origin) && !(initial && !origin && normalHost(to.hostname) === normalHost(new URL(target).hostname))) throw new Error('Redirect leaves the selected site origin.');
        if (hops.some(hop => hop.from === to.href) || to.href === url) throw new Error('Redirect loop observed.');
        hops.push({ from: from.href, to: to.href, status: response.status });
        return init;
      } });
    const { text, bytes: readBytes, truncated } = await readCapped(response, cap);
    bytes += readBytes;
    const finalUrl = hops.at(-1)?.to ?? response.url ?? url;
    return { url, finalUrl: finalUrl || url, status: response.status, headers: response.headers, text, truncated, hops, elapsedMs: Math.round(performance.now() - started) };
  };
  const attempt = async (url: string, cap?: number, initial = false) => {
    try { return await get(url, cap, initial); }
    catch (error) { if (options.signal?.aborted) throw error; failures.push({ url, error: String(error instanceof Error ? error.message : error).slice(0, 240) }); return undefined; }
  };
  const first = await attempt(target, undefined, true);
  if (!first) return { pages: [], findings, failures, coverage: { requests, complete: false, indexed: 'unverified' }, next: 'Resolve entry transport/access failure before claiming an audit.' };
  origin ??= new URL(first.finalUrl).origin;
  allowedOrigins.add(origin);
  if (new URL(first.finalUrl).origin !== origin) add('origin-mismatch', 'error', first.finalUrl, 'Entry does not resolve to the declared canonical origin.');
  if (origin.startsWith('http://') && !options.allowLoopback) add('https-policy', 'review', origin, 'Canonical site uses HTTP; establish HTTPS and host normalization.');
  const policy = publicSeoPages(options.pages ?? [], origin);
  for (const page of policy.excluded) excludedUrls.add(page.url);
  for (const page of policy.excluded) add('page-policy-exclusion', 'review', page.url, page.reason);
  const knownPolicy = new Map(policy.accepted.map(page => [page.url, page]));
  const robots = await attempt(origin + '/robots.txt', 256 * 1024);
  const robotsKnown = !!robots && !robots.truncated && (robots.status === 200 && !/<html|<!doctype html/i.test(robots.text) || robots.status >= 400 && robots.status < 500 && robots.status !== 429);
  const verdict = (url: string) => robotsKnown ? robotsVerdict(robots!.status === 200 ? robots!.text : '', new URL(url).pathname + new URL(url).search) : undefined;
  if (!robotsKnown) add('robots-unknown', 'review', origin + '/robots.txt', 'Robots unavailable, rate-limited or truncated; crawl permission remains unknown.');
  if (robots?.status === 200 && /<html|<!doctype html/i.test(robots.text)) add('robots-html', 'error', origin + '/robots.txt', 'robots.txt serves HTML; verify routing instead of treating a fallback page as crawl rules.');
  const sitemapQueue = [...new Set([...(robotsKnown ? robotsVerdict(robots!.text, '/').sitemaps : []), origin + '/sitemap.xml'])];
  const sitemapEntries = new Map<string, { lastmod?: string }>();
  const sitemaps: Array<{ url: string; status: number; kind: string; entries: number; complete: boolean }> = [];
  const visitedMaps = new Set<string>();
  while (sitemapQueue.length && visitedMaps.size < 5 && !signal.aborted) {
    const raw = sitemapQueue.shift()!, url = seoUrl(raw);
    if (!url || new URL(url).origin !== origin || excludedSeoUrl(url) || excludedUrls.has(url)) { add('sitemap-origin', 'error', origin, 'Sitemap pointer is invalid, private or outside the canonical origin.'); continue; }
    if (visitedMaps.has(url)) continue;
    visitedMaps.add(url);
    const response = await attempt(url);
    if (!response) continue;
    if (response.status !== 200) { add('sitemap-status', response.status === 404 ? 'review' : 'error', url, `Sitemap returns HTTP ${response.status}.`); continue; }
    const parsed = parseSeoSitemap(response.text);
    const complete = !response.truncated && !parsed.truncated && !parsed.errors.length;
    sitemaps.push({ url, status: response.status, kind: parsed.kind, entries: parsed.entries.length, complete });
    for (const error of parsed.errors) add('sitemap-xml', 'error', url, error);
    if (!complete) add('sitemap-coverage', 'review', url, 'Sitemap is invalid or exceeds the bounded XML sample; full coverage remains unknown.');
    for (const entry of parsed.entries) {
      const normalized = seoUrl(entry.url);
      if (!normalized || normalized !== entry.url || new URL(normalized).origin !== origin || excludedSeoUrl(normalized) || excludedUrls.has(normalized) || new URL(normalized).search) { add('sitemap-url-policy', 'error', url, 'Sitemap contains a noncanonical, private, query, alternate-host or invalid URL.'); continue; }
      if (entry.lastmod && (!validSeoDate(entry.lastmod) || Date.parse(entry.lastmod) > Date.now() + 86400000)) add('sitemap-lastmod', 'error', normalized, 'lastmod is invalid or in the future.');
      if (parsed.kind === 'sitemapindex') { sitemapQueue.push(normalized); continue; }
      if (parsed.kind === 'invalid') continue;
      if (sitemapEntries.has(normalized)) add('sitemap-duplicate', 'warning', normalized, 'URL is repeated across sitemap entries.');
      if (sitemapEntries.size < 2000) sitemapEntries.set(normalized, { lastmod: entry.lastmod });
      if (knownPolicy.get(normalized)?.lastmod && entry.lastmod !== knownPolicy.get(normalized)!.lastmod) add('lastmod-source-parity', 'error', normalized, 'Sitemap lastmod disagrees with the supplied substantive-change date.');
    }
  }
  const pages: ReturnType<typeof inspectSeoDocument>[] = [];
  const pending = [first.finalUrl, ...policy.accepted.map(page => page.url), ...sitemapEntries.keys()];
  const visited = new Set<string>();
  const redirects: Array<{ from: string; to: string; status: number }> = [];
  while (pending.length && pages.length < maxPages && visited.size < maxPages * 2 && !signal.aborted) {
    const url = pending.shift()!;
    if (visited.has(url) || new URL(url).origin !== origin || excludedUrls.has(url) || excludedSeoUrl(url) || new URL(url).search) continue;
    visited.add(url);
    const allowed = verdict(url);
    if (allowed?.allowed === false) { add('robots-block', sitemapEntries.has(url) || knownPolicy.has(url) ? 'error' : 'review', url, `Crawl blocked by ${allowed.rule}; not followed for crawl. Blocking can prevent crawlers from seeing noindex.`); continue; }
    if (!robotsKnown && url !== first.finalUrl) continue;
    const response = url === first.finalUrl ? first : await attempt(url);
    if (!response) continue;
    redirects.push(...response.hops);
    if (response.hops.length > 1) add('redirect-chain', 'warning', url, `${response.hops.length} redirect hops; link directly to the final identity.`);
    if (response.hops.some(hop => [302, 303, 307].includes(hop.status))) add('temporary-redirect', 'review', url, 'Temporary redirect observed; use a permanent redirect for a permanent move.');
    if (new URL(url).pathname !== '/' && new URL(response.finalUrl).pathname === '/' && response.hops.length) add('homepage-redirect', 'review', url, 'A non-home URL redirects to the homepage; verify a relevant replacement rather than mass redirection.');
    const type = response.headers.get('content-type') ?? '';
    if (!/html|xhtml/i.test(type)) { add('non-html-page', response.status >= 400 ? 'error' : 'review', url, `HTTP ${response.status}, ${type || 'no content type'}; HTML page checks not performed.`); continue; }
    const page = inspectSeoDocument(response.text, response.finalUrl, { status: response.status, headers: response.headers, truncated: response.truncated, policy: knownPolicy.get(url) });
    pages.push(page); findings.push(...page.findings.slice(0, Math.max(0, 600 - findings.length)));
    if (sitemapEntries.has(url) && (page.status !== 200 || page.noindex || page.canonical !== url || response.hops.length)) add('sitemap-indexability', 'error', url, 'Listed sitemap URL is not an observed 200 self-canonical page without noindex/redirect.');
    if (page.noindex) add('public-noindex', knownPolicy.has(url) || url === first.finalUrl ? 'error' : 'review', url, 'Public page has noindex; reconcile with intended page purpose.');
    if (page.canonical && !page.noindex && page.status === 200 && sitemaps.some(map => map.complete) && !sitemapEntries.has(page.canonical)) add('sitemap-membership', 'warning', page.url, 'Observed indexable canonical is absent from the parsed sitemap set.');
    for (const link of page.links) if (new URL(link.url).origin === origin && !new URL(link.url).search && !/\.(?:pdf|xml|txt|json|zip|jpe?g|png|webp|svg|mp4|mp3|css|js)$/i.test(new URL(link.url).pathname)) pending.push(link.url);
  }
  const byUrl = new Map(pages.map(page => [page.url, page]));
  for (const page of pages) {
    for (const link of page.links) {
      const destination = byUrl.get(link.url);
      if (destination && destination.status >= 400) add('broken-internal-link', 'error', page.url, `Internal link returns ${destination.status}: ${link.url}`);
      if (destination?.canonical && destination.canonical !== link.url) add('alternate-internal-link', 'warning', page.url, `Internal link and destination canonical differ: ${link.url}`);
    }
    for (const alternate of page.hreflang) {
      if (!alternate.url) continue;
      const other = byUrl.get(alternate.url);
      if (!other) { add('hreflang-unverified', 'review', page.url, 'Alternate was outside the crawl sample; reciprocity/canonical remain unverified.'); continue; }
      if (other.noindex || other.status !== 200 || other.canonical !== alternate.url) add('hreflang-indexability', 'error', page.url, 'Hreflang points to a nonindexable/noncanonical sampled page.');
      if (!other.hreflang.some(item => item.url === page.canonical)) add('hreflang-reciprocity', 'error', page.url, 'Sampled alternate has no reciprocal hreflang to this canonical.');
    }
  }
  for (const field of ['title', 'description', 'contentHash'] as const) {
    const groups = new Map<string, string[]>();
    for (const page of pages.filter(page => page.status === 200 && !page.noindex)) { const value = page[field]?.toLowerCase(); if (value && (field !== 'contentHash' || page.contentLength > 100)) groups.set(value, [...(groups.get(value) ?? []), page.url]); }
    for (const urls of groups.values()) if (urls.length > 1) add(`duplicate-${field}`, 'review', urls[0], `Same ${field === 'contentHash' ? 'sampled main text' : field} on ${urls.length} pages; compare intent before consolidating: ${urls.slice(0, 4).join(', ')}`);
  }
  const depth = new Map([[first.finalUrl, 0]]), walk = [first.finalUrl];
  while (walk.length) { const url = walk.shift()!; for (const link of byUrl.get(url)?.links ?? []) { if (!depth.has(link.url)) { depth.set(link.url, depth.get(url)! + 1); walk.push(link.url); } } }
  for (const url of new Set([...knownPolicy.keys(), ...sitemapEntries.keys()])) {
    if (byUrl.has(url) && !depth.has(url)) add('orphan-in-sample', 'review', url, 'Not reachable from the entry through sampled HTML links; sitemap discovery alone does not prove internal reachability.');
    if ((depth.get(url) ?? 0) > 3) add('deep-important-page', 'review', url, `Important page is ${depth.get(url)} clicks from the sampled entry.`);
  }
  const machine = await attempt(origin + '/llms.txt', 256 * 1024);
  const machineUrls = machine?.status === 200 ? [...machine.text.matchAll(/https?:\/\/[^\s<>"')]+/g)].slice(0, 500).map(match => seoUrl(match[0])).filter(Boolean) as string[] : [];
  if (!machine || machine.status !== 200) add('llms-discovery', 'review', origin + '/llms.txt', 'No verified llms.txt; create concise public canonical pointers under the requested discovery policy. It is not a ranking requirement.');
  else {
    if (/html/i.test(machine.headers.get('content-type') ?? '') || /<html|<!doctype html/i.test(machine.text)) add('llms-html', 'error', origin + '/llms.txt', 'llms.txt returns an HTML fallback.');
    if (machine.truncated) add('llms-coverage', 'review', origin + '/llms.txt', 'llms.txt is truncated; remaining pointers are unknown.');
    for (const url of machineUrls) {
      if (new URL(url).origin !== origin || excludedSeoUrl(url) || excludedUrls.has(url)) add('machine-private-url', 'error', origin + '/llms.txt', 'Machine-readable file exposes an excluded/private/alternate-origin URL.');
      const page = byUrl.get(url);
      if (page && (page.status !== 200 || page.noindex || page.canonical !== url)) add('machine-canonical-parity', 'error', origin + '/llms.txt', 'Discovery pointer disagrees with sampled canonical/index/status.');
    }
  }
  const { document: entryDoc } = parseHTML(first.text);
  const feed = entryDoc.querySelector('link[rel~="alternate"][type="application/rss+xml"],link[rel~="alternate"][type="application/atom+xml"]');
  const feedUrl = feed ? seoUrl(feed.getAttribute('href') ?? '', first.finalUrl) : undefined;
  if (feedUrl && (new URL(feedUrl).origin !== origin || excludedSeoUrl(feedUrl))) add('feed-url-policy', 'error', first.finalUrl, 'Feed points outside the public canonical route policy.');
  let feedStatus: number | null = null, feedEntries = 0;
  if (feedUrl && robotsKnown && new URL(feedUrl).origin === origin && !excludedSeoUrl(feedUrl) && !excludedUrls.has(feedUrl) && verdict(feedUrl)?.allowed !== false) {
    const response = await attempt(feedUrl);
    feedStatus = response?.status ?? null;
    if (response?.status === 200) {
      const parsed = parseSeoFeed(response.text); feedEntries = parsed.entries.length;
      for (const error of parsed.errors) add('feed-xml', 'error', feedUrl, error);
      if (response.truncated || parsed.entries.length >= 500) add('feed-coverage', 'review', feedUrl, 'Feed sample is bounded; remaining entries are unknown.');
      for (const entry of parsed.entries) {
        const url = seoUrl(entry.url);
        if (!url || new URL(url).origin !== origin || excludedSeoUrl(url) || excludedUrls.has(url)) add('feed-entry-policy', 'error', feedUrl, 'Feed entry URL is invalid, private or outside the canonical origin.');
        else {
          const page = byUrl.get(url);
          if (page && (page.status !== 200 || page.noindex || page.canonical !== url)) add('feed-canonical-parity', 'error', feedUrl, 'Feed pointer disagrees with sampled canonical/index/status.');
          const published = knownPolicy.get(url)?.published;
          if (published && entry.published && Date.parse(entry.published) !== Date.parse(published)) add('feed-source-date', 'error', url, 'Feed publication date disagrees with supplied source date.');
        }
        if (entry.published && (!Number.isFinite(Date.parse(entry.published)) || Date.parse(entry.published) > Date.now() + 86400000)) add('feed-date', 'error', feedUrl, 'Feed publication date is invalid or in the future.');
      }
    } else add('feed-status', 'review', feedUrl, `Feed status is ${feedStatus ?? 'unverified'}.`);
  }
  const omitted = pending.filter(url => !visited.has(url)).length;
  return { origin, entry: first.finalUrl, pages, findings: [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()], failures, sitemaps, redirects,
    discovery: { llms: { url: origin + '/llms.txt', status: machine?.status ?? null, pointers: machineUrls.length }, feed: feedUrl ? { url: feedUrl, status: feedStatus, entries: feedEntries } : null },
    coverage: { pages: pages.length, maxPages, requests, bytes, pendingUrls: omitted, sitemapFilesPending: sitemapQueue.length, robotsKnown, elapsedEntryMs: first.elapsedMs,
      complete: false, boundedSample: true, rawHtml: true, findingsTruncated: findings.length >= 600, renderedDom: false, coreWebVitals: false, schemaFacts: false, freshnessHistory: false, indexed: 'unverified',
      reason: signal.aborted ? 'deadline' : 'bounded representative audit; route inventory and live/browser/source-history checks remain separate' },
    next: ['Fix observed errors in shared route/templates/content owners; rerun on the changed revision.', 'Review route intent, content value/cannibalization, visible schema facts, identity and substantive-change dates.', 'Inspect rendered DOM, mobile/keyboard behavior and measure LCP/CLS/INP; repeat raw audit on production after an authorized deployment.'] };
}
