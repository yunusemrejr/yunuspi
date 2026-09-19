/** Unified micro-intelligence metrics. Every helper (deterministic, Needle,
 * Smol, Kompress, Jev, full-LLM arbitration) reports offers, runs, skips and
 * latencies here so utilization and savings are measurable instead of
 * assumed. Savings are labeled estimates; only sealed, rendered reductions
 * count as observed.
 */
const RING_MAX = 128;

export type MicroHelper = "deterministic" | "needle" | "smol" | "kompress" | "jev" | "llm";

export interface HelperCounters {
  offers: number;
  runs: number;
  accepted: number;
  cacheHits: number;
  inputChars: number;
  /** Characters removed from provider-visible projections (observed only
   * when the reduction was actually rendered; otherwise projected). */
  savedChars: number;
  projectedSavedChars: number;
  lateCompletions: number;
  skipReasons: Record<string, number>;
  latencies: number[];
}

export interface JevCounters extends HelperCounters {
  questions: number;
  tokens: number;
  costUsd: number;
  bySite: Record<string, { calls: number; questions: number; tokens: number; costUsd: number }>;
}

export interface LlmCounters {
  /** Full-LLM calls spent on micro-judgments (classification, ranking,
   * arbitration) that a cheaper layer could have owned. */
  helperCalls: number;
  /** Micro-judgments served by a cheaper layer instead of a full LLM. */
  avoided: number;
  estimatedTokensAvoided: number;
}

const freshHelper = (): HelperCounters => ({
  offers: 0, runs: 0, accepted: 0, cacheHits: 0, inputChars: 0,
  savedChars: 0, projectedSavedChars: 0, lateCompletions: 0,
  skipReasons: {}, latencies: [],
});

export interface MicroSnapshot {
  at: number;
  helpers: Record<MicroHelper, HelperCounters>;
  jev: { questions: number; tokens: number; costUsd: number; bySite: JevCounters["bySite"] };
  llm: LlmCounters;
  shadow: { needleAgreed: number; needleDisagreed: number };
}

function percentile(sorted: number[], frac: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
}

export function latencyStats(latencies: number[]): { p50: number; p95: number; count: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), count: sorted.length };
}

