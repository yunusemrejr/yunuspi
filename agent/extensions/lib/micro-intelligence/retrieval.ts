import { sessionObservability } from '../session-observability.ts';
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
import type { NeedleResult } from "../needle-runtime.ts";
import type { NeedleRankResult } from "../needle-types.ts";
import { microMetrics } from "./metrics.ts";
import { LOCAL_CHOICE_MIN_P, LOCAL_CHOICE_MIN_MARGIN, type LocalChooser } from "../local-lm.ts";

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
  applied: "lexical" | "needle" | "fused" | "local" | "jev";
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
/** Reciprocal-rank fusion constant (the conventional 60). */
const RRF_K = 60;

export function trivialQuery(query: unknown): boolean {
  return typeof query !== "string" || query.trim().length < 3;
}

/**
 * Blend lexical order with Needle/Jev judgments.
 *
 * - `lexical` is the caller's deterministic+lexical order (already bounded).
 * - Needle re-ranks the head slice; its order applies when the win is
 *   accepted (score/margin floors); agreement alone cannot reorder the tail.
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
  local?: LocalChooser;
  signal?: AbortSignal;
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
  const done = (ordered: T[], applied: RetrievalOutcome<T>["applied"], extra: Partial<RetrievalOutcome<T>> = {}): RetrievalOutcome<T> => {
    if(applied !== "lexical")try{sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("ml.retrieval.used",{count:1,decision:applied});}catch{/* optional visibility */}
    return { ordered, applied, lexicalTop, ...extra };
  };

  if (lexical.length < 2 || trivialQuery(query)) {
    metrics.skip("needle", lexical.length < 2 ? "no-candidates" : "trivial");
    return done([...lexical], "lexical");
  }

  const slice = lexical.slice(0, MAX_STAGE);
  const limit = Number.isSafeInteger(options.needleTopK) ? Math.max(2, Math.min(MAX_STAGE, options.needleTopK!)) : NEEDLE_STAGE;
  const needleSlice = slice.slice(0, limit);
  let needleTop: string | undefined;
  let needleMargin = 0;
  let needleAccepted = false;
  let needleShadow = false;
  let needleOrder: string[] | undefined;

  if (options.needle) {
    metrics.offer("needle");
    try {
      const ranked = await options.needle(
        query.slice(0, EMBED_CHARS),
        needleSlice.map((item) => ({ id: String(item.id), text: String(item.text).slice(0, EMBED_CHARS) })),
        needleSlice.length,
      );
      if (ranked.ok) {
        metrics.run("needle", ranked.ms);
        if (ranked.cached) metrics.cacheHit("needle");
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
            metrics.skip("needle", "shadow");
          } else if (!needleAccepted) {
            metrics.skip("needle", score < acceptScore ? "low-confidence" : "low-margin");
          }
        }
      } else {
        metrics.skip("needle", ranked.reason);
      }
    } catch {
      metrics.skip("needle", "unavailable");
    }
  }

  const agrees = needleTop !== undefined && needleTop === lexicalTop;
  // Shadow may measure agreement but must preserve baseline Jev eligibility.
  // Weak agreement on the first result does not authorize reordering others.
  let needleOrdered: T[] | undefined;
  if (!needleShadow && needleOrder && needleAccepted) {
    const rankOf = new Map(needleOrder.map((id, index) => [id, index]));
    needleOrdered = [...slice]
      .sort((a, b) => (rankOf.get(a.id) ?? 999) - (rankOf.get(b.id) ?? 999))
      .concat(lexical.slice(MAX_STAGE));
    if (!options.jev || agrees) {
      metrics.accept("needle");
      return done(needleOrdered, "needle", { needleTop, needleMargin });
    }
  }

  // Needle cosines are compressed (top-vs-second margins measured 0.000-0.006
  // over a 242-skill catalog), so the acceptance margin almost never passes
  // and its order used to be discarded. Reciprocal-rank fusion with the
  // lexical order keeps that signal without letting a weak Needle top displace
  // strong lexical evidence. Measured on 18 skill requests: top-1 4 Needle,
  // 7 lexical, 9 fused; top-5 10, 10, 13.
  let fusedOrdered: T[] | undefined;
  if (!needleShadow && needleOrder && !needleAccepted) {
    const needleRank = new Map(needleOrder.map((id, index) => [id, index]));
    const fused = slice.map((item, index) => ({ item, index, score: 1 / (RRF_K + index) + (needleRank.has(item.id) ? 1 / (RRF_K + needleRank.get(item.id)!) : 0) }))
      .sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item);
    if (fused.some((item, index) => item.id !== slice[index].id)) fusedOrdered = fused.concat(lexical.slice(MAX_STAGE));
  }

  // One local token can settle a short capability shortlist. Only promote
  // an existing entry; never drop evidence/candidates or expand authority.
  // Exact names and shadow ranking keep their existing behavior.
  const identity = (text: string) => text.trim().toLowerCase().replace(/[\s_:/.]+/g, '-').replace(/-+/g, '-');
  const named = lexical.some(entry => identity(entry.id) === identity(query) || identity(entry.text.split(':')[0]) === identity(query));
  if (options.local && !needleShadow && !named && !options.signal?.aborted) {
    try {
      const pool = needleOrdered ?? fusedOrdered ?? [...lexical];
      const candidates = pool.slice(0, 3).map(entry => ({ id: entry.id, text: entry.text.slice(0, 300) }));
      const picked = await options.local(query, candidates, `${kind}-discovery`, { signal: options.signal });
      if (picked.ok && !options.signal?.aborted && Number.isFinite(picked.p) && picked.p >= LOCAL_CHOICE_MIN_P && picked.p <= 1
        && Number.isFinite(picked.margin) && picked.margin >= LOCAL_CHOICE_MIN_MARGIN && picked.margin <= 1 && candidates.some(entry => entry.id === picked.id)) {
        return done([...pool.filter(entry => entry.id === picked.id), ...pool.filter(entry => entry.id !== picked.id)], 'local', { needleTop, needleMargin });
      }
    } catch { /* Unavailable/uncertain local advice retains the remote/lexical path. */ }
  }

  // Jev validation: uncertain Needle, stage disagreement, or no Needle.
  const needsJev = needleShadow || needleTop === undefined || !needleAccepted || !agrees;
  if (options.jev && needsJev) {
    metrics.offer("jev");
    try {
      const pool = (needleOrdered ?? fusedOrdered ?? [...lexical]).slice(0, MAX_STAGE);
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
        const allowed = new Set(candidates.map((candidate) => candidate.id));
        const exists = judged.answers.exists?.noul;
        if (Number.isFinite(exists) && exists! >= 0.5 && exists! <= 1 && Number.isFinite(topProb) && topProb >= 0.4 && topProb <= 1 && top && allowed.has(top)) {
          const rankOf = new Map(
            Object.entries(order).filter(([id, probability]) => allowed.has(id) && Number.isFinite(probability) && probability >= 0 && probability <= 1)
              .sort((a, b) => a[0] === top ? -1 : b[0] === top ? 1 : b[1] - a[1]).map(([id], index) => [id, index]),
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
    metrics.accept("needle");
    return done(needleOrdered, "needle", { needleTop, needleMargin });
  }
  if (fusedOrdered) {
    metrics.accept("needle");
    return done(fusedOrdered, "fused", { needleTop, needleMargin });
  }
  return done([...lexical], "lexical", { needleTop, needleMargin });
}
