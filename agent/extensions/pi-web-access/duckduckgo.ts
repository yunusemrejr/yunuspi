import { parseHTML } from "linkedom";
import { activityMonitor } from "./activity.ts";
import { searchGet, coolSearchProvider, SearchCooldownError } from "./search-transport.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";

const SEARCH_URL = "https://lite.duckduckgo.com/lite/";
const SEARCH_URLS = [SEARCH_URL, "https://html.duckduckgo.com/html/"];

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

export function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	const hostname = new URL(url).hostname.toLowerCase();
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) return false;
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

function decodeResultUrl(href: string): string | null {
	try {
		const link = new URL(href, SEARCH_URL);
		const destination = link.searchParams.get("uddg") ?? link.href;
		const url = new URL(destination);
		return !url.username && !url.password && ["http:", "https:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

export function isDuckDuckGoAvailable(): boolean {
	return true;
}

export function parseDuckDuckGoResults(html: string, options: SearchOptions = {}): SearchResult[] {
	const { document } = parseHTML(html);
	if (document.querySelector("#challenge-form, #anomaly-form, .anomaly-modal") || /anomaly\.js|bots use DuckDuckGo/i.test(html)) {
		throw new Error("DuckDuckGo returned a bot challenge (invalid response)");
	}
	const filters = normalizeDomainFilters(options.domainFilter);
	const results: SearchResult[] = [];
	let parseableResults = 0;
	const seen = new Set<string>();
	for (const anchor of document.querySelectorAll(".result__a, .result-link")) {
		const container = anchor.closest(".result");
		if (container?.classList.contains("result--ad")) continue;
		const title = anchor.textContent?.trim() ?? "";
		const resultUrl = decodeResultUrl(anchor.getAttribute("href") ?? "");
		if (!title || !resultUrl || hostMatchesDomain(new URL(resultUrl).hostname, "duckduckgo.com")) continue;
		parseableResults++;
		if (seen.has(resultUrl) || !matchesDomainFilters(resultUrl, filters)) continue;
		let snippet = container?.querySelector(".result__snippet")?.textContent?.trim() ?? "";
		if (!container) {
			// Lite places each link and its snippet in consecutive table rows.
			let row = anchor.closest("tr")?.nextElementSibling;
			while (row && !row.querySelector(".result-link")) {
				const text = row.querySelector(".result-snippet")?.textContent?.trim();
				if (text) { snippet = text; break; }
				row = row.nextElementSibling;
			}
		}
		seen.add(resultUrl);
		results.push({ title, url: resultUrl, snippet });
		if (results.length >= normalizeCount(options.numResults)) break;
	}
	if (parseableResults === 0 && !document.querySelector(".no-results, .no-results__message") && !/No results found for/i.test(document.body?.textContent ?? "")) {
		throw new Error("DuckDuckGo returned no parseable results (invalid response)");
	}
	return results;
}

async function searchEndpoint(endpoint: string, query: string, options: SearchOptions): Promise<SearchResponse> {
	const url = new URL(endpoint);
	url.searchParams.set("q", query);
	if (options.recencyFilter) url.searchParams.set("df", { day: "d", week: "w", month: "m", year: "y" }[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const html = await searchGet("duckduckgo", url, options.signal);
    let results: SearchResult[];
    try { results = parseDuckDuckGoResults(html, options); }
    catch (error) {
      if (/bot challenge/i.test(String(error))) await coolSearchProvider("duckduckgo", 15 * 60_000);
      throw error;
    }
		activityMonitor.logComplete(activityId, 200);
		const answer = results.map(result => result.snippet
			? `${result.snippet}\nSource: ${result.title} (${result.url})`
			: `Source: ${result.title} (${result.url})`).join("\n\n");
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}
}

export async function searchWithDuckDuckGo(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const errors: string[] = [];
	for (const endpoint of SEARCH_URLS) {
		options.signal?.throwIfAborted();
		try {
			return await searchEndpoint(endpoint, query, options);
		} catch (err) {
			if (options.signal?.aborted || err instanceof SearchCooldownError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${new URL(endpoint).hostname}: ${message}`);
		}
	}
	throw new Error(`DuckDuckGo search failed: ${errors.join("; ")}`);
}