export function createMicroMetrics() {
  const helpers: Record<MicroHelper, HelperCounters> = {
    deterministic: freshHelper(),
    needle: freshHelper(),
    smol: freshHelper(),
    kompress: freshHelper(),
    jev: freshHelper(),
    llm: freshHelper(),
  };
  const jevExtra = { questions: 0, tokens: 0, costUsd: 0, bySite: {} as JevCounters["bySite"] };
  const llmExtra: LlmCounters = { helperCalls: 0, avoided: 0, estimatedTokensAvoided: 0 };
  const shadow = { needleAgreed: 0, needleDisagreed: 0 };

  const ring = (helper: MicroHelper, ms: number): void => {
    const latencies = helpers[helper].latencies;
    latencies.push(ms);
    if (latencies.length > RING_MAX) latencies.splice(0, latencies.length - RING_MAX);
  };

  return {
    offer(helper: MicroHelper): void {
      helpers[helper].offers++;
    },
    run(helper: MicroHelper, ms = 0, inputChars = 0): void {
      helpers[helper].runs++;
      helpers[helper].inputChars += Math.max(0, Math.floor(inputChars));
      if (ms > 0) ring(helper, ms);
    },
    accept(helper: MicroHelper, savedChars = 0, projected = false): void {
      helpers[helper].accepted++;
      if (projected) helpers[helper].projectedSavedChars += Math.max(0, Math.floor(savedChars));
      else helpers[helper].savedChars += Math.max(0, Math.floor(savedChars));
    },
    /** Count a newly sealed provider projection once, separately from inference
     * acceptance. Replaying that seal does not manufacture further savings. */
    rendered(helper: MicroHelper, savedChars: number): void {
      helpers[helper].savedChars += Math.max(0, Math.floor(savedChars));
    },
    cacheHit(helper: MicroHelper): void {
      helpers[helper].cacheHits++;
    },
    skip(helper: MicroHelper, reason: string): void {
      const key = String(reason).slice(0, 48);
      helpers[helper].skipReasons[key] = (helpers[helper].skipReasons[key] ?? 0) + 1;
    },
    late(helper: MicroHelper): void {
      helpers[helper].lateCompletions++;
    },
    jevUsage(site: string, questions: number, tokens: number, costUsd: number, cached: boolean): void {
      jevExtra.questions += questions;
      if (!cached) {
        jevExtra.tokens += Math.max(0, tokens);
        if (costUsd >= 0) jevExtra.costUsd += costUsd;
      }
      const key = String(site).slice(0, 48);
      const row = jevExtra.bySite[key] ?? { calls: 0, questions: 0, tokens: 0, costUsd: 0 };
      row.calls++;
      row.questions += questions;
      if (!cached) {
        row.tokens += Math.max(0, tokens);
        if (costUsd >= 0) row.costUsd += costUsd;
      }
      if (!jevExtra.bySite[key] && Object.keys(jevExtra.bySite).length < 64) jevExtra.bySite[key] = row;
      else if (jevExtra.bySite[key]) jevExtra.bySite[key] = row;
    },
    llmHelperCall(): void {
      llmExtra.helperCalls++;
      helpers.llm.runs++;
    },
    llmAvoided(estimatedTokens = 0): void {
      llmExtra.avoided++;
      llmExtra.estimatedTokensAvoided += Math.max(0, Math.floor(estimatedTokens));
    },
    shadowAgreement(agreed: boolean): void {
      if (agreed) shadow.needleAgreed++;
      else shadow.needleDisagreed++;
    },
    snapshot(): MicroSnapshot {
      const helpersCopy = {} as Record<MicroHelper, HelperCounters>;
      for (const [key, value] of Object.entries(helpers)) {
        helpersCopy[key as MicroHelper] = {
          ...value,
          skipReasons: { ...value.skipReasons },
          latencies: [...value.latencies],
        };
      }
      return {
        at: Date.now(),
        helpers: helpersCopy,
        jev: {
          questions: jevExtra.questions,
          tokens: jevExtra.tokens,
          costUsd: jevExtra.costUsd,
          bySite: Object.fromEntries(Object.entries(jevExtra.bySite).map(([key, row]) => [key, { ...row }])),
        },
        llm: { ...llmExtra },
        shadow: { ...shadow },
      };
    },
    /** Compact one-line-per-helper summary for diagnostics surfaces. */
    summaryLines(): string[] {
      const lines: string[] = [];
      for (const [name, helper] of Object.entries(helpers)) {
        if (!helper.offers && !helper.runs) continue;
        const { p50, p95 } = latencyStats(helper.latencies);
        lines.push(
          `${name}: offers=${helper.offers} runs=${helper.runs} accepted=${helper.accepted} ` +
          `cache=${helper.cacheHits} p50=${Math.round(p50)}ms p95=${Math.round(p95)}ms`,
        );
      }
      if (jevExtra.questions) {
        lines.push(
          `jev: questions=${jevExtra.questions} tokens=${jevExtra.tokens} ` +
          `cost=$${jevExtra.costUsd.toFixed(4)} (estimated Jev spend; main-model spend lives in /cost)`,
        );
      }
      if (llmExtra.helperCalls || llmExtra.avoided) {
        lines.push(
          `llm-micro: helper-calls=${llmExtra.helperCalls} avoided=${llmExtra.avoided} ` +
          `est-tokens-avoided=${llmExtra.estimatedTokensAvoided} (estimate)`,
        );
      }
      return lines;
    },
  };
}

export type MicroMetrics = ReturnType<typeof createMicroMetrics>;

let shared: MicroMetrics | undefined;

export function microMetrics(): MicroMetrics {
  if (!shared) shared = createMicroMetrics();
  return shared;
}

/** Test seam. */
export function resetMicroMetrics(): void {
  shared = undefined;
}
