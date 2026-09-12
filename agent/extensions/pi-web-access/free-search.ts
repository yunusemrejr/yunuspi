import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { matchesDomainFilters, normalizeDomainFilters } from "./duckduckgo.ts";
import { searchGet } from "./search-transport.ts";

export function searxngUrl(): URL | undefined {
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(getWebSearchConfigPath(), "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw Error("Invalid web search configuration");
  }
  const raw = process.env.SEARXNG_URL ?? config.searxngUrl;
  if (raw === undefined) return;
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error(
      "searxngUrl must be HTTPS (or loopback HTTP), without credentials, query or fragment",
    );
  url.pathname = url.pathname.replace(/\/$/, "") + "/search";
  return url;
}
const text = (value: unknown): string =>
  typeof value === "string"
    ? (parseHTML(`<html><body>${value}</body></html>`)
        .document.body.textContent?.trim()
        .slice(0, 2000) ?? "")
    : "";
export function normalizeFreeResults(
  input: SearchResult[],
  options: SearchOptions,
): SearchResult[] {
  const filters = normalizeDomainFilters(options.domainFilter),
    seen = new Set<string>();
  return input
    .filter((row) => {
      try {
        const url = new URL(row.url);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          !row.title ||
          !matchesDomainFilters(url.href, filters)
        )
          return false;
        url.hash = "";
        if (seen.has(url.href)) return false;
        row.url = url.href;
        seen.add(url.href);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, Math.max(1, Math.min(options.numResults ?? 5, 20)));
}
export async function searchFree(
  provider: "searxng" | "wikipedia" | "crossref",
  query: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  let url: URL;
  if (provider === "searxng") {
    const endpoint = searxngUrl();
    if (!endpoint)
      throw Error(
        "SearXNG unavailable: configure your authorized JSON-enabled instance with searxngUrl or SEARXNG_URL",
      );
    url = endpoint;
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    if (options.recencyFilter === "week")
      throw Error(
        "SearXNG does not support the week recency filter; use day/month/year or another provider",
      );
    if (options.recencyFilter)
      url.searchParams.set("time_range", options.recencyFilter);
  } else {
    if (options.recencyFilter)
      throw Error(
        `${provider} does not support this publication-recency filter; use another provider`,
      );
    url = new URL(
      provider === "wikipedia"
        ? "https://en.wikipedia.org/w/api.php"
        : "https://api.crossref.org/works",
    );
    const parameters =
      provider === "wikipedia"
        ? {
            action: "query",
            list: "search",
            srsearch: query,
            srlimit: "20",
            format: "json",
            utf8: "1",
          }
        : { query, rows: "20" };
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value);
  }
  const body = await searchGet(
    provider === "searxng" ? `searxng:${url.origin}` : provider,
    url,
    options.signal,
  );
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw Error(`${provider} returned invalid JSON`);
  }
  let rows: SearchResult[];
  if (provider === "searxng") {
    if (!Array.isArray(data.results))
      throw Error(
        "SearXNG returned invalid response; enable JSON on your instance",
      );
    rows = data.results.map((r: any) => ({
      title: text(r.title),
      url: r.url,
      snippet: text(r.content),
    }));
  } else if (provider === "wikipedia") {
    if (!Array.isArray(data.query?.search))
      throw Error("Wikipedia returned invalid response");
    rows = data.query.search.map((r: any) => ({
      title: text(r.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replaceAll(" ", "_"))}`,
      snippet: text(r.snippet),
    }));
  } else {
    if (!Array.isArray(data.message?.items))
      throw Error("Crossref returned invalid response");
    rows = data.message.items.map((r: any) => ({
      title: text(r.title?.[0]),
      url: r.URL,
      snippet: text(r.abstract ?? r["container-title"]?.[0]),
    }));
  }
  const results = normalizeFreeResults(rows, options);
  const scope =
    provider === "wikipedia"
      ? "Wikipedia encyclopedia only; follow cited primary sources."
      : provider === "crossref"
        ? "Crossref scholarly metadata only; metadata is not full-text evidence."
        : "Configured SearXNG instance; coverage depends on its enabled engines.";
  return {
    results,
    answer: `${scope}\n\n${results.map((r) => `${r.title}: ${r.snippet}\nSource: ${r.url}`).join("\n\n")}`,
  };
}
