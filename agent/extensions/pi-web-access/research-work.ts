import { setTimeout as delay } from "node:timers/promises";
import { matchesDomainFilters, normalizeDomainFilters } from "./duckduckgo.ts";

/** Registrable-ish domain: the last two labels, three for common two-part
 * public suffixes (example.co.uk). Good enough for diversity accounting. */
export function siteOf(url: string): string {
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".");
    const two = labels.slice(-2).join(".");
    return /^(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/.test(two) && labels.length > 2 ? labels.slice(-3).join(".") : two;
  } catch { return ""; }
}
// Mild, transparent priors: primary and reference sources first, social and
// Q&A aggregators last. Relevance and corroboration still dominate.
const PRIMARY = /(?:^|\.)(?:gov|edu|mil|int)$|(?:^|\.)(?:w3\.org|ietf\.org|rfc-editor\.org|iso\.org|whatwg\.org|ecma-international\.org|arxiv\.org|acm\.org|ieee\.org|nature\.com|science\.org|nih\.gov|who\.int|europa\.eu|python\.org|nodejs\.org|mozilla\.org|kernel\.org|postgresql\.org|rust-lang\.org|go\.dev|github\.com)$/;
const REFERENCE = /(?:^|\.)(?:wikipedia\.org|stackoverflow\.com|stackexchange\.com)$/;
const LOW_SIGNAL = /(?:^|\.)(?:pinterest\.[a-z.]+|quora\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com)$/;

/** Order candidate pages for reading: supplied sources first, then pages
 * that more queries found (and found higher), from more reputable hosts,
 * whose titles match the queries, spread across different sites. Returns
 * rows with the reasons that ranked them. */
