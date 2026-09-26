/** TypeSafe Jev Router shadow advisor.
 *
 * The router suggests a model/reasoning-effort pair for a routing decision.
 * YunusPi records that suggestion ALONGSIDE its own capability-,
 * benchmark-, health-, privacy-, cost-, restriction-, reliability- and
 * cache-aware choice plus the actual outcome — and keeps routing
 * authority entirely. Promotion of router input into real influence
 * requires accumulated shadow evidence plus an explicit operator change;
 * this module never routes, never overrides restrictions, and never
 * bypasses the existing selector.
 */
import { createHash } from "node:crypto";

export interface RouterSuggestion {
  model: string;
  /** Reasoning effort label as suggested (provider-specific vocabulary). */
  effort?: string;
  reason?: string;
}

export interface RouterComparison {
  at: number;
  task: string;
  yunuspi: string;
  router: string | null;
  routerEffort?: string;
  agree: boolean;
  /** Recorded later via recordOutcome: did the YunusPi choice succeed? */
  success?: boolean;
  latencyMs?: number;
  costUsd?: number;
  retries?: number;
  reviewOutcome?: string;
  id: string;
}

export type RouterSuggest = (task: string, opts: {
  candidates: string[];
  signal?: AbortSignal;
}) => Promise<{ suggestion: RouterSuggestion | null; skipped?: string }>;

const ROUTER_SLUG_PATTERN = /typesafe.*router|router.*typesafe/i;

/** Find a router slug among live model ids. Unknown stays undiscovered. */
export function discoverRouterSlug(modelIds: readonly string[]): string | undefined {
  for (const id of modelIds) {
    if (typeof id === "string" && ROUTER_SLUG_PATTERN.test(id)) return id;
  }
  return undefined;
}

export function routerShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["1", "true", "yes"].includes((env.PI_OFFLINE ?? "").toLowerCase())
    && !["off", "0"].includes((env.PI_ROUTER_SHADOW ?? "on").toLowerCase());
}

export function createRouterShadow(maxRecords = 256): {
  compare: (task: string, yunuspiChoice: string, suggest: RouterSuggest | undefined, candidates: string[], signal?: AbortSignal) => Promise<RouterComparison>;
  recordOutcome: (id: string, outcome: Pick<RouterComparison, "success" | "latencyMs" | "costUsd" | "retries" | "reviewOutcome">) => void;
  report: () => RouterShadowReport;
  clear: () => void;
} {
  const records = new Map<string, RouterComparison>();
  const limit = Number.isFinite(maxRecords) ? Math.max(16, Math.min(1024, Math.floor(maxRecords))) : 256;
  const put = (record: RouterComparison): RouterComparison => {
    if (records.size >= limit) records.delete(records.keys().next().value!);
    records.set(record.id, record);
    return record;
  };
  return {
    async compare(task, yunuspiChoice, suggest, candidates, signal) {
      const at = Date.now();
      const id = createHash("sha256").update(`${at}:${task.slice(0, 200)}:${yunuspiChoice}`).digest("hex").slice(0, 16);
      if (!suggest || signal?.aborted) {
        return put({ at, task: task.slice(0, 200), yunuspi: yunuspiChoice.slice(0, 160), router: null, agree: false, id });
      }
      let suggestion: RouterSuggestion | null = null;
      try {
        const answer = await suggest(task.slice(0, 1000), { candidates: candidates.slice(0, 32), signal });
        suggestion = answer.suggestion;
      } catch {
        suggestion = null;
      }
      const router = suggestion?.model?.slice(0, 160) ?? null;
      return put({
        at,
        task: task.slice(0, 200),
        yunuspi: yunuspiChoice.slice(0, 160),
        router,
        routerEffort: suggestion?.effort?.slice(0, 32),
        agree: router !== null && router === yunuspiChoice.slice(0, 160),
        id,
      });
    },
    recordOutcome(id, outcome) {
      const record = records.get(id);
      if (!record) return;
      if (outcome.success !== undefined) record.success = outcome.success;
      if (outcome.latencyMs !== undefined) record.latencyMs = outcome.latencyMs;
      if (outcome.costUsd !== undefined) record.costUsd = outcome.costUsd;
      if (outcome.retries !== undefined) record.retries = outcome.retries;
      if (outcome.reviewOutcome !== undefined) record.reviewOutcome = String(outcome.reviewOutcome).slice(0, 64);
    },
    report() {
      return summarizeRouterShadow([...records.values()]);
    },
    clear() {
      records.clear();
    },
  };
}

export interface RouterShadowReport {
  comparisons: number;
  withSuggestion: number;
  agreements: number;
  yunuspiSuccess: number;
  yunuspiDecided: number;
  /** Mean latency/cost over outcome-recorded comparisons (YunusPi choice). */
  meanLatencyMs: number | null;
  meanCostUsd: number | null;
  note: string;
}

export function summarizeRouterShadow(records: readonly RouterComparison[]): RouterShadowReport {
  const withSuggestion = records.filter((record) => record.router !== null);
  const agreements = withSuggestion.filter((record) => record.agree).length;
  const decided = records.filter((record) => record.success !== undefined);
  const success = decided.filter((record) => record.success === true).length;
  const latencies = decided.map((record) => record.latencyMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const costs = decided.map((record) => record.costUsd).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    comparisons: records.length,
    withSuggestion: withSuggestion.length,
    agreements,
    yunuspiSuccess: success,
    yunuspiDecided: decided.length,
    meanLatencyMs: mean(latencies),
    meanCostUsd: mean(costs),
    note: "Shadow only: the router suggestion never influenced routing. Promotion requires accumulated evidence plus an explicit operator change.",
  };
}
