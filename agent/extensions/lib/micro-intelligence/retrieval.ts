/** Multi-stage retrieval: deterministic eligibility (caller-owned) ->
 * lexical/statistical order (caller-provided) -> Needle semantic ranking ->
 * Jev validation when uncertain. Candidates entering this function are
 * already authorized/eligible; ranking never grants access.
 *
 * Dependencies are injected so subsystem owners keep their wiring and tests
 * stay hermetic. Agreement/disagreement between stages is recorded for
 * shadow calibration.
 *
 * Cache partitioning: this stage is stateless. Underlying caches are
 * content-addressed only (text -> embedding, state+questions -> judgment),
 * so a cached value cannot leak candidates across authorization contexts;
 * context-dependent candidate SETS are rebuilt by the owner on every call.
 */
import type { NeedleResult } from "../needle-types.ts";
import type { NeedleRankResult } from "../needle-types.ts";
import { microMetrics } from "./metrics.ts";

export interface RetrievalCandidate {
  id: string;
  text: string;
}

export type RetrievalNeedle = (
  query: string,
  candidates: RetrievalCandidate[],
  topK: number,
) => Promise<NeedleResult<NeedleRankResult>>;

export type RetrievalJev = (
  site: string,
  state: unknown,
  questions: Record<string, unknown>,
) => Promise<
  | { ok: true; answers: Record<string, { choice?: string; noul?: number; probabilities?: Record<string, number>; confidence?: number }>; usage: { inputTokens: number; cached: boolean; costUsd?: number } }
  | { ok: false; skipped: string }
>;

export interface RetrievalOutcome<T extends RetrievalCandidate> {
  ordered: T[];
  applied: "lexical" | "needle" | "jev";
  lexicalTop?: string;
  needleTop?: string;
  needleMargin?: number;
  jevTop?: string;
  jevConfidence?: number;
  mark?: string;
}

const MAX_STAGE = 25;
/** Needle re-ranks the head slice only: 12 x ~160 chars keeps cold
 * first-rank latency inside the interactive budget (~5s worst case);
 * the worker cache makes repeat ranks near-instant. */
const NEEDLE_STAGE = 12;
/** Embedding texts truncate here (~160 chars x ~3.5ms/char). */
const EMBED_CHARS = 160;

export function trivialQuery(query: unknown): boolean {
  return typeof query !== "string" || query.trim().length < 3;
}

/**
 * Blend lexical order with Needle/Jev judgments.
 *
 * - `lexical` is the caller's deterministic+lexical order (already bounded).
 * - Needle re-ranks the head slice; its order applies when the win is
 *   accepted (score/margin floors) or when it agrees with lexical-top.
 * - Jev validates exactly when it adds value: Needle is uncertain, or
 *   Needle-top and lexical-top disagree. One batched call, same bars as the
 *   existing tool-discovery rerank (exists >= 0.5, topProb >= 0.4).
 */
