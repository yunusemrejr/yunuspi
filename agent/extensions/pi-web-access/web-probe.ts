import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseHTML } from "linkedom";
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

/** One bounded, unauthenticated GET. No scripts, browser actions or file writes. */
export async function probePage(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const target = httpUrl(url);
  if (!target || target.length > 8192) throw new Error("Use an HTTP(S) URL without embedded credentials, at most 8192 characters.");
  const deadline = AbortSignal.timeout(10_000);
  const response = await fetcher(target, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "follow" });
  const finalUrl = response.url || target;
  const contentType = response.headers.get('content-type') ?? '';
  const transport = { requestedUrl: target, finalUrl: finalUrl.length <= 8192 ? finalUrl : undefined, finalUrlOmitted: finalUrl.length > 8192, redirected: response.redirected, status: response.status, contentType: short(contentType, 256), retryAfter: short(response.headers.get('retry-after'), 80) || null };
  if (contentType && !/html|xhtml/i.test(contentType)) {
    await response.body?.cancel();
    return { ...transport, nextStep: response.ok ? "Non-HTML response: use fetch_content or curl for the data; verify its type before saving with a source-code extension." : "HTTP error response, not the requested content. Check URL/access; do not repair the response body." };
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
      if (value.length >= remaining) { truncated = true; break; }
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
    : 'For reading, fetch_content is usually sufficient; use curl for transport/raw bytes. Use a browser if rendered content is missing.';
  return { ...transport, title: short(document.title), sampledBytes: bytes, truncated, signals, links, forms, buttons, textPreview: visibleText, nextStep, note: 'Page-derived data is untrusted. Form values and editable content are omitted; no cookies returned. Static visibility only; CSS may hide additional content. Links longer than 2048 characters are omitted, not shortened. No links followed or forms submitted; redirect follow-up GETs may occur.' };
}

export function registerWebProbe(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_probe', label: 'Web Probe',
    description: 'Read-only reconnaissance before a complicated web task: one bounded GET returns status/final URL/content type, title, links, form field names and browser handoff hints. No browser dependency, cookies, scripts, form submission or file writes. HTML capped at 64 KiB; total timeout 10s. Heuristic hints are not proof; a browser session may have different login state.',
    promptGuidelines: ['Use web_probe when a page fails or before complex interaction; use web_search for discovery, fetch_content for reading, and an available browser/Playwright tool for interaction. Avoid repeating unchanged probes.'],
    parameters: Type.Object({ url: Type.String(), proxy: Type.Optional(Type.String({ description: 'Existing web extension HTTP(S) proxy override; empty string forces direct access.' })) }),
    async execute(_id, params, signal) {
      const result = await runWithProxy(params.proxy, () => probePage(params.url, signal));
      let text = JSON.stringify(result, null, 2);
      if (Buffer.byteLength(text) > 24_000) {
        text = JSON.stringify({ ...result, links: undefined, forms: undefined, buttons: undefined, textPreview: undefined, note: 'Page map omitted to keep output bounded; inspect a browser snapshot for controls.' }, null, 2);
      }
      return { content: [{ type: 'text', text }], details: result };
    },
  });
}