export function rankReadCandidates(candidates: Array<{ url: string; origin: string }>, results: any[], alreadyRead: string[] = []): Array<{ url: string; origin: string; score: number; why: string[] }> {
  const hits = new Map<string, { reciprocal: number; queries: Set<string>; text: string }>();
  const sites = new Map<string, Set<string>>();
  for (const result of results ?? []) (result?.results ?? []).forEach((row: any, rank: number) => {
    let key: string;
    try { const url = new URL(row.url); url.hash = ""; key = url.href; } catch { return; }
    const hit = hits.get(key) ?? { reciprocal: 0, queries: new Set<string>(), text: "" };
    hit.reciprocal += 1 / (1 + rank); hit.queries.add(result.query); hit.text += ` ${row.title ?? ""} ${row.snippet ?? ""}`;
    hits.set(key, hit);
    const site = siteOf(key);
    sites.set(site, (sites.get(site) ?? new Set<string>()).add(result.query));
  });
  const queryTerms = new Set((results ?? []).flatMap((r: any) => String(r?.query ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  const scored = candidates.map((row) => {
    const why: string[] = [];
    let score = 0;
    if (row.origin === "supplied") { score += 100; why.push("supplied source"); }
    const hit = hits.get(row.url);
    if (hit) {
      score += hit.reciprocal;
      if (hit.queries.size > 1) { score += 0.8 * (hit.queries.size - 1); why.push(`found by ${hit.queries.size} queries`); }
      const words = new Set(hit.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      const overlap = [...queryTerms].filter((t) => words.has(t)).length / Math.max(1, queryTerms.size);
      score += 0.6 * overlap;
    }
    const site = siteOf(row.url);
    if ((sites.get(site)?.size ?? 0) > 1) { score += 0.3; why.push("site found by several queries"); }
    if (PRIMARY.test(site)) { score += 0.6; why.push("primary or official source"); }
    else if (REFERENCE.test(site)) { score += 0.3; why.push("reference source"); }
    else if (LOW_SIGNAL.test(site)) { score -= 0.6; why.push("social or aggregator source"); }
    return { ...row, score, why, site };
  });
  // Greedy selection with a per-site penalty keeps reads diverse.
  const counts = new Map<string, number>();
  for (const url of alreadyRead) counts.set(siteOf(url), (counts.get(siteOf(url)) ?? 0) + 1);
  const order: Array<{ url: string; origin: string; score: number; why: string[] }> = [];
  const pool = [...scored];
  while (pool.length) {
    let best = 0, bestScore = -Infinity;
    pool.forEach((row, i) => { const adjusted = row.score - 0.9 * (counts.get(row.site) ?? 0); if (adjusted > bestScore) { bestScore = adjusted; best = i; } });
    const [row] = pool.splice(best, 1);
    counts.set(row.site, (counts.get(row.site) ?? 0) + 1);
    order.push({ url: row.url, origin: row.origin, score: Math.round(bestScore * 100) / 100, why: row.why });
  }
  return order;
}

// Runs inside the existing job owner. Two workers, no extra model or browser.
export async function runResearchWork(
  job: any,
  p: any,
  queries: string[],
  ctx: any,
  runSearch: any,
  readSource: any,
) {
  const signal = job.controller.signal;
  const filters = normalizeDomainFilters(p.domainFilter);
  const canonical = (raw: string) => {
    try {
      const url = new URL(raw);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !matchesDomainFilters(url.href, filters)
      )
        return null;
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  };
  const maxPages = p.readPages ?? 3;
  const candidates = new Map<string, { url: string; origin: string }>();
  const add = (url: string, origin: string) => {
    const key = canonical(url);
    if (key && !candidates.has(key)) candidates.set(key, { url: key, origin });
  };
  for (const url of p.sourceUrls ?? []) add(url, "supplied");
  const retry: Array<{ index: number; at: number }> = [];
  const options = {
    domainFilter: p.domainFilter,
    recencyFilter: p.recencyFilter,
    numResults: 5,
    signal,
    extensionContext: ctx,
  };
  const boundedFailures = (failures: any[] = []) =>
    failures.slice(0, 3).map((f) => ({
      provider: f.provider,
      kind: f.kind,
      retryAfterMs: f.retryAfterMs,
      error: String(f.error ?? "").slice(0, 160),
    }));
  const runQuery = async (index: number, allowRetry: boolean) => {
    const query = queries[index],
      attempts: any[] = [];
    let found: any;
    for (const provider of [
      p.provider ?? "auto",
      ...new Set(p.fallbackProviders ?? []),
    ]) {
      signal.throwIfAborted();
      try {
        const response = await runSearch(query, { ...options, provider });
        signal.throwIfAborted();
        attempts.push({
          provider: response.provider,
          matches: response.results.length,
          ...(response.providerErrors?.length
            ? { failures: boundedFailures(response.providerErrors) }
            : {}),
        });
        found = response;
        if (response.results.length) break;
      } catch (error: any) {
        signal.throwIfAborted();
        const failures = (error.failures ?? []).slice(0, 6);
        attempts.push({
          provider,
          error: String(error).slice(0, 240),
          ...(failures.length ? { failures: boundedFailures(failures) } : {}),
        });
        const waits = [
          error.retryAfterMs,
          ...failures.map((f: any) => f.retryAfterMs),
        ].filter((ms) => Number.isFinite(ms) && ms > 0);
        const wait = Math.min(...waits);
        if (
          allowRetry &&
          wait <= 120000 &&
          Date.now() + wait < Date.parse(job.startedAt) + 570000
        )
          retry.push({ index, at: Date.now() + wait + 100 });
      }
    }
    const previous = job.results[index];
    const rows =
      found?.results?.slice(0, 5).map((r: any) => ({
        title: r.title.slice(0, 200),
        url: r.url.slice(0, 2000),
        snippet: r.snippet.slice(0, 500),
      })) ?? [];
    job.results[index] = {
      query,
      provider: found?.provider,
      coverage: rows.length ? "candidates" : "unavailable",
      attempts: [...(previous?.attempts ?? []), ...attempts].slice(-8),
      answer: (found?.answer ?? "").slice(0, 1500),
      answerTruncated: (found?.answer?.length ?? 0) > 1500,
      results: rows,
      ...(!rows.length
        ? {
            error: "No candidate sources; coverage remains incomplete.",
            nextStep:
              "Use another relevant provider or query angle, or supply known sourceUrls; do not infer absence.",
          }
        : {}),
    };
    const receipt = job.results[index];
    for (const row of rows) add(row.url, query);
    while (
      JSON.stringify(receipt).length > 12000 &&
      receipt.results.length > 1
    ) {
      receipt.results.pop();
      receipt.resultsTruncated = true;
    }
    while (
      JSON.stringify(receipt).length > 12000 &&
      receipt.attempts.length > 1
    ) {
      receipt.attempts.shift();
      receipt.attemptsTruncated = true;
    }
    if (!previous || previous.coverage === "pending") job.completed++;
  };
  const parallel = async (items: any[], work: (item: any) => Promise<void>) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, items.length) }, async () => {
        while (next < items.length) {
          signal.throwIfAborted();
          await work(items[next++]);
        }
      }),
    );
  };
  const readPages = async () => {
    for (const result of job.results)
      for (const row of result?.results ?? []) add(row.url, result.query);
    const unread = [...candidates.values()].filter(
      (row) => !job.sources.some((source: any) => source.url === row.url),
    );
    const selected = rankReadCandidates(unread, job.results, job.sources.map((source: any) => source.url))
      .slice(0, Math.max(0, maxPages - job.sources.length));
    await parallel(selected, async (row) => {
      // Reserve before awaiting so completion order cannot exceed the source budget.
      const receipt: any = { url: row.url, origin: row.origin, ...(row.why.length ? { selectedBecause: row.why } : {}), state: "reading" };
      job.sources.push(receipt);
      try {
        const result = await readSource(row.url, signal);
        signal.throwIfAborted();
        Object.assign(receipt, {
          state:
            result.error || !result.content?.trim() ? "unavailable" : "read",
          title: result.title?.slice(0, 300) ?? "",
          excerpt: result.content?.slice(0, 2400) ?? "",
          truncated: (result.content?.length ?? 0) > 2400,
          ...(result.error
            ? { error: String(result.error).slice(0, 400) }
            : {}),
          retrievedAt: new Date().toISOString(),
          verification:
            "Extracted source text, not a verified claim or model summary.",
          ...(result.responseId
            ? {
                responseId: result.responseId,
                urlIndex: 0,
                retrieval:
                  "Use get_search_content for cached source slices or find; no repeat fetch needed.",
              }
            : {}),
        });
      } catch (error) {
        Object.assign(receipt, {
          state: signal.aborted ? "cancelled" : "unavailable",
          error: String(error).slice(0, 400),
        });
        signal.throwIfAborted();
      }
    });
  };
  job.phase = "discovery";
  // Known pages make progress even while a search provider is slow or unavailable.
  await Promise.all([
    parallel(
      queries.map((_, i) => i),
      (i) => runQuery(i, true),
    ),
    readPages(),
  ]);
  job.phase = "reading";
  await readPages();
  // Cooldowns never block untouched query angles or known-source reading.
  const pending = [
    ...new Map(
      retry
        .filter((r) => !job.results[r.index]?.results.length)
        .map((r) => [r.index, r]),
    ).values(),
  ].sort((a, b) => a.at - b.at);
  job.phase = "recovery";
  for (const item of pending) {
    if (Date.now() < item.at)
      await delay(item.at - Date.now(), undefined, { signal });
    await runQuery(item.index, false);
  }
  await readPages();
  job.phase = "finished";
  const failedQueries = job.results.filter((r: any) => r.error).length;
  const failedPages = job.sources.filter((r: any) => r.state !== "read").length;
  const successes =
    job.results.length - failedQueries + job.sources.length - failedPages;
  job.state = !successes
    ? "failed"
    : failedQueries || failedPages
      ? "partial"
      : "complete";
}
