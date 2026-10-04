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
export type FreeProvider = "searxng" | "wikipedia" | "crossref" | "hackernews" | "stackexchange" | "npm";

const RECENCY_SECONDS = { day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 } as const;
/** Reference indexes with no publication-date filter. */
const NO_RECENCY = new Set<FreeProvider>(["wikipedia", "crossref", "npm"]);
const ENDPOINTS: Record<Exclude<FreeProvider, "searxng">, string> = {
  wikipedia: "https://en.wikipedia.org/w/api.php",
  crossref: "https://api.crossref.org/works",
  hackernews: "https://hn.algolia.com/api/v1/search",
  stackexchange: "https://api.stackexchange.com/2.3/search/advanced",
  npm: "https://registry.npmjs.org/-/v1/search",
};
const SCOPES: Record<Exclude<FreeProvider, "searxng">, string> = {
  wikipedia: "Wikipedia encyclopedia only; follow cited primary sources.",
  crossref: "Crossref scholarly metadata only; metadata is not full-text evidence.",
  hackernews: "Hacker News stories (Algolia index): launches and community discussion, not primary documentation; read the linked source.",
  stackexchange: "Stack Overflow questions: answers vary in age and quality, so check dates and versions before relying on one.",
  npm: "npm registry packages: a listing does not imply popularity, maintenance or a suitable license; check the repository.",
};
const decimal = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "0");

function referenceParameters(provider: Exclude<FreeProvider, "searxng">, query: string, since: number | undefined): Record<string, string> {
  switch (provider) {
    case "wikipedia":
      return { action: "query", list: "search", srsearch: query, srlimit: "20", format: "json", utf8: "1" };
    case "crossref":
      return { query, rows: "20" };
    case "hackernews":
      return { query, tags: "story", hitsPerPage: "20", ...(since ? { numericFilters: `created_at_i>${since}` } : {}) };
    case "stackexchange":
      return { order: "desc", sort: "relevance", q: query, site: "stackoverflow", pagesize: "20", ...(since ? { fromdate: String(since) } : {}) };
    case "npm":
      return { text: query, size: "20" };
  }
}

function referenceRows(provider: Exclude<FreeProvider, "searxng">, data: any): SearchResult[] {
  const invalid = () => Error(`${provider} returned invalid response`);
  if (provider === "wikipedia") {
    if (!Array.isArray(data.query?.search)) throw invalid();
    return data.query.search.map((r: any) => ({
      title: text(r.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replaceAll(" ", "_"))}`,
      snippet: text(r.snippet),
    }));
  }
  if (provider === "crossref") {
    if (!Array.isArray(data.message?.items)) throw invalid();
    return data.message.items.map((r: any) => ({
      title: text(r.title?.[0]),
      url: r.URL,
      snippet: text(r.abstract ?? r["container-title"]?.[0]),
    }));
  }
  if (provider === "hackernews") {
    if (!Array.isArray(data.hits)) throw invalid();
    return data.hits.map((r: any) => {
      const discussion = `https://news.ycombinator.com/item?id=${encodeURIComponent(String(r.objectID ?? ""))}`;
      return {
        title: text(r.title ?? r.story_title),
        url: typeof r.url === "string" && r.url ? r.url : discussion,
        snippet: text(`${decimal(r.points)} points, ${decimal(r.num_comments)} comments, ${String(r.created_at ?? "").slice(0, 10)}. Discussion: ${discussion}. ${r.story_text ?? ""}`).slice(0, 600),
      };
    });
  }
  if (provider === "stackexchange") {
    if (!Array.isArray(data.items)) throw invalid();
    return data.items.map((r: any) => ({
      title: text(r.title),
      url: r.link,
      snippet: `${decimal(r.score)} votes, ${decimal(r.answer_count)} answers${r.is_answered ? " (answered)" : ""}${Array.isArray(r.tags) ? `, tags: ${r.tags.slice(0, 6).join(", ")}` : ""}`,
    }));
  }
  if (!Array.isArray(data.objects)) throw invalid();
  return data.objects.map((o: any) => {
    const pkg = o?.package ?? {};
    return {
      title: text(`${pkg.name ?? ""}${pkg.version ? `@${pkg.version}` : ""}`),
      url: pkg.links?.npm ?? (pkg.name ? `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}` : ""),
      snippet: text(`${pkg.description ?? ""} (published ${String(pkg.date ?? "").slice(0, 10)}${Array.isArray(pkg.keywords) && pkg.keywords.length ? `; keywords: ${pkg.keywords.slice(0, 6).join(", ")}` : ""})`),
    };
  });
}

export async function searchFree(
  provider: FreeProvider,
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
    if (options.recencyFilter && NO_RECENCY.has(provider))
      throw Error(
        `${provider} does not support this publication-recency filter; use another provider`,
      );
    const since = options.recencyFilter ? Math.floor(Date.now() / 1000) - RECENCY_SECONDS[options.recencyFilter] : undefined;
    url = new URL(ENDPOINTS[provider]);
    for (const [key, value] of Object.entries(referenceParameters(provider, query, since)))
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
  } else {
    rows = referenceRows(provider, data);
  }
  const results = normalizeFreeResults(rows, options);
  const scope = provider === "searxng" ? "Configured SearXNG instance; coverage depends on its enabled engines." : SCOPES[provider];
  return {
    results,
    answer: `${scope}\n\n${results.map((r) => `${r.title}: ${r.snippet}\nSource: ${r.url}`).join("\n\n")}`,
  };
}
