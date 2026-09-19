/** Lightweight micro-intelligence coordinator. It does NOT govern subsystem
 * owners: deterministic eligibility, safety hooks and authority checks stay
 * where they are. The coordinator only:
 * - deduplicates identical in-flight helper requests;
 * - caches helper results safely (bounded, TTL, keyed by content hash);
 * - tracks which helpers already processed a piece of evidence;
 * - records escalation chains (needle -> jev -> llm);
 * - attaches provenance to helper results;
 * - keeps a bounded opportunity ledger for tuning and debugging.
 */
import { createHash } from "node:crypto";
import type { MicroHelper } from "./metrics.ts";
import { microMetrics } from "./metrics.ts";

export interface Provenance {
  helper: MicroHelper;
  site: string;
  ms: number;
  cached: boolean;
  shadow: boolean;
  at: number;
}

export interface Assisted<T> {
  value: T;
  provenance: Provenance;
}

export type OpportunityDisposition =
  | "served" | "served-cached" | "deduped" | "skipped" | "failed";

export interface Opportunity {
  key: string;
  helper: MicroHelper;
  site: string;
  disposition: OpportunityDisposition;
  reason: string;
  ms: number;
  at: number;
}

interface CacheEntry {
  value: unknown;
  helper: MicroHelper;
  site: string;
  expires: number;
}

const LEDGER_MAX = 256;

export function opportunityKey(parts: Array<string | number | boolean | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function createCoordinator(options: {
  cacheMax?: number;
  defaultTtlMs?: number;
  now?: () => number;
} = {}) {
  const cacheMax = options.cacheMax ?? 512;
  const defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();
  const ledger: Opportunity[] = [];
  /** Evidence id -> helpers that already processed it (bounded). */
  const processed = new Map<string, Set<MicroHelper>>();
  /** Escalation chains: site -> sequence of helpers consulted. */
  const escalations = new Map<string, MicroHelper[]>();

  const note = (entry: Omit<Opportunity, "at">): void => {
    ledger.push({ ...entry, at: now() });
    if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
  };

  const remember = (key: string, value: unknown, helper: MicroHelper, site: string, ttlMs: number): void => {
    if (cacheMax <= 0 || ttlMs <= 0) return;
    cache.delete(key);
    cache.set(key, { value, helper, site, expires: now() + ttlMs });
    if (cache.size > cacheMax) cache.delete(cache.keys().next().value!);
  };

  return {
    /** Run `worker` once per key: concurrent duplicates share the in-flight
     * promise and resolved values are cached for `ttlMs`. */
    async assist<T>(
      key: string,
      helper: MicroHelper,
      site: string,
      worker: () => Promise<T>,
      ttlMs: number = defaultTtlMs,
    ): Promise<Assisted<T>> {
      const metrics = microMetrics();
      metrics.offer(helper);
      const hit = cache.get(key);
      if (hit && hit.expires > now()) {
        cache.delete(key);
        cache.set(key, hit);
        metrics.cacheHit(helper);
        note({ key, helper, site, disposition: "served-cached", reason: "cached", ms: 0 });
        return {
          value: hit.value as T,
          provenance: { helper: hit.helper, site: hit.site, ms: 0, cached: true, shadow: false, at: now() },
        };
      } else if (hit) {
        cache.delete(key);
      }
      const running = inflight.get(key);
      if (running) {
        const started = now();
        const value = (await running) as T;
        note({ key, helper, site, disposition: "deduped", reason: "inflight", ms: now() - started });
        return {
          value,
          provenance: { helper, site, ms: now() - started, cached: false, shadow: false, at: now() },
        };
      }
      const started = now();
      const task = (async (): Promise<T> => {
        try {
          const value = await worker();
          metrics.run(helper, now() - started);
          metrics.accept(helper);
          remember(key, value, helper, site, ttlMs);
          note({ key, helper, site, disposition: "served", reason: "fresh", ms: now() - started });
          return value;
        } catch (error) {
          note({
            key, helper, site, disposition: "failed",
            reason: (error instanceof Error ? error.message : String(error)).slice(0, 96),
            ms: now() - started,
          });
          throw error;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, task);
      const value = await task;
      return {
        value,
        provenance: { helper, site, ms: now() - started, cached: false, shadow: false, at: now() },
      };
    },
    /** Record that a helper already processed an evidence id (e.g. an
     * observation signature), so later stages skip repeat semantic work. */
    markProcessed(evidenceId: string, helper: MicroHelper): void {
      const key = String(evidenceId).slice(0, 128);
      let set = processed.get(key);
      if (!set) {
        set = new Set();
        processed.set(key, set);
        if (processed.size > 2048) processed.delete(processed.keys().next().value!);
      }
      set.add(helper);
    },
    processedBy(evidenceId: string): MicroHelper[] {
      return [...(processed.get(String(evidenceId).slice(0, 128)) ?? [])];
    },
    /** Record one step of an escalation chain for a site. */
    escalate(site: string, from: MicroHelper, to: MicroHelper): void {
      const key = String(site).slice(0, 128);
      const chain = escalations.get(key) ?? [];
      chain.push(from, to);
      escalations.set(key, chain.slice(-8));
      const metrics = microMetrics();
      if (to === "jev") metrics.skip("needle", "escalated-to-jev");
      if (to === "llm") metrics.skip(from === "jev" ? "jev" : "needle", "escalated-to-llm");
    },
    escalationChain(site: string): MicroHelper[] {
      return [...(escalations.get(String(site).slice(0, 128)) ?? [])];
    },
    ledger(): Opportunity[] {
      return [...ledger];
    },
    ledgerSummary(): Record<string, number> {
      const summary: Record<string, number> = {};
      for (const entry of ledger) {
        const key = `${entry.helper}:${entry.disposition}`;
        summary[key] = (summary[key] ?? 0) + 1;
      }
      return summary;
    },
    reset(): void {
      cache.clear();
      inflight.clear();
      ledger.length = 0;
      processed.clear();
      escalations.clear();
    },
  };
}

export type Coordinator = ReturnType<typeof createCoordinator>;

let shared: Coordinator | undefined;

export function coordinator(): Coordinator {
  if (!shared) shared = createCoordinator();
  return shared;
}

/** Test seam. */
export function resetCoordinator(): void {
  shared = undefined;
}
