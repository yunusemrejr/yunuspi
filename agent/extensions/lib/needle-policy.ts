/** Needle policy: environment controls, thresholds, skip vocabulary and the
 * safety contract. Pure and side-effect free; the runtime owns enforcement.
 *
 * Safety contract (non-negotiable):
 * - Embeddings/rankings never establish truth, authorization, completion,
 *   test success, dependency truth or permission.
 * - Rankings never grant access: every candidate set is pre-filtered by the
 *   deterministic owner (authorized tools, eligible skills, member commands).
 * - Similarity never equals causality, diagnosis or a verified fix.
 * - For mutation/read-only classification, helpers may only propose the
 *   read-only label under asymmetric thresholds; the mutation owner keeps
 *   the final decision and full-LLM confirmation stays available.
 */
import { createHash } from "node:crypto";

export type NeedleSkipReason =
  | "disabled" | "unavailable" | "warming" | "busy" | "timeout"
  | "trivial" | "too-small" | "too-large" | "no-candidates" | "unsupported-shape"
  | "low-confidence" | "low-margin" | "cooldown" | "cached" | "shadow"
  | "not-worth-cost" | "protected-evidence" | "deterministic-won";

export interface NeedlePolicy {
  enabled: boolean;
  shadow: boolean;
  /** Base per-op worker budget in ms. Slow ops fail open to the caller fallback. */
  opTimeoutMs: number;
  /** Ceiling for input-scaled op budgets (embed latency is ~3.5ms/char). */
  maxOpTimeoutMs: number;
  /** Maximum queued ops while warming/serving; overflow skips as busy. */
  maxQueue: number;
  /** Main-side embedding cache entries (LRU). */
  embedCacheMax: number;
  /** Worker-side candidate embedding cache entries (LRU by text hash). */
  workerCacheMax: number;
  /** Maximum texts per embed call / candidates per rank call. */
  maxBatch: number;
  /** Maximum input chars per text (longer inputs are truncated). */
  maxTextChars: number;
  /** Default classify acceptance floors (score in [-1,1], margin >= 0). */
  acceptScore: number;
  acceptMargin: number;
  /** Worker restarts allowed per window before cooling. */
  maxRestarts: number;
  restartWindowMs: number;
  /** Cooldown after the restart budget is exhausted. */
  cooldownMs: number;
  /** Re-probe interval while cooling/unavailable with assets present. */
  reprobeMs: number;
}

const num = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const frac = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export function needlePolicy(env: NodeJS.ProcessEnv = process.env): NeedlePolicy {
  return {
    enabled: (env.PI_NEEDLE ?? "").toLowerCase() !== "off",
    shadow: (env.PI_NEEDLE_SHADOW ?? "") === "1",
    opTimeoutMs: num(env.PI_NEEDLE_TIMEOUT_MS, 1500, 100, 15000),
    maxOpTimeoutMs: num(env.PI_NEEDLE_MAX_TIMEOUT_MS, 8000, 1000, 30000),
    maxQueue: num(env.PI_NEEDLE_QUEUE, 32, 1, 256),
    embedCacheMax: num(env.PI_NEEDLE_CACHE, 512, 0, 8192),
    workerCacheMax: num(env.PI_NEEDLE_WORKER_CACHE, 2048, 0, 32768),
    maxBatch: num(env.PI_NEEDLE_BATCH, 64, 1, 512),
    // Embedding is ~3.5ms/char warm: 512 chars is the hard ceiling, and
    // ranking call sites truncate to ~160 chars for interactive latency.
    maxTextChars: num(env.PI_NEEDLE_MAX_CHARS, 512, 64, 4096),
    // Calibrated 2026-09-19 against the pinned needle3.cact (dim 3072):
    // relevant candidates scored 0.909..0.986. Absolute cosine is
    // compressed and micro-text margins are thin (often < 0.01), so the
    // margin floor does the real separation: an accepted-but-wrong case at
    // margin 0.0188 moved the floor to 0.02. Clear winners are accepted,
    // near-ties escalate to Jev, and per-site bars may differ (see the
    // intent pre-screen's asymmetric bars).
    acceptScore: frac(env.PI_NEEDLE_ACCEPT_SCORE, 0.93, -1, 1),
    acceptMargin: frac(env.PI_NEEDLE_ACCEPT_MARGIN, 0.02, 0, 2),
    maxRestarts: num(env.PI_NEEDLE_RESTARTS, 3, 0, 16),
    restartWindowMs: num(env.PI_NEEDLE_RESTART_WINDOW_MS, 300_000, 10_000, 3_600_000),
    cooldownMs: num(env.PI_NEEDLE_COOLDOWN_MS, 300_000, 10_000, 3_600_000),
    reprobeMs: num(env.PI_NEEDLE_REPROBE_MS, 60_000, 5_000, 3_600_000),
  };
}

/** Bounded, NFKC-normalized text for embedding. Returns undefined for
 * trivial/unsupported input so callers skip before spending inference. */
export function needleText(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.normalize("NFKC").replace(/\0/g, "").trim().replace(/\s+/g, " ");
  if (text.length < 3 || text.length > 1024 * 1024) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function needleHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Cosine similarity for plain number arrays. Returns 0 for degenerate input. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
