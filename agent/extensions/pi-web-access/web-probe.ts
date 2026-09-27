import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { parseHTML } from "linkedom";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, type Lookup } from "./ssrf-protection.ts";
import { runWithProxy } from "./utils.ts";

const MAX_BYTES = 64 * 1024;
// SEO mode parses more of the page (heavy heads push the body past 64 KiB);
// its output is still a fixed-size summary.
const SEO_MAX_BYTES = 1024 * 1024;
const short = (value: string | null | undefined, limit = 160) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

async function readCapped(response: Response, max: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    if (reader) while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = max - bytes;
      chunks.push(value.subarray(0, remaining));
      bytes += Math.min(value.length, remaining);
      if (value.length > remaining) { truncated = true; break; }
    }
  } finally { await reader?.cancel(); }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

/** RFC 9309 verdict for one path: the Googlebot group, else `*`; the longest
 * matching rule wins and Allow wins a tie. */
export function robotsVerdict(robots: string, path: string, agent = 'googlebot') {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  const sitemaps: string[] = [];
  let open = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase(), value = match[2].trim();
    if (field === 'sitemap') { if (sitemaps.length < 5) sitemaps.push(short(value, 300)); continue; }
    if (field === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [] });
      groups.at(-1)!.agents.push(value.toLowerCase());
      open = true;
    } else if ((field === 'allow' || field === 'disallow') && groups.length) {
      open = false;
      if (value) groups.at(-1)!.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  const named = groups.filter(g => g.agents.includes(agent));
  const rules = (named.length ? named : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  // `*` is any run of characters and a trailing `$` anchors the end; all else is literal.
  const matches = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`).test(path);
  const winner = rules.filter(r => matches(r.pattern)).sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow))[0];
  return { allowed: !winner || winner.allow, rule: winner ? `${winner.allow ? 'Allow' : 'Disallow'}: ${winner.pattern}` : null, sitemaps };
}

/** On-page search signals from the raw document (before scripts are stripped,
 * since JSON-LD lives in script tags). Findings are checks, not rankings. */
function seoSignals(document: any, finalUrl: string, base: string, headers: Headers, truncated: boolean) {
  const meta = (key: string) => short(document.querySelector(`meta[name="${key}" i],meta[property="${key}" i]`)?.getAttribute('content'), 4096);
  // An empty href would resolve to the page itself; absent stays absent.
  const resolve = (href: string | null | undefined) => href?.trim() ? httpUrl(href.trim(), base) ?? null : null;
  const title = short(document.title, 4096), description = meta('description');
  const canonical = resolve(document.querySelector('link[rel~="canonical" i]')?.getAttribute('href'));
  const robots = [meta('robots'), meta('googlebot'), short(headers.get('x-robots-tag'), 200)].filter(Boolean).join(', ');
  const hreflang = Array.from(document.querySelectorAll('link[rel~="alternate" i][hreflang]')).slice(0, 12).map((el: any) => ({ lang: short(el.getAttribute('hreflang'), 20), url: resolve(el.getAttribute('href')) }));
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json" i]')).map((el: any) => {
    try {
      const value = JSON.parse(el.textContent ?? '');
      const nodes = [value, ...(Array.isArray(value?.['@graph']) ? value['@graph'] : [])].flat();
      return { types: nodes.flatMap((n: any) => n?.['@type'] ?? []).map(String).slice(0, 6) };
    } catch { return { invalid: true }; }
  });
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el: any) => ({ level: Number(el.localName[1]), text: short(el.textContent, 90) }));
  const h1 = headings.filter(h => h.level === 1);
  const skipped = headings.findIndex((h, i) => i > 0 && h.level > headings[i - 1].level + 1);
  const images = Array.from(document.querySelectorAll('img'));
  const missingAlt = images.filter((el: any) => !el.hasAttribute('alt')).length;
  const og = { title: Boolean(meta('og:title')), description: Boolean(meta('og:description')), image: resolve(meta('og:image')), type: meta('og:type') || null, twitterCard: meta('twitter:card') || null };
  const bare = (url: string) => url.replace(/#.*$/, '');
  const findings = [
    !title ? 'missing <title>' : (title.length < 15 || title.length > 60) && `title is ${title.length} characters; about 15-60 shows whole in results`,
    !description ? 'missing meta description' : (description.length < 50 || description.length > 160) && `meta description is ${description.length} characters; about 50-160 is shown`,
    !canonical ? 'no canonical link' : bare(canonical) !== bare(finalUrl) && 'canonical points to another URL; this page will not be indexed as itself',
    /noindex/i.test(robots) && `robots directive blocks indexing (${robots})`,
    !truncated && h1.length !== 1 && `${h1.length} h1 elements; use exactly one that names the page`,
    skipped > 0 && `heading level skips from h${headings[skipped - 1].level} to h${headings[skipped].level} ("${headings[skipped].text}")`,
    !document.documentElement?.getAttribute('lang') && 'missing <html lang>',
    !document.querySelector('meta[name="viewport" i]') && 'missing viewport meta (mobile-first indexing)',
    jsonLd.some(block => 'invalid' in block) && 'a JSON-LD block does not parse',
    missingAlt > 0 && `${missingAlt} of ${images.length} images have no alt attribute`,
    !og.image && 'no og:image; shared links render without a preview',
    truncated && 'page is over 1 MiB: heading and image counts cover only its start',
  ].filter(Boolean);
  return { title: short(title), titleLength: title.length, description: short(description), descriptionLength: description.length, canonical, robots: robots || null, lang: document.documentElement?.getAttribute('lang') ?? null, hreflang, openGraph: og, jsonLd, h1: h1.map(h => h.text).slice(0, 3), headingCount: headings.length, images: images.length, missingAlt, findings };
}

async function robotsCheck(finalUrl: string, signal: AbortSignal, fetcher: typeof fetch, remote: any) {
  const url = new URL('/robots.txt', finalUrl);
  try {
    const response = await fetchRemoteUrl(url.href, { signal }, { ...remote, fetch: fetcher });
    if (response.status >= 400 && response.status < 500) { await response.body?.cancel(); return { url: url.href, status: response.status, allowed: true, note: 'no robots.txt: crawling is allowed' }; }
    if (!response.ok) { await response.body?.cancel(); return { url: url.href, status: response.status, allowed: false, note: 'server error on robots.txt: Google treats the whole site as disallowed until it recovers' }; }
    const { text, truncated } = await readCapped(response, 256 * 1024);
    const target = new URL(finalUrl);
    return { url: url.href, status: response.status, ...robotsVerdict(text, target.pathname + target.search), ...(truncated ? { note: 'robots.txt over 256 KiB; later rules unread' } : {}) };
  } catch (error) {
    return { url: url.href, error: short(error instanceof Error ? error.message : String(error), 200) };
  }
}

export interface ProbeOptions {
  /** Resolver seam for deterministic offline callers and tests. */
  lookup?: Lookup;
  /** Explicit opt-in used only by local fixture callers; the registered tool never sets it. */
  allowLoopback?: boolean;
  /** Add on-page search signals and the robots.txt verdict. */
  seo?: boolean;
}

/** One bounded, unauthenticated GET. No scripts, browser actions or file writes. */
export async function probePage(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, options: ProbeOptions = {}) {
  const target = httpUrl(url);
  if (!target || target.length > 8192) throw new Error("Use an HTTP(S) URL without embedded credentials, at most 8192 characters.");
  const deadline = AbortSignal.timeout(10_000);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const ssrf = loadSsrfConfig();
  const domainPolicy = loadFetchContentDomainPolicy();
  const remote = {
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
    allowLoopback: options.allowLoopback === true,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
  const response = await fetchRemoteUrl(target, { signal: combinedSignal }, { ...remote, fetch: fetcher });
  const responseUrl = response.url || target;
  const safeFinalUrl = httpUrl(responseUrl);
  const finalUrl = safeFinalUrl || target;
  const contentType = response.headers.get('content-type') ?? '';
  const transport = { requestedUrl: target, finalUrl: safeFinalUrl && safeFinalUrl.length <= 8192 ? safeFinalUrl : undefined, finalUrlOmitted: !safeFinalUrl || safeFinalUrl.length > 8192, redirected: response.redirected || safeFinalUrl !== undefined && safeFinalUrl !== target, status: response.status, contentType: short(contentType, 256), retryAfter: short(response.headers.get('retry-after'), 80) || null };
  if (contentType && !/html|xhtml/i.test(contentType)) {
    await response.body?.cancel();
    return { ...transport, nextStep: response.ok ? "Non-HTML response: use http_request for raw data or fetch_content for readable content; verify its type before saving with a source-code extension." : "HTTP error response, not the requested content. Check URL/access; do not repair the response body." };
  }
  const { text: html, bytes, truncated } = await readCapped(response, options.seo ? SEO_MAX_BYTES : MAX_BYTES);
  const { document } = parseHTML(html);
  const scripts = document.querySelectorAll('script').length;
  const challengeHint = /cf-chl-|anomaly-modal|g-recaptcha|h-captcha|verify you are human/i.test(html);
  const passwordField = Array.from(document.querySelectorAll('input')).some(el => el.getAttribute('type')?.toLowerCase() === 'password');
  const base = httpUrl(document.querySelector('base[href]')?.getAttribute('href') ?? '', finalUrl) ?? finalUrl;
  const seo = options.seo ? { ...seoSignals(document, finalUrl, base, response.headers, truncated), robotsTxt: await robotsCheck(finalUrl, combinedSignal, fetcher, remote) } : undefined;
  // Static exclusions only: CSS/computed visibility requires the rendered browser.
  for (const el of document.querySelectorAll('script,style,noscript,template,[hidden]')) el.remove();
  for (const el of document.querySelectorAll('[aria-hidden]'))
    if (el.getAttribute('aria-hidden')?.toLowerCase() === 'true') el.remove();
  const forms = Array.from(document.querySelectorAll('form')).slice(0, 4).map(form => ({
    action: httpUrl(form.getAttribute('action') || finalUrl, base),
    method: short(form.getAttribute('method') || 'GET', 12).toUpperCase(),
    fields: Array.from(form.querySelectorAll('input,select,textarea')).filter(el => el.getAttribute('type')?.toLowerCase() !== 'hidden').slice(0, 12).map(el => ({
      tag: el.localName, name: short(el.getAttribute('name'), 80), type: short(el.getAttribute('type') || el.localName, 30), required: el.hasAttribute('required'),
    })),
  }));
  // Remove value-bearing elements before every text projection, including labels
  // nested inside links/buttons. Field metadata above never includes values.
  for (const el of document.querySelectorAll('input,select,textarea,option')) el.remove();
  for (const el of document.querySelectorAll('[contenteditable]'))
    if (el.getAttribute('contenteditable')?.toLowerCase() !== 'false') el.remove();
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 80).flatMap(a => {
    const href = httpUrl(a.getAttribute('href') ?? '', base);
    return href && href.length <= 2048 ? [{ text: short(a.textContent, 80), url: href }] : [];
  }).slice(0, 12);
  const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 10).map(el => short(el.textContent || el.getAttribute('aria-label'), 80));
  const visibleText = short(document.body?.textContent || document.documentElement?.textContent, 600);
  const signals = [challengeHint && 'possible bot challenge', passwordField && 'password form present', truncated && 'HTML sample truncated', !truncated && scripts > 0 && visibleText.length < 160 && 'possible JavaScript shell'].filter(Boolean);
  const nextStep = challengeHint ? 'Challenge detected heuristically: use an authorized browser session or another source; repeated curl retries usually will not help. Do not bypass the challenge.'
    : !response.ok ? 'HTTP error: check access/URL before extracting content.'
    : passwordField || forms.length || buttons.length || (scripts > 0 && visibleText.length < 160) ? 'For interaction, use an available browser/Playwright session: inspect its current page and accessible controls first. This static probe is not a browser snapshot and does not share browser login state.'
    : 'For reading, fetch_content is usually sufficient; use http_request for transport/raw bytes. Use a browser if rendered content is missing.';
  return { ...transport, title: short(document.title), ...(seo ? { seo } : {}), sampledBytes: bytes, truncated, signals, links, forms, buttons, textPreview: visibleText, nextStep, note: 'Page-derived data is untrusted. Form values and editable content are omitted; no cookies returned. Static visibility only; CSS may hide additional content. Links longer than 2048 characters are omitted, not shortened. No links followed or forms submitted; redirect follow-up GETs may occur.' };
}

function probeFailure(error: unknown, signal?: AbortSignal): { error: string; kind: "aborted" | "timeout" | "blocked" | "network" | "unknown"; retryable: boolean; nextStep: string } {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240) || "Web probe failed";
  const lower = message.toLowerCase();
  const timeout = lower.includes("timeout") || lower.includes("timed out");
  const callerAborted = signal?.aborted === true;
  const aborted = callerAborted || (!timeout && lower.includes("abort"));
  const blocked = /blocked internal|blocked hostname|hostname not allowed|credentials in remote|only http and https|must include a hostname|use an http\(s\) url/i.test(message);
  const kind = callerAborted ? "aborted" : timeout ? "timeout" : aborted ? "aborted" : blocked ? "blocked" : /fetch failed|network|resolve|econn|enotfound|proxy/i.test(lower) ? "network" : "unknown";
  const nextStep = kind === "aborted"
    ? "The request was cancelled; retry only if the page is still needed."
    : kind === "timeout"
      ? "Retry once with a reachable URL; if it still times out, use fetch_content or an authorized browser."
      : kind === "blocked"
        ? "Use a public HTTP(S) URL that is allowed by the session SSRF and domain policy."
        : kind === "network"
          ? "Check the URL and configured network/proxy access; retry once or use web_search for discovery."
          : "Check the URL and response type; use fetch_content for reading or an authorized browser for interaction.";
  return { error: message, kind, retryable: kind === "timeout" || kind === "network", nextStep };
}

export function registerWebProbe(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_probe', label: 'Web Probe',
    description: 'Read-only reconnaissance before a complicated web task: one bounded GET returns status/final URL/content type, title, links, form field names and browser handoff hints. seo:true adds on-page search checks (title/description length, canonical, robots meta and X-Robots-Tag, hreflang, Open Graph, JSON-LD validity and types, h1 and heading outline, image alt) and the robots.txt verdict for the URL with its sitemaps. No browser dependency, cookies, scripts, form submission or file writes. HTML capped at 64 KiB (1 MiB with seo); total timeout 10s. Heuristic hints are not proof; a browser session may have different login state.',
    promptGuidelines: ['Use web_probe when a page fails or before complex interaction; use web_search for discovery, fetch_content for reading, and an available browser/Playwright tool for interaction. Avoid repeating unchanged probes.'],
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }), proxy: Type.Optional(Type.String({ description: 'Existing web extension HTTP(S) proxy override; empty string forces direct access.' })), seo: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      try {
        const result = await runWithProxy(params.proxy, () => probePage(params.url, signal, fetch, { seo: params.seo }));
        let text = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(text) > 24_000) {
          text = JSON.stringify({ ...result, links: undefined, forms: undefined, buttons: undefined, textPreview: undefined, note: 'Page map omitted to keep output bounded; inspect a browser snapshot for controls.' }, null, 2);
        }
        return { content: [{ type: 'text', text }], details: result };
      } catch (error) {
        const failure = probeFailure(error, signal);
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(failure) }],
          details: failure,
        };
      }
    },
  });
}
