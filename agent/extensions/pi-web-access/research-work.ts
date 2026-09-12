import { setTimeout as delay } from "node:timers/promises";
import { matchesDomainFilters, normalizeDomainFilters } from "./duckduckgo.ts";

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
    const selected = [...candidates.values()]
      .filter(
        (row) => !job.sources.some((source: any) => source.url === row.url),
      )
      .slice(0, Math.max(0, maxPages - job.sources.length));
    await parallel(selected, async (row) => {
      // Reserve before awaiting so completion order cannot exceed the source budget.
      const receipt: any = { ...row, state: "reading" };
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