export async function multiStageRetrieve<T extends RetrievalCandidate>(options: {
  kind: string;
  site: string;
  query: string;
  lexical: readonly T[];
  needle?: RetrievalNeedle;
  jev?: RetrievalJev;
  jevMark?: (site: string, detail: string, usage: { inputTokens: number; cached: boolean }) => string;
  acceptScore?: number;
  acceptMargin?: number;
  needleTopK?: number;
}): Promise<RetrievalOutcome<T>> {
  const { kind, site, query, lexical } = options;
  const metrics = microMetrics();
  const bit = (id: string | undefined): string | undefined => id;
  const lexicalTop = bit(lexical[0]?.id);
  const done = (ordered: T[], applied: RetrievalOutcome<T>["applied"], extra: Partial<RetrievalOutcome<T>> = {}): RetrievalOutcome<T> => ({
    ordered, applied, lexicalTop, ...extra,
  });

  if (lexical.length < 2 || trivialQuery(query)) {
    metrics.skip("needle", lexical.length < 2 ? "no-candidates" : "trivial");
    return done([...lexical], "lexical");
  }

  const slice = lexical.slice(0, MAX_STAGE);
  const needleSlice = slice.slice(0, options.needleTopK ?? NEEDLE_STAGE);
  let needleTop: string | undefined;
  let needleMargin = 0;
  let needleAccepted = false;
  let needleShadow = false;
  let needleOrder: string[] | undefined;

  if (options.needle) {
    try {
      const ranked = await options.needle(
        query.slice(0, EMBED_CHARS),
        needleSlice.map((item) => ({ id: String(item.id).slice(0, 256), text: String(item.text).slice(0, EMBED_CHARS) })),
        needleSlice.length,
      );
      if (ranked.ok) {
        needleShadow = ranked.shadow;
        const head = ranked.value.ranked;
        if (head.length) {
          needleTop = head[0].id;
          needleMargin = ranked.value.margin;
          needleOrder = head.map((entry) => entry.id);
          const score = head[0].score;
          const acceptScore = options.acceptScore ?? 0.93;
          const acceptMargin = options.acceptMargin ?? 0.02;
          needleAccepted = score >= acceptScore && needleMargin >= acceptMargin;
          if (needleShadow) {
            metrics.shadowAgreement(needleTop === lexicalTop);
          }
        }
      } else {
        metrics.skip("needle", ranked.reason);
      }
    } catch {
      metrics.skip("needle", "unavailable");
    }
  }

  // Shadow mode: Needle measured, lexical order stays authoritative.
  if (needleShadow) {
    return done([...lexical], "lexical", { needleTop, needleMargin });
  }

  const agrees = needleTop !== undefined && needleTop === lexicalTop;
  // Fast path: an accepted Needle win, or agreement with lexical order.
  // Disagreement and uncertainty fall through to Jev validation.
  let needleOrdered: T[] | undefined;
  if (needleOrder && (needleAccepted || agrees)) {
    const rankOf = new Map(needleOrder.map((id, index) => [id, index]));
    needleOrdered = [...slice]
      .sort((a, b) => (rankOf.get(a.id) ?? 999) - (rankOf.get(b.id) ?? 999))
      .concat(lexical.slice(MAX_STAGE));
    if (needleAccepted || agrees) {
      metrics.run("needle");
      metrics.accept("needle");
      if (!options.jev || needleAccepted) {
        return done(needleOrdered, agrees && !needleAccepted ? "lexical" : "needle", { needleTop, needleMargin });
      }
      // Agreed but unaccepted: still cheap to confirm high-value picks.
    }
  }

  // Jev validation: uncertain Needle, stage disagreement, or no Needle.
  const needsJev = needleTop === undefined || !needleAccepted || !agrees;
  if (options.jev && needsJev) {
    try {
      const pool = (needleOrdered ?? [...lexical]).slice(0, MAX_STAGE);
      const candidates = pool.map((item) => ({ id: String(item.id), text: String(item.text).slice(0, 300) }));
      const judged = await options.jev(site, { query: query.slice(0, 256) }, {
        rank: {
          type: "choice",
          instructions: `Which ${kind} entry best serves this need?`,
          criteria: Object.fromEntries(candidates.map((entry) => [entry.id, entry.text])),
        },
        exists: { type: "noul", instructions: "Does any candidate actually serve the need?" },
      });
      if (judged.ok) {
        const order = judged.answers.rank?.probabilities ?? {};
        const top = judged.answers.rank?.choice;
        const topProb = top ? (order[top] ?? 0) : 0;
        metrics.run("jev");
        metrics.jevUsage(site, 2, judged.usage.inputTokens, judged.usage.costUsd ?? 0, judged.usage.cached);
        if (judged.usage.cached) metrics.cacheHit("jev");
        if ((judged.answers.exists?.noul ?? 0) >= 0.5 && topProb >= 0.4 && top) {
          const rankOf = new Map(
            Object.entries(order).sort((a, b) => b[1] - a[1]).map(([id], index) => [id, index]),
          );
          const reordered = [...lexical].sort(
            (a, b) => (rankOf.get(a.id) ?? 999) - (rankOf.get(b.id) ?? 999),
          );
          metrics.accept("jev");
          return done(reordered, "jev", {
            needleTop, needleMargin, jevTop: top, jevConfidence: topProb,
            mark: options.jevMark?.(site, `${top} ${topProb.toFixed(2)}`, judged.usage),
          });
        }
        metrics.skip("jev", "low-confidence");
      } else {
        metrics.skip("jev", judged.skipped);
      }
    } catch {
      metrics.skip("jev", "unavailable");
    }
  }

  if (needleOrdered && needleTop !== undefined) {
    return done(needleOrdered, "needle", { needleTop, needleMargin });
  }
  return done([...lexical], "lexical", { needleTop, needleMargin });
}

/**
 * Background embedding warmup for a static corpus (tool/capability/command
 * descriptions). Small batches with idle gaps so interactive ops interleave;
 * abortable, never throws, dedupes via the coordinator. Warmed embeddings
 * turn repeat ranks from ~250ms into cache hits.
 */
export async function warmEmbeddings(
  texts: string[],
  embed: (texts: string[]) => Promise<{ ok: boolean }>,
  options: { batch?: number; gapMs?: number; signal?: AbortSignal } = {},
): Promise<{ warmed: number; batches: number }> {
  const batch = Math.max(1, Math.min(16, options.batch ?? 6));
  const gapMs = Math.max(0, Math.min(5000, options.gapMs ?? 150));
  const unique = [...new Set(texts.filter((text) => typeof text === "string" && text.trim().length >= 3))].slice(0, 512);
  let warmed = 0, batches = 0;
  for (let i = 0; i < unique.length; i += batch) {
    if (options.signal?.aborted) break;
    try {
      const result = await embed(unique.slice(i, i + batch).map((text) => text.slice(0, EMBED_CHARS)));
      if (result.ok) warmed += Math.min(batch, unique.length - i);
      batches++;
    } catch {
      break;
    }
    if (i + batch < unique.length && gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }
  return { warmed, batches };
}
