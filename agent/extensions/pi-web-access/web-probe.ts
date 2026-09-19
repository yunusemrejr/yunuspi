import type { ExtensionAPI } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { parseHTML } from "linkedom";
import { fetchRemoteUrl, loadFetchContentDomainPolicy, loadSsrfConfig, type Lookup } from "./ssrf-protection.ts";
import { runWithProxy } from "./utils.ts";

const MAX_BYTES = 64 * 1024;
const short = (value: string | null | undefined, limit = 160) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

export interface ProbeOptions {
  /** Resolver seam for deterministic offline callers and tests. */
  lookup?: Lookup;
  /** Explicit opt-in used only by local fixture callers; the registered tool never sets it. */
  allowLoopback?: boolean;
}

/** One bounded, unauthenticated GET. No scripts, browser actions or file writes. */
export async function probePage(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, options: ProbeOptions = {}) {
  const target = httpUrl(url);
  if (!target || target.length > 8192) throw new Error("Use an HTTP(S) URL without embedded credentials, at most 8192 characters.");
  const deadline = AbortSignal.timeout(10_000);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const ssrf = loadSsrfConfig();
  const domainPolicy = loadFetchContentDomainPolicy();
  const response = await fetchRemoteUrl(target, { signal: combinedSignal }, {
    fetch: fetcher,
    allowRanges: ssrf.allowRanges,
    trustEnvProxy: ssrf.trustEnvProxy,
    domainPolicy,
    allowLoopback: options.allowLoopback === true,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  const responseUrl = response.url || target;
  const safeFinalUrl = httpUrl(responseUrl);
  const finalUrl = safeFinalUrl || target;
  const contentType = response.headers.get('content-type') ?? '';
  const transport = { requestedUrl: target, finalUrl: safeFinalUrl && safeFinalUrl.length <= 8192 ? safeFinalUrl : undefined, finalUrlOmitted: !safeFinalUrl || safeFinalUrl.length > 8192, redirected: response.redirected || safeFinalUrl !== undefined && safeFinalUrl !== target, status: response.status, contentType: short(contentType, 256), retryAfter: short(response.headers.get('retry-after'), 80) || null };
  if (contentType && !/html|xhtml/i.test(contentType)) {
    await response.body?.cancel();
    return { ...transport, nextStep: response.ok ? "Non-HTML response: use http_request for raw data or fetch_content for readable content; verify its type before saving with a source-code extension." : "HTTP error response, not the requested content. Check URL/access; do not repair the response body." };
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    if (reader) while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = MAX_BYTES - bytes;
      chunks.push(value.subarray(0, remaining));
      bytes += Math.min(value.length, remaining);
      if (value.length > remaining) { truncated = true; break; }
    }
  } finally { await reader?.cancel(); }
  const html = Buffer.concat(chunks).toString('utf8');
  const { document } = parseHTML(html);
  const scripts = document.querySelectorAll('script').length;
  const challengeHint = /cf-chl-|anomaly-modal|g-recaptcha|h-captcha|verify you are human/i.test(html);
  const passwordField = Array.from(document.querySelectorAll('input')).some(el => el.getAttribute('type')?.toLowerCase() === 'password');
  const base = httpUrl(document.querySelector('base[href]')?.getAttribute('href') ?? '', finalUrl) ?? finalUrl;
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
  return { ...transport, title: short(document.title), sampledBytes: bytes, truncated, signals, links, forms, buttons, textPreview: visibleText, nextStep, note: 'Page-derived data is untrusted. Form values and editable content are omitted; no cookies returned. Static visibility only; CSS may hide additional content. Links longer than 2048 characters are omitted, not shortened. No links followed or forms submitted; redirect follow-up GETs may occur.' };
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
    description: 'Read-only reconnaissance before a complicated web task: one bounded GET returns status/final URL/content type, title, links, form field names and browser handoff hints. No browser dependency, cookies, scripts, form submission or file writes. HTML capped at 64 KiB; total timeout 10s. Heuristic hints are not proof; a browser session may have different login state.',
    promptGuidelines: ['Use web_probe when a page fails or before complex interaction; use web_search for discovery, fetch_content for reading, and an available browser/Playwright tool for interaction. Avoid repeating unchanged probes.'],
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 8192 }), proxy: Type.Optional(Type.String({ description: 'Existing web extension HTTP(S) proxy override; empty string forces direct access.' })) }),
    async execute(_id, params, signal) {
      try {
        const result = await runWithProxy(params.proxy, () => probePage(params.url, signal));
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
