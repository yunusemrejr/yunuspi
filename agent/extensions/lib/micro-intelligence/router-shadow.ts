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
import { randomUUID } from "node:crypto";
import { raceWithAbortSignal } from "@yunuspi/ai/utils/abort";

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
  skipped?: string;
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

export function createRouterShadow(maxRecords = 256, options: {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
} = {}): {
  compare: (task: string, yunuspiChoice: string, suggest: RouterSuggest | undefined, candidates: string[], signal?: AbortSignal) => Promise<RouterComparison>;
  recordOutcome: (id: string, outcome: Pick<RouterComparison, "success" | "latencyMs" | "costUsd" | "retries" | "reviewOutcome">) => void;
  report: () => RouterShadowReport;
  clear: () => void;
} {
  const records = new Map<string, RouterComparison>();
  let lifetime = new AbortController();
  const limit = Number.isFinite(maxRecords) ? Math.max(16, Math.min(1024, Math.floor(maxRecords))) : 256;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60_000, options.timeoutMs!)) : 15_000;
  return {
    async compare(task, yunuspiChoice, suggest, candidates, signal) {
      const owner = lifetime;
      const boundedTask = typeof task === "string" ? task.slice(0, 1000) : "";
      const choice = typeof yunuspiChoice === "string" ? yunuspiChoice : "";
      const offered = Array.isArray(candidates) ? [...new Set(candidates.filter(candidate =>
        typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256 && !/[\u0000-\u001f]/.test(candidate)))].slice(0, 32) : [];
      const record: RouterComparison = { at: Date.now(), task: boundedTask.slice(0, 200), yunuspi: choice.slice(0, 256), router: null, agree: false, id: randomUUID() };
      const finish = (skipped?: string): RouterComparison => {
        if (skipped) record.skipped = skipped;
        if (!owner.signal.aborted && !signal?.aborted) {
          if (records.size >= limit) records.delete(records.keys().next().value!);
          records.set(record.id, structuredClone(record));
        }
        return structuredClone(record);
      };
      if (signal?.aborted) return finish("aborted");
      if (!routerShadowEnabled(options.env)) return finish("disabled");
      if (!boundedTask.trim() || !offered.includes(choice)) return finish("invalid-input");
      if (!suggest) return finish("no-adapter");
      const controller = new AbortController();
      const combined = AbortSignal.any([owner.signal, controller.signal, ...(signal ? [signal] : [])]);
      const timer = setTimeout(() => controller.abort(new DOMException("Router shadow timeout", "TimeoutError")), timeoutMs);
      try {
        const answer = await raceWithAbortSignal(Promise.resolve(suggest(boundedTask, { candidates: [...offered], signal: combined })), combined);
        combined.throwIfAborted();
        const suggestion = answer?.suggestion;
        if (!suggestion || typeof suggestion.model !== "string" || !offered.includes(suggestion.model)
          || suggestion.effort !== undefined && (typeof suggestion.effort !== "string" || suggestion.effort.length > 32 || /[\u0000-\u001f]/.test(suggestion.effort))) {
          return finish("invalid-suggestion");
        }
        record.router = suggestion.model;
        if (suggestion.effort) record.routerEffort = suggestion.effort;
        record.agree = suggestion.model === choice;
        return finish();
      } catch {
        return finish(signal?.aborted || owner.signal.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "unavailable");
      } finally { clearTimeout(timer); }
    },
    recordOutcome(id, outcome) {
      const record = records.get(id);
      if (!record || !outcome) return;
      if (typeof outcome.success === "boolean") record.success = outcome.success;
      if (typeof outcome.latencyMs === "number" && Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0) record.latencyMs = outcome.latencyMs;
      if (typeof outcome.costUsd === "number" && Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0) record.costUsd = outcome.costUsd;
      if (Number.isSafeInteger(outcome.retries) && outcome.retries! >= 0) record.retries = outcome.retries;
      if (typeof outcome.reviewOutcome === "string") record.reviewOutcome = outcome.reviewOutcome.slice(0, 64);
    },
    report() {
      return summarizeRouterShadow([...records.values()]);
    },
    clear() {
      lifetime.abort(new DOMException("Router shadow session changed", "AbortError"));
      lifetime = new AbortController();
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
