/** Optional remote rerank stage for retrieval pipelines.
 *
 * Local Needle3 ranking stays the zero-cost default everywhere. This module
 * adds an opt-in precision stage AFTER lexical/vector retrieval and BEFORE
 * final context selection, for project memory, historical/session
 * retrieval, Observer evidence, source relevance, skills and docs.
 *
 * The transport speaks the Voyage rerank API shape
 * ({model, query, documents, top_k} -> data[{index, relevance_score}])
 * against a configurable endpoint, so Voyage rerank variants — or any
 * compatible proxy — can be benchmarked without hardcoding assumptions.
 * OpenRouter itself exposes no /v1/rerank; PI_RERANK_URL points at the
 * real backend. Unconfigured, unreachable, or low-value reranking
 * degrades to undefined (caller keeps its local order).
 */
import { microMetrics } from "./metrics.ts";
import { sessionObservability } from "../session-observability.ts";

export const RERANK_DEFAULT_URL = "https://api.voyageai.com/v1/rerank";
export const RERANK_TIMEOUT_MS = 15_000;
export const RERANK_MAX_DOCUMENTS = 24;
export const RERANK_MAX_DOC_CHARS = 1200;
export const RERANK_MAX_QUERY_CHARS = 1000;

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankTransport {
  (request: {
    url: string;
    model: string;
    query: string;
    documents: string[];
    topK: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<{ order: number[] }>;
}

export function rerankEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["1", "true", "yes"].includes((env.PI_OFFLINE ?? "").toLowerCase())
    && ["on", "1", "true", "yes"].includes((env.PI_RERANK ?? "off").toLowerCase());
}

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

/** Default Voyage-shaped transport. Never throws past its contract: callers
 * treat any rejection as rerank-unavailable. */
export function voyageRerankTransport(opts: {
  key?: () => string | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
} = {}): RerankTransport {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const keyOf = opts.key ?? (() => env.VOYAGE_API_KEY ?? undefined);
  return async ({ url, model, query, documents, topK, signal, timeoutMs }) => {
    const key = keyOf();
    if (!key) throw Error("rerank: no API key");
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Rerank timeout", "TimeoutError")), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, query, documents, top_k: topK, return_documents: false }),
        signal: controller.signal,
      });
      if (!response.ok) throw Error(`rerank ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ index?: number; relevance_score?: number }> };
      if (!Array.isArray(body.data) || !body.data.length) throw Error("rerank: malformed answers");
      const order = body.data
        .filter((row) => Number.isInteger(row.index) && (row.index as number) >= 0 && (row.index as number) < documents.length)
        .sort((a, b) => (Number(b.relevance_score) || 0) - (Number(a.relevance_score) || 0))
        .map((row) => row.index as number);
      if (!order.length) throw Error("rerank: malformed answers");
      return { order };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export interface RemoteRankerOptions {
  model?: string;
  url?: string;
  transport?: RerankTransport;
  topK?: number;
  timeoutMs?: number;
  /** Minimum candidates before a remote call is worthwhile. */
  minCandidates?: number;
  env?: Record<string, string | undefined>;
}

/** Ranker-shaped ({rank}) remote reranker. Returns undefined to keep the
 * caller's local order whenever remote reranking cannot help. */
export function remoteRanker(opts: RemoteRankerOptions = {}): {
  rank: (query: string, candidates: RerankCandidate[], signal?: AbortSignal) => Promise<string[] | undefined>;
} {
  const env = opts.env ?? process.env;
  return {
    async rank(query, candidates, signal) {
      const metrics = microMetrics();
      const started = Date.now();
      if (!rerankEnabled(env)) {
        metrics.skip("rerank", "disabled");
        return undefined;
      }
      const model = opts.model ?? env.PI_RERANK_MODEL;
      const url = opts.url ?? env.PI_RERANK_URL ?? RERANK_DEFAULT_URL;
      if (!model) {
        metrics.skip("rerank", "unconfigured");
        return undefined;
      }
      if (!Array.isArray(candidates) || candidates.length < (opts.minCandidates ?? 3)) {
        metrics.skip("rerank", "trivial");
        return undefined;
      }
      if (signal?.aborted) {
        metrics.skip("rerank", "aborted");
        return undefined;
      }
      metrics.offer("rerank");
      const transport = opts.transport ?? voyageRerankTransport({ env });
      const docs = candidates.slice(0, RERANK_MAX_DOCUMENTS);
      try {
        const { order } = await transport({
          url,
          model,
          query: String(query ?? "").slice(0, RERANK_MAX_QUERY_CHARS),
          documents: docs.map((candidate) => String(candidate.text ?? "").slice(0, RERANK_MAX_DOC_CHARS)),
          topK: Math.max(1, Math.min(docs.length, opts.topK ?? 12)),
          signal,
          timeoutMs: opts.timeoutMs ?? RERANK_TIMEOUT_MS,
        });
        const ms = Date.now() - started;
        const ids = order.map((index) => docs[index]?.id).filter((id): id is string => typeof id === "string");
        if (ids.length < 2) {
          metrics.skip("rerank", "low-value");
          return undefined;
        }
        metrics.run("rerank", ms);
        metrics.accept("rerank");
        noteHealth("ml.rerank.used", { count: 1, cached: false, durationMs: ms, route: model });
        return ids;
      } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        const reason = /no API key/i.test(message) ? "no-key" : /timeout|aborted/i.test(message) ? "timeout" : "unavailable";
        metrics.skip("rerank", reason);
        noteHealth("ml.rerank.skipped", { count: 1, reason, durationMs: ms });
        return undefined;
      }
    },
  };
}

export function rerankStatus(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  model: string | null;
  url: string;
  key: boolean;
} {
  return {
    enabled: rerankEnabled(env),
    model: env.PI_RERANK_MODEL ?? null,
    url: env.PI_RERANK_URL ?? RERANK_DEFAULT_URL,
    key: (env.VOYAGE_API_KEY ?? "") !== "",
  };
}
